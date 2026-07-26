extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Garbage = preload("res://game/engine/garbage.gd")


static func find_matches(
	board: Types.Board,
	garbage: Array[Types.GarbageBlock] = [],
) -> Array[Vector2i]:
	var matched: Array[bool] = []
	matched.resize(board.columns * board.visible_rows)
	matched.fill(false)
	var grounded: Array[int] = []
	grounded.resize(board.columns)

	for column in board.columns:
		grounded[column] = _grounded_row_count(board, garbage, column)

	for row in board.visible_rows:
		var run_start := 0
		while run_start < board.columns:
			var first := board.get_panel(row, run_start)
			if (
				not _is_line_matchable(first)
				or row >= grounded[run_start]
			):
				run_start += 1
				continue

			var run_end := run_start + 1
			while run_end < board.columns:
				var candidate := board.get_panel(row, run_end)
				if (
					not _is_line_matchable(candidate)
					or row >= grounded[run_end]
					or candidate.type != first.type
				):
					break
				run_end += 1

			if run_end - run_start >= 3:
				for column in range(run_start, run_end):
					matched[board.cell_index(row, column)] = true
			run_start = run_end

	for column in board.columns:
		var run_start := 0
		while run_start < board.visible_rows:
			var first := board.get_panel(run_start, column)
			if (
				not _is_line_matchable(first)
				or run_start >= grounded[column]
			):
				run_start += 1
				continue

			var run_end := run_start + 1
			while run_end < board.visible_rows:
				var candidate := board.get_panel(run_end, column)
				if (
					not _is_line_matchable(candidate)
					or run_end >= grounded[column]
					or candidate.type != first.type
				):
					break
				run_end += 1

			if run_end - run_start >= 3:
				for row in range(run_start, run_end):
					matched[board.cell_index(row, column)] = true
			run_start = run_end

	_mark_shock_matches(board, matched)

	var result: Array[Vector2i] = []
	for row in board.visible_rows:
		for column in board.columns:
			if matched[board.cell_index(row, column)]:
				result.push_back(Vector2i(column, row))
	return result


static func has_matches(
	board: Types.Board,
	garbage: Array[Types.GarbageBlock] = [],
) -> bool:
	return not find_matches(board, garbage).is_empty()


static func _is_line_matchable(panel: Types.GamePanel) -> bool:
	return (
		panel != null
		and panel.state == &"idle"
		and panel.type != &"shock"
	)


static func _grounded_row_count(
	board: Types.Board,
	garbage: Array[Types.GarbageBlock],
	column: int,
) -> int:
	for row in board.visible_rows:
		var filled := board.get_panel(row, column) != null
		if not filled:
			for block in garbage:
				if Garbage.garbage_occupies_cell(block, row, column):
					filled = true
					break
		if not filled:
			return row
	return board.visible_rows


static func _mark_shock_matches(
	board: Types.Board,
	matched: Array[bool],
) -> void:
	var visited: Array[bool] = []
	visited.resize(board.columns * board.visible_rows)
	visited.fill(false)
	var offsets: Array[Vector2i] = [
		Vector2i(-1, 0),
		Vector2i(1, 0),
		Vector2i(0, -1),
		Vector2i(0, 1),
	]

	for row in board.visible_rows:
		for column in board.columns:
			var start_index := board.cell_index(row, column)
			var start := board.get_panel(row, column)
			if (
				visited[start_index]
				or start == null
				or start.state != &"idle"
				or start.type != &"shock"
			):
				continue

			var component: Array[int] = [start_index]
			var queue: Array[Vector2i] = [Vector2i(column, row)]
			var queue_index := 0
			visited[start_index] = true

			while queue_index < queue.size():
				var current := queue[queue_index]
				queue_index += 1
				for offset in offsets:
					var neighbor: Vector2i = current + offset
					if not board.is_inside(neighbor.y, neighbor.x):
						continue
					var neighbor_index := board.cell_index(neighbor.y, neighbor.x)
					if visited[neighbor_index]:
						continue
					var panel := board.get_panel(neighbor.y, neighbor.x)
					if (
						panel != null
						and panel.state == &"idle"
						and panel.type == &"shock"
					):
						visited[neighbor_index] = true
						component.push_back(neighbor_index)
						queue.push_back(neighbor)

			if component.size() >= 3:
				for index in component:
					matched[index] = true
