import { describe, expect, it } from 'vitest'
import {
  advanceSimulation,
  chainScoreBonus,
  clearScore,
  comboScoreBonus,
  createSimulation,
  defaultGameConfig,
} from '../src'
import { boardWith } from './helpers'

describe('scoring tables', () => {
  it.each([
    [3, 0],
    [4, 20],
    [6, 50],
    [10, 100],
    [15, 290],
    [40, 290],
  ] as const)('scores a %i-panel clear at %i bonus points', (size, points) => {
    expect(comboScoreBonus(size)).toBe(points)
  })

  it.each([
    [1, 0],
    [2, 50],
    [4, 150],
    [13, 1_800],
    [30, 1_800],
  ] as const)('scores a x%i chain at %i bonus points', (level, points) => {
    expect(chainScoreBonus(level)).toBe(points)
  })

  it('pays for every panel and stacks the combo and chain bonuses', () => {
    const { panelPoints } = defaultGameConfig.scoring

    expect(
      clearScore({
        size: 3,
        normalSize: 3,
        chainLevel: 1,
        qualifiedForChain: false,
      }),
    ).toBe(3 * panelPoints)

    // A five-panel clear that also extends a chain to x3 earns both bonuses.
    expect(
      clearScore({
        size: 5,
        normalSize: 5,
        chainLevel: 3,
        qualifiedForChain: true,
      }),
    ).toBe(5 * panelPoints + 30 + 80)

    // A chain level only counts when the clear actually continued the chain.
    expect(
      clearScore({
        size: 5,
        normalSize: 5,
        chainLevel: 3,
        qualifiedForChain: false,
      }),
    ).toBe(5 * panelPoints + 30)
  })

  it('rejects nonsense sizes rather than scoring them', () => {
    expect(() => comboScoreBonus(-1)).toThrow(RangeError)
    expect(() => chainScoreBonus(1.5)).toThrow(RangeError)
  })
})

describe('score accumulation', () => {
  it('starts at zero and banks points as clears resolve', () => {
    const initial = createSimulation('scoring-run')
    expect(initial.score).toBe(0)

    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [0, 3, 'circle'],
      ]),
    }
    const resolved = advanceSimulation(state, 1_000)

    // Four panels at ten points each, plus the four-panel combo bonus.
    expect(resolved.score).toBe(4 * defaultGameConfig.scoring.panelPoints + 20)
  })
})
