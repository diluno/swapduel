extends Node

signal enabled_changed(enabled: bool)

const SETTINGS_PATH := "user://settings.cfg"
const MASTER_GAIN := 0.24
const PLAYER_COUNT := 10

const EFFECT_PATHS := {
	&"swap": "res://assets/audio/swap.wav",
	&"clear": "res://assets/audio/clear.wav",
	&"combo": "res://assets/audio/combo.wav",
	&"chain": "res://assets/audio/chain.wav",
	&"garbage-land": "res://assets/audio/garbage_land.wav",
	&"danger": "res://assets/audio/danger.wav",
	&"win": "res://assets/audio/win.wav",
	&"lose": "res://assets/audio/lose.wav",
	&"toggle": "res://assets/audio/toggle.wav",
}

var sound_enabled := true

var _effects: Dictionary = {}
var _players: Array[AudioStreamPlayer] = []
var _next_player := 0
var _last_played_at: Dictionary = {}


func _ready() -> void:
	_load_preference()
	for effect in EFFECT_PATHS:
		var stream = load(EFFECT_PATHS[effect])
		if stream != null:
			_effects[effect] = stream
	for _index in PLAYER_COUNT:
		var player := AudioStreamPlayer.new()
		player.volume_db = linear_to_db(MASTER_GAIN)
		add_child(player)
		_players.push_back(player)


func toggle_sound() -> bool:
	sound_enabled = not sound_enabled
	_save_preference()
	enabled_changed.emit(sound_enabled)
	if sound_enabled:
		_play(&"toggle", 0)
	else:
		for player in _players:
			player.stop()
	return sound_enabled


func play_swap() -> void:
	_play(&"swap", 45)


func play_clear(normal_size: int, chain_level: int) -> void:
	if chain_level > 1:
		_play(&"chain", 80)
	elif normal_size >= 4:
		_play(&"combo", 80)
	else:
		_play(&"clear", 80)


func play_garbage_landed() -> void:
	_play(&"garbage-land", 70)


func play_danger() -> void:
	_play(&"danger", 620)


func play_result(new_best: bool) -> void:
	_play(&"win" if new_best else &"lose", 800)


func _play(effect: StringName, minimum_gap_ms: int) -> void:
	if not sound_enabled or _players.is_empty() or not _effects.has(effect):
		return
	var now := Time.get_ticks_msec()
	var previous := int(_last_played_at.get(effect, -1_000_000))
	if now - previous < minimum_gap_ms:
		return
	_last_played_at[effect] = now
	var player := _players[_next_player]
	_next_player = (_next_player + 1) % _players.size()
	player.stop()
	player.stream = _effects[effect]
	player.play()


func _load_preference() -> void:
	var settings := ConfigFile.new()
	if settings.load(SETTINGS_PATH) == OK:
		sound_enabled = bool(
			settings.get_value("audio", "enabled", true),
		)


func _save_preference() -> void:
	var settings := ConfigFile.new()
	settings.load(SETTINGS_PATH)
	settings.set_value("audio", "enabled", sound_enabled)
	settings.save(SETTINGS_PATH)
