<script setup lang="ts">
import {
  createSimulation,
  defaultGameConfig,
  enqueueIncomingGarbage,
  isSimulationState,
  requestSwap,
  setManualRaise,
  setPaused,
  simulationChecksum,
  stepSimulation,
} from '@swapduel/game-engine'
import { drawBoard } from '~/game/renderer/drawBoard'

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found' })
}

useHead({ title: 'Game laboratory · Swapduel' })

const seed = ref('lab-seed-01')
const state = shallowRef(createSimulation(seed.value))
const canvas = ref<HTMLCanvasElement | null>(null)
const selected = ref<{ row: number; column: number } | null>(null)
const jsonState = ref('')
const message = ref('Ready')
const reducedMotion = ref(false)
const {
  soundEnabled,
  unlockAudio,
  playSwap,
  playClear,
  playGarbageReceived,
  playDanger,
  toggleSound,
} = useGameAudio()

let animationFrame = 0
let previousTimestamp = 0
let accumulatorMs = 0
let lastAudioClearAt =
  state.value.lastClearEvent?.occurredAt ?? Number.NEGATIVE_INFINITY
let resizeObserver: ResizeObserver | null = null
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
let raiseTimer: ReturnType<typeof setTimeout> | null = null
let labAttackSequence = 1

const isPaused = computed(() => state.value.status === 'paused')
const checksum = computed(() => simulationChecksum(state.value))

function render(): void {
  if (canvas.value === null) return
  drawBoard(canvas.value, state.value, {
    selected: selected.value,
    reducedMotion: reducedMotion.value,
  })
}

function playSimulationSounds(): void {
  const clear = state.value.lastClearEvent
  if (clear !== null && clear.occurredAt > lastAudioClearAt) {
    lastAudioClearAt = clear.occurredAt
    playClear(clear.normalSize, clear.chainLevel)
  }
  if (state.value.dangerRemainingMs !== null) {
    playDanger()
  }
}

function animationLoop(timestamp: number): void {
  if (previousTimestamp === 0) previousTimestamp = timestamp
  const frameDelta = Math.min(100, timestamp - previousTimestamp)
  previousTimestamp = timestamp
  accumulatorMs += frameDelta

  while (accumulatorMs >= defaultGameConfig.timing.fixedStepMs) {
    state.value = stepSimulation(state.value)
    accumulatorMs -= defaultGameConfig.timing.fixedStepMs
  }

  playSimulationSounds()
  render()
  animationFrame = requestAnimationFrame(animationLoop)
}

function reset(): void {
  state.value = createSimulation(seed.value.trim() || 'lab-seed-01')
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  selected.value = null
  jsonState.value = ''
  message.value = `Reset with seed ${state.value.seed}`
  labAttackSequence = 1
}

function togglePause(): void {
  state.value = setPaused(state.value, !isPaused.value)
  message.value = isPaused.value ? 'Simulation paused' : 'Simulation running'
}

function advanceOneStep(): void {
  const wasPaused = isPaused.value
  let workingState = wasPaused
    ? { ...state.value, status: 'playing' as const }
    : state.value
  workingState = stepSimulation(workingState)
  state.value = wasPaused
    ? { ...workingState, status: 'paused' as const }
    : workingState
  playSimulationSounds()
  render()
}

function advancePhase(): void {
  const startingPhase = state.value.phase
  for (let step = 0; step < 120; step += 1) {
    advanceOneStep()
    if (state.value.phase !== startingPhase) break
  }
  message.value = `Advanced to ${state.value.phase}`
}

function forceCombo(): void {
  const cells = state.value.board.cells.map((row) =>
    row.map((panel) => (panel === null ? null : { ...panel })),
  )

  for (let column = 0; column < 4; column += 1) {
    const panel = cells[0]?.[column]
    if (panel !== null && panel !== undefined) {
      cells[0]![column] = {
        ...panel,
        type: 'circle',
        state: 'idle',
        animationStartedAt: null,
      }
    }
  }

  state.value = {
    ...state.value,
    board: { ...state.value.board, cells },
    status: 'playing',
    phase: 'idle',
    matchedPanelIds: [],
    pendingSwap: null,
    chain: null,
    garbage: [],
    incomingGarbage: [],
    garbageConversion: null,
    dangerRemainingMs: null,
    manualRaise: false,
    outgoingAttacks: [],
    lastClearEvent: null,
  }
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  message.value = 'Forced a four-panel match'
}

function forceShockMatch(): void {
  const panels = state.value.board.cells
    .flat()
    .filter((panel) => panel !== null)
    .slice(0, 3)
  if (panels.length < 3) {
    message.value = 'Reset the board before forcing a shock match'
    return
  }

  const layout = [
    [0, 0],
    [0, 1],
    [1, 1],
  ] as const
  const cells = Array.from(
    { length: state.value.board.visibleRows },
    () =>
      Array.from(
        { length: state.value.board.columns },
        () => null as (typeof panels)[number] | null,
      ),
  )

  for (const [index, [row, column]] of layout.entries()) {
    cells[row]![column] = {
      ...panels[index]!,
      type: 'shock',
      row,
      column,
      state: 'idle',
      offsetX: 0,
      offsetY: 0,
      chainEligible: false,
      chainId: null,
      animationStartedAt: null,
    }
  }

  state.value = {
    ...state.value,
    board: { ...state.value.board, cells },
    status: 'playing',
    phase: 'idle',
    matchedPanelIds: [],
    pendingSwap: null,
    chain: null,
    garbage: [],
    incomingGarbage: [],
    garbageConversion: null,
    dangerRemainingMs: null,
    manualRaise: false,
    outgoingAttacks: [],
    lastClearEvent: null,
  }
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  message.value = 'Forced a connected three-panel shock match'
}

function forceChain(): void {
  const panels = state.value.board.cells
    .flat()
    .filter((panel) => panel !== null)
    .slice(0, 6)
  if (panels.length < 6) {
    message.value = 'Reset the board before forcing a chain'
    return
  }

  const layout = [
    [0, 0, 'circle'],
    [0, 1, 'circle'],
    [0, 2, 'circle'],
    [1, 0, 'triangle'],
    [2, 1, 'triangle'],
    [3, 2, 'triangle'],
  ] as const
  const cells = Array.from(
    { length: state.value.board.visibleRows },
    () =>
      Array.from(
        { length: state.value.board.columns },
        () => null as (typeof panels)[number] | null,
      ),
  )

  for (const [index, [row, column, type]] of layout.entries()) {
    const panel = panels[index]!
    cells[row]![column] = {
      ...panel,
      type,
      row,
      column,
      state: 'idle',
      offsetX: 0,
      offsetY: 0,
      chainEligible: false,
      chainId: null,
      animationStartedAt: null,
    }
  }

  state.value = {
    ...state.value,
    board: { ...state.value.board, cells },
    status: 'playing',
    phase: 'idle',
    matchedPanelIds: [],
    pendingSwap: null,
    chain: null,
    garbage: [],
    incomingGarbage: [],
    garbageConversion: null,
    dangerRemainingMs: null,
    manualRaise: false,
    outgoingAttacks: [],
    lastClearEvent: null,
  }
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  message.value = 'Forced a two-step gravity chain'
}

function forceDanger(): void {
  const panel = state.value.board.cells
    .flat()
    .find((candidate) => candidate !== null)
  if (panel === null || panel === undefined) {
    message.value = 'Reset the board before forcing danger'
    return
  }

  const cells = Array.from(
    { length: state.value.board.visibleRows },
    () =>
      Array.from(
        { length: state.value.board.columns },
        () => null as typeof panel | null,
      ),
  )
  const row = state.value.board.visibleRows - 1
  cells[row]![0] = {
    ...panel,
    type: 'star',
    row,
    column: 0,
    state: 'idle',
    offsetX: 0,
    offsetY: 0,
    chainEligible: false,
    chainId: null,
    animationStartedAt: null,
  }

  state.value = {
    ...state.value,
    board: { ...state.value.board, cells },
    status: 'playing',
    phase: 'idle',
    matchedPanelIds: [],
    pendingSwap: null,
    chain: null,
    garbage: [],
    incomingGarbage: [],
    garbageConversion: null,
    dangerRemainingMs: null,
    manualRaise: false,
    outgoingAttacks: [],
    lastClearEvent: null,
  }
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  message.value = 'Forced danger at the top row'
}

function addGarbage(
  width: number,
  height: number,
  type: 'normal' | 'metal',
): void {
  const sequence = labAttackSequence
  labAttackSequence += 1
  state.value = enqueueIncomingGarbage(state.value, {
    attackId: `lab-${sequence}`,
    serverSequence: sequence,
    blocks: [{ width, height, type }],
  })
  playGarbageReceived()
  message.value = `Queued ${width}×${height} ${type} garbage`
}

function exportState(): void {
  jsonState.value = JSON.stringify(state.value, null, 2)
  message.value = 'Simulation JSON exported below'
}

function importState(): void {
  try {
    const parsed: unknown = JSON.parse(jsonState.value)
    if (!isSimulationState(parsed)) {
      throw new Error('Missing simulation fields')
    }
    state.value = parsed
    lastAudioClearAt =
      parsed.lastClearEvent?.occurredAt ?? Number.NEGATIVE_INFINITY
    seed.value = parsed.seed
    selected.value = null
    message.value = 'Simulation JSON loaded'
  } catch (error) {
    message.value =
      error instanceof Error ? `Could not load JSON: ${error.message}` : 'Could not load JSON'
  }
}

function boardCoordinate(
  event: PointerEvent,
): { row: number; column: number } | null {
  const target = canvas.value
  if (target === null) return null
  const bounds = target.getBoundingClientRect()
  const cellSize = bounds.width / state.value.board.columns
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  const column = Math.floor(x / cellSize)
  const row = Math.floor(
    (bounds.height - y) / cellSize - state.value.riseOffset,
  )

  if (
    row < 0 ||
    row >= state.value.board.visibleRows ||
    column < 0 ||
    column >= state.value.board.columns
  ) {
    return null
  }

  return { row, column }
}

function trySwap(row: number, column: number, direction: -1 | 1): boolean {
  const result = requestSwap(state.value, { row, column, direction })
  state.value = result.state
  message.value = result.ok ? 'Swap' : `Swap ignored: ${result.reason}`
  if (result.ok) {
    selected.value = null
    playSwap()
  }
  return result.ok
}

function onBoardPointerDown(event: PointerEvent): void {
  unlockAudio()
  if (activePointer !== null) return
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
    Math.abs(horizontal) < (bounds.width / state.value.board.columns) * 0.28
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
        message.value = `Selected row ${tapped.row}, column ${tapped.column}`
      }
    }
  }

  activePointer = null
}

function startRaise(event: PointerEvent): void {
  unlockAudio()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  raiseTimer = setTimeout(() => {
    state.value = setManualRaise(state.value, true)
    message.value = 'Manual raise active'
  }, 80)
}

function stopRaise(): void {
  if (raiseTimer !== null) {
    clearTimeout(raiseTimer)
    raiseTimer = null
  }
  state.value = setManualRaise(state.value, false)
}

onMounted(() => {
  reducedMotion.value = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches
  resizeObserver = new ResizeObserver(render)
  if (canvas.value !== null) resizeObserver.observe(canvas.value)
  animationFrame = requestAnimationFrame(animationLoop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  stopRaise()
})
</script>

<template>
  <main class="lab-shell">
    <header class="lab-header">
      <div>
        <p>Development tool</p>
        <h1>Board laboratory</h1>
      </div>
      <NuxtLink to="/" aria-label="Back to Swapduel home">Back</NuxtLink>
    </header>

    <section class="play-area" aria-label="Offline Swapduel board">
      <div class="status-row">
        <span>{{ state.phase }}</span>
        <span>{{ checksum }}</span>
        <span>{{ state.elapsedMs.toFixed(0) }} ms</span>
      </div>

      <canvas
        ref="canvas"
        class="board"
        aria-label="Interactive six column puzzle board"
        @pointerdown="onBoardPointerDown"
        @pointermove="onBoardPointerMove"
        @pointerup="onBoardPointerEnd"
        @pointercancel="onBoardPointerEnd"
      />

      <button
        class="raise"
        :disabled="state.status === 'lost' || state.dangerRemainingMs !== null"
        @pointerdown="startRaise"
        @pointerup="stopRaise"
        @pointercancel="stopRaise"
        @pointerleave="stopRaise"
      >
        Hold to raise
      </button>
    </section>

    <section class="controls" aria-label="Laboratory controls">
      <label class="seed-field">
        <span>Deterministic seed</span>
        <input v-model="seed" maxlength="80" @keyup.enter="reset">
      </label>

      <div class="button-grid">
        <button
          :aria-pressed="soundEnabled"
          :title="soundEnabled ? 'Mute game sounds' : 'Enable game sounds'"
          @click="toggleSound"
        >
          {{ soundEnabled ? 'Sound on' : 'Sound off' }}
        </button>
        <button @click="reset">Reset board</button>
        <button @click="togglePause">
          {{ isPaused ? 'Resume' : 'Pause' }}
        </button>
        <button @click="advanceOneStep">Step 1 frame</button>
        <button @click="advancePhase">Next phase</button>
        <button @click="forceCombo">Force 4 match</button>
        <button @click="forceShockMatch">Force shock match</button>
        <button @click="forceChain">Force ×2 chain</button>
        <button @click="forceDanger">Force danger</button>
        <button @click="addGarbage(3, 1, 'normal')">
          Add 1×3 garbage
        </button>
        <button @click="addGarbage(6, 2, 'normal')">
          Add 2×6 garbage
        </button>
        <button @click="addGarbage(6, 1, 'metal')">
          Add metal row
        </button>
        <button @click="exportState">Export JSON</button>
      </div>

      <details>
        <summary>Board JSON</summary>
        <textarea
          v-model="jsonState"
          rows="10"
          spellcheck="false"
          aria-label="Serialized simulation state"
        />
        <button class="import-button" @click="importState">Load JSON</button>
      </details>

      <dl class="metrics">
        <div>
          <dt>Cleared</dt>
          <dd>{{ state.totalCleared }}</dd>
        </div>
        <div>
          <dt>Last clear</dt>
          <dd>
            {{ state.lastClearSize }}
            <template v-if="state.lastClearEvent?.shockSize">
              · {{ state.lastClearEvent.shockSize }} shock
            </template>
          </dd>
        </div>
        <div>
          <dt>Rise</dt>
          <dd>{{ state.riseOffset.toFixed(3) }}</dd>
        </div>
        <div>
          <dt>Rise stop</dt>
          <dd>{{ state.stopTimeRemainingMs.toFixed(0) }} ms</dd>
        </div>
        <div>
          <dt>Chain</dt>
          <dd>
            {{
              state.chain === null
                ? '—'
                : `×${state.chain.level} ${state.chain.status}`
            }}
          </dd>
        </div>
        <div>
          <dt>Danger</dt>
          <dd>
            {{
              state.dangerRemainingMs === null
                ? 'safe'
                : `${state.dangerRemainingMs.toFixed(0)} ms`
            }}
          </dd>
        </div>
        <div>
          <dt>Garbage</dt>
          <dd>
            {{ state.garbage.length }} live ·
            {{ state.incomingGarbage.length }} queued
          </dd>
        </div>
        <div>
          <dt>Attacks</dt>
          <dd>
            {{
              state.outgoingAttacks.length === 0
                ? '—'
                : state.outgoingAttacks
                    .map((attack) => `#${attack.sequence} ${attack.kind}`)
                    .join(' · ')
            }}
          </dd>
        </div>
        <div>
          <dt>Next row</dt>
          <dd>{{ state.board.incomingRow.join(' · ') }}</dd>
        </div>
      </dl>

      <p class="live-message" aria-live="polite">{{ message }}</p>
    </section>
  </main>
</template>

<style scoped>
.lab-shell {
  width: min(100%, 980px);
  min-height: 100dvh;
  margin: 0 auto;
  padding:
    max(20px, env(safe-area-inset-top))
    max(16px, env(safe-area-inset-right))
    max(32px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
}

.lab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.lab-header p,
.lab-header h1 {
  margin: 0;
}

.lab-header p {
  color: #c99b82;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.lab-header h1 {
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(1.65rem, 7vw, 2.2rem);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.lab-header a {
  display: grid;
  min-width: 66px;
  min-height: 46px;
  place-items: center;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    0 3px 9px rgba(196, 120, 80, 0.16);
  color: #bc8e72;
  font-weight: 800;
  text-decoration: none;
}

.play-area {
  width: min(100%, 390px);
  margin: 0 auto;
  padding: 12px 12px 18px;
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 12px 34px rgba(120, 80, 50, 0.13);
}

.status-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0 6px 9px;
  color: #bc8e72;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.64rem;
  font-weight: 700;
  text-transform: uppercase;
}

.status-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 2;
  border: 3px solid #fff;
  border-radius: 24px;
  box-shadow:
    0 0 0 2px #f6c29a,
    0 10px 24px rgba(110, 86, 72, 0.16);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.raise {
  width: 100%;
  min-height: 60px;
  margin-top: 12px;
  border: 0;
  border-radius: 32px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.12),
    0 6px 0 #d95832,
    0 12px 18px rgba(217, 88, 50, 0.28);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1.08rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  touch-action: none;
  user-select: none;
}

.raise:active {
  transform: translateY(3px);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.45),
    inset 0 -3px 0 rgba(110, 86, 72, 0.1),
    0 3px 0 #d95832,
    0 7px 12px rgba(217, 88, 50, 0.22);
}

.raise:disabled {
  cursor: not-allowed;
  filter: saturate(0.45);
  opacity: 0.62;
}

.controls {
  margin: 22px auto 0;
  padding: 22px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 10px 30px rgba(120, 80, 50, 0.1);
}

.seed-field {
  display: grid;
  gap: 7px;
}

.seed-field span {
  color: #c99b82;
  font-size: 0.71rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

input,
textarea {
  width: 100%;
  border: 2px solid #f5e3d3;
  border-radius: 14px;
  outline: 0;
  background: #fffaf5;
  color: #6e5648;
}

input {
  min-height: 46px;
  padding: 0 14px;
  font-weight: 700;
}

input:focus,
textarea:focus {
  border-color: #ffb59a;
  box-shadow: 0 0 0 3px rgba(255, 181, 154, 0.2);
}

.button-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 9px;
  margin-top: 14px;
}

.button-grid button,
.import-button {
  border: 1px solid #f3dfcf;
  border-radius: 22px;
  background: #fff8f0;
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.9),
    0 3px 7px rgba(110, 86, 72, 0.09);
  color: #7a6557;
  font-family: "Fredoka", sans-serif;
  font-size: 0.78rem;
  font-weight: 500;
}

.button-grid button:active,
.import-button:active {
  background: #ffead6;
  transform: translateY(1px);
}

details {
  margin-top: 16px;
  border-top: 1px solid #f5ebe2;
}

summary {
  min-height: 44px;
  padding-top: 13px;
  color: #bc8e72;
  cursor: pointer;
  font-weight: 800;
}

textarea {
  padding: 12px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}

.import-button {
  width: 100%;
  margin-top: 7px;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 9px;
}

.metrics div {
  min-width: 0;
  padding: 11px;
  border-radius: 15px;
  background: #fff4e8;
}

.metrics div:nth-last-child(-n + 2) {
  grid-column: 1 / -1;
}

.metrics dt {
  color: #c99b82;
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.metrics dd {
  margin: 3px 0 0;
  overflow: hidden;
  color: #6e5648;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.73rem;
  font-weight: 700;
  text-overflow: ellipsis;
}

.live-message {
  min-height: 1.4em;
  margin: 8px 0 0;
  color: #bc8e72;
  font-size: 0.75rem;
  font-weight: 800;
}

@media (min-width: 760px) {
  .lab-shell {
    display: grid;
    grid-template-columns: minmax(320px, 390px) 1fr;
    gap: 28px;
    align-content: start;
    padding-top: 32px;
  }

  .lab-header {
    grid-column: 1 / -1;
  }

  .play-area,
  .controls {
    width: 100%;
    margin-top: 0;
  }

  .controls {
    align-self: start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .raise:active {
    transform: none;
  }
}
</style>
