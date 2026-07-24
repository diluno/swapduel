import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

const id = z.string().trim().min(1).max(128)
const nonNegativeInteger = z.number().int().nonnegative()

export const displayNameSchema = z.string().trim().min(1).max(20)

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
})

export const encodedGarbageSchema = z.object({
  id: nonNegativeInteger,
  type: z.enum(['normal', 'metal']),
  column: z.number().int().min(0).max(5),
  row: z.number().int().min(0).max(12),
  width: z.number().int().min(1).max(6),
  height: z.number().int().min(1).max(13),
  state: z.enum(['queued', 'falling', 'idle', 'converting']),
})

export const attackBlockSchema = z.object({
  width: z.number().int().min(1).max(6),
  height: z.number().int().min(1).max(12),
  type: z.enum(['normal', 'metal']),
})

export const attackEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  attackId: id,
  matchId: id,
  roundId: id,
  senderId: id,
  localSequence: nonNegativeInteger,
  clientTimestamp: z.number().finite(),
  kind: z.enum(['combo', 'chain', 'shock']),
  blocks: z.array(attackBlockSchema).min(1).max(12),
})

export const orderedAttackEventSchema = attackEventSchema.extend({
  targetId: id,
  serverSequence: nonNegativeInteger,
  serverTimestamp: z.number().finite(),
})

export const encodedAttackPreviewSchema = z.object({
  serverSequence: nonNegativeInteger,
  blocks: z.array(attackBlockSchema).max(12),
})

export const boardSnapshotSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: id,
  roundId: id,
  playerId: id,
  sequence: nonNegativeInteger,
  clientTimestamp: z.number().finite(),
  riseOffset: z.number().min(0).max(1),
  dangerRemainingMs: z.number().nonnegative().nullable(),
  chainLevel: nonNegativeInteger,
  cells: z.array(encodedCellSchema).max(72),
  garbage: z.array(encodedGarbageSchema).max(32),
  incomingGarbage: z.array(encodedAttackPreviewSchema).max(32),
})

export const playerSessionSchema = z.object({
  playerId: id,
  roomId: id,
  displayName: displayNameSchema,
  slot: z.union([z.literal(1), z.literal(2)]),
  connected: z.boolean(),
  ready: z.boolean(),
})

export const roomStateSchema = z.object({
  roomId: id,
  roomCode: z.string().regex(/^[A-Z0-9]{6}$/),
  hostPlayerId: id,
  players: z.array(playerSessionSchema).max(2),
  status: z.enum(['waiting', 'starting', 'playing', 'finished']),
  activeMatchId: id.nullable(),
})

export type AttackEvent = z.infer<typeof attackEventSchema>
export type OrderedAttackEvent = z.infer<typeof orderedAttackEventSchema>
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>
export type PlayerSession = z.infer<typeof playerSessionSchema>
export type RoomState = z.infer<typeof roomStateSchema>
