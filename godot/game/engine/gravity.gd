extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Garbage = preload("res://game/engine/garbage.gd")


class GravityResult extends RefCounted:
	var moved_panel_ids: Array[int] = []
	var board: Types.Board

	func _init(result_board: Types.Board, moved_ids: Array[int]) -> void:
		board = result_board
		moved_panel_ids.assign(moved_ids)


static func apply_gravity(
	board: Types.Board,
	garbage: Array[Types.GarbageBlock] = [],
) -> GravityResult:
	var moved_panel_ids: Array[int] = []

	for column in board.columns:
		var target_row := 0
		for row in board.visible_rows:
			if _garbage_occupies(garbage, row, column):
				target_row = row + 1
				continue

			var panel := board.get_panel(row, column)
			if panel == null:
				continue

			if row != target_row:
				panel = board.take_panel(row, column)
				panel.state = &"idle"
				panel.offset_y = float(row - target_row)
				panel.chain_eligible = true
				board.set_panel(target_row, column, panel)
				moved_panel_ids.push_back(panel.id)
			elif panel.state != &"idle" or panel.offset_y != 0.0:
				panel.state = &"idle"
				panel.offset_y = 0.0
			target_row += 1

	board.assert_ownership()
	return GravityResult.new(board, moved_panel_ids)


static func is_board_stable(
	board: Types.Board,
	garbage: Array[Types.GarbageBlock] = [],
) -> bool:
	for column in board.columns:
		var found_empty := false
		for row in board.visible_rows:
			if _garbage_occupies(garbage, row, column):
				found_empty = false
				continue

			var panel := board.get_panel(row, column)
			if panel == null:
				found_empty = true
			elif found_empty or panel.state != &"idle":
				return false
	return true


static func _garbage_occupies(
	garbage: Array[Types.GarbageBlock],
	row: int,
	column: int,
) -> bool:
	for block in garbage:
		if Garbage.garbage_occupies_cell(block, row, column):
			return true
	return false

