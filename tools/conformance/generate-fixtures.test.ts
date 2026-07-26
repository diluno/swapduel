import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CONFORMANCE_TRACE_VERSION,
  gameConfigHash,
  runConformanceTrace,
  type ConformanceTrace,
} from '../../packages/game-engine/src/index'

const directory = dirname(fileURLToPath(import.meta.url))

const traces: Array<{ name: string; trace: ConformanceTrace }> = [
  {
    name: 'smoke-swaps',
    trace: {
      version: CONFORMANCE_TRACE_VERSION,
      seed: 'godot-conformance-swaps',
      configHash: gameConfigHash(),
      steps: 360,
      timeLimitMs: null,
      inputs: [
        { step: 0, order: 0, kind: 'swap', row: 1, column: 1, direction: 1 },
        { step: 12, order: 0, kind: 'swap', row: 2, column: 3, direction: -1 },
        { step: 30, order: 0, kind: 'manual-raise', active: true },
        { step: 54, order: 0, kind: 'manual-raise', active: false },
        { step: 90, order: 0, kind: 'swap', row: 0, column: 4, direction: 1 },
        { step: 180, order: 0, kind: 'swap', row: 3, column: 2, direction: 1 },
      ],
      attacks: [],
    },
  },
  {
    name: 'incoming-garbage',
    trace: {
      version: CONFORMANCE_TRACE_VERSION,
      seed: 'godot-conformance-garbage',
      configHash: gameConfigHash(),
      steps: 420,
      timeLimitMs: null,
      inputs: [
        { step: 100, order: 1, kind: 'manual-raise', active: true },
        { step: 118, order: 0, kind: 'manual-raise', active: false },
      ],
      attacks: [
        {
          step: 0,
          order: 0,
          attackId: 'garbage-1',
          serverSequence: 1,
          blocks: [{ width: 3, height: 1, type: 'normal' }],
        },
        {
          step: 100,
          order: 0,
          attackId: 'garbage-2',
          serverSequence: 2,
          blocks: [{ width: 6, height: 2, type: 'metal' }],
        },
      ],
    },
  },
  {
    name: 'time-limit',
    trace: {
      version: CONFORMANCE_TRACE_VERSION,
      seed: 'godot-conformance-timed',
      configHash: gameConfigHash(),
      steps: 90,
      timeLimitMs: 1_000,
      inputs: [
        { step: 0, order: 0, kind: 'manual-raise', active: true },
      ],
      attacks: [],
    },
  },
]

describe('TypeScript conformance fixture generator', () => {
  it('writes canonical traces and JSONL checkpoints', async () => {
    const tracesDirectory = resolve(directory, 'traces')
    const expectedDirectory = resolve(directory, 'expected')
    await mkdir(tracesDirectory, { recursive: true })
    await mkdir(expectedDirectory, { recursive: true })

    for (const entry of traces) {
      const checkpoints = runConformanceTrace(entry.trace)
      await writeFile(
        resolve(tracesDirectory, `${entry.name}.json`),
        `${JSON.stringify(entry.trace, null, 2)}\n`,
      )
      await writeFile(
        resolve(expectedDirectory, `${entry.name}.jsonl`),
        `${checkpoints.map((value) => JSON.stringify(value)).join('\n')}\n`,
      )
    }

    expect(traces).toHaveLength(3)
  })
})

