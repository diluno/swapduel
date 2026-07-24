import {
  boardSnapshotSchema,
  displayNameSchema,
  estimateServerClock,
  roomCreatePayloadSchema,
  roomErrorSchema,
  selectBestClockEstimate,
} from '@swapduel/contracts'
import { describe, expect, it } from 'vitest'

describe('network contract hardening', () => {
  it('rejects unknown payload fields and control characters in names', () => {
    expect(
      roomCreatePayloadSchema.safeParse({
        displayName: 'Mira',
        admin: true,
      }).success,
    ).toBe(false)
    expect(displayNameSchema.safeParse('Mira\nNoah').success).toBe(false)
    expect(displayNameSchema.safeParse('Peach 🍑').success).toBe(true)
  })

  it('bounds snapshot collections before they reach room logic', () => {
    expect(
      boardSnapshotSchema.safeParse({
        protocolVersion: 1,
        matchId: 'match',
        roundId: 'round',
        playerId: 'player',
        sequence: 1,
        clientTimestamp: 1,
        riseOffset: 0,
        dangerRemainingMs: null,
        chainLevel: 0,
        cells: Array.from({ length: 73 }, (_, index) => ({
          row: index % 12,
          column: index % 6,
          type: 'circle',
          state: 'idle',
        })),
        garbage: [],
        incomingGarbage: [],
      }).success,
    ).toBe(false)
  })

  it('accepts bounded retry information in rate-limit errors', () => {
    expect(
      roomErrorSchema.parse({
        code: 'RATE_LIMITED',
        message: 'Wait and try again.',
        retryAfterMs: 1_000,
      }),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 1_000,
    })
    expect(
      roomErrorSchema.safeParse({
        code: 'RATE_LIMITED',
        message: 'Wait and try again.',
        retryAfterMs: 60_001,
      }).success,
    ).toBe(false)
  })

  it('estimates server time from the lowest-latency clock sample', () => {
    expect(
      estimateServerClock({
        sentAt: 1_000,
        receivedAt: 1_100,
        serverTimestamp: 1_550,
      }),
    ).toEqual({
      offsetMs: 500,
      roundTripMs: 100,
    })
    expect(
      selectBestClockEstimate([
        {
          sentAt: 1_000,
          receivedAt: 1_200,
          serverTimestamp: 1_600,
        },
        {
          sentAt: 2_000,
          receivedAt: 2_040,
          serverTimestamp: 2_520,
        },
      ]),
    ).toEqual({
      offsetMs: 500,
      roundTripMs: 40,
    })
  })
})
