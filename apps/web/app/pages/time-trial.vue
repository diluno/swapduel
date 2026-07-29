<script setup lang="ts">
import {
  createSimulation,
  defaultGameConfig,
  requestSwap,
  setManualRaise,
  setPaused,
  stepSimulation,
  timeTrialDurationMs,
} from '@swapduel/game-engine'
import { drawBoard } from '~/game/renderer/drawBoard'
import { createImpactTracker, panicIntensity } from '~/game/renderer/impact'

const RENDER_INTERVAL_MS = 30
const UI_UPDATE_INTERVAL_MS = 100
/** Below this the clock switches to tenths and turns urgent. */
const FINAL_STRETCH_MS = 10_000

useHead({
  title: 'Time trial · Swapduel',
  meta: [
    {
      name: 'description',
      content: 'Two minutes, one board, and a leaderboard to climb.',
    },
  ],
})

const canvas = ref<HTMLCanvasElement | null>(null)
const selected = ref<{ row: number; column: number } | null>(null)
const reducedMotion = ref(false)
const runPhase = ref<'ready' | 'running' | 'paused' | 'finished'>('ready')
const playerName = ref('')
const submitted = ref(false)
const { readPlayerName, rememberPlayerName } = usePlayerName()
const {
  entries: leaderboardEntries,
  loading: leaderboardLoading,
  submitting,
  errorMessage: leaderboardError,
  submittedRank,
  submittedEntryId,
  load: loadLeaderboard,
  submit: submitScore,
  resetSubmission,
} = useLeaderboard()
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

// As in the endless mode: the simulation is a plain value stepped at a fixed
// rate, with `state` a throttled mirror for the readouts.
let simulationState = createRun()
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

const remainingMs = computed(() =>
  Math.max(0, timeTrialDurationMs - state.value.elapsedMs),
)
const finalStretch = computed(
  () => runPhase.value === 'running' && remainingMs.value <= FINAL_STRETCH_MS,
)
const remainingLabel = computed(() => {
  const remaining = remainingMs.value
  if (remaining < FINAL_STRETCH_MS) return (remaining / 1000).toFixed(1)
  const totalSeconds = Math.ceil(remaining / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
})
const ranOutOfTime = computed(() => state.value.endReason === 'time-up')
const survivedLabel = computed(() => {
  const totalSeconds = Math.floor(state.value.elapsedMs / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
})
const canSubmit = computed(
  () =>
    !submitted.value &&
    !submitting.value &&
    playerName.value.trim().length > 0 &&
    state.value.score > 0,
)

function createRunSeed(): string {
  return `trial-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1_000_000,
  ).toString(36)}`
}

// The board is dealt up front so the player can read it while the clock is
// still stopped; the run only starts on their tap.
function createRun() {
  return setPaused(
    createSimulation(createRunSeed(), defaultGameConfig, {
      timeLimitMs: timeTrialDurationMs,
    }),
    true,
  )
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
  if (animationFrame === 0 && runPhase.value === 'running') startLoop()
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
  if (
    simulationState.status === 'playing' &&
    simulationState.dangerRemainingMs !== null
  ) {
    playDanger()
  }
}

function finishRun(): void {
  if (resultReported) return
  resultReported = true
  stopRaise()
  runPhase.value = 'finished'
  playRoundResult(simulationState.endReason === 'time-up' ? 'win' : 'loss')
  void loadLeaderboard()
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

  // The clock is the whole point of this mode, so it refreshes every frame in
  // the final stretch where tenths are on show.
  const uiInterval =
    timeTrialDurationMs - simulationState.elapsedMs <= FINAL_STRETCH_MS
      ? 0
      : UI_UPDATE_INTERVAL_MS
  if (
    lastUiUpdateAt === 0 ||
    timestamp - lastUiUpdateAt >= uiInterval ||
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
  unlockAudio()
  stopLoop()
  simulationState = setPaused(createRun(), false)
  state.value = simulationState
  impactTracker.reset()
  resetBoardPointer()
  resetSubmission()
  lastAudioClearAt = Number.NEGATIVE_INFINITY
  lastRenderAt = 0
  lastUiUpdateAt = 0
  resultReported = false
  submitted.value = false
  runPhase.value = 'running'
  renderRequested = true
  startLoop()
}

async function submitRun(): Promise<void> {
  const displayName = playerName.value.trim()
  if (displayName.length === 0) return
  rememberPlayerName(displayName)
  const ok = await submitScore({
    displayName,
    score: simulationState.score,
    totalCleared: simulationState.totalCleared,
    durationMs: simulationState.elapsedMs,
    seed: simulationState.seed,
  })
  if (ok) submitted.value = true
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

// A backgrounded tab suspends its animation frames, so the clock would either
// freeze mid-run or jump on return. Neither is a fair attempt, so the run
// pauses and waits to be picked back up deliberately.
function handleVisibilityChange(): void {
  if (!document.hidden || runPhase.value !== 'running') return
  stopRaise()
  stopLoop()
  simulationState = setPaused(simulationState, true)
  state.value = simulationState
  runPhase.value = 'paused'
  renderRequested = true
  render()
}

function resumeRun(): void {
  unlockAudio()
  simulationState = setPaused(simulationState, false)
  state.value = simulationState
  runPhase.value = 'running'
  renderRequested = true
  startLoop()
}

onMounted(() => {
  reducedMotion.value = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches
  playerName.value = readPlayerName()
  resizeObserver = new ResizeObserver(() => requestRender())
  if (canvas.value !== null) resizeObserver.observe(canvas.value)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  render()
  void loadLeaderboard()
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
          <small>Panels</small>
          <strong>{{ state.totalCleared }}</strong>
        </div>
        <div
          class="stat stat--right stat--clock"
          :class="{ 'stat--urgent': finalStretch }"
        >
          <small>Time left</small>
          <strong aria-live="off">{{ remainingLabel }}</strong>
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

        <div v-if="runPhase === 'ready'" class="overlay">
          <p>Two minutes</p>
          <h2>Time trial</h2>
          <p class="overlay-note">
            Score as much as you can before the clock runs out. Topping out
            ends the attempt early.
          </p>
          <button type="button" @click="startRun">
            <Icon name="solar:play-bold" />
            Start run
          </button>
        </div>

        <div v-else-if="runPhase === 'paused'" class="overlay">
          <p>{{ remainingLabel }} left</p>
          <h2>Paused</h2>
          <p class="overlay-note">
            The clock stopped when the tab lost focus.
          </p>
          <button type="button" @click="resumeRun">
            <Icon name="solar:play-bold" />
            Resume run
          </button>
        </div>

        <div v-else-if="runPhase === 'finished'" class="overlay overlay--result">
          <p>{{ ranOutOfTime ? "Time's up" : `Topped out at ${survivedLabel}` }}</p>
          <h2>{{ state.score.toLocaleString() }}</h2>
          <div class="result-meta">
            <span>{{ state.totalCleared }} panels</span>
            <span v-if="submittedRank !== null">Rank #{{ submittedRank }}</span>
          </div>

          <form v-if="!submitted" class="submit-form" @submit.prevent="submitRun">
            <label>
              <span>Name for the leaderboard</span>
              <input
                v-model="playerName"
                name="displayName"
                maxlength="20"
                autocomplete="nickname"
                required
              >
            </label>
            <button class="submit" type="submit" :disabled="!canSubmit">
              <Icon name="solar:medal-ribbons-star-bold" />
              {{ submitting ? 'Submitting…' : 'Submit score' }}
            </button>
          </form>
          <p v-else class="submitted-note">
            <Icon name="solar:check-circle-bold" />
            {{
              submittedRank === null
                ? 'Submitted — not quite a top score this time.'
                : `Submitted at rank #${submittedRank}.`
            }}
          </p>
          <p v-if="leaderboardError" class="form-message" role="alert">
            {{ leaderboardError }}
          </p>

          <ol v-if="leaderboardEntries.length > 0" class="leaderboard">
            <li
              v-for="(entry, index) in leaderboardEntries"
              :key="entry.entryId"
              :class="{ mine: entry.entryId === submittedEntryId }"
            >
              <span class="rank">{{ index + 1 }}</span>
              <span class="name">{{ entry.displayName }}</span>
              <span class="points">{{ entry.score.toLocaleString() }}</span>
            </li>
          </ol>
          <p v-else-if="leaderboardLoading" class="leaderboard-note">
            Loading the leaderboard…
          </p>

          <div class="overlay-actions">
            <button type="button" @click="startRun">
              <Icon name="solar:restart-bold" />
              Run again
            </button>
            <NuxtLink to="/">
              <Icon name="solar:home-smile-bold" />
              Back to menu
            </NuxtLink>
          </div>
        </div>
      </div>

      <div class="game-controls">
        <button
          class="raise"
          type="button"
          :disabled="runPhase !== 'running'"
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

/* The clock keeps a fixed width so switching from 0:12 to tenths does not
   shuffle the rest of the bar around. */
.stat--clock strong {
  min-width: 3.2ch;
  text-align: right;
}

.stat--urgent strong {
  color: #d95832;
}

.stat--urgent small {
  color: #d95832;
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

.overlay {
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

.overlay--result {
  justify-content: flex-start;
  overflow-y: auto;
}

.overlay p {
  margin: 0;
  color: #d95832;
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.overlay h2 {
  margin: 0;
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: 2.4rem;
  font-variant-numeric: tabular-nums;
}

/* Outranks the uppercase eyebrow styling that `.overlay p` sets. */
.overlay .overlay-note {
  max-width: 17rem;
  color: #a5806a;
  font-size: 0.82rem;
  letter-spacing: 0;
  text-transform: none;
}

.result-meta {
  display: flex;
  gap: 14px;
  margin-bottom: 6px;
  color: #a5806a;
  font-size: 0.82rem;
}

.overlay button {
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

.overlay button:disabled {
  cursor: not-allowed;
  filter: saturate(0.5);
  opacity: 0.6;
}

.overlay a {
  color: #b08a72;
  font-size: 0.86rem;
}

.submit-form {
  display: grid;
  gap: 6px;
  width: min(100%, 17rem);
  text-align: left;
}

.submit-form label span {
  color: #c99b82;
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.submit-form input {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 2px solid #f5e3d3;
  border-radius: 14px;
  outline: 0;
  background: #fffaf5;
  color: #6e5648;
  font-size: 0.95rem;
  font-weight: 700;
}

.submit-form input:focus {
  border-color: #ffb59a;
  box-shadow: 0 0 0 3px rgba(255, 181, 154, 0.2);
}

.overlay .submitted-note {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #3fba87;
  letter-spacing: 0;
  text-transform: none;
}

.overlay .form-message {
  color: #f0606c;
  font-size: 0.8rem;
  letter-spacing: 0;
  text-transform: none;
}

.leaderboard {
  display: grid;
  gap: 2px;
  width: min(100%, 19rem);
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.leaderboard li {
  display: grid;
  grid-template-columns: 1.6rem minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 5px 10px;
  border-radius: 12px;
  color: #7a6557;
  font-size: 0.84rem;
  text-align: left;
}

.leaderboard li:nth-child(odd) {
  background: rgba(255, 255, 255, 0.7);
}

.leaderboard li.mine {
  background: #ffe3d1;
  color: #d95832;
  font-weight: 800;
}

.leaderboard .rank {
  color: #c99b82;
  font-variant-numeric: tabular-nums;
}

.leaderboard .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leaderboard .points {
  font-family: "Fredoka", sans-serif;
  font-variant-numeric: tabular-nums;
}

.overlay .leaderboard-note {
  color: #a5806a;
  font-size: 0.8rem;
  letter-spacing: 0;
  text-transform: none;
}

.overlay-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  margin-top: 12px;
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
