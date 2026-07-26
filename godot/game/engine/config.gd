extends RefCounted

const Types = preload("res://game/engine/types.gd")

const CLOCK_UNITS_PER_MILLISECOND := 3
const CLOCK_UNITS_PER_STEP := 50
const TIME_TRIAL_DURATION := 120_000 * CLOCK_UNITS_PER_MILLISECOND
const SHIPPING_CONFIG_HASH := "029a4f0a"


static func milliseconds_to_clock(milliseconds: int) -> int:
	return milliseconds * CLOCK_UNITS_PER_MILLISECOND


static func clock_to_milliseconds(clock_units: int) -> float:
	return float(clock_units) / CLOCK_UNITS_PER_MILLISECOND


static func default_game_config() -> Types.GameConfig:
	var config := Types.GameConfig.new()

	config.attacks.combo_table = [
		_attack_entry(4, 4, [_block(3, 1)]),
		_attack_entry(5, 5, [_block(4, 1)]),
		_attack_entry(6, 6, [_block(5, 1)]),
		_attack_entry(7, 7, [_block(6, 1)]),
		_attack_entry(8, 8, [_block(4, 1), _block(3, 1)]),
		_attack_entry(9, 9, [_block(4, 1), _block(4, 1)]),
		_attack_entry(10, 10, [_block(5, 1), _block(5, 1)]),
		_attack_entry(11, 11, [_block(6, 1), _block(5, 1)]),
		_attack_entry(12, -1, [_block(6, 1), _block(6, 1)]),
	]
	config.attacks.shock_table = [
		_attack_entry(3, 3, [_block(6, 1, &"metal")]),
		_attack_entry(4, 4, [_block(6, 2, &"metal")]),
		_attack_entry(5, 5, [_block(6, 3, &"metal")]),
		_attack_entry(6, -1, [_block(6, 4, &"metal")]),
	]

	config.scoring.combo_table = [
		_score_entry(4, 4, 20),
		_score_entry(5, 5, 30),
		_score_entry(6, 6, 50),
		_score_entry(7, 7, 60),
		_score_entry(8, 8, 70),
		_score_entry(9, 9, 80),
		_score_entry(10, 10, 100),
		_score_entry(11, 11, 140),
		_score_entry(12, 12, 170),
		_score_entry(13, 13, 210),
		_score_entry(14, 14, 250),
		_score_entry(15, -1, 290),
	]
	config.scoring.chain_table = [
		_score_entry(2, 2, 50),
		_score_entry(3, 3, 80),
		_score_entry(4, 4, 150),
		_score_entry(5, 5, 300),
		_score_entry(6, 6, 400),
		_score_entry(7, 7, 500),
		_score_entry(8, 8, 700),
		_score_entry(9, 9, 900),
		_score_entry(10, 10, 1100),
		_score_entry(11, 11, 1300),
		_score_entry(12, 12, 1500),
		_score_entry(13, -1, 1800),
	]

	return config


static func _block(
	width: int,
	height: int,
	type: StringName = &"normal",
) -> Types.AttackBlock:
	return Types.AttackBlock.new(width, height, type)


static func _attack_entry(
	minimum: int,
	maximum: int,
	blocks: Array[Types.AttackBlock],
) -> Types.AttackTableEntry:
	return Types.AttackTableEntry.new(minimum, maximum, blocks)


static func _score_entry(
	minimum: int,
	maximum: int,
	points: int,
) -> Types.ScoreTableEntry:
	return Types.ScoreTableEntry.new(minimum, maximum, points)
