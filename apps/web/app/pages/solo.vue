<script setup lang="ts">
import {
  createSimulation,
  defaultGameConfig,
  requestSwap,
  setManualRaise,
  stepSimulation,
} from '@swapduel/game-engine'
import { drawBoard } from '~/game/renderer/drawBoard'
import { createImpactTracker, panicIntensity } from '~/game/renderer/impact'

const SOLO_BEST_KEY = 'swapduel:solo-best'
const RENDER_INTERVAL_MS = 30
const UI_UPDATE_INTERVAL_MS = 100

useHead({
  title: 'Endless · Swapduel',
  meta: [
    {
      name: 'description',
      content: 'Chain panels for score until the stack tops out.',
    },
  ],
})

const canvas = ref<HTMLCanvasElement | null>(null)
const selected = ref<{ row: number; column: number } | null>(null)
const reducedMotion = ref(false)
const bestScore = ref(0)
const isNewBest = ref(false)
const {
  soundEnabled,
  unlockAudio,
  playSwap,
  playClear,
  playGarbageLanded,
  playPanic,
  playDanger,
  playRoundResult,
  toggleSound,
} = useGameAudio()

// The simulation is a plain value stepped at a fixed rate; `state` is a
// throttled mirror for the score readout so the template is not re-rendered
// sixty times a second for a number that changes on clears.
let simulationState = createSimulation(createRunSeed())
const state = shallowRef(simulationState)

const impactTracker = createImpactTracker()
let animationFrame = 0
let previousTimestamp = 0
let accumulatorMs = 0
let lastRenderAt = 0
let lastUiUpdateAt = 0
let renderRequested = true
let lastAudioClearAt = Number.NEGATIVE_INFINITY
let raiseTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let resultReported = false

const isOver = computed(() => state.value.status === 'lost')
const elapsedLabel = computed(() => {
  const totalSeconds = Math.floor(state.value.elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
})

function createRunSeed(): string {
  return `solo-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1_000_000,
  ).toString(36)}`
}

function trySwap(row: number, column: number, direction: -1 | 1): boolean {
  if (simulationState.status !== 'playing') return false
  const result = requestSwap(simulationState, { row, column, direction })
  simulationState = result.state
  if (result.ok) {
    selected.value = null
    playSwap()
    requestRender()
  }
  return result.ok
}

const {
  onPointerDown: onBoardPointerDown,
  onPointerMove: onBoardPointerMove,
  onPointerEnd: onBoardPointerEnd,
  reset: resetBoardPointer,
} = useBoardPointer({
  canvas: () => canvas.value,
  state: () => simulationState,
  isLive: () => simulationState.status === 'playing',
  swap: trySwap,
  selected,
  onPress: () => {
    unlockAudio()
    hideCursor()
  },
  onSelect: () => requestRender(),
})

const { cursor, cursorVisible, hideCursor } = useBoardCursor({
  columns: () => simulationState.board.columns,
  visibleRows: () => simulationState.board.visibleRows,
  isLive: () => simulationState.status === 'playing',
  swap: (row, column, direction) => trySwap(row, column, direction),
  setRaise: (raising) => {
    if (raising && simulationState.status !== 'playing') return
    simulationState = setManualRaise(simulationState, raising)
  },
  onChange: () => {
    selected.value = null
    requestRender()
  },
})

function render(): void {
  if (canvas.value === null) return
  drawBoard(canvas.value, simulationState, {
    selected: selected.value,
    cursor: cursorVisible.value ? cursor.value : null,
    reducedMotion: reducedMotion.value,
    impact: impactTracker.state,
    panic: panicIntensity(simulationState),
  })
}

function requestRender(): void {
  renderRequested = true
  if (animationFrame === 0 && !isOver.value) startLoop()
}

function playSimulationSounds(): void {
  const clear = simulationState.lastClearEvent
  if (clear !== null && clear.occurredAt > lastAudioClearAt) {
    lastAudioClearAt = clear.occurredAt
    playClear(clear.normalSize, clear.chainLevel, clear.size)
  }
  const landing = impactTracker.observe(simulationState)
  if (landing !== null) {
    playGarbageLanded(landing.cells)
    requestRender()
  }
  playPanic(panicIntensity(simulationState))
  if (simulationState.dangerRemainingMs !== null) playDanger()
}

function loadBestScore(): number {
  try {
    const stored = Number(localStorage.getItem(SOLO_BEST_KEY))
    return Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : 0
  } catch {
    return 0
  }
}

function finishRun(): void {
  if (resultReported) return
  resultReported = true
  stopRaise()
  isNewBest.value = simulationState.score > bestScore.value
  if (isNewBest.value) {
    bestScore.value = simulationState.score
    try {
      localStorage.setItem(SOLO_BEST_KEY, String(simulationState.score))
    } catch {
      // A blocked storage write only costs the record, not the run.
    }
  }
  playRoundResult(isNewBest.value ? 'win' : 'loss')
}

function animationLoop(timestamp: number): void {
  animationFrame = 0
  if (previousTimestamp === 0) previousTimestamp = timestamp
  const frameDelta = Math.min(100, timestamp - previousTimestamp)
  previousTimestamp = timestamp

  const wasPlaying = simulationState.status === 'playing'
  if (wasPlaying) {
    accumulatorMs += frameDelta
    while (accumulatorMs >= defaultGameConfig.timing.fixedStepMs) {
      simulationState = stepSimulation(simulationState)
      accumulatorMs -= defaultGameConfig.timing.fixedStepMs
    }
    playSimulationSounds()
  }

  const stillPlaying = simulationState.status === 'playing'
  if (wasPlaying && !stillPlaying) renderRequested = true

  if (
    lastUiUpdateAt === 0 ||
    timestamp - lastUiUpdateAt >= UI_UPDATE_INTERVAL_MS ||
    !stillPlaying
  ) {
    lastUiUpdateAt = timestamp
    state.value = simulationState
  }

  if (
    renderRequested ||
    (stillPlaying &&
      (lastRenderAt === 0 || timestamp - lastRenderAt >= RENDER_INTERVAL_MS))
  ) {
    render()
    renderRequested = false
    lastRenderAt = timestamp
  }

  if (stillPlaying) {
    animationFrame = requestAnimationFrame(animationLoop)
    return
  }
  finishRun()
}

function startLoop(): void {
  if (animationFrame !== 0) return
  previousTimestamp = 0
  animationFrame = requestAnimationFrame(animationLoop)
}

function stopLoop(): void {
  if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
  animationFrame = 0
  previousTimestamp = 0
  accumulatorMs = 0
}

function startRun(): void {
  stopLoop()
  simulationState = createSimulation(createRunSeed())
  state.value = simulationState
  impactTracker.reset()
  resetBoardPointer()
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  lastRenderAt = 0
  lastUiUpdateAt = 0
  resultReported = false
  isNewBest.value = false
  renderRequested = true
  startLoop()
}

function startRaise(event: PointerEvent): void {
  unlockAudio()
  if (simulationState.status !== 'playing') return
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

// Backgrounding the tab must not run the stack up while nobody is looking.
function handleVisibilityChange(): void {
  if (document.hidden) {
    stopRaise()
    stopLoop()
    return
  }
  if (simulationState.status === 'playing') startLoop()
}

onMounted(() => {
  reducedMotion.value = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches
  bestScore.value = loadBestScore()
  resizeObserver = new ResizeObserver(() => requestRender())
  if (canvas.value !== null) resizeObserver.observe(canvas.value)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  stopRaise()
  resizeObserver?.disconnect()
  resizeObserver = null
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <main class="game-shell">
    <section class="game-layout">
      <header class="scorebar">
        <NuxtLink class="exit" to="/" aria-label="Back to menu">
          <Icon name="solar:alt-arrow-left-bold" />
        </NuxtLink>
        <div class="stat">
          <small>Score</small>
          <strong>{{ state.score.toLocaleString() }}</strong>
        </div>
        <div class="stat stat--center">
          <small>Time</small>
          <strong>{{ elapsedLabel }}</strong>
        </div>
        <div class="stat stat--right">
          <small>Best</small>
          <strong>{{ bestScore.toLocaleString() }}</strong>
        </div>
      </header>

      <div class="board-area">
        <canvas
          ref="canvas"
          class="board"
          aria-label="Your interactive six-column puzzle board"
          @pointerdown="onBoardPointerDown"
          @pointermove="onBoardPointerMove"
          @pointerup="onBoardPointerEnd"
          @pointercancel="onBoardPointerEnd"
        />

        <div v-if="isOver" class="result-overlay">
          <p>{{ isNewBest ? 'New personal best' : 'Topped out' }}</p>
          <h2>{{ state.score.toLocaleString() }}</h2>
          <div class="result-meta">
            <span>{{ state.totalCleared }} panels</span>
            <span>{{ elapsedLabel }}</span>
          </div>
          <button type="button" @click="startRun">
            <Icon name="solar:restart-bold" />
            Play again
          </button>
          <NuxtLink to="/">
            <Icon name="solar:home-smile-bold" />
            Back to menu
          </NuxtLink>
        </div>
      </div>

      <div class="game-controls">
        <button
          class="raise"
          type="button"
          :disabled="isOver"
          @pointerdown="startRaise"
          @pointerup="stopRaise"
          @pointercancel="stopRaise"
          @pointerleave="stopRaise"
        >
          <Icon name="solar:double-alt-arrow-up-bold" />
          Hold to raise
        </button>
        <button
          class="sound-toggle"
          type="button"
          :aria-label="soundEnabled ? 'Mute game sounds' : 'Enable game sounds'"
          :aria-pressed="soundEnabled"
          @click="toggleSound"
        >
          <Icon v-if="soundEnabled" name="solar:volume-loud-bold" />
          <Icon v-else name="solar:muted-bold" />
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.game-shell {
  height: 100dvh;
  /* Holding the raise button on iOS otherwise long-presses into a text
     selection and the callout menu, which fights the hold gesture. */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
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
  width: min(100%, 420px);
  height: 100%;
  margin: 0 auto;
}

.scorebar {
  display: grid;
  grid-template-columns: auto repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(110, 86, 72, 0.12);
}

.exit {
  display: flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border-radius: 17px;
  background: #fff4e8;
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.9),
    0 3px 7px rgba(110, 86, 72, 0.09);
  color: #b08a72;
  font-size: 1.05rem;
  line-height: 1;
  text-decoration: none;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.stat--center {
  align-items: center;
}

.stat--right {
  align-items: flex-end;
}

.stat small {
  color: #b08a72;
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stat strong {
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: 1.05rem;
  font-variant-numeric: tabular-nums;
}

.board-area {
  position: relative;
  display: flex;
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

.result-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 18px;
  border-radius: 24px;
  background: rgba(255, 244, 232, 0.94);
  text-align: center;
}

.result-overlay p {
  margin: 0;
  color: #d95832;
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.result-overlay h2 {
  margin: 0;
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: 2.4rem;
  font-variant-numeric: tabular-nums;
}

.result-meta {
  display: flex;
  gap: 14px;
  margin-bottom: 10px;
  color: #a5806a;
  font-size: 0.82rem;
}

.result-overlay button {
  min-height: 46px;
  padding: 0 26px;
  border: 0;
  border-radius: 23px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow: 0 4px 0 #d95832;
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1rem;
}

.result-overlay a {
  color: #b08a72;
  font-size: 0.86rem;
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
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.raise:disabled {
  filter: saturate(0.5);
  opacity: 0.6;
}

.sound-toggle {
  min-height: 58px;
  border: 0;
  border-radius: 29px;
  background: #fff;
  box-shadow: 0 4px 0 #f0d3bd;
  color: #d95832;
  font-size: 1.2rem;
}
</style>
