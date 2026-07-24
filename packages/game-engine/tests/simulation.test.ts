import { describe, expect, it } from 'vitest'
import {
  advanceSimulation,
  clearPhaseDurationMs,
  createSimulation,
  defaultGameConfig,
  requestSwap,
  setManualRaise,
  simulationChecksum,
  stepSimulation,
} from '../src'
import { boardWith } from './helpers'

describe('swapping', () => {
  it('swaps two adjacent panels after the configured animation time', () => {
    const initial = createSimulation('swap-panels')
    const leftType = initial.board.cells[0]![0]!.type
    const rightType = initial.board.cells[0]![1]!.type
    const requested = requestSwap(initial, {
      row: 0,
      column: 0,
      direction: 1,
    })

    expect(requested.ok).toBe(true)
    const completed = advanceSimulation(
      requested.state,
      defaultGameConfig.timing.swapDurationMs,
    )

    expect(completed.board.cells[0]![0]!.type).toBe(rightType)
    expect(completed.board.cells[0]![1]!.type).toBe(leftType)
  })

  it('swaps a panel into an adjacent empty cell', () => {
    const initial = createSimulation('swap-empty')
    const board = boardWith([[0, 0, 'circle']])
    const state = { ...initial, board }
    const requested = requestSwap(state, {
      row: 0,
      column: 0,
      direction: 1,
    })
    const completed = advanceSimulation(
      requested.state,
      defaultGameConfig.timing.swapDurationMs,
    )

    expect(completed.board.cells[0]![0]).toBeNull()
    expect(completed.board.cells[0]![1]?.type).toBe('circle')
  })

  it('applies gravity after swapping an unsupported panel into empty space', () => {
    const initial = createSimulation('swap-empty-fall')
    const board = boardWith([[2, 0, 'circle']])
    const state = { ...initial, board }
    const requested = requestSwap(state, {
      row: 2,
      column: 0,
      direction: 1,
    })
    const completed = advanceSimulation(requested.state, 250)

    expect(completed.board.cells[2]![1]).toBeNull()
    expect(completed.board.cells[0]![1]?.type).toBe('circle')
    expect(completed.phase).toBe('idle')
  })

  it('rejects swaps outside the board and between two empty cells', () => {
    const initial = createSimulation('invalid-swaps')
    const emptyState = { ...initial, board: boardWith([]) }

    expect(
      requestSwap(initial, { row: 0, column: 0, direction: -1 }),
    ).toMatchObject({ ok: false, reason: 'outside-board' })
    expect(
      requestSwap(emptyState, { row: 0, column: 0, direction: 1 }),
    ).toMatchObject({ ok: false, reason: 'both-empty' })
  })
})

describe('fixed-step resolution', () => {
  it('flashes, clears, and resolves gravity', () => {
    const initial = createSimulation('clear')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [2, 0, 'heart'],
      ]),
    }
    // Flash, then one pop per panel, then the fall delay and gravity.
    const resolved = advanceSimulation(state, 1_000)

    expect(resolved.totalCleared).toBe(3)
    expect(resolved.board.cells[0]![0]?.type).toBe('heart')
    expect(resolved.phase).toBe('idle')
  })

  it('holds the clear open long enough for every panel to pop', () => {
    const initial = createSimulation('sequential-pop')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [0, 3, 'circle'],
      ]),
    }
    const { matchFlashDurationMs, fixedStepMs } = defaultGameConfig.timing
    // One step goes on detecting the match before the flash even starts.
    const flashed = advanceSimulation(
      state,
      matchFlashDurationMs + fixedStepMs * 2,
    )
    expect(flashed.phase).toBe('clearing')
    expect(flashed.matchedPanelIds).toHaveLength(4)

    // Three pop intervals separate the first panel from the last, so the
    // board must still be clearing well past the base clear duration.
    const popTail =
      clearPhaseDurationMs(4) - defaultGameConfig.timing.clearDurationMs
    expect(popTail).toBe(
      3 * defaultGameConfig.timing.panelPopIntervalMs,
    )

    const midway = advanceSimulation(
      flashed,
      defaultGameConfig.timing.clearDurationMs + 1,
    )
    expect(midway.phase).toBe('clearing')
    expect(midway.totalCleared).toBe(0)

    const finished = advanceSimulation(midway, popTail + fixedStepMs * 2)
    expect(finished.phase).not.toBe('clearing')
    expect(finished.totalCleared).toBe(4)
  })

  it('produces the same checksum for the same seed and actions', () => {
    const play = () => {
      let state = createSimulation('deterministic-round')
      const firstSwap = requestSwap(state, {
        row: 1,
        column: 2,
        direction: 1,
      })
      state = advanceSimulation(firstSwap.state, 500)
      state = setManualRaise(state, true)
      for (let step = 0; step < 90; step += 1) {
        state = stepSimulation(state)
      }
      return setManualRaise(state, false)
    }

    expect(simulationChecksum(play())).toBe(simulationChecksum(play()))
  })

  it('raises faster while manual raise is active', () => {
    const initial = createSimulation('manual-raise')
    const automatic = advanceSimulation(initial, 500)
    const manual = advanceSimulation(setManualRaise(initial, true), 500)

    expect(manual.riseOffset).toBeGreaterThan(automatic.riseOffset)
  })

  it('holds automatic rising after a combo, then resumes', () => {
    const initial = createSimulation('combo-stop-time')
    let state = stepSimulation({
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
        [0, 3, 'circle'],
      ]),
    })

    expect(state.stopTimeRemainingMs).toBe(
      defaultGameConfig.timing.comboStopBaseMs,
    )

    for (
      let step = 0;
      step < 180 && (state.phase !== 'idle' || state.chain !== null);
      step += 1
    ) {
      state = stepSimulation(state)
    }

    expect(state.phase).toBe('idle')
    expect(state.chain).toBeNull()
    expect(state.stopTimeRemainingMs).toBeGreaterThan(0)
    const stoppedOffset = state.riseOffset

    for (
      let step = 0;
      step < 180 && state.stopTimeRemainingMs > 0;
      step += 1
    ) {
      state = stepSimulation(state)
      expect(state.riseOffset).toBe(stoppedOffset)
    }

    expect(state.stopTimeRemainingMs).toBe(0)
    state = stepSimulation(state)
    expect(state.riseOffset).toBeGreaterThan(stoppedOffset)
  })

  it('spends stop time faster while raising instead of wiping it', () => {
    const state = {
      ...createSimulation('spend-stop-time'),
      stopTimeRemainingMs: 900,
    }
    const { fixedStepMs } = defaultGameConfig.timing
    const { manualStopDrainMultiplier } = defaultGameConfig.rise

    const raised = setManualRaise(state, true)
    expect(raised.manualRaise).toBe(true)
    // Holding raise no longer destroys the buffer on the spot.
    expect(raised.stopTimeRemainingMs).toBe(900)

    const raisedStep = stepSimulation(raised)
    const heldStep = stepSimulation(state)

    expect(raisedStep.stopTimeRemainingMs).toBeCloseTo(
      900 - fixedStepMs * manualStopDrainMultiplier,
      6,
    )
    expect(heldStep.stopTimeRemainingMs).toBeCloseTo(900 - fixedStepMs, 6)
    // The point of spending it: the stack actually moves while stopped.
    expect(raisedStep.riseOffset).toBeGreaterThan(0)
    expect(heldStep.riseOffset).toBe(state.riseOffset)
  })

  it('banks stop time earned by a clear made while raising', () => {
    const initial = setManualRaise(
      createSimulation('manual-combo-stop-time'),
      true,
    )
    const matched = stepSimulation({
      ...initial,
      board: boardWith([
        [0, 0, 'heart'],
        [0, 1, 'heart'],
        [0, 2, 'heart'],
        [0, 3, 'heart'],
      ]),
    })

    expect(matched.manualRaise).toBe(true)
    expect(matched.stopTimeRemainingMs).toBeGreaterThan(0)
  })
})
