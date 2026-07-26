extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")

const SNAPSHOT_VERSION := 4
const DEFAULT_MAX_CHARACTERS := 512_000
const MAX_SAFE_INTEGER := 9_007_199_254_740_991.0

const PANEL_TYPES := [
	"circle",
	"triangle",
	"star",
	"diamond",
	"heart",
	"crescent",
	"shock",
]
const PANEL_STATES := [
	"idle",
	"swapping",
	"hovering",
	"falling",
	"matched",
	"flashing",
	"clearing",
	"garbage-locked",
]
const PHASES := [
	"idle",
	"flashing",
	"clearing",
	"garbage-converting",
	"garbage-falling",
	"fall-delay",
]
const STATUSES := ["playing", "paused", "lost"]


static func serialize_simulation_snapshot(
	state: Types.SimulationState,
	scope_id: String,
	saved_at_ms: int,
) -> String:
	return JSON.stringify({
		"version": SNAPSHOT_VERSION,
		"scopeId": scope_id,
		"seed": state.seed,
		"savedAt": saved_at_ms,
		"state": simulation_state_to_dictionary(state),
	}, "", true, true)


static func restore_simulation_snapshot(
	serialized: String,
	scope_id: String,
	expected_seed: String,
	now_ms: int,
	max_age_ms: int,
	max_characters: int = DEFAULT_MAX_CHARACTERS,
	config: Types.GameConfig = null,
) -> Types.SimulationState:
	if (
		serialized.length() > max_characters
		or max_age_ms < 0
		or max_characters < 0
	):
		return null

	var parser := JSON.new()
	if parser.parse(serialized) != OK:
		return null
	var snapshot = parser.data
	if not snapshot is Dictionary:
		return null
	if (
		not _is_integer(snapshot.get("version"), 3)
		or int(snapshot["version"]) not in [3, SNAPSHOT_VERSION]
		or snapshot.get("scopeId") != scope_id
		or snapshot.get("seed") != expected_seed
		or not _is_finite_number(snapshot.get("savedAt"))
	):
		return null

	var saved_at := float(snapshot["savedAt"])
	if saved_at > now_ms + 5000 or now_ms - saved_at > max_age_ms:
		return null

	var raw_state = snapshot.get("state")
	if int(snapshot["version"]) == 3:
		raw_state = _migrate_version_3_state(raw_state)
	var game_config := config if config != null else Config.default_game_config()
	if not _is_simulation_state_dictionary(raw_state, game_config):
		return null
	if raw_state["seed"] != expected_seed:
		return null

	var state := _simulation_state_from_dictionary(raw_state, game_config)
	if state == null:
		return null
	state.manual_raise = false
	return state


static func simulation_state_to_dictionary(
	state: Types.SimulationState,
) -> Dictionary:
	var clears: Array = []
	for group in state.clears:
		clears.push_back({
			"id": group.id,
			"panelIds": Array(group.panel_ids),
			"chainId": group.chain_id,
			"garbageBlockIds": Array(group.garbage_block_ids),
			"phase": String(group.phase),
			"phaseStartedAt": _clock_to_ms(group.phase_started_at),
		})

	var outgoing_attacks: Array = []
	for attack in state.outgoing_attacks:
		outgoing_attacks.push_back({
			"sequence": attack.sequence,
			"kind": String(attack.kind),
			"createdAt": _clock_to_ms(attack.created_at),
			"clearSize": attack.clear_size,
			"chainLevel": attack.chain_level,
			"blocks": _blocks_to_array(attack.blocks),
		})

	var garbage: Array = []
	for block in state.garbage:
		garbage.push_back({
			"id": block.id,
			"type": String(block.type),
			"column": block.column,
			"row": block.row,
			"width": block.width,
			"height": block.height,
			"conversionRow": (
				null if block.conversion_row < 0 else block.conversion_row
			),
			"state": String(block.state),
			"fallProgress": block.fall_progress,
		})

	var incoming_garbage: Array = []
	for attack in state.incoming_garbage:
		incoming_garbage.push_back({
			"attackId": attack.attack_id,
			"serverSequence": attack.server_sequence,
			"blocks": _blocks_to_array(attack.blocks),
			"readyAt": _clock_to_ms(attack.ready_at),
		})

	return {
		"seed": state.seed,
		"randomState": state.random_state,
		"garbageRandomState": state.garbage_random_state,
		"conversionRandomState": state.conversion_random_state,
		"step": state.step,
		"elapsedClock": state.elapsed_clock,
		"elapsedMs": _clock_to_ms(state.elapsed_clock),
		"board": _board_to_dictionary(state.board),
		"riseOffset": state.rise_offset,
		"riseSpeed": state.rise_speed,
		"stopTimeRemainingMs": _clock_to_ms(state.stop_time_remaining),
		"dangerRemainingMs": (
			null
			if state.danger_remaining < 0
			else _clock_to_ms(state.danger_remaining)
		),
		"manualRaise": state.manual_raise,
		"status": String(state.status),
		"timeLimitMs": (
			null if state.time_limit < 0 else _clock_to_ms(state.time_limit)
		),
		"endReason": (
			null if state.end_reason == &"" else String(state.end_reason)
		),
		"phase": String(state.phase),
		"phaseStartedAt": _clock_to_ms(state.phase_started_at),
		"matchedPanelIds": Array(state.matched_panel_ids),
		"clears": clears,
		"nextClearId": state.next_clear_id,
		"pendingSwap": _pending_swap_to_dictionary(state.pending_swap),
		"chain": _chain_to_dictionary(state.chain),
		"nextChainId": state.next_chain_id,
		"outgoingAttacks": outgoing_attacks,
		"nextAttackSequence": state.next_attack_sequence,
		"lastClearEvent": _clear_event_to_dictionary(state.last_clear_event),
		"garbage": garbage,
		"incomingGarbage": incoming_garbage,
		"receivedAttackIds": Array(state.received_attack_ids),
		"receivedAttackSequences": Array(state.received_attack_sequences),
		"nextGarbageId": state.next_garbage_id,
		"garbageConversion": _conversion_to_dictionary(
			state.garbage_conversion,
		),
		"totalCleared": state.total_cleared,
		"lastClearSize": state.last_clear_size,
		"score": state.score,
	}


static func _board_to_dictionary(board: Types.Board) -> Dictionary:
	var rows: Array = []
	for row in board.visible_rows:
		var cells: Array = []
		for column in board.columns:
			var panel := board.get_panel(row, column)
			cells.push_back(null if panel == null else {
				"id": panel.id,
				"type": String(panel.type),
				"state": String(panel.state),
				"row": panel.row,
				"column": panel.column,
				"offsetX": panel.offset_x,
				"offsetY": panel.offset_y,
				"chainEligible": panel.chain_eligible,
				"chainId": null if panel.chain_id < 0 else panel.chain_id,
				"animationStartedAt": (
					null
					if panel.animation_started_at < 0
					else _clock_to_ms(panel.animation_started_at)
				),
			})
		rows.push_back(cells)
	return {
		"columns": board.columns,
		"visibleRows": board.visible_rows,
		"hiddenRows": board.hidden_rows,
		"cells": rows,
		"incomingRow": _string_names_to_array(board.incoming_row),
		"nextPanelId": board.next_panel_id,
	}


static func _pending_swap_to_dictionary(
	pending: Types.PendingSwap,
) -> Variant:
	if pending == null:
		return null
	return {
		"from": {"row": pending.from.row, "column": pending.from.column},
		"to": {"row": pending.to.row, "column": pending.to.column},
		"startedAt": _clock_to_ms(pending.started_at),
	}


static func _chain_to_dictionary(chain: Types.ChainState) -> Variant:
	if chain == null:
		return null
	return {
		"id": chain.id,
		"level": chain.level,
		"startedAt": _clock_to_ms(chain.started_at),
		"lastQualifyingEventAt": _clock_to_ms(
			chain.last_qualifying_event_at,
		),
		"closingStartedAt": (
			null
			if chain.closing_started_at < 0
			else _clock_to_ms(chain.closing_started_at)
		),
		"status": String(chain.status),
	}


static func _clear_event_to_dictionary(
	event: Types.ClearEvent,
) -> Variant:
	if event == null:
		return null
	return {
		"size": event.size,
		"normalSize": event.normal_size,
		"shockSize": event.shock_size,
		"chainLevel": event.chain_level,
		"qualifiedForChain": event.qualified_for_chain,
		"touchedTop": event.touched_top,
		"occurredAt": _clock_to_ms(event.occurred_at),
		"attackSequences": Array(event.attack_sequences),
	}


static func _conversion_to_dictionary(
	conversion: Types.GarbageConversionState,
) -> Variant:
	if conversion == null:
		return null
	return {
		"blockIds": Array(conversion.block_ids),
		"activeBlockId": conversion.active_block_id,
		"nextColumn": conversion.next_column,
		"convertedPanelIds": Array(conversion.converted_panel_ids),
		"nextCellAt": _clock_to_ms(conversion.next_cell_at),
		"releaseAt": (
			null
			if conversion.release_at < 0
			else _clock_to_ms(conversion.release_at)
		),
	}


static func _blocks_to_array(blocks: Array[Types.AttackBlock]) -> Array:
	var result: Array = []
	for block in blocks:
		result.push_back({
			"width": block.width,
			"height": block.height,
			"type": String(block.type),
		})
	return result


static func _string_names_to_array(values: Array[StringName]) -> Array:
	var result: Array = []
	for value in values:
		result.push_back(String(value))
	return result


static func _migrate_version_3_state(value: Variant) -> Variant:
	if (
		not value is Dictionary
		or not _is_finite_number(value.get("elapsedMs"))
		or float(value["elapsedMs"]) < 0.0
	):
		return value
	var migrated: Dictionary = value.duplicate(true)
	var elapsed_clock := _ms_to_clock(value["elapsedMs"])
	migrated["step"] = roundi(
		float(elapsed_clock) / Config.CLOCK_UNITS_PER_STEP,
	)
	migrated["elapsedClock"] = elapsed_clock
	migrated["elapsedMs"] = _clock_to_ms(elapsed_clock)
	return migrated


static func _is_simulation_state_dictionary(
	value: Variant,
	config: Types.GameConfig,
) -> bool:
	if not value is Dictionary:
		return false
	var elapsed_clock_value = value.get("elapsedClock")
	var elapsed_ms_value = value.get("elapsedMs")
	if (
		not _is_bounded_string(value.get("seed"), 1, 128)
		or not _is_integer(value.get("randomState"))
		or not _is_integer(value.get("garbageRandomState"))
		or not _is_integer(value.get("conversionRandomState"))
		or not _is_integer(value.get("step"))
		or not _is_integer(elapsed_clock_value)
		or not _is_finite_number(elapsed_ms_value)
		or float(elapsed_ms_value) < 0.0
		or float(elapsed_ms_value) != _clock_to_ms(int(elapsed_clock_value))
		or not _is_board_dictionary(value.get("board"), config)
		or not _is_in_range(value.get("riseOffset"), 0.0, 1.0, false)
		or not _is_in_range(value.get("riseSpeed"), 0.0, INF, true)
		or not _is_in_range(
			value.get("stopTimeRemainingMs"),
			0.0,
			_clock_to_ms(config.timing.maximum_stop_time),
			true,
		)
		or not _is_nullable_non_negative_number(
			value.get("dangerRemainingMs"),
		)
		or typeof(value.get("manualRaise")) != TYPE_BOOL
		or value.get("status") not in STATUSES
		or not _is_nullable_positive_number(value.get("timeLimitMs"))
		or (
			value.get("endReason") != null
			and value.get("endReason") not in ["topped-out", "time-up"]
		)
		or value.get("phase") not in PHASES
		or not _is_finite_number(value.get("phaseStartedAt"))
		or not _is_number_array(value.get("matchedPanelIds"), 72)
		or not _is_object_array(value.get("clears"), 32, _is_clear_group)
		or not _is_integer(value.get("nextClearId"), 1)
		or not _is_pending_swap(value.get("pendingSwap"), config)
		or not _is_chain(value.get("chain"))
		or not _is_integer(value.get("nextChainId"), 1)
		or not _is_object_array(
			value.get("outgoingAttacks"),
			128,
			_is_outgoing_attack,
		)
		or not _is_integer(value.get("nextAttackSequence"))
		or not _is_clear_event(value.get("lastClearEvent"))
		or not _is_garbage_array(value.get("garbage"), config)
		or not _is_object_array(
			value.get("incomingGarbage"),
			128,
			_is_incoming_attack,
		)
		or not _is_string_array(value.get("receivedAttackIds"), 2048, 128)
		or not _is_number_array(
			value.get("receivedAttackSequences"),
			2048,
		)
		or not _is_integer(value.get("nextGarbageId"), 1)
		or not _is_conversion(value.get("garbageConversion"))
		or not _is_integer(value.get("totalCleared"))
		or not _is_integer(value.get("lastClearSize"))
		or not _is_integer(value.get("score"))
	):
		return false
	return true


static func _is_board_dictionary(
	value: Variant,
	config: Types.GameConfig,
) -> bool:
	if (
		not value is Dictionary
		or value.get("columns") != config.board.columns
		or value.get("visibleRows") != config.board.visible_rows
		or value.get("hiddenRows") != config.board.hidden_rows
		or not value.get("cells") is Array
		or value["cells"].size() != config.board.visible_rows
		or not value.get("incomingRow") is Array
		or value["incomingRow"].size() != config.board.columns
		or not _is_integer(value.get("nextPanelId"), 1)
	):
		return false
	for panel_type in value["incomingRow"]:
		if panel_type not in PANEL_TYPES:
			return false
	for row in config.board.visible_rows:
		var cells = value["cells"][row]
		if not cells is Array or cells.size() != config.board.columns:
			return false
		for column in config.board.columns:
			if not _is_panel(cells[column], row, column):
				return false
	return true


static func _is_panel(value: Variant, row: int, column: int) -> bool:
	if value == null:
		return true
	return (
		value is Dictionary
		and _is_integer(value.get("id"), 1)
		and value.get("type") in PANEL_TYPES
		and value.get("state") in PANEL_STATES
		and value.get("row") == row
		and value.get("column") == column
		and _is_finite_number(value.get("offsetX"))
		and _is_finite_number(value.get("offsetY"))
		and typeof(value.get("chainEligible")) == TYPE_BOOL
		and (
			value.get("chainId") == null
			or _is_integer(value.get("chainId"), 1)
		)
		and (
			value.get("animationStartedAt") == null
			or _is_finite_number(value.get("animationStartedAt"))
		)
	)


static func _is_clear_group(value: Variant) -> bool:
	return (
		value is Dictionary
		and _is_integer(value.get("id"), 1)
		and _is_number_array(value.get("panelIds"), 72)
		and _is_integer(value.get("chainId"), 1)
		and _is_number_array(value.get("garbageBlockIds"), 32)
		and value.get("phase") in ["flashing", "clearing"]
		and _is_finite_number(value.get("phaseStartedAt"))
	)


static func _is_pending_swap(
	value: Variant,
	config: Types.GameConfig,
) -> bool:
	return (
		value == null
		or (
			value is Dictionary
			and _is_coordinate(value.get("from"), config)
			and _is_coordinate(value.get("to"), config)
			and _is_finite_number(value.get("startedAt"))
		)
	)


static func _is_coordinate(
	value: Variant,
	config: Types.GameConfig,
) -> bool:
	return (
		value is Dictionary
		and _is_integer(value.get("row"))
		and int(value["row"]) < config.board.visible_rows
		and _is_integer(value.get("column"))
		and int(value["column"]) < config.board.columns
	)


static func _is_chain(value: Variant) -> bool:
	return (
		value == null
		or (
			value is Dictionary
			and _is_integer(value.get("id"), 1)
			and _is_integer(value.get("level"), 1)
			and _is_finite_number(value.get("startedAt"))
			and _is_finite_number(value.get("lastQualifyingEventAt"))
			and (
				value.get("closingStartedAt") == null
				or _is_finite_number(value.get("closingStartedAt"))
			)
			and value.get("status") in ["active", "closing"]
		)
	)


static func _is_attack_block(value: Variant) -> bool:
	return (
		value is Dictionary
		and _is_integer(value.get("width"), 1)
		and int(value["width"]) <= 6
		and _is_integer(value.get("height"), 1)
		and int(value["height"]) <= 12
		and value.get("type") in ["normal", "metal"]
	)


static func _has_attack_blocks(value: Variant) -> bool:
	if not value is Array or value.size() > 12:
		return false
	for block in value:
		if not _is_attack_block(block):
			return false
	return true


static func _is_outgoing_attack(value: Variant) -> bool:
	return (
		value is Dictionary
		and _is_integer(value.get("sequence"))
		and value.get("kind") in ["combo", "chain", "shock"]
		and _is_finite_number(value.get("createdAt"))
		and _is_integer(value.get("clearSize"))
		and _is_integer(value.get("chainLevel"))
		and _has_attack_blocks(value.get("blocks"))
	)


static func _is_incoming_attack(value: Variant) -> bool:
	return (
		value is Dictionary
		and _is_bounded_string(value.get("attackId"), 1, 128)
		and _is_integer(value.get("serverSequence"))
		and _is_finite_number(value.get("readyAt"))
		and _has_attack_blocks(value.get("blocks"))
	)


static func _is_garbage_array(
	value: Variant,
	config: Types.GameConfig,
) -> bool:
	if not value is Array or value.size() > 32:
		return false
	for block in value:
		if (
			not block is Dictionary
			or not _is_integer(block.get("id"), 1)
			or block.get("type") not in ["normal", "metal"]
			or not _is_integer(block.get("column"))
			or not _is_integer(block.get("width"), 1)
			or int(block["column"]) + int(block["width"])
				> config.board.columns
			or not _is_integer(block.get("row"))
			or int(block["row"]) > config.board.visible_rows
			or not _is_integer(block.get("height"), 1)
			or int(block["height"]) >
				config.board.visible_rows + config.board.hidden_rows
			or (
				block.get("conversionRow") != null
				and not _is_integer(block.get("conversionRow"))
			)
			or block.get("state") not in ["falling", "idle", "converting"]
			or not _is_in_range(
				block.get("fallProgress"),
				0.0,
				1.0,
				false,
			)
		):
			return false
	return true


static func _is_clear_event(value: Variant) -> bool:
	return (
		value == null
		or (
			value is Dictionary
			and _is_integer(value.get("size"))
			and _is_integer(value.get("normalSize"))
			and _is_integer(value.get("shockSize"))
			and _is_integer(value.get("chainLevel"))
			and typeof(value.get("qualifiedForChain")) == TYPE_BOOL
			and typeof(value.get("touchedTop")) == TYPE_BOOL
			and _is_finite_number(value.get("occurredAt"))
			and _is_number_array(value.get("attackSequences"), 32)
		)
	)


static func _is_conversion(value: Variant) -> bool:
	return (
		value == null
		or (
			value is Dictionary
			and _is_number_array(value.get("blockIds"), 32)
			and _is_integer(value.get("activeBlockId"), 1)
			and _is_integer(value.get("nextColumn"))
			and _is_number_array(value.get("convertedPanelIds"), 128)
			and _is_finite_number(value.get("nextCellAt"))
			and (
				value.get("releaseAt") == null
				or _is_finite_number(value.get("releaseAt"))
			)
		)
	)


static func _simulation_state_from_dictionary(
	value: Dictionary,
	config: Types.GameConfig,
) -> Types.SimulationState:
	var board := _board_from_dictionary(value["board"], config)
	if board == null:
		return null
	var state := Types.SimulationState.new()
	state.seed = value["seed"]
	state.random_state = int(value["randomState"])
	state.garbage_random_state = int(value["garbageRandomState"])
	state.conversion_random_state = int(value["conversionRandomState"])
	state.step = int(value["step"])
	state.elapsed_clock = int(value["elapsedClock"])
	state.board = board
	state.rise_offset = float(value["riseOffset"])
	state.rise_speed = float(value["riseSpeed"])
	state.stop_time_remaining = _ms_to_clock(value["stopTimeRemainingMs"])
	state.danger_remaining = (
		-1
		if value["dangerRemainingMs"] == null
		else _ms_to_clock(value["dangerRemainingMs"])
	)
	state.manual_raise = value["manualRaise"]
	state.status = StringName(value["status"])
	state.time_limit = (
		-1
		if value["timeLimitMs"] == null
		else _ms_to_clock(value["timeLimitMs"])
	)
	state.end_reason = (
		&""
		if value["endReason"] == null
		else StringName(value["endReason"])
	)
	state.phase = StringName(value["phase"])
	state.phase_started_at = _ms_to_clock(value["phaseStartedAt"])
	state.matched_panel_ids.assign(_int_array(value["matchedPanelIds"]))
	for item in value["clears"]:
		var group := Types.ClearGroup.new()
		group.id = int(item["id"])
		group.panel_ids.assign(_int_array(item["panelIds"]))
		group.chain_id = int(item["chainId"])
		group.garbage_block_ids.assign(_int_array(item["garbageBlockIds"]))
		group.phase = StringName(item["phase"])
		group.phase_started_at = _ms_to_clock(item["phaseStartedAt"])
		state.clears.push_back(group)
	state.next_clear_id = int(value["nextClearId"])
	state.pending_swap = _pending_swap_from_dictionary(value["pendingSwap"])
	state.chain = _chain_from_dictionary(value["chain"])
	state.next_chain_id = int(value["nextChainId"])
	for item in value["outgoingAttacks"]:
		state.outgoing_attacks.push_back(
			Types.OutgoingAttack.new(
				int(item["sequence"]),
				StringName(item["kind"]),
				_ms_to_clock(item["createdAt"]),
				int(item["clearSize"]),
				int(item["chainLevel"]),
				_blocks_from_array(item["blocks"]),
			),
		)
	state.next_attack_sequence = int(value["nextAttackSequence"])
	state.last_clear_event = _clear_event_from_dictionary(
		value["lastClearEvent"],
	)
	for item in value["garbage"]:
		var block := Types.GarbageBlock.new(
			int(item["id"]),
			StringName(item["type"]),
			int(item["column"]),
			int(item["row"]),
			int(item["width"]),
			int(item["height"]),
		)
		block.conversion_row = (
			-1
			if item["conversionRow"] == null
			else int(item["conversionRow"])
		)
		block.state = StringName(item["state"])
		block.fall_progress = float(item["fallProgress"])
		state.garbage.push_back(block)
	for item in value["incomingGarbage"]:
		state.incoming_garbage.push_back(
			Types.IncomingGarbageAttack.new(
				item["attackId"],
				int(item["serverSequence"]),
				_blocks_from_array(item["blocks"]),
				_ms_to_clock(item["readyAt"]),
			),
		)
	state.received_attack_ids.assign(_string_array(value["receivedAttackIds"]))
	state.received_attack_sequences.assign(
		_int_array(value["receivedAttackSequences"]),
	)
	state.next_garbage_id = int(value["nextGarbageId"])
	state.garbage_conversion = _conversion_from_dictionary(
		value["garbageConversion"],
	)
	state.total_cleared = int(value["totalCleared"])
	state.last_clear_size = int(value["lastClearSize"])
	state.score = int(value["score"])
	return state


static func _board_from_dictionary(
	value: Dictionary,
	config: Types.GameConfig,
) -> Types.Board:
	var board := Types.Board.new(
		config.board.columns,
		config.board.visible_rows,
		config.board.hidden_rows,
	)
	var seen_ids: Dictionary = {}
	for row in config.board.visible_rows:
		for column in config.board.columns:
			var item = value["cells"][row][column]
			if item == null:
				continue
			var panel_id := int(item["id"])
			if seen_ids.has(panel_id):
				return null
			seen_ids[panel_id] = true
			var panel := Types.GamePanel.new(
				panel_id,
				StringName(item["type"]),
				row,
				column,
			)
			panel.state = StringName(item["state"])
			panel.offset_x = float(item["offsetX"])
			panel.offset_y = float(item["offsetY"])
			panel.chain_eligible = item["chainEligible"]
			panel.chain_id = (
				-1 if item["chainId"] == null else int(item["chainId"])
			)
			panel.animation_started_at = (
				-1
				if item["animationStartedAt"] == null
				else _ms_to_clock(item["animationStartedAt"])
			)
			board.set_panel(row, column, panel)
	board.incoming_row.assign(_string_name_array(value["incomingRow"]))
	board.next_panel_id = int(value["nextPanelId"])
	board.assert_ownership()
	return board


static func _pending_swap_from_dictionary(
	value: Variant,
) -> Types.PendingSwap:
	if value == null:
		return null
	return Types.PendingSwap.new(
		Types.Coordinate.new(int(value["from"]["row"]), int(value["from"]["column"])),
		Types.Coordinate.new(int(value["to"]["row"]), int(value["to"]["column"])),
		_ms_to_clock(value["startedAt"]),
	)


static func _chain_from_dictionary(value: Variant) -> Types.ChainState:
	if value == null:
		return null
	var chain := Types.ChainState.new()
	chain.id = int(value["id"])
	chain.level = int(value["level"])
	chain.started_at = _ms_to_clock(value["startedAt"])
	chain.last_qualifying_event_at = _ms_to_clock(
		value["lastQualifyingEventAt"],
	)
	chain.closing_started_at = (
		-1
		if value["closingStartedAt"] == null
		else _ms_to_clock(value["closingStartedAt"])
	)
	chain.status = StringName(value["status"])
	return chain


static func _clear_event_from_dictionary(value: Variant) -> Types.ClearEvent:
	if value == null:
		return null
	var event := Types.ClearEvent.new()
	event.size = int(value["size"])
	event.normal_size = int(value["normalSize"])
	event.shock_size = int(value["shockSize"])
	event.chain_level = int(value["chainLevel"])
	event.qualified_for_chain = value["qualifiedForChain"]
	event.touched_top = value["touchedTop"]
	event.occurred_at = _ms_to_clock(value["occurredAt"])
	event.attack_sequences.assign(_int_array(value["attackSequences"]))
	return event


static func _conversion_from_dictionary(
	value: Variant,
) -> Types.GarbageConversionState:
	if value == null:
		return null
	var conversion := Types.GarbageConversionState.new()
	conversion.block_ids.assign(_int_array(value["blockIds"]))
	conversion.active_block_id = int(value["activeBlockId"])
	conversion.next_column = int(value["nextColumn"])
	conversion.converted_panel_ids.assign(
		_int_array(value["convertedPanelIds"]),
	)
	conversion.next_cell_at = _ms_to_clock(value["nextCellAt"])
	conversion.release_at = (
		-1
		if value["releaseAt"] == null
		else _ms_to_clock(value["releaseAt"])
	)
	return conversion


static func _blocks_from_array(values: Array) -> Array[Types.AttackBlock]:
	var blocks: Array[Types.AttackBlock] = []
	for value in values:
		blocks.push_back(
			Types.AttackBlock.new(
				int(value["width"]),
				int(value["height"]),
				StringName(value["type"]),
			),
		)
	return blocks


static func _is_object_array(
	value: Variant,
	maximum: int,
	validator: Callable,
) -> bool:
	if not value is Array or value.size() > maximum:
		return false
	for entry in value:
		if not validator.call(entry):
			return false
	return true


static func _is_number_array(value: Variant, maximum: int) -> bool:
	if not value is Array or value.size() > maximum:
		return false
	for entry in value:
		if not _is_integer(entry):
			return false
	return true


static func _is_string_array(
	value: Variant,
	maximum: int,
	maximum_length: int,
) -> bool:
	if not value is Array or value.size() > maximum:
		return false
	for entry in value:
		if not _is_bounded_string(entry, 0, maximum_length):
			return false
	return true


static func _is_bounded_string(
	value: Variant,
	minimum_length: int,
	maximum_length: int,
) -> bool:
	return (
		typeof(value) == TYPE_STRING
		and value.length() >= minimum_length
		and value.length() <= maximum_length
	)


static func _is_finite_number(value: Variant) -> bool:
	return (
		typeof(value) in [TYPE_INT, TYPE_FLOAT]
		and is_finite(float(value))
	)


static func _is_integer(value: Variant, minimum: int = 0) -> bool:
	return (
		_is_finite_number(value)
		and float(value) == floor(float(value))
		and absf(float(value)) <= MAX_SAFE_INTEGER
		and float(value) >= minimum
	)


static func _is_in_range(
	value: Variant,
	minimum: float,
	maximum: float,
	include_maximum: bool,
) -> bool:
	return (
		_is_finite_number(value)
		and float(value) >= minimum
		and (
			float(value) <= maximum
			if include_maximum
			else float(value) < maximum
		)
	)


static func _is_nullable_non_negative_number(value: Variant) -> bool:
	return value == null or _is_in_range(value, 0.0, INF, true)


static func _is_nullable_positive_number(value: Variant) -> bool:
	return (
		value == null
		or (_is_finite_number(value) and float(value) > 0.0)
	)


static func _int_array(values: Array) -> Array[int]:
	var result: Array[int] = []
	for value in values:
		result.push_back(int(value))
	return result


static func _string_array(values: Array) -> Array[String]:
	var result: Array[String] = []
	for value in values:
		result.push_back(String(value))
	return result


static func _string_name_array(values: Array) -> Array[StringName]:
	var result: Array[StringName] = []
	for value in values:
		result.push_back(StringName(value))
	return result


static func _clock_to_ms(clock: int) -> float:
	return Config.clock_to_milliseconds(clock)


static func _ms_to_clock(milliseconds: Variant) -> int:
	return roundi(float(milliseconds) * Config.CLOCK_UNITS_PER_MILLISECOND)
