import { describe, expect, it } from 'vitest'
import { applyGravity, isBoardStable } from '../src'
import { boardWith } from './helpers'

describe('gravity', () => {
  it('compacts panels toward row zero without changing their order', () => {
    const board = boardWith([
      [2, 0, 'circle'],
      [5, 0, 'triangle'],
      [4, 3, 'heart'],
    ])

    const result = applyGravity(board)

    expect(result.board.cells[0]![0]?.type).toBe('circle')
    expect(result.board.cells[1]![0]?.type).toBe('triangle')
    expect(result.board.cells[0]![3]?.type).toBe('heart')
    expect(result.movedPanelIds).toEqual([1, 2, 3])
    expect(isBoardStable(result.board)).toBe(true)
  })

  it('recognizes an unsupported panel as unstable', () => {
    expect(isBoardStable(boardWith([[1, 0, 'diamond']]))).toBe(false)
  })
})
