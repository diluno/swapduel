import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  defaultGameConfig,
  enqueueIncomingGarbage,
  findMatches,
  requestSwap,
  stepSimulation,
  type GarbageBlock,
  type SimulationState,
} from '../src'
import { boardWith } from './helpers'

function garbageBlock(
  overrides: Partial<GarbageBlock> = {},
): GarbageBlock {
  return {
    id: 1,
    type: 'normal',
    column: 0,
    row: 1,
    width: 3,
    height: 1,
    conversionRow: null,
    state: 'idle',
    fallProgress: 0,
    ...overrides,
  }
}

function advanceUntil(
  initial: SimulationState,
  predicate: (state: SimulationState) => boolean,
  maximumSteps = 600,
): SimulationState {
  let state = initial

  for (let step = 0; step < maximumSteps; step += 1) {
    state = stepSimulation(state)
    if (predicate(state)) return state
  }

  throw new Error('Simulation did not reach the expected garbage state')
}

describe('incoming garbage', () => {
  it('telegraphs an attack before letting it drop', () => {
    const initial = createSimulation('garbage-telegraph')
    const queued = enqueueIncomingGarbage(initial, {
      attackId: 'telegraphed',
      serverSequence: 1,
      blocks: [{ width: 3, height: 1, type: 'normal' }],
    })
    const { garbageTelegraphMs, fixedStepMs } = defaultGameConfig.timing

    expect(queued.incomingGarbage[0]!.readyAt).toBe(
      queued.elapsedMs + garbageTelegraphMs,
    )

    // The whole warning window passes with the attack still visible in the
    // queue and nothing on the board.
    let state = queued
    const heldSteps = Math.floor(garbageTelegraphMs / fixedStepMs) - 1
    for (let step = 0; step < heldSteps; step += 1) {
      state = stepSimulation(state)
      expect(state.garbage).toHaveLength(0)
      expect(state.incomingGarbage).toHaveLength(1)
    }

    const dropped = advanceUntil(state, ({ garbage }) => garbage.length > 0)
    expect(dropped.incomingGarbage).toHaveLength(0)
    expect(dropped.garbage[0]!.width).toBe(3)
  })

  it('orders incoming attacks and ignores duplicate attack IDs', () => {
    const initial = createSimulation('garbage-ordering')
    const second = enqueueIncomingGarbage(initial, {
      attackId: 'attack-2',
      serverSequence: 2,
      blocks: [{ width: 4, height: 1, type: 'normal' }],
    })
    const ordered = enqueueIncomingGarbage(second, {
      attackId: 'attack-1',
      serverSequence: 1,
      blocks: [{ width: 3, height: 1, type: 'normal' }],
    })
    const duplicate = enqueueIncomingGarbage(ordered, {
      attackId: 'attack-1',
      serverSequence: 3,
      blocks: [{ width: 6, height: 2, type: 'metal' }],
    })
    const duplicateSequence = enqueueIncomingGarbage(ordered, {
      attackId: 'different-id',
      serverSequence: 2,
      blocks: [{ width: 6, height: 1, type: 'metal' }],
    })

    expect(ordered.incomingGarbage.map(({ attackId }) => attackId)).toEqual([
      'attack-1',
      'attack-2',
    ])
    expect(duplicate).toBe(ordered)
    expect(duplicateSequence).toBe(ordered)
  })

  it('places partial-width garbage deterministically without changing row RNG', () => {
    const prepare = () =>
      enqueueIncomingGarbage(createSimulation('garbage-placement'), {
        attackId: 'partial',
        serverSequence: 1,
        blocks: [{ width: 3, height: 1, type: 'normal' }],
      })
    const firstInitial = prepare()
    const secondInitial = prepare()
    const first = advanceUntil(
      firstInitial,
      (state) =>
        state.garbage.length === 1 &&
        state.garbage[0]?.state === 'idle',
    )
    const second = advanceUntil(
      secondInitial,
      (state) =>
        state.garbage.length === 1 &&
        state.garbage[0]?.state === 'idle',
    )

    expect(first.garbage[0]).toMatchObject(second.garbage[0]!)
    expect(first.garbage[0]).toMatchObject({
      row: 6,
      width: 3,
      height: 1,
    })
    expect(first.randomState).toBe(firstInitial.randomState)
  })

  it('keeps a full-width multi-row block rectangular while falling', () => {
    const initial = enqueueIncomingGarbage(
      createSimulation('full-width-garbage'),
      {
        attackId: 'chain-block',
        serverSequence: 1,
        blocks: [{ width: 6, height: 2, type: 'normal' }],
      },
    )
    const settled = advanceUntil(
      initial,
      (state) => state.garbage[0]?.state === 'idle',
    )

    expect(settled.garbage[0]).toMatchObject({
      column: 0,
      row: 6,
      width: 6,
      height: 2,
    })
  })

  it('prevents a panel from swapping into garbage', () => {
    const initial = createSimulation('garbage-swap')
    const state = {
      ...initial,
      board: boardWith([[0, 0, 'circle']]),
      garbage: [garbageBlock({ column: 1, row: 0, width: 2 })],
    }

    expect(
      requestSwap(state, { row: 0, column: 0, direction: 1 }),
    ).toMatchObject({ ok: false, reason: 'cell-locked' })
  })
})

describe('garbage conversion', () => {
  it('converts a touched one-row block into normal panels', () => {
    const initial = createSimulation('garbage-convert')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
      ]),
      garbage: [garbageBlock()],
    }
    const converted = advanceUntil(
      state,
      (candidate) =>
        candidate.garbage.length === 0 &&
        candidate.garbageConversion === null &&
        candidate.totalCleared === 3,
    )

    expect(
      converted.board.cells
        .flat()
        .filter((panel) => panel !== null),
    ).toHaveLength(3)
  })

  it('converts only the lowest row of a multi-row block', () => {
    const initial = createSimulation('multi-row-convert')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'heart'],
        [0, 1, 'heart'],
        [0, 2, 'heart'],
      ]),
      garbage: [garbageBlock({ height: 2 })],
    }
    const converted = advanceUntil(
      state,
      (candidate) =>
        candidate.garbage.length === 1 &&
        candidate.garbage[0]?.height === 1 &&
        candidate.garbage[0]?.state === 'idle' &&
        candidate.garbageConversion === null &&
        candidate.phase === 'idle',
    )

    expect(converted.garbage[0]).toMatchObject({
      row: 1,
      width: 3,
      height: 1,
      state: 'idle',
    })
  })

  it('does not spread normal conversion into adjacent metal garbage', () => {
    const initial = createSimulation('separate-garbage-types')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'triangle'],
        [0, 1, 'triangle'],
        [0, 2, 'triangle'],
      ]),
      garbage: [
        garbageBlock({ id: 1, column: 0, width: 3, type: 'normal' }),
        garbageBlock({ id: 2, column: 3, width: 3, type: 'metal' }),
      ],
    }
    const converted = advanceUntil(
      state,
      (candidate) =>
        candidate.garbageConversion === null &&
        candidate.garbage.length === 1 &&
        candidate.garbage[0]?.type === 'metal',
    )

    expect(converted.garbage[0]?.type).toBe('metal')
  })

  it('converts directly touched metal garbage', () => {
    const initial = createSimulation('metal-convert')
    const state = {
      ...initial,
      board: boardWith([
        [0, 3, 'star'],
        [0, 4, 'star'],
        [0, 5, 'star'],
      ]),
      garbage: [
        garbageBlock({
          id: 1,
          column: 3,
          width: 3,
          type: 'metal',
        }),
      ],
    }
    const converted = advanceUntil(
      state,
      (candidate) =>
        candidate.garbage.length === 0 &&
        candidate.garbageConversion === null,
    )

    expect(converted.garbage).toEqual([])
  })

  it('joins directly connected garbage of the same type', () => {
    const initial = createSimulation('connected-garbage')
    const state = {
      ...initial,
      board: boardWith([
        [0, 0, 'diamond'],
        [0, 1, 'diamond'],
        [0, 2, 'diamond'],
      ]),
      garbage: [
        garbageBlock({ id: 1, column: 0, width: 3 }),
        garbageBlock({ id: 2, column: 3, width: 3 }),
      ],
    }
    // Conversion starts once the clear that cracked the blocks has finished
    // popping, so wait for it rather than reading it on the first step.
    const converting = advanceUntil(
      stepSimulation(state),
      (candidate) => candidate.garbageConversion !== null,
    )

    expect(converting.garbageConversion?.blockIds).toEqual([1, 2])

    const converted = advanceUntil(
      converting,
      (candidate) =>
        candidate.garbage.length === 0 &&
        candidate.garbageConversion === null,
    )
    expect(converted.garbage).toEqual([])
  })

  it('keeps converted panels part of the active chain', () => {
    // The mechanism that lets a player-built chain carry on through a
    // dissolving block: the spawned panels inherit the open chain, so a match
    // they later fall into still counts as a continuation.
    const initial = createSimulation('conversion-chain-flag')
    const state: SimulationState = {
      ...initial,
      board: boardWith([
        [0, 0, 'circle'],
        [0, 1, 'circle'],
        [0, 2, 'circle'],
      ]),
      garbage: [garbageBlock()],
    }
    const converting = advanceUntil(state, (candidate) =>
      candidate.board.cells
        .flat()
        .some((panel) => panel?.state === 'garbage-locked'),
    )
    const spawned = converting.board.cells
      .flat()
      .filter((panel) => panel?.state === 'garbage-locked')

    expect(spawned.length).toBeGreaterThan(0)
    expect(spawned.every((panel) => panel!.chainEligible)).toBe(true)
    expect(spawned.every((panel) => panel!.chainId !== null)).toBe(true)
  })

  it('never spawns a ready-made match when a block dissolves', () => {
    // Spawned panels are garbage-locked, so they cannot match until they are
    // released — at which point they all turn idle at once. Unlocking a copy
    // asks the real question: would these colours match the moment they land?
    for (let index = 0; index < 250; index += 1) {
      const initial = createSimulation(`conversion-safe-${index}`)
      const state: SimulationState = {
        ...initial,
        board: boardWith([
          [0, 0, 'circle'],
          [0, 1, 'circle'],
          [0, 2, 'circle'],
        ]),
        garbage: [garbageBlock({ width: 6 })],
      }
      const converted = advanceUntil(
        state,
        (candidate) =>
          candidate.garbageConversion !== null &&
          candidate.garbageConversion.nextColumn >= 6,
      )
      const unlocked = {
        ...converted.board,
        cells: converted.board.cells.map((row) =>
          row.map((panel) =>
            panel === null
              ? null
              : { ...panel, state: 'idle' as const },
          ),
        ),
      }

      expect(findMatches(unlocked)).toEqual([])
    }
  })
})
