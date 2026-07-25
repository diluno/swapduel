import type { SimulationState } from '@swapduel/game-engine'
import type { Ref } from 'vue'

export interface BoardCoordinate {
  row: number
  column: number
}

interface BoardPointerOptions {
  canvas: () => HTMLCanvasElement | null
  state: () => SimulationState
  /** Input is dropped unless the board is actually in play. */
  isLive: () => boolean
  /** Performs the swap; returns whether the engine accepted it. */
  swap: (row: number, column: number, direction: -1 | 1) => boolean
  /** The tap-to-select highlight, owned by the page so it can be rendered. */
  selected: Ref<BoardCoordinate | null>
  /** Fires on every press, before anything else (audio unlock, cursor hide). */
  onPress?: () => void
  /** Fires whenever the selection changed and the board needs repainting. */
  onSelect?: (coordinate: BoardCoordinate | null) => void
}

interface ActivePointer {
  id: number
  row: number
  column: number
  startX: number
  startY: number
  triggered: boolean
  verticalRejected: boolean
}

/** A drag has to cover this much of a cell before it counts as a swipe. */
const SWIPE_THRESHOLD = 0.28
/** Past this much vertical travel the gesture is a scroll, not a swap. */
const VERTICAL_REJECT_PX = 8

/**
 * Board input: tap a panel then tap its neighbour, or swipe a panel sideways.
 * Vertical swipes are deliberately rejected rather than swallowed — Panel de
 * Pon has no vertical swap, so the gesture should feel ignored, not broken.
 */
export function useBoardPointer(options: BoardPointerOptions) {
  let activePointer: ActivePointer | null = null

  function boardCoordinate(event: PointerEvent): BoardCoordinate | null {
    const target = options.canvas()
    if (target === null) return null
    const board = options.state().board
    const bounds = target.getBoundingClientRect()
    const cellSize = bounds.width / board.columns
    const column = Math.floor((event.clientX - bounds.left) / cellSize)
    const row = Math.floor(
      (bounds.height - (event.clientY - bounds.top)) / cellSize -
        options.state().riseOffset,
    )

    if (
      row < 0 ||
      row >= board.visibleRows ||
      column < 0 ||
      column >= board.columns
    ) {
      return null
    }
    return { row, column }
  }

  function select(coordinate: BoardCoordinate | null): void {
    options.selected.value = coordinate
    options.onSelect?.(coordinate)
  }

  function onPointerDown(event: PointerEvent): void {
    options.onPress?.()
    if (!options.isLive() || activePointer !== null) return

    const coordinate = boardCoordinate(event)
    if (coordinate === null) {
      select(null)
      return
    }

    options.canvas()?.setPointerCapture(event.pointerId)
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

  function onPointerMove(event: PointerEvent): void {
    if (activePointer === null || activePointer.id !== event.pointerId) return

    const horizontal = event.clientX - activePointer.startX
    const vertical = event.clientY - activePointer.startY
    if (
      !activePointer.triggered &&
      Math.abs(vertical) > Math.abs(horizontal) &&
      Math.abs(vertical) > VERTICAL_REJECT_PX
    ) {
      activePointer.verticalRejected = true
    }

    const bounds = options.canvas()?.getBoundingClientRect()
    if (
      bounds === undefined ||
      activePointer.triggered ||
      activePointer.verticalRejected ||
      Math.abs(horizontal) <
        (bounds.width / options.state().board.columns) * SWIPE_THRESHOLD
    ) {
      return
    }

    activePointer.triggered = options.swap(
      activePointer.row,
      activePointer.column,
      horizontal < 0 ? -1 : 1,
    )
  }

  function onPointerEnd(event: PointerEvent): void {
    if (activePointer === null || activePointer.id !== event.pointerId) return

    if (!activePointer.triggered && !activePointer.verticalRejected) {
      const tapped = boardCoordinate(event)
      const current = options.selected.value
      if (tapped !== null) {
        if (
          current !== null &&
          current.row === tapped.row &&
          Math.abs(current.column - tapped.column) === 1
        ) {
          options.swap(
            current.row,
            current.column,
            tapped.column > current.column ? 1 : -1,
          )
        } else {
          select(tapped)
        }
      }
    }

    activePointer = null
  }

  function reset(): void {
    activePointer = null
    options.selected.value = null
  }

  return { onPointerDown, onPointerMove, onPointerEnd, reset }
}
