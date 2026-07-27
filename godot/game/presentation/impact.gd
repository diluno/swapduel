extends RefCounted

const Config = preload("res://game/engine/config.gd")

const SQUASH_DURATION := 240 * Config.CLOCK_UNITS_PER_MILLISECOND
const SHAKE_DURATION := 320 * Config.CLOCK_UNITS_PER_MILLISECOND
const LANDING_MEMORY := 1000 * Config.CLOCK_UNITS_PER_MILLISECOND

var landings: Dictionary = {}
var panel_falls: Dictionary = {}
var shake_started_at := -1
var shake_strength := 0.0

var _previous_garbage_states: Dictionary = {}
var _previous_panel_rows: Dictionary = {}


func reset() -> void:
	landings.clear()
	panel_falls.clear()
	_previous_garbage_states.clear()
	_previous_panel_rows.clear()
	shake_started_at = -1
	shake_strength = 0.0


func observe(simulation_state) -> Dictionary:
	_observe_panels(simulation_state)
	var cells := 0
	var width := 0
	var live: Dictionary = {}

	for block in simulation_state.garbage:
		live[block.id] = true
		var previous = _previous_garbage_states.get(block.id)
		_previous_garbage_states[block.id] = block.state
		if previous != &"falling" or block.state != &"idle":
			continue
		cells += block.width * block.height
		width = maxi(width, block.width)
		landings[block.id] = simulation_state.elapsed_clock

	for id in _previous_garbage_states.keys():
		if not live.has(id):
			_previous_garbage_states.erase(id)
	for id in landings.keys():
		if (
			not live.has(id)
			or simulation_state.elapsed_clock - int(landings[id])
				> LANDING_MEMORY
		):
			landings.erase(id)

	if cells == 0:
		return {}
	var strength := minf(1.0, 0.4 + float(cells) / 14.0)
	if (
		strength >= shake_strength
		or simulation_state.elapsed_clock - shake_started_at
			> SHAKE_DURATION
	):
		shake_strength = strength
	shake_started_at = simulation_state.elapsed_clock
	return {
		"cells": cells,
		"width": width,
	}


func panel_fall_visual(panel_id: int, elapsed_clock: int) -> Vector2:
	var fall = panel_falls.get(panel_id)
	if fall == null:
		return Vector2.ZERO
	var distance := int(fall["distance"])
	var age := elapsed_clock - int(fall["landed_at"])
	var duration := panel_fall_duration(distance)
	if age < 0:
		return Vector2(float(distance), 0.0)
	if age < duration:
		var progress := float(age) / duration
		return Vector2(
			distance * (1.0 - progress * progress),
			0.0,
		)
	var settle_age := age - duration
	if settle_age >= SQUASH_DURATION:
		return Vector2.ZERO
	var settle := float(settle_age) / SQUASH_DURATION
	var weight := minf(1.0, 0.5 + distance * 0.18)
	return Vector2(
		0.0,
		sin(settle * PI) * (1.0 - settle) * 0.3 * weight,
	)


func shake_offset(elapsed_clock: int) -> Vector2:
	var age := elapsed_clock - shake_started_at
	if age < 0 or age >= SHAKE_DURATION:
		return Vector2.ZERO
	var decay := pow(1.0 - float(age) / SHAKE_DURATION, 2.0)
	var amplitude := 0.16 * shake_strength * decay
	return Vector2(
		sin(age * 0.085 / Config.CLOCK_UNITS_PER_MILLISECOND)
			* amplitude * 0.55,
		sin(age * 0.062 / Config.CLOCK_UNITS_PER_MILLISECOND)
			* amplitude,
	)


static func panel_fall_duration(distance: int) -> int:
	return mini(
		190 * Config.CLOCK_UNITS_PER_MILLISECOND,
		roundi(
			66.0
			* sqrt(maxf(1.0, distance))
			* Config.CLOCK_UNITS_PER_MILLISECOND
		),
	)


func _observe_panels(simulation_state) -> void:
	var live: Dictionary = {}
	for panel in simulation_state.board.cells:
		if panel == null:
			continue
		live[panel.id] = true
		var previous_row = _previous_panel_rows.get(panel.id)
		_previous_panel_rows[panel.id] = panel.row
		if previous_row == null or panel.row >= int(previous_row):
			continue
		panel_falls[panel.id] = {
			"distance": int(previous_row) - panel.row,
			"landed_at": simulation_state.elapsed_clock,
		}

	for id in _previous_panel_rows.keys():
		if not live.has(id):
			_previous_panel_rows.erase(id)
	for id in panel_falls.keys():
		var fall: Dictionary = panel_falls[id]
		var age: int = (
			simulation_state.elapsed_clock - int(fall["landed_at"])
		)
		if (
			not live.has(id)
			or age > (
				panel_fall_duration(int(fall["distance"]))
				+ SQUASH_DURATION
			)
		):
			panel_falls.erase(id)
