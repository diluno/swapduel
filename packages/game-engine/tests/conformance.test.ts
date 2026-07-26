import { describe, expect, it } from 'vitest'
import {
  CONFORMANCE_TRACE_VERSION,
  defaultGameConfig,
  gameConfigHash,
  runConformanceTrace,
  type ConformanceTrace,
} from '../src'

function trace(
  overrides: Partial<ConformanceTrace> = {},
): ConformanceTrace {
  return {
    version: CONFORMANCE_TRACE_VERSION,
    seed: 'conformance-test',
    configHash: gameConfigHash(),
    steps: 90,
    timeLimitMs: null,
    inputs: [],
    attacks: [],
    ...overrides,
  }
}

describe('cross-engine conformance traces', () => {
  it('emits the initial state and every requested checkpoint', () => {
    const checkpoints = runConformanceTrace(trace())

    expect(checkpoints.map(({ step }) => step)).toEqual([0, 30, 60, 90])
    expect(runConformanceTrace(trace())).toEqual(checkpoints)
  })

  it('uses one explicit order across inputs and attacks', () => {
    const checkpoints = runConformanceTrace(
      trace({
        inputs: [
          {
            step: 0,
            order: 1,
            kind: 'manual-raise',
            active: true,
          },
          {
            step: 12,
            order: 0,
            kind: 'manual-raise',
            active: false,
          },
        ],
        attacks: [
          {
            step: 0,
            order: 0,
            attackId: 'opening-garbage',
            serverSequence: 1,
            blocks: [{ width: 3, height: 1, type: 'normal' }],
          },
        ],
      }),
    )

    expect(checkpoints).toHaveLength(4)
    expect(new Set(checkpoints.map(({ checksum }) => checksum)).size).toBe(4)
  })

  it('rejects config drift and ambiguous event ordering', () => {
    expect(() =>
      runConformanceTrace(trace({ configHash: '00000000' })),
    ).toThrow(/config hash/)
    expect(() =>
      runConformanceTrace(
        trace({
          inputs: [
            {
              step: 0,
              order: 0,
              kind: 'manual-raise',
              active: true,
            },
          ],
          attacks: [
            {
              step: 0,
              order: 0,
              attackId: 'collision',
              serverSequence: 1,
              blocks: [
                { width: defaultGameConfig.board.columns, height: 1, type: 'normal' },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/Duplicate/)
  })
})

