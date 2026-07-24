import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  isSimulationState,
  requestSwap,
  restoreSimulationSnapshot,
  serializeSimulationSnapshot,
  simulationChecksum,
  stepSimulation,
} from '../src'

describe('simulation recovery validation', () => {
  it('accepts a serialized active simulation without changing its checksum', () => {
    let state = createSimulation('recover-round')
    state = requestSwap(state, {
      row: 1,
      column: 2,
      direction: 1,
    }).state
    for (let step = 0; step < 120; step += 1) {
      state = stepSimulation(state)
    }

    const restored: unknown = JSON.parse(JSON.stringify(state))
    expect(isSimulationState(restored)).toBe(true)
    if (!isSimulationState(restored)) return
    expect(simulationChecksum(restored)).toBe(simulationChecksum(state))
  })

  it('rejects malformed board geometry and panel coordinates', () => {
    const missingRow = structuredClone(createSimulation('bad-rows'))
    missingRow.board.cells.pop()
    expect(isSimulationState(missingRow)).toBe(false)

    const wrongCoordinate = structuredClone(
      createSimulation('bad-coordinate'),
    )
    wrongCoordinate.board.cells[0]![0]!.row = 9
    expect(isSimulationState(wrongCoordinate)).toBe(false)
  })

  it('rejects unsafe counters and oversized recovery queues', () => {
    const unsafe = structuredClone(createSimulation('bad-counter'))
    unsafe.elapsedMs = Number.NaN
    expect(isSimulationState(unsafe)).toBe(false)

    const oversized = structuredClone(createSimulation('bad-queue'))
    oversized.receivedAttackIds = Array.from(
      { length: 2_049 },
      (_, index) => `attack-${index}`,
    )
    expect(isSimulationState(oversized)).toBe(false)
  })

  it('restores only fresh snapshots for the expected round and seed', () => {
    const state = createSimulation('snapshot-seed')
    const serialized = serializeSimulationSnapshot(
      { ...state, manualRaise: true },
      'match-1:round-1',
      10_000,
    )
    const options = {
      scopeId: 'match-1:round-1',
      expectedSeed: 'snapshot-seed',
      now: 20_000,
      maxAgeMs: 30_000,
    }

    expect(restoreSimulationSnapshot(serialized, options)).toMatchObject({
      seed: 'snapshot-seed',
      manualRaise: false,
    })
    expect(
      restoreSimulationSnapshot(serialized, {
        ...options,
        scopeId: 'match-1:round-2',
      }),
    ).toBeNull()
    expect(
      restoreSimulationSnapshot(serialized, {
        ...options,
        expectedSeed: 'different-seed',
      }),
    ).toBeNull()
    expect(
      restoreSimulationSnapshot(serialized, {
        ...options,
        now: 40_001,
      }),
    ).toBeNull()
    expect(restoreSimulationSnapshot('{bad json', options)).toBeNull()
  })
})
