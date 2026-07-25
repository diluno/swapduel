import {
  attackEventSchema,
  boardSnapshotSchema,
  matchEndedSchema,
  matchPausedSchema,
  matchResumingSchema,
  pongSchema,
  roundEndedSchema,
  orderedAttackEventSchema,
  displayNameSchema,
  roundPreparationSchema,
  roundStartingSchema,
  roomCodeSchema,
  roomSessionSchema,
  selectBestClockEstimate,
  simulationChecksumReportSchema,
  simulationDesyncSchema,
  type RoomError,
  type RoomSession,
  type RoomState,
  type RoundPreparation,
  type RoundStarting,
  type BoardSnapshot,
  type AttackEvent,
  type OrderedAttackEvent,
  type MatchEnded,
  type MatchPaused,
  type MatchResuming,
  type MatchScore,
  type Pong,
  type RoundEnded,
  type SimulationChecksumReport,
  type SimulationDesync,
} from '@swapduel/contracts'
import { io, type Socket } from 'socket.io-client'

const SESSION_STORAGE_KEY = 'swapduel:room-session'
const ROUND_PREPARATION_KEY = 'swapduel:round-preparation'
const ROUND_STARTING_KEY = 'swapduel:round-starting'
const ROUND_RESULT_KEY = 'swapduel:round-result'
const MATCH_RESULT_KEY = 'swapduel:match-result'
const PENDING_ATTACKS_KEY = 'swapduel:pending-attacks'
const ATTACK_RETRY_MS = 1_000

type SocketResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RoomError }

let socket: Socket | null = null
let listenersAttached = false
let reconnectRetryTimer: ReturnType<typeof setTimeout> | null = null
let clockSyncPromise: Promise<boolean> | null = null
const attackRetryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>()
const attackDeliveriesInFlight = new Set<string>()

export function useRoomSocket() {
  const { readPlayerName, rememberPlayerName } = usePlayerName()
  const config = useRuntimeConfig()
  const connected = useState('room-connected', () => false)
  const clockSynchronized = useState(
    'server-clock-synchronized',
    () => false,
  )
  const serverClockOffsetMs = useState(
    'server-clock-offset-ms',
    () => 0,
  )
  const serverRoundTripMs = useState(
    'server-round-trip-ms',
    () => 0,
  )
  const roomState = useState<RoomState | null>('room-state', () => null)
  const session = useState<RoomSession | null>('room-session', () => null)
  const roundPreparation = useState<RoundPreparation | null>(
    'round-preparation',
    () => null,
  )
  const roundStarting = useState<RoundStarting | null>(
    'round-starting',
    () => null,
  )
  const opponentSnapshot = useState<BoardSnapshot | null>(
    'opponent-snapshot',
    () => null,
  )
  const incomingAttacks = useState<OrderedAttackEvent[]>(
    'incoming-attacks',
    () => [],
  )
  const pendingOutgoingAttacks = useState<AttackEvent[]>(
    'pending-outgoing-attacks',
    () => [],
  )
  const roundResult = useState<RoundEnded | null>(
    'round-result',
    () => null,
  )
  const matchResult = useState<MatchEnded | null>(
    'match-result',
    () => null,
  )
  const matchScores = useState<MatchScore[]>(
    'match-scores',
    () => [],
  )
  const networkPause = useState<MatchPaused | null>(
    'network-pause',
    () => null,
  )
  const networkResume = useState<MatchResuming | null>(
    'network-resume',
    () => null,
  )
  const errorMessage = useState('room-error', () => '')
  const simulationDesync = useState<SimulationDesync | null>(
    'simulation-desync',
    () => null,
  )

  function persistPendingOutgoingAttacks(
    attacks: AttackEvent[],
  ): void {
    pendingOutgoingAttacks.value = attacks
    if (!import.meta.client) return
    if (attacks.length === 0) {
      sessionStorage.removeItem(PENDING_ATTACKS_KEY)
      return
    }
    sessionStorage.setItem(PENDING_ATTACKS_KEY, JSON.stringify(attacks))
  }

  function clearPendingAttack(attackId: string): void {
    const timer = attackRetryTimers.get(attackId)
    if (timer !== undefined) clearTimeout(timer)
    attackRetryTimers.delete(attackId)
    persistPendingOutgoingAttacks(
      pendingOutgoingAttacks.value.filter(
        (attack) => attack.attackId !== attackId,
      ),
    )
  }

  function clearPendingAttacks(): void {
    for (const timer of attackRetryTimers.values()) clearTimeout(timer)
    attackRetryTimers.clear()
    attackDeliveriesInFlight.clear()
    persistPendingOutgoingAttacks([])
  }

  function clearRoomSession(): void {
    if (reconnectRetryTimer !== null) {
      clearTimeout(reconnectRetryTimer)
      reconnectRetryTimer = null
    }
    clearPendingAttacks()
    session.value = null
    roomState.value = null
    roundPreparation.value = null
    roundStarting.value = null
    opponentSnapshot.value = null
    incomingAttacks.value = []
    roundResult.value = null
    matchResult.value = null
    matchScores.value = []
    networkPause.value = null
    networkResume.value = null
    simulationDesync.value = null
    if (!import.meta.client) return
    localStorage.removeItem(SESSION_STORAGE_KEY)
    sessionStorage.removeItem(ROUND_PREPARATION_KEY)
    sessionStorage.removeItem(ROUND_STARTING_KEY)
    sessionStorage.removeItem(ROUND_RESULT_KEY)
    sessionStorage.removeItem(MATCH_RESULT_KEY)
  }

  function restorePendingAttacks(): void {
    if (
      !import.meta.client ||
      pendingOutgoingAttacks.value.length > 0
    ) {
      return
    }
    const serialized = sessionStorage.getItem(PENDING_ATTACKS_KEY)
    if (serialized === null) return

    try {
      const value: unknown = JSON.parse(serialized)
      if (!Array.isArray(value)) {
        sessionStorage.removeItem(PENDING_ATTACKS_KEY)
        return
      }
      const restored = value.flatMap((candidate) => {
        const parsed = attackEventSchema.safeParse(candidate)
        return parsed.success ? [parsed.data] : []
      })
      persistPendingOutgoingAttacks(restored)
    } catch {
      sessionStorage.removeItem(PENDING_ATTACKS_KEY)
    }
  }

  function persistSession(nextSession: RoomSession): void {
    const previousRoomId = session.value?.roomState.roomId
    if (
      previousRoomId !== undefined &&
      previousRoomId !== nextSession.roomState.roomId
    ) {
      roundPreparation.value = null
      roundStarting.value = null
      clearPendingAttacks()
      if (import.meta.client) {
        sessionStorage.removeItem(ROUND_PREPARATION_KEY)
        sessionStorage.removeItem(ROUND_STARTING_KEY)
        sessionStorage.removeItem(ROUND_RESULT_KEY)
        sessionStorage.removeItem(MATCH_RESULT_KEY)
      }
    }
    session.value = nextSession
    roomState.value = nextSession.roomState
    if (import.meta.client) {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify(nextSession),
      )
      const player = nextSession.roomState.players.find(
        ({ playerId }) => playerId === nextSession.playerId,
      )
      if (player !== undefined) {
        rememberPlayerName(player.displayName)
      }
    }
  }

  function restoreSession(): RoomSession | null {
    if (!import.meta.client || session.value !== null) return session.value
    const serialized = localStorage.getItem(SESSION_STORAGE_KEY)
    if (serialized === null) return null

    try {
      const parsed = roomSessionSchema.safeParse(JSON.parse(serialized))
      if (!parsed.success) return null
      session.value = parsed.data
      // Restore the room alongside the session, mirroring persistSession.
      // Without this, roomState stays null until the socket delivers
      // room:state, and anything gating on the room sees nothing on load.
      // Guarded above by the session.value !== null early return, so this
      // never clobbers live state with the stored copy.
      roomState.value = parsed.data.roomState
      return parsed.data
    } catch {
      return null
    }
  }

  function persistRoundPreparation(
    preparation: RoundPreparation,
  ): void {
    clearPendingAttacks()
    roundPreparation.value = preparation
    roundStarting.value = null
    opponentSnapshot.value = null
    incomingAttacks.value = []
    roundResult.value = null
    matchResult.value = null
    networkPause.value = null
    networkResume.value = null
    simulationDesync.value = null
    if (import.meta.client) {
      sessionStorage.setItem(
        ROUND_PREPARATION_KEY,
        JSON.stringify(preparation),
      )
      sessionStorage.removeItem(ROUND_STARTING_KEY)
      sessionStorage.removeItem(ROUND_RESULT_KEY)
    }
  }

  function persistRoundStarting(starting: RoundStarting): void {
    roundPreparation.value = starting
    roundStarting.value = starting
    if (import.meta.client) {
      sessionStorage.setItem(
        ROUND_PREPARATION_KEY,
        JSON.stringify(starting),
      )
      sessionStorage.setItem(
        ROUND_STARTING_KEY,
        JSON.stringify(starting),
      )
    }
  }

  function restoreRoundState(): void {
    if (!import.meta.client) return
    const serializedPreparation = sessionStorage.getItem(
      ROUND_PREPARATION_KEY,
    )
    const serializedStarting = sessionStorage.getItem(ROUND_STARTING_KEY)
    const serializedRoundResult = sessionStorage.getItem(ROUND_RESULT_KEY)
    const serializedMatchResult = sessionStorage.getItem(MATCH_RESULT_KEY)

    try {
      if (serializedPreparation !== null) {
        const parsed = roundPreparationSchema.safeParse(
          JSON.parse(serializedPreparation),
        )
        if (parsed.success) roundPreparation.value = parsed.data
      }
      if (serializedStarting !== null) {
        const parsed = roundStartingSchema.safeParse(
          JSON.parse(serializedStarting),
        )
        if (parsed.success) roundStarting.value = parsed.data
      }
      if (serializedRoundResult !== null) {
        const parsed = roundEndedSchema.safeParse(
          JSON.parse(serializedRoundResult),
        )
        if (parsed.success) {
          roundResult.value = parsed.data
          matchScores.value = parsed.data.scores
          networkPause.value = null
          networkResume.value = null
        }
      }
      if (serializedMatchResult !== null) {
        const parsed = matchEndedSchema.safeParse(
          JSON.parse(serializedMatchResult),
        )
        if (parsed.success) {
          matchResult.value = parsed.data
          matchScores.value = parsed.data.scores
        }
      }
    } catch {
      sessionStorage.removeItem(ROUND_PREPARATION_KEY)
      sessionStorage.removeItem(ROUND_STARTING_KEY)
      sessionStorage.removeItem(ROUND_RESULT_KEY)
      sessionStorage.removeItem(MATCH_RESULT_KEY)
    }
  }

  function reconnectSavedSession(activeSocket: Socket): void {
    if (reconnectRetryTimer !== null) {
      clearTimeout(reconnectRetryTimer)
      reconnectRetryTimer = null
    }
    const activeSession = session.value
    if (activeSession === null) return

    activeSocket.emit(
      'room:reconnect',
      {
        roomId: activeSession.roomState.roomId,
        playerId: activeSession.playerId,
        reconnectToken: activeSession.reconnectToken,
      },
      (result: SocketResult<RoomSession>) => {
        if (result.ok) {
          persistSession(result.data)
          retryPendingAttacks()
          return
        }
        errorMessage.value = result.error.message
        if (result.error.code === 'RATE_LIMITED') {
          reconnectRetryTimer = setTimeout(
            () => reconnectSavedSession(activeSocket),
            Math.max(250, result.error.retryAfterMs ?? 1_000),
          )
          return
        }
        clearRoomSession()
      },
    )
  }

  function ensureSocket(): Socket {
    if (socket === null) {
      socket = io(config.public.socketUrl || undefined, {
        autoConnect: true,
        transports: ['websocket', 'polling'],
      })
    }

    if (!listenersAttached) {
      socket.on('connect', () => {
        connected.value = true
        errorMessage.value = ''
        void synchronizeServerClock()
        reconnectSavedSession(socket!)
      })
      socket.on('disconnect', () => {
        connected.value = false
        clockSynchronized.value = false
        if (reconnectRetryTimer !== null) {
          clearTimeout(reconnectRetryTimer)
          reconnectRetryTimer = null
        }
      })
      socket.on('connect_error', () => {
        connected.value = false
        errorMessage.value = 'Could not connect to the game server.'
      })
      socket.on('room:state', (nextState: unknown) => {
        const parsed = roomSessionSchema.shape.roomState.safeParse(nextState)
        const activeRoomId = session.value?.roomState.roomId
        if (
          parsed.success &&
          (activeRoomId === undefined || parsed.data.roomId === activeRoomId)
        ) {
          roomState.value = parsed.data
        }
      })
      socket.on('room:error', (error: RoomError) => {
        if (
          error.code === 'ROOM_NOT_FOUND' &&
          error.roomId === session.value?.roomState.roomId
        ) {
          clearRoomSession()
        }
        errorMessage.value = error.message
      })
      socket.on('match:starting', (payload: unknown) => {
        const parsed = roundPreparationSchema.safeParse(payload)
        if (parsed.success) {
          matchScores.value = []
          matchResult.value = null
          errorMessage.value = ''
          if (import.meta.client) {
            sessionStorage.removeItem(MATCH_RESULT_KEY)
          }
          persistRoundPreparation(parsed.data)
        }
      })
      socket.on('round:prepare', (payload: unknown) => {
        const parsed = roundPreparationSchema.safeParse(payload)
        if (parsed.success) {
          // A notice from the previous round must not follow the player
          // into the next one; errorMessage is app-wide shared state.
          errorMessage.value = ''
          persistRoundPreparation(parsed.data)
        }
      })
      socket.on('round:starting', (payload: unknown) => {
        const parsed = roundStartingSchema.safeParse(payload)
        if (parsed.success) {
          errorMessage.value = ''
          persistRoundStarting(parsed.data)
        }
      })
      socket.on('opponent:snapshot', (payload: unknown) => {
        const parsed = boardSnapshotSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.matchId === roundPreparation.value?.matchId &&
          parsed.data.roundId === roundPreparation.value.roundId &&
          parsed.data.playerId !== session.value?.playerId &&
          (opponentSnapshot.value === null ||
            parsed.data.sequence > opponentSnapshot.value.sequence)
        ) {
          opponentSnapshot.value = parsed.data
        }
      })
      socket.on(
        'player:reconnected',
        (payload: { playerId?: unknown }) => {
          if (
            typeof payload.playerId === 'string' &&
            payload.playerId !== session.value?.playerId
          ) {
            opponentSnapshot.value = null
          }
        },
      )
      socket.on('attack:incoming', (payload: unknown) => {
        const parsed = orderedAttackEventSchema.safeParse(payload)
        if (
          !parsed.success ||
          parsed.data.targetId !== session.value?.playerId ||
          parsed.data.matchId !== roundPreparation.value?.matchId ||
          parsed.data.roundId !== roundPreparation.value.roundId ||
          incomingAttacks.value.some(
            ({ serverSequence }) =>
              serverSequence === parsed.data.serverSequence,
          )
        ) {
          return
        }
        incomingAttacks.value = [
          ...incomingAttacks.value,
          parsed.data,
        ].sort((left, right) => left.serverSequence - right.serverSequence)
      })
      socket.on('attack:confirmed', (payload: unknown) => {
        const parsed = orderedAttackEventSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.senderId === session.value?.playerId
        ) {
          clearPendingAttack(parsed.data.attackId)
        }
      })
      socket.on('simulation:desync', (payload: unknown) => {
        const parsed = simulationDesyncSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.playerId === session.value?.playerId &&
          parsed.data.matchId === roundPreparation.value?.matchId &&
          parsed.data.roundId === roundPreparation.value.roundId
        ) {
          simulationDesync.value = parsed.data
        }
      })
      socket.on('round:ended', (payload: unknown) => {
        const parsed = roundEndedSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.matchId === roundPreparation.value?.matchId &&
          parsed.data.roundId === roundPreparation.value.roundId
        ) {
          clearPendingAttacks()
          roundResult.value = parsed.data
          matchScores.value = parsed.data.scores
          if (import.meta.client) {
            sessionStorage.setItem(
              ROUND_RESULT_KEY,
              JSON.stringify(parsed.data),
            )
          }
        }
      })
      socket.on('match:ended', (payload: unknown) => {
        const parsed = matchEndedSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.matchId === roundPreparation.value?.matchId
        ) {
          matchResult.value = parsed.data
          matchScores.value = parsed.data.scores
          if (import.meta.client) {
            sessionStorage.setItem(
              MATCH_RESULT_KEY,
              JSON.stringify(parsed.data),
            )
          }
        }
      })
      socket.on('match:paused', (payload: unknown) => {
        const parsed = matchPausedSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.matchId === roundPreparation.value?.matchId &&
          parsed.data.roundId === roundPreparation.value.roundId
        ) {
          networkPause.value = parsed.data
          networkResume.value = null
        }
      })
      socket.on('match:resuming', (payload: unknown) => {
        const parsed = matchResumingSchema.safeParse(payload)
        if (
          parsed.success &&
          parsed.data.matchId === roundPreparation.value?.matchId &&
          parsed.data.roundId === roundPreparation.value.roundId
        ) {
          networkResume.value = parsed.data
          retryPendingAttacks(
            Math.max(0, parsed.data.resumeAt - Date.now()),
          )
        }
      })
      listenersAttached = true
    }

    return socket
  }

  async function send<T>(
    event: string,
    payload: unknown,
  ): Promise<SocketResult<T>> {
    const activeSocket = ensureSocket()
    return await new Promise((resolve) => {
      activeSocket.timeout(7_000).emit(
        event,
        payload,
        (
          timeoutError: Error | null,
          response: SocketResult<T> | undefined,
        ) => {
          if (timeoutError !== null || response === undefined) {
            resolve({
              ok: false,
              error: {
                code: 'INVALID_REQUEST',
                message: 'The game server did not respond. Try again.',
              },
            })
            return
          }
          resolve(response)
        },
      )
    })
  }

  function synchronizeServerClock(): Promise<boolean> {
    if (clockSyncPromise !== null) return clockSyncPromise
    clockSyncPromise = performServerClockSync().finally(() => {
      clockSyncPromise = null
    })
    return clockSyncPromise
  }

  async function performServerClockSync(): Promise<boolean> {
    const activeSocket = ensureSocket()
    if (!activeSocket.connected) {
      clockSynchronized.value = false
      return false
    }

    const samples = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const sentAt = Date.now()
        const result = await send<Pong>('ping', sentAt)
        const receivedAt = Date.now()
        if (!result.ok) return null
        const parsed = pongSchema.safeParse(result.data)
        if (
          !parsed.success ||
          parsed.data.clientTimestamp !== sentAt
        ) {
          return null
        }
        return {
          sentAt,
          receivedAt,
          serverTimestamp: parsed.data.serverTimestamp,
        }
      }),
    )
    const estimate = selectBestClockEstimate(
      samples.filter((sample) => sample !== null),
    )
    if (estimate === null) {
      clockSynchronized.value = false
      return false
    }

    serverClockOffsetMs.value = estimate.offsetMs
    serverRoundTripMs.value = estimate.roundTripMs
    clockSynchronized.value = true
    return true
  }

  function getServerNow(): number {
    return Date.now() + serverClockOffsetMs.value
  }

  async function createRoom(displayName: string): Promise<RoomSession | null> {
    const parsed = displayNameSchema.safeParse(displayName)
    if (!parsed.success) {
      errorMessage.value = 'Enter a player name between 1 and 20 characters.'
      return null
    }

    errorMessage.value = ''
    const result = await send<RoomSession>('room:create', {
      displayName: parsed.data,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return null
    }

    persistSession(result.data)
    return result.data
  }

  async function joinRoom(
    roomCode: string,
    displayName: string,
  ): Promise<RoomSession | null> {
    const parsedCode = roomCodeSchema.safeParse(roomCode)
    const parsedName = displayNameSchema.safeParse(displayName)
    if (!parsedCode.success || !parsedName.success) {
      errorMessage.value = 'Check the room code and player name.'
      return null
    }

    errorMessage.value = ''
    const result = await send<RoomSession>('room:join', {
      roomCode: parsedCode.data,
      displayName: parsedName.data,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return null
    }

    persistSession(result.data)
    return result.data
  }

  async function setReady(ready: boolean): Promise<boolean> {
    const activeSession = session.value ?? restoreSession()
    if (activeSession === null) {
      errorMessage.value = 'Your room session is missing.'
      return false
    }

    const result = await send<RoomState>('player:ready', {
      roomId: activeSession.roomState.roomId,
      playerId: activeSession.playerId,
      reconnectToken: activeSession.reconnectToken,
      ready,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }

    roomState.value = result.data
    return true
  }

  async function startMatch(): Promise<RoundPreparation | null> {
    const activeSession = session.value ?? restoreSession()
    if (activeSession === null) {
      errorMessage.value = 'Your room session is missing.'
      return null
    }

    errorMessage.value = ''
    const result = await send<RoundPreparation>('match:start', {
      roomId: activeSession.roomState.roomId,
      playerId: activeSession.playerId,
      reconnectToken: activeSession.reconnectToken,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return null
    }

    persistRoundPreparation(result.data)
    return result.data
  }

  async function confirmRoundReady(): Promise<boolean> {
    const activeSession = session.value ?? restoreSession()
    const preparation = roundPreparation.value
    if (activeSession === null || preparation === null) {
      errorMessage.value = 'The round setup is missing.'
      return false
    }

    const result = await send<RoundStarting | null>('round:ready', {
      roomId: activeSession.roomState.roomId,
      playerId: activeSession.playerId,
      reconnectToken: activeSession.reconnectToken,
      matchId: preparation.matchId,
      roundId: preparation.roundId,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }
    if (result.data !== null) persistRoundStarting(result.data)
    return true
  }

  function sendBoardSnapshot(snapshot: BoardSnapshot): void {
    const activeSocket = ensureSocket()
    if (!activeSocket.connected) return
    activeSocket.emit('board:snapshot', snapshot)
  }

  function sendSimulationChecksum(
    report: SimulationChecksumReport,
  ): void {
    const parsed = simulationChecksumReportSchema.safeParse(report)
    if (!parsed.success) return
    const activeSocket = ensureSocket()
    if (!activeSocket.connected) return
    activeSocket.emit('simulation:checksum', parsed.data)
  }

  async function sendAttack(attack: AttackEvent): Promise<boolean> {
    const parsed = attackEventSchema.safeParse(attack)
    if (!parsed.success) {
      errorMessage.value = 'Could not prepare the outgoing attack.'
      return false
    }
    if (
      !pendingOutgoingAttacks.value.some(
        (pending) => pending.attackId === parsed.data.attackId,
      )
    ) {
      persistPendingOutgoingAttacks([
        ...pendingOutgoingAttacks.value,
        parsed.data,
      ])
    }
    return await deliverPendingAttack(parsed.data.attackId)
  }

  function scheduleAttackRetry(
    attackId: string,
    delayMs = ATTACK_RETRY_MS,
  ): void {
    const previous = attackRetryTimers.get(attackId)
    if (previous !== undefined) clearTimeout(previous)
    attackRetryTimers.set(
      attackId,
      setTimeout(() => {
        attackRetryTimers.delete(attackId)
        void deliverPendingAttack(attackId)
      }, Math.max(100, delayMs)),
    )
  }

  function retryPendingAttacks(delayMs = 0): void {
    for (const attack of pendingOutgoingAttacks.value) {
      scheduleAttackRetry(attack.attackId, delayMs)
    }
  }

  async function deliverPendingAttack(
    attackId: string,
  ): Promise<boolean> {
    const attack = pendingOutgoingAttacks.value.find(
      (candidate) => candidate.attackId === attackId,
    )
    if (attack === undefined) return true
    if (attackDeliveriesInFlight.has(attackId)) return false

    const preparation = roundPreparation.value
    const resumeDelay =
      networkResume.value === null
        ? 0
        : networkResume.value.resumeAt - Date.now()
    if (
      !connected.value ||
      networkPause.value !== null ||
      resumeDelay > 0 ||
      preparation?.matchId !== attack.matchId ||
      preparation.roundId !== attack.roundId
    ) {
      scheduleAttackRetry(
        attackId,
        resumeDelay > 0 ? resumeDelay : ATTACK_RETRY_MS,
      )
      return false
    }

    attackDeliveriesInFlight.add(attackId)
    const result = await send<OrderedAttackEvent>('attack:create', attack)
    attackDeliveriesInFlight.delete(attackId)

    if (
      !pendingOutgoingAttacks.value.some(
        (pending) => pending.attackId === attackId,
      )
    ) {
      return true
    }
    if (result.ok) {
      clearPendingAttack(attackId)
      return true
    }

    scheduleAttackRetry(attackId)
    return false
  }

  function drainIncomingAttacks(): OrderedAttackEvent[] {
    const attacks = incomingAttacks.value
    incomingAttacks.value = []
    return attacks
  }

  function acknowledgeAttack(attack: OrderedAttackEvent): void {
    const activeSocket = ensureSocket()
    if (!activeSocket.connected) return
    activeSocket.emit('attack:ack', {
      protocolVersion: attack.protocolVersion,
      matchId: attack.matchId,
      roundId: attack.roundId,
      playerId: attack.targetId,
      serverSequence: attack.serverSequence,
    })
  }

  async function reportTopOut(clientTimestamp = Date.now()): Promise<boolean> {
    const preparation = roundPreparation.value
    const playerId = session.value?.playerId
    if (preparation === null || playerId === undefined) return false

    const result = await send<{ accepted: boolean }>('round:topout', {
      protocolVersion: 1,
      matchId: preparation.matchId,
      roundId: preparation.roundId,
      playerId,
      clientTimestamp,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }
    return result.data.accepted
  }

  async function readyForNextRound(): Promise<boolean> {
    const activeSession = session.value ?? restoreSession()
    const endedRound = roundResult.value
    if (activeSession === null || endedRound === null) return false

    const result = await send<RoundPreparation | null>('round:next', {
      roomId: activeSession.roomState.roomId,
      playerId: activeSession.playerId,
      reconnectToken: activeSession.reconnectToken,
      matchId: endedRound.matchId,
      roundId: endedRound.roundId,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }
    if (result.data !== null) persistRoundPreparation(result.data)
    return true
  }

  async function requestRematch(): Promise<boolean> {
    const activeSession = session.value ?? restoreSession()
    const endedMatch = matchResult.value
    if (activeSession === null || endedMatch === null) return false

    const result = await send<RoundPreparation | null>('match:rematch', {
      roomId: activeSession.roomState.roomId,
      playerId: activeSession.playerId,
      reconnectToken: activeSession.reconnectToken,
      matchId: endedMatch.matchId,
    })
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }
    if (result.data !== null) persistRoundPreparation(result.data)
    return true
  }

  function getSavedDisplayName(): string {
    return readPlayerName()
  }

  if (import.meta.client) {
    restoreSession()
    restoreRoundState()
    restorePendingAttacks()
    ensureSocket()
  }

  return {
    connected: readonly(connected),
    clockSynchronized: readonly(clockSynchronized),
    serverRoundTripMs: readonly(serverRoundTripMs),
    roomState: readonly(roomState),
    session: readonly(session),
    roundPreparation: readonly(roundPreparation),
    roundStarting: readonly(roundStarting),
    opponentSnapshot: readonly(opponentSnapshot),
    incomingAttacks: readonly(incomingAttacks),
    roundResult: readonly(roundResult),
    matchResult: readonly(matchResult),
    matchScores: readonly(matchScores),
    networkPause: readonly(networkPause),
    networkResume: readonly(networkResume),
    simulationDesync: readonly(simulationDesync),
    errorMessage,
    createRoom,
    joinRoom,
    setReady,
    startMatch,
    confirmRoundReady,
    synchronizeServerClock,
    getServerNow,
    sendBoardSnapshot,
    sendSimulationChecksum,
    sendAttack,
    drainIncomingAttacks,
    acknowledgeAttack,
    reportTopOut,
    readyForNextRound,
    requestRematch,
    getSavedDisplayName,
  }
}
