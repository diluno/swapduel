import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  createInitialBoard,
  insertIncomingRow,
  seedToRandomState,
  type Board,
} from '../../packages/game-engine/src/index'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(
  scriptDirectory,
  '../tests/fixtures/board-golden.json',
)

function boardSnapshot(board: Board) {
  return {
    columns: board.columns,
    visibleRows: board.visibleRows,
    hiddenRows: board.hiddenRows,
    nextPanelId: board.nextPanelId,
    incomingRow: board.incomingRow,
    cells: board.cells.flatMap((row) =>
      row.map((panel) =>
        panel === null
          ? null
          : {
              id: panel.id,
              type: panel.type,
              state: panel.state,
              row: panel.row,
              column: panel.column,
              offsetX: panel.offsetX,
              offsetY: panel.offsetY,
            },
      ),
    ),
  }
}

describe('Godot board fixture generator', () => {
  it('writes canonical TypeScript board snapshots', async () => {
    const cases = [
      'round-k7m4dp',
      'incoming',
      'seed-0',
      'seed-99',
    ].map((seed) => {
      const initialRandomState = seedToRandomState(seed)
      const initial = createInitialBoard(initialRandomState)
      const initialSnapshot = boardSnapshot(initial.board)
      const inserted = insertIncomingRow(
        initial.board,
        initial.randomState,
      )

      return {
        seed,
        initialRandomState,
        initial: {
          randomState: initial.randomState,
          board: initialSnapshot,
        },
        inserted: {
          randomState: inserted.randomState,
          toppedOut: inserted.toppedOut,
          board: boardSnapshot(inserted.board),
        },
      }
    })
    const fixture = {
      version: 1,
      source: 'packages/game-engine/src/board.ts',
      cases,
    }

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(fixture)}\n`)

    expect(cases).toHaveLength(4)
  })
})

