extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")


static func board_touches_top(state: Types.SimulationState) -> bool:
	var top_row := state.board.visible_rows - 1
	for column in state.board.columns:
		if state.board.get_panel(top_row, column) != null:
			return true

	for block in state.garbage:
		if (
			block.state != &"falling"
			and block.row <= top_row
			and block.row + block.height - 1 >= top_row
		):
			return true
	return false


static func advance_danger_state(
	state: Types.SimulationState,
	config: Types.GameConfig = null,
) -> void:
	if state.status != &"playing":
		return
	var game_config := (
		config if config != null else Config.default_game_config()
	)
	var blocked := board_touches_top(state)

	if not blocked:
		state.danger_remaining = -1
		return

	if state.danger_remaining < 0:
		state.danger_remaining = game_config.timing.danger_grace
		state.manual_raise = false
		return

	if state.phase != &"idle":
		return

	state.danger_remaining = maxi(
		0,
		state.danger_remaining - game_config.timing.fixed_step,
	)
	if state.danger_remaining == 0:
		state.status = &"lost"
		state.end_reason = &"topped-out"
		state.manual_raise = false

