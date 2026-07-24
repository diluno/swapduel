export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export interface FixedWindowRateLimiterOptions {
  limit: number
  windowMs: number
  maxKeys?: number
  now?: () => number
}

interface WindowEntry {
  count: number
  startedAt: number
  lastSeenAt: number
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number

  constructor(options: FixedWindowRateLimiterOptions) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      !Number.isFinite(options.windowMs) ||
      options.windowMs <= 0
    ) {
      throw new Error('Rate limiter options must be positive.')
    }
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.maxKeys = Math.max(1, options.maxKeys ?? 10_000)
    this.now = options.now ?? Date.now
  }

  consume(key: string): RateLimitResult {
    const now = this.now()
    let entry = this.entries.get(key)
    if (
      entry === undefined ||
      now - entry.startedAt >= this.windowMs
    ) {
      if (entry === undefined) this.ensureCapacity(now)
      entry = { count: 0, startedAt: now, lastSeenAt: now }
      this.entries.set(key, entry)
    }

    entry.lastSeenAt = now
    if (entry.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(
          0,
          entry.startedAt + this.windowMs - now,
        ),
      }
    }

    entry.count += 1
    return {
      allowed: true,
      remaining: this.limit - entry.count,
      retryAfterMs: 0,
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  prune(): number {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt < this.windowMs) continue
      this.entries.delete(key)
      removed += 1
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < this.maxKeys) return
    this.prune()
    if (this.entries.size < this.maxKeys) return

    let oldestKey: string | null = null
    let oldestSeenAt = now
    for (const [key, entry] of this.entries) {
      if (oldestKey === null || entry.lastSeenAt < oldestSeenAt) {
        oldestKey = key
        oldestSeenAt = entry.lastSeenAt
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey)
  }
}
