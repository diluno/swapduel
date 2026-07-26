extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")
const Rng = preload("res://game/engine/rng.gd")


static func garbage_occupies_cell(
	block: Types.GarbageBlock,
	row: int,
	column: int,
) -> bool:
	return (
		column >= block.column
		and column < block.column + block.width
		and row >= block.row
		and row < block.row + block.height
	)


static func garbage_at(
	garbage: Array[Types.GarbageBlock],
	row: int,
	column: int,
) -> Types.GarbageBlock:
	for block in garbage:
		if garbage_occupies_cell(block, row, column):
			return block
	return null


static func garbage_blocks_are_connected(
	first: Types.GarbageBlock,
	second: Types.GarbageBlock,
) -> bool:
	if first.id == second.id or first.type != second.type:
		return false

	var horizontal_touch := (
		(
			first.column + first.width == second.column
			or second.column + second.width == first.column
		)
		and _ranges_overlap(first.row, first.height, second.row, second.height)
	)
	var vertical_touch := (
		(
			first.row + first.height == second.row
			or second.row + second.height == first.row
		)
		and _ranges_overlap(
			first.column,
			first.width,
			second.column,
			second.width,
		)
	)
	return horizontal_touch or vertical_touch


static func garbage_blocks_touched_by_clear(
	garbage: Array[Types.GarbageBlock],
	matches: Array[Vector2i],
) -> Array[int]:
	var included: Dictionary = {}
	var queue: Array[int] = []
	var queue_index := 0

	for block in garbage:
		if block.state != &"idle":
			continue
		for match_coordinate in matches:
			if _match_touches_block(match_coordinate, block):
				included[block.id] = true
				queue.push_back(block.id)
				break

	while queue_index < queue.size():
		var current_id := queue[queue_index]
		queue_index += 1
		var current := _garbage_by_id(garbage, current_id)
		if current == null:
			continue

		for candidate in garbage:
			if (
				candidate.state == &"idle"
				and not included.has(candidate.id)
				and garbage_blocks_are_connected(current, candidate)
			):
				included[candidate.id] = true
				queue.push_back(candidate.id)

	var result: Array[int] = []
	for id in included:
		result.push_back(id)
	result.sort()
	return result


static func garbage_block_can_fall(
	block: Types.GarbageBlock,
	board: Types.Board,
	all_garbage: Array[Types.GarbageBlock],
) -> bool:
	var target_row := block.row - 1
	if target_row < 0:
		return false

	for column in range(block.column, block.column + block.width):
		if (
			target_row < board.visible_rows
			and board.get_panel(target_row, column) != null
		):
			return false

		for candidate in all_garbage:
			if (
				candidate.id != block.id
				and garbage_occupies_cell(candidate, target_row, column)
			):
				return false
	return true


static func advance_falling_garbage(
	state: Types.SimulationState,
	config: Types.GameConfig = null,
) -> void:
	var game_config := _config_or_default(config)

	for block in state.garbage:
		if block.state != &"falling":
			continue

		block.fall_progress += (
			game_config.timing.garbage_fall_cells_per_second
			* game_config.timing.fixed_step
			/ (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0)
		)

		while (
			block.fall_progress >= 1.0
			and garbage_block_can_fall(block, state.board, state.garbage)
		):
			block.row -= 1
			block.fall_progress -= 1.0

		if not garbage_block_can_fall(block, state.board, state.garbage):
			block.state = &"idle"
			block.fall_progress = 0.0


static func enqueue_incoming_garbage(
	state: Types.SimulationState,
	attack: Types.IncomingGarbageAttack,
	config: Types.GameConfig = null,
) -> bool:
	var game_config := _config_or_default(config)
	if (
		attack.attack_id.strip_edges().is_empty()
		or attack.server_sequence < 0
		or attack.blocks.is_empty()
		or attack.blocks.size() > 12
		or state.received_attack_ids.has(attack.attack_id)
		or state.received_attack_sequences.has(attack.server_sequence)
	):
		return false

	for block in attack.blocks:
		if not _valid_incoming_block(block, state.board.columns):
			return false

	var queued := attack.duplicate_deep()
	if queued.ready_at < 0:
		queued.ready_at = (
			state.elapsed_clock + game_config.timing.garbage_telegraph
		)
	state.incoming_garbage.push_back(queued)
	state.incoming_garbage.sort_custom(_incoming_before)
	state.received_attack_ids.push_back(queued.attack_id)
	state.received_attack_sequences.push_back(queued.server_sequence)
	state.received_attack_sequences.sort()
	return true


static func place_next_garbage_block(state: Types.SimulationState) -> bool:
	if state.incoming_garbage.is_empty():
		return false
	var attack := state.incoming_garbage[0]
	if attack.blocks.is_empty():
		return false
	var attack_block := attack.blocks[0]
	var placement := Rng.random_integer(
		state.garbage_random_state,
		state.board.columns - attack_block.width + 1,
	)
	var column := (
		0
		if attack_block.width == state.board.columns
		else placement.value
	)
	var block := Types.GarbageBlock.new(
		state.next_garbage_id,
		attack_block.type,
		column,
		state.board.visible_rows,
		attack_block.width,
		attack_block.height,
	)
	state.garbage_random_state = placement.random_state
	state.garbage.push_back(block)
	state.next_garbage_id += 1

	attack.blocks.pop_front()
	if attack.blocks.is_empty():
		state.incoming_garbage.pop_front()
	return true


static func _ranges_overlap(
	first_start: int,
	first_length: int,
	second_start: int,
	second_length: int,
) -> bool:
	return (
		first_start < second_start + second_length
		and second_start < first_start + first_length
	)


static func _match_touches_block(
	match_coordinate: Vector2i,
	block: Types.GarbageBlock,
) -> bool:
	var row := match_coordinate.y
	var column := match_coordinate.x
	return (
		garbage_occupies_cell(block, row - 1, column)
		or garbage_occupies_cell(block, row + 1, column)
		or garbage_occupies_cell(block, row, column - 1)
		or garbage_occupies_cell(block, row, column + 1)
	)


static func _garbage_by_id(
	garbage: Array[Types.GarbageBlock],
	id: int,
) -> Types.GarbageBlock:
	for block in garbage:
		if block.id == id:
			return block
	return null


static func _valid_incoming_block(
	block: Types.AttackBlock,
	columns: int,
) -> bool:
	return (
		block.width >= 1
		and block.width <= columns
		and block.height >= 1
		and block.height <= 12
		and block.type in [&"normal", &"metal"]
	)


static func _incoming_before(
	left: Types.IncomingGarbageAttack,
	right: Types.IncomingGarbageAttack,
) -> bool:
	if left.server_sequence != right.server_sequence:
		return left.server_sequence < right.server_sequence
	return left.attack_id < right.attack_id


static func _config_or_default(config: Types.GameConfig) -> Types.GameConfig:
	return config if config != null else Config.default_game_config()
