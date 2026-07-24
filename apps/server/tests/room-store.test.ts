import { describe, expect, it } from 'vitest'
import { RoomStore, RoomStoreError } from '../src/rooms/room-store'

function createStore(clock = { now: 1_000 }): RoomStore {
  let id = 0
  let token = 0
  let code = 0
  return new RoomStore({
    now: () => clock.now,
    createId: () => `id-${++id}`,
    createToken: () => `token-${++token}`,
    createRoomCode: () => `ROOM0${++code}`,
    createRoundSeed: () => 'round-seed',
    countdownLeadMs: 3_000,
    simultaneousTopOutWindowMs: 150,
    disconnectForfeitMs: 30_000,
    reconnectCountdownMs: 3_000,
    waitingReservationMs: 5 * 60_000,
    roomInactivityMs: 2 * 60 * 60_000,
  })
}

describe('RoomStore', () => {
  it('creates a private room with its host in slot one', () => {
    const store = createStore()
    const session = store.create('Mira', 'socket-1')

    expect(session).toMatchObject({
      playerId: 'id-2',
      reconnectToken: 'token-1',
      roomState: {
        roomId: 'id-1',
        roomCode: 'ROOM01',
        hostPlayerId: 'id-2',
        status: 'waiting',
        activeMatchId: null,
        players: [
          {
            displayName: 'Mira',
            slot: 1,
            connected: true,
            ready: false,
          },
        ],
      },
    })
    expect(session.roomState.players[0]).not.toHaveProperty(
      'reconnectToken',
    )
  })

  it('joins the second player and preserves slot order', () => {
    const store = createStore()
    store.create('Mira', 'socket-1')
    const joined = store.join('ROOM01', 'Noah', 'socket-2')

    expect(joined.roomState.players.map((player) => player.displayName)).toEqual(
      ['Mira', 'Noah'],
    )
    expect(joined.roomState.players.map((player) => player.slot)).toEqual([
      1, 2,
    ])
  })

  it('rejects a third player', () => {
    const store = createStore()
    store.create('Mira', 'socket-1')
    store.join('ROOM01', 'Noah', 'socket-2')

    expect(() => store.join('ROOM01', 'Ivy', 'socket-3')).toThrowError(
      expect.objectContaining({ code: 'ROOM_FULL' }),
    )
  })

  it('updates ready state only with valid private credentials', () => {
    const store = createStore()
    const session = store.create('Mira', 'socket-1')

    const ready = store.setReady(
      session.roomState.roomId,
      session.playerId,
      session.reconnectToken,
      true,
    )
    expect(ready.players[0]?.ready).toBe(true)

    expect(() =>
      store.setReady(
        session.roomState.roomId,
        session.playerId,
        'wrong-token',
        false,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
      }) as RoomStoreError,
    )
  })

  it('marks a disconnected player unavailable and not ready', () => {
    const store = createStore()
    const session = store.create('Mira', 'socket-1')
    store.setReady(
      session.roomState.roomId,
      session.playerId,
      session.reconnectToken,
      true,
    )

    const [changedRoom] = store.markDisconnected('socket-1')
    expect(changedRoom?.roomState.players[0]).toMatchObject({
      connected: false,
      ready: false,
    })
  })

  it('reconnects a reserved player without changing their slot', () => {
    const store = createStore()
    const session = store.create('Mira', 'socket-1')
    store.markDisconnected('socket-1')

    const reconnected = store.reconnect(
      session.roomState.roomId,
      session.playerId,
      session.reconnectToken,
      'socket-new',
    )

    expect(reconnected.roomState.players[0]).toMatchObject({
      playerId: session.playerId,
      slot: 1,
      connected: true,
    })
  })

  it('releases a disconnected waiting-room slot after five minutes', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    store.markDisconnected('socket-2')

    clock.now = 300_999
    expect(store.cleanupExpiredRooms()).toEqual({
      expiredRooms: [],
      updatedRooms: [],
    })
    expect(store.getById(host.roomState.roomId).players).toHaveLength(2)

    clock.now = 301_000
    const cleanup = store.cleanupExpiredRooms()
    expect(cleanup.expiredRooms).toEqual([])
    expect(cleanup.updatedRooms[0]?.players).toEqual([
      expect.objectContaining({
        playerId: host.playerId,
        slot: 1,
      }),
    ])

    const replacement = store.join('ROOM01', 'Ivy', 'socket-3')
    expect(replacement.roomState.players).toEqual([
      expect.objectContaining({ playerId: host.playerId, slot: 1 }),
      expect.objectContaining({
        playerId: replacement.playerId,
        slot: 2,
      }),
    ])
    expect(replacement.playerId).not.toBe(guest.playerId)
  })

  it('promotes the remaining player when the waiting-room host expires', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    store.markDisconnected('socket-1')

    clock.now = 301_000
    const [room] = store.cleanupExpiredRooms().updatedRooms
    expect(room).toMatchObject({
      hostPlayerId: guest.playerId,
      players: [{ playerId: guest.playerId, slot: 1 }],
    })
    expect(() =>
      store.reconnect(
        host.roomState.roomId,
        host.playerId,
        host.reconnectToken,
        'socket-old-host',
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
  })

  it('removes abandoned rooms and their room-code index', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    store.join('ROOM01', 'Noah', 'socket-2')
    store.markDisconnected('socket-1')
    store.markDisconnected('socket-2')

    clock.now = 301_000
    const cleanup = store.cleanupExpiredRooms()
    expect(cleanup.expiredRooms).toEqual([
      expect.objectContaining({
        roomId: host.roomState.roomId,
        roomCode: 'ROOM01',
        playerIds: [host.playerId, 'id-3'],
      }),
    ])
    expect(() => store.getById(host.roomState.roomId)).toThrowError(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' }),
    )
    expect(() => store.join('ROOM01', 'Ivy', 'socket-3')).toThrowError(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' }),
    )
  })

  it('expires rooms after two hours without authenticated activity', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')

    clock.now = 3_601_000
    store.setReady(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
      true,
    )
    clock.now = 7_200_999
    expect(store.cleanupExpiredRooms().expiredRooms).toEqual([])

    clock.now = 10_801_000
    expect(store.cleanupExpiredRooms().expiredRooms).toEqual([
      expect.objectContaining({ roomId: host.roomState.roomId }),
    ])
  })

  it('allows only a ready host to start a two-player match', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')

    expect(() =>
      store.startMatch(
        guest.roomState.roomId,
        guest.playerId,
        guest.reconnectToken,
      ),
    ).toThrowError(expect.objectContaining({ code: 'HOST_ONLY' }))

    expect(() =>
      store.startMatch(
        host.roomState.roomId,
        host.playerId,
        host.reconnectToken,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PLAYERS_NOT_READY' }),
    )

    store.setReady(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
      true,
    )
    store.setReady(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      true,
    )

    const started = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    expect(started).toMatchObject({
      roomState: {
        status: 'starting',
        activeMatchId: 'id-4',
      },
      preparation: {
        protocolVersion: 1,
        matchId: 'id-4',
        roundId: 'id-5',
        roundNumber: 1,
        roundSeed: 'round-seed',
      },
    })
  })

  it('issues one countdown timestamp after both clients prepare', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )

    const hostReady = store.markRoundReady(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
      preparation.matchId,
      preparation.roundId,
    )
    expect(hostReady.starting).toBeNull()
    expect(hostReady.roomState.status).toBe('starting')

    const guestReady = store.markRoundReady(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      preparation.matchId,
      preparation.roundId,
    )
    expect(guestReady.roomState.status).toBe('playing')
    expect(guestReady.starting).toMatchObject({
      ...preparation,
      startAt: 4_000,
    })

    const duplicate = store.markRoundReady(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      preparation.matchId,
      preparation.roundId,
    )
    expect(duplicate.starting?.startAt).toBe(4_000)
  })

  it('rejects readiness for a stale round', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')

    expect(() =>
      store.markRoundReady(
        host.roomState.roomId,
        host.playerId,
        host.reconnectToken,
        'old-match',
        'old-round',
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_MATCH' }))
  })

  it('authorizes live snapshots only from the active player socket', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    expect(
      store.authorizeGameplayEvent(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      ),
    ).toEqual({
      roomId: host.roomState.roomId,
      targetPlayerId: guest.playerId,
    })

    expect(() =>
      store.authorizeGameplayEvent(
        'spoofed-socket',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    expect(() =>
      store.authorizeGameplayEvent(
        'socket-1',
        host.playerId,
        preparation.matchId,
        'stale-round',
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_MATCH' }))
  })

  it('orders, deduplicates, targets, and acknowledges attacks', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    const hostAttack = {
      protocolVersion: 1 as const,
      attackId: 'host-attack-1',
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      senderId: host.playerId,
      localSequence: 1,
      clientTimestamp: 1_100,
      kind: 'combo' as const,
      blocks: [{ width: 3, height: 1, type: 'normal' as const }],
    }
    const orderedHostAttack = store.orderAttack('socket-1', hostAttack)
    expect(orderedHostAttack).toMatchObject({
      duplicate: false,
      targetSocketId: 'socket-2',
      event: {
        ...hostAttack,
        targetId: guest.playerId,
        serverSequence: 1,
        serverTimestamp: 1_000,
      },
    })

    const orderedGuestAttack = store.orderAttack('socket-2', {
      ...hostAttack,
      attackId: 'guest-attack-1',
      senderId: guest.playerId,
    })
    expect(orderedGuestAttack.event).toMatchObject({
      targetId: host.playerId,
      serverSequence: 2,
    })

    const duplicate = store.orderAttack('socket-1', hostAttack)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.event.serverSequence).toBe(1)

    expect(
      store.acknowledgeAttack(
        'socket-2',
        guest.playerId,
        preparation.matchId,
        preparation.roundId,
        1,
      ),
    ).toBe(true)
    expect(
      store.acknowledgeAttack(
        'socket-2',
        guest.playerId,
        preparation.matchId,
        preparation.roundId,
        1,
      ),
    ).toBe(false)
    expect(() =>
      store.acknowledgeAttack(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
  })

  it('retries unacknowledged attacks without assigning a new sequence', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    const attack = {
      protocolVersion: 1 as const,
      attackId: 'retry-attack',
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      senderId: host.playerId,
      localSequence: 1,
      clientTimestamp: 1_000,
      kind: 'combo' as const,
      blocks: [{ width: 3, height: 1, type: 'normal' as const }],
    }
    store.orderAttack('socket-1', attack)

    clock.now = 1_749
    expect(store.getRetryableAttacks(750)).toEqual([])
    clock.now = 1_750
    expect(store.getRetryableAttacks(750)).toMatchObject([
      {
        targetSocketId: 'socket-2',
        event: {
          attackId: 'retry-attack',
          serverSequence: 1,
        },
      },
    ])
    expect(store.getRetryableAttacks(750)).toEqual([])

    store.acknowledgeAttack(
      'socket-2',
      guest.playerId,
      preparation.matchId,
      preparation.roundId,
      1,
    )
    clock.now = 3_000
    expect(store.getRetryableAttacks(750)).toEqual([])

    const duplicate = store.orderAttack('socket-1', attack)
    expect(duplicate.event.serverSequence).toBe(1)
  })

  it('replays pending attacks to a reconnected socket during resume', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }
    store.orderAttack('socket-1', {
      protocolVersion: 1,
      attackId: 'reconnect-attack',
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      senderId: host.playerId,
      localSequence: 1,
      clientTimestamp: 1_000,
      kind: 'combo',
      blocks: [{ width: 3, height: 1, type: 'normal' }],
    })

    store.markDisconnected('socket-2')
    clock.now = 2_000
    store.pauseForDisconnect(guest.roomState.roomId, guest.playerId)
    expect(
      store.getPendingAttacksForPlayer(
        guest.roomState.roomId,
        guest.playerId,
      ),
    ).toEqual([])

    clock.now = 2_500
    store.reconnect(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      'socket-2-new',
    )
    store.resumeAfterReconnect(guest.roomState.roomId)
    expect(
      store.getPendingAttacksForPlayer(
        guest.roomState.roomId,
        guest.playerId,
      ),
    ).toMatchObject([
      {
        targetSocketId: 'socket-2-new',
        event: {
          attackId: 'reconnect-attack',
          serverSequence: 1,
        },
      },
    ])
    expect(
      store.acknowledgeAttack(
        'socket-2-new',
        guest.playerId,
        preparation.matchId,
        preparation.roundId,
        1,
      ),
    ).toBe(true)
    expect(
      store.getPendingAttacksForPlayer(
        guest.roomState.roomId,
        guest.playerId,
      ),
    ).toEqual([])
  })

  it('records bounded per-player checksum timelines and detects conflicts', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }
    const report = {
      protocolVersion: 1 as const,
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      playerId: host.playerId,
      sequence: 1,
      simulationStep: 100,
      checksum: 'aaaaaaaa',
      clientTimestamp: 1_000,
    }

    expect(store.recordSimulationChecksum('socket-1', report)).toEqual({
      accepted: true,
      conflict: null,
    })
    expect(store.recordSimulationChecksum('socket-1', report)).toEqual({
      accepted: false,
      conflict: null,
    })
    expect(
      store.recordSimulationChecksum('socket-2', {
        ...report,
        playerId: guest.playerId,
        checksum: 'bbbbbbbb',
      }),
    ).toEqual({
      accepted: true,
      conflict: null,
    })
    expect(
      store.recordSimulationChecksum('socket-1', {
        ...report,
        sequence: 2,
        checksum: 'cccccccc',
      }),
    ).toEqual({
      accepted: false,
      conflict: {
        playerId: host.playerId,
        simulationStep: 100,
        previousChecksum: 'aaaaaaaa',
        reportedChecksum: 'cccccccc',
      },
    })

    for (let index = 0; index < 32; index += 1) {
      expect(
        store.recordSimulationChecksum('socket-1', {
          ...report,
          sequence: index + 2,
          simulationStep: index + 101,
          checksum: (index + 1).toString(16).padStart(8, '0'),
        }).accepted,
      ).toBe(true)
    }
    expect(
      store.recordSimulationChecksum('socket-1', {
        ...report,
        sequence: 34,
        checksum: 'dddddddd',
      }),
    ).toEqual({
      accepted: true,
      conflict: null,
    })
    expect(() =>
      store.recordSimulationChecksum('socket-1', {
        ...report,
        roundId: 'stale-round',
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_MATCH' }))
  })

  it('resolves one top-out after the draw window and awards the opponent', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    const report = store.reportTopOut(
      'socket-1',
      host.playerId,
      preparation.matchId,
      preparation.roundId,
    )
    expect(report).toEqual({
      resolution: null,
      resolveAt: 1_150,
    })

    clock.now = 1_149
    expect(
      store.resolvePendingTopOut(
        preparation.matchId,
        preparation.roundId,
      ),
    ).toBeNull()
    clock.now = 1_150
    const resolution = store.resolvePendingTopOut(
      preparation.matchId,
      preparation.roundId,
    )
    expect(resolution).toMatchObject({
      roundEnded: {
        result: 'win',
        winnerPlayerId: guest.playerId,
        loserPlayerId: host.playerId,
        scores: [
          { playerId: host.playerId, wins: 0 },
          { playerId: guest.playerId, wins: 1 },
        ],
      },
      matchEnded: null,
    })
  })

  it('marks top-outs within 150 ms as a scoreless draw', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    store.reportTopOut(
      'socket-1',
      host.playerId,
      preparation.matchId,
      preparation.roundId,
    )
    clock.now = 1_100
    const draw = store.reportTopOut(
      'socket-2',
      guest.playerId,
      preparation.matchId,
      preparation.roundId,
    )
    expect(draw.resolution).toMatchObject({
      roundEnded: {
        result: 'draw',
        winnerPlayerId: null,
        loserPlayerId: null,
        scores: [
          { wins: 0 },
          { wins: 0 },
        ],
      },
      matchEnded: null,
    })

    const hostReady = store.readyForNextRound(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
      preparation.matchId,
      preparation.roundId,
    )
    expect(hostReady.preparation).toBeNull()
    const replay = store.readyForNextRound(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      preparation.matchId,
      preparation.roundId,
    )
    expect(replay.preparation).toMatchObject({
      matchId: preparation.matchId,
      roundNumber: 1,
    })
    expect(replay.preparation?.roundId).not.toBe(preparation.roundId)
  })

  it('ends the match when one player wins two rounds', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    let preparation = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    ).preparation

    for (let round = 1; round <= 2; round += 1) {
      for (const player of [host, guest]) {
        store.markRoundReady(
          player.roomState.roomId,
          player.playerId,
          player.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        )
      }
      store.reportTopOut(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      )
      clock.now += 150
      const resolution = store.resolvePendingTopOut(
        preparation.matchId,
        preparation.roundId,
      )

      if (round === 1) {
        expect(resolution?.matchEnded).toBeNull()
        store.readyForNextRound(
          host.roomState.roomId,
          host.playerId,
          host.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        )
        const next = store.readyForNextRound(
          guest.roomState.roomId,
          guest.playerId,
          guest.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        )
        preparation = next.preparation!
        expect(preparation.roundNumber).toBe(2)
      } else {
        expect(resolution?.matchEnded).toMatchObject({
          winnerPlayerId: guest.playerId,
          scores: [
            { playerId: host.playerId, wins: 0 },
            { playerId: guest.playerId, wins: 2 },
          ],
        })
        expect(store.getById(host.roomState.roomId).status).toBe(
          'finished',
        )
      }
    }
  })

  it('starts a confirmed rematch with reset scores and swapped slots', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    let preparation = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    ).preparation

    for (let round = 1; round <= 2; round += 1) {
      for (const player of [host, guest]) {
        store.markRoundReady(
          player.roomState.roomId,
          player.playerId,
          player.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        )
      }
      store.reportTopOut(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      )
      clock.now += 150
      store.resolvePendingTopOut(
        preparation.matchId,
        preparation.roundId,
      )
      if (round === 1) {
        store.readyForNextRound(
          host.roomState.roomId,
          host.playerId,
          host.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        )
        preparation = store.readyForNextRound(
          guest.roomState.roomId,
          guest.playerId,
          guest.reconnectToken,
          preparation.matchId,
          preparation.roundId,
        ).preparation!
      }
    }

    const finishedMatchId = preparation.matchId
    expect(
      store.requestRematch(
        host.roomState.roomId,
        host.playerId,
        host.reconnectToken,
        finishedMatchId,
      ).preparation,
    ).toBeNull()
    const rematch = store.requestRematch(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      finishedMatchId,
    )

    expect(rematch.preparation).toMatchObject({
      roundNumber: 1,
    })
    expect(rematch.preparation?.matchId).not.toBe(finishedMatchId)
    expect(rematch.roomState).toMatchObject({
      status: 'starting',
      players: [
        { playerId: guest.playerId, slot: 1, ready: false },
        { playerId: host.playerId, slot: 2, ready: false },
      ],
    })

    const rematchPreparation = rematch.preparation!
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        rematchPreparation.matchId,
        rematchPreparation.roundId,
      )
    }
    store.reportTopOut(
      'socket-1',
      host.playerId,
      rematchPreparation.matchId,
      rematchPreparation.roundId,
    )
    clock.now += 150
    const firstRematchWin = store.resolvePendingTopOut(
      rematchPreparation.matchId,
      rematchPreparation.roundId,
    )
    expect(firstRematchWin?.roundEnded.scores).toEqual([
      { playerId: guest.playerId, wins: 1 },
      { playerId: host.playerId, wins: 0 },
    ])
    expect(firstRematchWin?.matchEnded).toBeNull()
  })

  it('pauses a live round and resumes it on one shared timestamp', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const preparation = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    ).preparation
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }
    clock.now = 4_000
    const [disconnected] = store.markDisconnected('socket-2')
    expect(disconnected).toMatchObject({
      playerId: guest.playerId,
      activeRound: {
        matchId: preparation.matchId,
        roundId: preparation.roundId,
      },
    })

    clock.now = 5_000
    const paused = store.pauseForDisconnect(
      guest.roomState.roomId,
      guest.playerId,
    )
    expect(paused).toMatchObject({
      disconnectedPlayerId: guest.playerId,
      forfeitAt: 35_000,
    })
    expect(() =>
      store.authorizeGameplayEvent(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_MATCH' }))

    clock.now = 6_000
    store.reconnect(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      'socket-2-new',
    )
    const resuming = store.resumeAfterReconnect(guest.roomState.roomId)
    expect(resuming).toMatchObject({ resumeAt: 9_000 })

    clock.now = 8_999
    expect(() =>
      store.authorizeGameplayEvent(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_MATCH' }))
    clock.now = 9_000
    expect(
      store.authorizeGameplayEvent(
        'socket-1',
        host.playerId,
        preparation.matchId,
        preparation.roundId,
      ),
    ).toMatchObject({ targetPlayerId: guest.playerId })
  })

  it('does not pause when a player reconnects within the grace second', () => {
    const store = createStore()
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const preparation = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    ).preparation
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    store.markDisconnected('socket-2')
    store.reconnect(
      guest.roomState.roomId,
      guest.playerId,
      guest.reconnectToken,
      'socket-new',
    )
    expect(
      store.pauseForDisconnect(
        guest.roomState.roomId,
        guest.playerId,
      ),
    ).toBeNull()
  })

  it('awards the round when a disconnected player times out', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const preparation = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    ).preparation
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    clock.now = 4_000
    store.markDisconnected('socket-2')
    clock.now = 5_000
    store.pauseForDisconnect(guest.roomState.roomId, guest.playerId)
    clock.now = 35_000
    const resolution = store.forfeitDisconnected(
      guest.roomState.roomId,
      guest.playerId,
    )
    expect(resolution).toMatchObject({
      roundEnded: {
        winnerPlayerId: host.playerId,
        loserPlayerId: guest.playerId,
        scores: [
          { playerId: host.playerId, wins: 1 },
          { playerId: guest.playerId, wins: 0 },
        ],
      },
    })
  })

  it('returns the settled result for a top-out reported after the round ended', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)
    const host = store.create('Mira', 'socket-1')
    const guest = store.join('ROOM01', 'Noah', 'socket-2')
    for (const player of [host, guest]) {
      store.setReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        true,
      )
    }
    const { preparation } = store.startMatch(
      host.roomState.roomId,
      host.playerId,
      host.reconnectToken,
    )
    for (const player of [host, guest]) {
      store.markRoundReady(
        player.roomState.roomId,
        player.playerId,
        player.reconnectToken,
        preparation.matchId,
        preparation.roundId,
      )
    }

    store.reportTopOut(
      'socket-1',
      host.playerId,
      preparation.matchId,
      preparation.roundId,
    )
    clock.now = 1_150
    store.resolvePendingTopOut(
      preparation.matchId,
      preparation.roundId,
    )

    // The loser's own board tops out a moment after the round was already
    // settled. That is an ordinary end-of-round race, not an error: the
    // report should come back with the settled result.
    clock.now = 1_400
    const late = store.reportTopOut(
      'socket-2',
      guest.playerId,
      preparation.matchId,
      preparation.roundId,
    )
    expect(late.resolveAt).toBeNull()
    expect(late.resolution).toMatchObject({
      roundEnded: {
        result: 'win',
        winnerPlayerId: guest.playerId,
        loserPlayerId: host.playerId,
      },
    })
  })
})
