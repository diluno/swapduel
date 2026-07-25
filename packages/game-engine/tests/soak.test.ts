import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  defaultGameConfig,
  enqueueIncomingGarbage,
  requestSwap,
  stepSimulation,
  type SimulationState,
} from '../src'

// Deterministic pseudo-random driver so a failure is always reproducible.
function driver(seed: number): () => number {
  let value = seed
  return () => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648
    return value / 2_147_483_648
  }
}

describe('soak', () => {
  it('never wedges the board when swapping continuously through resolution', () => {
    const config = defaultGameConfig
    let state = createSimulation('soak-run')
    const random = driver(20_260_725)
    let attacks = 0

    // ~90 seconds of play, swapping as fast as the engine will take one.
    for (let step = 0; step < 90 * 60 && state.status === 'playing'; step += 1) {
      if (state.pendingSwap === null && random() < 0.35) {
        const row = Math.floor(random() * (config.board.visibleRows - 1))
        const column = Math.floor(random() * (config.board.columns - 1))
        state = requestSwap(state, { row, column, direction: 1 }, config).state
      }

      if (step % 900 === 0 && step > 0) {
        attacks += 1
        state = enqueueIncomingGarbage(state, {
          attackId: `soak-${attacks}`,
          serverSequence: attacks,
          blocks: [{ width: 6, height: 1, type: 'normal' }],
        })
      }

      state = stepSimulation(state, config)

      // A panel that hovers for longer than the fall delay plus a generous
      // margin is stuck: gravity has stopped picking it up and the cells above
      // it can never match again.
      for (const boardRow of state.board.cells) {
        for (const panel of boardRow) {
          if (panel === null || panel.state !== 'hovering') continue
          const hoveringFor = state.elapsedMs - (panel.animationStartedAt ?? 0)
          expect(hoveringFor).toBeLessThan(config.timing.fallDelayMs + 1_000)
        }
      }
    }

    // The board kept resolving rather than seizing up, and the run either
    // survived or topped out honestly.
    expect(state.totalCleared).toBeGreaterThan(0)
    expect(['playing', 'lost']).toContain(state.status)
  })

  it('returns to a settled idle board once swapping stops', () => {
    let state: SimulationState = createSimulation('soak-settle')
    const random = driver(7)

    for (let step = 0; step < 1_800; step += 1) {
      if (state.pendingSwap === null && random() < 0.4) {
        const row = Math.floor(random() * 6)
        const column = Math.floor(random() * 5)
        state = requestSwap(state, { row, column, direction: 1 }).state
      }
      state = stepSimulation(state)
    }

    // Freeze the stack so nothing new arrives, then let it drain.
    state = { ...state, manualRaise: false, riseSpeed: 0 }
    for (let step = 0; step < 600; step += 1) {
      state = stepSimulation({ ...state, riseOffset: 0 })
    }

    expect(state.clears).toEqual([])
    expect(
      state.board.cells
        .flat()
        .every((panel) => panel === null || panel.state !== 'hovering'),
    ).toBe(true)
  })
})
