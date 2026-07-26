extends RefCounted

const NORMAL_PANEL_TYPES: Array[StringName] = [
	&"circle",
	&"triangle",
	&"star",
	&"diamond",
	&"heart",
	&"crescent",
]


class GamePanel extends RefCounted:
	var id: int
	var type: StringName
	var state: StringName = &"idle"
	var row: int
	var column: int
	var offset_x: float = 0.0
	var offset_y: float = 0.0
	var chain_eligible: bool = false
	var chain_id: int = -1
	var animation_started_at: int = -1
	var owner_index: int = -1

	func _init(
		panel_id: int = 0,
		panel_type: StringName = &"circle",
		panel_row: int = 0,
		panel_column: int = 0,
	) -> void:
		id = panel_id
		type = panel_type
		row = panel_row
		column = panel_column

	func reset(
		panel_id: int,
		panel_type: StringName,
		panel_row: int,
		panel_column: int,
	) -> void:
		id = panel_id
		type = panel_type
		state = &"idle"
		row = panel_row
		column = panel_column
		offset_x = 0.0
		offset_y = 0.0
		chain_eligible = false
		chain_id = -1
		animation_started_at = -1
		owner_index = -1

	func duplicate_deep() -> GamePanel:
		var copy := GamePanel.new(id, type, row, column)
		copy.state = state
		copy.offset_x = offset_x
		copy.offset_y = offset_y
		copy.chain_eligible = chain_eligible
		copy.chain_id = chain_id
		copy.animation_started_at = animation_started_at
		return copy


class Board extends RefCounted:
	var columns: int
	var visible_rows: int
	var hidden_rows: int
	var cells: Array[GamePanel] = []
	var incoming_row: Array[StringName] = []
	var next_panel_id: int = 1
	var free_panels: Array[GamePanel] = []

	func _init(
		board_columns: int = 6,
		board_visible_rows: int = 12,
		board_hidden_rows: int = 1,
	) -> void:
		columns = board_columns
		visible_rows = board_visible_rows
		hidden_rows = board_hidden_rows
		cells.resize(columns * visible_rows)
		cells.fill(null)

	func cell_index(row: int, column: int) -> int:
		return row * columns + column

	func is_inside(row: int, column: int) -> bool:
		return (
			row >= 0
			and row < visible_rows
			and column >= 0
			and column < columns
		)

	func get_panel(row: int, column: int) -> GamePanel:
		if not is_inside(row, column):
			return null
		return cells[cell_index(row, column)]

	func set_panel(row: int, column: int, panel: GamePanel) -> void:
		assert(is_inside(row, column), "Panel cell is outside the board")
		var index := cell_index(row, column)
		var previous := cells[index]
		if previous != null and previous != panel:
			previous.owner_index = -1
		if panel != null:
			assert(
				panel.owner_index == -1 or panel.owner_index == index,
				"Panel is already owned by another board cell",
			)
			panel.row = row
			panel.column = column
			panel.owner_index = index
		cells[index] = panel

	func take_panel(row: int, column: int) -> GamePanel:
		if not is_inside(row, column):
			return null
		var index := cell_index(row, column)
		var panel := cells[index]
		cells[index] = null
		if panel != null:
			panel.owner_index = -1
		return panel

	func acquire_panel(
		panel_type: StringName,
		row: int,
		column: int,
	) -> GamePanel:
		var panel: GamePanel
		if free_panels.is_empty():
			panel = GamePanel.new()
		else:
			panel = free_panels.pop_back()
		panel.reset(next_panel_id, panel_type, row, column)
		next_panel_id += 1
		return panel

	func release_panel(panel: GamePanel) -> void:
		assert(panel.owner_index == -1, "Cannot pool a panel still owned by a cell")
		free_panels.push_back(panel)

	func duplicate_deep() -> Board:
		var copy := Board.new(columns, visible_rows, hidden_rows)
		copy.incoming_row.assign(incoming_row)
		copy.next_panel_id = next_panel_id
		for index in cells.size():
			var panel := cells[index]
			if panel != null:
				var panel_copy := panel.duplicate_deep()
				copy.set_panel(panel_copy.row, panel_copy.column, panel_copy)
		return copy

	func assert_ownership() -> void:
		var seen: Dictionary = {}
		for index in cells.size():
			var panel := cells[index]
			if panel == null:
				continue
			assert(panel.owner_index == index, "Panel owner index is stale")
			assert(not seen.has(panel.id), "Panel is referenced by two cells")
			seen[panel.id] = true


class GarbageBlock extends RefCounted:
	var id: int
	var type: StringName
	var column: int
	var row: int
	var width: int
	var height: int
	var conversion_row: int = -1
	var state: StringName = &"falling"
	var fall_progress: float = 0.0

	func _init(
		block_id: int = 0,
		block_type: StringName = &"normal",
		block_column: int = 0,
		block_row: int = 0,
		block_width: int = 1,
		block_height: int = 1,
	) -> void:
		id = block_id
		type = block_type
		column = block_column
		row = block_row
		width = block_width
		height = block_height

	func duplicate_deep() -> GarbageBlock:
		var copy := GarbageBlock.new(id, type, column, row, width, height)
		copy.conversion_row = conversion_row
		copy.state = state
		copy.fall_progress = fall_progress
		return copy


class AttackBlock extends RefCounted:
	var width: int
	var height: int
	var type: StringName

	func _init(
		block_width: int = 1,
		block_height: int = 1,
		block_type: StringName = &"normal",
	) -> void:
		width = block_width
		height = block_height
		type = block_type

	func duplicate_deep() -> AttackBlock:
		return AttackBlock.new(width, height, type)

	func to_dictionary() -> Dictionary:
		return {"width": width, "height": height, "type": String(type)}


class IncomingGarbageAttack extends RefCounted:
	var attack_id: String
	var server_sequence: int
	var blocks: Array[AttackBlock] = []
	## Integer simulation clock units, or -1 to use the standard telegraph.
	var ready_at: int = -1

	func _init(
		id: String = "",
		sequence: int = 0,
		attack_blocks: Array[AttackBlock] = [],
		ready_clock: int = -1,
	) -> void:
		attack_id = id
		server_sequence = sequence
		blocks.assign(attack_blocks)
		ready_at = ready_clock

	func duplicate_deep() -> IncomingGarbageAttack:
		return duplicate_with_blocks(blocks)

	func duplicate_with_blocks(
		replacement_blocks: Array[AttackBlock],
	) -> IncomingGarbageAttack:
		var copied_blocks: Array[AttackBlock] = []
		for block in replacement_blocks:
			copied_blocks.push_back(block.duplicate_deep())
		return IncomingGarbageAttack.new(
			attack_id,
			server_sequence,
			copied_blocks,
			ready_at,
		)


class OutgoingAttack extends RefCounted:
	var sequence: int
	var kind: StringName
	var created_at: int
	var clear_size: int
	var chain_level: int
	var blocks: Array[AttackBlock] = []

	func _init(
		attack_sequence: int = 0,
		attack_kind: StringName = &"combo",
		created_clock: int = 0,
		attack_clear_size: int = 0,
		attack_chain_level: int = 1,
		attack_blocks: Array[AttackBlock] = [],
	) -> void:
		sequence = attack_sequence
		kind = attack_kind
		created_at = created_clock
		clear_size = attack_clear_size
		chain_level = attack_chain_level
		blocks.assign(attack_blocks)

	func duplicate_with_blocks(
		replacement_blocks: Array[AttackBlock],
	) -> OutgoingAttack:
		var copied_blocks: Array[AttackBlock] = []
		for block in replacement_blocks:
			copied_blocks.push_back(block.duplicate_deep())
		return OutgoingAttack.new(
			sequence,
			kind,
			created_at,
			clear_size,
			chain_level,
			copied_blocks,
		)


class Coordinate extends RefCounted:
	var row: int
	var column: int

	func _init(coordinate_row: int = 0, coordinate_column: int = 0) -> void:
		row = coordinate_row
		column = coordinate_column


class PendingSwap extends RefCounted:
	var from: Coordinate
	var to: Coordinate
	var started_at: int

	func _init(
		from_coordinate: Coordinate,
		to_coordinate: Coordinate,
		started_clock: int,
	) -> void:
		from = from_coordinate
		to = to_coordinate
		started_at = started_clock


class ClearGroup extends RefCounted:
	var id: int
	var panel_ids: Array[int] = []
	var chain_id: int
	var garbage_block_ids: Array[int] = []
	var phase: StringName = &"flashing"
	var phase_started_at: int


class ChainState extends RefCounted:
	var id: int
	var level: int
	var started_at: int
	var last_qualifying_event_at: int
	## Negative means the chain is not closing yet.
	var closing_started_at: int = -1
	var status: StringName = &"active"


class ClearEvent extends RefCounted:
	var size: int
	var normal_size: int
	var shock_size: int
	var chain_level: int
	var qualified_for_chain: bool
	var touched_top: bool
	var occurred_at: int
	var attack_sequences: Array[int] = []


class GarbageConversionState extends RefCounted:
	var block_ids: Array[int] = []
	var active_block_id: int
	var next_column: int
	var converted_panel_ids: Array[int] = []
	var next_cell_at: int
	## Negative means converted panels are not ready for release yet.
	var release_at: int = -1


class AttackTableEntry extends RefCounted:
	var minimum: int
	## Negative means that the range has no upper bound.
	var maximum: int
	var blocks: Array[AttackBlock] = []

	func _init(
		entry_minimum: int = 0,
		entry_maximum: int = -1,
		entry_blocks: Array[AttackBlock] = [],
	) -> void:
		minimum = entry_minimum
		maximum = entry_maximum
		blocks.assign(entry_blocks)


class ScoreTableEntry extends RefCounted:
	var minimum: int
	## Negative means that the range has no upper bound.
	var maximum: int
	var points: int

	func _init(
		entry_minimum: int = 0,
		entry_maximum: int = -1,
		entry_points: int = 0,
	) -> void:
		minimum = entry_minimum
		maximum = entry_maximum
		points = entry_points


class BoardConfig extends RefCounted:
	var columns: int = 6
	var visible_rows: int = 12
	var hidden_rows: int = 1
	var starting_rows: int = 6
	var normal_panel_types: int = 5
	var shock_panel_chance: float = 0.025


class TimingConfig extends RefCounted:
	## The simulation clock uses 3 units per millisecond and 50 per 60 Hz step.
	var fixed_step: int = 50
	var swap_duration: int = 100 * 3
	var match_flash_duration: int = 300 * 3
	var clear_duration: int = 220 * 3
	var panel_pop_interval: int = 90 * 3
	var fall_delay: int = 100 * 3
	var fall_cells_per_second: float = 18.0
	var garbage_fall_cells_per_second: float = 12.0
	var garbage_cell_convert: int = 45 * 3
	var garbage_release_delay: int = 150 * 3
	var garbage_telegraph: int = 1200 * 3
	var chain_window: int = 250 * 3
	var combo_stop_base: int = 450 * 3
	var combo_stop_per_panel: int = 120 * 3
	var chain_stop_base: int = 650 * 3
	var chain_stop_per_level: int = 300 * 3
	var maximum_stop_time: int = 3000 * 3
	var danger_grace: int = 3000 * 3


class RiseConfig extends RefCounted:
	var starting_rows_per_second: float = 0.12
	var speed_increase_interval_seconds: float = 15.0
	var speed_multiplier_per_increase: float = 1.12
	var maximum_rows_per_second: float = 0.5
	var manual_rows_per_second: float = 0.9
	var manual_stop_drain_multiplier: float = 3.0


class AttackConfig extends RefCounted:
	var combo_table: Array[AttackTableEntry] = []
	var shock_table: Array[AttackTableEntry] = []


class ScoringConfig extends RefCounted:
	var panel_points: int = 10
	var combo_table: Array[ScoreTableEntry] = []
	var chain_table: Array[ScoreTableEntry] = []


class SimulationState extends RefCounted:
	var seed: String = ""
	var random_state: int = 0
	var garbage_random_state: int = 0
	var conversion_random_state: int = 0
	var step: int = 0
	## Three clock units equal one millisecond.
	var elapsed_clock: int = 0
	var board := Board.new()
	var rise_offset: float = 0.0
	var rise_speed: float = 0.0
	var stop_time_remaining: int = 0
	## Negative means the board is not currently in danger.
	var danger_remaining: int = -1
	var manual_raise: bool = false
	var status: StringName = &"playing"
	## Negative means an untimed run.
	var time_limit: int = -1
	var end_reason: StringName = &""
	var phase: StringName = &"idle"
	var phase_started_at: int = 0
	var matched_panel_ids: Array[int] = []
	var clears: Array[ClearGroup] = []
	var next_clear_id: int = 1
	var pending_swap: PendingSwap = null
	var chain: ChainState = null
	var next_chain_id: int = 1
	var outgoing_attacks: Array[OutgoingAttack] = []
	var next_attack_sequence: int = 1
	var last_clear_event: ClearEvent = null
	var garbage: Array[GarbageBlock] = []
	var incoming_garbage: Array[IncomingGarbageAttack] = []
	var received_attack_ids: Array[String] = []
	var received_attack_sequences: Array[int] = []
	var next_garbage_id: int = 1
	var garbage_conversion: GarbageConversionState = null
	var total_cleared: int = 0
	var last_clear_size: int = 0
	var score: int = 0


class GameConfig extends RefCounted:
	var board := BoardConfig.new()
	var timing := TimingConfig.new()
	var rise := RiseConfig.new()
	var attacks := AttackConfig.new()
	var scoring := ScoringConfig.new()
