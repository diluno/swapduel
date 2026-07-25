import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LEADERBOARD_PAGE_SIZE,
  type LeaderboardEntry,
  type LeaderboardResult,
  type LeaderboardSubmission,
} from '@swapduel/contracts'

/**
 * How many runs the table keeps. The board only ever shows the top twenty, but
 * holding a deeper tail means a purge of the leaders does not resurrect scores
 * that were already beaten, and it keeps the file small enough to stay boring.
 */
const DEFAULT_MAX_ENTRIES = 1_000
const MAX_PAGE_SIZE = 100

export interface LeaderboardStoreOptions {
  /** A filesystem path, or `:memory:` for a throwaway database. */
  databasePath: string
  maxEntries?: number
  now?: () => number
  createId?: () => string
}

interface ScoreRow {
  entry_id: string
  display_name: string
  score: number
  total_cleared: number
  duration_ms: number
  submitted_at: number
}

function toEntry(row: ScoreRow): LeaderboardEntry {
  return {
    entryId: row.entry_id,
    displayName: row.display_name,
    score: row.score,
    totalCleared: row.total_cleared,
    durationMs: row.duration_ms,
    submittedAt: row.submitted_at,
  }
}

/**
 * The one piece of durable state in the service. Everything else lives in
 * memory and dies with the container, so this deliberately owns its own SQLite
 * file rather than sharing a lifecycle with the room store.
 */
export class LeaderboardStore {
  private readonly database: DatabaseSync
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: LeaderboardStoreOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID

    if (options.databasePath !== ':memory:') {
      mkdirSync(dirname(options.databasePath), { recursive: true })
    }
    this.database = new DatabaseSync(options.databasePath)
    // A crash mid-write must not cost the whole table, and the container can be
    // killed at any moment by a deploy.
    this.database.exec('pragma journal_mode = wal')
    this.database.exec('pragma synchronous = normal')
    this.database.exec(`
      create table if not exists time_trial_scores (
        entry_id text primary key,
        display_name text not null,
        score integer not null,
        total_cleared integer not null,
        duration_ms integer not null,
        seed text not null,
        submitted_at integer not null
      )
    `)
    // Ranking reads score first and breaks ties on who got there earlier, so the
    // index carries both columns in exactly that order.
    this.database.exec(`
      create index if not exists time_trial_scores_ranking
        on time_trial_scores (score desc, submitted_at asc)
    `)
  }

  top(limit: number = LEADERBOARD_PAGE_SIZE): LeaderboardEntry[] {
    const rows = this.database
      .prepare(
        `select entry_id, display_name, score, total_cleared, duration_ms,
                submitted_at
           from time_trial_scores
           order by score desc, submitted_at asc
           limit ?`,
      )
      .all(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit))))
    return (rows as unknown as ScoreRow[]).map(toEntry)
  }

  submit(submission: LeaderboardSubmission): LeaderboardResult {
    const entry: LeaderboardEntry = {
      entryId: this.createId(),
      displayName: submission.displayName,
      score: submission.score,
      totalCleared: submission.totalCleared,
      durationMs: submission.durationMs,
      submittedAt: this.now(),
    }

    this.database
      .prepare(
        `insert into time_trial_scores
           (entry_id, display_name, score, total_cleared, duration_ms, seed,
            submitted_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.entryId,
        entry.displayName,
        entry.score,
        entry.totalCleared,
        entry.durationMs,
        submission.seed,
        entry.submittedAt,
      )
    this.prune()

    return {
      entry,
      rank: this.rankOf(entry.entryId),
      entries: this.top(),
    }
  }

  /** One-based position, or null once the run has fallen out of the table. */
  rankOf(entryId: string): number | null {
    const row = this.database
      .prepare(
        `select count(*) as ahead
           from time_trial_scores as other
           join time_trial_scores as target on target.entry_id = ?
          where other.score > target.score
             or (other.score = target.score
                 and other.submitted_at < target.submitted_at)`,
      )
      .get(entryId) as { ahead: number } | undefined
    if (row === undefined) return null

    const exists = this.database
      .prepare(
        'select 1 as found from time_trial_scores where entry_id = ?',
      )
      .get(entryId)
    return exists === undefined ? null : row.ahead + 1
  }

  count(): number {
    const row = this.database
      .prepare('select count(*) as total from time_trial_scores')
      .get() as { total: number }
    return row.total
  }

  close(): void {
    this.database.close()
  }

  private prune(): void {
    this.database
      .prepare(
        `delete from time_trial_scores
          where entry_id in (
            select entry_id from time_trial_scores
             order by score desc, submitted_at asc
             limit -1 offset ?
          )`,
      )
      .run(this.maxEntries)
  }
}
