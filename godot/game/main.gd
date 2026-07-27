extends Control

const Simulation = preload("res://game/engine/simulation.gd")
const BoardView = preload("res://game/presentation/board_view.gd")
const Config = preload("res://game/engine/config.gd")
const Recovery = preload("res://game/engine/recovery.gd")
const UiTheme = preload("res://game/presentation/ui_theme.gd")
const Backdrop = preload("res://game/presentation/backdrop.gd")

const MODE_ENDLESS: StringName = &"endless"
const MODE_TIME_TRIAL: StringName = &"time-trial"
const PROGRESS_PATH := "user://progress.cfg"
const RECOVERY_PATH := "user://solo-recovery.json"
const RECOVERY_SCOPE := "native:solo"
const RECOVERY_INTERVAL_STEPS := 120
const RECOVERY_MAX_AGE_MS := 7 * 24 * 60 * 60 * 1000
const BOARD_FRAME_INSET := 10.0

var state
var board_view
var recovery_enabled := true

var _title_label: Label
var _score_label: Label
var _score_caption_label: Label
var _time_chip: PanelContainer
var _time_status_label: Label
var _cleared_chip: PanelContainer
var _cleared_status_label: Label
var _chain_chip: PanelContainer
var _chain_status_label: Label
var _hud_panel: PanelContainer
var _board_frame: PanelContainer
var _controls_panel: PanelContainer
var _control_row: HBoxContainer
var _pause_button: Button
var _raise_button: Button
var _restart_button: Button
var _home_panel: PanelContainer
var _home_best_label: Label
var _help_panel: PanelContainer
var _settings_panel: PanelContainer
var _sound_button: Button
var _motion_button: Button
var _battery_button: Button
var _haptics_button: Button
var _result_panel: PanelContainer
var _result_kicker_label: Label
var _result_label: Label
var _result_retry_button: Button
var _pause_panel: PanelContainer
var _pause_resume_button: Button
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
var _overlay_tween: Tween
var _button_tweens: Dictionary = {}
var _hud_danger := false


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
	board_view.observe_simulation_step()
	_play_step_feedback(falling_before)
	if state.step - _last_recovery_step >= RECOVERY_INTERVAL_STEPS:
		_save_recovery()
	if state.step - _hud_step >= 6 or state.status == &"lost":
		_update_hud()
	if state.status == &"lost":
		_finish_round()


func _unhandled_input(event: InputEvent) -> void:
	if not event is InputEventKey:
		return
	var key: Key = event.keycode
	if event.pressed and not event.echo and key == KEY_ESCAPE:
		var navigated := true
		if _help_panel.visible:
			_hide_help()
		elif _settings_panel.visible:
			_hide_settings()
		elif _pause_panel.visible:
			_toggle_pause()
		elif _result_panel.visible:
			_show_home()
		elif state != null and state.status == &"playing":
			_toggle_pause()
		else:
			navigated = false
		if navigated:
			get_viewport().set_input_as_handled()
		return
	if state == null:
		return
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
			_pause_button.text = "RESUME"
			_reveal_panel(_pause_panel)
			_update_hud()
			_save_recovery()


func _exit_tree() -> void:
	_save_recovery()


func _build_interface() -> void:
	theme = UiTheme.create()

	var background = Backdrop.new()
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(background)

	_hud_panel = PanelContainer.new()
	_hud_panel.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			Color(1.0, 1.0, 1.0, 0.92),
			22,
			Color(1.0, 1.0, 1.0, 0.76),
			1,
			7,
		),
	)
	add_child(_hud_panel)

	_title_label = Label.new()
	_title_label.text = "ENDLESS"
	_title_label.add_theme_font_override("font", UiTheme.display_font(700))
	_title_label.add_theme_font_size_override("font_size", 18)
	_title_label.add_theme_color_override("font_color", UiTheme.INK)
	add_child(_title_label)

	_score_caption_label = Label.new()
	_score_caption_label.text = "SCORE"
	_score_caption_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_score_caption_label.add_theme_font_override(
		"font",
		UiTheme.body_font(800),
	)
	_score_caption_label.add_theme_font_size_override("font_size", 9)
	_score_caption_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	add_child(_score_caption_label)

	_score_label = Label.new()
	_score_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_score_label.add_theme_font_override("font", UiTheme.display_font(700))
	_score_label.add_theme_font_size_override("font_size", 25)
	_score_label.add_theme_color_override("font_color", UiTheme.CORAL_DEEP)
	add_child(_score_label)

	_time_chip = _make_status_chip()
	_time_status_label = _time_chip.get_child(0) as Label
	add_child(_time_chip)
	_cleared_chip = _make_status_chip()
	_cleared_status_label = _cleared_chip.get_child(0) as Label
	add_child(_cleared_chip)
	_chain_chip = _make_status_chip()
	_chain_status_label = _chain_chip.get_child(0) as Label
	add_child(_chain_chip)

	_board_frame = PanelContainer.new()
	_board_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_board_frame.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			UiTheme.WHITE,
			26,
			UiTheme.PEACH_DEEP,
			2,
			7,
		),
	)
	add_child(_board_frame)

	board_view = BoardView.new()
	board_view.swap_requested.connect(_request_swap)
	add_child(board_view)

	_controls_panel = PanelContainer.new()
	var controls_style := UiTheme.panel_style(
		Color(1.0, 1.0, 1.0, 0.94),
		30,
		Color(1.0, 1.0, 1.0, 0.8),
		1,
		6,
	)
	controls_style.content_margin_left = 8
	controls_style.content_margin_right = 8
	controls_style.content_margin_top = 8
	controls_style.content_margin_bottom = 8
	_controls_panel.add_theme_stylebox_override("panel", controls_style)
	add_child(_controls_panel)

	_control_row = HBoxContainer.new()
	_control_row.add_theme_constant_override("separation", 10)
	_controls_panel.add_child(_control_row)

	_pause_button = _make_button("PAUSE", &"ghost", false, true)
	_pause_button.custom_minimum_size.x = 72.0
	_pause_button.pressed.connect(_toggle_pause)
	_control_row.add_child(_pause_button)

	_raise_button = _make_button(
		"HOLD TO RAISE",
		&"primary",
		false,
		true,
	)
	_raise_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_raise_button.button_down.connect(_begin_raise_hold)
	_raise_button.button_up.connect(_stop_manual_raise)
	_raise_button.mouse_exited.connect(_stop_manual_raise)
	_control_row.add_child(_raise_button)

	_restart_button = _make_button("MODES", &"ghost", false, true)
	_restart_button.custom_minimum_size.x = 72.0
	_restart_button.pressed.connect(_show_home)
	_control_row.add_child(_restart_button)

	_raise_timer = Timer.new()
	_raise_timer.one_shot = true
	_raise_timer.wait_time = 0.08
	_raise_timer.timeout.connect(_activate_manual_raise)
	add_child(_raise_timer)

	_home_panel = PanelContainer.new()
	_home_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	add_child(_home_panel)
	var home_box := VBoxContainer.new()
	home_box.alignment = BoxContainer.ALIGNMENT_CENTER
	home_box.add_theme_constant_override("separation", 12)
	_home_panel.add_child(home_box)
	var home_eyebrow := Label.new()
	home_eyebrow.text = "NATIVE PUZZLE DUEL"
	home_eyebrow.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	home_eyebrow.add_theme_font_override("font", UiTheme.body_font(900))
	home_eyebrow.add_theme_font_size_override("font_size", 10)
	home_eyebrow.add_theme_color_override("font_color", UiTheme.INK_FAINT)
	home_box.add_child(home_eyebrow)
	var home_title := Label.new()
	home_title.text = "SWAPDUEL"
	home_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	home_title.add_theme_font_override("font", UiTheme.display_font(700))
	home_title.add_theme_font_size_override("font_size", 42)
	home_title.add_theme_color_override("font_color", UiTheme.CORAL)
	home_title.add_theme_color_override(
		"font_shadow_color",
		Color(0.72, 0.35, 0.2, 0.2),
	)
	home_title.add_theme_constant_override("shadow_offset_y", 4)
	home_title.add_theme_constant_override("shadow_outline_size", 2)
	home_box.add_child(home_title)
	var home_note := Label.new()
	home_note.text = "Match fast. Chain smart.\nKeep the stack alive."
	home_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	home_note.add_theme_font_override("font", UiTheme.body_font(700))
	home_note.add_theme_font_size_override("font_size", 14)
	home_note.add_theme_color_override("font_color", UiTheme.INK_SOFT)
	home_box.add_child(home_note)
	var endless_button := _make_button("PLAY ENDLESS", &"primary")
	endless_button.pressed.connect(_start_round.bind(MODE_ENDLESS))
	home_box.add_child(endless_button)
	var trial_button := _make_button("TWO-MINUTE TRIAL")
	trial_button.pressed.connect(_start_round.bind(MODE_TIME_TRIAL))
	home_box.add_child(trial_button)
	var help_button := _make_button("HOW TO PLAY", &"ghost")
	help_button.pressed.connect(_show_help)
	home_box.add_child(help_button)
	var settings_button := _make_button("SETTINGS", &"ghost")
	settings_button.pressed.connect(_show_settings)
	home_box.add_child(settings_button)
	_home_best_label = Label.new()
	_home_best_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_home_best_label.add_theme_font_override("font", UiTheme.body_font(800))
	_home_best_label.add_theme_font_size_override("font_size", 11)
	_home_best_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	home_box.add_child(_home_best_label)

	_help_panel = PanelContainer.new()
	_help_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	_help_panel.visible = false
	add_child(_help_panel)
	var help_box := VBoxContainer.new()
	help_box.alignment = BoxContainer.ALIGNMENT_CENTER
	help_box.add_theme_constant_override("separation", 10)
	_help_panel.add_child(help_box)
	var help_eyebrow := Label.new()
	help_eyebrow.text = "THE QUICK VERSION"
	help_eyebrow.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help_eyebrow.add_theme_font_override("font", UiTheme.body_font(900))
	help_eyebrow.add_theme_font_size_override("font_size", 10)
	help_eyebrow.add_theme_color_override("font_color", UiTheme.CORAL_DARK)
	help_box.add_child(help_eyebrow)
	var help_title := Label.new()
	help_title.text = "HOW TO PLAY"
	help_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help_title.add_theme_font_override("font", UiTheme.display_font(700))
	help_title.add_theme_font_size_override("font_size", 30)
	help_title.add_theme_color_override("font_color", UiTheme.INK)
	help_box.add_child(help_title)
	var help_note := Label.new()
	help_note.text = "Match before the stack reaches the top."
	help_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	help_note.add_theme_font_size_override("font_size", 12)
	help_note.add_theme_color_override("font_color", UiTheme.INK_SOFT)
	help_box.add_child(help_note)
	_add_help_step(
		help_box,
		"1",
		"SWAP",
		"Tap neighbors or swipe sideways.",
	)
	_add_help_step(
		help_box,
		"2",
		"MATCH",
		"Line up 3 or more matching panels.",
	)
	_add_help_step(
		help_box,
		"3",
		"CHAIN",
		"Falling panels can trigger\nanother match for a chain.",
	)
	_add_help_step(
		help_box,
		"4",
		"RAISE",
		"Hold raise to move faster.\nA red board means danger.",
	)
	var help_done := _make_button("GOT IT", &"primary")
	help_done.pressed.connect(_hide_help)
	help_box.add_child(help_done)

	_settings_panel = PanelContainer.new()
	_settings_panel.add_theme_stylebox_override(
		"panel",
		_make_overlay_style(),
	)
	_settings_panel.visible = false
	add_child(_settings_panel)
	var settings_box := VBoxContainer.new()
	settings_box.alignment = BoxContainer.ALIGNMENT_CENTER
	settings_box.add_theme_constant_override("separation", 11)
	_settings_panel.add_child(settings_box)
	var settings_eyebrow := Label.new()
	settings_eyebrow.text = "MAKE IT YOURS"
	settings_eyebrow.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	settings_eyebrow.add_theme_font_override("font", UiTheme.body_font(900))
	settings_eyebrow.add_theme_font_size_override("font_size", 10)
	settings_eyebrow.add_theme_color_override(
		"font_color",
		UiTheme.INK_FAINT,
	)
	settings_box.add_child(settings_eyebrow)
	var settings_title := Label.new()
	settings_title.text = "SETTINGS"
	settings_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	settings_title.add_theme_font_override("font", UiTheme.display_font(700))
	settings_title.add_theme_font_size_override("font_size", 30)
	settings_title.add_theme_color_override("font_color", UiTheme.INK)
	settings_box.add_child(settings_title)
	var settings_note := Label.new()
	settings_note.text = "Tune comfort and device feedback."
	settings_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	settings_note.add_theme_font_size_override("font_size", 12)
	settings_note.add_theme_color_override("font_color", UiTheme.INK_SOFT)
	settings_box.add_child(settings_note)
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
	var settings_done := _make_button("DONE", &"primary")
	settings_done.pressed.connect(_hide_settings)
	settings_box.add_child(settings_done)

	_result_panel = PanelContainer.new()
	_result_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	_result_panel.visible = false
	add_child(_result_panel)

	var result_box := VBoxContainer.new()
	result_box.alignment = BoxContainer.ALIGNMENT_CENTER
	result_box.add_theme_constant_override("separation", 12)
	_result_panel.add_child(result_box)
	_result_kicker_label = Label.new()
	_result_kicker_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_result_kicker_label.add_theme_font_override("font", UiTheme.body_font(900))
	_result_kicker_label.add_theme_font_size_override("font_size", 10)
	_result_kicker_label.add_theme_color_override(
		"font_color",
		UiTheme.CORAL_DARK,
	)
	result_box.add_child(_result_kicker_label)
	_result_label = Label.new()
	_result_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_result_label.add_theme_font_override("font", UiTheme.display_font(700))
	_result_label.add_theme_font_size_override("font_size", 28)
	_result_label.add_theme_color_override("font_color", UiTheme.INK)
	result_box.add_child(_result_label)
	_result_retry_button = _make_button("PLAY AGAIN", &"primary")
	_result_retry_button.pressed.connect(_restart_current_round)
	result_box.add_child(_result_retry_button)
	var modes := _make_button("CHOOSE MODE", &"ghost")
	modes.pressed.connect(_show_home)
	result_box.add_child(modes)

	_pause_panel = PanelContainer.new()
	_pause_panel.add_theme_stylebox_override("panel", _make_overlay_style())
	_pause_panel.visible = false
	add_child(_pause_panel)
	var pause_box := VBoxContainer.new()
	pause_box.alignment = BoxContainer.ALIGNMENT_CENTER
	pause_box.add_theme_constant_override("separation", 12)
	_pause_panel.add_child(pause_box)
	var pause_eyebrow := Label.new()
	pause_eyebrow.text = "RUN SAVED"
	pause_eyebrow.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pause_eyebrow.add_theme_font_override("font", UiTheme.body_font(900))
	pause_eyebrow.add_theme_font_size_override("font_size", 10)
	pause_eyebrow.add_theme_color_override(
		"font_color",
		UiTheme.CORAL_DARK,
	)
	pause_box.add_child(pause_eyebrow)
	var pause_title := Label.new()
	pause_title.text = "PAUSED"
	pause_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pause_title.add_theme_font_override("font", UiTheme.display_font(700))
	pause_title.add_theme_font_size_override("font_size", 34)
	pause_title.add_theme_color_override("font_color", UiTheme.INK)
	pause_box.add_child(pause_title)
	var pause_note := Label.new()
	pause_note.text = "Take a breath. The board will wait."
	pause_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pause_note.add_theme_font_size_override("font_size", 12)
	pause_note.add_theme_color_override("font_color", UiTheme.INK_SOFT)
	pause_box.add_child(pause_note)
	_pause_resume_button = _make_button("RESUME RUN", &"primary")
	_pause_resume_button.pressed.connect(_toggle_pause)
	pause_box.add_child(_pause_resume_button)


func _layout_interface() -> void:
	if board_view == null:
		return
	var viewport_size := size
	var safe := _safe_insets(viewport_size)
	var margin := 12.0
	var left := maxf(margin, safe.x + margin)
	var right := maxf(margin, safe.z + margin)
	var top := maxf(margin, safe.y + 8.0)
	var bottom := viewport_size.y - maxf(margin, safe.w + 10.0)

	var hud_height := 78.0
	_hud_panel.position = Vector2(left, top)
	_hud_panel.size = Vector2(viewport_size.x - left - right, hud_height)
	_title_label.position = _hud_panel.position + Vector2(14.0, 7.0)
	_title_label.size = Vector2(_hud_panel.size.x * 0.61, 28.0)
	_score_caption_label.position = Vector2(
		_hud_panel.position.x + _hud_panel.size.x - 112.0,
		_hud_panel.position.y + 4.0,
	)
	_score_caption_label.size = Vector2(96.0, 14.0)
	_score_label.position = Vector2(
		_hud_panel.position.x + _hud_panel.size.x - 132.0,
		_hud_panel.position.y + 15.0,
	)
	_score_label.size = Vector2(116.0, 36.0)
	var chip_padding := 12.0
	var chip_gap := 6.0
	var chip_width := (
		_hud_panel.size.x - chip_padding * 2.0 - chip_gap * 2.0
	) / 3.0
	var chip_y := _hud_panel.position.y + 45.0
	for index in 3:
		var chip: PanelContainer = [
			_time_chip,
			_cleared_chip,
			_chain_chip,
		][index]
		chip.position = Vector2(
			_hud_panel.position.x
				+ chip_padding
				+ index * (chip_width + chip_gap),
			chip_y,
		)
		chip.size = Vector2(chip_width, 24.0)

	var controls_height := 70.0
	var control_y := bottom - controls_height
	_controls_panel.position = Vector2(left, control_y)
	_controls_panel.size = Vector2(
		viewport_size.x - left - right,
		controls_height,
	)

	var board_top := _hud_panel.position.y + hud_height + 12.0
	var board_available_height := maxf(
		120.0,
		control_y - board_top - 12.0,
	)
	var board_width := minf(
		viewport_size.x - left - right - 18.0,
		board_available_height / 2.0,
	)
	board_view.size = Vector2(board_width, board_width * 2.0)
	board_view.position = Vector2(
		(viewport_size.x - board_width) / 2.0,
		board_top,
	)
	_board_frame.position = (
		board_view.position - Vector2.ONE * BOARD_FRAME_INSET
	)
	_board_frame.size = (
		board_view.size + Vector2.ONE * BOARD_FRAME_INSET * 2.0
	)

	var result_size := Vector2(
		minf(300.0, viewport_size.x - left - right - 8.0),
		270.0,
	)
	_result_panel.size = result_size
	_result_panel.position = Vector2(
		(viewport_size.x - result_size.x) / 2.0,
		top + (bottom - top - result_size.y) / 2.0,
	)
	var home_size := Vector2(
		minf(334.0, viewport_size.x - left - right),
		minf(480.0, bottom - top - 16.0),
	)
	_home_panel.size = home_size
	_home_panel.position = Vector2(
		(viewport_size.x - home_size.x) / 2.0,
		top + (bottom - top - home_size.y) / 2.0,
	)
	var help_size := Vector2(
		minf(334.0, viewport_size.x - left - right),
		minf(520.0, bottom - top - 16.0),
	)
	_help_panel.size = help_size
	_help_panel.position = Vector2(
		(viewport_size.x - help_size.x) / 2.0,
		top + (bottom - top - help_size.y) / 2.0,
	)
	var settings_size := Vector2(
		minf(334.0, viewport_size.x - left - right),
		minf(450.0, bottom - top - 16.0),
	)
	_settings_panel.size = settings_size
	_settings_panel.position = Vector2(
		(viewport_size.x - settings_size.x) / 2.0,
		top + (bottom - top - settings_size.y) / 2.0,
	)
	var pause_size := Vector2(
		minf(300.0, viewport_size.x - left - right - 8.0),
		245.0,
	)
	_pause_panel.size = pause_size
	_pause_panel.position = Vector2(
		(viewport_size.x - pause_size.x) / 2.0,
		top + (bottom - top - pause_size.y) / 2.0,
	)


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
	_help_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	_set_game_chrome_visible(true, true)
	_round_active = true
	_result_reported = false
	_last_clear_at = -1
	_last_recovery_step = state.step
	_title_label.text = (
		"TIME TRIAL" if _mode == MODE_TIME_TRIAL else "ENDLESS"
	)
	_pause_button.text = "PAUSE"
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
	_home_best_label.text = "LOCAL BESTS  ·  ENDLESS %d  ·  TRIAL %d" % [
		_best_endless,
		_best_time_trial,
	]
	_update_sound_button()
	_update_settings_buttons()
	_reveal_panel(_home_panel)
	_help_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	_set_game_chrome_visible(false, false)
	_pause_button.disabled = true
	_raise_button.disabled = true
	_pause_button.text = "PAUSE"


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
	_pause_button.text = "RESUME" if pause else "PAUSE"
	if pause:
		_reveal_panel(_pause_panel)
	else:
		_pause_panel.visible = false
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
	var mode_title := (
		"TIME TRIAL" if _mode == MODE_TIME_TRIAL else "ENDLESS"
	)
	var danger: bool = state.danger_remaining >= 0
	_title_label.text = (
		"%s  •  DANGER" % mode_title
		if danger
		else mode_title
	)
	_set_hud_danger(danger)
	if _mode == MODE_TIME_TRIAL and state.time_limit >= 0:
		var remaining := maxi(0, state.time_limit - state.elapsed_clock)
		var final_stretch := (
			remaining
			<= 30_000 * Config.CLOCK_UNITS_PER_MILLISECOND
		)
		_time_status_label.text = "LEFT  %s" % _format_remaining(remaining)
		_score_label.add_theme_color_override(
			"font_color",
			UiTheme.DANGER
				if final_stretch
				else UiTheme.CORAL_DEEP,
		)
		_style_status_chip(_time_chip, final_stretch)
	else:
		_time_status_label.text = "TIME  %s" % _format_elapsed(
			state.elapsed_clock,
		)
		_score_label.add_theme_color_override(
			"font_color",
			UiTheme.CORAL_DEEP,
		)
		_style_status_chip(_time_chip, false)
	_cleared_status_label.text = "CLEARED  %d" % state.total_cleared
	_chain_status_label.text = "CHAIN  ×%d" % chain_level
	_style_status_chip(_chain_chip, chain_level > 1, &"chain")
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
	_result_kicker_label.text = (
		"NEW LOCAL BEST"
		if is_new_best
		else ending.to_upper()
	)
	_result_label.text = "%d\nPOINTS" % state.score
	_pause_panel.visible = false
	_set_game_chrome_visible(true, false)
	_reveal_panel(_result_panel)
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
	_help_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	_reveal_panel(_settings_panel)
	_set_game_chrome_visible(false, false)
	_update_sound_button()
	_update_settings_buttons()


func _hide_settings() -> void:
	_settings_panel.visible = false
	_reveal_panel(_home_panel)
	_set_game_chrome_visible(false, false)


func _show_help() -> void:
	_home_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	_reveal_panel(_help_panel)
	_set_game_chrome_visible(false, false)


func _hide_help() -> void:
	_help_panel.visible = false
	_reveal_panel(_home_panel)
	_set_game_chrome_visible(false, false)


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
	if settings != null and bool(settings.reduced_motion):
		_reset_interface_motion()
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
		"REDUCED MOTION  •  ON" if reduced else "REDUCED MOTION  •  OFF"
	)
	_battery_button.text = (
		"BATTERY SAVER  •  ON" if battery else "BATTERY SAVER  •  OFF"
	)
	_haptics_button.text = (
		"HAPTICS  •  ON" if haptics else "HAPTICS  •  OFF"
	)
	_style_setting_button(_motion_button, reduced)
	_style_setting_button(_battery_button, battery)
	_style_setting_button(_haptics_button, haptics)


func _update_sound_button() -> void:
	if _sound_button == null:
		return
	var audio = _audio()
	var enabled := true if audio == null else bool(audio.sound_enabled)
	_sound_button.text = "SOUND  •  ON" if enabled else "SOUND  •  OFF"
	_style_setting_button(_sound_button, enabled)


func _style_setting_button(button: Button, enabled: bool) -> void:
	var normal := UiTheme.button_style(&"secondary", &"normal")
	if enabled:
		normal.bg_color = Color("#fff0e6")
		normal.border_color = UiTheme.CORAL_SOFT
		button.add_theme_color_override("font_color", UiTheme.CORAL_DARK)
		button.add_theme_color_override("font_hover_color", UiTheme.CORAL_DARK)
	else:
		button.add_theme_color_override("font_color", UiTheme.INK)
		button.add_theme_color_override("font_hover_color", UiTheme.INK)
	button.add_theme_stylebox_override("normal", normal)


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
	_help_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_reveal_panel(_pause_panel)
	_set_game_chrome_visible(true, true)
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
	_pause_button.text = "RESUME"
	_update_hud()
	_title_label.text += "  •  RECOVERED"
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


func _safe_insets(viewport_size: Vector2) -> Vector4:
	if not (
		OS.has_feature("android")
		or OS.has_feature("ios")
	):
		return Vector4.ZERO
	var window_size := Vector2(DisplayServer.window_get_size())
	var safe_area := Rect2(DisplayServer.get_display_safe_area())
	if (
		window_size.x <= 0.0
		or window_size.y <= 0.0
		or safe_area.size.x <= 0.0
		or safe_area.size.y <= 0.0
	):
		return Vector4.ZERO
	var scale := Vector2(
		viewport_size.x / window_size.x,
		viewport_size.y / window_size.y,
	)
	return Vector4(
		maxf(0.0, safe_area.position.x * scale.x),
		maxf(0.0, safe_area.position.y * scale.y),
		maxf(0.0, (window_size.x - safe_area.end.x) * scale.x),
		maxf(0.0, (window_size.y - safe_area.end.y) * scale.y),
	)


func _set_game_chrome_visible(
	hud_visible: bool,
	controls_visible: bool,
) -> void:
	_hud_panel.visible = hud_visible
	_title_label.visible = hud_visible
	_score_caption_label.visible = hud_visible
	_score_label.visible = hud_visible
	_time_chip.visible = hud_visible
	_cleared_chip.visible = hud_visible
	_chain_chip.visible = hud_visible
	_controls_panel.visible = controls_visible
	_pause_button.visible = controls_visible
	_raise_button.visible = controls_visible
	_restart_button.visible = controls_visible


func _reveal_panel(panel: Control) -> void:
	panel.visible = true
	panel.modulate = Color.WHITE
	panel.scale = Vector2.ONE
	panel.pivot_offset = panel.size / 2.0
	if _reduced_motion_enabled() or not is_inside_tree():
		return
	if _overlay_tween != null and _overlay_tween.is_valid():
		_overlay_tween.kill()
	panel.modulate = Color(1.0, 1.0, 1.0, 0.0)
	panel.scale = Vector2(0.94, 0.94)
	_overlay_tween = create_tween().set_parallel(true)
	_overlay_tween.tween_property(
		panel,
		"modulate",
		Color.WHITE,
		0.16,
	).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	_overlay_tween.tween_property(
		panel,
		"scale",
		Vector2.ONE,
		0.28,
	).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)


func _animate_button(button: Button, pressed: bool) -> void:
	button.pivot_offset = button.size / 2.0
	if _reduced_motion_enabled() or not is_inside_tree():
		button.scale = Vector2.ONE
		return
	var previous = _button_tweens.get(button)
	if previous != null and previous.is_valid():
		previous.kill()
	var target := Vector2(0.965, 0.965) if pressed else Vector2.ONE
	var tween := create_tween()
	tween.tween_property(
		button,
		"scale",
		target,
		0.055 if pressed else 0.13,
	).set_trans(Tween.TRANS_QUAD).set_ease(
		Tween.EASE_OUT if pressed else Tween.EASE_OUT,
	)
	_button_tweens[button] = tween


func _reduced_motion_enabled() -> bool:
	var settings = _settings()
	return settings != null and bool(settings.reduced_motion)


func _reset_interface_motion() -> void:
	if _overlay_tween != null and _overlay_tween.is_valid():
		_overlay_tween.kill()
	for button in _button_tweens.keys():
		if is_instance_valid(button):
			button.scale = Vector2.ONE
	for tween in _button_tweens.values():
		if tween != null and tween.is_valid():
			tween.kill()
	_button_tweens.clear()
	for panel in [
		_home_panel,
		_help_panel,
		_settings_panel,
		_result_panel,
		_pause_panel,
	]:
		if panel != null:
			panel.modulate = Color.WHITE
			panel.scale = Vector2.ONE
	for button in [
		_pause_button,
		_raise_button,
		_restart_button,
		_sound_button,
		_motion_button,
		_battery_button,
		_haptics_button,
		_result_retry_button,
		_pause_resume_button,
	]:
		if button != null:
			button.scale = Vector2.ONE


func _make_status_chip() -> PanelContainer:
	var chip := PanelContainer.new()
	chip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chip.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			Color("#fff7f0"),
			11,
			Color("#f2ded0"),
			1,
		),
	)
	var label := Label.new()
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_override("font", UiTheme.body_font(900))
	label.add_theme_font_size_override("font_size", 9)
	label.add_theme_color_override("font_color", UiTheme.INK_SOFT)
	chip.add_child(label)
	return chip


func _style_status_chip(
	chip: PanelContainer,
	highlighted: bool,
	kind: StringName = &"danger",
) -> void:
	var color := Color("#fff7f0")
	var border := Color("#f2ded0")
	var text_color := UiTheme.INK_SOFT
	if highlighted and kind == &"chain":
		color = Color("#f2ecff")
		border = Color("#cdbcf1")
		text_color = Color("#7459ba")
	elif highlighted:
		color = Color("#fff0ef")
		border = Color("#ffb1b5")
		text_color = UiTheme.DANGER
	chip.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(color, 11, border, 1),
	)
	var label := chip.get_child(0) as Label
	label.add_theme_color_override("font_color", text_color)


func _set_hud_danger(danger: bool) -> void:
	if danger == _hud_danger:
		return
	_hud_danger = danger
	_hud_panel.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			Color("#fff0ef") if danger else Color(1.0, 1.0, 1.0, 0.92),
			22,
			Color("#ffb1b5") if danger else Color(1.0, 1.0, 1.0, 0.76),
			2 if danger else 1,
			7,
		),
	)
	_title_label.add_theme_color_override(
		"font_color",
		UiTheme.DANGER if danger else UiTheme.INK,
	)


func _add_help_step(
	parent: VBoxContainer,
	number: String,
	title: String,
	description: String,
) -> void:
	var row := HBoxContainer.new()
	row.custom_minimum_size = Vector2(0.0, 50.0)
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("separation", 11)
	parent.add_child(row)

	var badge := PanelContainer.new()
	badge.custom_minimum_size = Vector2(36.0, 36.0)
	badge.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	badge.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			UiTheme.CORAL,
			18,
			Color(1.0, 1.0, 1.0, 0.54),
			1,
			2,
		),
	)
	row.add_child(badge)
	var number_label := Label.new()
	number_label.text = number
	number_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	number_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	number_label.add_theme_font_override("font", UiTheme.display_font(700))
	number_label.add_theme_font_size_override("font_size", 16)
	number_label.add_theme_color_override("font_color", UiTheme.WHITE)
	badge.add_child(number_label)

	var copy := VBoxContainer.new()
	copy.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	copy.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	copy.add_theme_constant_override("separation", 0)
	row.add_child(copy)
	var title_label := Label.new()
	title_label.text = title
	title_label.add_theme_font_override("font", UiTheme.body_font(900))
	title_label.add_theme_font_size_override("font_size", 11)
	title_label.add_theme_color_override("font_color", UiTheme.INK)
	copy.add_child(title_label)
	var description_label := Label.new()
	description_label.text = description
	description_label.add_theme_font_size_override("font_size", 11)
	description_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	copy.add_child(description_label)


func _make_overlay_style() -> StyleBoxFlat:
	var style := UiTheme.panel_style(
		Color(1.0, 0.995, 0.98, 0.97),
		28,
		Color("#f1d9c8"),
		1,
		12,
	)
	style.content_margin_left = 28
	style.content_margin_right = 28
	style.content_margin_top = 26
	style.content_margin_bottom = 26
	return style


func _make_button(
	text: String,
	kind: StringName = &"secondary",
	animate_press: bool = true,
	compact: bool = false,
) -> Button:
	var button := Button.new()
	button.text = text
	button.custom_minimum_size = Vector2(0.0, 50.0)
	button.add_theme_font_override("font", UiTheme.display_font(600))
	button.add_theme_font_size_override("font_size", 14)
	var text_color := UiTheme.WHITE if kind == &"primary" else UiTheme.INK
	button.add_theme_color_override("font_color", text_color)
	button.add_theme_color_override("font_hover_color", text_color)
	button.add_theme_color_override(
		"font_pressed_color",
		UiTheme.WHITE if kind == &"primary" else UiTheme.CORAL_DARK,
	)
	button.add_theme_color_override(
		"font_focus_color",
		text_color,
	)
	button.add_theme_color_override(
		"font_disabled_color",
		Color(text_color, 0.42),
	)
	button.add_theme_stylebox_override(
		"normal",
		_make_button_style(kind, &"normal", compact),
	)
	button.add_theme_stylebox_override(
		"hover",
		_make_button_style(kind, &"hover", compact),
	)
	button.add_theme_stylebox_override(
		"pressed",
		_make_button_style(kind, &"pressed", compact),
	)
	button.add_theme_stylebox_override(
		"focus",
		_make_button_style(kind, &"hover", compact),
	)
	var disabled := _make_button_style(kind, &"normal", compact)
	disabled.bg_color.a *= 0.5
	disabled.border_color.a *= 0.45
	disabled.shadow_size = 0
	button.add_theme_stylebox_override("disabled", disabled)
	if animate_press:
		button.button_down.connect(_animate_button.bind(button, true))
		button.button_up.connect(_animate_button.bind(button, false))
		button.mouse_exited.connect(_animate_button.bind(button, false))
	return button


func _make_button_style(
	kind: StringName,
	state_name: StringName,
	compact: bool,
) -> StyleBoxFlat:
	var style := UiTheme.button_style(kind, state_name)
	if compact:
		style.content_margin_left = 8
		style.content_margin_right = 8
		style.content_margin_top = 8
		style.content_margin_bottom = 8
	return style
