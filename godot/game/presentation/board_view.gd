extends Control

signal swap_requested(row: int, column: int, direction: int)

const SWIPE_THRESHOLD := 0.28
const VERTICAL_REJECT_PX := 8.0

const PANEL_COLORS := {
	&"heart": Color("#ff7c86"),
	&"circle": Color("#5fd0a0"),
	&"diamond": Color("#6bb6f2"),
	&"star": Color("#ffcf5c"),
	&"triangle": Color("#b79bf0"),
	&"crescent": Color("#ffb59a"),
	&"shock": Color("#fffaf5"),
}

var simulation_state
var selected := Vector2i(-1, -1)
var cursor := Vector2i(0, 0)
var cursor_visible := false
var reduced_motion := false

var _pointer_active := false
var _pointer_id := -1
var _pointer_row := -1
var _pointer_column := -1
var _pointer_start := Vector2.ZERO
var _pointer_triggered := false
var _pointer_vertical_rejected := false


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	clip_contents = true
	focus_mode = Control.FOCUS_ALL


func set_simulation_state(next_state) -> void:
	simulation_state = next_state
	queue_redraw()


func set_reduced_motion(enabled: bool) -> void:
	reduced_motion = enabled
	queue_redraw()


func set_cursor_position(row: int, column: int, visible: bool = true) -> void:
	if simulation_state == null:
		return
	cursor.x = clampi(column, 0, simulation_state.board.columns - 2)
	cursor.y = clampi(row, 0, simulation_state.board.visible_rows - 1)
	cursor_visible = visible
	queue_redraw()


func hide_cursor() -> void:
	cursor_visible = false
	queue_redraw()


func clear_selection() -> void:
	selected = Vector2i(-1, -1)
	queue_redraw()


func shift_tracking_for_inserted_row() -> void:
	if simulation_state == null:
		return
	if selected.x >= 0:
		selected.y += 1
		if selected.y >= simulation_state.board.visible_rows:
			selected = Vector2i(-1, -1)
	if cursor_visible:
		cursor.y = mini(
			cursor.y + 1,
			simulation_state.board.visible_rows - 1,
		)
	if _pointer_active:
		_pointer_row = mini(
			_pointer_row + 1,
			simulation_state.board.visible_rows - 1,
		)
	queue_redraw()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed:
			_pointer_down(event.index, event.position)
		else:
			_pointer_up(event.index, event.position)
		accept_event()
	elif event is InputEventScreenDrag:
		_pointer_move(event.index, event.position)
		accept_event()
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			_pointer_down(-1, event.position)
		else:
			_pointer_up(-1, event.position)
		accept_event()
	elif event is InputEventMouseMotion and _pointer_active and _pointer_id == -1:
		_pointer_move(-1, event.position)
		accept_event()


func _pointer_down(pointer_id: int, position: Vector2) -> void:
	hide_cursor()
	if not _is_live() or _pointer_active:
		return
	var coordinate := coordinate_at(position)
	if coordinate.x < 0:
		clear_selection()
		return
	grab_focus()
	_pointer_active = true
	_pointer_id = pointer_id
	_pointer_row = coordinate.y
	_pointer_column = coordinate.x
	_pointer_start = position
	_pointer_triggered = false
	_pointer_vertical_rejected = false


func _pointer_move(pointer_id: int, position: Vector2) -> void:
	if not _pointer_active or pointer_id != _pointer_id:
		return
	var movement := position - _pointer_start
	if (
		not _pointer_triggered
		and absf(movement.y) > absf(movement.x)
		and absf(movement.y) > VERTICAL_REJECT_PX
	):
		_pointer_vertical_rejected = true
	if (
		_pointer_triggered
		or _pointer_vertical_rejected
		or absf(movement.x) < _cell_size() * SWIPE_THRESHOLD
	):
		return
	var direction := -1 if movement.x < 0.0 else 1
	swap_requested.emit(_pointer_row, _pointer_column, direction)
	_pointer_triggered = true
	clear_selection()


func _pointer_up(pointer_id: int, position: Vector2) -> void:
	if not _pointer_active or pointer_id != _pointer_id:
		return
	if not _pointer_triggered and not _pointer_vertical_rejected:
		var tapped := coordinate_at(position)
		if tapped.x >= 0:
			if (
				selected.y == tapped.y
				and absi(selected.x - tapped.x) == 1
			):
				var direction := 1 if tapped.x > selected.x else -1
				swap_requested.emit(selected.y, selected.x, direction)
				clear_selection()
			else:
				selected = tapped
				queue_redraw()
	_pointer_active = false
	_pointer_id = -1


func coordinate_at(position: Vector2) -> Vector2i:
	if simulation_state == null or size.x <= 0.0:
		return Vector2i(-1, -1)
	var cell := _cell_size()
	var column := floori(position.x / cell)
	var row := floori(
		(size.y - position.y) / cell - simulation_state.rise_offset,
	)
	if not simulation_state.board.is_inside(row, column):
		return Vector2i(-1, -1)
	return Vector2i(column, row)


func _draw() -> void:
	if simulation_state == null:
		return
	var cell := _cell_size()
	_draw_board_background(cell)
	_draw_incoming_row(cell)
	_draw_panels(cell)
	_draw_garbage(cell)
	_draw_selection(cell)
	_draw_danger()


func _draw_board_background(cell: float) -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("#fff4e8"))
	for row in simulation_state.board.visible_rows:
		for column in simulation_state.board.columns:
			var rect := Rect2(
				Vector2(column * cell, size.y - (row + 1) * cell),
				Vector2(cell, cell),
			)
			var tint := (
				Color(1.0, 1.0, 1.0, 0.16)
				if (row + column) % 2 == 0
				else Color(0.45, 0.25, 0.18, 0.025)
			)
			draw_rect(rect, tint)
	draw_line(
		Vector2(0.0, cell),
		Vector2(size.x, cell),
		Color(0.94, 0.38, 0.42, 0.65),
		maxf(2.0, cell * 0.045),
	)


func _draw_incoming_row(cell: float) -> void:
	if simulation_state.board.incoming_row.size() < simulation_state.board.columns:
		return
	for column in simulation_state.board.columns:
		var y: float = size.y - simulation_state.rise_offset * cell
		_draw_panel(
			simulation_state.board.incoming_row[column],
			Rect2(Vector2(column * cell, y), Vector2(cell, cell)),
			&"incoming",
		)


func _draw_panels(cell: float) -> void:
	for panel in simulation_state.board.cells:
		if panel == null:
			continue
		var swap_progress := 0.0
		if panel.state == &"swapping" and panel.animation_started_at >= 0:
			swap_progress = clampf(
				float(
					simulation_state.elapsed_clock
					- panel.animation_started_at
				) / 300.0,
				0.0,
				1.0,
			)
		var x: float = (
			panel.column + panel.offset_x * swap_progress
		) * cell
		# `offset_y` is deterministic bookkeeping left by row insertion and
		# gravity. The canonical renderer projects the authoritative row plus
		# rise offset; applying offset_y here leaves panels drawn one row behind.
		var y := _row_y(panel.row, cell)
		_draw_panel(
			panel.type,
			Rect2(Vector2(x, y), Vector2(cell, cell)),
			panel.state,
		)


func _draw_panel(
	type: StringName,
	cell_rect: Rect2,
	state: StringName,
) -> void:
	var color: Color = PANEL_COLORS.get(type, Color.WHITE)
	var inset := cell_rect.size.x * 0.075
	var rect := cell_rect.grow(-inset)
	var alpha := 1.0
	if state == &"incoming":
		alpha = 0.55
	elif state == &"clearing":
		alpha = 0.72
	var surface := color
	surface.a = alpha
	if state == &"flashing":
		surface = Color(1.0, 0.98, 0.94, 1.0)

	var shadow := StyleBoxFlat.new()
	shadow.bg_color = Color(0.27, 0.16, 0.13, 0.16 * alpha)
	_set_corners(shadow, roundi(rect.size.x * 0.28))
	draw_style_box(
		shadow,
		Rect2(rect.position + Vector2(0.0, inset * 0.65), rect.size),
	)

	var style := StyleBoxFlat.new()
	style.bg_color = surface
	style.border_color = Color(1.0, 1.0, 1.0, 0.52 * alpha)
	style.set_border_width_all(maxi(1, roundi(rect.size.x * 0.025)))
	_set_corners(style, roundi(rect.size.x * 0.28))
	draw_style_box(style, rect)
	draw_rect(
		Rect2(
			rect.position + Vector2(rect.size.x * 0.17, rect.size.y * 0.08),
			Vector2(rect.size.x * 0.66, maxf(2.0, rect.size.y * 0.065)),
		),
		Color(1.0, 1.0, 1.0, 0.42 * alpha),
	)
	if state != &"flashing":
		_draw_symbol(type, rect, color, alpha)


func _draw_symbol(
	type: StringName,
	rect: Rect2,
	panel_color: Color,
	alpha: float,
) -> void:
	var center := rect.get_center()
	var unit := rect.size.x
	var ink := Color(1.0, 1.0, 1.0, 0.92 * alpha)
	if type == &"shock":
		ink = Color(0.93, 0.42, 0.27, alpha)
	var width := maxf(2.0, unit * 0.065)

	if type == &"circle":
		draw_arc(center, unit * 0.18, 0.0, TAU, 32, ink, width, true)
	elif type == &"triangle":
		var points := PackedVector2Array([
			center + Vector2(0.0, -unit * 0.22),
			center + Vector2(unit * 0.22, unit * 0.18),
			center + Vector2(-unit * 0.22, unit * 0.18),
			center + Vector2(0.0, -unit * 0.22),
		])
		draw_polyline(points, ink, width, true)
	elif type == &"diamond":
		var points := PackedVector2Array([
			center + Vector2(0.0, -unit * 0.23),
			center + Vector2(unit * 0.2, 0.0),
			center + Vector2(0.0, unit * 0.23),
			center + Vector2(-unit * 0.2, 0.0),
			center + Vector2(0.0, -unit * 0.23),
		])
		draw_polyline(points, ink, width, true)
	elif type == &"star":
		var points := PackedVector2Array()
		for point in 10:
			var radius := unit * (0.23 if point % 2 == 0 else 0.1)
			var angle := -PI / 2.0 + point * PI / 5.0
			points.push_back(center + Vector2.from_angle(angle) * radius)
		draw_colored_polygon(points, ink)
	elif type == &"heart":
		draw_circle(center + Vector2(-unit * 0.1, -unit * 0.06), unit * 0.12, ink)
		draw_circle(center + Vector2(unit * 0.1, -unit * 0.06), unit * 0.12, ink)
		draw_colored_polygon(PackedVector2Array([
			center + Vector2(-unit * 0.22, -unit * 0.03),
			center + Vector2(unit * 0.22, -unit * 0.03),
			center + Vector2(0.0, unit * 0.24),
		]), ink)
	elif type == &"crescent":
		draw_circle(center, unit * 0.2, ink)
		var cover := panel_color
		cover.a = alpha
		draw_circle(center + Vector2(unit * 0.09, -unit * 0.045), unit * 0.17, cover)
	elif type == &"shock":
		draw_colored_polygon(PackedVector2Array([
			center + Vector2(unit * 0.04, -unit * 0.25),
			center + Vector2(-unit * 0.13, unit * 0.02),
			center + Vector2(-unit * 0.01, unit * 0.02),
			center + Vector2(-unit * 0.07, unit * 0.25),
			center + Vector2(unit * 0.16, -unit * 0.06),
			center + Vector2(unit * 0.03, -unit * 0.06),
		]), ink)


func _draw_garbage(cell: float) -> void:
	for block in simulation_state.garbage:
		for row_offset in block.height:
			for column_offset in block.width:
				var row: int = block.row + row_offset
				var column: int = block.column + column_offset
				var rect := Rect2(
					Vector2(
						column * cell,
						size.y - (
							row + 1.0 + simulation_state.rise_offset
							- block.fall_progress
						) * cell,
					),
					Vector2(cell, cell),
				).grow(-cell * 0.035)
				var color := (
					Color("#77727e")
					if block.type == &"metal"
					else Color("#c9b4a5")
				)
				if block.state == &"converting":
					color = color.lerp(Color("#fffaf5"), 0.45)
				draw_rect(rect, color)
				draw_rect(rect.grow(-cell * 0.08), Color(1.0, 1.0, 1.0, 0.12), false, 2.0)
				draw_circle(rect.get_center(), cell * 0.055, Color(0.3, 0.25, 0.26, 0.35))


func _draw_selection(cell: float) -> void:
	if selected.x >= 0:
		_draw_cell_outline(selected.y, selected.x, cell, Color.WHITE, 4.0)
	if cursor_visible:
		var y := _row_y(cursor.y, cell)
		draw_rect(
			Rect2(Vector2(cursor.x * cell, y), Vector2(cell * 2.0, cell)),
			Color("#4d3029"),
			false,
			maxf(3.0, cell * 0.06),
		)


func _draw_cell_outline(
	row: int,
	column: int,
	cell: float,
	color: Color,
	width: float,
) -> void:
	var y := _row_y(row, cell)
	draw_rect(
		Rect2(Vector2(column * cell, y), Vector2(cell, cell)).grow(-2.0),
		color,
		false,
		width,
	)


func _draw_danger() -> void:
	if simulation_state.danger_remaining < 0:
		return
	var pulse := (
		0.14
		if reduced_motion
		else 0.12 + 0.08 * sin(
			float(simulation_state.elapsed_clock) / 90.0,
		)
	)
	draw_rect(Rect2(Vector2.ZERO, size), Color(1.0, 0.12, 0.16, pulse))


func _cell_size() -> float:
	if simulation_state == null:
		return size.x / 6.0
	return size.x / simulation_state.board.columns


func _row_y(row: int, cell: float = -1.0) -> float:
	var actual_cell := _cell_size() if cell <= 0.0 else cell
	return (
		size.y
		- (row + 1.0 + simulation_state.rise_offset) * actual_cell
	)


func _is_live() -> bool:
	return (
		simulation_state != null
		and simulation_state.status == &"playing"
	)


func _set_corners(style: StyleBoxFlat, radius: int) -> void:
	style.corner_radius_top_left = radius
	style.corner_radius_top_right = radius
	style.corner_radius_bottom_left = radius
	style.corner_radius_bottom_right = radius
