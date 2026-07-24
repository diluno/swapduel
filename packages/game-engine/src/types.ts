export const NORMAL_PANEL_TYPES = [
  'circle',
  'triangle',
  'star',
  'diamond',
  'heart',
  'crescent',
] as const

export type NormalPanelType = (typeof NORMAL_PANEL_TYPES)[number]
export type PanelType = NormalPanelType | 'shock'

export type CellState =
  | 'idle'
  | 'swapping'
  | 'hovering'
  | 'falling'
  | 'matched'
  | 'flashing'
  | 'clearing'
  | 'garbage-locked'

export interface Panel {
  id: number
  type: PanelType
  state: CellState
  row: number
  column: number
  offsetX: number
  offsetY: number
  chainEligible: boolean
  chainId: number | null
  animationStartedAt: number | null
}

export type Cell = Panel | null

export interface Board {
  columns: number
  visibleRows: number
  hiddenRows: number
  cells: Cell[][]
  incomingRow: PanelType[]
  nextPanelId: number
}

export interface Coordinate {
  row: number
  column: number
}

export interface SwapAction {
  row: number
  column: number
  direction: -1 | 1
}

export interface PendingSwap {
  from: Coordinate
  to: Coordinate
  startedAt: number
}

export interface AttackBlock {
  width: number
  height: number
  type: 'normal' | 'metal'
}

export interface IncomingGarbageAttack {
  attackId: string
  serverSequence: number
  blocks: AttackBlock[]
}

export interface GarbageBlock {
  id: number
  type: 'normal' | 'metal'
  column: number
  row: number
  width: number
  height: number
  conversionRow: number | null
  state: 'falling' | 'idle' | 'converting'
  fallProgress: number
}

export interface GarbageConversionState {
  blockIds: number[]
  activeBlockId: number
  nextColumn: number
  convertedPanelIds: number[]
  nextCellAt: number
  releaseAt: number | null
}

export interface AttackTableEntry {
  minimum: number
  maximum: number | null
  blocks: AttackBlock[]
}

export interface OutgoingAttack {
  sequence: number
  kind: 'combo' | 'chain' | 'shock'
  createdAt: number
  clearSize: number
  chainLevel: number
  blocks: AttackBlock[]
}

export interface ChainState {
  id: number
  level: number
  startedAt: number
  lastQualifyingEventAt: number
  closingStartedAt: number | null
  status: 'active' | 'closing'
}

export interface ClearEvent {
  size: number
  normalSize: number
  shockSize: number
  chainLevel: number
  qualifiedForChain: boolean
  touchedTop: boolean
  occurredAt: number
  attackSequences: number[]
}

export type ResolutionPhase =
  | 'idle'
  | 'flashing'
  | 'clearing'
  | 'garbage-converting'
  | 'garbage-falling'
  | 'fall-delay'
export type RoundStatus = 'playing' | 'paused' | 'lost'

export interface SimulationState {
  seed: string
  randomState: number
  garbageRandomState: number
  conversionRandomState: number
  elapsedMs: number
  board: Board
  riseOffset: number
  riseSpeed: number
  stopTimeRemainingMs: number
  dangerRemainingMs: number | null
  manualRaise: boolean
  status: RoundStatus
  phase: ResolutionPhase
  phaseStartedAt: number
  matchedPanelIds: number[]
  pendingSwap: PendingSwap | null
  chain: ChainState | null
  nextChainId: number
  outgoingAttacks: OutgoingAttack[]
  nextAttackSequence: number
  lastClearEvent: ClearEvent | null
  garbage: GarbageBlock[]
  incomingGarbage: IncomingGarbageAttack[]
  receivedAttackIds: string[]
  receivedAttackSequences: number[]
  nextGarbageId: number
  garbageConversion: GarbageConversionState | null
  totalCleared: number
  lastClearSize: number
}

export interface BoardConfig {
  columns: number
  visibleRows: number
  hiddenRows: number
  startingRows: number
  normalPanelTypes: 5 | 6
  shockPanelChance: number
}

export interface TimingConfig {
  fixedStepMs: number
  swapDurationMs: number
  matchFlashDurationMs: number
  clearDurationMs: number
  fallDelayMs: number
  fallCellsPerSecond: number
  garbageFallCellsPerSecond: number
  garbageCellConvertMs: number
  garbageReleaseDelayMs: number
  chainWindowMs: number
  comboStopBaseMs: number
  comboStopPerPanelMs: number
  chainStopBaseMs: number
  chainStopPerLevelMs: number
  maximumStopTimeMs: number
  dangerGraceMs: number
}

export interface RiseConfig {
  startingRowsPerSecond: number
  speedIncreaseIntervalSeconds: number
  speedMultiplierPerIncrease: number
  maximumRowsPerSecond: number
  manualRowsPerSecond: number
}

export interface AttackConfig {
  comboTable: AttackTableEntry[]
  shockTable: AttackTableEntry[]
}

export interface GameConfig {
  board: BoardConfig
  timing: TimingConfig
  rise: RiseConfig
  attacks: AttackConfig
}

export type SwapResult =
  | { ok: true; state: SimulationState }
  | {
      ok: false
      reason:
        | 'simulation-not-playing'
        | 'board-busy'
        | 'outside-board'
        | 'not-adjacent'
        | 'cell-locked'
        | 'both-empty'
      state: SimulationState
    }
