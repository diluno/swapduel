extends Control

signal swap_requested(row: int, column: int, direction: int)

const Config = preload("res://game/engine/config.gd")
const Impact = preload("res://game/presentation/impact.gd")
const UiTheme = preload("res://game/presentation/ui_theme.gd")

const SWIPE_THRESHOLD := 0.28
const VERTICAL_REJECT_PX := 8.0
const FLASH_INTERVAL := 70 * Config.CLOCK_UNITS_PER_MILLISECOND
const COMBO_EFFECT_DURATION := 1100 * Config.CLOCK_UNITS_PER_MILLISECOND
const COMBO_FADE_START := 760 * Config.CLOCK_UNITS_PER_MILLISECOND

const PANEL_SKINS := {
	&"heart": [Color("#ff7c86"), Color("#f0606c")],
	&"circle": [Color("#5fd0a0"), Color("#3fba87")],
	&"diamond": [Color("#6bb6f2"), Color("#4c9ee3")],
	&"star": [Color("#ffcf5c"), Color("#f4b637")],
	&"triangle": [Color("#b79bf0"), Color("#9e7fe6")],
	&"crescent": [Color("#ffb59a"), Color("#ed6a45")],
	&"shock": [Color("#fffaf5"), Color("#ffd8b8")],
}

const GARBAGE_SKINS := {
	&"normal": {
		"mortar": Color("#a3806a"),
		"top": Color("#f0dccb"),
		"middle": Color("#dcc0aa"),
		"bottom": Color("#c29f86"),
		"rim": Color(1.0, 0.98, 0.96, 0.8),
		"shade": Color(0.43, 0.31, 0.24, 0.18),
		"mark": Color(0.47, 0.33, 0.24, 0.42),
		"shadow": Color(0.43, 0.29, 0.21, 0.26),
	},
	&"metal": {
		"mortar": Color("#5d8098"),
		"top": Color("#e9f3f9"),
		"middle": Color("#bcd2e0"),
		"bottom": Color("#94b4c7"),
		"rim": Color(0.97, 0.99, 1.0, 0.88),
		"shade": Color(0.19, 0.32, 0.42, 0.2),
		"mark": Color(0.23, 0.36, 0.45, 0.45),
		"shadow": Color(0.26, 0.44, 0.56, 0.3),
	},
}

var simulation_state
var selected := Vector2i(-1, -1)
var cursor := Vector2i(0, 0)
var cursor_visible := false
var reduced_motion := false
var impact = Impact.new()
var _game_config = Config.default_game_config()

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
	impact.reset()
	if simulation_state != null:
		impact.observe(simulation_state)
	queue_redraw()


func observe_simulation_step() -> Dictionary:
	if simulation_state == null:
		return {}
	var landing: Dictionary = impact.observe(simulation_state)
	queue_redraw()
	return landing


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
	draw_rect(Rect2(Vector2.ZERO, size), Color("#fff4e8"))
	var shake := (
		Vector2.ZERO
		if reduced_motion
		else impact.shake_offset(simulation_state.elapsed_clock) * cell
	)
	draw_set_transform(shake)
	_draw_board_background(cell)
	_draw_incoming_row(cell)
	_draw_panels(cell)
	_draw_garbage(cell)
	_draw_selection(cell)
	_draw_danger()
	draw_set_transform(Vector2.ZERO)
	_draw_clear_badge(cell)


func _draw_board_background(cell: float) -> void:
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
	var pop_indexes := _pop_order()
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
		var squash := 0.0
		if panel.state == &"idle" and not reduced_motion:
			var fall_visual := impact.panel_fall_visual(
				panel.id,
				simulation_state.elapsed_clock,
			)
			y -= fall_visual.x * cell
			squash = fall_visual.y
		var draw_state: StringName = panel.state
		var alpha := 1.0
		var pop_scale := 1.0
		if panel.state == &"flashing":
			var flash_age: int = (
				simulation_state.elapsed_clock
				- panel.animation_started_at
			)
			draw_state = (
				&"flashing"
				if (
					not reduced_motion
					and floori(float(flash_age) / FLASH_INTERVAL) % 2 == 0
				)
				else &"idle"
			)
		elif panel.state == &"clearing":
			var pop_index := int(pop_indexes.get(panel.id, 0))
			var pop_start: int = (
				panel.animation_started_at
				+ pop_index * _game_config.timing.panel_pop_interval
			)
			var pop_elapsed: int = (
				simulation_state.elapsed_clock - pop_start
			)
			if pop_elapsed < 0:
				draw_state = &"flashing" if not reduced_motion else &"idle"
			else:
				var pop_progress := clampf(
					float(pop_elapsed)
						/ _game_config.timing.clear_duration,
					0.0,
					1.0,
				)
				alpha = maxf(0.12, 1.0 - pop_progress)
				if not reduced_motion:
					pop_scale = (
						1.0
						+ sin(minf(1.0, pop_progress * 1.6) * PI)
							* 0.16
					)
		var rect := Rect2(Vector2(x, y), Vector2(cell, cell))
		if pop_scale != 1.0:
			rect = _scale_rect_from_center(rect, pop_scale, pop_scale)
		if squash > 0.0:
			rect = _scale_rect_from_bottom(
				rect,
				1.0 + squash * 0.45,
				1.0 - squash,
			)
		_draw_panel(
			panel.type,
			rect,
			draw_state,
			alpha,
		)


func _draw_panel(
	type: StringName,
	cell_rect: Rect2,
	state: StringName,
	alpha_multiplier: float = 1.0,
) -> void:
	var skin: Array = PANEL_SKINS.get(
		type,
		[Color.WHITE, UiTheme.PEACH_DEEP],
	)
	var top: Color = skin[0]
	var bottom: Color = skin[1]
	var inset := cell_rect.size.x * 0.075
	var rect := cell_rect.grow(-inset)
	var alpha := alpha_multiplier
	if state == &"incoming":
		alpha *= 0.55
	if state == &"flashing":
		top = Color("#fffaf5")
		bottom = Color("#fff0df")
	top.a = alpha
	bottom.a = alpha

	var shadow := StyleBoxFlat.new()
	shadow.bg_color = Color(0.27, 0.16, 0.13, 0.16 * alpha)
	_set_corners(shadow, roundi(rect.size.x * 0.28))
	draw_style_box(
		shadow,
		Rect2(rect.position + Vector2(0.0, inset * 0.65), rect.size),
	)

	# A darker full-height base and a shorter lit face give each panel a
	# tactile candy-button profile without relying on external sprite sizes.
	var base := StyleBoxFlat.new()
	base.bg_color = bottom
	base.border_color = Color(1.0, 1.0, 1.0, 0.38 * alpha)
	base.set_border_width_all(maxi(1, roundi(rect.size.x * 0.025)))
	_set_corners(base, roundi(rect.size.x * 0.28))
	draw_style_box(base, rect)

	var face_rect := Rect2(
		rect.position + Vector2(rect.size.x * 0.018, rect.size.y * 0.018),
		Vector2(rect.size.x * 0.964, rect.size.y * 0.87),
	)
	var face := StyleBoxFlat.new()
	face.bg_color = top
	face.border_color = Color(1.0, 1.0, 1.0, 0.42 * alpha)
	face.set_border_width_all(maxi(1, roundi(rect.size.x * 0.018)))
	_set_corners(face, roundi(rect.size.x * 0.265))
	draw_style_box(face, face_rect)
	draw_rect(
		Rect2(
			rect.position + Vector2(rect.size.x * 0.17, rect.size.y * 0.08),
			Vector2(rect.size.x * 0.66, maxf(2.0, rect.size.y * 0.065)),
		),
		Color(1.0, 1.0, 1.0, 0.42 * alpha),
	)
	if state != &"flashing":
		_draw_symbol(type, rect, top, alpha)


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
		var squash := 0.0
		var landed_at = impact.landings.get(block.id)
		if landed_at != null and not reduced_motion:
			var squash_age: int = (
				simulation_state.elapsed_clock - int(landed_at)
			)
			if squash_age >= 0 and squash_age < Impact.SQUASH_DURATION:
				var progress := float(squash_age) / Impact.SQUASH_DURATION
				squash = sin(progress * PI) * (1.0 - progress) * 0.26
		var pivot := Vector2(
			(block.column + block.width * 0.5) * cell,
			size.y - (
				block.row + simulation_state.rise_offset
			) * cell,
		)
		var block_rect := Rect2(
			Vector2(
				block.column * cell,
				size.y - (
					block.row
					+ block.height
					+ simulation_state.rise_offset
					- block.fall_progress
				) * cell,
			),
			Vector2(block.width * cell, block.height * cell),
		).grow(-cell * 0.025)
		if squash > 0.0:
			block_rect = _scale_rect_around(
				block_rect,
				pivot,
				1.0 + squash * 0.5,
				1.0 - squash,
			)
		var skin: Dictionary = GARBAGE_SKINS.get(
			block.type,
			GARBAGE_SKINS[&"normal"],
		)
		var body := StyleBoxFlat.new()
		body.bg_color = skin["mortar"]
		body.border_color = skin["rim"]
		body.set_border_width_all(maxi(1, roundi(cell * 0.03)))
		body.shadow_color = skin["shadow"]
		body.shadow_size = roundi(
			cell * (0.18 if block.state == &"falling" else 0.08),
		)
		body.shadow_offset = Vector2(
			0.0,
			cell * (0.1 if block.state == &"falling" else 0.045),
		)
		_set_corners(body, roundi(cell * 0.22))
		draw_style_box(body, block_rect)

		var pulse := (
			0.5
			if reduced_motion
			else (
				1.0
				+ sin(
					float(simulation_state.elapsed_clock)
						/ Config.CLOCK_UNITS_PER_MILLISECOND
						/ 65.0,
				)
			) / 2.0
		)
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
				if squash > 0.0:
					rect = _scale_rect_around(
						rect,
						pivot,
						1.0 + squash * 0.5,
						1.0 - squash,
					)
				var breaking: bool = (
					block.state == &"converting"
					and row_offset == block.height - 1
				)
				var heat := (
					0.25 + 0.4 * pulse
					if breaking
					else (
						0.1 * pulse
						if block.state == &"converting"
						else 0.0
					)
				)
				_draw_garbage_tile(
					rect,
					skin,
					block.type == &"metal",
					heat,
					block.id + column_offset,
					breaking,
					cell,
				)

		if block.state == &"converting":
			var seam_y := block_rect.position.y
			var seam_height := minf(cell, block_rect.size.y)
			draw_rect(
				Rect2(
					Vector2(block_rect.position.x, seam_y),
					Vector2(block_rect.size.x, seam_height),
				),
				Color(1.0, 0.82, 0.38, 0.12 + 0.2 * pulse),
			)


func _draw_garbage_tile(
	rect: Rect2,
	skin: Dictionary,
	is_metal: bool,
	heat: float,
	crack_seed: int,
	breaking: bool,
	cell: float,
) -> void:
	var tile := rect.grow(-cell * 0.025)
	var radius := roundi(cell * 0.19)

	var base := StyleBoxFlat.new()
	base.bg_color = skin["bottom"]
	base.border_color = skin["rim"]
	base.set_border_width_all(maxi(1, roundi(cell * 0.025)))
	_set_corners(base, radius)
	draw_style_box(base, tile)

	var middle_rect := Rect2(
		tile.position + Vector2(cell * 0.012, cell * 0.012),
		Vector2(tile.size.x - cell * 0.024, tile.size.y * 0.83),
	)
	var middle := StyleBoxFlat.new()
	middle.bg_color = skin["middle"]
	_set_corners(middle, maxi(1, radius - 1))
	draw_style_box(middle, middle_rect)

	var top_rect := Rect2(
		middle_rect.position,
		Vector2(middle_rect.size.x, middle_rect.size.y * 0.48),
	)
	var top := StyleBoxFlat.new()
	top.bg_color = skin["top"]
	_set_corners(top, maxi(1, radius - 1))
	draw_style_box(top, top_rect)

	draw_rect(
		Rect2(
			tile.position + Vector2(cell * 0.12, cell * 0.075),
			Vector2(tile.size.x - cell * 0.24, maxf(1.5, cell * 0.055)),
		),
		Color(1.0, 1.0, 1.0, 0.44),
	)
	draw_rect(
		Rect2(
			Vector2(tile.position.x, tile.end.y - tile.size.y * 0.16),
			Vector2(tile.size.x, tile.size.y * 0.16),
		),
		skin["shade"],
	)

	if is_metal:
		draw_line(
			tile.position + Vector2(cell * 0.08, tile.size.y * 0.78),
			tile.position + Vector2(tile.size.x * 0.72, cell * 0.08),
			Color(1.0, 1.0, 1.0, 0.26),
			maxf(1.5, cell * 0.055),
			true,
		)

	if heat > 0.0:
		var heat_color := Color(1.0, 0.98, 0.92, 0.72 * heat)
		draw_rect(tile.grow(-cell * 0.02), heat_color)

	var center := tile.get_center()
	if is_metal:
		draw_circle(center, cell * 0.072, Color("#eef6fb"))
		draw_arc(
			center,
			cell * 0.072,
			0.0,
			TAU,
			18,
			skin["mark"],
			maxf(1.0, cell * 0.022),
			true,
		)
	else:
		var mark := cell * 0.1
		var lozenge := PackedVector2Array([
			center + Vector2(0.0, -mark),
			center + Vector2(mark, 0.0),
			center + Vector2(0.0, mark),
			center + Vector2(-mark, 0.0),
		])
		draw_colored_polygon(lozenge, Color(1.0, 0.97, 0.93, 0.7))
		var outline := lozenge.duplicate()
		outline.push_back(outline[0])
		draw_polyline(
			outline,
			skin["mark"],
			maxf(1.0, cell * 0.022),
			true,
		)

	if breaking:
		_draw_tile_cracks(tile, crack_seed, 0.45 + 0.4 * heat, cell)


func _draw_tile_cracks(
	rect: Rect2,
	seed: int,
	alpha: float,
	cell: float,
) -> void:
	var center := rect.get_center()
	for arm in 4:
		var angle := deg_to_rad(float((seed * 37 + arm * 120) % 360))
		var elbow := center + Vector2.from_angle(angle) * cell * 0.2
		var tip := (
			center
			+ Vector2.from_angle(angle + 0.5) * cell * 0.36
		)
		draw_polyline(
			PackedVector2Array([center, elbow, tip]),
			Color(1.0, 0.99, 0.96, alpha),
			maxf(1.5, cell * 0.04),
			true,
		)


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


func _draw_clear_badge(cell: float) -> void:
	var clear = simulation_state.last_clear_event
	if (
		clear == null
		or (clear.normal_size < 4 and clear.chain_level < 2)
	):
		return
	var age: int = simulation_state.elapsed_clock - clear.occurred_at
	if age < 0 or age >= COMBO_EFFECT_DURATION:
		return
	var fade := (
		1.0
		if age < COMBO_FADE_START
		else maxf(
			0.0,
			1.0
			- float(age - COMBO_FADE_START)
				/ (COMBO_EFFECT_DURATION - COMBO_FADE_START),
		)
	)
	var burst_progress := minf(
		1.0,
		float(age) / (720 * Config.CLOCK_UNITS_PER_MILLISECOND),
	)
	var enter_progress := minf(
		1.0,
		float(age) / (220 * Config.CLOCK_UNITS_PER_MILLISECOND),
	)
	var overshoot := enter_progress - 1.0
	var entrance_scale := (
		1.0
		if reduced_motion
		else (
			1.0
			+ 2.70158 * pow(overshoot, 3.0)
			+ 1.70158 * pow(overshoot, 2.0)
		)
	)
	var size_boost := minf(0.12, maxi(0, clear.normal_size - 4) * 0.018)
	var badge_scale := entrance_scale * (1.0 + size_boost)
	var center := Vector2(
		size.x / 2.0,
		maxf(cell * 1.45, size.y * 0.28),
	)

	if not reduced_motion:
		var ring_color := (
			Color(0.72, 0.61, 0.94, 0.5 * (1.0 - burst_progress))
			if clear.chain_level > 1 or clear.normal_size >= 8
			else Color(1.0, 0.81, 0.36, 0.58 * (1.0 - burst_progress))
		)
		draw_arc(
			center,
			cell * (0.62 + burst_progress * 1.08),
			0.0,
			TAU,
			40,
			ring_color,
			maxf(2.0, cell * 0.08),
			true,
		)
		var particle_colors := [
			Color("#ffcf5c"),
			Color("#ff8c66"),
			Color("#ff7c86"),
			Color("#5fd0a0"),
			Color("#6bb6f2"),
			Color("#b79bf0"),
		]
		var particle_count := mini(14, maxi(8, clear.normal_size + 4))
		for particle in particle_count:
			var angle := -PI / 2.0 + float(particle) / particle_count * TAU
			var stagger := (particle % 3) * cell * 0.08
			var distance := cell * (
				0.54 + burst_progress * 1.16
			) + stagger
			var particle_size := cell * (
				0.075 - burst_progress * 0.025
			)
			var color: Color = particle_colors[
				particle % particle_colors.size()
			]
			color.a = fade * maxf(0.0, 1.0 - burst_progress * 0.78)
			var position := center + Vector2.from_angle(angle) * distance
			if particle % 2 == 0:
				draw_rect(
					Rect2(
						position - Vector2.ONE * particle_size / 2.0,
						Vector2.ONE * particle_size,
					),
					color,
				)
			else:
				draw_circle(position, particle_size / 2.0, color)

	var badge_width := minf(size.x * 0.68, maxf(142.0, cell * 3.65))
	var badge_height := maxf(42.0, cell * 0.72)
	var rect := Rect2(
		center - Vector2(badge_width, badge_height) / 2.0,
		Vector2(badge_width, badge_height),
	)
	rect = _scale_rect_from_center(rect, badge_scale, badge_scale)
	var palette := (
		[Color("#b79bf0"), Color("#6b8fe8"), Color("#7459ba")]
		if clear.chain_level > 1 or clear.normal_size >= 8
		else (
			[Color("#ff8f91"), Color("#ed6a45"), Color("#c6533a")]
			if clear.normal_size >= 6
			else [Color("#ffd15c"), Color("#ff914f"), Color("#d87828")]
		)
	)
	var shadow := StyleBoxFlat.new()
	shadow.bg_color = palette[2]
	shadow.bg_color.a = fade
	_set_corners(shadow, roundi(rect.size.y / 2.0))
	draw_style_box(
		shadow,
		Rect2(rect.position + Vector2(0.0, cell * 0.075), rect.size),
	)
	var badge := StyleBoxFlat.new()
	badge.bg_color = palette[0].lerp(palette[1], 0.38)
	badge.bg_color.a = fade
	badge.border_color = Color(1.0, 1.0, 1.0, 0.72 * fade)
	badge.set_border_width_all(maxi(1, roundi(cell * 0.035)))
	_set_corners(badge, roundi(rect.size.y / 2.0))
	draw_style_box(badge, rect)
	var label := (
		"CHAIN ×%d" % clear.chain_level
		if clear.chain_level > 1
		else "%d COMBO!" % clear.normal_size
	)
	var font_size := maxi(17, roundi(cell * 0.38 * badge_scale))
	draw_string(
		UiTheme.display_font(700),
		Vector2(rect.position.x, center.y + font_size * 0.34),
		label,
		HORIZONTAL_ALIGNMENT_CENTER,
		rect.size.x,
		font_size,
		Color(1.0, 1.0, 1.0, fade),
	)


func _pop_order() -> Dictionary:
	var order: Dictionary = {}
	for group in simulation_state.clears:
		var matched: Array = []
		for panel_id in group.panel_ids:
			for panel in simulation_state.board.cells:
				if panel != null and panel.id == panel_id:
					matched.push_back(panel)
					break
		matched.sort_custom(func(a, b):
			if a.row != b.row:
				return a.row > b.row
			return a.column < b.column
		)
		for index in matched.size():
			order[matched[index].id] = index
	return order


func _scale_rect_from_center(
	rect: Rect2,
	scale_x: float,
	scale_y: float,
) -> Rect2:
	return _scale_rect_around(
		rect,
		rect.get_center(),
		scale_x,
		scale_y,
	)


func _scale_rect_from_bottom(
	rect: Rect2,
	scale_x: float,
	scale_y: float,
) -> Rect2:
	return _scale_rect_around(
		rect,
		Vector2(rect.get_center().x, rect.end.y),
		scale_x,
		scale_y,
	)


func _scale_rect_around(
	rect: Rect2,
	pivot: Vector2,
	scale_x: float,
	scale_y: float,
) -> Rect2:
	var scale := Vector2(scale_x, scale_y)
	var scaled_center := pivot + (rect.get_center() - pivot) * scale
	var scaled_size := rect.size * scale
	return Rect2(scaled_center - scaled_size / 2.0, scaled_size)


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
