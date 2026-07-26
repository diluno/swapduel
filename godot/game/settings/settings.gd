extends Node

signal changed

const SETTINGS_PATH := "user://settings.cfg"
const FULL_FRAME_RATE := 60
const BATTERY_FRAME_RATE := 30

var reduced_motion := false
var battery_saver := false
var haptics_enabled := true


func _ready() -> void:
	_load_preferences()
	_apply_runtime_preferences()


func toggle_reduced_motion() -> bool:
	reduced_motion = not reduced_motion
	_save_preferences()
	changed.emit()
	return reduced_motion


func toggle_battery_saver() -> bool:
	battery_saver = not battery_saver
	_apply_runtime_preferences()
	_save_preferences()
	changed.emit()
	return battery_saver


func toggle_haptics() -> bool:
	haptics_enabled = not haptics_enabled
	_save_preferences()
	changed.emit()
	return haptics_enabled


func presentation_frame_rate() -> int:
	return BATTERY_FRAME_RATE if battery_saver else FULL_FRAME_RATE


func vibrate(duration_ms: int, amplitude: float = -1.0) -> void:
	if not haptics_enabled:
		return
	Input.vibrate_handheld(duration_ms, amplitude)


func _load_preferences() -> void:
	var settings := ConfigFile.new()
	if settings.load(SETTINGS_PATH) != OK:
		return
	reduced_motion = bool(
		settings.get_value("accessibility", "reduced_motion", false),
	)
	battery_saver = bool(
		settings.get_value("display", "battery_saver", false),
	)
	haptics_enabled = bool(
		settings.get_value("feedback", "haptics", true),
	)


func _save_preferences() -> void:
	var settings := ConfigFile.new()
	settings.load(SETTINGS_PATH)
	settings.set_value(
		"accessibility",
		"reduced_motion",
		reduced_motion,
	)
	settings.set_value("display", "battery_saver", battery_saver)
	settings.set_value("feedback", "haptics", haptics_enabled)
	settings.save(SETTINGS_PATH)


func _apply_runtime_preferences() -> void:
	Engine.max_fps = presentation_frame_rate()
