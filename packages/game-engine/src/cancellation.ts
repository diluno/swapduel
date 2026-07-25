import type {
  AttackBlock,
  IncomingGarbageAttack,
  OutgoingAttack,
} from './types'

/**
 * Garbage that has been telegraphed but has not landed is still negotiable: a
 * clear made while it sits in the queue eats into it instead of stacking on
 * top of it. Without this, a duel accumulates the sum of both players' output
 * rather than the difference, and both boards fill no matter how well either
 * side plays.
 *
 * Both sides are cancelled a row at a time, widest-first is *not* the rule —
 * queue order is, so the attack about to land is the one you fend off. When a
 * row meets a narrower one the wider row survives at the reduced width, which
 * keeps every block rectangular and means a small combo still visibly dents a
 * full-width slab rather than bouncing off it.
 */

interface AttackRow {
  width: number
  type: AttackBlock['type']
  /** Which source block this row came from, so slabs can be reassembled. */
  group: number
}

function toRows(blocks: AttackBlock[], groupOffset: number): AttackRow[] {
  return blocks.flatMap((block, index) =>
    Array.from({ length: block.height }, () => ({
      width: block.width,
      type: block.type,
      group: groupOffset + index,
    })),
  )
}

/** Rebuild blocks, merging adjacent rows that still match into one slab. */
function toBlocks(rows: AttackRow[]): AttackBlock[] {
  const blocks: AttackBlock[] = []
  let previous: AttackRow | null = null

  for (const row of rows) {
    const last = blocks[blocks.length - 1]
    if (
      last !== undefined &&
      previous !== null &&
      previous.group === row.group &&
      last.width === row.width &&
      last.type === row.type
    ) {
      last.height += 1
    } else {
      blocks.push({ width: row.width, height: 1, type: row.type })
    }
    previous = row
  }

  return blocks
}

/**
 * Trade freshly-made attacks against garbage still waiting in the queue.
 * Returns the surviving queue and the attacks that are left to actually send.
 * Anything fully cancelled disappears from both sides; an attack that is
 * entirely spent on defence is never transmitted, so its sequence number is
 * simply skipped.
 */
export function cancelIncomingGarbage(
  incomingGarbage: IncomingGarbageAttack[],
  attacks: OutgoingAttack[],
): {
  incomingGarbage: IncomingGarbageAttack[]
  attacks: OutgoingAttack[]
  cancelledCells: number
} {
  if (incomingGarbage.length === 0 || attacks.length === 0) {
    return { incomingGarbage, attacks, cancelledCells: 0 }
  }

  let group = 0
  const defence = incomingGarbage.map((attack) => {
    const rows = toRows(attack.blocks, group)
    group += attack.blocks.length
    return { attack, rows }
  })
  const offence = attacks.map((attack) => {
    const rows = toRows(attack.blocks, group)
    group += attack.blocks.length
    return { attack, rows }
  })

  const defenceRows = defence.flatMap(({ rows }) => rows)
  const offenceRows = offence.flatMap(({ rows }) => rows)
  let defenceIndex = 0
  let offenceIndex = 0
  let cancelledCells = 0

  while (
    defenceIndex < defenceRows.length &&
    offenceIndex < offenceRows.length
  ) {
    const defenceRow = defenceRows[defenceIndex]!
    const offenceRow = offenceRows[offenceIndex]!
    const traded = Math.min(defenceRow.width, offenceRow.width)

    defenceRow.width -= traded
    offenceRow.width -= traded
    cancelledCells += traded

    if (defenceRow.width === 0) defenceIndex += 1
    if (offenceRow.width === 0) offenceIndex += 1
  }

  return {
    incomingGarbage: defence.flatMap(({ attack, rows }) => {
      const blocks = toBlocks(rows.filter(({ width }) => width > 0))
      return blocks.length === 0 ? [] : [{ ...attack, blocks }]
    }),
    attacks: offence.flatMap(({ attack, rows }) => {
      const blocks = toBlocks(rows.filter(({ width }) => width > 0))
      return blocks.length === 0 ? [] : [{ ...attack, blocks }]
    }),
    cancelledCells,
  }
}
