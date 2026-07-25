import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  requestSwap,
  stepSimulation,
  type SimulationState,
} from '../src'
import { boardWith } from './helpers'

function advance(state: SimulationState, steps: number): SimulationState {
  let next = state
  for (let step = 0; step < steps; step += 1) {
    next = stepSimulation(next)
  }
  return next
}

describe('swapping a panel over a hole', () => {
  // Row 0 is the floor. Columns 0 and 1 hold a supported pair of circles at
  // row 1; column 2 is empty all the way down. Swapping the circle from
  // (1, 3) into (1, 2) lines up three circles on row 1 — but that third
  // circle has nothing underneath it, so on a real Panel de Pon board it
  // falls to row 0 and the match never happens.
  it('falls instead of matching with its new neighbours', () => {
    const initial = createSimulation('swap-over-hole')
    const state: SimulationState = {
      ...initial,
      board: boardWith([
        [0, 0, 'triangle'],
        [0, 1, 'triangle'],
        [1, 0, 'circle'],
        [1, 1, 'circle'],
        [1, 3, 'circle'],
        [0, 3, 'heart'],
      ]),
    }

    const swap = requestSwap(state, { row: 1, column: 3, direction: -1 })
    expect(swap.ok).toBe(true)

    const settled = advance(swap.state, 120)

    // The swapped circle ends up on the floor of column 2...
    expect(settled.board.cells[0]![2]?.type).toBe('circle')
    // ...and the row-1 circles are still on the board, unmatched.
    expect(settled.board.cells[1]![0]?.type).toBe('circle')
    expect(settled.board.cells[1]![1]?.type).toBe('circle')
    expect(settled.totalCleared).toBe(0)
  })
})
