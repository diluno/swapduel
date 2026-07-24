import { describe, expect, it } from 'vitest'
import { FixedWindowRateLimiter } from '../src/security/rate-limiter'

describe('FixedWindowRateLimiter', () => {
  it('rejects requests over the limit until the window resets', () => {
    const clock = { now: 1_000 }
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => clock.now,
    })

    expect(limiter.consume('player')).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    })
    expect(limiter.consume('player').allowed).toBe(true)
    expect(limiter.consume('player')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1_000,
    })

    clock.now = 1_999
    expect(limiter.consume('player').retryAfterMs).toBe(1)
    clock.now = 2_000
    expect(limiter.consume('player')).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    })
  })

  it('tracks clients independently and can forget socket-scoped keys', () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
    })

    expect(limiter.consume('socket-a').allowed).toBe(true)
    expect(limiter.consume('socket-a').allowed).toBe(false)
    expect(limiter.consume('socket-b').allowed).toBe(true)
    limiter.delete('socket-a')
    expect(limiter.consume('socket-a').allowed).toBe(true)
  })

  it('prunes stale keys and remains bounded under key churn', () => {
    const clock = { now: 1_000 }
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 100,
      maxKeys: 2,
      now: () => clock.now,
    })

    limiter.consume('first')
    clock.now = 1_010
    limiter.consume('second')
    clock.now = 1_020
    limiter.consume('third')
    expect(limiter.size).toBe(2)
    expect(limiter.consume('first').allowed).toBe(true)
    expect(limiter.size).toBe(2)

    clock.now = 1_200
    expect(limiter.prune()).toBe(2)
    expect(limiter.size).toBe(0)
  })
})
