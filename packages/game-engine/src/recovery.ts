import { defaultGameConfig } from './config'
import type {
  AttackBlock,
  Board,
  ClearEvent,
  GameConfig,
  GarbageBlock,
  GarbageConversionState,
  IncomingGarbageAttack,
  OutgoingAttack,
  Panel,
  SimulationState,
} from './types'

const panelTypes = new Set([
  'circle',
  'triangle',
  'star',
  'diamond',
  'heart',
  'crescent',
  'shock',
])
const cellStates = new Set([
  'idle',
  'swapping',
  'hovering',
  'falling',
  'matched',
  'flashing',
  'clearing',
  'garbage-locked',
])
const phases = new Set([
  'idle',
  'flashing',
  'clearing',
  'garbage-converting',
  'garbage-falling',
  'fall-delay',
])
const statuses = new Set(['playing', 'paused', 'lost'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum
  )
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isNumberArray(value: unknown, maximum: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => isInteger(entry))
  )
}

function isStringArray(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length <= 128,
    )
  )
}

function isCoordinate(
  value: unknown,
  board: GameConfig['board'],
): boolean {
  return (
    isRecord(value) &&
    isInteger(value.row) &&
    value.row < board.visibleRows &&
    isInteger(value.column) &&
    value.column < board.columns
  )
}

function isPanel(
  value: unknown,
  row: number,
  column: number,
): value is Panel {
  return (
    isRecord(value) &&
    isInteger(value.id, 1) &&
    typeof value.type === 'string' &&
    panelTypes.has(value.type) &&
    typeof value.state === 'string' &&
    cellStates.has(value.state) &&
    value.row === row &&
    value.column === column &&
    isFiniteNumber(value.offsetX) &&
    isFiniteNumber(value.offsetY) &&
    typeof value.chainEligible === 'boolean' &&
    (value.chainId === null || isInteger(value.chainId, 1)) &&
    isNullableNumber(value.animationStartedAt)
  )
}

function isBoard(value: unknown, config: GameConfig): value is Board {
  if (
    !isRecord(value) ||
    value.columns !== config.board.columns ||
    value.visibleRows !== config.board.visibleRows ||
    value.hiddenRows !== config.board.hiddenRows ||
    !Array.isArray(value.cells) ||
    value.cells.length !== config.board.visibleRows ||
    !Array.isArray(value.incomingRow) ||
    value.incomingRow.length !== config.board.columns ||
    !value.incomingRow.every(
      (type) => typeof type === 'string' && panelTypes.has(type),
    ) ||
    !isInteger(value.nextPanelId, 1)
  ) {
    return false
  }

  return value.cells.every(
    (cells, row) =>
      Array.isArray(cells) &&
      cells.length === config.board.columns &&
      cells.every(
        (cell, column) =>
          cell === null || isPanel(cell, row, column),
      ),
  )
}

function isAttackBlock(value: unknown): value is AttackBlock {
  return (
    isRecord(value) &&
    isInteger(value.width, 1) &&
    value.width <= 6 &&
    isInteger(value.height, 1) &&
    value.height <= 12 &&
    (value.type === 'normal' || value.type === 'metal')
  )
}

function hasAttackBlocks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every(isAttackBlock)
  )
}

function isOutgoingAttack(value: unknown): value is OutgoingAttack {
  return (
    isRecord(value) &&
    isInteger(value.sequence) &&
    (value.kind === 'combo' ||
      value.kind === 'chain' ||
      value.kind === 'shock') &&
    isFiniteNumber(value.createdAt) &&
    isInteger(value.clearSize) &&
    isInteger(value.chainLevel) &&
    hasAttackBlocks(value.blocks)
  )
}

function isIncomingAttack(value: unknown): value is IncomingGarbageAttack {
  return (
    isRecord(value) &&
    typeof value.attackId === 'string' &&
    value.attackId.length > 0 &&
    value.attackId.length <= 128 &&
    isInteger(value.serverSequence) &&
    hasAttackBlocks(value.blocks)
  )
}

function isGarbage(value: unknown, config: GameConfig): value is GarbageBlock {
  return (
    isRecord(value) &&
    isInteger(value.id, 1) &&
    (value.type === 'normal' || value.type === 'metal') &&
    isInteger(value.column) &&
    isInteger(value.width, 1) &&
    value.column + value.width <= config.board.columns &&
    isInteger(value.row) &&
    value.row <= config.board.visibleRows &&
    isInteger(value.height, 1) &&
    value.height <= config.board.visibleRows + config.board.hiddenRows &&
    (value.conversionRow === null || isInteger(value.conversionRow)) &&
    (value.state === 'falling' ||
      value.state === 'idle' ||
      value.state === 'converting') &&
    isFiniteNumber(value.fallProgress) &&
    value.fallProgress >= 0 &&
    value.fallProgress < 1
  )
}

function isClearEvent(value: unknown): value is ClearEvent {
  return (
    isRecord(value) &&
    isInteger(value.size) &&
    isInteger(value.normalSize) &&
    isInteger(value.shockSize) &&
    isInteger(value.chainLevel) &&
    typeof value.qualifiedForChain === 'boolean' &&
    typeof value.touchedTop === 'boolean' &&
    isFiniteNumber(value.occurredAt) &&
    isNumberArray(value.attackSequences, 32)
  )
}

function isGarbageConversion(
  value: unknown,
): value is GarbageConversionState {
  return (
    isRecord(value) &&
    isNumberArray(value.blockIds, 32) &&
    isInteger(value.activeBlockId, 1) &&
    isInteger(value.nextColumn) &&
    isNumberArray(value.convertedPanelIds, 128) &&
    isFiniteNumber(value.nextCellAt) &&
    isNullableNumber(value.releaseAt)
  )
}

export function isSimulationState(
  value: unknown,
  config: GameConfig = defaultGameConfig,
): value is SimulationState {
  return (
    isRecord(value) &&
    typeof value.seed === 'string' &&
    value.seed.length > 0 &&
    value.seed.length <= 128 &&
    isInteger(value.randomState) &&
    isInteger(value.garbageRandomState) &&
    isInteger(value.conversionRandomState) &&
    isFiniteNumber(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    isBoard(value.board, config) &&
    isFiniteNumber(value.riseOffset) &&
    value.riseOffset >= 0 &&
    value.riseOffset < 1 &&
    isFiniteNumber(value.riseSpeed) &&
    value.riseSpeed >= 0 &&
    isFiniteNumber(value.stopTimeRemainingMs) &&
    value.stopTimeRemainingMs >= 0 &&
    value.stopTimeRemainingMs <= config.timing.maximumStopTimeMs &&
    (value.dangerRemainingMs === null ||
      (isFiniteNumber(value.dangerRemainingMs) &&
        value.dangerRemainingMs >= 0)) &&
    typeof value.manualRaise === 'boolean' &&
    typeof value.status === 'string' &&
    statuses.has(value.status) &&
    typeof value.phase === 'string' &&
    phases.has(value.phase) &&
    isFiniteNumber(value.phaseStartedAt) &&
    isNumberArray(value.matchedPanelIds, 72) &&
    (value.pendingSwap === null ||
      (isRecord(value.pendingSwap) &&
        isCoordinate(value.pendingSwap.from, config.board) &&
        isCoordinate(value.pendingSwap.to, config.board) &&
        isFiniteNumber(value.pendingSwap.startedAt))) &&
    (value.chain === null ||
      (isRecord(value.chain) &&
        isInteger(value.chain.id, 1) &&
        isInteger(value.chain.level, 1) &&
        isFiniteNumber(value.chain.startedAt) &&
        isFiniteNumber(value.chain.lastQualifyingEventAt) &&
        isNullableNumber(value.chain.closingStartedAt) &&
        (value.chain.status === 'active' ||
          value.chain.status === 'closing'))) &&
    isInteger(value.nextChainId, 1) &&
    Array.isArray(value.outgoingAttacks) &&
    value.outgoingAttacks.length <= 128 &&
    value.outgoingAttacks.every(isOutgoingAttack) &&
    isInteger(value.nextAttackSequence) &&
    (value.lastClearEvent === null ||
      isClearEvent(value.lastClearEvent)) &&
    Array.isArray(value.garbage) &&
    value.garbage.length <= 32 &&
    value.garbage.every((block) => isGarbage(block, config)) &&
    Array.isArray(value.incomingGarbage) &&
    value.incomingGarbage.length <= 128 &&
    value.incomingGarbage.every(isIncomingAttack) &&
    isStringArray(value.receivedAttackIds, 2_048) &&
    isNumberArray(value.receivedAttackSequences, 2_048) &&
    isInteger(value.nextGarbageId, 1) &&
    (value.garbageConversion === null ||
      isGarbageConversion(value.garbageConversion)) &&
    isInteger(value.totalCleared) &&
    isInteger(value.lastClearSize)
  )
}

export interface SimulationSnapshotOptions {
  scopeId: string
  expectedSeed: string
  now: number
  maxAgeMs: number
  maxBytes?: number
}

export function serializeSimulationSnapshot(
  state: SimulationState,
  scopeId: string,
  savedAt: number,
): string {
  return JSON.stringify({
    version: 2,
    scopeId,
    seed: state.seed,
    savedAt,
    state,
  })
}

export function restoreSimulationSnapshot(
  serialized: string,
  options: SimulationSnapshotOptions,
): SimulationState | null {
  if (
    serialized.length > (options.maxBytes ?? 512_000) ||
    options.maxAgeMs < 0
  ) {
    return null
  }

  try {
    const snapshot: unknown = JSON.parse(serialized)
    if (
      !isRecord(snapshot) ||
      snapshot.version !== 2 ||
      snapshot.scopeId !== options.scopeId ||
      snapshot.seed !== options.expectedSeed ||
      !isFiniteNumber(snapshot.savedAt) ||
      snapshot.savedAt > options.now + 5_000 ||
      options.now - snapshot.savedAt > options.maxAgeMs ||
      !isSimulationState(snapshot.state) ||
      snapshot.state.seed !== options.expectedSeed
    ) {
      return null
    }
    return {
      ...snapshot.state,
      manualRaise: false,
    }
  } catch {
    return null
  }
}
