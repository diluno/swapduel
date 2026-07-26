extends Control

const Simulation = preload("res://game/engine/simulation.gd")
const BoardView = preload("res://game/presentation/board_view.gd")
const Config = preload("res://game/engine/config.gd")
const Recovery = preload("res://game/engine/recovery.gd")

const MODE_ENDLESS: StringName = &"endless"
const MODE_TIME_TRIAL: StringName = &"time-trial"
const PROGRESS_PATH := "user://progress.cfg"
const RECOVERY_PATH := "user://solo-recovery.json"
const RECOVERY_SCOPE := "native:solo"
const RECOVERY_INTERVAL_STEPS := 120
const RECOVERY_MAX_AGE_MS := 7 * 24 * 60 * 60 * 1000

var state
var board_view
var recovery_enabled := true

var _title_label: Label
var _score_label: Label
var _detail_label: Label
var _pause_button: Button
var _raise_button: Button
var _restart_button: Button
var _home_panel: PanelContainer
var _home_best_label: Label
var _settings_panel: PanelContainer
var _sound_button: Button
var _motion_button: Button
var _battery_button: Button
var _haptics_button: Button
var _result_panel: PanelContainer
var _result_label: Label
var _result_retry_button: Button
var _raise_timer: Timer
var _cursor := Vector2i(0, 0)
var _hud_step := -1
var _raise_held := false
var _mode: StringName = MODE_ENDLESS
var _round_active := false
var _result_reported := false
var _best_endless := 0
var _best_time_trial := 0
var _progress := ConfigFile.new()
var _last_clear_at := -1
var _last_recovery_step := -1


func _ready() -> void:
	_build_interface()
	var settings = _settings()
	if settings != null:
		settings.changed.connect(_apply_settings)
	_apply_settings()
	_load_progress()
	if not _try_restore_round():
		_show_home()
	resized.connect(_layout_interface)
	_layout_interface()


func _physics_process(_delta: float) -> void:
	if state == null or state.status != &"playing":
		return
	var falling_before: Array[int] = []
	for block in state.garbage:
		if block.state == &"falling":
			falling_before.push_back(block.id)
	var rise_before: float = state.rise_offset
	var next_panel_id_before: int = state.board.next_panel_id
	Simulation.step_simulation(state)
	if (
		state.rise_offset < rise_before
		and state.board.next_panel_id - next_panel_id_before
			>= state.board.columns
	):
		board_view.shift_tracking_for_inserted_row()
	_play_step_feedback(falling_before)
	board_view.queue_redraw()
	if state.step - _last_recovery_step >= RECOVERY_INTERVAL_STEPS:
		_save_recovery()
	if state.step - _hud_step >= 6 or state.status == &"lost":
		_update_hud()
	if state.status == &"lost":
		_finish_round()


func _unhandled_input(event: InputEvent) -> void:
	if state == null or not event is InputEventKey:
		return
	var key: Key = event.keycode
	if not event.pressed:
		if key == KEY_SHIFT:
			_stop_manual_raise()
			get_viewport().set_input_as_handled()
		return
	if event.echo or state.status != &"playing":
		return

	var handled := true
	if key in [KEY_LEFT, KEY_A]:
		_cursor.x -= 1
	elif key in [KEY_RIGHT, KEY_D]:
		_cursor.x += 1
	elif key in [KEY_UP, KEY_W]:
		_cursor.y += 1
	elif key in [KEY_DOWN, KEY_S]:
		_cursor.y -= 1
	elif key in [KEY_SPACE, KEY_ENTER, KEY_KP_ENTER]:
		_request_swap(_cursor.y, _cursor.x, 1)
	elif key == KEY_SHIFT:
		Simulation.set_manual_raise(state, true)
	else:
		handled = false

	if not handled:
		return
	_cursor.x = clampi(_cursor.x, 0, state.board.columns - 2)
	_cursor.y = clampi(_cursor.y, 0, state.board.visible_rows - 1)
	board_view.set_cursor_position(_cursor.y, _cursor.x)
	get_viewport().set_input_as_handled()


func _notification(what: int) -> void:
	if what in [NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED]:
		_stop_manual_raise()
		if _round_active and state != null and state.status == &"playing":
			Simulation.set_paused(state, true)
			_pause_button.text = "Resume"
			_update_hud()
		_save_recovery()


func _exit_tree() -> void:
	_save_recovery()


func _build_interface() -> void:
	var background := ColorRect.new()
	background.color = Color("#fff4e8")
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(background)

	_title_label = Label.new()
	_title_label.text = "ENDLESS"
	_title_label.add_theme_font_size_override("font_size", 19)
	_title_label.add_theme_color_override("font_color", Color("#6d4a3d"))
	add_child(_title_label)

	_score_label = Label.new()
	_score_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_score_label.add_theme_font_size_override("font_size", 28)
	_score_label.add_theme_color_override("font_color", Color("#ed6a45"))
	add_child(_score_label)

	_detail_label = Label.new()
	_detail_label.add_theme_font_size_override("font_size", 13)
	_detail_label.add_theme_color_override("font_color", Color("#907063"))
	add_child(_detail_label)

	board_view = BoardView.new()
	board_view.swap_requested.connect(_request_swap)
	add_child(board_view)

	_pause_button = _make_button("Pause")
	_pause_button.pressed.connect(_toggle_pause)
	add_child(_pause_button)

	_raise_button = _make_button("Hold to raise")
	_raise_button.button_down.connect(_begin_raise_hold)
	_raise_button.button_up.connect(_stop_manual_raise)
	_raise_button.mouse_exited.connect(_stop_manual_raise)
	add_child(_raise_button)

	_restart_button = _make_button("Modes")
	_restart_button.pressed.connect(_show_home)
	add_child(_restart_button)

	_raise_timer = Timer.new()
	_raise_timer.one_shot = true
	_raise_timer.wait_time = 0.08
	_raise_timer.timeout.connect(_activate_manual_raise)
	add_child(_raise_timer)

	_home_panel = PanelContainer.new()
	_home_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	add_child(_home_panel)
	var home_box := VBoxContainer.new()
	home_box.add_theme_constant_override("separation", 10)
	_home_panel.add_child(home_box)
	var home_title := Label.new()
	home_title.text = "SWAPDUEL"
	home_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	home_title.add_theme_font_size_override("font_size", 28)
	home_title.add_theme_color_override("font_color", Color("#ed6a45"))
	home_box.add_child(home_title)
	var home_note := Label.new()
	home_note.text = "Choose your run"
	home_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	home_note.add_theme_color_override("font_color", Color("#907063"))
	home_box.add_child(home_note)
	var endless_button := _make_button("Endless")
	endless_button.pressed.connect(_start_round.bind(MODE_ENDLESS))
	home_box.add_child(endless_button)
	var trial_button := _make_button("Two-minute trial")
	trial_button.pressed.connect(_start_round.bind(MODE_TIME_TRIAL))
	home_box.add_child(trial_button)
	var settings_button := _make_button("Settings")
	settings_button.pressed.connect(_show_settings)
	home_box.add_child(settings_button)
	_home_best_label = Label.new()
	_home_best_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_home_best_label.add_theme_font_size_override("font_size", 12)
	_home_best_label.add_theme_color_override("font_color", Color("#907063"))
	home_box.add_child(_home_best_label)

	_settings_panel = PanelContainer.new()
	_settings_panel.add_theme_stylebox_override(
		"panel",
		_make_overlay_style(),
	)
	_settings_panel.visible = false
	add_child(_settings_panel)
	var settings_box := VBoxContainer.new()
	settings_box.add_theme_constant_override("separation", 10)
	_settings_panel.add_child(settings_box)
	var settings_title := Label.new()
	settings_title.text = "SETTINGS"
	settings_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	settings_title.add_theme_font_size_override("font_size", 23)
	settings_title.add_theme_color_override("font_color", Color("#6d4a3d"))
	settings_box.add_child(settings_title)
	_sound_button = _make_button("")
	_sound_button.pressed.connect(_toggle_sound)
	settings_box.add_child(_sound_button)
	_motion_button = _make_button("")
	_motion_button.pressed.connect(_toggle_reduced_motion)
	settings_box.add_child(_motion_button)
	_battery_button = _make_button("")
	_battery_button.pressed.connect(_toggle_battery_saver)
	settings_box.add_child(_battery_button)
	_haptics_button = _make_button("")
	_haptics_button.pressed.connect(_toggle_haptics)
	settings_box.add_child(_haptics_button)
	var settings_done := _make_button("Done")
	settings_done.pressed.connect(_hide_settings)
	settings_box.add_child(settings_done)

	_result_panel = PanelContainer.new()
	_result_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	_result_panel.visible = false
	add_child(_result_panel)

	var result_box := VBoxContainer.new()
	result_box.add_theme_constant_override("separation", 12)
	_result_panel.add_child(result_box)
	_result_label = Label.new()
	_result_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_result_label.add_theme_font_size_override("font_size", 22)
	_result_label.add_theme_color_override("font_color", Color("#6d4a3d"))
	result_box.add_child(_result_label)
	_result_retry_button = _make_button("Play again")
	_result_retry_button.pressed.connect(_restart_current_round)
	result_box.add_child(_result_retry_button)
	var modes := _make_button("Choose mode")
	modes.pressed.connect(_show_home)
	result_box.add_child(modes)


func _layout_interface() -> void:
	if board_view == null:
		return
	var viewport_size := size
	var margin := 16.0
	_title_label.position = Vector2(margin, 16.0)
	_title_label.size = Vector2(viewport_size.x * 0.45, 28.0)
	_score_label.position = Vector2(viewport_size.x * 0.5, 10.0)
	_score_label.size = Vector2(viewport_size.x * 0.5 - margin, 38.0)
	_detail_label.position = Vector2(margin, 45.0)
	_detail_label.size = Vector2(viewport_size.x - margin * 2.0, 24.0)

	var board_top := 76.0
	var controls_height := 60.0
	var board_available_height := maxf(
		120.0,
		viewport_size.y - board_top - controls_height - 28.0,
	)
	var board_width := minf(
		viewport_size.x - margin * 2.0,
		board_available_height / 2.0,
	)
	board_view.size = Vector2(board_width, board_width * 2.0)
	board_view.position = Vector2(
		(viewport_size.x - board_width) / 2.0,
		board_top,
	)

	var control_y: float = board_view.position.y + board_view.size.y + 10.0
	var gap := 8.0
	var button_width := (viewport_size.x - margin * 2.0 - gap * 2.0) / 3.0
	for index in 3:
		var button: Button = [
			_pause_button,
			_raise_button,
			_restart_button,
		][index]
		button.position = Vector2(margin + index * (button_width + gap), control_y)
		button.size = Vector2(button_width, 48.0)

	var result_size := Vector2(
		minf(280.0, viewport_size.x - 48.0),
		205.0,
	)
	_result_panel.size = result_size
	_result_panel.position = board_view.position + (
		board_view.size - result_size
	) / 2.0
	var home_size := Vector2(
		minf(292.0, viewport_size.x - 40.0),
		315.0,
	)
	_home_panel.size = home_size
	_home_panel.position = board_view.position + (
		board_view.size - home_size
	) / 2.0
	var settings_size := Vector2(
		minf(300.0, viewport_size.x - 40.0),
		350.0,
	)
	_settings_panel.size = settings_size
	_settings_panel.position = board_view.position + (
		board_view.size - settings_size
	) / 2.0


func _start_round(mode: StringName) -> void:
	_stop_manual_raise()
	_clear_recovery()
	_mode = mode
	var seed := "godot-%s-%d" % [String(mode), Time.get_ticks_usec()]
	var time_limit_ms := (
		Config.TIME_TRIAL_DURATION_MS
		if mode == MODE_TIME_TRIAL
		else -1
	)
	state = Simulation.create_simulation(seed, null, time_limit_ms)
	_cursor = Vector2i(0, 0)
	board_view.set_simulation_state(state)
	board_view.clear_selection()
	board_view.set_cursor_position(0, 0, false)
	_home_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_round_active = true
	_result_reported = false
	_last_clear_at = -1
	_last_recovery_step = state.step
	_title_label.text = (
		"TIME TRIAL" if _mode == MODE_TIME_TRIAL else "ENDLESS"
	)
	_pause_button.text = "Pause"
	_update_hud()


func _restart_current_round() -> void:
	_start_round(_mode)


func _show_home() -> void:
	_stop_manual_raise()
	_round_active = false
	_clear_recovery()
	_mode = MODE_ENDLESS
	state = Simulation.create_simulation(
		"godot-menu-%d" % Time.get_ticks_usec(),
	)
	Simulation.set_paused(state, true)
	board_view.set_simulation_state(state)
	board_view.clear_selection()
	board_view.set_cursor_position(0, 0, false)
	_title_label.text = "SWAPDUEL"
	_score_label.text = ""
	_detail_label.text = "Match panels. Build chains. Stay alive."
	_home_best_label.text = "Best endless %d  ·  Best trial %d" % [
		_best_endless,
		_best_time_trial,
	]
	_update_sound_button()
	_update_settings_buttons()
	_home_panel.visible = true
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_button.disabled = true
	_raise_button.disabled = true
	_pause_button.text = "Pause"


func _request_swap(row: int, column: int, direction: int) -> void:
	if state == null:
		return
	var result = Simulation.request_swap(state, row, column, direction)
	if result.ok:
		var audio = _audio()
		if audio != null:
			audio.play_swap()
		board_view.clear_selection()
		board_view.queue_redraw()


func _toggle_pause() -> void:
	if state == null or state.status == &"lost":
		return
	var pause: bool = state.status == &"playing"
	Simulation.set_paused(state, pause)
	_stop_manual_raise()
	_pause_button.text = "Resume" if pause else "Pause"
	_update_hud()
	if pause:
		_save_recovery()


func _begin_raise_hold() -> void:
	if state == null or state.status != &"playing":
		return
	_raise_held = true
	_raise_timer.start()


func _activate_manual_raise() -> void:
	if _raise_held and state != null:
		Simulation.set_manual_raise(state, true)


func _stop_manual_raise() -> void:
	_raise_held = false
	if _raise_timer != null:
		_raise_timer.stop()
	if state != null:
		Simulation.set_manual_raise(state, false)


func _update_hud() -> void:
	if state == null:
		return
	_hud_step = state.step
	_score_label.text = "%d" % state.score
	var chain_level: int = 1 if state.chain == null else state.chain.level
	if _mode == MODE_TIME_TRIAL and state.time_limit >= 0:
		var remaining := maxi(0, state.time_limit - state.elapsed_clock)
		_detail_label.text = "%s left · %d panels · Chain ×%d" % [
			_format_remaining(remaining),
			state.total_cleared,
			chain_level,
		]
		_score_label.add_theme_color_override(
			"font_color",
			Color("#f0606c") if remaining <= 30_000 else Color("#ed6a45"),
		)
	else:
		_detail_label.text = "%s · %d panels · Chain ×%d" % [
			_format_elapsed(state.elapsed_clock),
			state.total_cleared,
			chain_level,
		]
		_score_label.add_theme_color_override("font_color", Color("#ed6a45"))
	if state.status == &"paused":
		_detail_label.text += " · Paused"
	if state.danger_remaining >= 0:
		_detail_label.text += " · DANGER"
	if state.status == &"lost":
		_pause_button.disabled = true
		_raise_button.disabled = true
	else:
		_pause_button.disabled = false
		_raise_button.disabled = state.danger_remaining >= 0


func _finish_round() -> void:
	if _result_reported:
		return
	_result_reported = true
	_round_active = false
	_clear_recovery()
	_stop_manual_raise()
	var previous_best: int = (
		_best_time_trial if _mode == MODE_TIME_TRIAL else _best_endless
	)
	var is_new_best: bool = state.score > previous_best
	if is_new_best:
		if _mode == MODE_TIME_TRIAL:
			_best_time_trial = state.score
		else:
			_best_endless = state.score
		_save_progress()

	var ending := (
		"Time's up"
		if state.end_reason == &"time-up"
		else "Stack topped out"
	)
	var record := "\nNew local best!" if is_new_best else ""
	_result_label.text = "%s\n%d points%s" % [ending, state.score, record]
	_result_panel.visible = true
	var audio = _audio()
	if audio != null:
		audio.play_result(is_new_best)


func _play_step_feedback(falling_before: Array[int]) -> void:
	var clear = state.last_clear_event
	var audio = _audio()
	var settings = _settings()
	if clear != null and clear.occurred_at > _last_clear_at:
		_last_clear_at = clear.occurred_at
		if audio != null:
			audio.play_clear(clear.normal_size, clear.chain_level)
		if settings != null:
			settings.vibrate(70 if clear.chain_level > 1 else 35)
	if audio != null and state.danger_remaining >= 0:
		audio.play_danger()
	for block_id in falling_before:
		for block in state.garbage:
			if block.id == block_id and block.state == &"idle":
				if audio != null:
					audio.play_garbage_landed()
				if settings != null:
					settings.vibrate(55)
				return


func _toggle_sound() -> void:
	var audio = _audio()
	if audio != null:
		audio.toggle_sound()
	_update_sound_button()


func _show_settings() -> void:
	_home_panel.visible = false
	_result_panel.visible = false
	_settings_panel.visible = true
	_update_sound_button()
	_update_settings_buttons()


func _hide_settings() -> void:
	_settings_panel.visible = false
	_home_panel.visible = true


func _toggle_reduced_motion() -> void:
	var settings = _settings()
	if settings != null:
		settings.toggle_reduced_motion()
	_update_settings_buttons()


func _toggle_battery_saver() -> void:
	var settings = _settings()
	if settings != null:
		settings.toggle_battery_saver()
	_update_settings_buttons()


func _toggle_haptics() -> void:
	var settings = _settings()
	if settings != null:
		settings.toggle_haptics()
	_update_settings_buttons()


func _apply_settings() -> void:
	var settings = _settings()
	if board_view != null:
		board_view.set_reduced_motion(
			false if settings == null else bool(settings.reduced_motion),
		)
	_update_settings_buttons()


func _update_settings_buttons() -> void:
	if (
		_motion_button == null
		or _battery_button == null
		or _haptics_button == null
	):
		return
	var settings = _settings()
	var reduced := false if settings == null else bool(settings.reduced_motion)
	var battery := false if settings == null else bool(settings.battery_saver)
	var haptics := true if settings == null else bool(settings.haptics_enabled)
	_motion_button.text = (
		"Motion: Reduced" if reduced else "Motion: Full"
	)
	_battery_button.text = (
		"Battery saver: On" if battery else "Battery saver: Off"
	)
	_haptics_button.text = "Haptics: On" if haptics else "Haptics: Off"


func _update_sound_button() -> void:
	if _sound_button == null:
		return
	var audio = _audio()
	var enabled := true if audio == null else bool(audio.sound_enabled)
	_sound_button.text = "Sound: On" if enabled else "Sound: Off"


func _audio():
	if not is_inside_tree():
		return null
	return get_tree().root.get_node_or_null("Audio")


func _settings():
	if not is_inside_tree():
		return null
	return get_tree().root.get_node_or_null("GameSettings")


func _format_elapsed(clock_units: int) -> String:
	var total_seconds := floori(
		float(clock_units)
		/ (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0),
	)
	return "%d:%02d" % [total_seconds / 60, total_seconds % 60]


func _format_remaining(clock_units: int) -> String:
	if clock_units < 10_000 * Config.CLOCK_UNITS_PER_MILLISECOND:
		return "%.1f" % (
			float(clock_units)
			/ (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0)
		)
	var total_seconds := ceili(
		float(clock_units)
		/ (Config.CLOCK_UNITS_PER_MILLISECOND * 1000.0),
	)
	return "%d:%02d" % [total_seconds / 60, total_seconds % 60]


func _load_progress() -> void:
	if _progress.load(PROGRESS_PATH) != OK:
		return
	_best_endless = maxi(
		0,
		int(_progress.get_value("scores", "endless", 0)),
	)
	_best_time_trial = maxi(
		0,
		int(_progress.get_value("scores", "time_trial", 0)),
	)


func _save_progress() -> void:
	_progress.set_value("scores", "endless", _best_endless)
	_progress.set_value("scores", "time_trial", _best_time_trial)
	_progress.save(PROGRESS_PATH)


func _try_restore_round() -> bool:
	if not recovery_enabled or not FileAccess.file_exists(RECOVERY_PATH):
		return false
	var serialized := FileAccess.get_file_as_string(RECOVERY_PATH)
	var recovered := _decode_recovery_snapshot(serialized, _now_ms())
	if recovered.is_empty():
		_clear_recovery()
		return false

	state = recovered["state"]
	_mode = recovered["mode"]
	Simulation.set_paused(state, true)
	board_view.set_simulation_state(state)
	board_view.clear_selection()
	board_view.set_cursor_position(0, 0, false)
	_home_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_round_active = true
	_result_reported = false
	_last_clear_at = (
		-1
		if state.last_clear_event == null
		else state.last_clear_event.occurred_at
	)
	_last_recovery_step = state.step
	_title_label.text = (
		"TIME TRIAL" if _mode == MODE_TIME_TRIAL else "ENDLESS"
	)
	_pause_button.text = "Resume"
	_update_hud()
	_detail_label.text += " · Recovered run"
	return true


func _save_recovery() -> void:
	if (
		not recovery_enabled
		or not _round_active
		or state == null
		or state.status == &"lost"
	):
		return
	var serialized := _encode_recovery_snapshot(_now_ms())
	if serialized.is_empty():
		return
	var file := FileAccess.open(RECOVERY_PATH, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(serialized)
	_last_recovery_step = state.step


func _clear_recovery() -> void:
	if not recovery_enabled or not FileAccess.file_exists(RECOVERY_PATH):
		return
	DirAccess.remove_absolute(
		ProjectSettings.globalize_path(RECOVERY_PATH),
	)
	_last_recovery_step = -1


func _encode_recovery_snapshot(saved_at_ms: int) -> String:
	if state == null or _mode not in [MODE_ENDLESS, MODE_TIME_TRIAL]:
		return ""
	var serialized := Recovery.serialize_simulation_snapshot(
		state,
		RECOVERY_SCOPE,
		saved_at_ms,
	)
	var root = JSON.parse_string(serialized)
	if not root is Dictionary:
		return ""
	root["mode"] = String(_mode)
	return JSON.stringify(root, "", true, true)


func _decode_recovery_snapshot(
	serialized: String,
	now_ms: int,
) -> Dictionary:
	var root = JSON.parse_string(serialized)
	if not root is Dictionary:
		return {}
	var mode := StringName(String(root.get("mode", "")))
	if mode not in [MODE_ENDLESS, MODE_TIME_TRIAL]:
		return {}
	var seed = root.get("seed")
	if not seed is String or seed.is_empty():
		return {}
	var restored = Recovery.restore_simulation_snapshot(
		serialized,
		RECOVERY_SCOPE,
		seed,
		now_ms,
		RECOVERY_MAX_AGE_MS,
	)
	if restored == null or restored.status == &"lost":
		return {}
	return {
		"mode": mode,
		"state": restored,
	}


func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


func _make_overlay_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(1.0, 0.98, 0.95, 0.96)
	style.border_color = Color("#ff9a6e")
	style.set_border_width_all(3)
	style.set_corner_radius_all(22)
	style.content_margin_left = 24
	style.content_margin_right = 24
	style.content_margin_top = 22
	style.content_margin_bottom = 22
	return style


func _make_button(text: String) -> Button:
	var button := Button.new()
	button.text = text
	button.add_theme_font_size_override("font_size", 14)
	button.add_theme_color_override("font_color", Color("#6d4033"))
	button.add_theme_color_override("font_hover_color", Color("#6d4033"))
	button.add_theme_color_override("font_pressed_color", Color.WHITE)
	var normal := StyleBoxFlat.new()
	normal.bg_color = Color("#ffe3d1")
	normal.set_corner_radius_all(14)
	normal.content_margin_left = 8
	normal.content_margin_right = 8
	var hover: StyleBoxFlat = normal.duplicate()
	hover.bg_color = Color("#ffd1b9")
	var pressed: StyleBoxFlat = normal.duplicate()
	pressed.bg_color = Color("#ed6a45")
	button.add_theme_stylebox_override("normal", normal)
	button.add_theme_stylebox_override("hover", hover)
	button.add_theme_stylebox_override("pressed", pressed)
	return button
