import { randomBytes, randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  type AttackEvent,
  type OrderedAttackEvent,
  type PlayerSession,
  type MatchEnded,
  type MatchPaused,
  type MatchResuming,
  type RoomError,
  type RoomSession,
  type RoomState,
  type RoundPreparation,
  type RoundEnded,
  type RoundStarting,
  type SimulationChecksumReport,
} from '@swapduel/contracts'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_CHECKSUM_HISTORY_PER_PLAYER = 32

interface StoredPlayer extends PlayerSession {
  reconnectToken: string
  socketId: string
  disconnectedAt: number | null
}

interface StoredRoom {
  roomId: string
  roomCode: string
  hostPlayerId: string
  players: StoredPlayer[]
  status: RoomState['status']
  activeMatchId: string | null
  activeRound: StoredRound | null
  matchScores: Map<string, number> | null
  matchEndedResult: MatchEnded | null
  nextRoundReadyPlayerIds: Set<string>
  rematchReadyPlayerIds: Set<string>
  rematchCount: number
  updatedAt: number
}

interface StoredRound {
  preparation: RoundPreparation
  readyPlayerIds: Set<string>
  startAt: number | null
  nextServerSequence: number
  orderedAttacksById: Map<string, OrderedAttackEvent>
  attackDeliveriesBySequence: Map<number, AttackDeliveryState>
  acknowledgedAttackSequences: Set<number>
  checksumsByPlayerId: Map<string, Map<number, StoredChecksum>>
  lastChecksumSequenceByPlayerId: Map<string, number>
  topOutReports: Map<string, number>
  endedResult: RoundEnded | null
  networkPausedAt: number | null
  pausedForPlayerId: string | null
  forfeitAt: number | null
  resumeAt: number | null
}

interface AttackDeliveryState {
  attempts: number
  lastSentAt: number
}

interface StoredChecksum {
  sequence: number
  checksum: string
}

export interface ChecksumConflict {
  playerId: string
  simulationStep: number
  previousChecksum: string
  reportedChecksum: string
}

export interface PendingAttackDelivery {
  event: OrderedAttackEvent
  targetSocketId: string
}

export interface RoundResolution {
  roundEnded: RoundEnded
  matchEnded: MatchEnded | null
}

export interface RoundRecovery {
  preparation: RoundPreparation
  starting: RoundStarting | null
  roundEnded: RoundEnded | null
  matchEnded: MatchEnded | null
}

export interface DisconnectedPlayer {
  roomState: RoomState
  playerId: string
  activeRound:
    | {
        matchId: string
        roundId: string
      }
    | null
}

export interface ExpiredRoom {
  roomId: string
  roomCode: string
  playerIds: string[]
  activeMatchId: string | null
  activeRoundId: string | null
}

export interface RoomCleanupResult {
  expiredRooms: ExpiredRoom[]
  updatedRooms: RoomState[]
}

export class RoomStoreError extends Error {
  readonly code: RoomError['code']

  constructor(code: RoomError['code'], message: string) {
    super(message)
    this.name = 'RoomStoreError'
    this.code = code
  }
}

export interface RoomStoreOptions {
  now?: () => number
  createId?: () => string
  createToken?: () => string
  createRoomCode?: () => string
  createRoundSeed?: () => string
  countdownLeadMs?: number
  simultaneousTopOutWindowMs?: number
  disconnectForfeitMs?: number
  reconnectCountdownMs?: number
  waitingReservationMs?: number
  roomInactivityMs?: number
}

export class RoomStore {
  private readonly roomsById = new Map<string, StoredRoom>()
  private readonly roomIdsByCode = new Map<string, string>()
  private readonly now: () => number
  private readonly createId: () => string
  private readonly createToken: () => string
  private readonly createRoomCode: () => string
  private readonly createRoundSeed: () => string
  private readonly countdownLeadMs: number
  private readonly simultaneousTopOutWindowMs: number
  private readonly disconnectForfeitMs: number
  private readonly reconnectCountdownMs: number
  private readonly waitingReservationMs: number
  private readonly roomInactivityMs: number

  constructor(options: RoomStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.createToken =
      options.createToken ?? (() => randomBytes(24).toString('base64url'))
    this.createRoomCode =
      options.createRoomCode ?? (() => this.generateRoomCode())
    this.createRoundSeed =
      options.createRoundSeed ?? (() => randomBytes(16).toString('hex'))
    this.countdownLeadMs = options.countdownLeadMs ?? 4_000
    this.simultaneousTopOutWindowMs =
      options.simultaneousTopOutWindowMs ?? 150
    this.disconnectForfeitMs = options.disconnectForfeitMs ?? 30_000
    this.reconnectCountdownMs = options.reconnectCountdownMs ?? 3_000
    this.waitingReservationMs =
      options.waitingReservationMs ?? 5 * 60_000
    this.roomInactivityMs =
      options.roomInactivityMs ?? 2 * 60 * 60_000
  }

  create(displayName: string, socketId: string): RoomSession {
    const roomId = this.createId()
    const playerId = this.createId()
    const reconnectToken = this.createToken()
    const roomCode = this.nextUniqueRoomCode()
    const player: StoredPlayer = {
      playerId,
      roomId,
      displayName,
      slot: 1,
      connected: true,
      ready: false,
      reconnectToken,
      socketId,
      disconnectedAt: null,
    }
    const room: StoredRoom = {
      roomId,
      roomCode,
      hostPlayerId: playerId,
      players: [player],
      status: 'waiting',
      activeMatchId: null,
      activeRound: null,
      matchScores: null,
      matchEndedResult: null,
      nextRoundReadyPlayerIds: new Set(),
      rematchReadyPlayerIds: new Set(),
      rematchCount: 0,
      updatedAt: this.now(),
    }

    this.roomsById.set(roomId, room)
    this.roomIdsByCode.set(roomCode, roomId)

    return {
      roomState: this.toRoomState(room),
      playerId,
      reconnectToken,
    }
  }

  join(
    roomCode: string,
    displayName: string,
    socketId: string,
  ): RoomSession {
    const room = this.getStoredRoomByCode(roomCode)
    if (room.status !== 'waiting') {
      throw new RoomStoreError(
        'ROOM_NOT_WAITING',
        'This room is no longer accepting players.',
      )
    }
    if (room.players.length >= 2) {
      throw new RoomStoreError('ROOM_FULL', 'This room already has two players.')
    }

    const playerId = this.createId()
    const reconnectToken = this.createToken()
    room.players.push({
      playerId,
      roomId: room.roomId,
      displayName,
      slot: 2,
      connected: true,
      ready: false,
      reconnectToken,
      socketId,
      disconnectedAt: null,
    })
    room.updatedAt = this.now()

    return {
      roomState: this.toRoomState(room),
      playerId,
      reconnectToken,
    }
  }

  reconnect(
    roomId: string,
    playerId: string,
    reconnectToken: string,
    socketId: string,
  ): RoomSession {
    const { room, player } = this.authorize(
      roomId,
      playerId,
      reconnectToken,
    )
    player.socketId = socketId
    player.connected = true
    player.disconnectedAt = null
    room.updatedAt = this.now()

    return {
      roomState: this.toRoomState(room),
      playerId,
      reconnectToken,
    }
  }

  getRoundRecovery(
    roomId: string,
    playerId: string,
    reconnectToken: string,
  ): RoundRecovery | null {
    const { room } = this.authorize(roomId, playerId, reconnectToken)
    const activeRound = room.activeRound
    if (activeRound === null) return null

    return {
      preparation: activeRound.preparation,
      starting:
        activeRound.startAt === null
          ? null
          : {
              ...activeRound.preparation,
              startAt: activeRound.startAt,
            },
      roundEnded: activeRound.endedResult,
      matchEnded: room.matchEndedResult,
    }
  }

  setReady(
    roomId: string,
    playerId: string,
    reconnectToken: string,
    ready: boolean,
  ): RoomState {
    const { room, player } = this.authorize(
      roomId,
      playerId,
      reconnectToken,
    )
    if (room.status !== 'waiting') {
      throw new RoomStoreError(
        'ROOM_NOT_WAITING',
        'Ready state can only change before a match.',
      )
    }

    player.ready = ready
    room.updatedAt = this.now()
    return this.toRoomState(room)
  }

  startMatch(
    roomId: string,
    playerId: string,
    reconnectToken: string,
  ): {
    roomState: RoomState
    preparation: RoundPreparation
  } {
    const { room } = this.authorize(roomId, playerId, reconnectToken)
    if (playerId !== room.hostPlayerId) {
      throw new RoomStoreError(
        'HOST_ONLY',
        'Only the room host can start the match.',
      )
    }
    if (room.status !== 'waiting') {
      throw new RoomStoreError(
        'ROOM_NOT_WAITING',
        'This room has already started.',
      )
    }
    if (
      room.players.length !== 2 ||
      !room.players.every((player) => player.connected && player.ready)
    ) {
      throw new RoomStoreError(
        'PLAYERS_NOT_READY',
        'Both connected players must be ready.',
      )
    }

    const matchId = this.createId()
    const roundId = this.createId()
    const preparation: RoundPreparation = {
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      matchId,
      roundId,
      roundNumber: 1,
      roundSeed: this.createRoundSeed(),
    }
    room.status = 'starting'
    room.activeMatchId = matchId
    room.activeRound = this.createStoredRound(preparation)
    room.matchScores = new Map(
      room.players.map((player) => [player.playerId, 0]),
    )
    room.matchEndedResult = null
    room.nextRoundReadyPlayerIds.clear()
    room.rematchReadyPlayerIds.clear()
    room.updatedAt = this.now()

    return {
      roomState: this.toRoomState(room),
      preparation,
    }
  }

  markRoundReady(
    roomId: string,
    playerId: string,
    reconnectToken: string,
    matchId: string,
    roundId: string,
  ): {
    roomState: RoomState
    starting: RoundStarting | null
  } {
    const { room } = this.authorize(roomId, playerId, reconnectToken)
    const activeRound = room.activeRound
    if (
      activeRound === null ||
      activeRound.preparation.matchId !== matchId ||
      activeRound.preparation.roundId !== roundId ||
      activeRound.endedResult !== null
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'This round is no longer active.',
      )
    }

    activeRound.readyPlayerIds.add(playerId)
    if (
      activeRound.readyPlayerIds.size < room.players.length &&
      activeRound.startAt === null
    ) {
      return {
        roomState: this.toRoomState(room),
        starting: null,
      }
    }

    if (activeRound.startAt === null) {
      activeRound.startAt = this.now() + this.countdownLeadMs
      room.status = 'playing'
      room.updatedAt = this.now()
    }

    return {
      roomState: this.toRoomState(room),
      starting: {
        ...activeRound.preparation,
        startAt: activeRound.startAt,
      },
    }
  }

  authorizeGameplayEvent(
    socketId: string,
    playerId: string,
    matchId: string,
    roundId: string,
    options: { allowSettledRound?: boolean } = {},
  ): { roomId: string; targetPlayerId: string } {
    const room = [...this.roomsById.values()].find(
      (candidate) => candidate.activeMatchId === matchId,
    )
    const activeRound = room?.activeRound
    if (
      room === undefined ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.preparation.roundId !== roundId
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'This gameplay event belongs to an inactive round.',
      )
    }

    // A settled round still authorizes a late report from the round it
    // settled. A losing board frequently tops out a moment after the round
    // was already decided, and that race is ordinary, not an error.
    const roundIsSettled = activeRound.endedResult !== null
    if (
      !(options.allowSettledRound === true && roundIsSettled) &&
      (activeRound.endedResult !== null ||
        activeRound.startAt === null ||
        room.status !== 'playing' ||
        activeRound.networkPausedAt !== null ||
        (activeRound.resumeAt !== null &&
          this.now() < activeRound.resumeAt))
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'This gameplay event belongs to an inactive round.',
      )
    }

    const player = room.players.find(
      (candidate) =>
        candidate.playerId === playerId &&
        candidate.socketId === socketId &&
        candidate.connected,
    )
    if (player === undefined) {
      throw new RoomStoreError(
        'UNAUTHORIZED',
        'The gameplay sender could not be verified.',
      )
    }

    const target = room.players.find(
      (candidate) => candidate.playerId !== playerId,
    )
    if (target === undefined) {
      throw new RoomStoreError(
        'PLAYERS_NOT_READY',
        'The opponent is not available.',
      )
    }

    room.updatedAt = this.now()
    return {
      roomId: room.roomId,
      targetPlayerId: target.playerId,
    }
  }

  orderAttack(
    socketId: string,
    attack: AttackEvent,
  ): {
    event: OrderedAttackEvent
    targetSocketId: string
    duplicate: boolean
  } {
    const authorization = this.authorizeGameplayEvent(
      socketId,
      attack.senderId,
      attack.matchId,
      attack.roundId,
    )
    const room = this.roomsById.get(authorization.roomId)!
    const activeRound = room.activeRound!
    const target = room.players.find(
      (player) => player.playerId === authorization.targetPlayerId,
    )!
    const existing = activeRound.orderedAttacksById.get(attack.attackId)
    if (existing !== undefined) {
      this.markAttackSent(activeRound, existing.serverSequence)
      return {
        event: existing,
        targetSocketId: target.socketId,
        duplicate: true,
      }
    }

    const event: OrderedAttackEvent = {
      ...attack,
      targetId: target.playerId,
      serverSequence: activeRound.nextServerSequence,
      serverTimestamp: this.now(),
    }
    activeRound.nextServerSequence += 1
    activeRound.orderedAttacksById.set(event.attackId, event)
    this.markAttackSent(activeRound, event.serverSequence)
    room.updatedAt = this.now()

    return {
      event,
      targetSocketId: target.socketId,
      duplicate: false,
    }
  }

  acknowledgeAttack(
    socketId: string,
    playerId: string,
    matchId: string,
    roundId: string,
    serverSequence: number,
  ): boolean {
    const room = [...this.roomsById.values()].find(
      (candidate) => candidate.activeMatchId === matchId,
    )
    const activeRound = room?.activeRound
    if (
      room === undefined ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.preparation.roundId !== roundId ||
      activeRound.endedResult !== null
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'This attack belongs to an inactive round.',
      )
    }
    const player = room.players.find(
      (candidate) =>
        candidate.playerId === playerId &&
        candidate.socketId === socketId &&
        candidate.connected,
    )
    if (player === undefined) {
      throw new RoomStoreError(
        'UNAUTHORIZED',
        'The attack recipient could not be verified.',
      )
    }
    const event = [...activeRound.orderedAttacksById.values()].find(
      (candidate) => candidate.serverSequence === serverSequence,
    )
    if (event === undefined || event.targetId !== playerId) {
      throw new RoomStoreError(
        'UNAUTHORIZED',
        'This attack acknowledgement is not valid for the player.',
      )
    }

    const isNew = !activeRound.acknowledgedAttackSequences.has(
      serverSequence,
    )
    activeRound.acknowledgedAttackSequences.add(serverSequence)
    room.updatedAt = this.now()
    return isNew
  }

  getRetryableAttacks(retryAfterMs: number): PendingAttackDelivery[] {
    const now = this.now()
    const deliveries: PendingAttackDelivery[] = []
    for (const room of this.roomsById.values()) {
      const activeRound = room.activeRound
      if (
        room.status !== 'playing' ||
        activeRound === null ||
        activeRound.endedResult !== null
      ) {
        continue
      }

      for (const event of activeRound.orderedAttacksById.values()) {
        if (
          activeRound.acknowledgedAttackSequences.has(
            event.serverSequence,
          )
        ) {
          continue
        }
        const delivery = activeRound.attackDeliveriesBySequence.get(
          event.serverSequence,
        )
        if (
          delivery !== undefined &&
          now - delivery.lastSentAt < retryAfterMs
        ) {
          continue
        }
        const target = room.players.find(
          (player) => player.playerId === event.targetId,
        )
        if (target?.connected !== true) continue

        this.markAttackSent(activeRound, event.serverSequence)
        deliveries.push({
          event,
          targetSocketId: target.socketId,
        })
      }
    }
    return deliveries
  }

  getPendingAttacksForPlayer(
    roomId: string,
    playerId: string,
  ): PendingAttackDelivery[] {
    const room = this.roomsById.get(roomId)
    const activeRound = room?.activeRound
    const player = room?.players.find(
      (candidate) => candidate.playerId === playerId,
    )
    if (
      room === undefined ||
      room.status !== 'playing' ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.endedResult !== null ||
      player?.connected !== true
    ) {
      return []
    }

    return [...activeRound.orderedAttacksById.values()]
      .filter(
        (event) =>
          event.targetId === playerId &&
          !activeRound.acknowledgedAttackSequences.has(
            event.serverSequence,
          ),
      )
      .sort(
        (left, right) => left.serverSequence - right.serverSequence,
      )
      .map((event) => {
        this.markAttackSent(activeRound, event.serverSequence)
        return {
          event,
          targetSocketId: player.socketId,
        }
      })
  }

  recordSimulationChecksum(
    socketId: string,
    report: SimulationChecksumReport,
  ): {
    accepted: boolean
    conflict: ChecksumConflict | null
  } {
    const authorization = this.authorizeGameplayEvent(
      socketId,
      report.playerId,
      report.matchId,
      report.roundId,
    )
    const room = this.roomsById.get(authorization.roomId)!
    const activeRound = room.activeRound!
    let checksums = activeRound.checksumsByPlayerId.get(report.playerId)
    if (checksums === undefined) {
      checksums = new Map()
      activeRound.checksumsByPlayerId.set(report.playerId, checksums)
    }

    const existing = checksums.get(report.simulationStep)
    if (existing !== undefined) {
      return {
        accepted: false,
        conflict:
          existing.checksum === report.checksum
            ? null
            : {
                playerId: report.playerId,
                simulationStep: report.simulationStep,
                previousChecksum: existing.checksum,
                reportedChecksum: report.checksum,
              },
      }
    }

    const lastSequence =
      activeRound.lastChecksumSequenceByPlayerId.get(report.playerId) ??
      -1
    if (report.sequence <= lastSequence) {
      return { accepted: false, conflict: null }
    }

    checksums.set(report.simulationStep, {
      sequence: report.sequence,
      checksum: report.checksum,
    })
    activeRound.lastChecksumSequenceByPlayerId.set(
      report.playerId,
      report.sequence,
    )
    while (checksums.size > MAX_CHECKSUM_HISTORY_PER_PLAYER) {
      const oldestStep = checksums.keys().next().value
      if (oldestStep === undefined) break
      checksums.delete(oldestStep)
    }
    room.updatedAt = this.now()
    return { accepted: true, conflict: null }
  }

  reportTopOut(
    socketId: string,
    playerId: string,
    matchId: string,
    roundId: string,
  ): {
    resolution: RoundResolution | null
    resolveAt: number | null
  } {
    const authorization = this.authorizeGameplayEvent(
      socketId,
      playerId,
      matchId,
      roundId,
      { allowSettledRound: true },
    )
    const room = this.roomsById.get(authorization.roomId)!
    const activeRound = room.activeRound!
    if (activeRound.endedResult !== null) {
      return {
        resolution: {
          roundEnded: activeRound.endedResult,
          matchEnded: room.matchEndedResult,
        },
        resolveAt: null,
      }
    }
    if (room.status !== 'playing' || activeRound.startAt === null) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'The round has not started.',
      )
    }

    if (!activeRound.topOutReports.has(playerId)) {
      activeRound.topOutReports.set(playerId, this.now())
    }
    const reports = [...activeRound.topOutReports.entries()].sort(
      (left, right) => left[1] - right[1],
    )

    if (reports.length >= 2) {
      const first = reports[0]!
      const second = reports[1]!
      const winnerPlayerId =
        second[1] - first[1] <= this.simultaneousTopOutWindowMs
          ? null
          : room.players.find(
              (player) => player.playerId !== first[0],
            )!.playerId
      return {
        resolution: this.finalizeRound(room, winnerPlayerId),
        resolveAt: null,
      }
    }

    return {
      resolution: null,
      resolveAt:
        reports[0]![1] + this.simultaneousTopOutWindowMs,
    }
  }

  resolvePendingTopOut(
    matchId: string,
    roundId: string,
  ): RoundResolution | null {
    const room = [...this.roomsById.values()].find(
      (candidate) => candidate.activeMatchId === matchId,
    )
    const activeRound = room?.activeRound
    if (
      room === undefined ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.preparation.roundId !== roundId ||
      activeRound.endedResult !== null
    ) {
      return null
    }

    const reports = [...activeRound.topOutReports.entries()]
    if (reports.length !== 1) return null
    const [loserPlayerId, reportedAt] = reports[0]!
    if (
      this.now() <
      reportedAt + this.simultaneousTopOutWindowMs
    ) {
      return null
    }
    const winnerPlayerId = room.players.find(
      (player) => player.playerId !== loserPlayerId,
    )!.playerId
    return this.finalizeRound(room, winnerPlayerId)
  }

  readyForNextRound(
    roomId: string,
    playerId: string,
    reconnectToken: string,
    matchId: string,
    roundId: string,
  ): {
    roomState: RoomState
    preparation: RoundPreparation | null
  } {
    const { room } = this.authorize(roomId, playerId, reconnectToken)
    const activeRound = room.activeRound
    if (
      room.activeMatchId !== matchId ||
      activeRound === null ||
      activeRound.preparation.roundId !== roundId ||
      activeRound.endedResult === null ||
      room.matchEndedResult !== null
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'The next round is not available.',
      )
    }

    room.nextRoundReadyPlayerIds.add(playerId)
    if (room.nextRoundReadyPlayerIds.size < room.players.length) {
      return {
        roomState: this.toRoomState(room),
        preparation: null,
      }
    }

    const roundNumber =
      activeRound.endedResult.result === 'draw'
        ? activeRound.preparation.roundNumber
        : activeRound.preparation.roundNumber + 1
    const preparation: RoundPreparation = {
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      matchId,
      roundId: this.createId(),
      roundNumber,
      roundSeed: this.createRoundSeed(),
    }
    room.activeRound = this.createStoredRound(preparation)
    room.nextRoundReadyPlayerIds.clear()
    room.status = 'starting'
    room.updatedAt = this.now()

    return {
      roomState: this.toRoomState(room),
      preparation,
    }
  }

  requestRematch(
    roomId: string,
    playerId: string,
    reconnectToken: string,
    matchId: string,
  ): {
    roomState: RoomState
    preparation: RoundPreparation | null
  } {
    const { room } = this.authorize(roomId, playerId, reconnectToken)
    if (
      room.activeMatchId !== matchId ||
      room.matchEndedResult === null ||
      room.status !== 'finished'
    ) {
      throw new RoomStoreError(
        'STALE_MATCH',
        'This match is not available for a rematch.',
      )
    }

    room.rematchReadyPlayerIds.add(playerId)
    if (room.rematchReadyPlayerIds.size < room.players.length) {
      return {
        roomState: this.toRoomState(room),
        preparation: null,
      }
    }

    room.rematchCount += 1
    for (const player of room.players) {
      player.slot = player.slot === 1 ? 2 : 1
      player.ready = false
    }
    room.players.sort((left, right) => left.slot - right.slot)

    const nextMatchId = this.createId()
    const preparation: RoundPreparation = {
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      matchId: nextMatchId,
      roundId: this.createId(),
      roundNumber: 1,
      roundSeed: this.createRoundSeed(),
    }
    room.status = 'starting'
    room.activeMatchId = nextMatchId
    room.activeRound = this.createStoredRound(preparation)
    room.matchScores = new Map(
      room.players.map((player) => [player.playerId, 0]),
    )
    room.matchEndedResult = null
    room.nextRoundReadyPlayerIds.clear()
    room.rematchReadyPlayerIds.clear()
    room.updatedAt = this.now()

    return {
      roomState: this.toRoomState(room),
      preparation,
    }
  }

  pauseForDisconnect(
    roomId: string,
    playerId: string,
  ): MatchPaused | null {
    const room = this.roomsById.get(roomId)
    const player = room?.players.find(
      (candidate) => candidate.playerId === playerId,
    )
    const activeRound = room?.activeRound
    if (
      room === undefined ||
      player === undefined ||
      player.connected ||
      room.status !== 'playing' ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.endedResult !== null
    ) {
      return null
    }

    if (activeRound.networkPausedAt === null) {
      activeRound.networkPausedAt = this.now()
      activeRound.pausedForPlayerId = playerId
      activeRound.forfeitAt = this.now() + this.disconnectForfeitMs
      activeRound.resumeAt = null
      room.updatedAt = this.now()
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      matchId: activeRound.preparation.matchId,
      roundId: activeRound.preparation.roundId,
      disconnectedPlayerId: activeRound.pausedForPlayerId!,
      forfeitAt: activeRound.forfeitAt!,
    }
  }

  resumeAfterReconnect(
    roomId: string,
  ): MatchResuming | null {
    const room = this.roomsById.get(roomId)
    const activeRound = room?.activeRound
    if (
      room === undefined ||
      activeRound === null ||
      activeRound === undefined ||
      activeRound.networkPausedAt === null ||
      activeRound.endedResult !== null ||
      room.players.some((player) => !player.connected)
    ) {
      return null
    }

    activeRound.networkPausedAt = null
    activeRound.pausedForPlayerId = null
    activeRound.forfeitAt = null
    activeRound.resumeAt = this.now() + this.reconnectCountdownMs
    room.updatedAt = this.now()
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      matchId: activeRound.preparation.matchId,
      roundId: activeRound.preparation.roundId,
      resumeAt: activeRound.resumeAt,
    }
  }

  forfeitDisconnected(
    roomId: string,
    playerId: string,
  ): RoundResolution | null {
    const room = this.roomsById.get(roomId)
    const activeRound = room?.activeRound
    const forfeitingPlayer = room?.players.find(
      (player) => player.playerId === playerId,
    )
    if (
      room === undefined ||
      activeRound === null ||
      activeRound === undefined ||
      forfeitingPlayer === undefined ||
      forfeitingPlayer.connected ||
      activeRound.endedResult !== null ||
      activeRound.networkPausedAt === null
    ) {
      return null
    }

    const opponent = room.players.find(
      (player) => player.playerId !== playerId,
    )
    const winnerPlayerId =
      opponent?.connected === true ? opponent.playerId : null
    return this.finalizeRound(room, winnerPlayerId)
  }

  markDisconnected(socketId: string): DisconnectedPlayer[] {
    const changedPlayers: DisconnectedPlayer[] = []
    for (const room of this.roomsById.values()) {
      const player = room.players.find(
        (candidate) =>
          candidate.socketId === socketId && candidate.connected,
      )
      if (player === undefined) continue

      player.connected = false
      player.ready = false
      player.disconnectedAt = this.now()
      room.updatedAt = this.now()
      changedPlayers.push({
        roomState: this.toRoomState(room),
        playerId: player.playerId,
        activeRound:
          room.status === 'playing' && room.activeRound !== null
            ? {
                matchId: room.activeRound.preparation.matchId,
                roundId: room.activeRound.preparation.roundId,
              }
            : null,
      })
    }
    return changedPlayers
  }

  cleanupExpiredRooms(): RoomCleanupResult {
    const now = this.now()
    const expiredRooms: ExpiredRoom[] = []
    const updatedRooms: RoomState[] = []

    for (const room of [...this.roomsById.values()]) {
      if (now - room.updatedAt >= this.roomInactivityMs) {
        expiredRooms.push(this.removeRoom(room))
        continue
      }

      if (room.status === 'waiting') {
        const retainedPlayers = room.players.filter(
          (player) =>
            player.connected ||
            player.disconnectedAt === null ||
            now - player.disconnectedAt < this.waitingReservationMs,
        )
        if (retainedPlayers.length !== room.players.length) {
          if (retainedPlayers.length === 0) {
            expiredRooms.push(this.removeRoom(room))
            continue
          }
          room.players = retainedPlayers
          room.players
            .sort((left, right) => left.slot - right.slot)
            .forEach((player, index) => {
              player.slot = index === 0 ? 1 : 2
            })
          if (
            !room.players.some(
              (player) => player.playerId === room.hostPlayerId,
            )
          ) {
            room.hostPlayerId = room.players[0]!.playerId
          }
          room.updatedAt = now
          updatedRooms.push(this.toRoomState(room))
        }
        continue
      }

      if (
        room.players.length > 0 &&
        room.players.every(
          (player) =>
            !player.connected &&
            player.disconnectedAt !== null &&
            now - player.disconnectedAt >= this.waitingReservationMs,
        )
      ) {
        expiredRooms.push(this.removeRoom(room))
      }
    }

    return { expiredRooms, updatedRooms }
  }

  getById(roomId: string): RoomState {
    const room = this.roomsById.get(roomId)
    if (room === undefined) {
      throw new RoomStoreError('ROOM_NOT_FOUND', 'Room not found.')
    }
    return this.toRoomState(room)
  }

  private authorize(
    roomId: string,
    playerId: string,
    reconnectToken: string,
  ): { room: StoredRoom; player: StoredPlayer } {
    const room = this.roomsById.get(roomId)
    const player = room?.players.find(
      (candidate) =>
        candidate.playerId === playerId &&
        candidate.reconnectToken === reconnectToken,
    )
    if (room === undefined || player === undefined) {
      throw new RoomStoreError(
        'UNAUTHORIZED',
        'The room session could not be verified.',
      )
    }
    room.updatedAt = this.now()
    return { room, player }
  }

  private createStoredRound(
    preparation: RoundPreparation,
  ): StoredRound {
    return {
      preparation,
      readyPlayerIds: new Set(),
      startAt: null,
      nextServerSequence: 1,
      orderedAttacksById: new Map(),
      attackDeliveriesBySequence: new Map(),
      acknowledgedAttackSequences: new Set(),
      checksumsByPlayerId: new Map(),
      lastChecksumSequenceByPlayerId: new Map(),
      topOutReports: new Map(),
      endedResult: null,
      networkPausedAt: null,
      pausedForPlayerId: null,
      forfeitAt: null,
      resumeAt: null,
    }
  }

  private markAttackSent(
    round: StoredRound,
    serverSequence: number,
  ): void {
    const previous = round.attackDeliveriesBySequence.get(serverSequence)
    round.attackDeliveriesBySequence.set(serverSequence, {
      attempts: (previous?.attempts ?? 0) + 1,
      lastSentAt: this.now(),
    })
  }

  private removeRoom(room: StoredRoom): ExpiredRoom {
    this.roomsById.delete(room.roomId)
    this.roomIdsByCode.delete(room.roomCode)
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      playerIds: room.players.map((player) => player.playerId),
      activeMatchId: room.activeMatchId,
      activeRoundId: room.activeRound?.preparation.roundId ?? null,
    }
  }

  private finalizeRound(
    room: StoredRoom,
    winnerPlayerId: string | null,
  ): RoundResolution {
    const activeRound = room.activeRound!
    const matchId = room.activeMatchId!
    const scores = room.matchScores!
    if (winnerPlayerId !== null) {
      scores.set(winnerPlayerId, (scores.get(winnerPlayerId) ?? 0) + 1)
    }
    const scoreEntries = room.players.map((player) => ({
      playerId: player.playerId,
      wins: scores.get(player.playerId) ?? 0,
    }))
    const loserPlayerId =
      winnerPlayerId === null
        ? null
        : room.players.find(
            (player) => player.playerId !== winnerPlayerId,
          )!.playerId
    const roundEnded: RoundEnded = {
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      matchId,
      roundId: activeRound.preparation.roundId,
      roundNumber: activeRound.preparation.roundNumber,
      result: winnerPlayerId === null ? 'draw' : 'win',
      winnerPlayerId,
      loserPlayerId,
      scores: scoreEntries,
    }
    activeRound.endedResult = roundEnded
    const winnerScore =
      winnerPlayerId === null ? 0 : (scores.get(winnerPlayerId) ?? 0)
    const matchEnded =
      winnerPlayerId !== null && winnerScore >= 2
        ? {
            protocolVersion: PROTOCOL_VERSION,
            roomId: room.roomId,
            matchId,
            finalRoundId: activeRound.preparation.roundId,
            winnerPlayerId,
            scores: scoreEntries,
          }
        : null
    room.matchEndedResult = matchEnded
    room.status = matchEnded === null ? 'starting' : 'finished'
    room.updatedAt = this.now()

    return { roundEnded, matchEnded }
  }

  private getStoredRoomByCode(roomCode: string): StoredRoom {
    const roomId = this.roomIdsByCode.get(roomCode)
    const room = roomId === undefined ? undefined : this.roomsById.get(roomId)
    if (room === undefined) {
      throw new RoomStoreError('ROOM_NOT_FOUND', 'Room not found.')
    }
    return room
  }

  private nextUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const roomCode = this.createRoomCode()
      if (!this.roomIdsByCode.has(roomCode)) return roomCode
    }
    throw new Error('Unable to generate a unique room code.')
  }

  private generateRoomCode(): string {
    const bytes = randomBytes(6)
    return [...bytes]
      .map((byte) => ROOM_CODE_ALPHABET[byte! % ROOM_CODE_ALPHABET.length])
      .join('')
  }

  private toRoomState(room: StoredRoom): RoomState {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(
        ({
          playerId,
          roomId,
          displayName,
          slot,
          connected,
          ready,
        }) => ({
          playerId,
          roomId,
          displayName,
          slot,
          connected,
          ready,
        }),
      ),
      status: room.status,
      activeMatchId: room.activeMatchId,
    }
  }
}
