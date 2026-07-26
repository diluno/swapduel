extends RefCounted

const Types = preload("res://game/engine/types.gd")


class AttackRow extends RefCounted:
	var width: int
	var type: StringName
	var group: int

	func _init(row_width: int, row_type: StringName, row_group: int) -> void:
		width = row_width
		type = row_type
		group = row_group


class IncomingRows extends RefCounted:
	var attack: Types.IncomingGarbageAttack
	var rows: Array[AttackRow]

	func _init(
		source: Types.IncomingGarbageAttack,
		attack_rows: Array[AttackRow],
	) -> void:
		attack = source
		rows.assign(attack_rows)


class OutgoingRows extends RefCounted:
	var attack: Types.OutgoingAttack
	var rows: Array[AttackRow]

	func _init(
		source: Types.OutgoingAttack,
		attack_rows: Array[AttackRow],
	) -> void:
		attack = source
		rows.assign(attack_rows)


class CancellationResult extends RefCounted:
	var incoming_garbage: Array[Types.IncomingGarbageAttack]
	var attacks: Array[Types.OutgoingAttack]
	var cancelled_cells: int

	func _init(
		incoming: Array[Types.IncomingGarbageAttack],
		outgoing: Array[Types.OutgoingAttack],
		cancelled: int,
	) -> void:
		incoming_garbage.assign(incoming)
		attacks.assign(outgoing)
		cancelled_cells = cancelled


static func cancel_incoming_garbage(
	incoming_garbage: Array[Types.IncomingGarbageAttack],
	attacks: Array[Types.OutgoingAttack],
) -> CancellationResult:
	if incoming_garbage.is_empty() or attacks.is_empty():
		return CancellationResult.new(incoming_garbage, attacks, 0)

	var group := 0
	var defence: Array[IncomingRows] = []
	for attack in incoming_garbage:
		var rows := _to_rows(attack.blocks, group)
		group += attack.blocks.size()
		defence.push_back(IncomingRows.new(attack, rows))

	var offence: Array[OutgoingRows] = []
	for attack in attacks:
		var rows := _to_rows(attack.blocks, group)
		group += attack.blocks.size()
		offence.push_back(OutgoingRows.new(attack, rows))

	var defence_rows: Array[AttackRow] = []
	for bundle in defence:
		defence_rows.append_array(bundle.rows)
	var offence_rows: Array[AttackRow] = []
	for bundle in offence:
		offence_rows.append_array(bundle.rows)

	var defence_index := 0
	var offence_index := 0
	var cancelled_cells := 0

	while (
		defence_index < defence_rows.size()
		and offence_index < offence_rows.size()
	):
		var defence_row := defence_rows[defence_index]
		var offence_row := offence_rows[offence_index]
		var traded := mini(defence_row.width, offence_row.width)
		defence_row.width -= traded
		offence_row.width -= traded
		cancelled_cells += traded
		if defence_row.width == 0:
			defence_index += 1
		if offence_row.width == 0:
			offence_index += 1

	var surviving_incoming: Array[Types.IncomingGarbageAttack] = []
	for bundle in defence:
		var blocks := _to_blocks(bundle.rows)
		if not blocks.is_empty():
			surviving_incoming.push_back(
				bundle.attack.duplicate_with_blocks(blocks),
			)

	var surviving_outgoing: Array[Types.OutgoingAttack] = []
	for bundle in offence:
		var blocks := _to_blocks(bundle.rows)
		if not blocks.is_empty():
			surviving_outgoing.push_back(
				bundle.attack.duplicate_with_blocks(blocks),
			)

	return CancellationResult.new(
		surviving_incoming,
		surviving_outgoing,
		cancelled_cells,
	)


static func _to_rows(
	blocks: Array[Types.AttackBlock],
	group_offset: int,
) -> Array[AttackRow]:
	var rows: Array[AttackRow] = []
	for index in blocks.size():
		var block := blocks[index]
		for _row in block.height:
			rows.push_back(
				AttackRow.new(block.width, block.type, group_offset + index),
			)
	return rows


static func _to_blocks(rows: Array[AttackRow]) -> Array[Types.AttackBlock]:
	var blocks: Array[Types.AttackBlock] = []
	var previous: AttackRow = null

	for row in rows:
		if row.width <= 0:
			continue
		var last: Types.AttackBlock = null
		if not blocks.is_empty():
			last = blocks[-1]
		if (
			last != null
			and previous != null
			and previous.group == row.group
			and last.width == row.width
			and last.type == row.type
		):
			last.height += 1
		else:
			blocks.push_back(Types.AttackBlock.new(row.width, 1, row.type))
		previous = row
	return blocks

