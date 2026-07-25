import type { GameConfig } from './types'

/**
 * How long a time-trial run lasts. Two minutes is long enough for the rise to
 * accelerate twice and for a deliberate chain setup to pay off, and short enough
 * that a leaderboard attempt is a commute-sized decision.
 */
export const timeTrialDurationMs = 120_000

export const defaultGameConfig: GameConfig = {
  board: {
    columns: 6,
    visibleRows: 12,
    hiddenRows: 1,
    startingRows: 6,
    normalPanelTypes: 5,
    shockPanelChance: 0.025,
  },
  timing: {
    fixedStepMs: 1000 / 60,
    swapDurationMs: 100,
    matchFlashDurationMs: 300,
    clearDurationMs: 220,
    panelPopIntervalMs: 90,
    fallDelayMs: 100,
    fallCellsPerSecond: 18,
    garbageFallCellsPerSecond: 12,
    garbageCellConvertMs: 45,
    garbageReleaseDelayMs: 150,
    garbageTelegraphMs: 1200,
    chainWindowMs: 250,
    comboStopBaseMs: 450,
    comboStopPerPanelMs: 120,
    chainStopBaseMs: 650,
    chainStopPerLevelMs: 300,
    maximumStopTimeMs: 3000,
    dangerGraceMs: 3000,
  },
  rise: {
    startingRowsPerSecond: 0.05,
    // Fifteen steps of 12% each. At the old 30s interval top speed arrived
    // 7.5 minutes in, which is a long time to wait for the pressure that makes
    // a run interesting; this reaches the cap just under four minutes.
    speedIncreaseIntervalSeconds: 15,
    speedMultiplierPerIncrease: 1.12,
    maximumRowsPerSecond: 0.25,
    manualRowsPerSecond: 0.9,
    manualStopDrainMultiplier: 3,
  },
  attacks: {
    comboTable: [
      {
        minimum: 4,
        maximum: 4,
        blocks: [{ width: 3, height: 1, type: 'normal' }],
      },
      {
        minimum: 5,
        maximum: 5,
        blocks: [{ width: 4, height: 1, type: 'normal' }],
      },
      // The width climbs one panel at a time, so a full-width row is a
      // seven-panel combo rather than a six. Combo garbage stays one row tall
      // at every size — height is what chains buy, and conflating the two is
      // what made trading combos escalate faster than either player could dig.
      // Past a full row the payout splits into two blocks, each placed in its
      // own random column, so a big combo lands staggered rather than as a
      // neat rectangle.
      {
        minimum: 6,
        maximum: 6,
        blocks: [{ width: 5, height: 1, type: 'normal' }],
      },
      {
        minimum: 7,
        maximum: 7,
        blocks: [{ width: 6, height: 1, type: 'normal' }],
      },
      {
        minimum: 8,
        maximum: 8,
        blocks: [
          { width: 4, height: 1, type: 'normal' },
          { width: 3, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 9,
        maximum: 9,
        blocks: [
          { width: 4, height: 1, type: 'normal' },
          { width: 4, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 10,
        maximum: 10,
        blocks: [
          { width: 5, height: 1, type: 'normal' },
          { width: 5, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 11,
        maximum: 11,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 5, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 12,
        maximum: null,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 6, height: 1, type: 'normal' },
        ],
      },
    ],
    shockTable: [
      {
        minimum: 3,
        maximum: 3,
        blocks: [{ width: 6, height: 1, type: 'metal' }],
      },
      {
        minimum: 4,
        maximum: 4,
        blocks: [{ width: 6, height: 2, type: 'metal' }],
      },
      {
        minimum: 5,
        maximum: 5,
        blocks: [{ width: 6, height: 3, type: 'metal' }],
      },
      {
        minimum: 6,
        maximum: null,
        blocks: [{ width: 6, height: 4, type: 'metal' }],
      },
    ],
  },
  // Chains pay out far more than combos of the same size: that gap is what
  // makes setting up a chain the skill worth learning, and it is the whole
  // point of a score-attack mode.
  scoring: {
    panelPoints: 10,
    comboTable: [
      { minimum: 4, maximum: 4, points: 20 },
      { minimum: 5, maximum: 5, points: 30 },
      { minimum: 6, maximum: 6, points: 50 },
      { minimum: 7, maximum: 7, points: 60 },
      { minimum: 8, maximum: 8, points: 70 },
      { minimum: 9, maximum: 9, points: 80 },
      { minimum: 10, maximum: 10, points: 100 },
      { minimum: 11, maximum: 11, points: 140 },
      { minimum: 12, maximum: 12, points: 170 },
      { minimum: 13, maximum: 13, points: 210 },
      { minimum: 14, maximum: 14, points: 250 },
      { minimum: 15, maximum: null, points: 290 },
    ],
    chainTable: [
      { minimum: 2, maximum: 2, points: 50 },
      { minimum: 3, maximum: 3, points: 80 },
      { minimum: 4, maximum: 4, points: 150 },
      { minimum: 5, maximum: 5, points: 300 },
      { minimum: 6, maximum: 6, points: 400 },
      { minimum: 7, maximum: 7, points: 500 },
      { minimum: 8, maximum: 8, points: 700 },
      { minimum: 9, maximum: 9, points: 900 },
      { minimum: 10, maximum: 10, points: 1_100 },
      { minimum: 11, maximum: 11, points: 1_300 },
      { minimum: 12, maximum: 12, points: 1_500 },
      { minimum: 13, maximum: null, points: 1_800 },
    ],
  },
}
