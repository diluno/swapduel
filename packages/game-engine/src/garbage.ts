import { defaultGameConfig } from './config'
import { randomInteger } from './random'
import type {
  Board,
  Coordinate,
  GameConfig,
  GarbageBlock,
  IncomingGarbageAttack,
  SimulationState,
} from './types'

export function garbageOccupiesCell(
  block: GarbageBlock,
  row: number,
  column: number,
): boolean {
  return (
    column >= block.column &&
    column < block.column + block.width &&
    row >= block.row &&
    row < block.row + block.height
  )
}

export function garbageAt(
  garbage: GarbageBlock[],
  row: number,
  column: number,
): GarbageBlock | null {
  return (
    garbage.find((block) => garbageOccupiesCell(block, row, column)) ?? null
  )
}

function rangesOverlap(
  firstStart: number,
  firstLength: number,
  secondStart: number,
  secondLength: number,
): boolean {
  return (
    firstStart < secondStart + secondLength &&
    secondStart < firstStart + firstLength
  )
}

export function garbageBlocksAreConnected(
  first: GarbageBlock,
  second: GarbageBlock,
): boolean {
  if (first.id === second.id || first.type !== second.type) {
    return false
  }

  const horizontalTouch =
    (first.column + first.width === second.column ||
      second.column + second.width === first.column) &&
    rangesOverlap(first.row, first.height, second.row, second.height)
  const verticalTouch =
    (first.row + first.height === second.row ||
      second.row + second.height === first.row) &&
    rangesOverlap(first.column, first.width, second.column, second.width)

  return horizontalTouch || verticalTouch
}

function matchTouchesBlock(
  match: Coordinate,
  block: GarbageBlock,
): boolean {
  return (
    garbageOccupiesCell(block, match.row - 1, match.column) ||
    garbageOccupiesCell(block, match.row + 1, match.column) ||
    garbageOccupiesCell(block, match.row, match.column - 1) ||
    garbageOccupiesCell(block, match.row, match.column + 1)
  )
}

export function garbageBlocksTouchedByClear(
  garbage: GarbageBlock[],
  matches: Coordinate[],
): number[] {
  const directlyTouched = garbage
    .filter(
      (block) =>
        block.state === 'idle' &&
        matches.some((match) => matchTouchesBlock(match, block)),
    )
    .map(({ id }) => id)
  const included = new Set(directlyTouched)
  const queue = [...directlyTouched]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const current = garbage.find(({ id }) => id === currentId)
    if (current === undefined) continue

    for (const candidate of garbage) {
      if (
        candidate.state === 'idle' &&
        !included.has(candidate.id) &&
        garbageBlocksAreConnected(current, candidate)
      ) {
        included.add(candidate.id)
        queue.push(candidate.id)
      }
    }
  }

  return [...included].sort((left, right) => left - right)
}

export function garbageBlockCanFall(
  block: GarbageBlock,
  board: Board,
  allGarbage: GarbageBlock[],
): boolean {
  const targetRow = block.row - 1
  if (targetRow < 0) return false

  for (
    let column = block.column;
    column < block.column + block.width;
    column += 1
  ) {
    if (
      targetRow < board.visibleRows &&
      board.cells[targetRow]?.[column] !== null
    ) {
      return false
    }

    if (
      allGarbage.some(
        (candidate) =>
          candidate.id !== block.id &&
          garbageOccupiesCell(candidate, targetRow, column),
      )
    ) {
      return false
    }
  }

  return true
}

export function advanceFallingGarbage(
  state: SimulationState,
  config: GameConfig,
): SimulationState {
  if (!state.garbage.some(({ state: blockState }) => blockState === 'falling')) {
    return state
  }

  let garbage = state.garbage.map((block) => ({ ...block }))

  for (let index = 0; index < garbage.length; index += 1) {
    let block = garbage[index]!
    if (block.state !== 'falling') continue

    let fallProgress =
      block.fallProgress +
      config.timing.garbageFallCellsPerSecond *
        (config.timing.fixedStepMs / 1000)

    while (
      fallProgress >= 1 &&
      garbageBlockCanFall(block, state.board, garbage)
    ) {
      block = {
        ...block,
        row: block.row - 1,
      }
      garbage[index] = block
      fallProgress -= 1
    }

    if (!garbageBlockCanFall(block, state.board, garbage)) {
      garbage[index] = {
        ...block,
        state: 'idle',
        fallProgress: 0,
      }
    } else {
      garbage[index] = {
        ...block,
        fallProgress,
      }
    }
  }

  return { ...state, garbage }
}

function validateIncomingBlock(
  block: IncomingGarbageAttack['blocks'][number],
  columns: number,
): boolean {
  return (
    Number.isInteger(block.width) &&
    block.width >= 1 &&
    block.width <= columns &&
    Number.isInteger(block.height) &&
    block.height >= 1 &&
    block.height <= 12
  )
}

export function enqueueIncomingGarbage(
  state: SimulationState,
  attack: Omit<IncomingGarbageAttack, 'readyAt'> &
    Partial<Pick<IncomingGarbageAttack, 'readyAt'>>,
  config: GameConfig = defaultGameConfig,
): SimulationState {
  if (
    attack.attackId.trim() === '' ||
    !Number.isInteger(attack.serverSequence) ||
    attack.serverSequence < 0 ||
    attack.blocks.length === 0 ||
    attack.blocks.length > 12 ||
    attack.blocks.some(
      (block) => !validateIncomingBlock(block, state.board.columns),
    ) ||
    state.receivedAttackIds.includes(attack.attackId) ||
    state.receivedAttackSequences.includes(attack.serverSequence)
  ) {
    return state
  }

  const incomingGarbage = [
    ...state.incomingGarbage,
    {
      ...attack,
      blocks: attack.blocks.map((block) => ({ ...block })),
      // The attack is visible in the queue for a beat before it can land, so
      // the defender gets a fair window to answer with a chain.
      readyAt: attack.readyAt ?? state.elapsedMs + config.timing.garbageTelegraphMs,
    },
  ].sort(
    (left, right) =>
      left.serverSequence - right.serverSequence ||
      left.attackId.localeCompare(right.attackId),
  )

  return {
    ...state,
    incomingGarbage,
    receivedAttackIds: [...state.receivedAttackIds, attack.attackId],
    receivedAttackSequences: [
      ...state.receivedAttackSequences,
      attack.serverSequence,
    ].sort((left, right) => left - right),
  }
}

export function placeNextGarbageBlock(
  state: SimulationState,
): SimulationState {
  const attack = state.incomingGarbage[0]
  const attackBlock = attack?.blocks[0]
  if (attack === undefined || attackBlock === undefined) {
    return state
  }

  const placement = randomInteger(
    state.garbageRandomState,
    state.board.columns - attackBlock.width + 1,
  )
  const column =
    attackBlock.width === state.board.columns ? 0 : placement.value
  const garbageBlock: GarbageBlock = {
    id: state.nextGarbageId,
    type: attackBlock.type,
    column,
    row: state.board.visibleRows,
    width: attackBlock.width,
    height: attackBlock.height,
    conversionRow: null,
    state: 'falling',
    fallProgress: 0,
  }
  const remainingBlocks = attack.blocks.slice(1)
  const incomingGarbage =
    remainingBlocks.length === 0
      ? state.incomingGarbage.slice(1)
      : [
          {
            ...attack,
            blocks: remainingBlocks,
          },
          ...state.incomingGarbage.slice(1),
        ]

  return {
    ...state,
    garbageRandomState: placement.randomState,
    garbage: [...state.garbage, garbageBlock],
    incomingGarbage,
    nextGarbageId: state.nextGarbageId + 1,
  }
}
