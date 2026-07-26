extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")
const Rng = preload("res://game/engine/rng.gd")


class BoardGenerationResult extends RefCounted:
	var board: Types.Board
	var random_state: int

	func _init(result_board: Types.Board, state: int) -> void:
		board = result_board
		random_state = state


class IncomingRowResult extends RefCounted:
	var random_state: int
	var row: Array[StringName]

	func _init(state: int, panel_row: Array[StringName]) -> void:
		random_state = state
		row.assign(panel_row)


class InsertRowResult extends RefCounted:
	var board: Types.Board
	var random_state: int
	var topped_out: bool

	func _init(result_board: Types.Board, state: int, did_top_out: bool) -> void:
		board = result_board
		random_state = state
		topped_out = did_top_out


static func available_types(
	board: Types.Board,
	row: int,
	column: int,
	panel_types: Array[StringName],
) -> Array[StringName]:
	var available: Array[StringName] = []

	for type in panel_types:
		var left_one := board.get_panel(row, column - 1)
		var left_two := board.get_panel(row, column - 2)
		var below_one := board.get_panel(row - 1, column)
		var below_two := board.get_panel(row - 2, column)
		var creates_horizontal: bool = (
			left_one != null
			and left_two != null
			and left_one.type == type
			and left_two.type == type
		)
		var creates_vertical: bool = (
			below_one != null
			and below_two != null
			and below_one.type == type
			and below_two.type == type
		)
		if not creates_horizontal and not creates_vertical:
			available.push_back(type)

	return available


static func create_empty_board(config: Types.GameConfig = null) -> Types.Board:
	var game_config := _config_or_default(config)
	return Types.Board.new(
		game_config.board.columns,
		game_config.board.visible_rows,
		game_config.board.hidden_rows,
	)


static func generate_incoming_row(
	board: Types.Board,
	initial_random_state: int,
	config: Types.GameConfig = null,
) -> IncomingRowResult:
	var game_config := _config_or_default(config)
	var panel_types: Array[StringName] = []
	panel_types.assign(
		Types.NORMAL_PANEL_TYPES.slice(0, game_config.board.normal_panel_types),
	)
	var row: Array[StringName] = []
	var random_state := initial_random_state

	for column in board.columns:
		var shock_roll := Rng.next_random(random_state)
		random_state = shock_roll.random_state
		var bottom := board.get_panel(0, column)
		var next := board.get_panel(1, column)
		var adjacent_shock: bool = (
			(column > 0 and row[column - 1] == &"shock")
			or (bottom != null and bottom.type == &"shock")
		)

		if (
			shock_roll.value < game_config.board.shock_panel_chance
			and not adjacent_shock
		):
			row.push_back(&"shock")
			continue

		var candidates: Array[StringName] = []
		for type in panel_types:
			var creates_horizontal: bool = (
				column >= 2
				and row[column - 1] == type
				and row[column - 2] == type
			)
			var creates_vertical: bool = (
				bottom != null
				and next != null
				and bottom.type == type
				and next.type == type
			)
			if not creates_horizontal and not creates_vertical:
				candidates.push_back(type)

		var chosen := Rng.random_integer(random_state, candidates.size())
		random_state = chosen.random_state
		row.push_back(candidates[chosen.value])

	return IncomingRowResult.new(random_state, row)


static func create_initial_board(
	initial_random_state: int,
	config: Types.GameConfig = null,
) -> BoardGenerationResult:
	var game_config := _config_or_default(config)
	var board := create_empty_board(game_config)
	var panel_types: Array[StringName] = []
	panel_types.assign(
		Types.NORMAL_PANEL_TYPES.slice(0, game_config.board.normal_panel_types),
	)
	var random_state := initial_random_state

	for row in game_config.board.starting_rows:
		for column in board.columns:
			var shock_roll := Rng.next_random(random_state)
			random_state = shock_roll.random_state
			var left := board.get_panel(row, column - 1)
			var below := board.get_panel(row - 1, column)
			var adjacent_shock: bool = (
				(left != null and left.type == &"shock")
				or (below != null and below.type == &"shock")
			)

			var panel_type: StringName
			if (
				shock_roll.value < game_config.board.shock_panel_chance
				and not adjacent_shock
			):
				panel_type = &"shock"
			else:
				var candidates := available_types(
					board,
					row,
					column,
					panel_types,
				)
				var chosen := Rng.random_integer(random_state, candidates.size())
				random_state = chosen.random_state
				panel_type = candidates[chosen.value]

			board.set_panel(
				row,
				column,
				board.acquire_panel(panel_type, row, column),
			)

	var incoming := generate_incoming_row(board, random_state, game_config)
	board.incoming_row.assign(incoming.row)
	board.assert_ownership()
	return BoardGenerationResult.new(board, incoming.random_state)


static func insert_incoming_row(
	board: Types.Board,
	initial_random_state: int,
	config: Types.GameConfig = null,
) -> InsertRowResult:
	var game_config := _config_or_default(config)

	for column in board.columns:
		if board.get_panel(board.visible_rows - 1, column) != null:
			return InsertRowResult.new(board, initial_random_state, true)

	for row in range(board.visible_rows - 1, 0, -1):
		for column in board.columns:
			var panel := board.take_panel(row - 1, column)
			if panel != null:
				panel.offset_y -= 1.0
				board.set_panel(row, column, panel)

	for column in board.columns:
		assert(
			column < board.incoming_row.size(),
			"Incoming row is incomplete",
		)
		board.set_panel(
			0,
			column,
			board.acquire_panel(board.incoming_row[column], 0, column),
		)

	var incoming := generate_incoming_row(
		board,
		initial_random_state,
		game_config,
	)
	board.incoming_row.assign(incoming.row)
	board.assert_ownership()
	return InsertRowResult.new(board, incoming.random_state, false)


static func _config_or_default(config: Types.GameConfig) -> Types.GameConfig:
	return config if config != null else Config.default_game_config()
