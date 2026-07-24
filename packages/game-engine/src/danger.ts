import type { GameConfig, SimulationState } from './types'

export function boardTouchesTop(state: SimulationState): boolean {
  const topRow = state.board.visibleRows - 1
  return (
    state.board.cells[topRow]!.some((panel) => panel !== null) ||
    state.garbage.some(
      (block) =>
        block.state !== 'falling' &&
        block.row <= topRow &&
        block.row + block.height - 1 >= topRow,
    )
  )
}

function rescuingClearIsActive(state: SimulationState): boolean {
  return (
    state.phase !== 'idle' &&
    state.lastClearEvent?.touchedTop === true
  )
}

export function advanceDangerState(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (state.status !== 'playing') {
    return state
  }

  const blocked = boardTouchesTop(state)
  if (!blocked) {
    return state.dangerRemainingMs === null
      ? state
      : { ...state, dangerRemainingMs: null }
  }

  if (state.dangerRemainingMs === null) {
    return {
      ...state,
      dangerRemainingMs: config.timing.dangerGraceMs,
      manualRaise: false,
    }
  }

  if (rescuingClearIsActive(state)) {
    return state
  }

  const dangerRemainingMs = Math.max(
    0,
    state.dangerRemainingMs - config.timing.fixedStepMs,
  )

  return {
    ...state,
    dangerRemainingMs,
    status: dangerRemainingMs === 0 ? 'lost' : state.status,
    manualRaise: dangerRemainingMs === 0 ? false : state.manualRaise,
  }
}
