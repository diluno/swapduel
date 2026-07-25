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
  garbageOccupiesCell,
  placeNextGarbageBlock,
} from './garbage'
import { applyGravity, isBoardStable } from './gravity'
import { findMatches } from './matches'
import { randomInteger, seedToRandomState } from './random'
import { clearScore } from './scoring'
import type {
  Board,
  Coordinate,
  ResolutionPhase,
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
  config: GameConfig,
): Pick<SimulationState, 'garbage' | 'garbageConversion'> {
  const ids = blockIds.filter((id) =>
    state.garbage.some((block) => block.id === id),
  )
  const activeBlockId = ids[0]
  if (activeBlockId === undefined) {
    return {
      garbage: state.garbage,
      garbageConversion: state.garbageConversion,
    }
  }

  const garbage = state.garbage.map((block) =>
    ids.includes(block.id)
      ? {
          ...block,
          state: 'converting' as const,
          conversionRow: block.row,
          fallProgress: 0,
        }
      : block,
  )

  // Only one block converts at a time. A second clear cracking more garbage
  // while the first is still turning into panels queues up behind it instead
  // of restarting the whole conversion.
  const running = state.garbageConversion
  if (running !== null) {
    return {
      garbage,
      garbageConversion: {
        ...running,
        blockIds: [
          ...running.blockIds,
          ...ids.filter((id) => !running.blockIds.includes(id)),
        ],
      },
    }
  }

  return {
    garbage,
    garbageConversion: {
      blockIds: ids,
      activeBlockId,
      nextColumn: 0,
      convertedPanelIds: [],
      nextCellAt: state.elapsedMs + config.timing.garbageCellConvertMs,
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
  // Now that clears overlap, a plain match can land while a chain is still in
  // flight. The chain counter belongs to the board, not to one clear, so an
  // unrelated match neither extends it nor tears it down — it just scores as a
  // fresh level-1 clear and leaves the chain to expire on its own clock.
  // 'active' means the board has not settled since the chain's last link, so
  // the chain is genuinely still running. A chain that is merely *closing* has
  // already had its board settle, and an unrelated clear there still starts a
  // fresh origin the way it always did.
  const chainIsLive =
    previousChain !== null && previousChain.status === 'active'
  const chain =
    previousChain !== null && qualifiedForChain
      ? {
          ...previousChain,
          level: previousChain.level + 1,
          lastQualifyingEventAt: state.elapsedMs,
          closingStartedAt: null,
          status: 'active' as const,
        }
      : previousChain !== null && chainIsLive
        ? previousChain
        : {
            id: state.nextChainId,
            level: 1,
            startedAt: state.elapsedMs,
            lastQualifyingEventAt: state.elapsedMs,
            closingStartedAt: null,
            status: 'active' as const,
          }
  const clearChainLevel = qualifiedForChain ? chain.level : 1
  const baseBoard =
    previousChain !== null && !qualifiedForChain && !chainIsLive
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
    clearChainLevel,
    comboAttackBlocks(normalSize, config),
  )
  nextAttackSequence = appendAttack(
    outgoingAttacks,
    nextAttackSequence,
    'shock',
    state,
    shockSize,
    clearChainLevel,
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
  const score =
    state.score +
    clearScore(
      {
        size: matchedPanelIds.length,
        normalSize,
        chainLevel: clearChainLevel,
        qualifiedForChain,
      },
      config,
    )

  return {
    ...state,
    board: withPanelsById(baseBoard, idSet, (panel) => ({
      ...panel,
      state: 'flashing',
      chainId: chain.id,
      animationStartedAt: state.elapsedMs,
    })),
    clears: [
      ...state.clears,
      {
        id: state.nextClearId,
        panelIds: matchedPanelIds,
        chainId: chain.id,
        garbageBlockIds: garbageBlocksTouchedByClear(
          state.garbage,
          matches,
        ),
        phase: 'flashing',
        phaseStartedAt: state.elapsedMs,
      },
    ],
    nextClearId: state.nextClearId + 1,
    chain,
    nextChainId:
      chain.id === state.nextChainId
        ? state.nextChainId + 1
        : state.nextChainId,
    outgoingAttacks,
    nextAttackSequence,
    stopTimeRemainingMs,
    score,
    lastClearEvent: {
      size: matchedPanelIds.length,
      normalSize,
      shockSize,
      chainLevel: clearChainLevel,
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

/**
 * Runs every clear group on its own clock. Groups do not wait for each other,
 * so a match made while an older one is still popping resolves alongside it.
 */
function advanceClearGroups(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (state.clears.length === 0) {
    return state
  }

  let board = state.board
  let garbage = state.garbage
  let garbageConversion = state.garbageConversion
  let totalCleared = state.totalCleared
  const clears: SimulationState['clears'] = []
  let changed = false

  for (const group of state.clears) {
    const elapsed = state.elapsedMs - group.phaseStartedAt

    if (group.phase === 'flashing') {
      if (elapsed < config.timing.matchFlashDurationMs) {
        clears.push(group)
        continue
      }

      board = withPanelsById(board, new Set(group.panelIds), (panel) => ({
        ...panel,
        state: 'clearing',
        animationStartedAt: state.elapsedMs,
      }))
      clears.push({
        ...group,
        phase: 'clearing',
        phaseStartedAt: state.elapsedMs,
      })
      changed = true
      continue
    }

    if (
      elapsed < clearPhaseDurationMs(group.panelIds.length, config)
    ) {
      clears.push(group)
      continue
    }

    const idSet = new Set(group.panelIds)
    board = {
      ...board,
      cells: board.cells.map((row) =>
        row.map((panel) =>
          panel !== null && idSet.has(panel.id) ? null : panel,
        ),
      ),
    }
    totalCleared += group.panelIds.length

    if (group.garbageBlockIds.length > 0) {
      const conversion = beginGarbageConversion(
        { ...state, garbage, garbageConversion },
        group.garbageBlockIds,
        config,
      )
      garbage = conversion.garbage
      garbageConversion = conversion.garbageConversion
    }
    changed = true
  }

  if (!changed) {
    return state
  }

  return {
    ...state,
    board,
    garbage,
    garbageConversion,
    clears,
    totalCleared,
  }
}

function advanceGarbageConversion(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  const conversion = state.garbageConversion
  if (conversion === null) {
    return state
  }

  const block = state.garbage.find(
    ({ id }) => id === conversion.activeBlockId,
  )
  if (block === undefined) {
    return { ...state, garbageConversion: null }
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

/** Panels that gravity is allowed to pick up. Everything else holds its cell. */
function panelIsMovable(panel: Panel): boolean {
  return panel.state === 'idle' || panel.state === 'hovering'
}

/**
 * Per-panel gravity. Each unsupported panel starts its own hover timer and
 * drops when that timer runs out, so one column falling never stops the player
 * working in another — and panels held up by a clear elsewhere wait for it
 * without freezing the board.
 */
function advancePanelGravity(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  const cells = cloneCells(state.board)
  const rowCount = state.board.visibleRows
  const activeChainId = state.chain?.id ?? null
  let changed = false

  for (let column = 0; column < state.board.columns; column += 1) {
    // The lowest row this column can still drop a panel into.
    let landing = 0

    for (let row = 0; row < rowCount; row += 1) {
      if (
        state.garbage.some((block) =>
          garbageOccupiesCell(block, row, column),
        )
      ) {
        landing = row + 1
        continue
      }

      const panel = cells[row]?.[column] ?? null
      if (panel === null) {
        continue
      }

      if (!panelIsMovable(panel)) {
        landing = row + 1
        continue
      }

      if (row === landing) {
        if (panel.state === 'hovering') {
          // The gap underneath closed while it hung there.
          cells[row]![column] = {
            ...panel,
            state: 'idle',
            animationStartedAt: null,
          }
          changed = true
        }
        landing = row + 1
        continue
      }

      if (panel.state === 'idle') {
        cells[row]![column] = {
          ...panel,
          state: 'hovering',
          animationStartedAt: state.elapsedMs,
        }
        changed = true
        landing = row + 1
        continue
      }

      const hoveringSince = panel.animationStartedAt ?? state.elapsedMs
      if (state.elapsedMs - hoveringSince < config.timing.fallDelayMs) {
        landing = row + 1
        continue
      }

      cells[landing]![column] = {
        ...panel,
        row: landing,
        state: 'idle',
        offsetY: 0,
        animationStartedAt: null,
        chainEligible: activeChainId !== null,
        chainId: activeChainId,
      }
      cells[row]![column] = null
      changed = true
      landing += 1
    }
  }

  if (!changed) {
    return state
  }

  return { ...state, board: { ...state.board, cells } }
}

function advanceResolution(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  let next = advanceClearGroups(state, config)
  next = advanceGarbageConversion(next, config)
  next = advancePanelGravity(next, config)

  // Only settled panels can match (see findMatches), so this picks up exactly
  // the matches that have just come to rest — including ones the player made
  // while another clear was still resolving.
  const matches = findMatches(next.board, next.garbage)
  return matches.length > 0
    ? beginMatchResolution(next, matches, config)
    : next
}

/**
 * Collapses everything happening on the board into the single `phase` label
 * the renderer, danger clock and rise gate read. It is a report, not a
 * controller: no resolution logic branches on it.
 */
function summarizePhase(state: SimulationState): ResolutionPhase {
  if (state.garbageConversion !== null) return 'garbage-converting'
  if (state.garbage.some(({ state: block }) => block === 'falling')) {
    return 'garbage-falling'
  }
  if (state.clears.some(({ phase }) => phase === 'clearing')) {
    return 'clearing'
  }
  if (state.clears.length > 0) return 'flashing'
  if (!isBoardStable(state.board, state.garbage)) return 'fall-delay'
  return 'idle'
}

function syncPhaseSummary(state: SimulationState): SimulationState {
  const phase = summarizePhase(state)
  const matchedPanelIds = state.clears.flatMap(({ panelIds }) => panelIds)

  if (
    phase === state.phase &&
    matchedPanelIds.length === state.matchedPanelIds.length &&
    matchedPanelIds.every((id, index) => state.matchedPanelIds[index] === id)
  ) {
    return state
  }

  return {
    ...state,
    phase,
    phaseStartedAt:
      phase === state.phase ? state.phaseStartedAt : state.elapsedMs,
    matchedPanelIds,
  }
}

function advanceChainClosure(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  // The board coming to rest is what ends a chain: from here it has one
  // window left in which a falling panel can still land a further link.
  if (
    state.chain !== null &&
    state.chain.status === 'active' &&
    state.phase === 'idle' &&
    state.pendingSwap === null
  ) {
    return {
      ...state,
      chain: {
        ...state.chain,
        status: 'closing',
        closingStartedAt: state.elapsedMs,
      },
    }
  }

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

  if (
    advanced.garbageConversion === null &&
    advanced.pendingSwap === null
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

  return placeNextGarbageBlock(advanced)
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

/**
 * Ends a timed run the moment its clock runs out. The cut is deliberately hard:
 * a clear still flashing when the timer expires does not get to pay out, so two
 * players who made the same swaps at the same times always finish on the same
 * score. `elapsedMs` is pinned to the limit so the readout lands on 0:00 exactly
 * rather than a step past it.
 */
function endTimedRun(state: SimulationState): SimulationState {
  return {
    ...state,
    elapsedMs: state.timeLimitMs ?? state.elapsedMs,
    status: 'lost',
    endReason: 'time-up',
    manualRaise: false,
    riseSpeed: 0,
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
    nextState.timeLimitMs !== null &&
    // The step is 16.6…ms, so accumulating a whole number of steps lands a
    // float hair short of a round limit (2 minutes comes out 9e-13ms light).
    // Without the slack the run would get one extra step it did not earn.
    nextState.elapsedMs >= nextState.timeLimitMs - 1e-6
  ) {
    return endTimedRun(nextState)
  }

  if (
    nextState.pendingSwap !== null &&
    nextState.elapsedMs - nextState.pendingSwap.startedAt >=
      config.timing.swapDurationMs
  ) {
    nextState = completePendingSwap(nextState)
  }

  nextState = advanceResolution(nextState, config)
  nextState = syncPhaseSummary(nextState)
  nextState = advanceChainClosure(nextState, config)
  nextState = advanceGarbageLifecycle(nextState, config)
  nextState = syncPhaseSummary(nextState)
  nextState = advanceDangerState(nextState, config)
  nextState = advanceRise(nextState, config)
  return nextState
}

export interface SimulationOptions {
  /** Ends the run once the simulation clock reaches this many milliseconds. */
  timeLimitMs?: number | null
}

export function createSimulation(
  seed: string,
  config: GameConfig = defaultGameConfig,
  options: SimulationOptions = {},
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
    timeLimitMs: options.timeLimitMs ?? null,
    endReason: null,
    phase: 'idle',
    phaseStartedAt: 0,
    matchedPanelIds: [],
    clears: [],
    nextClearId: 1,
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
    score: 0,
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
    state.clears
      .map(
        (group) =>
          `${group.id},${group.phase},${group.phaseStartedAt.toFixed(4)},${group.chainId},${group.panelIds.join('.')}`,
      )
      .join('|'),
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
    state.score,
  ].join(';')
  let hash = 2166136261

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}
