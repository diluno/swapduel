import { defaultGameConfig } from './config'
import { nextRandom, randomInteger } from './random'
import {
  NORMAL_PANEL_TYPES,
  type Board,
  type GameConfig,
  type NormalPanelType,
  type Panel,
  type PanelType,
} from './types'

function createPanel(
  id: number,
  type: PanelType,
  row: number,
  column: number,
): Panel {
  return {
    id,
    type,
    state: 'idle',
    row,
    column,
    offsetX: 0,
    offsetY: 0,
    chainEligible: false,
    chainId: null,
    animationStartedAt: null,
  }
}

function availableTypes(
  cells: Board['cells'],
  row: number,
  column: number,
  panelTypes: readonly NormalPanelType[],
): NormalPanelType[] {
  return panelTypes.filter((type) => {
    const leftOne = cells[row]?.[column - 1] ?? null
    const leftTwo = cells[row]?.[column - 2] ?? null
    const belowOne = cells[row - 1]?.[column] ?? null
    const belowTwo = cells[row - 2]?.[column] ?? null

    const createsHorizontal =
      leftOne?.type === type && leftTwo?.type === type
    const createsVertical =
      belowOne?.type === type && belowTwo?.type === type

    return !createsHorizontal && !createsVertical
  })
}

export function createEmptyBoard(
  config: GameConfig = defaultGameConfig,
): Board {
  return {
    columns: config.board.columns,
    visibleRows: config.board.visibleRows,
    hiddenRows: config.board.hiddenRows,
    cells: Array.from({ length: config.board.visibleRows }, () =>
      Array.from({ length: config.board.columns }, () => null),
    ),
    incomingRow: [],
    nextPanelId: 1,
  }
}

export function generateIncomingRow(
  board: Board,
  initialRandomState: number,
  config: GameConfig = defaultGameConfig,
): { randomState: number; row: PanelType[] } {
  const panelTypes = NORMAL_PANEL_TYPES.slice(
    0,
    config.board.normalPanelTypes,
  )
  const row: PanelType[] = []
  let randomState = initialRandomState

  for (let column = 0; column < board.columns; column += 1) {
    const shockRoll = nextRandom(randomState)
    randomState = shockRoll.randomState
    const adjacentShock =
      row[column - 1] === 'shock' ||
      board.cells[0]?.[column]?.type === 'shock'

    if (
      shockRoll.value < config.board.shockPanelChance &&
      !adjacentShock
    ) {
      row.push('shock')
      continue
    }

    const candidates = panelTypes.filter((type) => {
      const createsHorizontal =
        row[column - 1] === type && row[column - 2] === type
      const bottom = board.cells[0]?.[column] ?? null
      const next = board.cells[1]?.[column] ?? null
      const createsVertical = bottom?.type === type && next?.type === type

      return !createsHorizontal && !createsVertical
    })

    const chosen = randomInteger(randomState, candidates.length)
    randomState = chosen.randomState
    row.push(candidates[chosen.value]!)
  }

  return { randomState, row }
}

export function createInitialBoard(
  initialRandomState: number,
  config: GameConfig = defaultGameConfig,
): { board: Board; randomState: number } {
  const board = createEmptyBoard(config)
  const panelTypes = NORMAL_PANEL_TYPES.slice(
    0,
    config.board.normalPanelTypes,
  )
  let randomState = initialRandomState

  for (let row = 0; row < config.board.startingRows; row += 1) {
    for (let column = 0; column < board.columns; column += 1) {
      const shockRoll = nextRandom(randomState)
      randomState = shockRoll.randomState
      const adjacentShock =
        board.cells[row]?.[column - 1]?.type === 'shock' ||
        board.cells[row - 1]?.[column]?.type === 'shock'

      if (
        shockRoll.value < config.board.shockPanelChance &&
        !adjacentShock
      ) {
        board.cells[row]![column] = createPanel(
          board.nextPanelId,
          'shock',
          row,
          column,
        )
        board.nextPanelId += 1
        continue
      }

      const candidates = availableTypes(
        board.cells,
        row,
        column,
        panelTypes,
      )
      const chosen = randomInteger(randomState, candidates.length)
      randomState = chosen.randomState
      board.cells[row]![column] = createPanel(
        board.nextPanelId,
        candidates[chosen.value]!,
        row,
        column,
      )
      board.nextPanelId += 1
    }
  }

  const incoming = generateIncomingRow(board, randomState, config)
  board.incomingRow = incoming.row

  return {
    board,
    randomState: incoming.randomState,
  }
}

export function insertIncomingRow(
  board: Board,
  initialRandomState: number,
  config: GameConfig = defaultGameConfig,
): { board: Board; randomState: number; toppedOut: boolean } {
  const rowCount = board.visibleRows
  const toppedOut = board.cells[rowCount - 1]!.some((cell) => cell !== null)

  if (toppedOut) {
    return { board, randomState: initialRandomState, toppedOut: true }
  }

  const cells = Array.from({ length: rowCount }, () =>
    Array.from({ length: board.columns }, () => null as Panel | null),
  )

  for (let row = rowCount - 1; row >= 1; row -= 1) {
    for (let column = 0; column < board.columns; column += 1) {
      const panel = board.cells[row - 1]?.[column] ?? null
      cells[row]![column] =
        panel === null
          ? null
          : {
              ...panel,
              row,
              offsetY: panel.offsetY - 1,
            }
    }
  }

  let nextPanelId = board.nextPanelId
  for (let column = 0; column < board.columns; column += 1) {
    const type = board.incomingRow[column]
    if (type === undefined) {
      throw new Error('Incoming row is incomplete')
    }
    cells[0]![column] = createPanel(nextPanelId, type, 0, column)
    nextPanelId += 1
  }

  const shiftedBoard: Board = {
    ...board,
    cells,
    nextPanelId,
  }
  const incoming = generateIncomingRow(
    shiftedBoard,
    initialRandomState,
    config,
  )

  return {
    board: {
      ...shiftedBoard,
      incomingRow: incoming.row,
    },
    randomState: incoming.randomState,
    toppedOut: false,
  }
}
