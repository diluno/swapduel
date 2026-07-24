import { describe, expect, it } from 'vitest'
import {
  chainAttackBlocks,
  comboAttackBlocks,
  createSimulation,
  defaultGameConfig,
  drainOutgoingAttacks,
  shockAttackBlocks,
  stepSimulation,
} from '../src'
import { boardWith } from './helpers'

describe('data-driven attack tables', () => {
  it.each([
    [3, []],
    [4, [{ width: 3, height: 1, type: 'normal' }]],
    [5, [{ width: 4, height: 1, type: 'normal' }]],
    [6, [{ width: 5, height: 1, type: 'normal' }]],
    [7, [{ width: 6, height: 1, type: 'normal' }]],
    [
      8,
      [
        { width: 3, height: 1, type: 'normal' },
        { width: 4, height: 1, type: 'normal' },
      ],
    ],
    [
      10,
      [
        { width: 5, height: 1, type: 'normal' },
        { width: 5, height: 1, type: 'normal' },
      ],
    ],
    [12, [{ width: 6, height: 2, type: 'normal' }]],
    [20, [{ width: 6, height: 2, type: 'normal' }]],
  ] as const)(
    'maps a %i-panel clear to the configured garbage',
    (clearSize, blocks) => {
      expect(comboAttackBlocks(clearSize)).toEqual(blocks)
    },
  )

  it.each([
    [1, []],
    [2, [{ width: 6, height: 1, type: 'normal' }]],
    [3, [{ width: 6, height: 2, type: 'normal' }]],
    [6, [{ width: 6, height: 5, type: 'normal' }]],
  ] as const)('maps a x%i chain to full-width garbage', (level, blocks) => {
    expect(chainAttackBlocks(level)).toEqual(blocks)
  })

  it.each([
    [2, []],
    [3, [{ width: 6, height: 1, type: 'metal' }]],
    [4, [{ width: 6, height: 2, type: 'metal' }]],
    [5, [{ width: 6, height: 3, type: 'metal' }]],
    [6, [{ width: 6, height: 4, type: 'metal' }]],
  ] as const)(
    'maps a %i-panel shock clear to metal garbage',
    (clearSize, blocks) => {
      expect(shockAttackBlocks(clearSize)).toEqual(blocks)
    },
  )

  it('queues combo attacks with monotonic local sequences', () => {
    const initial = createSimulation('combo-queue')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'heart'],
        [0, 1, 'heart'],
        [0, 2, 'heart'],
        [0, 3, 'heart'],
      ]),
    }
    const matched = stepSimulation(state)

    expect(matched.outgoingAttacks).toEqual([
      expect.objectContaining({
        sequence: 1,
        kind: 'combo',
        clearSize: 4,
        chainLevel: 1,
        blocks: [{ width: 3, height: 1, type: 'normal' }],
      }),
    ])
    expect(matched.lastClearEvent?.attackSequences).toEqual([1])
    expect(matched.stopTimeRemainingMs).toBe(
      defaultGameConfig.timing.comboStopBaseMs,
    )

    const drained = drainOutgoingAttacks(matched)
    expect(drained.attacks).toHaveLength(1)
    expect(drained.state.outgoingAttacks).toEqual([])
    expect(drained.state.nextAttackSequence).toBe(2)
  })

  it('queues metal garbage for a connected shock clear', () => {
    const initial = createSimulation('shock-attack')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'shock'],
        [0, 1, 'shock'],
        [1, 1, 'shock'],
      ]),
    }
    const matched = stepSimulation(state)

    expect(matched.lastClearEvent).toMatchObject({
      size: 3,
      normalSize: 0,
      shockSize: 3,
    })
    expect(matched.outgoingAttacks).toEqual([
      expect.objectContaining({
        sequence: 1,
        kind: 'shock',
        clearSize: 3,
        blocks: [{ width: 6, height: 1, type: 'metal' }],
      }),
    ])
  })
})
