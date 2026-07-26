import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  nextRandom,
  seedToRandomState,
} from '../../packages/game-engine/src/random.ts'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(
  scriptDirectory,
  '../tests/fixtures/rng-golden.json',
)

const seedCases = [
  '',
  'round-k7m4dp',
  'incoming',
  'seed-99',
  'Grüezi',
  'duel-🎮',
]

const sequenceSeeds = ['round-k7m4dp', 'duel-🎮']
const fixture = {
  version: 1,
  source: 'packages/game-engine/src/random.ts',
  seeds: seedCases.map((seed) => ({
    seed,
    randomState: seedToRandomState(seed),
  })),
  sequences: sequenceSeeds.map((seed) => {
    let randomState = seedToRandomState(seed)
    const states = []
    for (let index = 0; index < 1_000; index += 1) {
      const next = nextRandom(randomState)
      randomState = next.randomState
      states.push(randomState)
    }
    return { seed, states }
  }),
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(fixture)}\n`)
console.log(`Wrote ${outputPath}`)

