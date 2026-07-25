import {
  leaderboardPageSchema,
  leaderboardResultSchema,
  PROTOCOL_VERSION,
  type LeaderboardEntry,
  type LeaderboardSubmission,
} from '@swapduel/contracts'

export interface RunResult {
  displayName: string
  score: number
  totalCleared: number
  durationMs: number
  seed: string
}

/**
 * The leaderboard is plain HTTP on the same origin as the socket server, so in
 * production this resolves to a relative path and in dev it points at :3001.
 */
export function useLeaderboard() {
  const config = useRuntimeConfig()
  const baseUrl = `${config.public.socketUrl}/api/leaderboard`
  const entries = ref<LeaderboardEntry[]>([])
  const loading = ref(false)
  const submitting = ref(false)
  const errorMessage = ref('')
  /** Where the run that was just submitted landed, if it made the table. */
  const submittedRank = ref<number | null>(null)
  const submittedEntryId = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    errorMessage.value = ''
    try {
      const page = leaderboardPageSchema.parse(
        await $fetch(baseUrl, { retry: 1 }),
      )
      entries.value = page.entries
    } catch {
      errorMessage.value = 'The leaderboard could not be loaded.'
    } finally {
      loading.value = false
    }
  }

  async function submit(run: RunResult): Promise<boolean> {
    submitting.value = true
    errorMessage.value = ''
    try {
      const submission: LeaderboardSubmission = {
        protocolVersion: PROTOCOL_VERSION,
        displayName: run.displayName,
        score: run.score,
        totalCleared: run.totalCleared,
        durationMs: Math.round(run.durationMs),
        seed: run.seed,
      }
      const result = leaderboardResultSchema.parse(
        await $fetch(baseUrl, { method: 'POST', body: submission }),
      )
      entries.value = result.entries
      submittedRank.value = result.rank
      submittedEntryId.value = result.entry.entryId
      return true
    } catch {
      errorMessage.value = 'The score could not be submitted. Try again.'
      return false
    } finally {
      submitting.value = false
    }
  }

  function resetSubmission(): void {
    submittedRank.value = null
    submittedEntryId.value = null
    errorMessage.value = ''
  }

  return {
    entries,
    loading,
    submitting,
    errorMessage,
    submittedRank,
    submittedEntryId,
    load,
    submit,
    resetSubmission,
  }
}
