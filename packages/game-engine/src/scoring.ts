import { defaultGameConfig } from './config'
import type { GameConfig, ScoreTableEntry } from './types'

function tablePoints(value: number, table: ScoreTableEntry[]): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('value must be a non-negative integer')
  }

  const entry = table.find(
    ({ minimum, maximum }) =>
      value >= minimum && (maximum === null || value <= maximum),
  )

  return entry?.points ?? 0
}

/** Bonus for clearing more than the minimum three panels at once. */
export function comboScoreBonus(
  clearSize: number,
  config: GameConfig = defaultGameConfig,
): number {
  return tablePoints(clearSize, config.scoring.comboTable)
}

/** Bonus for extending a chain; worth far more than the equivalent combo. */
export function chainScoreBonus(
  chainLevel: number,
  config: GameConfig = defaultGameConfig,
): number {
  return tablePoints(chainLevel, config.scoring.chainTable)
}

/**
 * Points awarded for a single clear: every panel pays out, and the combo and
 * chain bonuses stack on top so a chain link that is also a big combo scores
 * both.
 */
export function clearScore(
  options: {
    size: number
    normalSize: number
    chainLevel: number
    qualifiedForChain: boolean
  },
  config: GameConfig = defaultGameConfig,
): number {
  const panels = options.size * config.scoring.panelPoints
  const combo = comboScoreBonus(options.normalSize, config)
  const chain =
    options.qualifiedForChain && options.chainLevel >= 2
      ? chainScoreBonus(options.chainLevel, config)
      : 0

  return panels + combo + chain
}
