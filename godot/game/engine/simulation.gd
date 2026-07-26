extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")
const Rng = preload("res://game/engine/rng.gd")
const BoardEngine = preload("res://game/engine/board.gd")
const Garbage = preload("res://game/engine/garbage.gd")
const Danger = preload("res://game/engine/danger.gd")
const Gravity = preload("res://game/engine/gravity.gd")

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

	# Resolution and chain progression are the next port tranche. The ordering
	# here already matches the TypeScript tail: danger runs before rising.
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
