import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attackAckSchema,
  attackEventSchema,
  boardSnapshotSchema,
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
  type RoomError,
  type RoomSession,
  type RoomState,
  type RoundPreparation,
  type RoundStarting,
  type OrderedAttackEvent,
  type Pong,
  type SimulationDesync,
} from '@swapduel/contracts'
import cors from 'cors'
import express from 'express'
import { Server, type Socket } from 'socket.io'
import {
  RoomStore,
  RoomStoreError,
  type ExpiredRoom,
  type RoundResolution,
} from './rooms/room-store'
import { FixedWindowRateLimiter } from './security/rate-limiter'

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const allowedOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000'
const trustProxy =
  process.env.TRUST_PROXY === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.TRUST_PROXY === 'true'
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

function getClientAddress(socket: Socket): string {
  if (!trustProxy) return socket.handshake.address
  const forwarded = socket.handshake.headers['x-forwarded-for']
  const firstAddress = (
    Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  )?.trim()
  return firstAddress !== undefined && isIP(firstAddress) !== 0
    ? firstAddress
    : socket.handshake.address
}

function rateLimitError(retryAfterMs: number): RoomError {
  return {
    code: 'RATE_LIMITED',
    message: 'Too many requests. Wait a moment and try again.',
    retryAfterMs: Math.min(60_000, Math.ceil(retryAfterMs)),
  }
}

function emitRoundResolution(resolution: RoundResolution): void {
  io.to(resolution.roundEnded.roomId).emit(
    'round:ended',
    resolution.roundEnded,
  )
  if (resolution.matchEnded !== null) {
    io.to(resolution.matchEnded.roomId).emit(
      'match:ended',
      resolution.matchEnded,
    )
  }
  io.to(resolution.roundEnded.roomId).emit(
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
    io.to(delivery.targetSocketId).emit(
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
  snapshotLimiter.prune()
  pingLimiter.prune()
  malformedEventLimiter.prune()
  for (const roomState of cleanup.updatedRooms) {
    io.to(roomState.roomId).emit('room:state', roomState)
  }
  for (const room of cleanup.expiredRooms) {
    cancelExpiredRoomTimers(room)
    io.to(room.roomId).emit('room:error', {
      code: 'ROOM_NOT_FOUND',
      message: 'This room expired after being inactive.',
      roomId: room.roomId,
    } satisfies RoomError)
    io.in(room.roomId).socketsLeave(room.roomId)
  }
}, ROOM_CLEANUP_SCAN_MS)

io.on('connection', (socket) => {
  const clientAddress = getClientAddress(socket)

  function rejectIfLimited(
    limiter: FixedWindowRateLimiter,
    key: string,
    acknowledge?: FailureAcknowledge,
    emitError = true,
  ): boolean {
    const result = limiter.consume(key)
    if (result.allowed) return false

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
        const session = rooms.create(parsed.data.displayName, socket.id)
        void socket.join(session.roomState.roomId)
        socket.emit('room:created', session)
        io.to(session.roomState.roomId).emit(
          'room:state',
          session.roomState,
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
        const session = rooms.join(
          parsed.data.roomCode,
          parsed.data.displayName,
          socket.id,
        )
        void socket.join(session.roomState.roomId)
        socket.emit('room:joined', session)
        io.to(session.roomState.roomId).emit(
          'room:state',
          session.roomState,
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
        const roomState = rooms.setReady(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          parsed.data.ready,
        )
        io.to(roomState.roomId).emit('room:state', roomState)
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
        const session = rooms.reconnect(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          socket.id,
        )
        void socket.join(session.roomState.roomId)
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

        io.to(session.roomState.roomId).emit('player:reconnected', {
          playerId: session.playerId,
        })
        io.to(session.roomState.roomId).emit(
          'room:state',
          session.roomState,
        )
        const resuming = rooms.resumeAfterReconnect(session.roomState.roomId)
        if (resuming !== null) {
          io.to(session.roomState.roomId).emit(
            'match:resuming',
            resuming,
          )
        }
        for (const delivery of rooms.getPendingAttacksForPlayer(
          session.roomState.roomId,
          session.playerId,
        )) {
          io.to(delivery.targetSocketId).emit(
            'attack:incoming',
            delivery.event,
          )
        }
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
        const result = rooms.startMatch(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
        )
        io.to(result.roomState.roomId).emit(
          'room:state',
          result.roomState,
        )
        io.to(result.roomState.roomId).emit(
          'match:starting',
          result.preparation,
        )
        acknowledge?.({ ok: true, data: result.preparation })
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
        const result = rooms.markRoundReady(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          parsed.data.matchId,
          parsed.data.roundId,
        )
        if (result.starting !== null) {
          io.to(result.roomState.roomId).emit(
            'room:state',
            result.roomState,
          )
          io.to(result.roomState.roomId).emit(
            'round:starting',
            result.starting,
          )
        }
        acknowledge?.({ ok: true, data: result.starting })
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
      const authorization = rooms.authorizeGameplayEvent(
        socket.id,
        parsed.data.playerId,
        parsed.data.matchId,
        parsed.data.roundId,
      )
      socket
        .to(authorization.roomId)
        .emit('opponent:snapshot', parsed.data)
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
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
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
        const result = rooms.recordSimulationChecksum(
          socket.id,
          parsed.data,
        )
        if (result.conflict !== null) {
          const diagnostic: SimulationDesync = {
            protocolVersion: 1,
            matchId: parsed.data.matchId,
            roundId: parsed.data.roundId,
            playerId: parsed.data.playerId,
            simulationStep: parsed.data.simulationStep,
            detectedAt: Date.now(),
          }
          socket.emit('simulation:desync', diagnostic)
          console.warn(
            JSON.stringify({
              event: 'simulation_checksum_conflict',
              ...diagnostic,
              previousChecksum: result.conflict.previousChecksum,
              reportedChecksum: result.conflict.reportedChecksum,
            }),
          )
        }
        acknowledge?.({
          ok: true,
          data: {
            accepted: result.accepted,
            conflict: result.conflict !== null,
          },
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
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
      ) {
        return
      }
      const parsed = attackEventSchema.safeParse(payload)
      if (!parsed.success) {
        rejectMalformed('The attack payload was invalid.', acknowledge)
        return
      }

      try {
        const ordered = rooms.orderAttack(socket.id, parsed.data)
        io.to(ordered.targetSocketId).emit(
          'attack:incoming',
          ordered.event,
        )
        socket.emit('attack:confirmed', ordered.event)
        acknowledge?.({ ok: true, data: ordered.event })
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
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
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
        const acknowledged = rooms.acknowledgeAttack(
          socket.id,
          parsed.data.playerId,
          parsed.data.matchId,
          parsed.data.roundId,
          parsed.data.serverSequence,
        )
        acknowledge?.({ ok: true, data: { acknowledged } })
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
        rejectIfLimited(controlEventLimiter, socket.id, acknowledge)
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
        const result = rooms.reportTopOut(
          socket.id,
          parsed.data.playerId,
          parsed.data.matchId,
          parsed.data.roundId,
        )
        const timerKey = roundTimerKey(
          parsed.data.matchId,
          parsed.data.roundId,
        )
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
                parsed.data.matchId,
                parsed.data.roundId,
              )
              if (resolution !== null) emitRoundResolution(resolution)
            }, delay),
          )
        }
        acknowledge?.({ ok: true, data: { accepted: true } })
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
        const result = rooms.readyForNextRound(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          parsed.data.matchId,
          parsed.data.roundId,
        )
        if (result.preparation !== null) {
          io.to(result.roomState.roomId).emit(
            'room:state',
            result.roomState,
          )
          io.to(result.roomState.roomId).emit(
            'round:prepare',
            result.preparation,
          )
        }
        acknowledge?.({ ok: true, data: result.preparation })
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
        const result = rooms.requestRematch(
          parsed.data.roomId,
          parsed.data.playerId,
          parsed.data.reconnectToken,
          parsed.data.matchId,
        )
        if (result.preparation !== null) {
          io.to(result.roomState.roomId).emit(
            'room:state',
            result.roomState,
          )
          io.to(result.roomState.roomId).emit(
            'match:starting',
            result.preparation,
          )
        }
        acknowledge?.({ ok: true, data: result.preparation })
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
    controlEventLimiter.delete(socket.id)
    snapshotLimiter.delete(socket.id)
    pingLimiter.delete(socket.id)
    malformedEventLimiter.delete(socket.id)
    for (const disconnected of rooms.markDisconnected(socket.id)) {
      const { roomState, playerId, activeRound } = disconnected
      io.to(roomState.roomId).emit('room:state', roomState)
      io.to(roomState.roomId).emit('player:disconnected', {
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

          io.to(roomState.roomId).emit('match:paused', paused)
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

  io.close(() => {
    clearTimeout(forcedExit)
    process.exit(0)
  })
}

process.once('SIGTERM', () => shutDown('SIGTERM'))
process.once('SIGINT', () => shutDown('SIGINT'))
