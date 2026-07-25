import { describe, expect, it } from 'vitest'
import {
  cancelIncomingGarbage,
  createSimulation,
  enqueueIncomingGarbage,
  stepSimulation,
  type IncomingGarbageAttack,
  type OutgoingAttack,
} from '../src'
import { boardWith } from './helpers'

function incoming(
  sequence: number,
  blocks: IncomingGarbageAttack['blocks'],
): IncomingGarbageAttack {
  return {
    attackId: `attack-${sequence}`,
    serverSequence: sequence,
    blocks,
    readyAt: 0,
  }
}

function outgoing(
  sequence: number,
  blocks: OutgoingAttack['blocks'],
): OutgoingAttack {
  return {
    sequence,
    kind: 'combo',
    createdAt: 0,
    clearSize: 4,
    chainLevel: 1,
    blocks,
  }
}

describe('garbage cancellation', () => {
  it('leaves both sides alone when nothing is queued', () => {
    const attacks = [outgoing(1, [{ width: 3, height: 1, type: 'normal' }])]
    const result = cancelIncomingGarbage([], attacks)

    expect(result.cancelledCells).toBe(0)
    expect(result.attacks).toBe(attacks)
  })

  it('cancels an even exchange down to nothing on both sides', () => {
    const result = cancelIncomingGarbage(
      [incoming(1, [{ width: 6, height: 1, type: 'normal' }])],
      [outgoing(1, [{ width: 6, height: 1, type: 'normal' }])],
    )

    expect(result.incomingGarbage).toEqual([])
    expect(result.attacks).toEqual([])
    expect(result.cancelledCells).toBe(6)
  })

  it('spends a whole row before narrowing the next one', () => {
    const result = cancelIncomingGarbage(
      [incoming(1, [{ width: 6, height: 2, type: 'normal' }])],
      [outgoing(1, [{ width: 6, height: 1, type: 'normal' }])],
    )

    expect(result.incomingGarbage[0]?.blocks).toEqual([
      { width: 6, height: 1, type: 'normal' },
    ])
    expect(result.attacks).toEqual([])
  })

  it('narrows a single row when the attack cannot cover it', () => {
    const result = cancelIncomingGarbage(
      [incoming(1, [{ width: 6, height: 1, type: 'normal' }])],
      [outgoing(1, [{ width: 4, height: 1, type: 'normal' }])],
    )

    expect(result.incomingGarbage[0]?.blocks).toEqual([
      { width: 2, height: 1, type: 'normal' },
    ])
    expect(result.attacks).toEqual([])
    expect(result.cancelledCells).toBe(4)
  })

  it('dents a slab one row at a time, keeping it rectangular', () => {
    const result = cancelIncomingGarbage(
      [incoming(1, [{ width: 6, height: 2, type: 'normal' }])],
      [outgoing(1, [{ width: 3, height: 1, type: 'normal' }])],
    )

    expect(result.incomingGarbage[0]?.blocks).toEqual([
      { width: 3, height: 1, type: 'normal' },
      { width: 6, height: 1, type: 'normal' },
    ])
    expect(result.attacks).toEqual([])
    expect(result.cancelledCells).toBe(3)
  })

  it('sends only the surplus when the attack outweighs the queue', () => {
    const result = cancelIncomingGarbage(
      [incoming(1, [{ width: 3, height: 1, type: 'normal' }])],
      [outgoing(1, [{ width: 6, height: 2, type: 'normal' }])],
    )

    expect(result.incomingGarbage).toEqual([])
    expect(result.attacks[0]?.blocks).toEqual([
      { width: 3, height: 1, type: 'normal' },
      { width: 6, height: 1, type: 'normal' },
    ])
  })

  it('eats the earliest queued attack first', () => {
    const result = cancelIncomingGarbage(
      [
        incoming(1, [{ width: 3, height: 1, type: 'normal' }]),
        incoming(2, [{ width: 6, height: 1, type: 'normal' }]),
      ],
      [outgoing(1, [{ width: 3, height: 1, type: 'normal' }])],
    )

    expect(result.incomingGarbage.map(({ serverSequence }) => serverSequence)).toEqual([2])
  })

  it('defends with a clear instead of sending, inside the simulation', () => {
    const initial = createSimulation('cancel-in-sim')
    const queued = enqueueIncomingGarbage(
      {
        ...initial,
        board: boardWith([
          [0, 0, 'heart'],
          [0, 1, 'heart'],
          [0, 2, 'heart'],
          [0, 3, 'heart'],
        ]),
      },
      {
        attackId: 'incoming-1',
        serverSequence: 0,
        blocks: [{ width: 6, height: 1, type: 'normal' }],
      },
    )

    const matched = stepSimulation(queued)

    // A 4-panel combo is three cells; it shaves the queued row down rather
    // than adding a row of its own to the opponent's board.
    expect(matched.outgoingAttacks).toEqual([])
    expect(matched.lastClearEvent?.attackSequences).toEqual([])
    expect(matched.incomingGarbage[0]?.blocks).toEqual([
      { width: 3, height: 1, type: 'normal' },
    ])
  })
})
