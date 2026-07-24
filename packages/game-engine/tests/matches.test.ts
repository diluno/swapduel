import { describe, expect, it } from 'vitest'
import { findMatches } from '../src'
import { boardWith } from './helpers'

describe('match detection', () => {
  it('finds a horizontal match', () => {
    const board = boardWith([
      [0, 1, 'circle'],
      [0, 2, 'circle'],
      [0, 3, 'circle'],
    ])

    expect(findMatches(board)).toEqual([
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
    ])
  })

  it('finds a vertical match', () => {
    const board = boardWith([
      [2, 4, 'triangle'],
      [3, 4, 'triangle'],
      [4, 4, 'triangle'],
    ])

    expect(findMatches(board)).toEqual([
      { row: 2, column: 4 },
      { row: 3, column: 4 },
      { row: 4, column: 4 },
    ])
  })

  it('deduplicates the center of intersecting matches', () => {
    const board = boardWith([
      [2, 1, 'star'],
      [2, 2, 'star'],
      [2, 3, 'star'],
      [1, 2, 'star'],
      [3, 2, 'star'],
    ])

    expect(findMatches(board)).toHaveLength(5)
  })

  it('does not match through an empty cell', () => {
    const board = boardWith([
      [0, 0, 'heart'],
      [0, 1, 'heart'],
      [0, 3, 'heart'],
    ])

    expect(findMatches(board)).toEqual([])
  })

  it('finds an orthogonally connected shock group', () => {
    const board = boardWith([
      [0, 0, 'shock'],
      [0, 1, 'shock'],
      [1, 1, 'shock'],
    ])

    expect(findMatches(board)).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 1 },
    ])
  })

  it('does not match two connected shock panels', () => {
    const board = boardWith([
      [0, 0, 'shock'],
      [1, 0, 'shock'],
    ])

    expect(findMatches(board)).toEqual([])
  })
})
