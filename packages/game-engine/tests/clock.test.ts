import { describe, expect, it } from 'vitest'
import {
  CLOCK_UNITS_PER_STEP,
  clockToMilliseconds,
  createSimulation,
  defaultGameConfig,
  millisecondsToClock,
  stepSimulation,
} from '../src'

describe('integer simulation clock', () => {
  it('represents milliseconds and the 60 Hz step exactly', () => {
    expect(millisecondsToClock(220)).toBe(660)
    expect(CLOCK_UNITS_PER_STEP).toBe(50)
    expect(clockToMilliseconds(CLOCK_UNITS_PER_STEP)).toBe(50 / 3)
  })

  it('does not accumulate floating-point drift over a two-minute run', () => {
    const config = structuredClone(defaultGameConfig)
    config.board.startingRows = 0
    config.rise.startingRowsPerSecond = 0
    config.rise.maximumRowsPerSecond = 0
    let state = createSimulation('clock-soak', config)

    for (let step = 0; step < 7_200; step += 1) {
      state = stepSimulation(state, config)
    }

    expect(state.step).toBe(7_200)
    expect(state.elapsedClock).toBe(360_000)
    expect(state.elapsedMs).toBe(120_000)
  })
})
