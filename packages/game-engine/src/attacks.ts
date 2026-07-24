import { defaultGameConfig } from './config'
import type { AttackBlock, GameConfig } from './types'

function cloneBlocks(blocks: AttackBlock[]): AttackBlock[] {
  return blocks.map((block) => ({ ...block }))
}

function tableAttackBlocks(
  clearSize: number,
  table: GameConfig['attacks']['comboTable'],
): AttackBlock[] {
  if (!Number.isInteger(clearSize) || clearSize < 0) {
    throw new RangeError('clearSize must be a non-negative integer')
  }

  const entry = table.find(
    ({ minimum, maximum }) =>
      clearSize >= minimum && (maximum === null || clearSize <= maximum),
  )

  return entry === undefined ? [] : cloneBlocks(entry.blocks)
}

export function comboAttackBlocks(
  clearSize: number,
  config: GameConfig = defaultGameConfig,
): AttackBlock[] {
  return tableAttackBlocks(clearSize, config.attacks.comboTable)
}

export function shockAttackBlocks(
  clearSize: number,
  config: GameConfig = defaultGameConfig,
): AttackBlock[] {
  return tableAttackBlocks(clearSize, config.attacks.shockTable)
}

export function chainAttackBlocks(
  chainLevel: number,
  columns = defaultGameConfig.board.columns,
): AttackBlock[] {
  if (!Number.isInteger(chainLevel) || chainLevel < 0) {
    throw new RangeError('chainLevel must be a non-negative integer')
  }
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new RangeError('columns must be a positive integer')
  }

  return chainLevel < 2
    ? []
    : [{ width: columns, height: chainLevel - 1, type: 'normal' }]
}
