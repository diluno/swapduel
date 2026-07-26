extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")


static func combo_score_bonus(
	clear_size: int,
	config: Types.GameConfig = null,
) -> int:
	var game_config := _config_or_default(config)
	return _table_points(clear_size, game_config.scoring.combo_table)


static func chain_score_bonus(
	chain_level: int,
	config: Types.GameConfig = null,
) -> int:
	var game_config := _config_or_default(config)
	return _table_points(chain_level, game_config.scoring.chain_table)


static func clear_score(
	size: int,
	normal_size: int,
	chain_level: int,
	qualified_for_chain: bool,
	config: Types.GameConfig = null,
) -> int:
	assert(size >= 0 and normal_size >= 0, "Clear sizes cannot be negative")
	var game_config := _config_or_default(config)
	var panels := size * game_config.scoring.panel_points
	var combo := combo_score_bonus(normal_size, game_config)
	var chain := 0
	if qualified_for_chain and chain_level >= 2:
		chain = chain_score_bonus(chain_level, game_config)
	return panels + combo + chain


static func _table_points(
	value: int,
	table: Array[Types.ScoreTableEntry],
) -> int:
	assert(value >= 0, "Score table values cannot be negative")
	for entry in table:
		if (
			value >= entry.minimum
			and (entry.maximum < 0 or value <= entry.maximum)
		):
			return entry.points
	return 0


static func _config_or_default(config: Types.GameConfig) -> Types.GameConfig:
	return config if config != null else Config.default_game_config()

