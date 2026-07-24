import {
  PROTOCOL_VERSION,
  type BoardSnapshot,
} from '@swapduel/contracts'
import type { SimulationState } from '@swapduel/game-engine'

export interface SnapshotIdentity {
  matchId: string
  roundId: string
  playerId: string
}

export function createBoardSnapshot(
  state: SimulationState,
  identity: SnapshotIdentity,
  sequence: number,
  clientTimestamp = Date.now(),
): BoardSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ...identity,
    sequence,
    clientTimestamp,
    riseOffset: state.riseOffset,
    dangerRemainingMs: state.dangerRemainingMs,
    chainLevel: state.chain?.level ?? 0,
    cells: state.board.cells.flatMap((row) =>
      row
        .filter((panel) => panel !== null)
        .map((panel) => ({
          row: panel.row,
          column: panel.column,
          type: panel.type,
          state: panel.state,
        })),
    ),
    garbage: state.garbage.map(
      ({ id, type, column, row, width, height, state: garbageState }) => ({
        id,
        type,
        column,
        row,
        width,
        height,
        state: garbageState,
      }),
    ),
    incomingGarbage: state.incomingGarbage.map(
      ({ serverSequence, blocks }) => ({
        serverSequence,
        blocks: blocks.map((block) => ({ ...block })),
      }),
    ),
  }
}
