import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

const id = z.string().trim().min(1).max(128)
const nonNegativeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/)

export const encodedCellSchema = z.object({
  row: z.number().int().min(0).max(11),
  column: z.number().int().min(0).max(5),
  type: z.enum(['circle', 'triangle', 'star', 'diamond', 'heart', 'crescent', 'shock']),
  state: z.enum([
    'idle',
    'swapping',
    'hovering',
    'falling',
    'matched',
    'flashing',
    'clearing',
    'garbage-locked',
  ]),
}).strict()

export const encodedGarbageSchema = z.object({
  id: nonNegativeInteger,
  type: z.enum(['normal', 'metal']),
  column: z.number().int().min(0).max(5),
  row: z.number().int().min(0).max(12),
  width: z.number().int().min(1).max(6),
  height: z.number().int().min(1).max(13),
  state: z.enum(['queued', 'falling', 'idle', 'converting']),
}).strict()

export const attackBlockSchema = z.object({
  width: z.number().int().min(1).max(6),
  height: z.number().int().min(1).max(12),
  type: z.enum(['normal', 'metal']),
}).strict()

export const attackEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  attackId: id,
  matchId: id,
  roundId: id,
  senderId: id,
  localSequence: nonNegativeInteger,
  clientTimestamp: z.number().finite().nonnegative(),
  kind: z.enum(['combo', 'chain', 'shock']),
  blocks: z.array(attackBlockSchema).min(1).max(12),
}).strict()

export const orderedAttackEventSchema = attackEventSchema.extend({
  targetId: id,
  serverSequence: nonNegativeInteger,
  serverTimestamp: z.number().finite(),
}).strict()

export const attackAckSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  serverSequence: nonNegativeInteger,
}).strict()

export const encodedAttackPreviewSchema = z.object({
  serverSequence: nonNegativeInteger,
  blocks: z.array(attackBlockSchema).max(12),
}).strict()

export const boardSnapshotSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  sequence: nonNegativeInteger,
  clientTimestamp: z.number().finite().nonnegative(),
  riseOffset: z.number().min(0).max(1),
  dangerRemainingMs: z.number().nonnegative().nullable(),
  chainLevel: nonNegativeInteger,
  cells: z.array(encodedCellSchema).max(72),
  garbage: z.array(encodedGarbageSchema).max(32),
  incomingGarbage: z.array(encodedAttackPreviewSchema).max(32),
}).strict()

export const playerSessionSchema = z.object({
  playerId: id,
  roomId: id,
  displayName: displayNameSchema,
  slot: z.union([z.literal(1), z.literal(2)]),
  connected: z.boolean(),
  ready: z.boolean(),
}).strict()

export const roomStateSchema = z.object({
  roomId: id,
  roomCode: roomCodeSchema,
  hostPlayerId: id,
  players: z.array(playerSessionSchema).max(2),
  status: z.enum(['waiting', 'starting', 'playing', 'finished']),
  activeMatchId: id.nullable(),
}).strict()

export const roomCreatePayloadSchema = z.object({
  displayName: displayNameSchema,
}).strict()

export const roomJoinPayloadSchema = z.object({
  roomCode: roomCodeSchema,
  displayName: displayNameSchema,
}).strict()

export const roomCredentialsSchema = z.object({
  roomId: id,
  playerId: id,
  reconnectToken: id,
}).strict()

export const roomReconnectPayloadSchema = roomCredentialsSchema

export const playerReadyPayloadSchema = roomCredentialsSchema.extend({
  ready: z.boolean(),
}).strict()

export const roomSessionSchema = z.object({
  roomState: roomStateSchema,
  playerId: id,
  reconnectToken: id,
}).strict()

export const roomErrorSchema = z.object({
  code: z.enum([
    'INVALID_REQUEST',
    'ROOM_NOT_FOUND',
    'ROOM_FULL',
    'ROOM_NOT_WAITING',
    'HOST_ONLY',
    'PLAYERS_NOT_READY',
    'STALE_MATCH',
    'UNAUTHORIZED',
    'RATE_LIMITED',
  ]),
  message: z.string().min(1).max(200),
  roomId: id.optional(),
  retryAfterMs: nonNegativeInteger.max(60_000).optional(),
}).strict()

export const matchStartPayloadSchema = roomCredentialsSchema

export const roundPreparationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: id,
  matchId: id,
  roundId: id,
  roundNumber: z.number().int().min(1).max(5),
  roundSeed: id,
}).strict()

export const roundReadyPayloadSchema = roomCredentialsSchema.extend({
  matchId: id,
  roundId: id,
}).strict()

export const roundStartingSchema = roundPreparationSchema.extend({
  startAt: z.number().finite().positive(),
}).strict()

export const roundTopOutSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  clientTimestamp: z.number().finite().nonnegative(),
}).strict()

export const matchScoreSchema = z.object({
  playerId: id,
  wins: z.number().int().min(0).max(2),
}).strict()

export const roundEndedSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: id,
  matchId: id,
  roundId: id,
  roundNumber: z.number().int().min(1).max(5),
  result: z.enum(['win', 'draw']),
  winnerPlayerId: id.nullable(),
  loserPlayerId: id.nullable(),
  scores: z.array(matchScoreSchema).length(2),
}).strict()

export const matchEndedSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: id,
  matchId: id,
  finalRoundId: id,
  winnerPlayerId: id,
  scores: z.array(matchScoreSchema).length(2),
}).strict()

export const nextRoundReadyPayloadSchema = roomCredentialsSchema.extend({
  matchId: id,
  roundId: id,
}).strict()

export const matchRematchPayloadSchema = roomCredentialsSchema.extend({
  matchId: id,
}).strict()

export const matchPausedSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: id,
  matchId: id,
  roundId: id,
  disconnectedPlayerId: id,
  forfeitAt: z.number().finite().positive(),
}).strict()

export const matchResumingSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: id,
  matchId: id,
  roundId: id,
  resumeAt: z.number().finite().positive(),
}).strict()

export const pingPayloadSchema = z.number().finite().nonnegative()

export const pongSchema = z.object({
  clientTimestamp: z.number().finite().nonnegative(),
  serverTimestamp: z.number().finite().nonnegative(),
}).strict()

export const simulationChecksumReportSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  sequence: nonNegativeInteger,
  simulationStep: nonNegativeInteger,
  checksum: z.string().regex(/^[0-9a-f]{8}$/),
  clientTimestamp: z.number().finite().nonnegative(),
}).strict()

export const simulationDesyncSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  simulationStep: nonNegativeInteger,
  detectedAt: z.number().finite().nonnegative(),
}).strict()

export interface ClockSample {
  sentAt: number
  receivedAt: number
  serverTimestamp: number
}

export interface ClockEstimate {
  offsetMs: number
  roundTripMs: number
}

export function estimateServerClock(sample: ClockSample): ClockEstimate {
  const roundTripMs = Math.max(0, sample.receivedAt - sample.sentAt)
  return {
    offsetMs:
      sample.serverTimestamp + roundTripMs / 2 - sample.receivedAt,
    roundTripMs,
  }
}

export function selectBestClockEstimate(
  samples: ClockSample[],
): ClockEstimate | null {
  let best: ClockEstimate | null = null
  for (const sample of samples) {
    const estimate = estimateServerClock(sample)
    if (best === null || estimate.roundTripMs < best.roundTripMs) {
      best = estimate
    }
  }
  return best
}

export type AttackEvent = z.infer<typeof attackEventSchema>
export type OrderedAttackEvent = z.infer<typeof orderedAttackEventSchema>
export type AttackAck = z.infer<typeof attackAckSchema>
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type PlayerSession = z.infer<typeof playerSessionSchema>
export type RoomState = z.infer<typeof roomStateSchema>
export type RoomCreatePayload = z.infer<typeof roomCreatePayloadSchema>
export type RoomJoinPayload = z.infer<typeof roomJoinPayloadSchema>
export type RoomCredentials = z.infer<typeof roomCredentialsSchema>
export type RoomReconnectPayload = z.infer<
  typeof roomReconnectPayloadSchema
>
export type PlayerReadyPayload = z.infer<typeof playerReadyPayloadSchema>
export type RoomSession = z.infer<typeof roomSessionSchema>
export type RoomError = z.infer<typeof roomErrorSchema>
export type MatchStartPayload = z.infer<typeof matchStartPayloadSchema>
export type RoundPreparation = z.infer<typeof roundPreparationSchema>
export type RoundReadyPayload = z.infer<typeof roundReadyPayloadSchema>
export type RoundStarting = z.infer<typeof roundStartingSchema>
export type RoundTopOut = z.infer<typeof roundTopOutSchema>
export type MatchScore = z.infer<typeof matchScoreSchema>
export type RoundEnded = z.infer<typeof roundEndedSchema>
export type MatchEnded = z.infer<typeof matchEndedSchema>
export type NextRoundReadyPayload = z.infer<
  typeof nextRoundReadyPayloadSchema
>
export type MatchRematchPayload = z.infer<
  typeof matchRematchPayloadSchema
>
export type MatchPaused = z.infer<typeof matchPausedSchema>
export type MatchResuming = z.infer<typeof matchResumingSchema>
export type Pong = z.infer<typeof pongSchema>
export type SimulationChecksumReport = z.infer<
  typeof simulationChecksumReportSchema
>
export type SimulationDesync = z.infer<typeof simulationDesyncSchema>
