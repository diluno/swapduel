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

function panelStates(state: SimulationState): string[] {
  return state.board.cells
    .flat()
    .filter((cell) => cell !== null)
    .map((cell) => cell!.state)
}

describe('holding raise while a swap is in flight', () => {
  // Manual raise is deliberately allowed during a swap. The inserted row shifts
  // every panel up one, so a pending swap recorded against the old rows used to
  // complete on the wrong cells and leave the real panels stuck in 'swapping'
  // — a block the player could never move again.
  it('leaves no panel stranded in the swapping state', () => {
    const initial = createSimulation('swap-during-raise')
    const state: SimulationState = {
      ...initial,
      board: {
        ...boardWith([
          [0, 0, 'circle'],
          [0, 1, 'triangle'],
          [1, 0, 'star'],
          [1, 1, 'heart'],
        ]),
        incomingRow: initial.board.incomingRow,
      },
      // On the verge of inserting a row, so the raise lands mid-swap.
      riseOffset: 0.99,
      manualRaise: true,
    }

    const swap = requestSwap(state, { row: 1, column: 0, direction: 1 })
    expect(swap.ok).toBe(true)

    const settled = advance(swap.state, 30)

    expect(settled.pendingSwap).toBeNull()
    expect(panelStates(settled)).not.toContain('swapping')

    // The pair actually traded places, and both remain swappable afterwards.
    const rowWithPair = settled.board.cells.findIndex((row) =>
      row[0]?.type === 'heart' && row[1]?.type === 'star',
    )
    expect(rowWithPair).toBeGreaterThanOrEqual(0)
    expect(
      requestSwap(settled, { row: rowWithPair, column: 0, direction: 1 }).ok,
    ).toBe(true)
  })
})
