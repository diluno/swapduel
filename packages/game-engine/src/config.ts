import type { GameConfig } from './types'

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
      // Six panels is the first combo that spans the opponent's whole board,
      // and everything past it stacks a full-width slab with a narrower one on
      // top. The narrow block is placed in a random column, so a big combo
      // lands as a staggered wall rather than a neat rectangle.
      {
        minimum: 6,
        maximum: 6,
        blocks: [{ width: 6, height: 1, type: 'normal' }],
      },
      {
        minimum: 7,
        maximum: 7,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 3, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 8,
        maximum: 8,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 4, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 9,
        maximum: 9,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 5, height: 1, type: 'normal' },
        ],
      },
      {
        minimum: 10,
        maximum: 10,
        blocks: [
          { width: 6, height: 1, type: 'normal' },
          { width: 6, height: 1, type: 'normal' },
        ],
      },
      // A two-high slab is the same twelve cells as the pair above but far
      // nastier to dig out, so it reads as the step up rather than a repeat.
      {
        minimum: 11,
        maximum: 11,
        blocks: [{ width: 6, height: 2, type: 'normal' }],
      },
      {
        minimum: 12,
        maximum: null,
        blocks: [
          { width: 6, height: 2, type: 'normal' },
          { width: 3, height: 1, type: 'normal' },
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
