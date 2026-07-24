import { describe, expect, it } from 'vitest'
import {
  createInitialBoard,
  defaultGameConfig,
  findMatches,
  generateIncomingRow,
  insertIncomingRow,
  seedToRandomState,
} from '../src'

describe('deterministic board generation', () => {
  it('creates the same board and incoming row for the same seed', () => {
    const randomState = seedToRandomState('round-k7m4dp')
    const first = createInitialBoard(randomState)
    const second = createInitialBoard(randomState)

    expect(first).toEqual(second)
  })

  it.each(Array.from({ length: 100 }, (_, index) => `seed-${index}`))(
    'creates an initial board without automatic matches for %s',
    (seed) => {
      const initial = createInitialBoard(seedToRandomState(seed))
      expect(findMatches(initial.board)).toEqual([])
    },
  )

  it('generates deterministic incoming rows that are safe to insert', () => {
    const initial = createInitialBoard(seedToRandomState('incoming'))
    const first = generateIncomingRow(initial.board, initial.randomState)
    const second = generateIncomingRow(initial.board, initial.randomState)

    expect(first).toEqual(second)

    const board = {
      ...initial.board,
      incomingRow: first.row,
    }
    const inserted = insertIncomingRow(board, first.randomState)

    expect(inserted.toppedOut).toBe(false)
    expect(findMatches(inserted.board)).toEqual([])
  })

  it('generates isolated shock panels without creating starting matches', () => {
    const config = {
      ...defaultGameConfig,
      board: {
        ...defaultGameConfig.board,
        shockPanelChance: 1,
      },
    }
    const initial = createInitialBoard(
      seedToRandomState('shock-generation'),
      config,
    )
    const shocks = initial.board.cells
      .flat()
      .filter((panel) => panel?.type === 'shock')

    expect(shocks.length).toBeGreaterThan(0)
    expect(findMatches(initial.board)).toEqual([])
    expect(initial.board.incomingRow).toContain('shock')
  })
})
