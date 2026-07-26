extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")
const Rng = preload("res://game/engine/rng.gd")
const BoardEngine = preload("res://game/engine/board.gd")
const Garbage = preload("res://game/engine/garbage.gd")
const Danger = preload("res://game/engine/danger.gd")
const Gravity = preload("res://game/engine/gravity.gd")
const Matches = preload("res://game/engine/matches.gd")
const Scoring = preload("res://game/engine/scoring.gd")
const Attacks = preload("res://game/engine/attacks.gd")
const Cancellation = preload("res://game/engine/cancellation.gd")

const UINT32_MASK := 0xFFFFFFFF


class SwapResult extends RefCounted:
	var ok: bool
	var reason: StringName
	var state: Types.SimulationState

	func _init(
		accepted: bool,
		result_state: Types.SimulationState,
		rejection_reason: StringName = &"",
	) -> void:
		ok = accepted
		state = result_state
		reason = rejection_reason


static func create_simulation(
	seed: String,
	config: Types.GameConfig = null,
	time_limit_ms: int = -1,
) -> Types.SimulationState:
	var game_config := _config_or_default(config)
	var initial_random_state := Rng.seed_to_random_state(seed)
	var initial := BoardEngine.create_initial_board(
		initial_random_state,
		game_config,
	)
	var state := Types.SimulationState.new()
	state.seed = seed
	state.random_state = initial.random_state
	state.garbage_random_state = Rng.seed_to_random_state(
		"%s:garbage" % seed,
	)
	state.conversion_random_state = Rng.seed_to_random_state(
		"%s:conversion" % seed,
	)
	state.board = initial.board
	state.rise_speed = game_config.rise.starting_rows_per_second
	state.time_limit = (
		-1
		if time_limit_ms < 0
		else Config.milliseconds_to_clock(time_limit_ms)
	)
	return state


static func request_swap(
	state: Types.SimulationState,
	row: int,
	column: int,
	direction: int,
	config: Types.GameConfig = null,
) -> SwapResult:
	var game_config := _config_or_default(config)
	if state.status != &"playing":
		return SwapResult.new(false, state, &"simulation-not-playing")
	if state.pending_swap != null:
		return SwapResult.new(false, state, &"board-busy")

	var from := Types.Coordinate.new(row, column)
	var to := Types.Coordinate.new(row, column + direction)
	if (
		not state.board.is_inside(from.row, from.column)
		or not state.board.is_inside(to.row, to.column)
	):
		return SwapResult.new(false, state, &"outside-board")
	if absi(from.column - to.column) != 1 or from.row != to.row:
		return SwapResult.new(false, state, &"not-adjacent")

	var from_panel := state.board.get_panel(from.row, from.column)
	var to_panel := state.board.get_panel(to.row, to.column)
	if (
		Garbage.garbage_at(state.garbage, from.row, from.column) != null
		or Garbage.garbage_at(state.garbage, to.row, to.column) != null
	):
		return SwapResult.new(false, state, &"cell-locked")
	if from_panel == null and to_panel == null:
		return SwapResult.new(false, state, &"both-empty")
	if not _panel_can_swap(from_panel) or not _panel_can_swap(to_panel):
		return SwapResult.new(false, state, &"cell-locked")

	var chain_is_open := (
		state.chain != null
		and (
			state.chain.status == &"active"
			or (
				state.chain.closing_started_at >= 0
				and state.elapsed_clock - state.chain.closing_started_at
					<= game_config.timing.chain_window
			)
		)
	)
	if from_panel != null:
		from_panel.state = &"swapping"
		from_panel.offset_x = float(direction)
		from_panel.animation_started_at = state.elapsed_clock
		if chain_is_open:
			from_panel.chain_eligible = true
			from_panel.chain_id = state.chain.id
	if to_panel != null:
		to_panel.state = &"swapping"
		to_panel.offset_x = float(-direction)
		to_panel.animation_started_at = state.elapsed_clock
		if chain_is_open:
			to_panel.chain_eligible = true
			to_panel.chain_id = state.chain.id

	state.pending_swap = Types.PendingSwap.new(
		from,
		to,
		state.elapsed_clock,
	)
	return SwapResult.new(true, state)


static func set_manual_raise(
	state: Types.SimulationState,
	active: bool,
) -> Types.SimulationState:
	if not active:
		state.manual_raise = false
	elif state.status == &"playing" and state.danger_remaining < 0:
		state.manual_raise = true
	return state


static func set_paused(
	state: Types.SimulationState,
	paused: bool,
) -> Types.SimulationState:
	if state.status == &"lost":
		return state
	state.status = &"paused" if paused else &"playing"
	if paused:
		state.manual_raise = false
	return state


static func advance_simulation(
	state: Types.SimulationState,
	delta_ms: float,
	config: Types.GameConfig = null,
) -> Types.SimulationState:
	assert(is_finite(delta_ms) and delta_ms >= 0.0)
	var game_config := _config_or_default(config)
	var clock_delta := delta_ms * Config.CLOCK_UNITS_PER_MILLISECOND
	var step_count := floori(
		(clock_delta + 0.000000000001) / game_config.timing.fixed_step,
	)
	for _step in step_count:
		step_simulation(state, game_config)
	return state


static func step_simulation(
	state: Types.SimulationState,
	config: Types.GameConfig = null,
) -> Types.SimulationState:
	if state.status != &"playing":
		return state
	var game_config := _config_or_default(config)
	state.step += 1
	state.elapsed_clock += game_config.timing.fixed_step

	if state.time_limit >= 0 and state.elapsed_clock >= state.time_limit:
		state.elapsed_clock = state.time_limit
		state.status = &"lost"
		state.end_reason = &"time-up"
		state.manual_raise = false
		state.rise_speed = 0.0
		return state

	if (
		state.pending_swap != null
		and state.elapsed_clock - state.pending_swap.started_at
			>= game_config.timing.swap_duration
	):
		_complete_pending_swap(state)

	_advance_resolution(state, game_config)
	_sync_phase_summary(state)
	_advance_chain_closure(state, game_config)
	_advance_garbage_lifecycle(state, game_config)
	_sync_phase_summary(state)
	Danger.advance_danger_state(state, game_config)
	_advance_rise(state, game_config)
	return state


static func simulation_checksum(state: Types.SimulationState) -> String:
	var panels: Array[Types.GamePanel] = []
	for panel in state.board.cells:
		if panel != null:
			panels.push_back(panel)
	panels.sort_custom(
		func(left: Types.GamePanel, right: Types.GamePanel) -> bool:
			return left.id < right.id,
	)
	var panel_values: Array[String] = []
	for panel in panels:
		panel_values.push_back(",".join([
			str(panel.id),
			String(panel.type),
			String(panel.state),
			str(panel.row),
			str(panel.column),
			_js_number(panel.offset_x),
			_js_number(panel.offset_y),
			"1" if panel.chain_eligible else "0",
			"-" if panel.chain_id < 0 else str(panel.chain_id),
			(
				"-"
				if panel.animation_started_at < 0
				else str(panel.animation_started_at)
			),
		]))

	var clear_values: Array[String] = []
	for group in state.clears:
		clear_values.push_back(
			"%d,%s,%d,%d,%s"
			% [
				group.id,
				String(group.phase),
				group.phase_started_at,
				group.chain_id,
				_join_ints(group.panel_ids, "."),
			],
		)

	var outgoing_values: Array[String] = []
	for attack in state.outgoing_attacks:
		outgoing_values.push_back(
			"%d,%s,%s"
			% [
				attack.sequence,
				String(attack.kind),
				_join_blocks(attack.blocks),
			],
		)

	var garbage_values: Array[String] = []
	for block in state.garbage:
		garbage_values.push_back(",".join([
			str(block.id),
			String(block.type),
			String(block.state),
			str(block.row),
			str(block.column),
			str(block.width),
			str(block.height),
			"-" if block.conversion_row < 0 else str(block.conversion_row),
			"%.8f" % block.fall_progress,
		]))

	var incoming_values: Array[String] = []
	for attack in state.incoming_garbage:
		incoming_values.push_back(
			"%s@%d!%d:%s"
			% [
				attack.attack_id,
				attack.server_sequence,
				attack.ready_at,
				_join_blocks(attack.blocks),
			],
		)

	var source := ";".join([
		str(state.random_state),
		str(state.garbage_random_state),
		str(state.conversion_random_state),
		str(state.step),
		str(state.elapsed_clock),
		"%.8f" % state.rise_offset,
		"%.8f" % state.rise_speed,
		str(state.stop_time_remaining),
		"safe" if state.danger_remaining < 0 else str(state.danger_remaining),
		String(state.status),
		String(state.phase),
		str(state.phase_started_at),
		"|".join(clear_values),
		_pending_swap_checksum(state.pending_swap),
		_chain_checksum(state.chain),
		str(state.next_attack_sequence),
		"|".join(outgoing_values),
		"|".join(garbage_values),
		"|".join(incoming_values),
		_join_ints(state.received_attack_sequences, ","),
		_conversion_checksum(state.garbage_conversion),
		"|".join(panel_values),
		_join_string_names(state.board.incoming_row, ","),
		str(state.score),
	])
	return _fnv1a(source)


static func _complete_pending_swap(state: Types.SimulationState) -> void:
	var pending := state.pending_swap
	if pending == null:
		return
	var from_panel := state.board.take_panel(
		pending.from.row,
		pending.from.column,
	)
	var to_panel := state.board.take_panel(
		pending.to.row,
		pending.to.column,
	)
	if to_panel != null:
		to_panel.state = &"idle"
		to_panel.offset_x = 0.0
		to_panel.animation_started_at = -1
		state.board.set_panel(
			pending.from.row,
			pending.from.column,
			to_panel,
		)
	if from_panel != null:
		from_panel.state = &"idle"
		from_panel.offset_x = 0.0
		from_panel.animation_started_at = -1
		state.board.set_panel(
			pending.to.row,
			pending.to.column,
			from_panel,
		)
	state.pending_swap = null
	state.board.assert_ownership()


static func _advance_resolution(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	_release_stray_swap_states(state)
	_advance_clear_groups(state, config)
	_advance_garbage_conversion(state, config)
	_advance_panel_gravity(state, config)
	var matches := Matches.find_matches(state.board, state.garbage)
	if not matches.is_empty():
		_begin_match_resolution(state, matches, config)


static func _begin_match_resolution(
	state: Types.SimulationState,
	matches: Array[Vector2i],
	config: Types.GameConfig,
) -> void:
	var matched_panels: Array[Types.GamePanel] = []
	var matched_panel_ids: Array[int] = []
	var shock_size := 0
	for coordinate in matches:
		var panel := state.board.get_panel(coordinate.y, coordinate.x)
		if panel == null:
			continue
		matched_panels.push_back(panel)
		matched_panel_ids.push_back(panel.id)
		if panel.type == &"shock":
			shock_size += 1

	var normal_size := matched_panel_ids.size() - shock_size
	var previous_chain := state.chain
	var qualified_for_chain := false
	if previous_chain != null:
		for panel in matched_panels:
			if panel.chain_eligible and panel.chain_id == previous_chain.id:
				qualified_for_chain = true
				break

	var chain_is_live := (
		previous_chain != null and previous_chain.status == &"active"
	)
	var chain: Types.ChainState
	if previous_chain != null and qualified_for_chain:
		chain = previous_chain
		chain.level += 1
		chain.last_qualifying_event_at = state.elapsed_clock
		chain.closing_started_at = -1
		chain.status = &"active"
	elif chain_is_live:
		chain = previous_chain
	else:
		if previous_chain != null:
			_clear_chain_metadata(state.board)
		chain = Types.ChainState.new()
		chain.id = state.next_chain_id
		chain.level = 1
		chain.started_at = state.elapsed_clock
		chain.last_qualifying_event_at = state.elapsed_clock
		state.next_chain_id += 1

	var clear_chain_level := chain.level if qualified_for_chain else 1
	var new_attacks: Array[Types.OutgoingAttack] = []
	_append_attack(
		new_attacks,
		state,
		&"combo",
		normal_size,
		clear_chain_level,
		Attacks.combo_attack_blocks(normal_size, config),
	)
	_append_attack(
		new_attacks,
		state,
		&"shock",
		shock_size,
		clear_chain_level,
		Attacks.shock_attack_blocks(shock_size, config),
	)
	if qualified_for_chain:
		_append_attack(
			new_attacks,
			state,
			&"chain",
			matched_panel_ids.size(),
			chain.level,
			Attacks.chain_attack_blocks(chain.level, state.board.columns),
		)

	var cancellation := Cancellation.cancel_incoming_garbage(
		state.incoming_garbage,
		new_attacks,
	)
	state.incoming_garbage.assign(cancellation.incoming_garbage)
	state.outgoing_attacks.append_array(cancellation.attacks)

	var combo_stop := 0
	if normal_size >= 4:
		combo_stop = (
			config.timing.combo_stop_base
			+ (normal_size - 4) * config.timing.combo_stop_per_panel
		)
	var chain_stop := 0
	if qualified_for_chain and chain.level >= 2:
		chain_stop = (
			config.timing.chain_stop_base
			+ (chain.level - 2) * config.timing.chain_stop_per_level
		)
	state.stop_time_remaining = mini(
		config.timing.maximum_stop_time,
		state.stop_time_remaining + combo_stop + chain_stop,
	)

	for panel in matched_panels:
		panel.state = &"flashing"
		panel.chain_id = chain.id
		panel.animation_started_at = state.elapsed_clock

	var clear := Types.ClearGroup.new()
	clear.id = state.next_clear_id
	clear.panel_ids.assign(matched_panel_ids)
	clear.chain_id = chain.id
	clear.garbage_block_ids.assign(
		Garbage.garbage_blocks_touched_by_clear(state.garbage, matches),
	)
	clear.phase = &"flashing"
	clear.phase_started_at = state.elapsed_clock
	state.clears.push_back(clear)
	state.next_clear_id += 1
	state.chain = chain

	var attack_sequences: Array[int] = []
	for attack in cancellation.attacks:
		attack_sequences.push_back(attack.sequence)
	var clear_event := Types.ClearEvent.new()
	clear_event.size = matched_panel_ids.size()
	clear_event.normal_size = normal_size
	clear_event.shock_size = shock_size
	clear_event.chain_level = clear_chain_level
	clear_event.qualified_for_chain = qualified_for_chain
	clear_event.occurred_at = state.elapsed_clock
	clear_event.attack_sequences.assign(attack_sequences)
	for panel in matched_panels:
		if panel.row == state.board.visible_rows - 1:
			clear_event.touched_top = true
			break
	state.last_clear_event = clear_event
	state.last_clear_size = matched_panel_ids.size()
	state.score += Scoring.clear_score(
		matched_panel_ids.size(),
		normal_size,
		clear_chain_level,
		qualified_for_chain,
		config,
	)


static func _append_attack(
	attacks: Array[Types.OutgoingAttack],
	state: Types.SimulationState,
	kind: StringName,
	clear_size: int,
	chain_level: int,
	blocks: Array[Types.AttackBlock],
) -> void:
	if blocks.is_empty():
		return
	attacks.push_back(
		Types.OutgoingAttack.new(
			state.next_attack_sequence,
			kind,
			state.elapsed_clock,
			clear_size,
			chain_level,
			blocks,
		),
	)
	state.next_attack_sequence += 1


static func _advance_clear_groups(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	if state.clears.is_empty():
		return

	var remaining: Array[Types.ClearGroup] = []
	for group in state.clears:
		var elapsed := state.elapsed_clock - group.phase_started_at
		if group.phase == &"flashing":
			if elapsed < config.timing.match_flash_duration:
				remaining.push_back(group)
				continue
			for panel_id in group.panel_ids:
				var panel := _panel_by_id(state.board, panel_id)
				if panel != null:
					panel.state = &"clearing"
					panel.animation_started_at = state.elapsed_clock
			group.phase = &"clearing"
			group.phase_started_at = state.elapsed_clock
			remaining.push_back(group)
			continue

		if elapsed < _clear_phase_duration(group.panel_ids.size(), config):
			remaining.push_back(group)
			continue

		var ids: Dictionary = {}
		for panel_id in group.panel_ids:
			ids[panel_id] = true
		for index in state.board.cells.size():
			var panel := state.board.cells[index]
			if panel == null or not ids.has(panel.id):
				continue
			var released := state.board.take_panel(panel.row, panel.column)
			state.board.release_panel(released)
		state.total_cleared += group.panel_ids.size()
		if not group.garbage_block_ids.is_empty():
			_begin_garbage_conversion(
				state,
				group.garbage_block_ids,
				config,
			)

	state.clears.assign(remaining)
	state.board.assert_ownership()


static func _begin_garbage_conversion(
	state: Types.SimulationState,
	block_ids: Array[int],
	config: Types.GameConfig,
) -> void:
	var valid_ids: Array[int] = []
	for block_id in block_ids:
		for block in state.garbage:
			if block.id == block_id:
				valid_ids.push_back(block_id)
				block.state = &"converting"
				block.conversion_row = block.row
				block.fall_progress = 0.0
				break
	if valid_ids.is_empty():
		return

	if state.garbage_conversion != null:
		for block_id in valid_ids:
			if not state.garbage_conversion.block_ids.has(block_id):
				state.garbage_conversion.block_ids.push_back(block_id)
		return

	var conversion := Types.GarbageConversionState.new()
	conversion.block_ids.assign(valid_ids)
	conversion.active_block_id = valid_ids[0]
	conversion.next_column = 0
	conversion.next_cell_at = (
		state.elapsed_clock + config.timing.garbage_cell_convert
	)
	state.garbage_conversion = conversion


static func _advance_garbage_conversion(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	var conversion := state.garbage_conversion
	if conversion == null:
		return
	var block := _garbage_by_id(state.garbage, conversion.active_block_id)
	if block == null:
		state.garbage_conversion = null
		return

	if (
		conversion.release_at >= 0
		and state.elapsed_clock >= conversion.release_at
	):
		for panel_id in conversion.converted_panel_ids:
			var converted := _panel_by_id(state.board, panel_id)
			if converted == null:
				continue
			converted.state = &"idle"
			converted.chain_eligible = state.chain != null
			converted.chain_id = -1 if state.chain == null else state.chain.id
			converted.animation_started_at = -1

		if block.height == 1:
			state.garbage.erase(block)
		else:
			block.row += 1
			block.height -= 1
			block.conversion_row = -1
			block.state = &"idle"

		conversion.block_ids.erase(block.id)
		if conversion.block_ids.is_empty():
			state.garbage_conversion = null
			return

		conversion.active_block_id = conversion.block_ids[0]
		conversion.next_column = 0
		conversion.converted_panel_ids.clear()
		conversion.next_cell_at = (
			state.elapsed_clock + config.timing.garbage_cell_convert
		)
		conversion.release_at = -1
		return

	if (
		conversion.release_at >= 0
		or state.elapsed_clock < conversion.next_cell_at
	):
		return

	var conversion_row := (
		block.row if block.conversion_row < 0 else block.conversion_row
	)
	var column := block.column + conversion.next_column
	var palette: Array[StringName] = []
	palette.assign(
		Types.NORMAL_PANEL_TYPES.slice(0, config.board.normal_panel_types),
	)
	var candidates := BoardEngine.available_types(
		state.board,
		conversion_row,
		column,
		palette,
	)
	var safe_types := candidates if not candidates.is_empty() else palette
	var random_panel := Rng.random_integer(
		state.conversion_random_state,
		safe_types.size(),
	)
	state.conversion_random_state = random_panel.random_state

	if (
		state.board.is_inside(conversion_row, column)
		and state.board.get_panel(conversion_row, column) == null
	):
		var panel := state.board.acquire_panel(
			safe_types[random_panel.value],
			conversion_row,
			column,
		)
		panel.state = &"garbage-locked"
		panel.chain_eligible = state.chain != null
		panel.chain_id = -1 if state.chain == null else state.chain.id
		panel.animation_started_at = state.elapsed_clock
		state.board.set_panel(conversion_row, column, panel)
		conversion.converted_panel_ids.push_back(panel.id)

	conversion.next_column += 1
	conversion.next_cell_at += config.timing.garbage_cell_convert
	if conversion.next_column >= block.width:
		conversion.release_at = (
			state.elapsed_clock + config.timing.garbage_release_delay
		)
	state.board.assert_ownership()


static func _clear_phase_duration(
	panel_count: int,
	config: Types.GameConfig,
) -> int:
	return (
		config.timing.clear_duration
		+ maxi(0, panel_count - 1) * config.timing.panel_pop_interval
	)


static func _advance_panel_gravity(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	var active_chain_id := -1 if state.chain == null else state.chain.id
	for column in state.board.columns:
		var landing := 0
		for row in state.board.visible_rows:
			if Garbage.garbage_at(state.garbage, row, column) != null:
				landing = row + 1
				continue

			var panel := state.board.get_panel(row, column)
			if panel == null:
				continue
			if panel.state not in [&"idle", &"hovering"]:
				landing = row + 1
				continue
			if row == landing:
				if panel.state == &"hovering":
					panel.state = &"idle"
					panel.animation_started_at = -1
				landing = row + 1
				continue
			if panel.state == &"idle":
				panel.state = &"hovering"
				panel.animation_started_at = state.elapsed_clock
				landing = row + 1
				continue
			if (
				state.elapsed_clock - panel.animation_started_at
				< config.timing.fall_delay
			):
				landing = row + 1
				continue

			panel = state.board.take_panel(row, column)
			panel.state = &"idle"
			panel.offset_y = 0.0
			panel.animation_started_at = -1
			panel.chain_eligible = active_chain_id >= 0
			panel.chain_id = active_chain_id
			state.board.set_panel(landing, column, panel)
			landing += 1
	state.board.assert_ownership()


static func _release_stray_swap_states(state: Types.SimulationState) -> void:
	if state.pending_swap != null:
		return
	for panel in state.board.cells:
		if panel != null and panel.state == &"swapping":
			panel.state = &"idle"
			panel.offset_x = 0.0
			panel.animation_started_at = -1


static func _advance_chain_closure(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	if (
		state.chain != null
		and state.chain.status == &"active"
		and state.phase == &"idle"
		and state.pending_swap == null
	):
		state.chain.status = &"closing"
		state.chain.closing_started_at = state.elapsed_clock
		return

	if (
		state.chain == null
		or state.chain.status != &"closing"
		or state.chain.closing_started_at < 0
		or state.phase != &"idle"
		or state.pending_swap != null
		or _has_falling_garbage(state)
		or state.elapsed_clock - state.chain.closing_started_at
			< config.timing.chain_window
	):
		return
	_clear_chain_metadata(state.board)
	state.chain = null


static func _clear_chain_metadata(board: Types.Board) -> void:
	for panel in board.cells:
		if panel == null:
			continue
		panel.chain_eligible = false
		panel.chain_id = -1


static func _advance_garbage_lifecycle(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	Garbage.advance_falling_garbage(state, config)

	if state.garbage_conversion == null and state.pending_swap == null:
		var unsupported := false
		for block in state.garbage:
			if (
				block.state == &"idle"
				and Garbage.garbage_block_can_fall(
					block,
					state.board,
					state.garbage,
				)
			):
				block.state = &"falling"
				block.fall_progress = 0.0
				unsupported = true
		if unsupported:
			return

	var safe_to_insert := (
		state.status == &"playing"
		and state.danger_remaining < 0
		and state.phase == &"idle"
		and state.pending_swap == null
		and state.chain == null
		and state.garbage_conversion == null
		and not _has_falling_garbage(state)
	)
	if (
		not safe_to_insert
		or state.incoming_garbage.is_empty()
		or state.elapsed_clock < state.incoming_garbage[0].ready_at
	):
		return
	Garbage.place_next_garbage_block(state)


static func _panel_by_id(
	board: Types.Board,
	panel_id: int,
) -> Types.GamePanel:
	for panel in board.cells:
		if panel != null and panel.id == panel_id:
			return panel
	return null


static func _garbage_by_id(
	garbage: Array[Types.GarbageBlock],
	block_id: int,
) -> Types.GarbageBlock:
	for block in garbage:
		if block.id == block_id:
			return block
	return null


static func _advance_rise(
	state: Types.SimulationState,
	config: Types.GameConfig,
) -> void:
	if (
		state.status != &"playing"
		or state.danger_remaining >= 0
		or state.garbage_conversion != null
		or _has_falling_garbage(state)
	):
		state.rise_speed = 0.0
		return

	var automatic_allowed := (
		state.phase == &"idle"
		and state.pending_swap == null
		and state.chain == null
	)
	if not state.manual_raise and not automatic_allowed:
		return
	if not state.manual_raise and state.stop_time_remaining > 0:
		state.rise_speed = 0.0
		state.stop_time_remaining = maxi(
			0,
			state.stop_time_remaining - config.timing.fixed_step,
		)
		return

	var elapsed_seconds := (
		float(state.elapsed_clock) / (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0)
	)
	var increases := floori(
		elapsed_seconds / config.rise.speed_increase_interval_seconds,
	)
	var automatic_speed := minf(
		config.rise.starting_rows_per_second
			* pow(config.rise.speed_multiplier_per_increase, increases),
		config.rise.maximum_rows_per_second,
	)
	state.rise_speed = (
		config.rise.manual_rows_per_second
		if state.manual_raise
		else automatic_speed
	)
	if state.manual_raise and state.stop_time_remaining > 0:
		state.stop_time_remaining = maxi(
			0,
			state.stop_time_remaining -
				roundi(
					config.timing.fixed_step *
						config.rise.manual_stop_drain_multiplier,
				),
		)

	state.rise_offset += (
		state.rise_speed
		* config.timing.fixed_step
		/ (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0)
	)
	while state.rise_offset >= 1.0 and state.status == &"playing":
		var inserted := BoardEngine.insert_incoming_row(
			state.board,
			state.random_state,
			config,
		)
		if inserted.topped_out:
			state.danger_remaining = config.timing.danger_grace
			state.rise_offset = 0.0
			break
		state.random_state = inserted.random_state
		for block in state.garbage:
			block.row += 1
			if block.conversion_row >= 0:
				block.conversion_row += 1
		if state.pending_swap != null:
			state.pending_swap.from.row += 1
			state.pending_swap.to.row += 1
		state.rise_offset -= 1.0


static func _sync_phase_summary(state: Types.SimulationState) -> void:
	var phase: StringName = &"idle"
	if state.garbage_conversion != null:
		phase = &"garbage-converting"
	elif _has_falling_garbage(state):
		phase = &"garbage-falling"
	else:
		for group in state.clears:
			if group.phase == &"clearing":
				phase = &"clearing"
				break
		if phase == &"idle" and not state.clears.is_empty():
			phase = &"flashing"
		elif (
			phase == &"idle"
			and not Gravity.is_board_stable(state.board, state.garbage)
		):
			phase = &"fall-delay"

	var matched_ids: Array[int] = []
	for group in state.clears:
		matched_ids.append_array(group.panel_ids)
	var phase_changed := phase != state.phase
	state.phase = phase
	if phase_changed:
		state.phase_started_at = state.elapsed_clock
	state.matched_panel_ids.assign(matched_ids)


static func _panel_can_swap(panel: Types.GamePanel) -> bool:
	return panel == null or panel.state == &"idle"


static func _has_falling_garbage(state: Types.SimulationState) -> bool:
	for block in state.garbage:
		if block.state == &"falling":
			return true
	return false


static func _pending_swap_checksum(pending: Types.PendingSwap) -> String:
	if pending == null:
		return "no-swap"
	return "%d,%d>%d,%d@%d" % [
		pending.from.row,
		pending.from.column,
		pending.to.row,
		pending.to.column,
		pending.started_at,
	]


static func _chain_checksum(chain: Types.ChainState) -> String:
	if chain == null:
		return "no-chain"
	return "%d,%d,%s,%d,%d,%s" % [
		chain.id,
		chain.level,
		String(chain.status),
		chain.started_at,
		chain.last_qualifying_event_at,
		"-" if chain.closing_started_at < 0 else str(chain.closing_started_at),
	]


static func _conversion_checksum(
	conversion: Types.GarbageConversionState,
) -> String:
	if conversion == null:
		return "no-conversion"
	return "%d:%d:%s:%s:%d:%s" % [
		conversion.active_block_id,
		conversion.next_column,
		_join_ints(conversion.block_ids, ","),
		_join_ints(conversion.converted_panel_ids, ","),
		conversion.next_cell_at,
		"-" if conversion.release_at < 0 else str(conversion.release_at),
	]


static func _join_blocks(blocks: Array[Types.AttackBlock]) -> String:
	var values: Array[String] = []
	for block in blocks:
		values.push_back(
			"%dx%d:%s" % [block.width, block.height, String(block.type)],
		)
	return "+".join(values)


static func _join_ints(values: Array[int], separator: String) -> String:
	var strings: Array[String] = []
	for value in values:
		strings.push_back(str(value))
	return separator.join(strings)


static func _join_string_names(
	values: Array[StringName],
	separator: String,
) -> String:
	var strings: Array[String] = []
	for value in values:
		strings.push_back(String(value))
	return separator.join(strings)


static func _js_number(value: float) -> String:
	if value == floor(value):
		return str(int(value))
	return str(value)


static func _fnv1a(value: String) -> String:
	var hash := 2166136261
	for index in value.length():
		var codepoint := value.unicode_at(index)
		if codepoint <= 0xFFFF:
			hash = ((hash ^ codepoint) * 16777619) & UINT32_MASK
		else:
			var adjusted := codepoint - 0x10000
			hash = (
				(hash ^ (0xD800 + (adjusted >> 10))) * 16777619
			) & UINT32_MASK
			hash = (
				(hash ^ (0xDC00 + (adjusted & 0x3FF))) * 16777619
			) & UINT32_MASK
	return "%08x" % hash


static func _config_or_default(config: Types.GameConfig) -> Types.GameConfig:
	return config if config != null else Config.default_game_config()
