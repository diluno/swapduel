import { describe, expect, it } from 'vitest'
import {
  advanceSimulation,
  createSimulation,
  defaultGameConfig,
  requestSwap,
  setManualRaise,
  stepSimulation,
  timeTrialDurationMs,
} from '../src'

const step = defaultGameConfig.timing.fixedStepMs

function timedRun(timeLimitMs = timeTrialDurationMs) {
  return createSimulation('time-trial-seed', defaultGameConfig, {
    timeLimitMs,
  })
}

describe('timed runs', () => {
  it('leaves an untimed run open-ended', () => {
    const state = createSimulation('endless-seed')

    expect(state.timeLimitMs).toBeNull()
    expect(advanceSimulation(state, 10_000).status).toBe('playing')
  })

  it('ends the run when the clock runs out', () => {
    const state = timedRun(1_000)
    const before = advanceSimulation(state, 1_000 - step)

    expect(before.status).toBe('playing')

    const after = stepSimulation(before)

    expect(after.status).toBe('lost')
    expect(after.endReason).toBe('time-up')
  })

  it('pins the clock to the limit so the readout lands on the mark', () => {
    // 1,000ms is not a whole number of 16.67ms steps, so an unpinned clock
    // would overshoot and the countdown would render a step past zero.
    const finished = advanceSimulation(timedRun(1_000), 2_000)

    expect(finished.elapsedMs).toBe(1_000)
  })

  it('stops the stack and refuses input once time is up', () => {
    const finished = advanceSimulation(timedRun(1_000), 1_100)
    const swap = requestSwap(finished, { row: 0, column: 0, direction: 1 })

    expect(swap.ok).toBe(false)
    expect(finished.riseSpeed).toBe(0)
    expect(finished.manualRaise).toBe(false)
    expect(setManualRaise(finished, true).manualRaise).toBe(false)
  })

  it('keeps the score earned before the buzzer', () => {
    const finished = advanceSimulation(timedRun(1_000), 5_000)

    expect(finished.score).toBe(advanceSimulation(timedRun(1_000), 1_000).score)
  })

  it('reports a top-out as the reason when the stack loses first', () => {
    let state = timedRun(timeTrialDurationMs)
    // Holding the raise buries the board long before two minutes are up.
    state = setManualRaise(state, true)
    while (state.status === 'playing' && state.elapsedMs < timeTrialDurationMs) {
      state = stepSimulation(state)
      if (state.status === 'playing') state = setManualRaise(state, true)
    }

    expect(state.status).toBe('lost')
    expect(state.endReason).toBe('topped-out')
    expect(state.elapsedMs).toBeLessThan(timeTrialDurationMs)
  })
})
