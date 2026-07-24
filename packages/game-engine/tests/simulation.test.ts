import { describe, expect, it } from 'vitest'
import {
  advanceSimulation,
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
    const resolved = advanceSimulation(state, 800)

    expect(resolved.totalCleared).toBe(3)
    expect(resolved.board.cells[0]![0]?.type).toBe('heart')
    expect(resolved.phase).toBe('idle')
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

  it('lets manual raising cancel earned stop time', () => {
    const state = {
      ...createSimulation('cancel-stop-time'),
      stopTimeRemainingMs: 900,
    }

    const raised = setManualRaise(state, true)

    expect(raised.manualRaise).toBe(true)
    expect(raised.stopTimeRemainingMs).toBe(0)
  })

  it('does not bank new stop time while manual raising is held', () => {
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
    expect(matched.stopTimeRemainingMs).toBe(0)
  })
})
