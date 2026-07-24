import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  defaultGameConfig,
  requestSwap,
  stepSimulation,
  type SimulationState,
} from '../src'
import { boardWith } from './helpers'

function advanceUntil(
  initial: SimulationState,
  predicate: (state: SimulationState) => boolean,
  maximumSteps = 240,
): SimulationState {
  let state = initial

  for (let step = 0; step < maximumSteps; step += 1) {
    state = stepSimulation(state)
    if (predicate(state)) return state
  }

  throw new Error('Simulation did not reach the expected state')
}

describe('chain lifecycle', () => {
  it('counts a clear formed by falling panels as a two-step chain', () => {
    const initial = createSimulation('gravity-chain')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [1, 0, 'triangle'],
        [2, 1, 'triangle'],
        [3, 2, 'triangle'],
      ]),
    }
    const chained = advanceUntil(
      state,
      (candidate) => candidate.lastClearEvent?.chainLevel === 2,
    )

    expect(chained.chain).toMatchObject({
      id: 1,
      level: 2,
      status: 'active',
    })
    expect(chained.lastClearEvent).toMatchObject({
      size: 3,
      chainLevel: 2,
      qualifiedForChain: true,
    })
    expect(chained.stopTimeRemainingMs).toBe(
      defaultGameConfig.timing.chainStopBaseMs,
    )
    expect(chained.outgoingAttacks).toEqual([
      expect.objectContaining({
        sequence: 1,
        kind: 'chain',
        chainLevel: 2,
        blocks: [{ width: 6, height: 1, type: 'normal' }],
      }),
    ])
  })

  it('allows a manual swap during an active clear to extend the chain', () => {
    const initial = createSimulation('manual-chain')
    let state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [1, 0, 'circle'],
        [2, 0, 'circle'],
        [0, 2, 'heart'],
        [0, 3, 'heart'],
        [0, 4, 'triangle'],
        [0, 5, 'heart'],
      ]),
    }

    state = stepSimulation(state)
    expect(state.chain?.level).toBe(1)

    const swapped = requestSwap(state, {
      row: 0,
      column: 4,
      direction: 1,
    })
    expect(swapped.ok).toBe(true)

    const chained = advanceUntil(
      swapped.state,
      (candidate) => candidate.lastClearEvent?.chainLevel === 2,
    )

    expect(chained.lastClearEvent).toMatchObject({
      chainLevel: 2,
      qualifiedForChain: true,
    })
    expect(chained.outgoingAttacks.some(({ kind }) => kind === 'chain')).toBe(
      true,
    )
  })

  it('closes the chain after the stable-board window expires', () => {
    const initial = createSimulation('chain-close')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'diamond'],
        [0, 1, 'diamond'],
        [0, 2, 'diamond'],
      ]),
    }
    const closing = advanceUntil(
      state,
      (candidate) => candidate.chain?.status === 'closing',
    )

    expect(closing.chain?.level).toBe(1)

    const closed = advanceUntil(
      closing,
      (candidate) => candidate.chain === null,
    )
    expect(
      closed.board.cells
        .flat()
        .some(
          (panel) =>
            panel !== null &&
            (panel.chainEligible || panel.chainId !== null),
        ),
    ).toBe(false)
  })

  it('starts a new chain origin for an unrelated clear', () => {
    const initial = createSimulation('unrelated-clear')
    const firstOrigin = {
      ...initial,
      board: boardWith([
        [0, 0, 'star'],
        [0, 1, 'star'],
        [0, 2, 'star'],
      ]),
    }
    const closing = advanceUntil(
      firstOrigin,
      (candidate) => candidate.chain?.status === 'closing',
    )
    const unrelated = {
      ...closing,
      board: boardWith([
        [0, 3, 'heart'],
        [0, 4, 'heart'],
        [0, 5, 'heart'],
      ]),
    }
    const resolving = stepSimulation(unrelated)

    expect(resolving.chain?.id).toBe(2)
    expect(resolving.lastClearEvent?.chainLevel).toBe(1)
    expect(resolving.lastClearEvent?.qualifiedForChain).toBe(false)
  })
})
