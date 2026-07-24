<script setup lang="ts">
import {
  PROTOCOL_VERSION,
  type AttackEvent,
  type BoardSnapshot,
} from '@swapduel/contracts'
import {
  createSimulation,
  defaultGameConfig,
  drainOutgoingAttacks,
  enqueueIncomingGarbage,
  requestSwap,
  restoreSimulationSnapshot,
  serializeSimulationSnapshot,
  setManualRaise,
  simulationChecksum,
  stepSimulation,
} from '@swapduel/game-engine'
import { createBoardSnapshot } from '~/game/network/createBoardSnapshot'
import { drawBoard } from '~/game/renderer/drawBoard'

const SIMULATION_SNAPSHOT_KEY = 'swapduel:simulation-snapshot'
const SIMULATION_SNAPSHOT_INTERVAL_MS = 2_000
const SIMULATION_SNAPSHOT_MAX_AGE_MS = 35_000
const CHECKSUM_INTERVAL_MS = 2_000
const RENDER_INTERVAL_MS = 30
const UI_UPDATE_INTERVAL_MS = 100

const route = useRoute()
const now = ref(Date.now())
const canvas = ref<HTMLCanvasElement | null>(null)
const selected = ref<{ row: number; column: number } | null>(null)
const reducedMotion = ref(false)
const acknowledged = ref(false)
const browserHidden = ref(false)
const foregroundSyncing = ref(false)
const {
  connected,
  roomState,
  session,
  roundPreparation,
  roundStarting,
  opponentSnapshot,
  roundResult,
  matchResult,
  matchScores,
  networkPause,
  networkResume,
  simulationDesync,
  errorMessage,
  confirmRoundReady,
  synchronizeServerClock,
  getServerNow,
  sendBoardSnapshot,
  sendSimulationChecksum,
  sendAttack,
  drainIncomingAttacks,
  acknowledgeAttack,
  reportTopOut,
  readyForNextRound,
  requestRematch,
} = useRoomSocket()
const {
  soundEnabled,
  unlockAudio,
  playSwap,
  playClear,
  playGarbageReceived,
  playDanger,
  playRoundResult,
  toggleSound,
} = useGameAudio()
const topOutReported = ref(false)
const nextRoundReady = ref(false)
const rematchRequested = ref(false)
const localConnectionPaused = ref(false)
const localPauseStartedAt = ref(0)

const activePreparation = computed(() =>
  roundPreparation.value?.matchId === String(route.params.matchId)
    ? roundPreparation.value
    : null,
)
// Landing here without a preparation is usually a back-navigation returning
// mid-match, where the socket has not delivered the room yet. That is a
// reconnect in progress, not a missing round, so hold off on the dead-end
// error until we have actually heard from the server.
const rejoiningMatch = computed(
  () => session.value !== null && (!connected.value || roomState.value === null),
)
const activeStarting = computed(() =>
  roundStarting.value?.matchId === activePreparation.value?.matchId
    ? roundStarting.value
    : null,
)
function recoveryScopeId(
  preparation: NonNullable<typeof activePreparation.value>,
): string {
  return `${preparation.matchId}:${preparation.roundId}`
}

function restoreLocalSimulation(
  preparation: NonNullable<typeof activePreparation.value>,
) {
  if (!import.meta.client) return null
  const serialized = sessionStorage.getItem(SIMULATION_SNAPSHOT_KEY)
  if (serialized === null) return null
  const restored = restoreSimulationSnapshot(serialized, {
    scopeId: recoveryScopeId(preparation),
    expectedSeed: preparation.roundSeed,
    now: Date.now(),
    maxAgeMs: SIMULATION_SNAPSHOT_MAX_AGE_MS,
  })
  if (restored === null) {
    sessionStorage.removeItem(SIMULATION_SNAPSHOT_KEY)
  }
  return restored
}

const initialPreparation = activePreparation.value
const state = shallowRef(
  initialPreparation === null
    ? createSimulation('pending-round')
    : restoreLocalSimulation(initialPreparation) ??
        createSimulation(initialPreparation.roundSeed),
)
// Keep the 60 Hz engine state out of Vue's render cycle. The shallow ref is a
// lower-frequency view used only by status controls around the canvas.
let simulationState = state.value
let activeStateScopeId =
  initialPreparation === null ? null : recoveryScopeId(initialPreparation)
const ownPlayer = computed(() =>
  roomState.value?.players.find(
    ({ playerId }) => playerId === session.value?.playerId,
  ),
)
const opponent = computed(() =>
  roomState.value?.players.find(
    ({ playerId }) => playerId !== session.value?.playerId,
  ),
)
const scheduledRoundIsLive = computed(
  () =>
    activeStarting.value !== null &&
    now.value >= activeStarting.value.startAt &&
    roundResult.value?.roundId !== activePreparation.value?.roundId,
)
const networkBlocked = computed(() => {
  const resumeAt = networkResume.value?.resumeAt ?? 0
  const localBlock =
    localConnectionPaused.value &&
    (resumeAt <= localPauseStartedAt.value || now.value < resumeAt)
  const remoteBlock =
    networkPause.value !== null &&
    (resumeAt === 0 || now.value < resumeAt)
  return localBlock || remoteBlock || foregroundSyncing.value
})
const roundIsLive = computed(
  () =>
    scheduledRoundIsLive.value &&
    !networkBlocked.value &&
    !browserHidden.value,
)
const showCountdown = computed(
  () =>
    activeStarting.value === null ||
    now.value < activeStarting.value.startAt + 850,
)
const countdownLabel = computed(() => {
  if (activeStarting.value === null) return '…'
  const remaining = activeStarting.value.startAt - now.value
  if (remaining > 0) return String(Math.min(3, Math.ceil(remaining / 1_000)))
  return 'GO!'
})
const incomingBlockCount = computed(
  () =>
    state.value.incomingGarbage.reduce(
      (total, attack) => total + attack.blocks.length,
      0,
    ),
)
const ownWins = computed(
  () =>
    matchScores.value.find(
      ({ playerId }) => playerId === session.value?.playerId,
    )?.wins ?? 0,
)
const opponentWins = computed(
  () =>
    matchScores.value.find(
      ({ playerId }) => playerId !== session.value?.playerId,
    )?.wins ?? 0,
)
const resultTitle = computed(() => {
  if (matchResult.value !== null) {
    return matchResult.value.winnerPlayerId === session.value?.playerId
      ? 'Match won!'
      : 'Match lost'
  }
  if (roundResult.value?.result === 'draw') return 'Draw round'
  return roundResult.value?.winnerPlayerId === session.value?.playerId
    ? 'Round won!'
    : 'Round lost'
})
const networkStatusLabel = computed(() => {
  if (foregroundSyncing.value) return 'Syncing match clock…'
  if (networkResume.value !== null) {
    const remaining = networkResume.value.resumeAt - now.value
    return remaining > 0
      ? String(Math.min(3, Math.ceil(remaining / 1_000)))
      : 'GO!'
  }
  if (!connected.value) return 'Reconnecting…'
  const seconds =
    networkPause.value === null
      ? 30
      : Math.max(
          0,
          Math.ceil(
            (networkPause.value.forfeitAt - now.value) / 1_000,
          ),
        )
  return `Waiting for opponent · ${seconds}s`
})

let animationFrame = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let wasLive = false
let lastDrawnStatus = simulationState.status
let previousTimestamp = 0
let accumulatorMs = 0
let lastRenderAt = 0
let lastUiUpdateAt = 0
let lastSnapshotAt = 0
let lastRecoverySnapshotAt = 0
let lastChecksumSequence =
  Math.floor(simulationState.elapsedMs / CHECKSUM_INTERVAL_MS) - 1
let lastAudioClearAt =
  simulationState.lastClearEvent?.occurredAt ?? Number.NEGATIVE_INFINITY
let snapshotSequence = 0
let renderRequested = true
let resizeObserver: ResizeObserver | null = null
let raiseTimer: ReturnType<typeof setTimeout> | null = null
let localDisconnectTimer: ReturnType<typeof setTimeout> | null = null
let roundConfirmationInFlight = false
let activePointer:
  | {
      id: number
      row: number
      column: number
      startX: number
      startY: number
      triggered: boolean
      verticalRejected: boolean
    }
  | null = null

useHead({
  title: 'Live match · Swapduel',
  // Locks the document to the viewport for the duration of the match; unhead
  // removes it again on leaving the page.
  htmlAttrs: { class: 'viewport-locked' },
})

function clearLocalSimulationSnapshot(): void {
  if (import.meta.client) {
    sessionStorage.removeItem(SIMULATION_SNAPSHOT_KEY)
  }
}

function persistLocalSimulationSnapshot(force = false): void {
  if (!import.meta.client) return
  const preparation = activePreparation.value
  if (
    preparation === null ||
    roundResult.value?.roundId === preparation.roundId
  ) {
    clearLocalSimulationSnapshot()
    return
  }
  const savedAt = Date.now()
  if (
    !force &&
    savedAt - lastRecoverySnapshotAt <
      SIMULATION_SNAPSHOT_INTERVAL_MS
  ) {
    return
  }
  try {
    sessionStorage.setItem(
      SIMULATION_SNAPSHOT_KEY,
      serializeSimulationSnapshot(
        simulationState,
        recoveryScopeId(preparation),
        savedAt,
      ),
    )
    lastRecoverySnapshotAt = savedAt
  } catch {
    clearLocalSimulationSnapshot()
  }
}

async function confirmPreparedRound(): Promise<void> {
  if (
    !import.meta.client ||
    document.hidden ||
    acknowledged.value ||
    roundConfirmationInFlight ||
    activePreparation.value === null
  ) {
    return
  }
  roundConfirmationInFlight = true
  try {
    await nextTick()
    acknowledged.value = await confirmRoundReady()
  } finally {
    roundConfirmationInFlight = false
  }
}

watch(activePreparation, async (preparation) => {
  const nextScopeId =
    preparation === null ? null : recoveryScopeId(preparation)
  if (
    preparation !== null &&
    activeStateScopeId !== nextScopeId
  ) {
    simulationState =
      restoreLocalSimulation(preparation) ??
      createSimulation(preparation.roundSeed)
    state.value = simulationState
    selected.value = null
    snapshotSequence = 0
    topOutReported.value = false
    nextRoundReady.value = false
    rematchRequested.value = false
    localConnectionPaused.value = false
    localPauseStartedAt.value = 0
    acknowledged.value = false
    renderRequested = true
    lastRenderAt = 0
    lastUiUpdateAt = 0
    lastRecoverySnapshotAt = 0
    lastChecksumSequence =
      Math.floor(simulationState.elapsedMs / CHECKSUM_INTERVAL_MS) - 1
    lastAudioClearAt =
      simulationState.lastClearEvent?.occurredAt ??
      Number.NEGATIVE_INFINITY
    activeStateScopeId = nextScopeId
    await confirmPreparedRound()
  }
})

watch(roundResult, (result, previousResult) => {
  if (
    result !== null &&
    result.roundId === activePreparation.value?.roundId
  ) {
    clearLocalSimulationSnapshot()
    if (previousResult?.roundId !== result.roundId) {
      playRoundResult(
        result.result === 'draw'
          ? 'draw'
          : result.winnerPlayerId === session.value?.playerId
            ? 'win'
            : 'loss',
      )
    }
  }
})

watch(roundPreparation, async (preparation) => {
  if (
    preparation !== null &&
    preparation.matchId !== String(route.params.matchId)
  ) {
    await navigateTo(`/match/${preparation.matchId}`)
  }
})

watch(connected, (isConnected) => {
  if (isConnected) {
    if (localDisconnectTimer !== null) {
      clearTimeout(localDisconnectTimer)
      localDisconnectTimer = null
    }
    return
  }
  if (!scheduledRoundIsLive.value || localDisconnectTimer !== null) return
  localDisconnectTimer = setTimeout(() => {
    localConnectionPaused.value = true
    localPauseStartedAt.value = getServerNow()
    localDisconnectTimer = null
  }, 1_000)
})

function render(): void {
  if (canvas.value === null) return
  drawBoard(canvas.value, simulationState, {
    selected: selected.value,
    reducedMotion: reducedMotion.value,
  })
}

function requestRender(): void {
  renderRequested = true
  wakeLoop()
}

function updateUiState(timestamp: number, serverNow: number): void {
  if (
    lastUiUpdateAt !== 0 &&
    timestamp - lastUiUpdateAt < UI_UPDATE_INTERVAL_MS
  ) {
    return
  }
  lastUiUpdateAt = timestamp
  now.value = serverNow
  state.value = simulationState
}

function isRoundLiveAt(serverNow: number): boolean {
  const starting = activeStarting.value
  if (
    starting === null ||
    serverNow < starting.startAt ||
    roundResult.value?.roundId === activePreparation.value?.roundId ||
    browserHidden.value ||
    foregroundSyncing.value
  ) {
    return false
  }

  const resumeAt = networkResume.value?.resumeAt ?? 0
  const localBlock =
    localConnectionPaused.value &&
    (resumeAt <= localPauseStartedAt.value || serverNow < resumeAt)
  const remoteBlock =
    networkPause.value !== null &&
    (resumeAt === 0 || serverNow < resumeAt)
  return !localBlock && !remoteBlock
}

function reportTopOutIfNeeded(): void {
  if (
    simulationState.status !== 'lost' ||
    topOutReported.value ||
    activePreparation.value === null
  ) {
    return
  }
  topOutReported.value = true
  void reportTopOut()
}

function sendCurrentSnapshot(timestamp: number): void {
  const preparation = activePreparation.value
  const playerId = session.value?.playerId
  if (preparation === null || playerId === undefined) return

  snapshotSequence += 1
  sendBoardSnapshot(
    createBoardSnapshot(
      simulationState,
      {
        matchId: preparation.matchId,
        roundId: preparation.roundId,
        playerId,
      },
      snapshotSequence,
      timestamp,
    ),
  )
}

function applyIncomingAttacks(): void {
  for (const attack of drainIncomingAttacks()) {
    simulationState = enqueueIncomingGarbage(simulationState, {
      attackId: attack.attackId,
      serverSequence: attack.serverSequence,
      blocks: attack.blocks.map((block) => ({ ...block })),
    })
    playGarbageReceived()
    acknowledgeAttack(attack)
  }
}

function playSimulationSounds(): void {
  const clear = simulationState.lastClearEvent
  if (clear !== null && clear.occurredAt > lastAudioClearAt) {
    lastAudioClearAt = clear.occurredAt
    playClear(clear.normalSize, clear.chainLevel)
  }
  if (simulationState.dangerRemainingMs !== null) {
    playDanger()
  }
}

function flushOutgoingAttacks(timestamp: number): void {
  const drained = drainOutgoingAttacks(simulationState)
  if (drained.attacks.length === 0) return
  simulationState = drained.state

  const preparation = activePreparation.value
  const playerId = session.value?.playerId
  if (preparation === null || playerId === undefined) return

  for (const attack of drained.attacks) {
    const event: AttackEvent = {
      protocolVersion: PROTOCOL_VERSION,
      attackId: `${preparation.roundId}:${playerId}:${attack.sequence}`,
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      senderId: playerId,
      localSequence: attack.sequence,
      clientTimestamp: timestamp,
      kind: attack.kind,
      blocks: attack.blocks.map((block) => ({ ...block })),
    }
    void sendAttack(event)
  }
}

function sendCurrentChecksum(timestamp: number): void {
  const preparation = activePreparation.value
  const playerId = session.value?.playerId
  if (preparation === null || playerId === undefined) return

  const sequence = Math.floor(
    simulationState.elapsedMs / CHECKSUM_INTERVAL_MS,
  )
  if (sequence <= lastChecksumSequence) return
  lastChecksumSequence = sequence
  sendSimulationChecksum({
    protocolVersion: PROTOCOL_VERSION,
    matchId: preparation.matchId,
    roundId: preparation.roundId,
    playerId,
    sequence,
    simulationStep: Math.round(
      simulationState.elapsedMs /
        defaultGameConfig.timing.fixedStepMs,
    ),
    checksum: simulationChecksum(simulationState),
    clientTimestamp: timestamp,
  })
}

function animationLoop(timestamp: number): void {
  animationFrame = 0
  if (browserHidden.value) return

  const serverNow = getServerNow()
  const simulationIsLive = isRoundLiveAt(serverNow)

  if (simulationIsLive) {
    // Coming out of an idle tick, previousTimestamp is up to one idle
    // interval stale — start fresh so the accumulator does not burst.
    if (!wasLive || previousTimestamp === 0) previousTimestamp = timestamp
    const frameDelta = Math.min(100, timestamp - previousTimestamp)
    previousTimestamp = timestamp

    applyIncomingAttacks()
    accumulatorMs += frameDelta
    while (accumulatorMs >= defaultGameConfig.timing.fixedStepMs) {
      simulationState = stepSimulation(simulationState)
      accumulatorMs -= defaultGameConfig.timing.fixedStepMs
    }
    playSimulationSounds()
    reportTopOutIfNeeded()
    flushOutgoingAttacks(serverNow)
    sendCurrentChecksum(serverNow)

    if (timestamp - lastSnapshotAt >= 100) {
      lastSnapshotAt = timestamp
      sendCurrentSnapshot(serverNow)
    }
    persistLocalSimulationSnapshot()
  } else {
    previousTimestamp = 0
  }
  wasLive = simulationIsLive

  // Once the local board has topped out nothing on it moves again, but the
  // round only stops counting as live when the server confirms the result.
  // Keep reporting and syncing, just stop doing it at display rate.
  const simulationIsAnimating =
    simulationIsLive && simulationState.status === 'playing'
  // The tick that ends the round must still paint its final frame.
  if (simulationState.status !== lastDrawnStatus) {
    lastDrawnStatus = simulationState.status
    renderRequested = true
  }

  updateUiState(timestamp, serverNow)
  if (
    renderRequested ||
    (simulationIsAnimating &&
      (lastRenderAt === 0 ||
        timestamp - lastRenderAt >= RENDER_INTERVAL_MS))
  ) {
    render()
    renderRequested = false
    lastRenderAt = timestamp
  }
  scheduleNextTick(simulationIsAnimating, serverNow)
}

// While a round is live we need per-frame stepping. Outside of one (lobby,
// countdown, results) nothing moves and only the clock-driven labels need
// refreshing, so drop off requestAnimationFrame onto a slow timer instead of
// waking the CPU 60 times a second for nothing.
function scheduleNextTick(
  simulationIsLive: boolean,
  serverNow: number,
): void {
  if (browserHidden.value || animationFrame !== 0 || idleTimer !== null) return
  if (simulationIsLive || renderRequested || roundStartIsImminent(serverNow)) {
    animationFrame = requestAnimationFrame(animationLoop)
    return
  }
  idleTimer = setTimeout(() => {
    idleTimer = null
    animationLoop(performance.now())
  }, UI_UPDATE_INTERVAL_MS)
}

// Never let an idle tick straddle the round start — be back on rAF before the
// first simulation step is due.
function roundStartIsImminent(serverNow: number): boolean {
  const starting = activeStarting.value
  return (
    starting !== null &&
    serverNow >= starting.startAt - UI_UPDATE_INTERVAL_MS * 2 &&
    serverNow < starting.startAt
  )
}

function startAnimationLoop(): void {
  if (animationFrame !== 0 || idleTimer !== null || browserHidden.value) return
  animationFrame = requestAnimationFrame(animationLoop)
}

// Pull the loop back onto rAF immediately when something needs drawing
// (resize, selection, a round going live) rather than waiting out the timer.
function wakeLoop(): void {
  if (browserHidden.value || animationFrame !== 0) return
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  animationFrame = requestAnimationFrame(animationLoop)
}

function suspendForBackground(): void {
  if (browserHidden.value) return
  persistLocalSimulationSnapshot(true)
  browserHidden.value = true
  foregroundSyncing.value = false
  if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
  animationFrame = 0
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  wasLive = false
  previousTimestamp = 0
  accumulatorMs = 0
  lastRenderAt = 0
  lastUiUpdateAt = 0
  stopRaise()
  selected.value = null
  activePointer = null
}

async function resumeFromBackground(): Promise<void> {
  if (!browserHidden.value && (animationFrame !== 0 || idleTimer !== null)) {
    return
  }
  browserHidden.value = false
  foregroundSyncing.value = true
  wasLive = false
  previousTimestamp = 0
  accumulatorMs = 0
  lastRenderAt = 0
  lastUiUpdateAt = 0
  lastSnapshotAt = 0
  renderRequested = true
  startAnimationLoop()
  await synchronizeServerClock()
  if (document.hidden) {
    suspendForBackground()
    return
  }
  now.value = getServerNow()
  previousTimestamp = 0
  accumulatorMs = 0
  foregroundSyncing.value = false
  await confirmPreparedRound()
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    suspendForBackground()
    return
  }
  void resumeFromBackground()
}

function boardCoordinate(
  event: PointerEvent,
): { row: number; column: number } | null {
  const target = canvas.value
  if (target === null) return null
  const bounds = target.getBoundingClientRect()
  const cellSize = bounds.width / simulationState.board.columns
  const column = Math.floor((event.clientX - bounds.left) / cellSize)
  const row = Math.floor(
    (bounds.height - (event.clientY - bounds.top)) / cellSize -
      simulationState.riseOffset,
  )

  if (
    row < 0 ||
    row >= simulationState.board.visibleRows ||
    column < 0 ||
    column >= simulationState.board.columns
  ) {
    return null
  }
  return { row, column }
}

function trySwap(row: number, column: number, direction: -1 | 1): boolean {
  if (!isRoundLiveAt(getServerNow())) return false
  const result = requestSwap(simulationState, { row, column, direction })
  simulationState = result.state
  if (result.ok) {
    selected.value = null
    playSwap()
    requestRender()
  }
  return result.ok
}

function onBoardPointerDown(event: PointerEvent): void {
  unlockAudio()
  if (!roundIsLive.value || activePointer !== null) return
  const coordinate = boardCoordinate(event)
  if (coordinate === null) {
    selected.value = null
    return
  }

  canvas.value?.setPointerCapture(event.pointerId)
  activePointer = {
    id: event.pointerId,
    row: coordinate.row,
    column: coordinate.column,
    startX: event.clientX,
    startY: event.clientY,
    triggered: false,
    verticalRejected: false,
  }
}

function onBoardPointerMove(event: PointerEvent): void {
  if (activePointer === null || activePointer.id !== event.pointerId) return

  const horizontal = event.clientX - activePointer.startX
  const vertical = event.clientY - activePointer.startY
  if (
    !activePointer.triggered &&
    Math.abs(vertical) > Math.abs(horizontal) &&
    Math.abs(vertical) > 8
  ) {
    activePointer.verticalRejected = true
  }

  const bounds = canvas.value?.getBoundingClientRect()
  if (
    bounds === undefined ||
    activePointer.triggered ||
    activePointer.verticalRejected ||
    Math.abs(horizontal) <
      (bounds.width / simulationState.board.columns) * 0.28
  ) {
    return
  }

  activePointer.triggered = trySwap(
    activePointer.row,
    activePointer.column,
    horizontal < 0 ? -1 : 1,
  )
}

function onBoardPointerEnd(event: PointerEvent): void {
  if (activePointer === null || activePointer.id !== event.pointerId) return

  if (!activePointer.triggered && !activePointer.verticalRejected) {
    const tapped = boardCoordinate(event)
    if (tapped !== null) {
      if (
        selected.value !== null &&
        selected.value.row === tapped.row &&
        Math.abs(selected.value.column - tapped.column) === 1
      ) {
        trySwap(
          selected.value.row,
          selected.value.column,
          tapped.column > selected.value.column ? 1 : -1,
        )
      } else {
        selected.value = tapped
        requestRender()
      }
    }
  }
  activePointer = null
}

function startRaise(event: PointerEvent): void {
  unlockAudio()
  if (!isRoundLiveAt(getServerNow())) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  raiseTimer = setTimeout(() => {
    simulationState = setManualRaise(simulationState, true)
  }, 80)
}

function stopRaise(): void {
  if (raiseTimer !== null) {
    clearTimeout(raiseTimer)
    raiseTimer = null
  }
  simulationState = setManualRaise(simulationState, false)
}

function miniCellStyle(cell: BoardSnapshot['cells'][number]) {
  const riseOffset = opponentSnapshot.value?.riseOffset ?? 0
  return {
    left: `${(cell.column / 6) * 100}%`,
    bottom: `${((cell.row + riseOffset) / 12) * 100}%`,
  }
}

function miniGarbageStyle(
  block: BoardSnapshot['garbage'][number],
) {
  const riseOffset = opponentSnapshot.value?.riseOffset ?? 0
  return {
    left: `${(block.column / 6) * 100}%`,
    bottom: `${((block.row + riseOffset) / 12) * 100}%`,
    width: `${(block.width / 6) * 100}%`,
    height: `${(block.height / 12) * 100}%`,
    '--garbage-cell-width': `${100 / block.width}%`,
    '--garbage-cell-height': `${100 / block.height}%`,
  }
}

function panelGlyph(type: BoardSnapshot['cells'][number]['type']): string {
  return {
    heart: '♥',
    circle: '○',
    diamond: '◆',
    star: '★',
    triangle: '△',
    crescent: '◔',
    shock: 'ϟ',
  }[type]
}

function scoreDots(wins: number): string {
  return `${'●'.repeat(wins)}${'○'.repeat(Math.max(0, 2 - wins))}`
}

async function prepareNextRound(): Promise<void> {
  nextRoundReady.value = true
  const accepted = await readyForNextRound()
  if (!accepted) nextRoundReady.value = false
}

async function askForRematch(): Promise<void> {
  rematchRequested.value = true
  const accepted = await requestRematch()
  if (!accepted) rematchRequested.value = false
}

onMounted(async () => {
  reducedMotion.value = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches
  resizeObserver = new ResizeObserver(render)
  if (canvas.value !== null) resizeObserver.observe(canvas.value)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', suspendForBackground)
  window.addEventListener('pageshow', handleVisibilityChange)
  browserHidden.value = document.hidden
  if (!browserHidden.value) await resumeFromBackground()

  await confirmPreparedRound()
})

onBeforeUnmount(() => {
  persistLocalSimulationSnapshot(true)
  cancelAnimationFrame(animationFrame)
  if (idleTimer !== null) clearTimeout(idleTimer)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('pagehide', suspendForBackground)
  window.removeEventListener('pageshow', handleVisibilityChange)
  resizeObserver?.disconnect()
  if (localDisconnectTimer !== null) clearTimeout(localDisconnectTimer)
  stopRaise()
})
</script>

<template>
  <main class="game-shell">
    <section
      v-if="activePreparation === null && rejoiningMatch"
      class="missing-card"
    >
      <p>Rejoining</p>
      <h1>Finding your match…</h1>
    </section>

    <section
      v-else-if="activePreparation === null"
      class="missing-card"
    >
      <p>Match unavailable</p>
      <h1>Round setup missing</h1>
      <NuxtLink :to="`/room/${roomState?.roomCode ?? ''}`">
        Back to room
      </NuxtLink>
    </section>

    <section v-else class="game-layout">
      <header class="scorebar">
        <div class="player-score">
          <strong>{{ ownPlayer?.displayName ?? 'You' }}</strong>
          <span>{{ scoreDots(ownWins) }}</span>
        </div>
        <div class="round-label">
          <small>Round</small>
          <strong>{{ activePreparation.roundNumber }}</strong>
        </div>
        <div class="player-score player-score--opponent">
          <strong>{{ opponent?.displayName ?? 'Opponent' }}</strong>
          <span>{{ scoreDots(opponentWins) }}</span>
        </div>
      </header>

      <div class="boards">
        <div class="own-board">
          <canvas
            ref="canvas"
            class="board"
            aria-label="Your interactive six-column puzzle board"
            @pointerdown="onBoardPointerDown"
            @pointermove="onBoardPointerMove"
            @pointerup="onBoardPointerEnd"
            @pointercancel="onBoardPointerEnd"
          />
        </div>

        <aside class="opponent-rail">
          <div class="rail-title">
            <span :class="{ online: connected }" />
            Opponent
          </div>
          <div class="mini-board" aria-label="Opponent board preview">
            <span
              v-for="cell in opponentSnapshot?.cells ?? []"
              :key="`${cell.row}-${cell.column}`"
              class="mini-cell"
              :class="`mini-cell--${cell.type}`"
              :style="miniCellStyle(cell)"
            >
              {{ panelGlyph(cell.type) }}
            </span>
            <span
              v-for="block in opponentSnapshot?.garbage ?? []"
              :key="`garbage-${block.id}`"
              class="mini-garbage"
              :class="{
                metal: block.type === 'metal',
                falling: block.state === 'falling',
                converting: block.state === 'converting',
              }"
              :style="miniGarbageStyle(block)"
            />
            <span v-if="opponentSnapshot === null" class="mini-waiting">
              Waiting for board…
            </span>
          </div>

          <div class="incoming">
            <span>Incoming</span>
            <strong>{{ incomingBlockCount }}</strong>
          </div>
          <div v-if="state.chain !== null" class="chain-pill">
            ×{{ state.chain.level }} chain
          </div>
        </aside>

        <div v-if="showCountdown" class="countdown-overlay">
          <strong>{{ countdownLabel }}</strong>
          <span v-if="activeStarting === null">
            {{
              acknowledged
                ? 'Waiting for opponent'
                : 'Preparing board'
            }}
          </span>
          <span v-else>Both boards synchronized</span>
        </div>

        <div
          v-if="networkBlocked && roundResult === null"
          class="network-overlay"
        >
          <p>
            {{
              networkResume === null
                ? 'Connection paused'
                : 'Opponent reconnected'
            }}
          </p>
          <strong>{{ networkStatusLabel }}</strong>
          <span>Your board is safely paused.</span>
        </div>

        <div v-if="roundResult !== null" class="result-overlay">
          <p>
            {{
              matchResult === null
                ? `Round ${roundResult.roundNumber}`
                : 'First to 2'
            }}
          </p>
          <h2>{{ resultTitle }}</h2>
          <div class="result-score">
            <strong>{{ ownWins }}</strong>
            <span>—</span>
            <strong>{{ opponentWins }}</strong>
          </div>
          <button
            v-if="matchResult === null"
            type="button"
            :disabled="nextRoundReady"
            @click="prepareNextRound"
          >
            {{
              nextRoundReady
                ? 'Waiting for opponent…'
                : 'Ready for next round'
            }}
          </button>
          <div v-else class="match-actions">
            <button
              type="button"
              :disabled="rematchRequested"
              @click="askForRematch"
            >
              {{
                rematchRequested
                  ? 'Waiting for opponent…'
                  : 'Play again'
              }}
            </button>
            <NuxtLink to="/">Leave room</NuxtLink>
          </div>
        </div>
      </div>

      <div class="game-controls">
        <button
          class="raise"
          type="button"
          :disabled="
            !roundIsLive ||
            state.status === 'lost' ||
            state.dangerRemainingMs !== null
          "
          @pointerdown="startRaise"
          @pointerup="stopRaise"
          @pointercancel="stopRaise"
          @pointerleave="stopRaise"
        >
          Hold to raise
        </button>
        <button
          class="sound-toggle"
          type="button"
          :aria-label="soundEnabled ? 'Mute game sounds' : 'Enable game sounds'"
          :aria-pressed="soundEnabled"
          :title="soundEnabled ? 'Mute game sounds' : 'Enable game sounds'"
          @click="toggleSound"
        >
          <span aria-hidden="true">{{ soundEnabled ? '♪' : '×' }}</span>
        </button>
      </div>

      <p v-if="errorMessage" class="error-message" role="alert">
        {{ errorMessage }}
      </p>
      <p
        v-if="simulationDesync !== null"
        class="error-message"
        role="status"
      >
        Simulation consistency warning detected. Rejoin if the boards appear
        out of sync.
      </p>
    </section>
  </main>
</template>

<style scoped>
.game-shell {
  height: 100dvh;
  /* Capped at the viewport: a bare 520px floor made the shell taller than a
     landscape phone and scrolled the page. The layout compresses instead. */
  min-height: min(520px, 100dvh);
  overflow: hidden;
  padding:
    max(10px, env(safe-area-inset-top))
    max(10px, env(safe-area-inset-right))
    max(12px, env(safe-area-inset-bottom))
    max(10px, env(safe-area-inset-left));
}

.game-layout {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 10px;
  width: min(100%, 520px);
  height: 100%;
  margin: 0 auto;
}

.scorebar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 8px 14px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 7px 20px rgba(120, 80, 50, 0.1);
}

.player-score {
  min-width: 0;
}

.player-score strong,
.player-score span {
  display: block;
}

.player-score strong {
  overflow: hidden;
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: 0.9rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-score span {
  color: #5fd0a0;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
}

.player-score--opponent {
  text-align: right;
}

.player-score--opponent span {
  color: #ff7c86;
}

.round-label {
  display: flex;
  align-items: baseline;
  gap: 4px;
  color: #c99b82;
}

.round-label small {
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.round-label strong {
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
  font-size: 1.3rem;
}

.boards {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(76px, 1fr);
  gap: 10px;
  min-height: 0;
}

.own-board {
  display: flex;
  min-width: 0;
  min-height: 0;
  justify-content: center;
}

.board {
  display: block;
  width: auto;
  max-width: 100%;
  height: 100%;
  aspect-ratio: 1 / 2;
  border: 3px solid #fff;
  border-radius: 24px;
  box-shadow:
    0 0 0 2px #f6c29a,
    0 9px 22px rgba(110, 86, 72, 0.15);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.opponent-rail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.rail-title {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #bc8e72;
  font-size: 0.62rem;
  font-weight: 800;
  text-transform: uppercase;
}

.rail-title span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c9b4a5;
}

.rail-title span.online {
  background: #5fd0a0;
}

.mini-board {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 2;
  overflow: hidden;
  border: 2px solid #fff;
  border-radius: 16px;
  background:
    linear-gradient(rgba(196, 120, 80, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(196, 120, 80, 0.08) 1px, transparent 1px),
    #fff4e8;
  background-size: 16.6667% 8.3333%;
  box-shadow:
    0 0 0 1px #f6c29a,
    0 6px 14px rgba(110, 86, 72, 0.12);
}

.mini-cell {
  position: absolute;
  display: grid;
  width: 16.6667%;
  height: 8.3333%;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 28%;
  color: rgba(255, 255, 255, 0.92);
  font-size: clamp(0.42rem, 2vw, 0.7rem);
  line-height: 1;
  transform: scale(0.87);
}

.mini-cell--heart {
  background: linear-gradient(#ff7c86 55%, #f0606c);
}

.mini-cell--circle {
  background: linear-gradient(#5fd0a0 55%, #3fba87);
}

.mini-cell--diamond {
  background: linear-gradient(#6bb6f2 55%, #4c9ee3);
}

.mini-cell--star {
  background: linear-gradient(#ffcf5c 55%, #f4b637);
}

.mini-cell--triangle {
  background: linear-gradient(#b79bf0 55%, #9e7fe6);
}

.mini-cell--crescent {
  background: linear-gradient(#ffb59a 55%, #ed6a45);
}

.mini-cell--shock {
  background: linear-gradient(#fffaf5 55%, #ffd8b8);
  color: #ed6a45;
}

.mini-garbage {
  position: absolute;
  z-index: 2;
  overflow: hidden;
  border: 1px solid rgba(255, 248, 241, 0.9);
  border-radius: 7px;
  background:
    radial-gradient(
      circle,
      rgba(255, 248, 241, 0.68) 0 16%,
      rgba(110, 78, 61, 0.24) 17% 20%,
      transparent 21%
    ),
    linear-gradient(
      90deg,
      transparent calc(100% - 1px),
      rgba(104, 72, 56, 0.3) 0
    ),
    linear-gradient(
      transparent calc(100% - 1px),
      rgba(104, 72, 56, 0.3) 0
    ),
    linear-gradient(#ead8c8, #cfb5a3 52%, #b79784);
  background-position: center;
  background-size:
    var(--garbage-cell-width) var(--garbage-cell-height),
    var(--garbage-cell-width) 100%,
    100% var(--garbage-cell-height),
    100% 100%;
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.4),
    inset 0 -2px 0 rgba(104, 72, 56, 0.16),
    0 2px 0 #9f7f6d;
  transform: scale(0.92);
}

.mini-garbage.metal {
  border-color: rgba(246, 252, 255, 0.92);
  background:
    radial-gradient(
      circle,
      #e8f2f7 0 15%,
      rgba(66, 105, 130, 0.72) 16% 22%,
      transparent 23%
    ),
    linear-gradient(
      90deg,
      transparent calc(100% - 1px),
      rgba(65, 103, 128, 0.42) 0
    ),
    linear-gradient(
      transparent calc(100% - 1px),
      rgba(65, 103, 128, 0.42) 0
    ),
    repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.14) 0 3px,
      transparent 3px 8px
    ),
    linear-gradient(#d9e8f1, #adc7d8 48%, #86a8bd);
  background-size:
    var(--garbage-cell-width) var(--garbage-cell-height),
    var(--garbage-cell-width) 100%,
    100% var(--garbage-cell-height),
    auto,
    100% 100%;
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.45),
    inset 0 -2px 0 rgba(57, 92, 116, 0.18),
    0 2px 0 #6689a1;
}

.mini-garbage.falling {
  filter: drop-shadow(0 3px 2px rgba(110, 86, 72, 0.22));
}

.mini-garbage.converting {
  border-color: rgba(63, 186, 135, 0.9);
  box-shadow:
    inset 0 -5px 0 rgba(95, 208, 160, 0.62),
    0 0 0 1px rgba(95, 208, 160, 0.38),
    0 2px 0 #3fba87;
}

.mini-waiting {
  position: absolute;
  inset: 0;
  display: grid;
  padding: 8px;
  place-items: center;
  color: #c99b82;
  font-size: 0.58rem;
  font-weight: 800;
  text-align: center;
}

.incoming {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 9px 10px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 4px 12px rgba(110, 86, 72, 0.09);
}

.incoming span {
  color: #c99b82;
  font-size: 0.56rem;
  font-weight: 800;
  text-transform: uppercase;
}

.incoming strong {
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
}

.chain-pill {
  padding: 7px 8px;
  border-radius: 14px;
  background: linear-gradient(180deg, #ffd15c, #ff9a4e);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 0.68rem;
  font-weight: 700;
  text-align: center;
}

.countdown-overlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  align-content: center;
  justify-items: center;
  border-radius: 24px;
  background: rgba(255, 244, 232, 0.78);
  backdrop-filter: blur(5px);
}

.network-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: grid;
  align-content: center;
  justify-items: center;
  padding: 24px;
  border-radius: 24px;
  background: rgba(255, 244, 232, 0.94);
  backdrop-filter: blur(7px);
  text-align: center;
}

.network-overlay p {
  margin: 0;
  color: #c99b82;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.network-overlay strong {
  margin-top: 8px;
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(1.8rem, 10vw, 3rem);
  font-weight: 700;
}

.network-overlay span {
  margin-top: 8px;
  color: #a38b7c;
  font-size: 0.78rem;
  font-weight: 700;
}

.result-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  align-content: center;
  justify-items: center;
  padding: 24px;
  border-radius: 24px;
  background: rgba(255, 244, 232, 0.92);
  backdrop-filter: blur(7px);
  text-align: center;
}

.result-overlay p {
  margin: 0;
  color: #c99b82;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.result-overlay h2 {
  margin: 5px 0 0;
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(2.2rem, 12vw, 3.6rem);
  font-weight: 700;
}

.result-score {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 18px 0 22px;
  color: #c99b82;
}

.result-score strong {
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: 2.2rem;
}

.result-overlay button,
.result-overlay a {
  display: inline-flex;
  min-height: 54px;
  align-items: center;
  justify-content: center;
  padding: 0 25px;
  border: 0;
  border-radius: 28px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    0 5px 0 #d95832,
    0 10px 16px rgba(217, 88, 50, 0.22);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 0.96rem;
  font-weight: 600;
  text-decoration: none;
}

.result-overlay button:disabled {
  filter: saturate(0.5);
  opacity: 0.68;
}

.match-actions {
  display: grid;
  gap: 12px;
  justify-items: center;
}

.match-actions a {
  min-height: 44px;
  padding: 0 18px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(110, 86, 72, 0.1);
  color: #bc8e72;
}

.countdown-overlay strong {
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(3.8rem, 20vw, 6rem);
  font-weight: 700;
  text-shadow:
    0 3px 0 #fff,
    0 6px 14px rgba(196, 120, 80, 0.2);
}

.countdown-overlay span {
  color: #bc8e72;
  font-size: 0.72rem;
  font-weight: 800;
}

.game-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  gap: 10px;
}

.raise {
  width: 100%;
  min-height: 58px;
  border: 0;
  border-radius: 31px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.12),
    0 5px 0 #d95832,
    0 10px 16px rgba(217, 88, 50, 0.24);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1rem;
  font-weight: 600;
  touch-action: none;
  user-select: none;
}

.raise:active {
  transform: translateY(3px);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.45),
    0 2px 0 #d95832;
}

.raise:disabled {
  filter: saturate(0.45);
  opacity: 0.62;
}

.sound-toggle {
  min-width: 58px;
  min-height: 58px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: linear-gradient(180deg, #fff 0%, #ffead6 100%);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.8),
    0 4px 0 #f6c29a,
    0 8px 14px rgba(120, 80, 50, 0.16);
  color: #ed6a45;
  font-family: "Fredoka", sans-serif;
  font-size: 1.45rem;
  font-weight: 700;
}

.sound-toggle:active {
  transform: translateY(2px);
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.75),
    0 2px 0 #f6c29a;
}

.sound-toggle[aria-pressed="false"] {
  background: linear-gradient(180deg, #fff 0%, #f2e8e0 100%);
  color: #a38b7c;
}

.error-message {
  position: fixed;
  right: 16px;
  bottom: 16px;
  left: 16px;
  z-index: 6;
  margin: 0 auto;
  padding: 10px 14px;
  border-radius: 18px;
  background: #fff;
  color: #f0606c;
  font-size: 0.75rem;
  font-weight: 800;
  text-align: center;
  box-shadow: 0 8px 20px rgba(110, 86, 72, 0.14);
}

.missing-card {
  width: min(100%, 440px);
  margin: 15vh auto 0;
  padding: 28px;
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(120, 80, 50, 0.1);
}

.missing-card p {
  color: #c99b82;
  font-size: 0.7rem;
  font-weight: 800;
  text-transform: uppercase;
}

.missing-card h1 {
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
}

.missing-card a {
  color: #bc8e72;
  font-weight: 800;
}

@media (max-height: 620px) {
  .game-layout {
    gap: 7px;
  }

  .scorebar {
    min-height: 46px;
    padding-block: 5px;
  }

  .raise {
    min-height: 50px;
  }
}
</style>
