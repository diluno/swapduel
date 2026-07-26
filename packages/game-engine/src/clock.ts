/**
 * Exact simulation clock shared with the Godot port.
 *
 * Three units represent one millisecond, so one 60 Hz step is exactly
 * 50 units. Gameplay decisions use these integers; millisecond values remain
 * on the public state for the web renderer, protocol, and recovery format.
 */
export const CLOCK_UNITS_PER_MILLISECOND = 3
export const CLOCK_UNITS_PER_SECOND = 3_000
export const CLOCK_UNITS_PER_STEP = 50

export function millisecondsToClock(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('milliseconds must be finite')
  }
  return Math.round(milliseconds * CLOCK_UNITS_PER_MILLISECOND)
}

export function clockToMilliseconds(clockUnits: number): number {
  if (!Number.isSafeInteger(clockUnits)) {
    throw new RangeError('clockUnits must be a safe integer')
  }
  return clockUnits / CLOCK_UNITS_PER_MILLISECOND
}

export function fixedStepClockUnits(fixedStepMs: number): number {
  const units = millisecondsToClock(fixedStepMs)
  if (units <= 0) {
    throw new RangeError('fixedStepMs must be positive')
  }
  return units
}

