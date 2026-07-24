import {
  createEmptyBoard,
  type Board,
  type Panel,
  type PanelType,
} from '../src'

export function panel(
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

export function boardWith(
  entries: Array<[row: number, column: number, type: PanelType]>,
): Board {
  const board = createEmptyBoard()

  for (const [index, [row, column, type]] of entries.entries()) {
    board.cells[row]![column] = panel(index + 1, type, row, column)
  }
  board.nextPanelId = entries.length + 1

  return board
}
