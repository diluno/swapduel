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

// A supported full stack in column 0: blocks the top row without floating,
// and alternates types so it never matches itself. Row 0 is 'triangle' so it
// cannot extend a horizontal circle match in the bottom row.
const blockingColumn: Array<
  [row: number, column: number, type: 'circle' | 'triangle']
> = Array.from({ length: 12 }, (_, row) => [
  row,
  0,
  row % 2 === 0 ? 'triangle' : 'circle',
])

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
      // Hearts across the top of three full columns. The fill alternates in
      // both directions so nothing but the heart row can match, and it keeps
      // the hearts grounded — a floating row would just fall instead.
      board: boardWith([
        ...Array.from({ length: 3 }, (_, column) =>
          Array.from({ length: 11 }, (_, row) => [
            row,
            column,
            (row + column) % 2 === 0 ? 'circle' : 'triangle',
          ]),
        ).flat() as Array<[number, number, 'circle' | 'triangle']>,
        [11, 0, 'heart'],
        [11, 1, 'heart'],
        [11, 2, 'heart'],
      ]),
    }

    state = stepSimulation(state)
    const startingDangerMs = state.dangerRemainingMs

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

  it('pauses for a clear below the blocked top, not just top-row ones', () => {
    const initial = createSimulation('danger-unrelated')
    let state = {
      ...initial,
      // A grounded stack in column 5 blocks the top; the circles clear far
      // away from it on the bottom row.
      board: boardWith([
        ...Array.from({ length: 11 }, (_, row) => [
          row,
          5,
          row % 2 === 0 ? 'triangle' : 'diamond',
        ]) as Array<[number, number, 'triangle' | 'diamond']>,
        [11, 5, 'star'],
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
      ]),
    }

    state = stepSimulation(state)
    const startingDangerMs = state.dangerRemainingMs!
    // Removing panels lower down is how the stack normally falls away from
    // the top, so the clock has to hold for it too.
    expect(state.lastClearEvent?.touchedTop).toBe(false)

    for (let step = 0; step < 10; step += 1) {
      state = stepSimulation(state)
    }
    expect(state.phase).not.toBe('idle')
    expect(state.dangerRemainingMs).toBe(startingDangerMs)
  })

  it('holds the clock across a cascade until the board settles', () => {
    const initial = createSimulation('danger-cascade')
    // Column 0 is a supported full stack, so the board stays blocked for the
    // whole test. Clearing the circles in row 0 drops the hearts into row 0,
    // cascading into a second match without the player acting again.
    let state = {
      ...initial,
      board: boardWith([
        ...blockingColumn,
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [0, 3, 'circle'],
        [1, 1, 'heart'],
        [1, 2, 'heart'],
        [2, 3, 'heart'],
      ]),
    }

    state = stepSimulation(state)
    const startingDangerMs = state.dangerRemainingMs!

    // Two flash+clear+fall cycles run about 1240ms, so allow well past that.
    let sawIdle = false
    const clearTimes = new Set<number>()
    for (let step = 0; step < 200; step += 1) {
      state = stepSimulation(state)
      if (state.lastClearEvent !== null) {
        clearTimes.add(state.lastClearEvent.occurredAt)
      }
      if (state.phase === 'idle') {
        sawIdle = true
        break
      }
      expect(state.dangerRemainingMs).toBe(startingDangerMs)
    }

    expect(sawIdle).toBe(true)
    // Two separate clears, i.e. the cascade actually happened and the clock
    // held across both of them rather than only the first.
    expect(clearTimes.size).toBe(2)
  })

  it('resumes the clock once the board settles while still blocked', () => {
    const initial = createSimulation('danger-resume')
    // A settled board that is still blocked, carrying a stale top-touching
    // clear from earlier. The clock must tick: lastClearEvent lingers after
    // its clear finished and must not keep freezing the countdown.
    const state: SimulationState = {
      ...initial,
      board: boardWith(blockingColumn),
      phase: 'idle',
      dangerRemainingMs: defaultGameConfig.timing.dangerGraceMs,
      lastClearEvent: {
        size: 3,
        normalSize: 3,
        shockSize: 0,
        chainLevel: 1,
        qualifiedForChain: false,
        touchedTop: true,
        occurredAt: 0,
        attackSequences: [],
      },
    }

    const stepped = stepSimulation(state)

    expect(stepped.dangerRemainingMs).toBeLessThan(
      defaultGameConfig.timing.dangerGraceMs,
    )
  })
})
