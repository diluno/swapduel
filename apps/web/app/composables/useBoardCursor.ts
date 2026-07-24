export interface BoardCursor {
  row: number
  /** Left cell of the two-wide cursor. */
  column: number
}

interface BoardCursorOptions {
  columns: () => number
  visibleRows: () => number
  /** Input is ignored unless the round is actually running. */
  isLive: () => boolean
  /** Returns whether the swap was accepted. */
  swap: (row: number, column: number, direction: -1 | 1) => boolean
  setRaise: (raising: boolean) => void
  /** Called whenever the cursor moved and the board needs repainting. */
  onChange: () => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Panel de Pon's cursor: a two-wide box driven by the keyboard, where the only
 * action is swapping the pair it straddles. It stays hidden until a key is
 * pressed so touch players keep the tap-to-select model untouched, and any
 * pointer interaction hides it again.
 */
export function useBoardCursor(options: BoardCursorOptions) {
  const cursor = ref<BoardCursor>({ row: 0, column: 0 })
  const cursorVisible = ref(false)
  let raising = false

  function clamp(next: BoardCursor): BoardCursor {
    // The cursor spans two columns, so its left cell stops one short of the
    // right wall.
    const maxColumn = Math.max(0, options.columns() - 2)
    const maxRow = Math.max(0, options.visibleRows() - 1)
    return {
      row: Math.min(maxRow, Math.max(0, next.row)),
      column: Math.min(maxColumn, Math.max(0, next.column)),
    }
  }

  function move(rowDelta: number, columnDelta: number): void {
    cursor.value = clamp({
      row: cursor.value.row + rowDelta,
      column: cursor.value.column + columnDelta,
    })
    options.onChange()
  }

  function hideCursor(): void {
    if (!cursorVisible.value) return
    cursorVisible.value = false
    options.onChange()
  }

  function stopRaising(): void {
    if (!raising) return
    raising = false
    options.setRaise(false)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey) return
    if (!options.isLive()) return

    const key = event.key.toLowerCase()
    let handled = true

    switch (key) {
      case 'arrowleft':
      case 'a':
        move(0, -1)
        break
      case 'arrowright':
      case 'd':
        move(0, 1)
        break
      case 'arrowup':
      case 'w':
        move(1, 0)
        break
      case 'arrowdown':
      case 's':
        move(-1, 0)
        break
      case ' ':
      case 'enter':
        // Vertical swaps do not exist in Panel de Pon, so the cursor always
        // swaps its own pair left-to-right.
        options.swap(cursor.value.row, cursor.value.column, 1)
        break
      case 'shift':
        if (!event.repeat && !raising) {
          raising = true
          options.setRaise(true)
        }
        break
      default:
        handled = false
    }

    if (!handled) return
    event.preventDefault()
    if (!cursorVisible.value) {
      cursorVisible.value = true
      options.onChange()
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'shift') stopRaising()
  }

  onMounted(() => {
    cursor.value = clamp(cursor.value)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    // A held raise must not survive the tab losing focus.
    window.addEventListener('blur', stopRaising)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', stopRaising)
    stopRaising()
  })

  return { cursor, cursorVisible, hideCursor }
}
