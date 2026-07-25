import { PROTOCOL_VERSION } from '@swapduel/contracts'
import { describe, expect, it } from 'vitest'
import { LeaderboardStore } from '../src/leaderboard/leaderboard-store'

function createStore(
  clock = { now: 1_000 },
  maxEntries = 1_000,
): LeaderboardStore {
  let id = 0
  return new LeaderboardStore({
    databasePath: ':memory:',
    maxEntries,
    now: () => clock.now,
    createId: () => `entry-${++id}`,
  })
}

function submission(displayName: string, score: number) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    displayName,
    score,
    totalCleared: 40,
    durationMs: 120_000,
    seed: 'time-trial-seed',
  } as const
}

describe('LeaderboardStore', () => {
  it('ranks a submitted run against the existing table', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)

    store.submit(submission('Mira', 5_000))
    clock.now += 1_000
    const result = store.submit(submission('Rune', 8_000))

    expect(result.rank).toBe(1)
    expect(result.entry).toMatchObject({
      entryId: 'entry-2',
      displayName: 'Rune',
      score: 8_000,
      submittedAt: 2_000,
    })
    expect(result.entries.map(({ displayName }) => displayName)).toEqual([
      'Rune',
      'Mira',
    ])
    store.close()
  })

  it('breaks a tie in favour of whoever got there first', () => {
    const clock = { now: 1_000 }
    const store = createStore(clock)

    store.submit(submission('Mira', 5_000))
    clock.now += 1_000
    const later = store.submit(submission('Rune', 5_000))

    expect(later.rank).toBe(2)
    expect(later.entries.map(({ displayName }) => displayName)).toEqual([
      'Mira',
      'Rune',
    ])
    store.close()
  })

  it('keeps every run, not just each name’s best', () => {
    const store = createStore()

    store.submit(submission('Mira', 5_000))
    store.submit(submission('Mira', 3_000))

    expect(store.count()).toBe(2)
    store.close()
  })

  it('prunes runs that fall out of the retained tail', () => {
    const store = createStore({ now: 1_000 }, 2)

    store.submit(submission('Mira', 5_000))
    store.submit(submission('Rune', 8_000))
    const dropped = store.submit(submission('Ivo', 100))

    expect(store.count()).toBe(2)
    expect(dropped.rank).toBeNull()
    expect(store.top().map(({ score }) => score)).toEqual([8_000, 5_000])
    store.close()
  })

  it('returns at most the requested number of entries', () => {
    const store = createStore()

    for (let index = 0; index < 5; index += 1) {
      store.submit(submission(`Player ${index}`, 1_000 * index))
    }

    expect(store.top(3)).toHaveLength(3)
    expect(store.top(3)[0]?.score).toBe(4_000)
    store.close()
  })

  it('survives being reopened against the same file', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = await mkdtemp(join(tmpdir(), 'swapduel-leaderboard-'))
    const databasePath = join(directory, 'nested', 'leaderboard.db')

    const first = new LeaderboardStore({ databasePath })
    first.submit(submission('Mira', 5_000))
    first.close()

    const second = new LeaderboardStore({ databasePath })
    expect(second.top()).toHaveLength(1)
    second.close()

    await rm(directory, { recursive: true, force: true })
  })
})
