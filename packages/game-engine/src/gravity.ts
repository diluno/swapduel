import { garbageOccupiesCell } from './garbage'
import type { Board, GarbageBlock } from './types'

export interface GravityResult {
  movedPanelIds: number[]
  board: Board
}

export function applyGravity(
  board: Board,
  garbage: GarbageBlock[] = [],
): GravityResult {
  const cells = board.cells.map((row) => [...row])
  const movedPanelIds: number[] = []
  const rowCount = board.visibleRows

  for (let column = 0; column < board.columns; column += 1) {
    let targetRow = 0

    for (let row = 0; row < rowCount; row += 1) {
      if (
        garbage.some((block) =>
          garbageOccupiesCell(block, row, column),
        )
      ) {
        targetRow = row + 1
        continue
      }

      const panel = cells[row]?.[column] ?? null
      if (panel === null) {
        continue
      }

      if (row !== targetRow) {
        cells[targetRow]![column] = {
          ...panel,
          row: targetRow,
          state: 'idle',
          offsetY: row - targetRow,
          chainEligible: true,
        }
        cells[row]![column] = null
        movedPanelIds.push(panel.id)
      } else if (panel.state !== 'idle' || panel.offsetY !== 0) {
        cells[row]![column] = {
          ...panel,
          state: 'idle',
          offsetY: 0,
        }
      }

      targetRow += 1
    }
  }

  return {
    movedPanelIds,
    board: {
      ...board,
      cells,
    },
  }
}

export function isBoardStable(
  board: Board,
  garbage: GarbageBlock[] = [],
): boolean {
  const rowCount = board.visibleRows

  for (let column = 0; column < board.columns; column += 1) {
    let foundEmpty = false

    for (let row = 0; row < rowCount; row += 1) {
      if (
        garbage.some((block) =>
          garbageOccupiesCell(block, row, column),
        )
      ) {
        foundEmpty = false
        continue
      }

      const panel = board.cells[row]?.[column] ?? null
      if (panel === null) {
        foundEmpty = true
      } else if (foundEmpty || panel.state !== 'idle') {
        return false
      }
    }
  }

  return true
}
