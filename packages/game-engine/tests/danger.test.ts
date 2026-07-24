import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  defaultGameConfig,
  setManualRaise,
  stepSimulation,
  type SimulationState,
} from '../src'
import { boardWith } from './helpers'

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

  throw new Error('Simulation did not reach the expected danger state')
}

describe('danger state machine', () => {
  it('enters danger at the top and cancels manual raising', () => {
    const initial = createSimulation('danger-entry')
    const state = setManualRaise(
      {
        ...initial,
        board: boardWith([[11, 0, 'circle']]),
      },
      true,
    )
    const danger = stepSimulation(state)

    expect(danger.status).toBe('playing')
    expect(danger.dangerRemainingMs).toBe(
      defaultGameConfig.timing.dangerGraceMs,
    )
    expect(danger.manualRaise).toBe(false)
    expect(danger.riseSpeed).toBe(0)
  })

  it('loses when the board stays blocked for the full grace period', () => {
    const initial = createSimulation('danger-timeout')
    const fullColumn: Array<
      [row: number, column: number, type: 'circle' | 'triangle']
    > = Array.from({ length: 12 }, (_, row) => [
      row,
      0,
      row % 2 === 0 ? 'circle' : 'triangle',
    ])
    const state = {
      ...initial,
      board: boardWith(fullColumn),
    }
    const danger = stepSimulation(state)
    const lost = advanceUntil(danger, (candidate) => candidate.status === 'lost')

    expect(lost.dangerRemainingMs).toBe(0)
    expect(lost.status).toBe('lost')
  })

  it('pauses the timer while a top-row clear is rescuing the board', () => {
    const initial = createSimulation('danger-pause')
    let state = {
      ...initial,
      board: boardWith([
        [11, 0, 'heart'],
        [11, 1, 'heart'],
        [11, 2, 'heart'],
      ]),
    }

    state = stepSimulation(state)
    const startingDangerMs = state.dangerRemainingMs
    expect(state.lastClearEvent?.touchedTop).toBe(true)

    for (let step = 0; step < 10; step += 1) {
      state = stepSimulation(state)
    }
    expect(state.dangerRemainingMs).toBe(startingDangerMs)

    const rescued = advanceUntil(
      state,
      (candidate) => candidate.dangerRemainingMs === null,
    )
    expect(rescued.status).toBe('playing')
    expect(rescued.board.cells[11]!.every((panel) => panel === null)).toBe(true)
  })

  it('does not pause for an unrelated clear below the blocked top', () => {
    const initial = createSimulation('danger-unrelated')
    let state = {
      ...initial,
      board: boardWith([
        [11, 5, 'star'],
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
      ]),
    }

    state = stepSimulation(state)
    const startingDangerMs = state.dangerRemainingMs!
    expect(state.lastClearEvent?.touchedTop).toBe(false)
    state = stepSimulation(state)

    expect(state.dangerRemainingMs).toBeLessThan(startingDangerMs)
  })
})
