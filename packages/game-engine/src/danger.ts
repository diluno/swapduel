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

// The danger clock only runs while the board is settled and the player can
// actually act on it. Every resolution phase holds it: flash, clear, garbage
// conversion, garbage fall, and fall delay — which applies gravity and can
// cascade straight back into flashing, so a whole chain resolves on a frozen
// clock.
//
// Swaps deliberately do not hold it. A swap is player input rather than the
// board settling, and pausing on it would let continuous swapping freeze the
// countdown indefinitely. Clears cannot be abused the same way: the stack
// does not rise during danger, so every clear consumes panels and moves the
// board towards safety.
function boardIsSettling(state: SimulationState): boolean {
  return state.phase !== 'idle'
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

  if (boardIsSettling(state)) {
    return state
  }

  const dangerRemainingMs = Math.max(
    0,
    state.dangerRemainingMs - config.timing.fixedStepMs,
  )

  const toppedOut = dangerRemainingMs === 0

  return {
    ...state,
    dangerRemainingMs,
    status: toppedOut ? 'lost' : state.status,
    endReason: toppedOut ? 'topped-out' : state.endReason,
    manualRaise: toppedOut ? false : state.manualRaise,
  }
}
