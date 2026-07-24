import {
  chainAttackBlocks,
  comboAttackBlocks,
  shockAttackBlocks,
} from './attacks'
import {
  availableTypes,
  createInitialBoard,
  insertIncomingRow,
} from './board'
import { defaultGameConfig } from './config'
import { advanceDangerState } from './danger'
import {
  advanceFallingGarbage,
  garbageAt,
  garbageBlockCanFall,
  garbageBlocksTouchedByClear,
  placeNextGarbageBlock,
} from './garbage'
import { applyGravity, isBoardStable } from './gravity'
import { findMatches } from './matches'
import { randomInteger, seedToRandomState } from './random'
import type {
  Board,
  Coordinate,
  GameConfig,
  OutgoingAttack,
  Panel,
  SimulationState,
  SwapAction,
  SwapResult,
} from './types'
import { NORMAL_PANEL_TYPES } from './types'

/**
 * How long the clearing phase runs for a match of `panelCount` panels: every
 * panel waits its turn to pop, and the last one still gets a full fade.
 */
export function clearPhaseDurationMs(
  panelCount: number,
  config: GameConfig = defaultGameConfig,
): number {
  return (
    config.timing.clearDurationMs +
    Math.max(0, panelCount - 1) * config.timing.panelPopIntervalMs
  )
}

function cloneCells(board: Board): Board['cells'] {
  return board.cells.map((row) =>
    row.map((panel) => (panel === null ? null : { ...panel })),
  )
}

function coordinateIsInsideBoard(
  state: SimulationState,
  coordinate: Coordinate,
): boolean {
  return (
    coordinate.column >= 0 &&
    coordinate.column < state.board.columns &&
    coordinate.row >= 0 &&
    coordinate.row < state.board.visibleRows
  )
}

function panelCanSwap(panel: Panel | null): boolean {
  return panel === null || panel.state === 'idle'
}

function withPanelsById(
  board: Board,
  panelIds: ReadonlySet<number>,
  update: (panel: Panel) => Panel,
): Board {
  return {
    ...board,
    cells: board.cells.map((row) =>
      row.map((panel) =>
        panel !== null && panelIds.has(panel.id) ? update(panel) : panel,
      ),
    ),
  }
}

function clearChainMetadata(board: Board): Board {
  return {
    ...board,
    cells: board.cells.map((row) =>
      row.map((panel) =>
        panel === null ||
        (!panel.chainEligible && panel.chainId === null)
          ? panel
          : {
              ...panel,
              chainEligible: false,
              chainId: null,
            },
      ),
    ),
  }
}

function appendAttack(
  attacks: OutgoingAttack[],
  sequence: number,
  kind: OutgoingAttack['kind'],
  state: SimulationState,
  clearSize: number,
  chainLevel: number,
  blocks: OutgoingAttack['blocks'],
): number {
  if (blocks.length === 0) {
    return sequence
  }

  attacks.push({
    sequence,
    kind,
    createdAt: state.elapsedMs,
    clearSize,
    chainLevel,
    blocks,
  })
  return sequence + 1
}

function beginGarbageConversion(
  state: SimulationState,
  blockIds: number[],
): Pick<SimulationState, 'garbage' | 'garbageConversion'> {
  const activeBlockId = blockIds[0]
  if (activeBlockId === undefined) {
    return {
      garbage: state.garbage,
      garbageConversion: null,
    }
  }

  return {
    garbage: state.garbage.map((block) =>
      blockIds.includes(block.id)
        ? {
            ...block,
            state: 'converting',
            conversionRow: block.row,
            fallProgress: 0,
          }
        : block,
    ),
    garbageConversion: {
      blockIds,
      activeBlockId,
      nextColumn: 0,
      convertedPanelIds: [],
      nextCellAt: 0,
      releaseAt: null,
    },
  }
}

function beginMatchResolution(
  state: SimulationState,
  matches: Coordinate[],
  config: GameConfig,
): SimulationState {
  const matchedPanels = matches
    .map(({ row, column }) => state.board.cells[row]?.[column] ?? null)
    .filter((panel): panel is Panel => panel !== null)
  const matchedPanelIds = matchedPanels.map(({ id }) => id)
  const shockSize = matchedPanels.filter(
    ({ type }) => type === 'shock',
  ).length
  const normalSize = matchedPanelIds.length - shockSize
  const idSet = new Set(matchedPanelIds)
  const previousChain = state.chain
  const qualifiedForChain =
    previousChain !== null &&
    matchedPanels.some(
      (panel) =>
        panel.chainEligible && panel.chainId === previousChain.id,
    )
  const chain =
    previousChain !== null && qualifiedForChain
      ? {
          ...previousChain,
          level: previousChain.level + 1,
          lastQualifyingEventAt: state.elapsedMs,
          closingStartedAt: null,
          status: 'active' as const,
        }
      : {
          id: state.nextChainId,
          level: 1,
          startedAt: state.elapsedMs,
          lastQualifyingEventAt: state.elapsedMs,
          closingStartedAt: null,
          status: 'active' as const,
        }
  const baseBoard =
    previousChain !== null && !qualifiedForChain
      ? clearChainMetadata(state.board)
      : state.board
  const outgoingAttacks = [...state.outgoingAttacks]
  let nextAttackSequence = state.nextAttackSequence
  const firstNewAttackSequence = nextAttackSequence
  nextAttackSequence = appendAttack(
    outgoingAttacks,
    nextAttackSequence,
    'combo',
    state,
    normalSize,
    chain.level,
    comboAttackBlocks(normalSize, config),
  )
  nextAttackSequence = appendAttack(
    outgoingAttacks,
    nextAttackSequence,
    'shock',
    state,
    shockSize,
    chain.level,
    shockAttackBlocks(shockSize, config),
  )
  if (qualifiedForChain) {
    nextAttackSequence = appendAttack(
      outgoingAttacks,
      nextAttackSequence,
      'chain',
      state,
      matchedPanelIds.length,
      chain.level,
      chainAttackBlocks(chain.level, state.board.columns),
    )
  }
  const attackSequences = Array.from(
    { length: nextAttackSequence - firstNewAttackSequence },
    (_, index) => firstNewAttackSequence + index,
  )
  const touchedGarbageIds = garbageBlocksTouchedByClear(
    state.garbage,
    matches,
  )
  const conversion = beginGarbageConversion(state, touchedGarbageIds)
  const comboStopMs =
    normalSize < 4
      ? 0
      : config.timing.comboStopBaseMs +
        (normalSize - 4) * config.timing.comboStopPerPanelMs
  const chainStopMs =
    !qualifiedForChain || chain.level < 2
      ? 0
      : config.timing.chainStopBaseMs +
        (chain.level - 2) * config.timing.chainStopPerLevelMs
  const stopTimeRemainingMs = Math.min(
    config.timing.maximumStopTimeMs,
    state.stopTimeRemainingMs + comboStopMs + chainStopMs,
  )

  return {
    ...state,
    board: withPanelsById(baseBoard, idSet, (panel) => ({
      ...panel,
      state: 'flashing',
      chainId: chain.id,
      animationStartedAt: state.elapsedMs,
    })),
    phase: 'flashing',
    phaseStartedAt: state.elapsedMs,
    matchedPanelIds,
    chain,
    nextChainId:
      qualifiedForChain && previousChain !== null
        ? state.nextChainId
        : state.nextChainId + 1,
    outgoingAttacks,
    nextAttackSequence,
    garbage: conversion.garbage,
    garbageConversion: conversion.garbageConversion,
    stopTimeRemainingMs,
    lastClearEvent: {
      size: matchedPanelIds.length,
      normalSize,
      shockSize,
      chainLevel: chain.level,
      qualifiedForChain,
      touchedTop: matchedPanels.some(
        (panel) => panel.row === state.board.visibleRows - 1,
      ),
      occurredAt: state.elapsedMs,
      attackSequences,
    },
    lastClearSize: matchedPanelIds.length,
  }
}

function advanceGarbageConversion(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  const conversion = state.garbageConversion
  if (state.phase !== 'garbage-converting' || conversion === null) {
    return state
  }

  const block = state.garbage.find(
    ({ id }) => id === conversion.activeBlockId,
  )
  if (block === undefined) {
    return {
      ...state,
      phase: 'fall-delay',
      phaseStartedAt: state.elapsedMs,
      garbageConversion: null,
    }
  }

  if (
    conversion.releaseAt !== null &&
    state.elapsedMs >= conversion.releaseAt
  ) {
    const convertedIds = new Set(conversion.convertedPanelIds)
    const board = withPanelsById(
      state.board,
      convertedIds,
      (panel) => ({
        ...panel,
        state: 'idle',
        chainEligible: state.chain !== null,
        chainId: state.chain?.id ?? null,
        animationStartedAt: null,
      }),
    )
    const garbage =
      block.height === 1
        ? state.garbage.filter(({ id }) => id !== block.id)
        : state.garbage.map((candidate) =>
            candidate.id === block.id
              ? {
                  ...candidate,
                  row: candidate.row + 1,
                  height: candidate.height - 1,
                  conversionRow: null,
                  state: 'idle' as const,
                }
              : candidate,
          )
    const remainingBlockIds = conversion.blockIds.filter(
      (id) => id !== block.id,
    )
    const nextBlockId = remainingBlockIds[0]

    if (nextBlockId === undefined) {
      return {
        ...state,
        board,
        garbage,
        garbageConversion: null,
        phase: 'fall-delay',
        phaseStartedAt: state.elapsedMs,
      }
    }

    return {
      ...state,
      board,
      garbage,
      garbageConversion: {
        blockIds: remainingBlockIds,
        activeBlockId: nextBlockId,
        nextColumn: 0,
        convertedPanelIds: [],
        nextCellAt:
          state.elapsedMs + config.timing.garbageCellConvertMs,
        releaseAt: null,
      },
    }
  }

  if (
    conversion.releaseAt !== null ||
    state.elapsedMs < conversion.nextCellAt
  ) {
    return state
  }

  const conversionRow = block.conversionRow ?? block.row
  const column = block.column + conversion.nextColumn
  const cells = cloneCells(state.board)
  // Spawn a colour that does not itself complete a three-in-a-row, the same
  // rule the starting board and incoming rows already follow. Chains the
  // player set up still continue: those come from panels falling into place
  // once the block is gone, not from spawned colours lining up by chance.
  const palette = NORMAL_PANEL_TYPES.slice(
    0,
    config.board.normalPanelTypes,
  )
  const candidates = availableTypes(cells, conversionRow, column, palette)
  // Only two colours can ever be excluded, so this cannot empty; fall back to
  // the full palette rather than risk an out-of-range pick.
  const safeTypes = candidates.length > 0 ? candidates : palette
  const randomPanel = randomInteger(
    state.conversionRandomState,
    safeTypes.length,
  )
  const type = safeTypes[randomPanel.value]!
  const convertedPanelIds = [...conversion.convertedPanelIds]
  let nextPanelId = state.board.nextPanelId

  if (
    conversionRow >= 0 &&
    conversionRow < state.board.visibleRows &&
    cells[conversionRow]?.[column] === null
  ) {
    cells[conversionRow]![column] = {
      id: nextPanelId,
      type,
      state: 'garbage-locked',
      row: conversionRow,
      column,
      offsetX: 0,
      offsetY: 0,
      chainEligible: state.chain !== null,
      chainId: state.chain?.id ?? null,
      animationStartedAt: state.elapsedMs,
    }
    convertedPanelIds.push(nextPanelId)
    nextPanelId += 1
  }

  const nextColumn = conversion.nextColumn + 1
  const rowComplete = nextColumn >= block.width

  return {
    ...state,
    conversionRandomState: randomPanel.randomState,
    board: {
      ...state.board,
      cells,
      nextPanelId,
    },
    garbageConversion: {
      ...conversion,
      nextColumn,
      convertedPanelIds,
      nextCellAt:
        conversion.nextCellAt + config.timing.garbageCellConvertMs,
      releaseAt: rowComplete
        ? state.elapsedMs + config.timing.garbageReleaseDelayMs
        : null,
    },
  }
}

function completePendingSwap(state: SimulationState): SimulationState {
  const pending = state.pendingSwap
  if (pending === null) {
    return state
  }

  const cells = cloneCells(state.board)
  const fromPanel = cells[pending.from.row]?.[pending.from.column] ?? null
  const toPanel = cells[pending.to.row]?.[pending.to.column] ?? null

  cells[pending.from.row]![pending.from.column] =
    toPanel === null
      ? null
      : {
          ...toPanel,
          row: pending.from.row,
          column: pending.from.column,
          state: 'idle',
          offsetX: 0,
          animationStartedAt: null,
        }
  cells[pending.to.row]![pending.to.column] =
    fromPanel === null
      ? null
      : {
          ...fromPanel,
          row: pending.to.row,
          column: pending.to.column,
          state: 'idle',
          offsetX: 0,
          animationStartedAt: null,
        }

  return {
    ...state,
    board: { ...state.board, cells },
    pendingSwap: null,
  }
}

function advanceResolution(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  const phaseElapsed = state.elapsedMs - state.phaseStartedAt

  if (state.phase === 'idle') {
    if (state.pendingSwap !== null) {
      return state
    }
    const matches = findMatches(state.board)
    if (matches.length > 0) {
      return beginMatchResolution(state, matches, config)
    }
    if (!isBoardStable(state.board, state.garbage)) {
      return {
        ...state,
        phase: 'fall-delay',
        phaseStartedAt: state.elapsedMs,
      }
    }
    return state
  }

  if (state.phase === 'garbage-converting') {
    return advanceGarbageConversion(state, config)
  }

  if (state.phase === 'garbage-falling') {
    return state
  }

  const idSet = new Set(state.matchedPanelIds)

  if (
    state.phase === 'flashing' &&
    phaseElapsed >= config.timing.matchFlashDurationMs
  ) {
    return {
      ...state,
      board: withPanelsById(state.board, idSet, (panel) => ({
        ...panel,
        state: 'clearing',
        animationStartedAt: state.elapsedMs,
      })),
      phase: 'clearing',
      phaseStartedAt: state.elapsedMs,
    }
  }

  // Panels pop one at a time rather than all at once, so the clear lasts until
  // the last one has had its own fade. Keeping this in the simulation (instead
  // of faking the stagger in the renderer) means both clients agree on when the
  // board comes back to life, and a bigger match genuinely takes longer to
  // resolve — as it does on the SNES.
  if (
    state.phase === 'clearing' &&
    phaseElapsed >= clearPhaseDurationMs(state.matchedPanelIds.length, config)
  ) {
    const cells = state.board.cells.map((row) =>
      row.map((panel) =>
        panel !== null && idSet.has(panel.id) ? null : panel,
      ),
    )

    const garbageConversion =
      state.garbageConversion === null
        ? null
        : {
            ...state.garbageConversion,
            nextCellAt:
              state.elapsedMs + config.timing.garbageCellConvertMs,
          }

    return {
      ...state,
      board: { ...state.board, cells },
      phase:
        garbageConversion === null
          ? 'fall-delay'
          : 'garbage-converting',
      phaseStartedAt: state.elapsedMs,
      garbageConversion,
      totalCleared: state.totalCleared + state.matchedPanelIds.length,
    }
  }

  if (
    state.phase === 'fall-delay' &&
    phaseElapsed >= config.timing.fallDelayMs
  ) {
    const gravity = applyGravity(state.board, state.garbage)
    const movedPanelIds = new Set(gravity.movedPanelIds)
    const activeChainId = state.chain?.id ?? null
    const stableState: SimulationState = {
      ...state,
      board: {
        ...gravity.board,
        cells: gravity.board.cells.map((row) =>
          row.map((panel) =>
            panel === null
              ? null
              : {
                  ...panel,
                  offsetY: 0,
                  state: 'idle',
                  chainEligible: movedPanelIds.has(panel.id)
                    ? activeChainId !== null
                    : panel.chainEligible,
                  chainId: movedPanelIds.has(panel.id)
                    ? activeChainId
                    : panel.chainId,
                  animationStartedAt: null,
                },
          ),
        ),
      },
      phase: 'idle',
      phaseStartedAt: state.elapsedMs,
      matchedPanelIds: [],
    }
    const matches = findMatches(stableState.board)
    if (matches.length > 0) {
      return beginMatchResolution(stableState, matches, config)
    }

    return {
      ...stableState,
      chain:
        stableState.chain === null
          ? null
          : {
              ...stableState.chain,
              status: 'closing',
              closingStartedAt: stableState.elapsedMs,
            },
    }
  }

  return state
}

function advanceChainClosure(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (
    state.chain === null ||
    state.chain.status !== 'closing' ||
    state.chain.closingStartedAt === null ||
    state.phase !== 'idle' ||
    state.pendingSwap !== null ||
    state.garbage.some(
      ({ state: blockState }) => blockState === 'falling',
    ) ||
    state.elapsedMs - state.chain.closingStartedAt <
      config.timing.chainWindowMs
  ) {
    return state
  }

  return {
    ...state,
    board: clearChainMetadata(state.board),
    chain: null,
  }
}

function advanceGarbageLifecycle(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  const advanced = advanceFallingGarbage(state, config)

  if (state.phase === 'garbage-falling') {
    return advanced.garbage.some(
      ({ state: blockState }) => blockState === 'falling',
    )
      ? advanced
      : {
          ...advanced,
          phase: 'fall-delay',
          phaseStartedAt: advanced.elapsedMs,
        }
  }

  if (
    advanced.phase === 'idle' &&
    advanced.pendingSwap === null &&
    advanced.garbageConversion === null
  ) {
    const unsupportedIds = new Set(
      advanced.garbage
        .filter(
          (block) =>
            block.state === 'idle' &&
            garbageBlockCanFall(
              block,
              advanced.board,
              advanced.garbage,
            ),
        )
        .map(({ id }) => id),
    )

    if (unsupportedIds.size > 0) {
      return {
        ...advanced,
        garbage: advanced.garbage.map((block) =>
          unsupportedIds.has(block.id)
            ? { ...block, state: 'falling', fallProgress: 0 }
            : block,
        ),
        phase: 'garbage-falling',
        phaseStartedAt: advanced.elapsedMs,
      }
    }
  }

  const safeToInsert =
    advanced.status === 'playing' &&
    advanced.dangerRemainingMs === null &&
    advanced.phase === 'idle' &&
    advanced.pendingSwap === null &&
    advanced.chain === null &&
    advanced.garbageConversion === null &&
    !advanced.garbage.some(
      ({ state: blockState }) => blockState === 'falling',
    )

  const nextAttack = advanced.incomingGarbage[0]
  if (
    !safeToInsert ||
    nextAttack === undefined ||
    // Held in the telegraph queue until its warning has run.
    advanced.elapsedMs < nextAttack.readyAt
  ) {
    return advanced
  }

  const placed = placeNextGarbageBlock(advanced)
  return {
    ...placed,
    phase: 'garbage-falling',
    phaseStartedAt: placed.elapsedMs,
  }
}

function advanceRise(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (
    state.status !== 'playing' ||
    state.dangerRemainingMs !== null ||
    state.garbageConversion !== null ||
    state.garbage.some(
      ({ state: blockState }) => blockState === 'falling',
    )
  ) {
    return state.riseSpeed === 0 ? state : { ...state, riseSpeed: 0 }
  }

  const automaticRiseAllowed =
    state.phase === 'idle' &&
    state.pendingSwap === null &&
    state.chain === null
  if (!state.manualRaise && !automaticRiseAllowed) {
    return state
  }
  if (!state.manualRaise && state.stopTimeRemainingMs > 0) {
    return {
      ...state,
      riseSpeed: 0,
      stopTimeRemainingMs: Math.max(
        0,
        state.stopTimeRemainingMs - config.timing.fixedStepMs,
      ),
    }
  }

  const elapsedSeconds = state.elapsedMs / 1000
  const speedIncreases = Math.floor(
    elapsedSeconds / config.rise.speedIncreaseIntervalSeconds,
  )
  const automaticSpeed = Math.min(
    config.rise.startingRowsPerSecond *
      config.rise.speedMultiplierPerIncrease ** speedIncreases,
    config.rise.maximumRowsPerSecond,
  )
  const riseSpeed = state.manualRaise
    ? config.rise.manualRowsPerSecond
    : automaticSpeed
  // Raising through earned stop time spends it faster rather than throwing it
  // away: pushing the stack up is the aggressive play, so it should cost tempo,
  // not erase the whole buffer the way it used to.
  const stopTimeRemainingMs =
    state.manualRaise && state.stopTimeRemainingMs > 0
      ? Math.max(
          0,
          state.stopTimeRemainingMs -
            config.timing.fixedStepMs * config.rise.manualStopDrainMultiplier,
        )
      : state.stopTimeRemainingMs
  let riseOffset =
    state.riseOffset + riseSpeed * (config.timing.fixedStepMs / 1000)
  let board = state.board
  let randomState = state.randomState
  let garbage = state.garbage
  let status = state.status
  let dangerRemainingMs: number | null = state.dangerRemainingMs

  while (riseOffset >= 1 && status === 'playing') {
    const inserted = insertIncomingRow(board, randomState, config)
    if (inserted.toppedOut) {
      dangerRemainingMs = config.timing.dangerGraceMs
      riseOffset = 0
      break
    }

    board = inserted.board
    garbage = garbage.map((block) => ({
      ...block,
      row: block.row + 1,
      conversionRow:
        block.conversionRow === null ? null : block.conversionRow + 1,
    }))
    randomState = inserted.randomState
    riseOffset -= 1
  }

  return {
    ...state,
    board,
    garbage,
    randomState,
    riseOffset,
    riseSpeed,
    status,
    dangerRemainingMs,
    stopTimeRemainingMs,
  }
}

function fixedStep(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (state.status !== 'playing') {
    return state
  }

  let nextState: SimulationState = {
    ...state,
    elapsedMs: state.elapsedMs + config.timing.fixedStepMs,
  }

  if (
    nextState.pendingSwap !== null &&
    nextState.elapsedMs - nextState.pendingSwap.startedAt >=
      config.timing.swapDurationMs
  ) {
    nextState = completePendingSwap(nextState)
  }

  nextState = advanceResolution(nextState, config)
  nextState = advanceChainClosure(nextState, config)
  nextState = advanceGarbageLifecycle(nextState, config)
  nextState = advanceDangerState(nextState, config)
  nextState = advanceRise(nextState, config)
  return nextState
}

export function createSimulation(
  seed: string,
  config: GameConfig = defaultGameConfig,
): SimulationState {
  const initialRandomState = seedToRandomState(seed)
  const initial = createInitialBoard(initialRandomState, config)

  return {
    seed,
    randomState: initial.randomState,
    garbageRandomState: seedToRandomState(`${seed}:garbage`),
    conversionRandomState: seedToRandomState(`${seed}:conversion`),
    elapsedMs: 0,
    board: initial.board,
    riseOffset: 0,
    riseSpeed: config.rise.startingRowsPerSecond,
    stopTimeRemainingMs: 0,
    dangerRemainingMs: null,
    manualRaise: false,
    status: 'playing',
    phase: 'idle',
    phaseStartedAt: 0,
    matchedPanelIds: [],
    pendingSwap: null,
    chain: null,
    nextChainId: 1,
    outgoingAttacks: [],
    nextAttackSequence: 1,
    lastClearEvent: null,
    garbage: [],
    incomingGarbage: [],
    receivedAttackIds: [],
    receivedAttackSequences: [],
    nextGarbageId: 1,
    garbageConversion: null,
    totalCleared: 0,
    lastClearSize: 0,
  }
}

export function requestSwap(
  state: SimulationState,
  action: SwapAction,
  config: GameConfig = defaultGameConfig,
): SwapResult {
  if (state.status !== 'playing') {
    return { ok: false, reason: 'simulation-not-playing', state }
  }
  if (state.pendingSwap !== null) {
    return { ok: false, reason: 'board-busy', state }
  }

  const from = { row: action.row, column: action.column }
  const to = {
    row: action.row,
    column: action.column + action.direction,
  }

  if (!coordinateIsInsideBoard(state, from) || !coordinateIsInsideBoard(state, to)) {
    return { ok: false, reason: 'outside-board', state }
  }
  if (Math.abs(from.column - to.column) !== 1 || from.row !== to.row) {
    return { ok: false, reason: 'not-adjacent', state }
  }

  const fromPanel = state.board.cells[from.row]?.[from.column] ?? null
  const toPanel = state.board.cells[to.row]?.[to.column] ?? null

  if (
    garbageAt(state.garbage, from.row, from.column) !== null ||
    garbageAt(state.garbage, to.row, to.column) !== null
  ) {
    return { ok: false, reason: 'cell-locked', state }
  }

  if (fromPanel === null && toPanel === null) {
    return { ok: false, reason: 'both-empty', state }
  }
  if (!panelCanSwap(fromPanel) || !panelCanSwap(toPanel)) {
    return { ok: false, reason: 'cell-locked', state }
  }

  const swappedIds = new Set(
    [fromPanel?.id, toPanel?.id].filter((id): id is number => id !== undefined),
  )
  const direction = to.column - from.column
  const chainIsOpen =
    state.chain !== null &&
    (state.chain.status === 'active' ||
      (state.chain.closingStartedAt !== null &&
        state.elapsedMs - state.chain.closingStartedAt <=
          config.timing.chainWindowMs))
  const board = withPanelsById(state.board, swappedIds, (panel) => ({
    ...panel,
    state: 'swapping',
    offsetX: panel.id === fromPanel?.id ? direction : -direction,
    chainEligible: chainIsOpen ? true : panel.chainEligible,
    chainId: chainIsOpen ? state.chain!.id : panel.chainId,
    animationStartedAt: state.elapsedMs,
  }))

  return {
    ok: true,
    state: {
      ...state,
      board,
      pendingSwap: {
        from,
        to,
        startedAt: state.elapsedMs,
      },
    },
  }
}

export function drainOutgoingAttacks(state: SimulationState): {
  state: SimulationState
  attacks: OutgoingAttack[]
} {
  return {
    state:
      state.outgoingAttacks.length === 0
        ? state
        : { ...state, outgoingAttacks: [] },
    attacks: state.outgoingAttacks.map((attack) => ({
      ...attack,
      blocks: attack.blocks.map((block) => ({ ...block })),
    })),
  }
}

export function setManualRaise(
  state: SimulationState,
  active: boolean,
): SimulationState {
  if (!active) {
    return state.manualRaise ? { ...state, manualRaise: false } : state
  }

  // Earned stop time survives the raise; holding it just burns through the
  // buffer more quickly (see advanceRise).
  return state.status === 'playing' && state.dangerRemainingMs === null
    ? { ...state, manualRaise: true }
    : state
}

export function setPaused(
  state: SimulationState,
  paused: boolean,
): SimulationState {
  if (state.status === 'lost') {
    return state
  }

  return {
    ...state,
    status: paused ? 'paused' : 'playing',
    manualRaise: paused ? false : state.manualRaise,
  }
}

export function advanceSimulation(
  state: SimulationState,
  deltaMs: number,
  config: GameConfig = defaultGameConfig,
): SimulationState {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new RangeError('deltaMs must be a finite non-negative number')
  }

  const stepCount = Math.floor(
    (deltaMs + Number.EPSILON) / config.timing.fixedStepMs,
  )
  let nextState = state

  for (let step = 0; step < stepCount; step += 1) {
    nextState = fixedStep(nextState, config)
  }

  return nextState
}

export function stepSimulation(
  state: SimulationState,
  config: GameConfig = defaultGameConfig,
): SimulationState {
  return fixedStep(state, config)
}

export function simulationChecksum(state: SimulationState): string {
  const panels = state.board.cells
    .flatMap((row) => row)
    .filter((panel): panel is Panel => panel !== null)
    .sort((left, right) => left.id - right.id)
    .map(
      (panel) =>
        [
          panel.id,
          panel.type,
          panel.state,
          panel.row,
          panel.column,
          panel.offsetX,
          panel.offsetY,
          panel.chainEligible ? 1 : 0,
          panel.chainId ?? '-',
          panel.animationStartedAt ?? '-',
        ].join(','),
    )
    .join('|')
  const source = [
    state.randomState,
    state.garbageRandomState,
    state.conversionRandomState,
    state.elapsedMs.toFixed(4),
    state.riseOffset.toFixed(8),
    state.riseSpeed.toFixed(8),
    state.stopTimeRemainingMs.toFixed(4),
    state.dangerRemainingMs?.toFixed(4) ?? 'safe',
    state.status,
    state.phase,
    state.phaseStartedAt.toFixed(4),
    state.pendingSwap === null
      ? 'no-swap'
      : `${state.pendingSwap.from.row},${state.pendingSwap.from.column}>${state.pendingSwap.to.row},${state.pendingSwap.to.column}@${state.pendingSwap.startedAt}`,
    state.chain === null
      ? 'no-chain'
      : [
          state.chain.id,
          state.chain.level,
          state.chain.status,
          state.chain.startedAt,
          state.chain.lastQualifyingEventAt,
          state.chain.closingStartedAt ?? '-',
        ].join(','),
    state.nextAttackSequence,
    state.outgoingAttacks
      .map(
        (attack) =>
          `${attack.sequence},${attack.kind},${attack.blocks
            .map((block) => `${block.width}x${block.height}:${block.type}`)
            .join('+')}`,
      )
      .join('|'),
    state.garbage
      .map(
        (block) =>
          [
            block.id,
            block.type,
            block.state,
            block.row,
            block.column,
            block.width,
            block.height,
            block.conversionRow ?? '-',
            block.fallProgress.toFixed(8),
          ].join(','),
      )
      .join('|'),
    state.incomingGarbage
      .map(
        (attack) =>
          `${attack.attackId}@${attack.serverSequence}!${attack.readyAt.toFixed(
            4,
          )}:${attack.blocks
            .map((block) => `${block.width}x${block.height}:${block.type}`)
            .join('+')}`,
      )
      .join('|'),
    state.receivedAttackSequences.join(','),
    state.garbageConversion === null
      ? 'no-conversion'
      : [
          state.garbageConversion.activeBlockId,
          state.garbageConversion.nextColumn,
          state.garbageConversion.blockIds.join(','),
          state.garbageConversion.convertedPanelIds.join(','),
          state.garbageConversion.nextCellAt,
          state.garbageConversion.releaseAt ?? '-',
        ].join(':'),
    panels,
    state.board.incomingRow.join(','),
  ].join(';')
  let hash = 2166136261

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}
