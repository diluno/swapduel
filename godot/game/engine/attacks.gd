extends RefCounted

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")


static func combo_attack_blocks(
	clear_size: int,
	config: Types.GameConfig = null,
) -> Array[Types.AttackBlock]:
	var game_config := _config_or_default(config)
	return _table_attack_blocks(clear_size, game_config.attacks.combo_table)


static func shock_attack_blocks(
	clear_size: int,
	config: Types.GameConfig = null,
) -> Array[Types.AttackBlock]:
	var game_config := _config_or_default(config)
	return _table_attack_blocks(clear_size, game_config.attacks.shock_table)


static func chain_attack_blocks(
	chain_level: int,
	columns: int = 6,
) -> Array[Types.AttackBlock]:
	assert(chain_level >= 0, "Chain level cannot be negative")
	assert(columns > 0, "Board must have at least one column")
	if chain_level < 2:
		return []
	return [Types.AttackBlock.new(columns, chain_level - 1, &"normal")]


static func _table_attack_blocks(
	clear_size: int,
	table: Array[Types.AttackTableEntry],
) -> Array[Types.AttackBlock]:
	assert(clear_size >= 0, "Clear size cannot be negative")
	for entry in table:
		if (
			clear_size >= entry.minimum
			and (entry.maximum < 0 or clear_size <= entry.maximum)
		):
			var result: Array[Types.AttackBlock] = []
			for block in entry.blocks:
				result.push_back(block.duplicate_deep())
			return result
	return []


static func _config_or_default(config: Types.GameConfig) -> Types.GameConfig:
	return config if config != null else Config.default_game_config()

