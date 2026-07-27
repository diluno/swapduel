extends "res://game/presentation/board_view.gd"

const Types = preload("res://game/engine/types.gd")

var last_sequence := -1


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	clip_contents = true
	focus_mode = Control.FOCUS_NONE


func _draw() -> void:
	if simulation_state != null:
		super._draw()
		return
	draw_rect(Rect2(Vector2.ZERO, size), Color("#fff4e8"))
	var font_size := maxi(8, roundi(size.x * 0.105))
	draw_string(
		UiTheme.body_font(900),
		Vector2(0.0, size.y * 0.5 + font_size * 0.35),
		"WAITING…",
		HORIZONTAL_ALIGNMENT_CENTER,
		size.x,
		font_size,
		UiTheme.INK_FAINT,
	)


func clear_snapshot() -> void:
	last_sequence = -1
	set_simulation_state(null)


func set_snapshot(snapshot: Dictionary) -> bool:
	var sequence := int(snapshot.get("sequence", -1))
	if sequence < 0 or sequence <= last_sequence:
		return false

	var next_state := Types.SimulationState.new()
	next_state.board = Types.Board.new(6, 12, 1)
	next_state.rise_offset = clampf(
		float(snapshot.get("riseOffset", 0.0)),
		0.0,
		1.0,
	)
	next_state.elapsed_clock = (
		Time.get_ticks_msec() * Config.CLOCK_UNITS_PER_MILLISECOND
	)
	var danger = snapshot.get("dangerRemainingMs")
	next_state.danger_remaining = (
		-1
		if danger == null
		else maxi(
			0,
			roundi(
				float(danger) * Config.CLOCK_UNITS_PER_MILLISECOND,
			),
		)
	)

	var next_panel_id := 1
	for raw_cell in snapshot.get("cells", []):
		if not raw_cell is Dictionary:
			continue
		var row := int(raw_cell.get("row", -1))
		var column := int(raw_cell.get("column", -1))
		if not next_state.board.is_inside(row, column):
			continue
		var panel := Types.GamePanel.new(
			next_panel_id,
			StringName(String(raw_cell.get("type", "circle"))),
			row,
			column,
		)
		panel.state = StringName(String(raw_cell.get("state", "idle")))
		panel.animation_started_at = next_state.elapsed_clock
		next_state.board.set_panel(row, column, panel)
		next_panel_id += 1

	for raw_block in snapshot.get("garbage", []):
		if not raw_block is Dictionary:
			continue
		var block := Types.GarbageBlock.new(
			int(raw_block.get("id", next_state.garbage.size() + 1)),
			StringName(String(raw_block.get("type", "normal"))),
			int(raw_block.get("column", 0)),
			int(raw_block.get("row", 0)),
			maxi(1, int(raw_block.get("width", 1))),
			maxi(1, int(raw_block.get("height", 1))),
		)
		block.state = StringName(String(raw_block.get("state", "idle")))
		next_state.garbage.push_back(block)

	last_sequence = sequence
	set_simulation_state(next_state)
	return true
