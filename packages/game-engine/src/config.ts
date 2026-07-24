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
    speedIncreaseIntervalSeconds: 30,
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
}
