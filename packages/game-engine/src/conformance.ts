import { defaultGameConfig } from './config'
import { enqueueIncomingGarbage } from './garbage'
import {
  createSimulation,
  requestSwap,
  setManualRaise,
  simulationChecksum,
  stepSimulation,
} from './simulation'
import type {
  AttackBlock,
  GameConfig,
  SimulationState,
} from './types'

export const CONFORMANCE_TRACE_VERSION = 1

interface OrderedTraceEvent {
  /** Zero-based step; the event is applied immediately before that step. */
  step: number
  /** Total ordering shared by inputs and attacks on the same step. */
  order: number
}

export interface SwapTraceInput extends OrderedTraceEvent {
  kind: 'swap'
  row: number
  column: number
  direction: -1 | 1
}

export interface ManualRaiseTraceInput extends OrderedTraceEvent {
  kind: 'manual-raise'
  active: boolean
}

export type ConformanceTraceInput =
  | SwapTraceInput
  | ManualRaiseTraceInput

export interface ConformanceTraceAttack extends OrderedTraceEvent {
  attackId: string
  serverSequence: number
  blocks: AttackBlock[]
  /** Millisecond deadline override; omitted to use the telegraph duration. */
  readyAt?: number
}

export interface ConformanceTrace {
  version: typeof CONFORMANCE_TRACE_VERSION
  seed: string
  configHash: string
  steps: number
  timeLimitMs: number | null
  inputs: ConformanceTraceInput[]
  attacks: ConformanceTraceAttack[]
}

export interface ConformanceCheckpoint {
  step: number
  checksum: string
  score: number
  status: SimulationState['status']
  endReason: SimulationState['endReason']
}

function fnv1a(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(record[key])}`,
    )
    .join(',')}}`
}

export function gameConfigHash(
  config: GameConfig = defaultGameConfig,
): string {
  return fnv1a(stableStringify(config))
}

function validateTrace(trace: ConformanceTrace, config: GameConfig): void {
  if (
    trace.version !== CONFORMANCE_TRACE_VERSION ||
    trace.seed.trim() === '' ||
    !Number.isSafeInteger(trace.steps) ||
    trace.steps < 0 ||
    (trace.timeLimitMs !== null &&
      (!Number.isFinite(trace.timeLimitMs) || trace.timeLimitMs <= 0))
  ) {
    throw new RangeError('Invalid conformance trace header')
  }
  if (trace.configHash !== gameConfigHash(config)) {
    throw new Error('Conformance trace config hash does not match')
  }

  const orderKeys = new Set<string>()
  for (const event of [...trace.inputs, ...trace.attacks]) {
    if (
      !Number.isSafeInteger(event.step) ||
      event.step < 0 ||
      event.step >= trace.steps ||
      !Number.isSafeInteger(event.order) ||
      event.order < 0
    ) {
      throw new RangeError('Invalid conformance trace event position')
    }
    const key = `${event.step}:${event.order}`
    if (orderKeys.has(key)) {
      throw new Error(`Duplicate conformance event order ${key}`)
    }
    orderKeys.add(key)
  }
}

export function runConformanceTrace(
  trace: ConformanceTrace,
  config: GameConfig = defaultGameConfig,
  checkpointInterval = 30,
): ConformanceCheckpoint[] {
  if (!Number.isSafeInteger(checkpointInterval) || checkpointInterval <= 0) {
    throw new RangeError('checkpointInterval must be a positive integer')
  }
  validateTrace(trace, config)

  const events = [
    ...trace.inputs.map((input) => ({ type: 'input' as const, input })),
    ...trace.attacks.map((attack) => ({
      type: 'attack' as const,
      attack,
    })),
  ].sort(
    (left, right) =>
      (left.type === 'input' ? left.input.step : left.attack.step) -
        (right.type === 'input' ? right.input.step : right.attack.step) ||
      (left.type === 'input' ? left.input.order : left.attack.order) -
        (right.type === 'input' ? right.input.order : right.attack.order),
  )
  let eventIndex = 0
  let state = createSimulation(trace.seed, config, {
    timeLimitMs: trace.timeLimitMs,
  })
  const checkpoints: ConformanceCheckpoint[] = [
    checkpointFor(state),
  ]

  for (let step = 0; step < trace.steps; step += 1) {
    while (eventIndex < events.length) {
      const event = events[eventIndex]!
      const eventStep =
        event.type === 'input' ? event.input.step : event.attack.step
      if (eventStep !== step) break

      if (event.type === 'input') {
        if (event.input.kind === 'swap') {
          state = requestSwap(state, event.input, config).state
        } else {
          state = setManualRaise(state, event.input.active)
        }
      } else {
        const { attack } = event
        state = enqueueIncomingGarbage(
          state,
          attack.readyAt === undefined
            ? {
                attackId: attack.attackId,
                serverSequence: attack.serverSequence,
                blocks: attack.blocks,
              }
            : {
                attackId: attack.attackId,
                serverSequence: attack.serverSequence,
                blocks: attack.blocks,
                readyAt: attack.readyAt,
              },
          config,
        )
      }
      eventIndex += 1
    }

    state = stepSimulation(state, config)
    if (
      state.step % checkpointInterval === 0 ||
      step === trace.steps - 1
    ) {
      checkpoints.push(checkpointFor(state))
    }
    if (state.status === 'lost') {
      if (checkpoints.at(-1)?.step !== state.step) {
        checkpoints.push(checkpointFor(state))
      }
      break
    }
  }

  return checkpoints
}

function checkpointFor(state: SimulationState): ConformanceCheckpoint {
  return {
    step: state.step,
    checksum: simulationChecksum(state),
    score: state.score,
    status: state.status,
    endReason: state.endReason,
  }
}
