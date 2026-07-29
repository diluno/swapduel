import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attackAckSchema,
  attackEventSchema,
  boardSnapshotSchema,
  leaderboardSubmissionSchema,
  LEADERBOARD_PAGE_SIZE,
  matchStartPayloadSchema,
  matchRematchPayloadSchema,
  nextRoundReadyPayloadSchema,
  playerReadyPayloadSchema,
  pingPayloadSchema,
  roundReadyPayloadSchema,
  roundTopOutSchema,
  roomCreatePayloadSchema,
  roomJoinPayloadSchema,
  roomReconnectPayloadSchema,
  simulationChecksumReportSchema,
  type AttackAck,
  type AttackEvent,
  type BoardSnapshot,
  type LeaderboardPage,
  type MatchRematchPayload,
  type MatchStartPayload,
  type NextRoundReadyPayload,
  type RoomError,
  type RoomSession,
  type RoomState,
  type RoundPreparation,
  type RoundReadyPayload,
  type RoundStarting,
  type RoundTopOut,
  type OrderedAttackEvent,
  type Pong,
  type SimulationChecksumReport,
  type SimulationDesync,
} from '@swapduel/contracts'
import cors from 'cors'
import express from 'express'
import { Server, type Socket } from 'socket.io'
import { LeaderboardStore } from './leaderboard/leaderboard-store'
import {
  RoomStore,
  RoomStoreError,
  type ExpiredRoom,
  type RoundResolution,
} from './rooms/room-store'
import { FixedWindowRateLimiter } from './security/rate-limiter'
import {
  createNativeWebSocketTransport,
  type NativeRequestContext,
} from './realtime/native-websocket'
import { RealtimeHub } from './realtime/realtime-hub'

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const allowedOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000'
const trustProxy =
  process.env.TRUST_PROXY === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.TRUST_PROXY === 'true'
const leaderboardDatabasePath =
  process.env.LEADERBOARD_DB_PATH ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../data/leaderboard.db',
  )
const webPublicDirectory =
  process.env.WEB_PUBLIC_DIR ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../web/.output/public',
  )

const app = express()
app.disable('x-powered-by')
if (trustProxy) app.set('trust proxy', 1)
app.use(cors({ origin: allowedOrigin }))
app.use(express.json({ limit: '32kb' }))

app.get('/health', (_request, response) => {
  response.json({ service: 'swapduel', status: 'ok' })
})

// The leaderboard is the only durable state in the service. A missing or
// unwritable volume must not take the game down with it: the endpoints report
// 503 and everything else — rooms, matches, solo play — carries on.
let leaderboard: LeaderboardStore | null = null
try {
  leaderboard = new LeaderboardStore({ databasePath: leaderboardDatabasePath })
} catch (error) {
  console.error(
    `Leaderboard storage at ${leaderboardDatabasePath} is unavailable; time-trial scores will not be recorded.`,
    error,
  )
}

const leaderboardReadLimiter = new FixedWindowRateLimiter({
  limit: 60,
  windowMs: 60_000,
  maxKeys: 5_000,
})
const leaderboardWriteLimiter = new FixedWindowRateLimiter({
  limit: 10,
  windowMs: 60_000,
  maxKeys: 5_000,
})

function rejectHttpIfLimited(
  limiter: FixedWindowRateLimiter,
  request: express.Request,
  response: express.Response,
): boolean {
  const result = limiter.consume(request.ip ?? 'unknown')
  if (result.allowed) return false

  response
    .status(429)
    .set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
    .json(rateLimitError(result.retryAfterMs))
  return true
}

function requireLeaderboard(
  response: express.Response,
): LeaderboardStore | null {
  if (leaderboard !== null) return leaderboard

  response.status(503).json({
    code: 'INVALID_REQUEST',
    message: 'The leaderboard is temporarily unavailable.',
  } satisfies RoomError)
  return null
}

app.get('/api/leaderboard', (request, response) => {
  if (rejectHttpIfLimited(leaderboardReadLimiter, request, response)) return
  const store = requireLeaderboard(response)
  if (store === null) return

  const requestedLimit = Number.parseInt(
    typeof request.query.limit === 'string' ? request.query.limit : '',
    10,
  )
  const entries = store.top(
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : LEADERBOARD_PAGE_SIZE,
  )
  response.json({ entries } satisfies LeaderboardPage)
})

app.post('/api/leaderboard', (request, response) => {
  if (rejectHttpIfLimited(leaderboardWriteLimiter, request, response)) return
  const store = requireLeaderboard(response)
  if (store === null) return

  const parsed = leaderboardSubmissionSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({
      code: 'INVALID_REQUEST',
      message: 'The score submission was invalid.',
    } satisfies RoomError)
    return
  }

  response.status(201).json(store.submit(parsed.data))
})

if (existsSync(webPublicDirectory)) {
  app.use(
    express.static(webPublicDirectory, {
      index: 'index.html',
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    }),
  )
  app.use((request, response, next) => {
    if (request.method !== 'GET') {
      next()
      return
    }
    if (
      request.path === '/lab' ||
      request.path.startsWith('/lab/')
    ) {
      response
        .status(404)
        .sendFile('404.html', { root: webPublicDirectory })
      return
    }
    response.sendFile('200.html', { root: webPublicDirectory })
  })
} else if (process.env.NODE_ENV === 'production') {
  console.warn(
    `Web assets were not found at ${webPublicDirectory}. Only the realtime API will be available.`,
  )
}

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigin },
  maxHttpBufferSize: 64 * 1024,
})
const realtime = new RealtimeHub()
const rooms = new RoomStore()
const topOutTimers = new Map<string, ReturnType<typeof setTimeout>>()
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
const forfeitTimers = new Map<string, ReturnType<typeof setTimeout>>()
const ATTACK_RETRY_AFTER_MS = 750
const ATTACK_RETRY_SCAN_MS = 250
const ROOM_CLEANUP_SCAN_MS = 60_000
const roomCreationLimiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 60_000,
  maxKeys: 5_000,
})
const roomJoinLimiter = new FixedWindowRateLimiter({
  limit: 20,
  windowMs: 60_000,
  maxKeys: 5_000,
})
const authenticationLimiter = new FixedWindowRateLimiter({
  limit: 30,
  windowMs: 60_000,
  maxKeys: 5_000,
})
const controlEventLimiter = new FixedWindowRateLimiter({
  limit: 60,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const checksumLimiter = new FixedWindowRateLimiter({
  limit: 20,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const attackEventLimiter = new FixedWindowRateLimiter({
  limit: 120,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const topOutLimiter = new FixedWindowRateLimiter({
  limit: 10,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const snapshotLimiter = new FixedWindowRateLimiter({
  limit: 25,
  windowMs: 1_000,
  maxKeys: 5_000,
})
const pingLimiter = new FixedWindowRateLimiter({
  limit: 10,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const malformedEventLimiter = new FixedWindowRateLimiter({
  limit: 10,
  windowMs: 10_000,
  maxKeys: 5_000,
})
const realtimeRateLimitBuckets = new Map<
  FixedWindowRateLimiter,
  string
>([
  [roomCreationLimiter, 'room-create'],
  [roomJoinLimiter, 'room-join'],
  [authenticationLimiter, 'authentication'],
  [controlEventLimiter, 'control'],
  [checksumLimiter, 'checksum'],
  [attackEventLimiter, 'attack'],
  [topOutLimiter, 'top-out'],
  [snapshotLimiter, 'snapshot'],
  [pingLimiter, 'ping'],
  [malformedEventLimiter, 'malformed'],
])
const KNOWN_CLIENT_EVENTS = new Set([
  'room:create',
  'room:join',
  'room:reconnect',
  'player:ready',
  'match:start',
  'match:rematch',
  'round:ready',
  'round:next',
  'board:snapshot',
  'simulation:checksum',
  'attack:create',
  'attack:ack',
  'round:topout',
  'ping',
])
const USER_FACING_NATIVE_ERROR_EVENTS = new Set([
  'room:create',
  'room:join',
  'player:ready',
  'match:start',
  'round:ready',
  'attack:create',
])

type SocketResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RoomError }
type FailureAcknowledge =
  | ((result: { ok: false; error: RoomError }) => void)
  | undefined

function toRoomError(error: unknown): RoomError {
  if (error instanceof RoomStoreError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'INVALID_REQUEST',
    message: 'The request could not be completed.',
  }
}

function roundTimerKey(matchId: string, roundId: string): string {
  return `${matchId}:${roundId}`
}

function playerTimerKey(roomId: string, playerId: string): string {
  return `${roomId}:${playerId}`
}

function resolveClientAddress(
  fallbackAddress: string,
  forwarded: string | string[] | undefined,
): string {
  if (!trustProxy) return fallbackAddress
  const firstAddress = (
    Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  )?.trim()
  return firstAddress !== undefined && isIP(firstAddress) !== 0
    ? firstAddress
    : fallbackAddress
}

function getClientAddress(socket: Socket): string {
  return resolveClientAddress(
    socket.handshake.address,
    socket.handshake.headers['x-forwarded-for'],
  )
}

function getNativeClientAddress(request: IncomingMessage): string {
  return resolveClientAddress(
    request.socket.remoteAddress ?? 'unknown',
    request.headers['x-forwarded-for'],
  )
}

function rateLimitError(retryAfterMs: number): RoomError {
  return {
    code: 'RATE_LIMITED',
    message: 'Too many requests. Wait a moment and try again.',
    retryAfterMs: Math.min(60_000, Math.ceil(retryAfterMs)),
  }
}

function logRealtimeRateLimit(
  transport: 'native-websocket' | 'socket.io',
  limiter: FixedWindowRateLimiter,
  retryAfterMs: number,
): void {
  console.warn(
    JSON.stringify({
      event: 'realtime_rate_limited',
      transport,
      bucket: realtimeRateLimitBuckets.get(limiter) ?? 'unknown',
      retryAfterMs: Math.ceil(retryAfterMs),
    }),
  )
}

function createRoom(displayName: string, connectionId: string): RoomSession {
  const session = rooms.create(displayName, connectionId)
  realtime.join(connectionId, session.roomState.roomId)
  realtime.emitToConnection(connectionId, 'room:created', session)
  realtime.emitToRoom(
    session.roomState.roomId,
    'room:state',
    session.roomState,
  )
  return session
}

function joinRoom(
  roomCode: string,
  displayName: string,
  connectionId: string,
): RoomSession {
  const session = rooms.join(roomCode, displayName, connectionId)
  realtime.join(connectionId, session.roomState.roomId)
  realtime.emitToConnection(connectionId, 'room:joined', session)
  realtime.emitToRoom(
    session.roomState.roomId,
    'room:state',
    session.roomState,
  )
  return session
}

function updateReadyState(
  roomId: string,
  playerId: string,
  reconnectToken: string,
  ready: boolean,
): RoomState {
  const roomState = rooms.setReady(
    roomId,
    playerId,
    reconnectToken,
    ready,
  )
  realtime.emitToRoom(roomState.roomId, 'room:state', roomState)
  return roomState
}

function reconnectRoom(
  roomId: string,
  playerId: string,
  reconnectToken: string,
  connectionId: string,
): RoomSession {
  const session = rooms.reconnect(
    roomId,
    playerId,
    reconnectToken,
    connectionId,
  )
  realtime.join(connectionId, session.roomState.roomId)
  const timerKey = playerTimerKey(
    session.roomState.roomId,
    session.playerId,
  )
  const disconnectTimer = disconnectTimers.get(timerKey)
  if (disconnectTimer !== undefined) clearTimeout(disconnectTimer)
  disconnectTimers.delete(timerKey)
  const forfeitTimer = forfeitTimers.get(timerKey)
  if (forfeitTimer !== undefined) clearTimeout(forfeitTimer)
  forfeitTimers.delete(timerKey)

  realtime.emitToRoom(session.roomState.roomId, 'player:reconnected', {
    playerId: session.playerId,
  })
  realtime.emitToRoom(
    session.roomState.roomId,
    'room:state',
    session.roomState,
  )
  const recovery = rooms.getRoundRecovery(
    roomId,
    playerId,
    reconnectToken,
  )
  if (recovery !== null) {
    realtime.emitToConnection(
      connectionId,
      'round:prepare',
      recovery.preparation,
    )
    if (recovery.starting !== null) {
      realtime.emitToConnection(
        connectionId,
        'round:starting',
        recovery.starting,
      )
    }
    if (recovery.roundEnded !== null) {
      realtime.emitToConnection(
        connectionId,
        'round:ended',
        recovery.roundEnded,
      )
    }
    if (recovery.matchEnded !== null) {
      realtime.emitToConnection(
        connectionId,
        'match:ended',
        recovery.matchEnded,
      )
    }
  }
  const resuming = rooms.resumeAfterReconnect(session.roomState.roomId)
  if (resuming !== null) {
    realtime.emitToRoom(
      session.roomState.roomId,
      'match:resuming',
      resuming,
    )
  }
  for (const delivery of rooms.getPendingAttacksForPlayer(
    session.roomState.roomId,
    session.playerId,
  )) {
    realtime.emitToConnection(
      delivery.targetSocketId,
      'attack:incoming',
      delivery.event,
    )
  }
  return session
}

function startMatch(payload: MatchStartPayload): RoundPreparation {
  const result = rooms.startMatch(
    payload.roomId,
    payload.playerId,
    payload.reconnectToken,
  )
  realtime.emitToRoom(
    result.roomState.roomId,
    'room:state',
    result.roomState,
  )
  realtime.emitToRoom(
    result.roomState.roomId,
    'match:starting',
    result.preparation,
  )
  return result.preparation
}

function markRoundReady(
  payload: RoundReadyPayload,
): RoundStarting | null {
  const result = rooms.markRoundReady(
    payload.roomId,
    payload.playerId,
    payload.reconnectToken,
    payload.matchId,
    payload.roundId,
  )
  if (result.starting !== null) {
    realtime.emitToRoom(
      result.roomState.roomId,
      'room:state',
      result.roomState,
    )
    realtime.emitToRoom(
      result.roomState.roomId,
      'round:starting',
      result.starting,
    )
  }
  return result.starting
}

function relayBoardSnapshot(
  connectionId: string,
  payload: BoardSnapshot,
): void {
  const authorization = rooms.authorizeGameplayEvent(
    connectionId,
    payload.playerId,
    payload.matchId,
    payload.roundId,
  )
  realtime.emitToRoomExcept(
    authorization.roomId,
    connectionId,
    'opponent:snapshot',
    payload,
  )
}

function recordSimulationChecksum(
  connectionId: string,
  payload: SimulationChecksumReport,
): { accepted: boolean; conflict: boolean } {
  const result = rooms.recordSimulationChecksum(connectionId, payload)
  if (result.conflict !== null) {
    const diagnostic: SimulationDesync = {
      protocolVersion: 1,
      matchId: payload.matchId,
      roundId: payload.roundId,
      playerId: payload.playerId,
      simulationStep: payload.simulationStep,
      detectedAt: Date.now(),
    }
    realtime.emitToConnection(
      connectionId,
      'simulation:desync',
      diagnostic,
    )
    console.warn(
      JSON.stringify({
        event: 'simulation_checksum_conflict',
        ...diagnostic,
        previousChecksum: result.conflict.previousChecksum,
        reportedChecksum: result.conflict.reportedChecksum,
      }),
    )
  }
  return {
    accepted: result.accepted,
    conflict: result.conflict !== null,
  }
}

function createAttack(
  connectionId: string,
  payload: AttackEvent,
): OrderedAttackEvent {
  const ordered = rooms.orderAttack(connectionId, payload)
  realtime.emitToConnection(
    ordered.targetSocketId,
    'attack:incoming',
    ordered.event,
  )
  realtime.emitToConnection(
    connectionId,
    'attack:confirmed',
    ordered.event,
  )
  return ordered.event
}

function acknowledgeAttack(
  connectionId: string,
  payload: AttackAck,
): boolean {
  return rooms.acknowledgeAttack(
    connectionId,
    payload.playerId,
    payload.matchId,
    payload.roundId,
    payload.serverSequence,
  )
}

function reportTopOut(
  connectionId: string,
  payload: RoundTopOut,
): { accepted: true } {
  const result = rooms.reportTopOut(
    connectionId,
    payload.playerId,
    payload.matchId,
    payload.roundId,
  )
  const timerKey = roundTimerKey(payload.matchId, payload.roundId)
  if (result.resolution !== null) {
    const timer = topOutTimers.get(timerKey)
    if (timer !== undefined) clearTimeout(timer)
    topOutTimers.delete(timerKey)
    emitRoundResolution(result.resolution)
  } else if (result.resolveAt !== null) {
    const existingTimer = topOutTimers.get(timerKey)
    if (existingTimer !== undefined) clearTimeout(existingTimer)
    const delay = Math.max(0, result.resolveAt - Date.now()) + 5
    topOutTimers.set(
      timerKey,
      setTimeout(() => {
        topOutTimers.delete(timerKey)
        const resolution = rooms.resolvePendingTopOut(
          payload.matchId,
          payload.roundId,
        )
        if (resolution !== null) emitRoundResolution(resolution)
      }, delay),
    )
  }
  return { accepted: true }
}

function readyForNextRound(
  payload: NextRoundReadyPayload,
): RoundPreparation | null {
  const result = rooms.readyForNextRound(
    payload.roomId,
    payload.playerId,
    payload.reconnectToken,
    payload.matchId,
    payload.roundId,
  )
  if (result.preparation !== null) {
    realtime.emitToRoom(
      result.roomState.roomId,
      'room:state',
      result.roomState,
    )
    realtime.emitToRoom(
      result.roomState.roomId,
      'round:prepare',
      result.preparation,
    )
  }
  return result.preparation
}

function requestRematch(
  payload: MatchRematchPayload,
): RoundPreparation | null {
  const result = rooms.requestRematch(
    payload.roomId,
    payload.playerId,
    payload.reconnectToken,
    payload.matchId,
  )
  if (result.preparation !== null) {
    realtime.emitToRoom(
      result.roomState.roomId,
      'room:state',
      result.roomState,
    )
    realtime.emitToRoom(
      result.roomState.roomId,
      'match:starting',
      result.preparation,
    )
  }
  return result.preparation
}

function emitRoundResolution(resolution: RoundResolution): void {
  realtime.emitToRoom(
    resolution.roundEnded.roomId,
    'round:ended',
    resolution.roundEnded,
  )
  if (resolution.matchEnded !== null) {
    realtime.emitToRoom(
      resolution.matchEnded.roomId,
      'match:ended',
      resolution.matchEnded,
    )
  }
  realtime.emitToRoom(
    resolution.roundEnded.roomId,
    'room:state',
    rooms.getById(resolution.roundEnded.roomId),
  )
}

function cancelExpiredRoomTimers(room: ExpiredRoom): void {
  for (const playerId of room.playerIds) {
    const timerKey = playerTimerKey(room.roomId, playerId)
    const disconnectTimer = disconnectTimers.get(timerKey)
    if (disconnectTimer !== undefined) clearTimeout(disconnectTimer)
    disconnectTimers.delete(timerKey)
    const forfeitTimer = forfeitTimers.get(timerKey)
    if (forfeitTimer !== undefined) clearTimeout(forfeitTimer)
    forfeitTimers.delete(timerKey)
  }
  if (room.activeMatchId !== null && room.activeRoundId !== null) {
    const timerKey = roundTimerKey(
      room.activeMatchId,
      room.activeRoundId,
    )
    const topOutTimer = topOutTimers.get(timerKey)
    if (topOutTimer !== undefined) clearTimeout(topOutTimer)
    topOutTimers.delete(timerKey)
  }
}

const attackRetryInterval = setInterval(() => {
  for (const delivery of rooms.getRetryableAttacks(
    ATTACK_RETRY_AFTER_MS,
  )) {
    realtime.emitToConnection(
      delivery.targetSocketId,
      'attack:incoming',
      delivery.event,
    )
  }
}, ATTACK_RETRY_SCAN_MS)

const roomCleanupInterval = setInterval(() => {
  const cleanup = rooms.cleanupExpiredRooms()
  roomCreationLimiter.prune()
  roomJoinLimiter.prune()
  authenticationLimiter.prune()
  controlEventLimiter.prune()
  checksumLimiter.prune()
  attackEventLimiter.prune()
  topOutLimiter.prune()
  snapshotLimiter.prune()
  pingLimiter.prune()
  malformedEventLimiter.prune()
  leaderboardReadLimiter.prune()
  leaderboardWriteLimiter.prune()
  for (const roomState of cleanup.updatedRooms) {
    realtime.emitToRoom(roomState.roomId, 'room:state', roomState)
  }
  for (const room of cleanup.expiredRooms) {
    cancelExpiredRoomTimers(room)
    realtime.emitToRoom(room.roomId, 'room:error', {
      code: 'ROOM_NOT_FOUND',
      message: 'This room expired after being inactive.',
      roomId: room.roomId,
    } satisfies RoomError)
    realtime.leaveRoom(room.roomId)
  }
}, ROOM_CLEANUP_SCAN_MS)

function handleDisconnect(connectionId: string): void {
  controlEventLimiter.delete(connectionId)
  checksumLimiter.delete(connectionId)
  attackEventLimiter.delete(connectionId)
  topOutLimiter.delete(connectionId)
  snapshotLimiter.delete(connectionId)
  pingLimiter.delete(connectionId)
  malformedEventLimiter.delete(connectionId)
  for (const disconnected of rooms.markDisconnected(connectionId)) {
    const { roomState, playerId, activeRound } = disconnected
    realtime.emitToRoom(roomState.roomId, 'room:state', roomState)
    realtime.emitToRoom(roomState.roomId, 'player:disconnected', {
      playerId,
    })
    if (activeRound === null) continue

    const timerKey = playerTimerKey(roomState.roomId, playerId)
    disconnectTimers.set(
      timerKey,
      setTimeout(() => {
        disconnectTimers.delete(timerKey)
        const paused = rooms.pauseForDisconnect(
          roomState.roomId,
          playerId,
        )
        if (paused === null) return

        realtime.emitToRoom(roomState.roomId, 'match:paused', paused)
        const forfeitDelay = Math.max(0, paused.forfeitAt - Date.now())
        forfeitTimers.set(
          timerKey,
          setTimeout(() => {
            forfeitTimers.delete(timerKey)
            const resolution = rooms.forfeitDisconnected(
              roomState.roomId,
              playerId,
            )
            if (resolution !== null) emitRoundResolution(resolution)
          }, forfeitDelay),
        )
      }, 1_000),
    )
  }
}

function nativeFailure(
  context: NativeRequestContext,
  error: RoomError,
  emitError: boolean,
): void {
  if (emitError) {
    realtime.emitToConnection(context.connectionId, 'room:error', error)
  }
  context.respond({ ok: false, error })
}

function rejectNativeIfLimited(
  context: NativeRequestContext,
  limiter: FixedWindowRateLimiter,
  key: string,
  emitError = true,
): boolean {
  const result = limiter.consume(key)
  if (result.allowed) return false
  logRealtimeRateLimit(
    'native-websocket',
    limiter,
    result.retryAfterMs,
  )
  nativeFailure(context, rateLimitError(result.retryAfterMs), emitError)
  return true
}

function rejectMalformedNative(
  context: NativeRequestContext,
  message: string,
  emitError = true,
): void {
  const result = malformedEventLimiter.consume(context.connectionId)
  nativeFailure(
    context,
    result.allowed
      ? { code: 'INVALID_REQUEST', message }
      : rateLimitError(result.retryAfterMs),
    emitError,
  )
}

function shouldEmitNativeRoomError(event: string): boolean {
  return USER_FACING_NATIVE_ERROR_EVENTS.has(event)
}

function handleNativeRequest(context: NativeRequestContext): void {
  const { connectionId, clientAddress, request } = context

  try {
    switch (request.event) {
      case 'room:create': {
        if (
          rejectNativeIfLimited(
            context,
            roomCreationLimiter,
            clientAddress,
          )
        ) return
        const parsed = roomCreatePayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'Enter a player name between 1 and 20 characters.',
          )
          return
        }
        context.respond({
          ok: true,
          data: createRoom(parsed.data.displayName, connectionId),
        })
        return
      }
      case 'room:join': {
        if (
          rejectNativeIfLimited(context, roomJoinLimiter, clientAddress)
        ) return
        const parsed = roomJoinPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'Check the room code and player name.',
          )
          return
        }
        context.respond({
          ok: true,
          data: joinRoom(
            parsed.data.roomCode,
            parsed.data.displayName,
            connectionId,
          ),
        })
        return
      }
      case 'room:reconnect': {
        if (
          rejectNativeIfLimited(
            context,
            authenticationLimiter,
            clientAddress,
          )
        ) return
        const parsed = roomReconnectPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The saved room session was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: reconnectRoom(
            parsed.data.roomId,
            parsed.data.playerId,
            parsed.data.reconnectToken,
            connectionId,
          ),
        })
        return
      }
      case 'player:ready': {
        if (
          rejectNativeIfLimited(
            context,
            controlEventLimiter,
            connectionId,
          )
        ) return
        const parsed = playerReadyPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The ready-state update was invalid.',
          )
          return
        }
        context.respond({
          ok: true,
          data: updateReadyState(
            parsed.data.roomId,
            parsed.data.playerId,
            parsed.data.reconnectToken,
            parsed.data.ready,
          ),
        })
        return
      }
      case 'match:start': {
        if (
          rejectNativeIfLimited(
            context,
            controlEventLimiter,
            connectionId,
          )
        ) return
        const parsed = matchStartPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The match-start request was invalid.',
          )
          return
        }
        context.respond({ ok: true, data: startMatch(parsed.data) })
        return
      }
      case 'round:ready': {
        if (
          rejectNativeIfLimited(
            context,
            controlEventLimiter,
            connectionId,
          )
        ) return
        const parsed = roundReadyPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The round-ready acknowledgement was invalid.',
          )
          return
        }
        context.respond({ ok: true, data: markRoundReady(parsed.data) })
        return
      }
      case 'board:snapshot': {
        if (
          rejectNativeIfLimited(
            context,
            snapshotLimiter,
            connectionId,
            false,
          )
        ) return
        const parsed = boardSnapshotSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The board snapshot was invalid.',
            false,
          )
          return
        }
        try {
          relayBoardSnapshot(connectionId, parsed.data)
        } catch {
          // Snapshots are lossy visual updates. Invalid or stale data is ignored.
        }
        context.respond({ ok: true, data: { accepted: true } })
        return
      }
      case 'simulation:checksum': {
        if (
          rejectNativeIfLimited(
            context,
            checksumLimiter,
            connectionId,
            false,
          )
        ) return
        const parsed = simulationChecksumReportSchema.safeParse(
          request.payload,
        )
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The simulation checksum report was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: recordSimulationChecksum(connectionId, parsed.data),
        })
        return
      }
      case 'attack:create': {
        if (
          rejectNativeIfLimited(
            context,
            attackEventLimiter,
            connectionId,
          )
        ) return
        const parsed = attackEventSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The attack payload was invalid.',
          )
          return
        }
        context.respond({
          ok: true,
          data: createAttack(connectionId, parsed.data),
        })
        return
      }
      case 'attack:ack': {
        if (
          rejectNativeIfLimited(
            context,
            attackEventLimiter,
            connectionId,
            false,
          )
        ) return
        const parsed = attackAckSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The attack acknowledgement was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: {
            acknowledged: acknowledgeAttack(connectionId, parsed.data),
          },
        })
        return
      }
      case 'round:topout': {
        if (
          rejectNativeIfLimited(
            context,
            topOutLimiter,
            connectionId,
          )
        ) return
        const parsed = roundTopOutSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The top-out report was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: reportTopOut(connectionId, parsed.data),
        })
        return
      }
      case 'round:next': {
        if (
          rejectNativeIfLimited(
            context,
            controlEventLimiter,
            connectionId,
          )
        ) return
        const parsed = nextRoundReadyPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The next-round request was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: readyForNextRound(parsed.data),
        })
        return
      }
      case 'match:rematch': {
        if (
          rejectNativeIfLimited(
            context,
            controlEventLimiter,
            connectionId,
          )
        ) return
        const parsed = matchRematchPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The rematch request was invalid.',
            false,
          )
          return
        }
        context.respond({
          ok: true,
          data: requestRematch(parsed.data),
        })
        return
      }
      case 'ping': {
        if (
          rejectNativeIfLimited(
            context,
            pingLimiter,
            connectionId,
            false,
          )
        ) return
        const parsed = pingPayloadSchema.safeParse(request.payload)
        if (!parsed.success) {
          rejectMalformedNative(
            context,
            'The ping timestamp was invalid.',
            false,
          )
          return
        }
        const pong: Pong = {
          clientTimestamp: parsed.data,
          serverTimestamp: Date.now(),
        }
        realtime.emitToConnection(connectionId, 'pong', pong)
        context.respond({ ok: true, data: pong })
        return
      }
    }
  } catch (error) {
    nativeFailure(
      context,
      toRoomError(error),
      shouldEmitNativeRoomError(request.event),
    )
  }
}

const nativeWebSocket = createNativeWebSocketTransport({
  httpServer,
  hub: realtime,
  getClientAddress: getNativeClientAddress,
  onRequest: handleNativeRequest,
  onDisconnect: handleDisconnect,
})

io.on('connection', (socket) => {
  realtime.register(socket.id, (event, payload) => {
    socket.emit(event, payload)
  })
  const clientAddress = getClientAddress(socket)

  function rejectIfLimited(
    limiter: FixedWindowRateLimiter,
    key: string,
    acknowledge?: FailureAcknowledge,
    emitError = true,
  ): boolean {
    const result = limiter.consume(key)
    if (result.allowed) return false

    logRealtimeRateLimit('socket.io', limiter, result.retryAfterMs)
    const error = rateLimitError(result.retryAfterMs)
    if (emitError) socket.emit('room:error', error)
    acknowledge?.({ ok: false, error })
    return true
  }

  function rejectMalformed(
    message: string,
    acknowledge?: FailureAcknowledge,
    emitError = true,
  ): void {
    const result = malformedEventLimiter.consume(socket.id)
    const error: RoomError = result.allowed
      ? { code: 'INVALID_REQUEST', message }
      : rateLimitError(result.retryAfterMs)
    if (emitError) socket.emit('room:error', error)
    acknowledge?.({ ok: false, error })
  }

  socket.onAny((event) => {
    if (!KNOWN_CLIENT_EVENTS.has(event)) {
      rejectMalformed('The socket event was not recognized.')
    }
  })

  socket.on(
    'room:create',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<RoomSession>) => void,
    ) => {
      if (
        rejectIfLimited(
          roomCreationLimiter,
          clientAddress,
          acknowledge,
        )
      ) {
        return
      }
      const parsed = roomCreatePayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'Enter a player name between 1 and 20 characters.',
          acknowledge,
        )
        return
      }

      try {
        const session = createRoom(parsed.data.displayName, socket.id)
        acknowledge?.({ ok: true, data: session })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'room:join',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<RoomSession>) => void,
    ) => {
      if (
        rejectIfLimited(roomJoinLimiter, clientAddress, acknowledge)
      ) {
        return
      }
      const parsed = roomJoinPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'Check the room code and player name.',
          acknowledge,
        )
        return
      }

      try {
        const session = joinRoom(
          parsed.data.roomCode,
          parsed.data.displayName,
          socket.id,
        )
        acknowledge?.({ ok: true, data: session })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'player:ready',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<RoomState>) => void,
    ) => {
      if (
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = playerReadyPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The ready-state update was invalid.',
          acknowledge,
        )
        return
      }

      try {
        const roomState = updateReadyState(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          parsed.data.ready,
        )
        acknowledge?.({ ok: true, data: roomState })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'room:reconnect',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<RoomSession>) => void,
    ) => {
      if (
        rejectIfLimited(
          authenticationLimiter,
          clientAddress,
          acknowledge,
        )
      ) {
        return
      }
      const parsed = roomReconnectPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The saved room session was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        const session = reconnectRoom(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          socket.id,
        )
        acknowledge?.({ ok: true, data: session })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'match:start',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<RoundPreparation>) => void,
    ) => {
      if (
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = matchStartPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The match-start request was invalid.',
          acknowledge,
        )
        return
      }

      try {
        acknowledge?.({ ok: true, data: startMatch(parsed.data) })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'round:ready',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<RoundStarting | null>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = roundReadyPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The round-ready acknowledgement was invalid.',
          acknowledge,
        )
        return
      }

      try {
        acknowledge?.({ ok: true, data: markRoundReady(parsed.data) })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on('board:snapshot', (payload: unknown) => {
    if (
      rejectIfLimited(
        snapshotLimiter,
        socket.id,
        undefined,
        false,
      )
    ) {
      return
    }
    const parsed = boardSnapshotSchema.safeParse(payload)
    if (!parsed.success) {
      rejectMalformed(
        'The board snapshot was invalid.',
        undefined,
        false,
      )
      return
    }

    try {
      relayBoardSnapshot(socket.id, parsed.data)
    } catch {
      // Snapshots are lossy visual updates. Invalid or stale data is ignored.
    }
  })

  socket.on(
    'simulation:checksum',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<{
          accepted: boolean
          conflict: boolean
        }>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(
          checksumLimiter,
          socket.id,
          acknowledge,
          false,
        )
      ) {
        return
      }
      const parsed = simulationChecksumReportSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The simulation checksum report was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: recordSimulationChecksum(socket.id, parsed.data),
        })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'attack:create',
    (
      payload: unknown,
      acknowledge?: (result: SocketResult<OrderedAttackEvent>) => void,
    ) => {
      if (
        rejectIfLimited(attackEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = attackEventSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed('The attack payload was invalid.', acknowledge)
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: createAttack(socket.id, parsed.data),
        })
      } catch (error) {
        const roomError = toRoomError(error)
        socket.emit('room:error', roomError)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'attack:ack',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<{ acknowledged: boolean }>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(
          attackEventLimiter,
          socket.id,
          acknowledge,
          false,
        )
      ) {
        return
      }
      const parsed = attackAckSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The attack acknowledgement was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: {
            acknowledged: acknowledgeAttack(socket.id, parsed.data),
          },
        })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'round:topout',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<{ accepted: boolean }>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(topOutLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = roundTopOutSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The top-out report was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: reportTopOut(socket.id, parsed.data),
        })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'round:next',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<RoundPreparation | null>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = nextRoundReadyPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The next-round request was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: readyForNextRound(parsed.data),
        })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'match:rematch',
    (
      payload: unknown,
      acknowledge?: (
        result: SocketResult<RoundPreparation | null>,
      ) => void,
    ) => {
      if (
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = matchRematchPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed(
          'The rematch request was invalid.',
          acknowledge,
          false,
        )
        return
      }

      try {
        acknowledge?.({
          ok: true,
          data: requestRematch(parsed.data),
        })
      } catch (error) {
        const roomError = toRoomError(error)
        acknowledge?.({ ok: false, error: roomError })
      }
    },
  )

  socket.on(
    'ping',
    (
      clientTimestamp: unknown,
      acknowledge?: (result: SocketResult<Pong>) => void,
    ) => {
      if (
        rejectIfLimited(pingLimiter, socket.id, acknowledge, false)
      ) {
        return
      }
      const parsed = pingPayloadSchema.safeParse(clientTimestamp)
      if (!parsed.success) {
        rejectMalformed(
          'The ping timestamp was invalid.',
          acknowledge,
          false,
        )
        return
      }

      const pong: Pong = {
        clientTimestamp: parsed.data,
        serverTimestamp: Date.now(),
      }
      socket.emit('pong', pong)
      acknowledge?.({ ok: true, data: pong })
    },
  )

  socket.on('disconnect', () => {
    handleDisconnect(socket.id)
    realtime.unregister(socket.id)
  })
})

httpServer.listen(port, () => {
  console.log(`Swapduel server listening on port ${port}`)
})

let shuttingDown = false

function shutDown(signal: NodeJS.Signals): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down`)

  clearInterval(attackRetryInterval)
  clearInterval(roomCleanupInterval)
  for (const timer of topOutTimers.values()) clearTimeout(timer)
  for (const timer of disconnectTimers.values()) clearTimeout(timer)
  for (const timer of forfeitTimers.values()) clearTimeout(timer)

  const forcedExit = setTimeout(() => {
    console.error('Graceful shutdown timed out')
    process.exit(1)
  }, 10_000)
  forcedExit.unref()

  nativeWebSocket.close(() => {
    io.close(() => {
      leaderboard?.close()
      clearTimeout(forcedExit)
      process.exit(0)
    })
  })
}

process.once('SIGTERM', () => shutDown('SIGTERM'))
process.once('SIGINT', () => shutDown('SIGINT'))
