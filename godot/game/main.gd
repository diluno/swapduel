extends Control

const Simulation = preload("res://game/engine/simulation.gd")
const Types = preload("res://game/engine/types.gd")
const Garbage = preload("res://game/engine/garbage.gd")
const BoardView = preload("res://game/presentation/board_view.gd")
const OpponentBoardView = preload(
	"res://game/presentation/opponent_board_view.gd"
)
const Config = preload("res://game/engine/config.gd")
const Recovery = preload("res://game/engine/recovery.gd")
const UiTheme = preload("res://game/presentation/ui_theme.gd")
const Backdrop = preload("res://game/presentation/backdrop.gd")

const MODE_ENDLESS: StringName = &"endless"
const MODE_TIME_TRIAL: StringName = &"time-trial"
const MODE_ONLINE: StringName = &"online"
const PROGRESS_PATH := "user://progress.cfg"
const RECOVERY_PATH := "user://solo-recovery.json"
const RECOVERY_SCOPE := "native:solo"
const ONLINE_RECOVERY_PATH := "user://online-recovery.json"
const ONLINE_RECOVERY_SCOPE_PREFIX := "native:online"
const RECOVERY_INTERVAL_STEPS := 120
const RECOVERY_MAX_AGE_MS := 7 * 24 * 60 * 60 * 1000
const ONLINE_RECOVERY_MAX_AGE_MS := 35_000
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
var _opponent_board_frame: PanelContainer
var _opponent_board_label: Label
var _opponent_board_view
var _network_panel: PanelContainer
var _network_kicker_label: Label
var _network_status_label: Label
var _network_note_label: Label
var _controls_panel: PanelContainer
var _control_row: HBoxContainer
var _pause_button: Button
var _raise_button: Button
var _restart_button: Button
var _home_panel: PanelContainer
var _home_best_label: Label
var _help_panel: PanelContainer
var _settings_panel: PanelContainer
var _online_panel: PanelContainer
var _online_form: VBoxContainer
var _online_lobby: VBoxContainer
var _online_name_input: LineEdit
var _online_code_input: LineEdit
var _online_status_label: Label
var _online_connection_label: Label
var _online_room_code_label: Label
var _online_players_label: Label
var _online_create_button: Button
var _online_join_button: Button
var _online_reconnect_button: Button
var _online_ready_button: Button
var _online_start_button: Button
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
var _online_round_start_at_ms := -1.0
var _online_resume_at_ms := -1.0
var _online_snapshot_sequence := 0
var _online_checksum_sequence := 0
var _online_topout_reported := false
var _online_forfeit_at_ms := -1.0
var _online_foreground_syncing := false
var _online_was_backgrounded := false
var _online_desync_step := -1


func _ready() -> void:
	_build_interface()
	_connect_room_client()
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
	if state == null:
		return
	if _mode == MODE_ONLINE:
		_update_online_round_gate()
		_apply_online_attacks()
	if state.status != &"playing":
		return
	var falling_before: Array[int] = []
	for block in state.garbage:
		if block.state == &"falling":
			falling_before.push_back(block.id)
	var rise_before: float = state.rise_offset
	var next_panel_id_before: int = state.board.next_panel_id
	Simulation.step_simulation(state)
	if _mode == MODE_ONLINE:
		_flush_online_attacks()
		_send_online_periodic_state()
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
		elif _online_panel.visible:
			_hide_online()
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
		if _round_active and state != null and _mode == MODE_ONLINE:
			_online_was_backgrounded = true
			_online_foreground_syncing = true
			if state.status == &"playing":
				Simulation.set_paused(state, true)
			_title_label.text = "DUEL  •  RECONNECTING"
			_raise_button.disabled = true
			_save_recovery()
			return
		if _round_active and state != null and state.status == &"playing":
			Simulation.set_paused(state, true)
			_pause_button.text = "RESUME"
			_reveal_panel(_pause_panel)
			_update_hud()
			_save_recovery()
	elif what in [
		NOTIFICATION_APPLICATION_FOCUS_IN,
		NOTIFICATION_APPLICATION_RESUMED,
	]:
		_resume_online_from_background()


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

	_opponent_board_frame = PanelContainer.new()
	_opponent_board_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_opponent_board_frame.add_theme_stylebox_override(
		"panel",
		UiTheme.panel_style(
			UiTheme.WHITE,
			18,
			UiTheme.PEACH_DEEP,
			2,
			4,
		),
	)
	add_child(_opponent_board_frame)

	_opponent_board_label = Label.new()
	_opponent_board_label.text = "RIVAL"
	_opponent_board_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_opponent_board_label.text_overrun_behavior = (
		TextServer.OVERRUN_TRIM_ELLIPSIS
	)
	_opponent_board_label.add_theme_font_override(
		"font",
		UiTheme.body_font(900),
	)
	_opponent_board_label.add_theme_font_size_override("font_size", 10)
	_opponent_board_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_FAINT,
	)
	add_child(_opponent_board_label)

	_opponent_board_view = OpponentBoardView.new()
	add_child(_opponent_board_view)
	_set_opponent_board_visible(false)

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
	home_box.add_theme_constant_override("separation", 8)
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
	var online_button := _make_button("PRIVATE DUEL", &"primary")
	online_button.pressed.connect(_show_online)
	home_box.add_child(online_button)
	var endless_button := _make_button("PLAY ENDLESS")
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

	_online_panel = PanelContainer.new()
	var online_style := _make_overlay_style()
	online_style.content_margin_left = 22
	online_style.content_margin_right = 22
	online_style.content_margin_top = 20
	online_style.content_margin_bottom = 20
	_online_panel.add_theme_stylebox_override("panel", online_style)
	_online_panel.visible = false
	add_child(_online_panel)
	var online_root := VBoxContainer.new()
	online_root.alignment = BoxContainer.ALIGNMENT_BEGIN
	online_root.add_theme_constant_override("separation", 6)
	_online_panel.add_child(online_root)
	var online_eyebrow := Label.new()
	online_eyebrow.text = "TWO PLAYERS  ·  PRIVATE ROOM"
	online_eyebrow.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	online_eyebrow.add_theme_font_override("font", UiTheme.body_font(900))
	online_eyebrow.add_theme_font_size_override("font_size", 10)
	online_eyebrow.add_theme_color_override("font_color", UiTheme.CORAL_DARK)
	online_root.add_child(online_eyebrow)
	var online_title := Label.new()
	online_title.text = "PLAY ONLINE"
	online_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	online_title.add_theme_font_override("font", UiTheme.display_font(700))
	online_title.add_theme_font_size_override("font_size", 30)
	online_title.add_theme_color_override("font_color", UiTheme.INK)
	online_root.add_child(online_title)
	_online_connection_label = Label.new()
	_online_connection_label.text = "NOT CONNECTED"
	_online_connection_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_online_connection_label.add_theme_font_override(
		"font",
		UiTheme.body_font(900),
	)
	_online_connection_label.add_theme_font_size_override("font_size", 9)
	_online_connection_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_FAINT,
	)
	online_root.add_child(_online_connection_label)
	_online_status_label = Label.new()
	_online_status_label.text = "Create a room or enter a friend's code."
	_online_status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	# Autowrap reports one line per character while this hidden card still has
	# zero width, permanently inflating the container's minimum height.
	_online_status_label.autowrap_mode = TextServer.AUTOWRAP_OFF
	_online_status_label.text_overrun_behavior = (
		TextServer.OVERRUN_TRIM_ELLIPSIS
	)
	_online_status_label.custom_minimum_size.y = 24.0
	_online_status_label.add_theme_font_size_override("font_size", 11)
	_online_status_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	online_root.add_child(_online_status_label)

	_online_form = VBoxContainer.new()
	_online_form.add_theme_constant_override("separation", 7)
	online_root.add_child(_online_form)
	_online_name_input = _make_text_input("YOUR NAME", 20)
	_online_name_input.text_submitted.connect(
		func(_text: String) -> void: _create_online_room(),
	)
	_online_form.add_child(_online_name_input)
	# Allow pasted codes with spaces or separators; normalization still caps at 6.
	_online_code_input = _make_text_input("ROOM CODE", 12)
	_online_code_input.text_changed.connect(_normalize_room_code)
	_online_code_input.text_submitted.connect(
		func(_text: String) -> void: _join_online_room(),
	)
	_online_form.add_child(_online_code_input)
	var online_actions := HBoxContainer.new()
	online_actions.add_theme_constant_override("separation", 7)
	_online_form.add_child(online_actions)
	_online_create_button = _make_button("CREATE", &"primary", true, true)
	_online_create_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_online_create_button.pressed.connect(_create_online_room)
	online_actions.add_child(_online_create_button)
	_online_join_button = _make_button("JOIN", &"secondary", true, true)
	_online_join_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_online_join_button.pressed.connect(_join_online_room)
	online_actions.add_child(_online_join_button)
	_online_reconnect_button = _make_button("RECONNECT SAVED ROOM", &"ghost")
	_online_reconnect_button.pressed.connect(_reconnect_online_room)
	_online_form.add_child(_online_reconnect_button)

	_online_lobby = VBoxContainer.new()
	_online_lobby.visible = false
	_online_lobby.add_theme_constant_override("separation", 7)
	online_root.add_child(_online_lobby)
	var room_caption := Label.new()
	room_caption.text = "ROOM CODE"
	room_caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	room_caption.add_theme_font_override("font", UiTheme.body_font(900))
	room_caption.add_theme_font_size_override("font_size", 9)
	room_caption.add_theme_color_override("font_color", UiTheme.INK_FAINT)
	_online_lobby.add_child(room_caption)
	_online_room_code_label = Label.new()
	_online_room_code_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_online_room_code_label.add_theme_font_override(
		"font",
		UiTheme.display_font(700),
	)
	_online_room_code_label.add_theme_font_size_override("font_size", 34)
	_online_room_code_label.add_theme_color_override(
		"font_color",
		UiTheme.CORAL_DEEP,
	)
	_online_lobby.add_child(_online_room_code_label)
	_online_players_label = Label.new()
	_online_players_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_online_players_label.custom_minimum_size.y = 48.0
	_online_players_label.add_theme_font_override("font", UiTheme.body_font(700))
	_online_players_label.add_theme_font_size_override("font_size", 12)
	_online_players_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	_online_lobby.add_child(_online_players_label)
	_online_ready_button = _make_button("I'M READY")
	_online_ready_button.pressed.connect(_toggle_online_ready)
	_online_lobby.add_child(_online_ready_button)
	_online_start_button = _make_button("START DUEL", &"primary")
	_online_start_button.pressed.connect(_start_online_match)
	_online_lobby.add_child(_online_start_button)

	var online_back := _make_button("BACK", &"ghost")
	online_back.pressed.connect(_hide_online)
	online_root.add_child(online_back)

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

	_network_panel = PanelContainer.new()
	_network_panel.add_theme_stylebox_override(
		"panel",
		_make_overlay_style(),
	)
	_network_panel.visible = false
	add_child(_network_panel)
	var network_box := VBoxContainer.new()
	network_box.alignment = BoxContainer.ALIGNMENT_CENTER
	network_box.add_theme_constant_override("separation", 9)
	_network_panel.add_child(network_box)
	_network_kicker_label = Label.new()
	_network_kicker_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_network_kicker_label.add_theme_font_override(
		"font",
		UiTheme.body_font(900),
	)
	_network_kicker_label.add_theme_font_size_override("font_size", 10)
	_network_kicker_label.add_theme_color_override(
		"font_color",
		UiTheme.CORAL_DARK,
	)
	network_box.add_child(_network_kicker_label)
	_network_status_label = Label.new()
	_network_status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_network_status_label.add_theme_font_override(
		"font",
		UiTheme.display_font(700),
	)
	_network_status_label.add_theme_font_size_override("font_size", 26)
	_network_status_label.add_theme_color_override(
		"font_color",
		UiTheme.INK,
	)
	network_box.add_child(_network_status_label)
	_network_note_label = Label.new()
	_network_note_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_network_note_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_network_note_label.add_theme_font_size_override("font_size", 12)
	_network_note_label.add_theme_color_override(
		"font_color",
		UiTheme.INK_SOFT,
	)
	network_box.add_child(_network_note_label)


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
	var board_region_width := viewport_size.x - left - right
	var board_width: float
	if _mode == MODE_ONLINE:
		var opponent_width := clampf(board_region_width * 0.235, 76.0, 104.0)
		var opponent_inset := 6.0
		var board_gap := 12.0
		board_width = minf(
			board_available_height / 2.0,
			board_region_width
				- BOARD_FRAME_INSET * 2.0
				- board_gap
				- opponent_width
				- opponent_inset * 2.0,
		)
		var group_width := (
			board_width
			+ BOARD_FRAME_INSET * 2.0
			+ board_gap
			+ opponent_width
			+ opponent_inset * 2.0
		)
		var group_left := (viewport_size.x - group_width) / 2.0
		board_view.position = Vector2(
			group_left + BOARD_FRAME_INSET,
			board_top,
		)
		var opponent_frame_position := Vector2(
			group_left + board_width + BOARD_FRAME_INSET * 2.0 + board_gap,
			board_top + 22.0,
		)
		_opponent_board_label.position = Vector2(
			opponent_frame_position.x,
			board_top,
		)
		_opponent_board_label.size = Vector2(
			opponent_width + opponent_inset * 2.0,
			18.0,
		)
		_opponent_board_frame.position = opponent_frame_position
		_opponent_board_frame.size = Vector2(
			opponent_width + opponent_inset * 2.0,
			opponent_width * 2.0 + opponent_inset * 2.0,
		)
		_opponent_board_view.position = (
			opponent_frame_position + Vector2.ONE * opponent_inset
		)
		_opponent_board_view.size = Vector2(
			opponent_width,
			opponent_width * 2.0,
		)
	else:
		board_width = minf(
			board_region_width - 18.0,
			board_available_height / 2.0,
		)
		board_view.position = Vector2(
			(viewport_size.x - board_width) / 2.0,
			board_top,
		)
	board_view.size = Vector2(board_width, board_width * 2.0)
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
	var network_size := Vector2(
		minf(300.0, viewport_size.x - left - right - 8.0),
		172.0,
	)
	_network_panel.size = network_size
	_network_panel.position = Vector2(
		(viewport_size.x - network_size.x) / 2.0,
		top + (bottom - top - network_size.y) / 2.0,
	)
	var home_size := Vector2(
		minf(334.0, viewport_size.x - left - right),
		minf(520.0, bottom - top - 16.0),
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
	var online_height := clampf(
		_online_panel.get_combined_minimum_size().y,
		350.0,
		460.0,
	)
	var online_size := Vector2(
		minf(334.0, viewport_size.x - left - right),
		minf(online_height, bottom - top - 16.0),
	)
	_online_panel.size = online_size
	_online_panel.position = Vector2(
		(viewport_size.x - online_size.x) / 2.0,
		top + (bottom - top - online_size.y) / 2.0,
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
	_set_opponent_board_visible(false)
	_opponent_board_view.clear_snapshot()
	_network_panel.visible = false
	_layout_interface()
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
	_online_panel.visible = false
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
	if _mode == MODE_ONLINE:
		var client = _room_client()
		if client == null:
			return
		_result_retry_button.disabled = true
		if client.match_result.is_empty():
			client.ready_for_next_round()
		else:
			client.request_rematch()
		return
	_start_round(_mode)


func _show_home() -> void:
	_stop_manual_raise()
	var leaving_online_match := _mode == MODE_ONLINE
	if leaving_online_match:
		var online_client = _room_client()
		if online_client != null:
			online_client.disconnect_from_server()
			online_client.clear_saved_session()
	_round_active = false
	_clear_recovery()
	_mode = MODE_ENDLESS
	_set_opponent_board_visible(false)
	_opponent_board_view.clear_snapshot()
	_network_panel.visible = false
	_layout_interface()
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
	_online_panel.visible = false
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
	if state == null or state.status == &"lost" or _mode == MODE_ONLINE:
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
		"TIME TRIAL"
		if _mode == MODE_TIME_TRIAL
		else "DUEL" if _mode == MODE_ONLINE else "ENDLESS"
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
		_pause_button.disabled = _mode == MODE_ONLINE
		_raise_button.disabled = state.danger_remaining >= 0


func _finish_round() -> void:
	if _result_reported:
		return
	if _mode == MODE_ONLINE:
		_result_reported = true
		_online_topout_reported = true
		_round_active = false
		_clear_file(ONLINE_RECOVERY_PATH)
		_stop_manual_raise()
		var client = _room_client()
		if client != null:
			client.report_top_out()
		_title_label.text = "DUEL  •  WAITING FOR RESULT"
		_pause_button.disabled = true
		_raise_button.disabled = true
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
	_online_panel.visible = false
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
	_online_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	_reveal_panel(_help_panel)
	_set_game_chrome_visible(false, false)


func _hide_help() -> void:
	_help_panel.visible = false
	_reveal_panel(_home_panel)
	_set_game_chrome_visible(false, false)


func _connect_room_client() -> void:
	var client = _room_client()
	if client == null:
		return
	client.connection_state_changed.connect(_on_online_connection_changed)
	client.room_session_changed.connect(_on_online_session_changed)
	client.room_state_changed.connect(_on_online_room_state_changed)
	client.room_error.connect(_on_online_error)
	client.round_prepared.connect(_on_online_round_prepared)
	client.round_starting.connect(_on_online_round_starting)
	client.opponent_snapshot_received.connect(_on_online_opponent_snapshot)
	client.opponent_snapshot_cleared.connect(_on_online_opponent_snapshot_cleared)
	client.clock_synchronized.connect(_on_online_clock_synchronized)
	client.desync_detected.connect(_on_online_desync_detected)
	client.round_ended.connect(_on_online_round_ended)
	client.match_ended.connect(_on_online_match_ended)
	client.match_paused.connect(_on_online_match_paused)
	client.match_resuming.connect(_on_online_match_resuming)


func _show_online() -> void:
	_home_panel.visible = false
	_help_panel.visible = false
	_settings_panel.visible = false
	_result_panel.visible = false
	_pause_panel.visible = false
	var client = _room_client()
	if client != null:
		client.connect_to_server(false)
	_reveal_panel(_online_panel)
	_set_game_chrome_visible(false, false)
	_online_name_input.text = String(
		_progress.get_value("online", "display_name", ""),
	)
	_update_online_panel()


func _hide_online() -> void:
	_online_panel.visible = false
	_reveal_panel(_home_panel)
	_set_game_chrome_visible(false, false)


func _create_online_room() -> void:
	var display_name := _online_name_input.text.strip_edges()
	if display_name.is_empty() or display_name.length() > 20:
		_set_online_status("Enter a name between 1 and 20 characters.", true)
		return
	_remember_online_name(display_name)
	_set_online_status("Creating room…")
	_set_online_actions_disabled(true)
	var client = _room_client()
	if client != null:
		client.create_room(display_name)


func _join_online_room() -> void:
	var display_name := _online_name_input.text.strip_edges()
	var room_code := _online_code_input.text.strip_edges().to_upper()
	if display_name.is_empty() or display_name.length() > 20:
		_set_online_status("Enter a name between 1 and 20 characters.", true)
		return
	if room_code.length() != 6:
		_set_online_status("Enter the six-character room code.", true)
		return
	_remember_online_name(display_name)
	_set_online_status("Joining %s…" % room_code)
	_set_online_actions_disabled(true)
	var client = _room_client()
	if client != null:
		client.join_room(room_code, display_name)


func _reconnect_online_room() -> void:
	var client = _room_client()
	if client == null or not client.has_saved_session():
		_set_online_status("There is no saved room to reconnect.", true)
		return
	_set_online_status("Reconnecting to saved room…")
	_set_online_actions_disabled(true)
	client.reconnect_saved_session()


func _toggle_online_ready() -> void:
	var client = _room_client()
	if client == null:
		return
	var player := _online_player()
	if player.is_empty():
		return
	client.set_ready(not bool(player.get("ready", false)))


func _start_online_match() -> void:
	var client = _room_client()
	if client == null or _online_start_button.disabled:
		return
	_set_online_status("Preparing the duel…")
	client.start_match()


func _on_online_connection_changed(_state: StringName) -> void:
	var client = _room_client()
	if (
		_mode == MODE_ONLINE
		and state != null
		and state.status != &"lost"
		and client != null
		and client.connection_state != client.STATE_CONNECTED
	):
		Simulation.set_paused(state, true)
		_title_label.text = "DUEL  •  RECONNECTING"
		_raise_button.disabled = true
		_opponent_board_label.text = "RECONNECTING"
		_show_network_overlay(
			"CONNECTION PAUSED",
			"RECONNECTING…",
			"Your board is safely paused.",
		)
	elif _mode == MODE_ONLINE:
		_update_opponent_board_label()
	_update_online_panel()


func _on_online_session_changed(_session: Dictionary) -> void:
	_set_online_actions_disabled(false)
	_update_online_panel()


func _on_online_room_state_changed(_room_state: Dictionary) -> void:
	_set_online_actions_disabled(false)
	if _mode == MODE_ONLINE:
		_update_opponent_board_label()
	_update_online_panel()


func _on_online_error(error: Dictionary) -> void:
	_set_online_actions_disabled(false)
	_set_online_status(
		String(error.get("message", "The online request failed.")),
		true,
	)


func _update_online_panel() -> void:
	if _online_panel == null:
		return
	var client = _room_client()
	if client == null:
		_online_connection_label.text = "ONLINE SERVICE UNAVAILABLE"
		_online_connection_label.add_theme_color_override(
			"font_color",
			UiTheme.DANGER,
		)
		return
	match client.connection_state:
		client.STATE_CONNECTED:
			_online_connection_label.text = "CONNECTED"
			_online_connection_label.add_theme_color_override(
				"font_color",
				Color("#5a9f79"),
			)
		client.STATE_CONNECTING:
			_online_connection_label.text = "CONNECTING…"
			_online_connection_label.add_theme_color_override(
				"font_color",
				UiTheme.CORAL_DARK,
			)
		_:
			_online_connection_label.text = "NOT CONNECTED"
			_online_connection_label.add_theme_color_override(
				"font_color",
				UiTheme.INK_FAINT,
			)

	var active_room: Dictionary = client.room_state
	var has_room := (
		not active_room.is_empty()
		and not String(active_room.get("roomCode", "")).is_empty()
	)
	_online_form.visible = not has_room
	_online_lobby.visible = has_room
	_online_reconnect_button.visible = (
		not has_room and client.has_saved_session()
	)
	if not has_room:
		if _online_status_label.text.is_empty():
			_set_online_status("Create a room or enter a friend's code.")
		_layout_interface()
		return

	_online_room_code_label.text = String(active_room.get("roomCode", ""))
	var player_lines: Array[String] = []
	for player in active_room.get("players", []):
		if not player is Dictionary:
			continue
		var marker := "✓" if bool(player.get("ready", false)) else "○"
		var connection := "" if bool(player.get("connected", false)) else "  OFFLINE"
		player_lines.push_back(
			"%s  %s%s"
			% [marker, String(player.get("displayName", "Player")), connection],
		)
	while player_lines.size() < 2:
		player_lines.push_back("○  Waiting for player…")
	_online_players_label.text = "\n".join(player_lines)
	var own_player := _online_player()
	var own_ready := bool(own_player.get("ready", false))
	_online_ready_button.text = "NOT READY" if own_ready else "I'M READY"
	_online_ready_button.disabled = (
		own_player.is_empty()
		or String(active_room.get("status", "")) != "waiting"
	)
	var is_host := (
		String(active_room.get("hostPlayerId", ""))
		== String(client.room_session.get("playerId", ""))
	)
	var players: Array = active_room.get("players", [])
	var all_ready := (
		players.size() == 2
		and players.all(
			func(player: Variant) -> bool:
				return (
					player is Dictionary
					and bool(player.get("connected", false))
					and bool(player.get("ready", false))
				),
		)
	)
	_online_start_button.visible = is_host
	_online_start_button.disabled = (
		not all_ready
		or String(active_room.get("status", "")) != "waiting"
	)
	if String(active_room.get("status", "")) == "starting":
		_set_online_status("Both boards are preparing…")
	elif players.size() < 2:
		_set_online_status("Share the room code and wait for player two.")
	elif not all_ready:
		_set_online_status("Both players need to be ready.")
	elif is_host:
		_set_online_status("Ready! Start whenever you like.")
	else:
		_set_online_status("Ready! Waiting for the host to start.")
	_layout_interface()


func _online_player() -> Dictionary:
	var client = _room_client()
	if client == null:
		return {}
	var player_id := String(client.room_session.get("playerId", ""))
	for player in client.room_state.get("players", []):
		if player is Dictionary and String(player.get("playerId", "")) == player_id:
			return player
	return {}


func _set_online_status(message: String, error := false) -> void:
	_online_status_label.text = message
	_online_status_label.add_theme_color_override(
		"font_color",
		UiTheme.DANGER if error else UiTheme.INK_SOFT,
	)


func _set_online_actions_disabled(disabled: bool) -> void:
	_online_create_button.disabled = disabled
	_online_join_button.disabled = disabled
	_online_reconnect_button.disabled = disabled


func _normalize_room_code(value: String) -> void:
	var normalized := ""
	for character in value.to_upper():
		if (
			character >= "A" and character <= "Z"
			or character >= "0" and character <= "9"
		):
			normalized += character
		if normalized.length() >= 6:
			break
	if normalized == value:
		return
	_online_code_input.text = normalized
	_online_code_input.caret_column = normalized.length()


func _remember_online_name(display_name: String) -> void:
	_progress.set_value("online", "display_name", display_name)
	_save_progress()


func _on_online_round_prepared(preparation: Dictionary) -> void:
	_mode = MODE_ONLINE
	_opponent_board_view.clear_snapshot()
	_set_opponent_board_visible(true)
	_update_opponent_board_label()
	_layout_interface()
	_clear_recovery()
	state = Simulation.create_simulation(String(preparation.get("roundSeed", "")))
	Simulation.set_paused(state, true)
	_cursor = Vector2i(0, 0)
	board_view.set_simulation_state(state)
	board_view.clear_selection()
	board_view.set_cursor_position(0, 0, false)
	for panel in [
		_home_panel,
		_help_panel,
		_online_panel,
		_settings_panel,
		_result_panel,
		_pause_panel,
	]:
		panel.visible = false
	_set_game_chrome_visible(true, true)
	_round_active = true
	_result_reported = false
	_online_topout_reported = false
	_online_round_start_at_ms = -1.0
	_online_resume_at_ms = -1.0
	_online_forfeit_at_ms = -1.0
	_online_foreground_syncing = false
	_online_was_backgrounded = false
	_online_desync_step = -1
	_online_snapshot_sequence = 0
	_online_checksum_sequence = 0
	_last_clear_at = -1
	_last_recovery_step = state.step
	_title_label.text = "DUEL  •  PREPARING"
	_pause_button.text = "LIVE"
	_pause_button.disabled = true
	_raise_button.disabled = true
	_restart_button.text = "LEAVE"
	_result_retry_button.disabled = false
	_update_hud()
	_title_label.text = "DUEL  •  PREPARING"
	_pause_button.disabled = true
	_raise_button.disabled = true
	_network_panel.visible = false
	var client = _room_client()
	if client != null:
		client.mark_round_ready(preparation)


func _on_online_opponent_snapshot(snapshot: Dictionary) -> void:
	if _mode != MODE_ONLINE:
		return
	_opponent_board_view.set_snapshot(snapshot)


func _on_online_opponent_snapshot_cleared() -> void:
	if _mode == MODE_ONLINE:
		_opponent_board_view.clear_snapshot()


func _on_online_clock_synchronized(
	_offset_ms: float,
	_round_trip_ms: float,
) -> void:
	if _mode != MODE_ONLINE:
		return
	_online_foreground_syncing = false
	_update_online_round_gate()


func _on_online_desync_detected(diagnostic: Dictionary) -> void:
	if _mode != MODE_ONLINE:
		return
	_online_desync_step = int(diagnostic.get("simulationStep", -1))
	_title_label.text = "DUEL  •  SYNC WARNING"


func _update_opponent_board_label() -> void:
	var client = _room_client()
	if client == null:
		_opponent_board_label.text = "RIVAL"
		return
	var own_id := String(client.room_session.get("playerId", ""))
	for player in client.room_state.get("players", []):
		if (
			player is Dictionary
			and String(player.get("playerId", "")) != own_id
		):
			var display_name := String(
				player.get("displayName", "RIVAL"),
			).to_upper()
			_opponent_board_label.text = (
				display_name
				if bool(player.get("connected", false))
				else "%s • OFFLINE" % display_name
			)
			return
	_opponent_board_label.text = "RIVAL"


func _on_online_round_starting(starting: Dictionary) -> void:
	_online_round_start_at_ms = float(starting.get("startAt", -1.0))
	_online_resume_at_ms = -1.0
	if state != null and state.status != &"lost":
		Simulation.set_paused(state, true)


func _on_online_round_ended(result: Dictionary) -> void:
	if _mode != MODE_ONLINE:
		return
	_round_active = false
	_clear_file(ONLINE_RECOVERY_PATH)
	var client = _room_client()
	var own_id := (
		"" if client == null else String(client.room_session.get("playerId", ""))
	)
	var winner_id := String(result.get("winnerPlayerId", ""))
	_result_kicker_label.text = (
		"DRAW"
		if winner_id.is_empty()
		else "ROUND WON" if winner_id == own_id else "ROUND LOST"
	)
	_result_label.text = _format_online_scores(result.get("scores", []), own_id)
	_result_retry_button.text = "NEXT ROUND"
	_result_retry_button.disabled = false
	_pause_panel.visible = false
	_network_panel.visible = false
	_set_game_chrome_visible(true, false)
	_reveal_panel(_result_panel)


func _on_online_match_ended(result: Dictionary) -> void:
	if _mode != MODE_ONLINE:
		return
	_clear_file(ONLINE_RECOVERY_PATH)
	var client = _room_client()
	var own_id := (
		"" if client == null else String(client.room_session.get("playerId", ""))
	)
	_result_kicker_label.text = (
		"MATCH WON"
		if String(result.get("winnerPlayerId", "")) == own_id
		else "MATCH LOST"
	)
	_result_label.text = _format_online_scores(result.get("scores", []), own_id)
	_result_retry_button.text = "REMATCH"
	_result_retry_button.disabled = false
	_network_panel.visible = false
	_reveal_panel(_result_panel)


func _on_online_match_paused(pause: Dictionary) -> void:
	if _mode != MODE_ONLINE or state == null or state.status == &"lost":
		return
	Simulation.set_paused(state, true)
	_online_resume_at_ms = -1.0
	_online_forfeit_at_ms = float(pause.get("forfeitAt", -1.0))
	_title_label.text = "DUEL  •  OPPONENT DISCONNECTED"
	_raise_button.disabled = true
	_show_network_overlay(
		"CONNECTION PAUSED",
		"RIVAL DISCONNECTED",
		"Waiting for them to return. Your board is safely paused.",
	)


func _on_online_match_resuming(resume: Dictionary) -> void:
	if _mode != MODE_ONLINE or state == null or state.status == &"lost":
		return
	Simulation.set_paused(state, true)
	_online_resume_at_ms = float(resume.get("resumeAt", -1.0))
	_online_forfeit_at_ms = -1.0
	_show_network_overlay(
		"RIVAL RECONNECTED",
		"GET READY",
		"Both boards will resume together.",
	)


func _resume_online_from_background() -> void:
	if (
		not _online_was_backgrounded
		or _mode != MODE_ONLINE
		or not _round_active
	):
		return
	_online_was_backgrounded = false
	_online_foreground_syncing = true
	_show_network_overlay(
		"BACK ONLINE",
		"SYNCING CLOCK…",
		"Checking the match before play resumes.",
	)
	var client = _room_client()
	if client == null:
		_online_foreground_syncing = false
		return
	client.connect_to_server(true)
	client.sample_clock()


func _show_network_overlay(
	kicker: String,
	status_text: String,
	note: String,
) -> void:
	if _network_panel == null or _mode != MODE_ONLINE:
		return
	_network_kicker_label.text = kicker
	_network_status_label.text = status_text
	_network_note_label.text = note
	_network_panel.visible = true


func _update_online_round_gate() -> void:
	if state == null or state.status == &"lost":
		return
	var client = _room_client()
	if client == null or client.connection_state != client.STATE_CONNECTED:
		Simulation.set_paused(state, true)
		_title_label.text = "DUEL  •  RECONNECTING"
		_show_network_overlay(
			"CONNECTION PAUSED",
			"RECONNECTING…",
			"Your board is safely paused.",
		)
		return
	if _online_foreground_syncing:
		Simulation.set_paused(state, true)
		_show_network_overlay(
			"BACK ONLINE",
			"SYNCING CLOCK…",
			"Checking the match before play resumes.",
		)
		return
	if _online_forfeit_at_ms > 0.0 and _online_resume_at_ms < 0.0:
		Simulation.set_paused(state, true)
		var wait_seconds := maxi(
			0,
			ceili(
				(_online_forfeit_at_ms - float(client.server_time_ms()))
					/ 1000.0,
			),
		)
		_network_status_label.text = "WAITING  %ds" % wait_seconds
		return
	var gate_at := maxf(_online_round_start_at_ms, _online_resume_at_ms)
	if gate_at < 0.0:
		Simulation.set_paused(state, true)
		return
	var remaining_ms: float = gate_at - float(client.server_time_ms())
	if remaining_ms > 0.0:
		Simulation.set_paused(state, true)
		_title_label.text = "DUEL  •  %d" % maxi(1, ceili(remaining_ms / 1000.0))
		_show_network_overlay(
			"RIVAL RECONNECTED",
			"%d" % maxi(1, ceili(remaining_ms / 1000.0)),
			"Both boards will resume together.",
		)
		return
	if state.status == &"paused":
		Simulation.set_paused(state, false)
		_title_label.text = (
			"DUEL  •  SYNC WARNING"
			if _online_desync_step >= 0
			else "DUEL"
		)
		_raise_button.disabled = state.danger_remaining >= 0
		_network_panel.visible = false


func _apply_online_attacks() -> void:
	var client = _room_client()
	if client == null or state == null:
		return
	var applied := false
	for attack in client.drain_incoming_attacks():
		var blocks: Array[Types.AttackBlock] = []
		for encoded_block in attack.get("blocks", []):
			if encoded_block is Dictionary:
				blocks.push_back(Types.AttackBlock.new(
					int(encoded_block.get("width", 1)),
					int(encoded_block.get("height", 1)),
					StringName(String(encoded_block.get("type", "normal"))),
				))
		var incoming := Types.IncomingGarbageAttack.new(
			String(attack.get("attackId", "")),
			int(attack.get("serverSequence", -1)),
			blocks,
		)
		if Garbage.enqueue_incoming_garbage(state, incoming):
			client.acknowledge_attack(attack)
			applied = true
	if applied:
		_save_recovery()


func _flush_online_attacks() -> void:
	var client = _room_client()
	if client == null or state.outgoing_attacks.is_empty():
		return
	var attacks: Array = state.outgoing_attacks.duplicate()
	state.outgoing_attacks.clear()
	for attack in attacks:
		var blocks: Array[Dictionary] = []
		for block in attack.blocks:
			blocks.push_back(block.to_dictionary())
		client.send_attack({
			"attackId": "%s:%s:%d" % [
				String(client.round_preparation.get("roundId", "")),
				String(client.room_session.get("playerId", "")),
				attack.sequence,
			],
			"localSequence": attack.sequence,
			"kind": String(attack.kind),
			"blocks": blocks,
		})
	_save_recovery()


func _send_online_periodic_state() -> void:
	var client = _room_client()
	if client == null:
		return
	if state.step % 6 == 0:
		_online_snapshot_sequence += 1
		client.send_board_snapshot(_online_snapshot())
	if state.step % 120 == 0:
		_online_checksum_sequence += 1
		client.send_simulation_checksum(
			_online_checksum_sequence,
			state.step,
			Simulation.simulation_checksum(state),
		)


func _online_snapshot() -> Dictionary:
	var cells: Array[Dictionary] = []
	for panel in state.board.cells:
		if panel != null:
			cells.push_back({
				"row": panel.row,
				"column": panel.column,
				"type": String(panel.type),
				"state": String(panel.state),
			})
	var garbage: Array[Dictionary] = []
	for block in state.garbage:
		garbage.push_back({
			"id": block.id,
			"type": String(block.type),
			"column": block.column,
			"row": block.row,
			"width": block.width,
			"height": block.height,
			"state": String(block.state),
		})
	var incoming: Array[Dictionary] = []
	for attack in state.incoming_garbage:
		var blocks: Array[Dictionary] = []
		for block in attack.blocks:
			blocks.push_back(block.to_dictionary())
		incoming.push_back({
			"serverSequence": attack.server_sequence,
			"blocks": blocks,
		})
	return {
		"sequence": _online_snapshot_sequence,
		"riseOffset": state.rise_offset,
		"dangerRemainingMs": (
			null
			if state.danger_remaining < 0
			else float(state.danger_remaining) / Config.CLOCK_UNITS_PER_MILLISECOND
		),
		"chainLevel": 0 if state.chain == null else state.chain.level,
		"cells": cells,
		"garbage": garbage,
		"incomingGarbage": incoming,
	}


func _format_online_scores(scores: Array, own_id: String) -> String:
	var own_wins := 0
	var opponent_wins := 0
	for score in scores:
		if not score is Dictionary:
			continue
		if String(score.get("playerId", "")) == own_id:
			own_wins = int(score.get("wins", 0))
		else:
			opponent_wins = int(score.get("wins", 0))
	return "%d — %d" % [own_wins, opponent_wins]


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
	if _opponent_board_view != null:
		_opponent_board_view.set_reduced_motion(
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


func _room_client():
	if not is_inside_tree():
		return null
	return get_tree().root.get_node_or_null("RoomClient")


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
	if _try_restore_online_round():
		return true
	return _try_restore_solo_round()


func _try_restore_solo_round() -> bool:
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
	_online_panel.visible = false
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


func _try_restore_online_round() -> bool:
	if (
		not recovery_enabled
		or not FileAccess.file_exists(ONLINE_RECOVERY_PATH)
	):
		return false
	var client = _room_client()
	if (
		client == null
		or not client.has_saved_session()
		or client.round_preparation.is_empty()
	):
		_clear_file(ONLINE_RECOVERY_PATH)
		return false
	var serialized := FileAccess.get_file_as_string(ONLINE_RECOVERY_PATH)
	var recovered := _decode_online_recovery_snapshot(
		serialized,
		_now_ms(),
		client.round_preparation,
		String(client.room_session.get("playerId", "")),
	)
	if recovered.is_empty():
		_clear_file(ONLINE_RECOVERY_PATH)
		return false

	state = recovered["state"]
	_mode = MODE_ONLINE
	Simulation.set_paused(state, true)
	board_view.set_simulation_state(state)
	board_view.clear_selection()
	board_view.set_cursor_position(0, 0, false)
	_opponent_board_view.clear_snapshot()
	_set_opponent_board_visible(true)
	for panel in [
		_home_panel,
		_help_panel,
		_online_panel,
		_settings_panel,
		_result_panel,
		_pause_panel,
	]:
		panel.visible = false
	_set_game_chrome_visible(true, true)
	_round_active = true
	_result_reported = false
	_online_topout_reported = false
	_online_round_start_at_ms = float(
		client.round_start.get("startAt", -1.0),
	)
	_online_resume_at_ms = -1.0
	_online_forfeit_at_ms = -1.0
	_online_foreground_syncing = true
	_online_was_backgrounded = false
	_online_desync_step = -1
	_online_snapshot_sequence = int(recovered["snapshotSequence"])
	_online_checksum_sequence = int(recovered["checksumSequence"])
	_last_clear_at = (
		-1
		if state.last_clear_event == null
		else state.last_clear_event.occurred_at
	)
	_last_recovery_step = state.step
	_title_label.text = "DUEL  •  RECOVERED"
	_pause_button.text = "LIVE"
	_pause_button.disabled = true
	_raise_button.disabled = true
	_restart_button.text = "LEAVE"
	_update_opponent_board_label()
	_layout_interface()
	_update_hud()
	_show_network_overlay(
		"ROUND RECOVERED",
		"RECONNECTING…",
		"Checking the saved board with the active room.",
	)
	client.connect_to_server(true)
	client.mark_round_ready(client.round_preparation)
	return true


func _save_recovery() -> void:
	if (
		not recovery_enabled
		or not _round_active
		or state == null
		or state.status == &"lost"
	):
		return
	var serialized := (
		_encode_online_recovery_snapshot(_now_ms())
		if _mode == MODE_ONLINE
		else _encode_recovery_snapshot(_now_ms())
	)
	if serialized.is_empty():
		return
	var path := (
		ONLINE_RECOVERY_PATH if _mode == MODE_ONLINE else RECOVERY_PATH
	)
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(serialized)
	_last_recovery_step = state.step


func _clear_recovery() -> void:
	if not recovery_enabled:
		return
	_clear_file(RECOVERY_PATH)
	_clear_file(ONLINE_RECOVERY_PATH)
	_last_recovery_step = -1


func _clear_file(path: String) -> void:
	if not FileAccess.file_exists(path):
		return
	DirAccess.remove_absolute(
		ProjectSettings.globalize_path(path),
	)


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


func _encode_online_recovery_snapshot(saved_at_ms: int) -> String:
	var client = _room_client()
	if (
		state == null
		or _mode != MODE_ONLINE
		or client == null
		or client.round_preparation.is_empty()
	):
		return ""
	return _encode_online_recovery_for(
		saved_at_ms,
		client.round_preparation,
		String(client.room_session.get("playerId", "")),
	)


func _encode_online_recovery_for(
	saved_at_ms: int,
	preparation: Dictionary,
	player_id: String,
) -> String:
	var match_id := String(preparation.get("matchId", ""))
	var round_id := String(preparation.get("roundId", ""))
	var round_seed := String(preparation.get("roundSeed", ""))
	if (
		state == null
		or match_id.is_empty()
		or round_id.is_empty()
		or round_seed.is_empty()
		or player_id.is_empty()
		or state.seed != round_seed
	):
		return ""
	var serialized := Recovery.serialize_simulation_snapshot(
		state,
		_online_recovery_scope(match_id, round_id),
		saved_at_ms,
	)
	var root = JSON.parse_string(serialized)
	if not root is Dictionary:
		return ""
	root["mode"] = String(MODE_ONLINE)
	root["matchId"] = match_id
	root["roundId"] = round_id
	root["playerId"] = player_id
	root["snapshotSequence"] = _online_snapshot_sequence
	root["checksumSequence"] = _online_checksum_sequence
	return JSON.stringify(root, "", true, true)


func _decode_online_recovery_snapshot(
	serialized: String,
	now_ms: int,
	preparation: Dictionary,
	player_id: String,
) -> Dictionary:
	var root = JSON.parse_string(serialized)
	if not root is Dictionary or root.get("mode") != String(MODE_ONLINE):
		return {}
	var match_id := String(preparation.get("matchId", ""))
	var round_id := String(preparation.get("roundId", ""))
	var round_seed := String(preparation.get("roundSeed", ""))
	if (
		match_id.is_empty()
		or round_id.is_empty()
		or round_seed.is_empty()
		or player_id.is_empty()
		or root.get("matchId") != match_id
		or root.get("roundId") != round_id
		or root.get("playerId") != player_id
	):
		return {}
	var restored = Recovery.restore_simulation_snapshot(
		serialized,
		_online_recovery_scope(match_id, round_id),
		round_seed,
		now_ms,
		ONLINE_RECOVERY_MAX_AGE_MS,
	)
	if restored == null or restored.status == &"lost":
		return {}
	return {
		"state": restored,
		"snapshotSequence": maxi(
			int(root.get("snapshotSequence", 0)),
			restored.step / 6,
		),
		"checksumSequence": maxi(
			int(root.get("checksumSequence", 0)),
			restored.step / 120,
		),
	}


func _online_recovery_scope(match_id: String, round_id: String) -> String:
	return "%s:%s:%s" % [
		ONLINE_RECOVERY_SCOPE_PREFIX,
		match_id,
		round_id,
	]


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


func _set_opponent_board_visible(visible: bool) -> void:
	_opponent_board_frame.visible = visible
	_opponent_board_label.visible = visible
	_opponent_board_view.visible = visible


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
			_online_panel,
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


func _make_text_input(placeholder: String, maximum_length: int) -> LineEdit:
	var input := LineEdit.new()
	input.placeholder_text = placeholder
	input.max_length = maximum_length
	input.clear_button_enabled = true
	input.custom_minimum_size = Vector2(0.0, 44.0)
	input.add_theme_font_override("font", UiTheme.body_font(800))
	input.add_theme_font_size_override("font_size", 14)
	input.add_theme_color_override("font_color", UiTheme.INK)
	input.add_theme_color_override("font_placeholder_color", UiTheme.INK_FAINT)
	input.add_theme_color_override("caret_color", UiTheme.CORAL_DARK)
	input.add_theme_color_override("selection_color", UiTheme.CORAL_SOFT)
	var normal := UiTheme.panel_style(
		Color("#fffaf5"),
		18,
		Color("#f1d9c8"),
		1,
	)
	normal.content_margin_left = 16
	normal.content_margin_right = 16
	var focus := normal.duplicate() as StyleBoxFlat
	focus.border_color = UiTheme.CORAL
	focus.set_border_width_all(2)
	input.add_theme_stylebox_override("normal", normal)
	input.add_theme_stylebox_override("focus", focus)
	input.add_theme_stylebox_override("read_only", normal)
	return input


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
