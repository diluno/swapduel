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

function advanceUntil(
  initial: SimulationState,
  predicate: (state: SimulationState) => boolean,
  maximumSteps = 300,
): SimulationState {
  let state = initial

  for (let step = 0; step < maximumSteps; step += 1) {
    state = stepSimulation(state)
    if (predicate(state)) return state
  }

  throw new Error('Simulation did not reach the expected state')
}

describe('swapping while the board resolves', () => {
  // Column 5 clears itself the moment the simulation starts. Meanwhile the
  // hearts are two beats away from a match of their own: swap the heart at
  // (1, 4) left over the empty column 3 and it drops in beside them. The point
  // is that the player never has to wait for the diamonds to finish popping.
  function twoIndependentGroups(): SimulationState {
    const initial = createSimulation('concurrent')
    return {
      ...initial,
      board: boardWith([
        [0, 5, 'diamond'],
        [1, 5, 'diamond'],
        [2, 5, 'diamond'],
        [0, 1, 'heart'],
        [0, 2, 'heart'],
        [0, 4, 'star'],
        [1, 4, 'heart'],
      ]),
    }
  }

  const heartSwap = { row: 1, column: 4, direction: -1 } as const

  it('accepts a swap while another match is still flashing', () => {
    const flashing = stepSimulation(twoIndependentGroups())
    expect(flashing.phase).toBe('flashing')

    const swap = requestSwap(flashing, heartSwap)
    expect(swap.ok).toBe(true)
  })

  it('resolves the second match on its own clock, not the first one’s', () => {
    const flashing = stepSimulation(twoIndependentGroups())
    const swap = requestSwap(flashing, heartSwap)
    expect(swap.ok).toBe(true)

    const both = advanceUntil(swap.state, (candidate) => candidate.clears.length === 2)

    // Two clears in flight at once, each with its own timer.
    expect(both.clears.map(({ panelIds }) => panelIds.length)).toEqual([3, 3])
    expect(new Set(both.clears.map(({ phaseStartedAt }) => phaseStartedAt)).size).toBe(2)

    const settled = advanceUntil(
      both,
      (candidate) => candidate.clears.length === 0 && candidate.phase === 'idle',
    )
    expect(settled.totalCleared).toBe(6)
  })

  it('lets the first clear finish while the second is still flashing', () => {
    const flashing = stepSimulation(twoIndependentGroups())
    const swap = requestSwap(flashing, heartSwap)
    const overlapping = advanceUntil(
      swap.state,
      (candidate) => candidate.clears.length === 2,
    )

    // The diamonds pop away first; the hearts are untouched and still resolving.
    const partway = advanceUntil(
      overlapping,
      (candidate) => candidate.clears.length === 1,
    )
    expect(partway.totalCleared).toBe(3)
    expect(partway.board.cells[0]![5]).toBeNull()
    expect(partway.clears[0]?.panelIds).toHaveLength(3)
  })

  it('keeps the rest of the board swappable while a column is dropping', () => {
    const initial = createSimulation('falling-swap')
    const state: SimulationState = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [3, 0, 'heart'],
        [0, 4, 'star'],
        [0, 5, 'diamond'],
      ]),
    }

    // The heart is hanging in mid-air and will hover, then drop.
    const dropping = advanceUntil(
      state,
      (candidate) => candidate.board.cells[3]![0]?.state === 'hovering',
    )

    const swap = requestSwap(dropping, { row: 0, column: 4, direction: 1 })
    expect(swap.ok).toBe(true)

    const landed = advance(swap.state, 60)
    expect(landed.board.cells[0]![0]?.type).toBe('heart')
    expect(landed.board.cells[0]![4]?.type).toBe('diamond')
    expect(landed.board.cells[0]![5]?.type).toBe('star')
  })
})
