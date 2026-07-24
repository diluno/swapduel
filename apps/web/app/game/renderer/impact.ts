import type { SimulationState } from '@swapduel/game-engine'

// Landing feedback is a presentation concern: the engine already tells us a
// garbage block went from `falling` to `idle`, so the tracker just watches for
// that edge and hands the renderer a decaying shake plus per-block squash
// timestamps. Nothing here feeds back into the simulation, so it stays out of
// snapshots and checksums.

export const SQUASH_DURATION_MS = 240
const SHAKE_DURATION_MS = 320
const LANDING_MEMORY_MS = 1_000
/** Rows of clear space left above the stack when panic starts creeping in. */
const PANIC_HEADROOM_ROWS = 2

export interface LandingEvent {
  /** Number of garbage cells that touched down on this step. */
  cells: number
  /** Widest block in the landing, in columns. */
  width: number
}

export interface PanelFall {
  /** How many cells the panel dropped. */
  distance: number
  /** Simulation time the engine put it in its landing cell. */
  landedAt: number
}

export interface ImpactState {
  /** Block id → simulation time the block landed at. */
  landings: Map<number, number>
  /** Panel id → the drop it is still animating through. */
  panelFalls: Map<number, PanelFall>
  shakeStartedAt: number
  /** 0..1, how hard the last landing hit. */
  shakeStrength: number
}

export interface ImpactTracker {
  readonly state: ImpactState
  /** Returns the landing that happened since the last call, if any. */
  observe: (state: SimulationState) => LandingEvent | null
  reset: () => void
}

export function createImpactTracker(): ImpactTracker {
  const previousStates = new Map<number, string>()
  const previousPanelRows = new Map<number, number>()
  const state: ImpactState = {
    landings: new Map(),
    panelFalls: new Map(),
    shakeStartedAt: Number.NEGATIVE_INFINITY,
    shakeStrength: 0,
  }

  function reset(): void {
    previousStates.clear()
    previousPanelRows.clear()
    state.landings.clear()
    state.panelFalls.clear()
    state.shakeStartedAt = Number.NEGATIVE_INFINITY
    state.shakeStrength = 0
  }

  // Gravity teleports a panel straight into its landing cell and clears its
  // offset, so the drop has to be reconstructed here: a row that decreased
  // between two observations is a panel that fell that far.
  function observePanels(simulation: SimulationState): void {
    const live = new Set<number>()

    for (const row of simulation.board.cells) {
      for (const panel of row) {
        if (panel === null) continue
        live.add(panel.id)
        const previousRow = previousPanelRows.get(panel.id)
        previousPanelRows.set(panel.id, panel.row)
        if (previousRow === undefined || panel.row >= previousRow) continue
        state.panelFalls.set(panel.id, {
          distance: previousRow - panel.row,
          landedAt: simulation.elapsedMs,
        })
      }
    }

    for (const id of previousPanelRows.keys()) {
      if (!live.has(id)) previousPanelRows.delete(id)
    }
    for (const [id, fall] of state.panelFalls) {
      const age = simulation.elapsedMs - fall.landedAt
      if (!live.has(id) || age > panelFallDurationMs(fall.distance) + SQUASH_DURATION_MS) {
        state.panelFalls.delete(id)
      }
    }
  }

  function observe(simulation: SimulationState): LandingEvent | null {
    observePanels(simulation)
    let cells = 0
    let width = 0
    const live = new Set<number>()

    for (const block of simulation.garbage) {
      live.add(block.id)
      const previous = previousStates.get(block.id)
      previousStates.set(block.id, block.state)
      if (previous !== 'falling' || block.state !== 'idle') continue
      cells += block.width * block.height
      width = Math.max(width, block.width)
      state.landings.set(block.id, simulation.elapsedMs)
    }

    for (const id of previousStates.keys()) {
      if (!live.has(id)) previousStates.delete(id)
    }
    for (const [id, landedAt] of state.landings) {
      if (!live.has(id) || simulation.elapsedMs - landedAt > LANDING_MEMORY_MS) {
        state.landings.delete(id)
      }
    }

    if (cells === 0) return null

    // A full-width slab is 6 cells per row, so this saturates around a
    // two-row-tall attack — big enough to shake the board hard, not so big
    // that a one-row drop feels weightless.
    const strength = Math.min(1, 0.4 + cells / 14)
    if (
      strength >= state.shakeStrength ||
      simulation.elapsedMs - state.shakeStartedAt > SHAKE_DURATION_MS
    ) {
      state.shakeStrength = strength
    }
    state.shakeStartedAt = simulation.elapsedMs
    return { cells, width }
  }

  return { state, observe, reset }
}

/**
 * A one-cell drop is a quick tap; longer drops take more time but not
 * proportionally more, so tall collapses still feel snappy.
 */
export function panelFallDurationMs(distance: number): number {
  return Math.min(190, 66 * Math.sqrt(Math.max(1, distance)))
}

/**
 * Where a falling panel should be drawn and how squashed it is, in cell units,
 * for a panel the engine has already placed in its landing cell.
 */
export function panelFallVisual(
  fall: PanelFall,
  elapsedMs: number,
): { riseCells: number; squash: number } {
  const age = elapsedMs - fall.landedAt
  const duration = panelFallDurationMs(fall.distance)

  if (age < 0) return { riseCells: fall.distance, squash: 0 }
  if (age < duration) {
    // Accelerating fall: covers little ground early, arrives fast.
    const progress = age / duration
    return { riseCells: fall.distance * (1 - progress ** 2), squash: 0 }
  }

  const settleAge = age - duration
  if (settleAge >= SQUASH_DURATION_MS) return { riseCells: 0, squash: 0 }
  const settle = settleAge / SQUASH_DURATION_MS
  // One compression on impact that springs back out, scaled by drop height.
  const weight = Math.min(1, 0.5 + fall.distance * 0.18)
  return {
    riseCells: 0,
    squash: Math.sin(settle * Math.PI) * (1 - settle) * 0.3 * weight,
  }
}

/**
 * Decaying shake offset in cell units, sampled at the current simulation time.
 */
export function shakeOffset(
  impact: ImpactState,
  elapsedMs: number,
): { x: number; y: number } {
  const age = elapsedMs - impact.shakeStartedAt
  if (age < 0 || age >= SHAKE_DURATION_MS) return { x: 0, y: 0 }
  const decay = (1 - age / SHAKE_DURATION_MS) ** 2
  const amplitude = 0.16 * impact.shakeStrength * decay
  return {
    x: Math.sin(age * 0.085) * amplitude * 0.55,
    y: Math.sin(age * 0.062) * amplitude,
  }
}

/**
 * 0 (settled) → 1 (topped out), driven by how close the stack is to the top.
 * Danger pins it at 1 so the countdown always plays at full panic.
 */
export function panicIntensity(simulation: SimulationState): number {
  if (simulation.status !== 'playing') return 0
  if (simulation.dangerRemainingMs !== null) return 1

  const { board } = simulation
  let highest = -1
  for (let row = board.visibleRows - 1; row >= 0; row -= 1) {
    if (board.cells[row]!.some((panel) => panel !== null)) {
      highest = row
      break
    }
  }
  for (const block of simulation.garbage) {
    if (block.state === 'falling') continue
    highest = Math.max(highest, block.row + block.height - 1)
  }
  if (highest < 0) return 0

  // Panic only starts with two rows of headroom left and ramps to full as the
  // top row fills. Anything earlier fires during ordinary play — a stack two
  // thirds up the well is a working stack, not a scare.
  const rowsFilled = highest + 1 + simulation.riseOffset
  const headroom = board.visibleRows - rowsFilled
  return Math.max(
    0,
    Math.min(1, (PANIC_HEADROOM_ROWS - headroom) / PANIC_HEADROOM_ROWS),
  )
}
