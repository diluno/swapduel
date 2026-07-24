import type { Board, Coordinate, Panel } from './types'

function isLineMatchable(panel: Panel | null): panel is Panel {
  return (
    panel !== null &&
    panel.state === 'idle' &&
    panel.type !== 'shock'
  )
}

function coordinateKey(row: number, column: number): string {
  return `${row}:${column}`
}

export function findMatches(board: Board): Coordinate[] {
  const matches = new Map<string, Coordinate>()
  const rowCount = board.visibleRows

  for (let row = 0; row < rowCount; row += 1) {
    let runStart = 0

    while (runStart < board.columns) {
      const first = board.cells[row]?.[runStart] ?? null
      if (!isLineMatchable(first)) {
        runStart += 1
        continue
      }

      let runEnd = runStart + 1
      while (runEnd < board.columns) {
        const candidate = board.cells[row]?.[runEnd] ?? null
        if (
          !isLineMatchable(candidate) ||
          candidate.type !== first.type
        ) {
          break
        }
        runEnd += 1
      }

      if (runEnd - runStart >= 3) {
        for (let column = runStart; column < runEnd; column += 1) {
          matches.set(coordinateKey(row, column), { row, column })
        }
      }

      runStart = runEnd
    }
  }

  for (let column = 0; column < board.columns; column += 1) {
    let runStart = 0

    while (runStart < rowCount) {
      const first = board.cells[runStart]?.[column] ?? null
      if (!isLineMatchable(first)) {
        runStart += 1
        continue
      }

      let runEnd = runStart + 1
      while (runEnd < rowCount) {
        const candidate = board.cells[runEnd]?.[column] ?? null
        if (
          !isLineMatchable(candidate) ||
          candidate.type !== first.type
        ) {
          break
        }
        runEnd += 1
      }

      if (runEnd - runStart >= 3) {
        for (let row = runStart; row < runEnd; row += 1) {
          matches.set(coordinateKey(row, column), { row, column })
        }
      }

      runStart = runEnd
    }
  }

  const visitedShockCells = new Set<string>()
  const neighborOffsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const

  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < board.columns; column += 1) {
      const startKey = coordinateKey(row, column)
      const start = board.cells[row]?.[column] ?? null
      if (
        visitedShockCells.has(startKey) ||
        start?.state !== 'idle' ||
        start.type !== 'shock'
      ) {
        continue
      }

      const component: Coordinate[] = []
      const queue: Coordinate[] = [{ row, column }]
      visitedShockCells.add(startKey)

      while (queue.length > 0) {
        const current = queue.shift()!
        component.push(current)

        for (const [rowOffset, columnOffset] of neighborOffsets) {
          const neighborRow = current.row + rowOffset
          const neighborColumn = current.column + columnOffset
          const neighborKey = coordinateKey(neighborRow, neighborColumn)
          const neighbor =
            board.cells[neighborRow]?.[neighborColumn] ?? null

          if (
            neighborRow >= 0 &&
            neighborRow < rowCount &&
            neighborColumn >= 0 &&
            neighborColumn < board.columns &&
            !visitedShockCells.has(neighborKey) &&
            neighbor?.state === 'idle' &&
            neighbor.type === 'shock'
          ) {
            visitedShockCells.add(neighborKey)
            queue.push({
              row: neighborRow,
              column: neighborColumn,
            })
          }
        }
      }

      if (component.length >= 3) {
        for (const coordinate of component) {
          matches.set(
            coordinateKey(coordinate.row, coordinate.column),
            coordinate,
          )
        }
      }
    }
  }

  return [...matches.values()].sort(
    (left, right) => left.row - right.row || left.column - right.column,
  )
}

export function hasMatches(board: Board): boolean {
  return findMatches(board).length > 0
}
