import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The leaderboard store uses node:sqlite, which is still behind a flag on
    // Node 22 (what CI and the container run). Passing it to the worker keeps
    // the tests running on both 22 and 24 without an env-var prefix.
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--experimental-sqlite'] },
    },
  },
})
