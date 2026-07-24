const UINT32_RANGE = 0x1_0000_0000

export function seedToRandomState(seed: string): number {
  let hash = 2166136261

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0 || 0x6d2b79f5
}

export function nextRandom(randomState: number): {
  randomState: number
  value: number
} {
  let nextState = randomState >>> 0
  nextState ^= nextState << 13
  nextState ^= nextState >>> 17
  nextState ^= nextState << 5
  nextState >>>= 0

  return {
    randomState: nextState,
    value: nextState / UINT32_RANGE,
  }
}

export function randomInteger(
  randomState: number,
  maximumExclusive: number,
): { randomState: number; value: number } {
  if (!Number.isInteger(maximumExclusive) || maximumExclusive <= 0) {
    throw new RangeError('maximumExclusive must be a positive integer')
  }

  const next = nextRandom(randomState)
  return {
    randomState: next.randomState,
    value: Math.floor(next.value * maximumExclusive),
  }
}
