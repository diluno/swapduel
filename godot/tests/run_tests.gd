extends SceneTree

const Types = preload("res://game/engine/types.gd")
const Config = preload("res://game/engine/config.gd")
const Rng = preload("res://game/engine/rng.gd")
const BoardEngine = preload("res://game/engine/board.gd")
const Matches = preload("res://game/engine/matches.gd")
const Gravity = preload("res://game/engine/gravity.gd")
const Scoring = preload("res://game/engine/scoring.gd")
const Attacks = preload("res://game/engine/attacks.gd")
const Garbage = preload("res://game/engine/garbage.gd")
const Cancellation = preload("res://game/engine/cancellation.gd")
const Danger = preload("res://game/engine/danger.gd")
const Simulation = preload("res://game/engine/simulation.gd")
const Conformance = preload("res://game/engine/conformance.gd")
const Recovery = preload("res://game/engine/recovery.gd")
const MainScreen = preload("res://game/main.gd")
const BoardView = preload("res://game/presentation/board_view.gd")
const GameSettings = preload("res://game/settings/settings.gd")

var _checks := 0
var _failures := 0


func _initialize() -> void:
	_test_exact_clock()
	_test_rng_fixture()
	_test_board_generation()
	_test_matches()
	_test_gravity()
	_test_scoring()
	_test_attacks()
	_test_garbage()
	_test_cancellation()
	_test_danger()
	_test_simulation_state()
	_test_swapping()
	_test_simulation_resolution()
	_test_recovery()
	_test_board_rise_projection()
	_test_offline_shell()
	_test_native_settings()
	_test_conformance_initial_states()

	if _failures == 0:
		print("Swapduel Godot engine: %d checks passed." % _checks)
	else:
		printerr(
			"Swapduel Godot engine: %d of %d checks failed."
			% [_failures, _checks],
		)
	quit(1 if _failures > 0 else 0)


func _test_exact_clock() -> void:
	_check(Config.CLOCK_UNITS_PER_STEP == 50, "one step is 50 clock units")
	_check(
		Config.milliseconds_to_clock(220) == 660,
		"220 ms stays exact in the integer clock",
	)
	_check(
		Config.clock_to_milliseconds(50) == 1000.0 / 60.0,
		"clock units derive the expected display milliseconds",
	)


func _test_rng_fixture() -> void:
	var fixture_text := FileAccess.get_file_as_string(
		"res://tests/fixtures/rng-golden.json",
	)
	_check(not fixture_text.is_empty(), "RNG fixture can be read")
	var fixture = JSON.parse_string(fixture_text)
	_check(fixture is Dictionary, "RNG fixture is valid JSON")
	if not fixture is Dictionary:
		return

	for seed_case in fixture["seeds"]:
		_check(
			Rng.seed_to_random_state(seed_case["seed"])
				== int(seed_case["randomState"]),
			"seed hash matches TypeScript for %s" % seed_case["seed"],
		)

	for sequence in fixture["sequences"]:
		var random_state := Rng.seed_to_random_state(sequence["seed"])
		for index in sequence["states"].size():
			var next := Rng.next_random(random_state)
			random_state = next.random_state
			_check(
				random_state == int(sequence["states"][index]),
				"RNG %s output %d matches TypeScript"
				% [sequence["seed"], index + 1],
			)


func _test_board_generation() -> void:
	var fixture_text := FileAccess.get_file_as_string(
		"res://tests/fixtures/board-golden.json",
	)
	var fixture = JSON.parse_string(fixture_text)
	_check(fixture is Dictionary, "board fixture is valid JSON")
	if fixture is Dictionary:
		for board_case in fixture["cases"]:
			var initial := BoardEngine.create_initial_board(
				int(board_case["initialRandomState"]),
			)
			_check(
				initial.random_state == int(board_case["initial"]["randomState"]),
				"initial board RNG state matches TypeScript for %s"
				% board_case["seed"],
			)
			_check(
				_variants_equal(
					_board_snapshot(initial.board),
					board_case["initial"]["board"],
				),
				"initial board matches TypeScript for %s" % board_case["seed"],
			)
			var inserted := BoardEngine.insert_incoming_row(
				initial.board,
				initial.random_state,
			)
			_check(
				inserted.random_state
					== int(board_case["inserted"]["randomState"]),
				"inserted row RNG state matches TypeScript for %s"
				% board_case["seed"],
			)
			_check(
				inserted.topped_out == board_case["inserted"]["toppedOut"],
				"inserted row top-out matches TypeScript for %s"
				% board_case["seed"],
			)
			_check(
				_variants_equal(
					_board_snapshot(inserted.board),
					board_case["inserted"]["board"],
				),
				"inserted row matches TypeScript for %s" % board_case["seed"],
			)

	for index in 100:
		var seed := "seed-%d" % index
		var first := BoardEngine.create_initial_board(
			Rng.seed_to_random_state(seed),
		)
		var second := BoardEngine.create_initial_board(
			Rng.seed_to_random_state(seed),
		)
		_check(
			_board_signature(first.board) == _board_signature(second.board),
			"board generation is deterministic for %s" % seed,
		)
		_check(
			Matches.find_matches(first.board).is_empty(),
			"initial board has no automatic match for %s" % seed,
		)

	var initial := BoardEngine.create_initial_board(
		Rng.seed_to_random_state("incoming"),
	)
	var first_row := BoardEngine.generate_incoming_row(
		initial.board,
		initial.random_state,
	)
	var second_row := BoardEngine.generate_incoming_row(
		initial.board,
		initial.random_state,
	)
	_check(
		first_row.row == second_row.row
			and first_row.random_state == second_row.random_state,
		"incoming row generation is deterministic",
	)
	initial.board.incoming_row.assign(first_row.row)
	var inserted := BoardEngine.insert_incoming_row(
		initial.board,
		first_row.random_state,
	)
	_check(not inserted.topped_out, "safe incoming row can be inserted")
	_check(
		Matches.find_matches(inserted.board).is_empty(),
		"inserted incoming row creates no automatic match",
	)

	var shock_config := Config.default_game_config()
	shock_config.board.shock_panel_chance = 1.0
	var shock_board := BoardEngine.create_initial_board(
		Rng.seed_to_random_state("shock-generation"),
		shock_config,
	)
	var shock_count := 0
	for panel in shock_board.board.cells:
		if panel != null and panel.type == &"shock":
			shock_count += 1
	_check(shock_count > 0, "forced shock generation creates shock panels")
	_check(
		Matches.find_matches(shock_board.board).is_empty(),
		"generated shock panels stay isolated",
	)
	_check(
		shock_board.board.incoming_row.has(&"shock"),
		"incoming row can contain an isolated shock panel",
	)


func _test_matches() -> void:
	var horizontal := _board_with([
		[0, 1, &"circle"],
		[0, 2, &"circle"],
		[0, 3, &"circle"],
	])
	_check(
		Matches.find_matches(horizontal)
			== [Vector2i(1, 0), Vector2i(2, 0), Vector2i(3, 0)],
		"horizontal match is found",
	)

	var vertical := _board_with([
		[0, 4, &"heart"],
		[1, 4, &"circle"],
		[2, 4, &"triangle"],
		[3, 4, &"triangle"],
		[4, 4, &"triangle"],
	])
	_check(
		Matches.find_matches(vertical)
			== [Vector2i(4, 2), Vector2i(4, 3), Vector2i(4, 4)],
		"grounded vertical match is found",
	)

	var crossing := _board_with([
		[2, 1, &"star"],
		[2, 2, &"star"],
		[2, 3, &"star"],
		[1, 2, &"star"],
		[3, 2, &"star"],
		[0, 1, &"heart"],
		[1, 1, &"circle"],
		[0, 2, &"circle"],
		[0, 3, &"heart"],
		[1, 3, &"circle"],
	])
	_check(
		Matches.find_matches(crossing).size() == 5,
		"intersecting match deduplicates its center",
	)

	var shock := _board_with([
		[0, 0, &"shock"],
		[0, 1, &"shock"],
		[1, 1, &"shock"],
	])
	_check(
		Matches.find_matches(shock)
			== [Vector2i(0, 0), Vector2i(1, 0), Vector2i(1, 1)],
		"orthogonally connected shock group is found",
	)


func _test_gravity() -> void:
	var board := _board_with([
		[2, 0, &"circle"],
		[5, 0, &"triangle"],
		[4, 3, &"heart"],
	])
	var result := Gravity.apply_gravity(board)
	_check(
		result.board.get_panel(0, 0).type == &"circle"
			and result.board.get_panel(1, 0).type == &"triangle"
			and result.board.get_panel(0, 3).type == &"heart",
		"gravity preserves panel order while compacting",
	)
	_check(result.moved_panel_ids == [1, 2, 3], "gravity reports moved panels")
	_check(Gravity.is_board_stable(board), "compacted board is stable")
	_check(
		not Gravity.is_board_stable(_board_with([[1, 0, &"diamond"]])),
		"unsupported panel is unstable",
	)


func _test_scoring() -> void:
	_check(Scoring.combo_score_bonus(3) == 0, "three-panel combo has no bonus")
	_check(Scoring.combo_score_bonus(10) == 100, "combo table is ported")
	_check(Scoring.combo_score_bonus(40) == 290, "combo table upper range works")
	_check(Scoring.chain_score_bonus(4) == 150, "chain table is ported")
	_check(Scoring.chain_score_bonus(30) == 1800, "chain upper range works")
	_check(
		Scoring.clear_score(5, 5, 3, true) == 160,
		"clear score stacks panels, combo, and chain bonuses",
	)


func _test_attacks() -> void:
	_check(
		_block_dicts(Attacks.combo_attack_blocks(3)).is_empty(),
		"three-panel clear sends no combo garbage",
	)
	_check(
		_block_dicts(Attacks.combo_attack_blocks(8))
			== [
				{"width": 4, "height": 1, "type": "normal"},
				{"width": 3, "height": 1, "type": "normal"},
			],
		"combo attack table is ported",
	)
	_check(
		_block_dicts(Attacks.shock_attack_blocks(6))
			== [{"width": 6, "height": 4, "type": "metal"}],
		"shock attack table is ported",
	)
	_check(
		_block_dicts(Attacks.chain_attack_blocks(3))
			== [{"width": 6, "height": 2, "type": "normal"}],
		"chain attack dimensions are ported",
	)


func _test_garbage() -> void:
	var first := _garbage_block(1, &"normal", 0, 1, 3, 1)
	var connected := _garbage_block(2, &"normal", 3, 1, 3, 1)
	var diagonal := _garbage_block(3, &"normal", 3, 2, 2, 1)
	var metal := _garbage_block(4, &"metal", 3, 1, 3, 1)
	_check(
		Garbage.garbage_occupies_cell(first, 1, 2),
		"garbage occupies cells inside its rectangle",
	)
	_check(
		not Garbage.garbage_occupies_cell(first, 1, 3),
		"garbage excludes cells outside its rectangle",
	)
	_check(
		Garbage.garbage_blocks_are_connected(first, connected),
		"same-type garbage connects along a shared edge",
	)
	_check(
		not Garbage.garbage_blocks_are_connected(first, diagonal),
		"garbage does not connect diagonally",
	)
	_check(
		not Garbage.garbage_blocks_are_connected(first, metal),
		"normal and metal garbage remain separate",
	)

	var touched: Array[Types.GarbageBlock] = [first, connected, metal]
	_check(
		Garbage.garbage_blocks_touched_by_clear(
			touched,
			[Vector2i(0, 0), Vector2i(1, 0), Vector2i(2, 0)],
		) == [1, 2],
		"a clear cracks connected garbage of only the same type",
	)

	var queue_state := Types.SimulationState.new()
	queue_state.board = BoardEngine.create_empty_board()
	queue_state.elapsed_clock = 150
	var second_attack := _incoming_attack(
		2,
		[_attack_block(4, 1)],
		-1,
		"attack-2",
	)
	var first_attack := _incoming_attack(
		1,
		[_attack_block(3, 1)],
		-1,
		"attack-1",
	)
	_check(
		Garbage.enqueue_incoming_garbage(queue_state, second_attack),
		"valid incoming garbage is accepted",
	)
	_check(
		Garbage.enqueue_incoming_garbage(queue_state, first_attack),
		"earlier incoming garbage is accepted",
	)
	_check(
		queue_state.incoming_garbage[0].attack_id == "attack-1"
			and queue_state.incoming_garbage[1].attack_id == "attack-2",
		"incoming garbage is ordered by server sequence",
	)
	_check(
		queue_state.incoming_garbage[0].ready_at
			== 150 + Config.default_game_config().timing.garbage_telegraph,
		"incoming garbage receives the exact telegraph deadline",
	)
	_check(
		not Garbage.enqueue_incoming_garbage(
			queue_state,
			_incoming_attack(
				3,
				[_attack_block(6, 2, &"metal")],
				-1,
				"attack-1",
			),
		),
		"duplicate attack IDs are ignored",
	)
	_check(
		not Garbage.enqueue_incoming_garbage(
			queue_state,
			_incoming_attack(
				2,
				[_attack_block(6, 1, &"metal")],
				-1,
				"different-id",
			),
		),
		"duplicate server sequences are ignored",
	)

	var placement_seed := Rng.seed_to_random_state(
		"garbage-placement:garbage",
	)
	var first_placement := _placement_state(placement_seed, 3)
	var second_placement := _placement_state(placement_seed, 3)
	var row_random_state := first_placement.random_state
	_check(
		Garbage.place_next_garbage_block(first_placement),
		"queued garbage block can be placed",
	)
	Garbage.place_next_garbage_block(second_placement)
	_check(
		first_placement.garbage[0].column
			== second_placement.garbage[0].column,
		"partial-width garbage placement is deterministic",
	)
	_check(
		first_placement.garbage[0].row == 12
			and first_placement.garbage[0].width == 3
			and first_placement.garbage[0].state == &"falling",
		"garbage starts above the visible board as one rectangle",
	)
	_check(
		first_placement.random_state == row_random_state,
		"garbage placement does not consume row-generation RNG",
	)

	var support_entries: Array = []
	for row in 6:
		for column in 6:
			support_entries.push_back(
				[row, column, &"circle" if (row + column) % 2 == 0 else &"heart"],
			)
	var falling_state := Types.SimulationState.new()
	falling_state.board = _board_with(support_entries)
	falling_state.garbage = [
		_garbage_block(1, &"normal", 1, 12, 3, 1, &"falling"),
	]
	for _step in 30:
		Garbage.advance_falling_garbage(falling_state)
	_check(
		falling_state.garbage[0].row == 6
			and falling_state.garbage[0].state == &"idle"
			and falling_state.garbage[0].fall_progress == 0.0,
		"falling garbage settles intact on the stack",
	)


func _test_cancellation() -> void:
	var even := Cancellation.cancel_incoming_garbage(
		[_incoming_attack(1, [_attack_block(6, 1)])],
		[_outgoing_attack(1, [_attack_block(6, 1)])],
	)
	_check(
		even.incoming_garbage.is_empty()
			and even.attacks.is_empty()
			and even.cancelled_cells == 6,
		"even garbage exchange cancels both sides",
	)

	var next_row := Cancellation.cancel_incoming_garbage(
		[_incoming_attack(1, [_attack_block(6, 2)])],
		[_outgoing_attack(1, [_attack_block(6, 1)])],
	)
	_check(
		_block_dicts(next_row.incoming_garbage[0].blocks)
			== [{"width": 6, "height": 1, "type": "normal"}],
		"cancellation spends a whole row before the next",
	)

	var narrowed := Cancellation.cancel_incoming_garbage(
		[_incoming_attack(1, [_attack_block(6, 1)])],
		[_outgoing_attack(1, [_attack_block(4, 1)])],
	)
	_check(
		_block_dicts(narrowed.incoming_garbage[0].blocks)
			== [{"width": 2, "height": 1, "type": "normal"}]
			and narrowed.attacks.is_empty()
			and narrowed.cancelled_cells == 4,
		"a smaller attack dents the queued row",
	)

	var rectangular := Cancellation.cancel_incoming_garbage(
		[_incoming_attack(1, [_attack_block(6, 2)])],
		[_outgoing_attack(1, [_attack_block(3, 1)])],
	)
	_check(
		_block_dicts(rectangular.incoming_garbage[0].blocks)
			== [
				{"width": 3, "height": 1, "type": "normal"},
				{"width": 6, "height": 1, "type": "normal"},
			],
		"partially cancelled slabs remain rectangular",
	)

	var surplus := Cancellation.cancel_incoming_garbage(
		[_incoming_attack(1, [_attack_block(3, 1)])],
		[_outgoing_attack(1, [_attack_block(6, 2)])],
	)
	_check(
		surplus.incoming_garbage.is_empty()
			and _block_dicts(surplus.attacks[0].blocks)
				== [
					{"width": 3, "height": 1, "type": "normal"},
					{"width": 6, "height": 1, "type": "normal"},
				],
		"only surplus offence remains after cancellation",
	)

	var queue_order := Cancellation.cancel_incoming_garbage(
		[
			_incoming_attack(1, [_attack_block(3, 1)]),
			_incoming_attack(2, [_attack_block(6, 1)]),
		],
		[_outgoing_attack(1, [_attack_block(3, 1)])],
	)
	_check(
		queue_order.incoming_garbage.size() == 1
			and queue_order.incoming_garbage[0].server_sequence == 2,
		"cancellation consumes the earliest queued attack first",
	)


func _test_danger() -> void:
	var state := Types.SimulationState.new()
	state.board = _board_with([[11, 0, &"circle"]])
	state.manual_raise = true
	Danger.advance_danger_state(state)
	var grace := Config.default_game_config().timing.danger_grace
	_check(
		state.danger_remaining == grace
			and state.status == &"playing"
			and not state.manual_raise,
		"touching the top enters danger and cancels manual raise",
	)

	Danger.advance_danger_state(state)
	_check(
		state.danger_remaining == grace - Config.CLOCK_UNITS_PER_STEP,
		"danger counts down by one exact simulation step",
	)
	state.phase = &"flashing"
	var paused_at := state.danger_remaining
	Danger.advance_danger_state(state)
	_check(
		state.danger_remaining == paused_at,
		"danger pauses while the board is settling",
	)
	state.phase = &"idle"
	state.board = BoardEngine.create_empty_board()
	Danger.advance_danger_state(state)
	_check(
		state.danger_remaining == -1,
		"danger clears when the top is unblocked",
	)

	var timeout := Types.SimulationState.new()
	timeout.board = _board_with([[11, 0, &"triangle"]])
	Danger.advance_danger_state(timeout)
	for _step in grace / Config.CLOCK_UNITS_PER_STEP:
		Danger.advance_danger_state(timeout)
	_check(
		timeout.danger_remaining == 0
			and timeout.status == &"lost"
			and timeout.end_reason == &"topped-out",
		"danger loses after the full configured grace period",
	)

	var garbage_danger := Types.SimulationState.new()
	garbage_danger.board = BoardEngine.create_empty_board()
	garbage_danger.garbage = [
		_garbage_block(1, &"normal", 0, 11, 6, 1, &"idle"),
	]
	_check(
		Danger.board_touches_top(garbage_danger),
		"settled garbage can block the danger line",
	)
	garbage_danger.garbage[0].state = &"falling"
	_check(
		not Danger.board_touches_top(garbage_danger),
		"falling garbage does not start danger before landing",
	)


func _test_simulation_state() -> void:
	var first := Simulation.create_simulation("simulation-state")
	var second := Simulation.create_simulation("simulation-state")
	_check(first.step == 0 and first.elapsed_clock == 0, "simulation starts at step zero")
	_check(
		Simulation.simulation_checksum(first)
			== Simulation.simulation_checksum(second),
		"same seed creates the same initial checksum",
	)

	var timed := Simulation.create_simulation("timed-state", null, 1000)
	for _step in 60:
		Simulation.step_simulation(timed)
	_check(
		timed.step == 60
			and timed.elapsed_clock == 3000
			and timed.status == &"lost"
			and timed.end_reason == &"time-up",
		"integer clock ends a one-second run at exactly 60 steps",
	)
	var stopped_step := timed.step
	Simulation.step_simulation(timed)
	_check(timed.step == stopped_step, "lost simulation no longer advances")


func _test_swapping() -> void:
	var state := Simulation.create_simulation("swap-panels")
	var left_type := state.board.get_panel(0, 0).type
	var right_type := state.board.get_panel(0, 1).type
	var requested := Simulation.request_swap(state, 0, 0, 1)
	_check(requested.ok, "adjacent panels accept a horizontal swap")
	_check(
		state.pending_swap != null
			and state.board.get_panel(0, 0).state == &"swapping"
			and state.board.get_panel(0, 1).state == &"swapping",
		"accepted swap enters its animation state",
	)
	for _step in 5:
		Simulation.step_simulation(state)
	_check(state.pending_swap != null, "swap remains pending before 100 ms")
	Simulation.step_simulation(state)
	_check(
		state.pending_swap == null
			and state.board.get_panel(0, 0).type == right_type
			and state.board.get_panel(0, 1).type == left_type,
		"swap completes on the sixth exact clock step",
	)

	var empty := Simulation.create_simulation("swap-empty")
	empty.board = _board_with([[0, 0, &"circle"]])
	var into_empty := Simulation.request_swap(empty, 0, 0, 1)
	_check(into_empty.ok, "panel can swap into an adjacent empty cell")
	Simulation.advance_simulation(empty, 100.0)
	_check(
		empty.board.get_panel(0, 0) == null
			and empty.board.get_panel(0, 1).type == &"circle",
		"panel moves into the empty cell after swap duration",
	)

	var invalid := Simulation.create_simulation("invalid-swaps")
	_check(
		Simulation.request_swap(invalid, 0, 0, -1).reason
			== &"outside-board",
		"swap outside the board is rejected",
	)
	invalid.board = BoardEngine.create_empty_board()
	_check(
		Simulation.request_swap(invalid, 0, 0, 1).reason == &"both-empty",
		"swap between two empty cells is rejected",
	)
	invalid.board = _board_with([[0, 0, &"circle"]])
	invalid.garbage = [
		_garbage_block(1, &"normal", 1, 0, 2, 1, &"idle"),
	]
	_check(
		Simulation.request_swap(invalid, 0, 0, 1).reason == &"cell-locked",
		"swap into garbage is rejected",
	)


func _test_simulation_resolution() -> void:
	var state := Simulation.create_simulation("resolution-clear")
	state.board = _board_with([
		[0, 0, &"circle"],
		[0, 1, &"circle"],
		[0, 2, &"circle"],
	])
	state.garbage = [
		_garbage_block(1, &"normal", 0, 1, 3, 1, &"idle"),
	]

	Simulation.step_simulation(state)
	_check(
		state.score == 30
			and state.clears.size() == 1
			and state.clears[0].phase == &"flashing",
		"settled match begins an independently timed clear",
	)

	var saw_locked_chain_panels := false
	for _step in 180:
		Simulation.step_simulation(state)
		if state.garbage_conversion != null:
			var locked_count := 0
			var chain_linked_count := 0
			for panel in state.board.cells:
				if panel != null and panel.state == &"garbage-locked":
					locked_count += 1
					if panel.chain_eligible and panel.chain_id >= 0:
						chain_linked_count += 1
			if locked_count > 0 and locked_count == chain_linked_count:
				saw_locked_chain_panels = true
		if (
			state.garbage.is_empty()
			and state.garbage_conversion == null
			and state.total_cleared == 3
		):
			break

	var remaining_panels := 0
	for panel in state.board.cells:
		if panel != null:
			remaining_panels += 1
	_check(
		state.total_cleared == 3
			and state.garbage.is_empty()
			and state.garbage_conversion == null
			and remaining_panels == 3,
		"touched one-row garbage converts into normal panels",
	)
	_check(
		saw_locked_chain_panels,
		"converted panels inherit the active chain while locked",
	)


func _test_recovery() -> void:
	var state := Simulation.create_simulation("snapshot-seed")
	Simulation.set_manual_raise(state, true)
	for _step in 37:
		Simulation.step_simulation(state)
	var serialized := Recovery.serialize_simulation_snapshot(
		state,
		"match-1:round-1",
		10_000,
	)
	var root = JSON.parse_string(serialized)
	_check(
		root is Dictionary
			and root["version"] == 4
			and root["state"]["elapsedClock"] == state.elapsed_clock
			and root["state"]["elapsedMs"]
				== Config.clock_to_milliseconds(state.elapsed_clock),
		"snapshot uses the version 4 web-compatible clock schema",
	)

	var restored := Recovery.restore_simulation_snapshot(
		serialized,
		"match-1:round-1",
		"snapshot-seed",
		20_000,
		30_000,
	)
	_check(
		restored != null
			and not restored.manual_raise
			and Simulation.simulation_checksum(restored)
				== Simulation.simulation_checksum(state),
		"fresh snapshot restores without changing its checksum",
	)

	var complex := Simulation.create_simulation("complex-snapshot")
	complex.board = _board_with([
		[0, 0, &"triangle"],
		[0, 1, &"triangle"],
		[0, 2, &"triangle"],
	])
	complex.board.incoming_row.assign([
		&"circle",
		&"triangle",
		&"star",
		&"diamond",
		&"heart",
		&"circle",
	])
	complex.garbage = [
		_garbage_block(1, &"normal", 0, 1, 3, 1, &"idle"),
	]
	for _step in 120:
		Simulation.step_simulation(complex)
		if (
			complex.garbage_conversion != null
			and not complex.garbage_conversion.converted_panel_ids.is_empty()
		):
			break
	var complex_serialized := Recovery.serialize_simulation_snapshot(
		complex,
		"solo:complex",
		12_000,
	)
	var complex_restored := Recovery.restore_simulation_snapshot(
		complex_serialized,
		"solo:complex",
		"complex-snapshot",
		13_000,
		5_000,
	)
	_check(
		complex_restored != null
			and complex_restored.garbage_conversion != null
			and Simulation.simulation_checksum(complex_restored)
				== Simulation.simulation_checksum(complex),
		"active clears, chains, garbage, and conversion round-trip",
	)
	_check(
		Recovery.restore_simulation_snapshot(
			serialized,
			"match-1:round-2",
			"snapshot-seed",
			20_000,
			30_000,
		) == null,
		"snapshot from another recovery scope is rejected",
	)
	_check(
		Recovery.restore_simulation_snapshot(
			serialized,
			"match-1:round-1",
			"different-seed",
			20_000,
			30_000,
		) == null,
		"snapshot with another expected seed is rejected",
	)
	_check(
		Recovery.restore_simulation_snapshot(
			serialized,
			"match-1:round-1",
			"snapshot-seed",
			40_001,
			30_000,
		) == null,
		"stale snapshot is rejected",
	)
	_check(
		Recovery.restore_simulation_snapshot(
			"{bad json",
			"match-1:round-1",
			"snapshot-seed",
			20_000,
			30_000,
		) == null,
		"malformed snapshot JSON is rejected",
	)

	var malformed: Dictionary = root.duplicate(true)
	malformed["state"]["board"]["cells"][0][0]["row"] = 9
	_check(
		Recovery.restore_simulation_snapshot(
			JSON.stringify(malformed, "", true, true),
			"match-1:round-1",
			"snapshot-seed",
			20_000,
			30_000,
		) == null,
		"snapshot with inconsistent panel coordinates is rejected",
	)

	var legacy: Dictionary = root.duplicate(true)
	legacy["version"] = 3
	legacy["scopeId"] = "solo:legacy"
	legacy["state"].erase("step")
	legacy["state"].erase("elapsedClock")
	var migrated := Recovery.restore_simulation_snapshot(
		JSON.stringify(legacy, "", true, true),
		"solo:legacy",
		"snapshot-seed",
		11_000,
		5_000,
	)
	_check(
		migrated != null
			and migrated.step == 37
			and migrated.elapsed_clock == 1850,
		"version 3 millisecond snapshot migrates onto the integer clock",
	)


func _test_offline_shell() -> void:
	var shell := MainScreen.new()
	shell.recovery_enabled = false
	shell._build_interface()
	shell._start_round(&"time-trial")
	_check(
		shell.state.status == &"playing"
			and shell.state.time_limit == Config.TIME_TRIAL_DURATION
			and shell._format_remaining(shell.state.time_limit) == "2:00",
		"offline shell starts an exact two-minute time trial",
	)
	for _step in 15:
		Simulation.step_simulation(shell.state)
	var recovery_snapshot := shell._encode_recovery_snapshot(20_000)
	var recovered := shell._decode_recovery_snapshot(
		recovery_snapshot,
		21_000,
	)
	_check(
		not recovered.is_empty()
			and recovered["mode"] == &"time-trial"
			and Simulation.simulation_checksum(recovered["state"])
				== Simulation.simulation_checksum(shell.state),
		"offline shell recovery preserves mode and simulation checksum",
	)
	var wrong_mode = JSON.parse_string(recovery_snapshot)
	wrong_mode["mode"] = "unknown"
	_check(
		shell._decode_recovery_snapshot(
			JSON.stringify(wrong_mode, "", true, true),
			21_000,
		).is_empty(),
		"offline shell rejects recovery metadata for an unknown mode",
	)
	_check(
		shell._decode_recovery_snapshot(
			recovery_snapshot,
			20_000 + shell.RECOVERY_MAX_AGE_MS + 1,
		).is_empty(),
		"offline shell rejects stale recovered runs",
	)
	shell._show_home()
	_check(
		shell.state.status == &"paused" and shell._home_panel.visible,
		"offline shell returns to a paused mode-selection board",
	)
	shell._show_settings()
	_check(
		shell._settings_panel.visible and not shell._home_panel.visible,
		"offline shell opens its native settings panel",
	)
	shell._hide_settings()
	_check(
		not shell._settings_panel.visible and shell._home_panel.visible,
		"offline shell returns from settings to mode selection",
	)
	shell.free()


func _test_native_settings() -> void:
	var settings := GameSettings.new()
	settings.battery_saver = false
	_check(
		settings.presentation_frame_rate() == 60,
		"default presentation frame rate remains 60 fps",
	)
	settings.battery_saver = true
	_check(
		settings.presentation_frame_rate() == 30,
		"battery saver caps presentation without changing simulation",
	)
	settings.free()

	var state := Simulation.create_simulation("reduced-motion")
	var view := BoardView.new()
	view.set_simulation_state(state)
	view.set_reduced_motion(true)
	_check(
		view.reduced_motion,
		"board renderer accepts the reduced-motion preference",
	)
	view.free()


func _test_board_rise_projection() -> void:
	var state := Simulation.create_simulation("rise-projection")
	var view := BoardView.new()
	view.size = Vector2(300.0, 600.0)
	view.set_simulation_state(state)
	var cell := 50.0
	var panel := state.board.get_panel(0, 0)
	var panel_id := panel.id
	state.rise_offset = 1.0
	var before_y := view._row_y(panel.row, cell)
	var inserted := BoardEngine.insert_incoming_row(
		state.board,
		state.random_state,
	)
	state.board = inserted.board
	state.rise_offset = 0.0
	var shifted_panel: Types.GamePanel = null
	for candidate in state.board.cells:
		if candidate != null and candidate.id == panel_id:
			shifted_panel = candidate
			break
	_check(
		shifted_panel != null
			and shifted_panel.offset_y == -1.0
			and view._row_y(shifted_panel.row, cell) == before_y,
		"row insertion keeps panel projection continuous without offset_y",
	)

	state.rise_offset = 0.4
	var panel_center := Vector2(
		cell * 2.5,
		view._row_y(2, cell) + cell * 0.5,
	)
	_check(
		view.coordinate_at(panel_center) == Vector2i(2, 2),
		"pointer coordinates invert the shared rising-row projection",
	)

	view.selected = Vector2i(2, 2)
	view.cursor = Vector2i(1, 2)
	view.cursor_visible = true
	view._pointer_active = true
	view._pointer_row = 2
	view.shift_tracking_for_inserted_row()
	_check(
		view.selected == Vector2i(2, 3)
			and view.cursor == Vector2i(1, 3)
			and view._pointer_row == 3,
		"selection, cursor, and active gesture follow inserted rows",
	)
	view.free()


func _test_conformance_initial_states() -> void:
	for trace_name in Conformance.TRACE_NAMES:
		var trace := Conformance.load_trace(trace_name)
		var checkpoints := Conformance.load_checkpoints(trace_name)
		var state = Conformance.create_initial_state(trace)
		var expected := checkpoints[0]
		_check(expected["step"] == 0, "%s trace starts at step zero" % trace_name)
		_check(
			Simulation.simulation_checksum(state) == expected["checksum"],
			"%s initial checksum matches TypeScript" % trace_name,
		)
		_check(
			state.score == expected["score"]
				and String(state.status) == expected["status"],
			"%s initial summary matches TypeScript" % trace_name,
		)

	var supported_steps := {
		"smoke-swaps": 360,
		"incoming-garbage": 420,
		"time-limit": 60,
	}
	for trace_name in Conformance.TRACE_NAMES:
		var trace := Conformance.load_trace(trace_name)
		var actual := Conformance.run_trace(trace)
		var expected := Conformance.load_checkpoints(trace_name)
		for expected_checkpoint in expected:
			if expected_checkpoint["step"] > supported_steps[trace_name]:
				break
			var actual_checkpoint = actual.filter(
				func(value: Dictionary) -> bool:
					return value["step"] == expected_checkpoint["step"],
			).front()
			_check(
				_variants_equal(actual_checkpoint, expected_checkpoint),
				"%s checkpoint %d matches TypeScript"
				% [trace_name, expected_checkpoint["step"]],
			)


func _board_with(entries: Array) -> Types.Board:
	var board := BoardEngine.create_empty_board()
	for entry in entries:
		var row: int = entry[0]
		var column: int = entry[1]
		var type: StringName = entry[2]
		board.set_panel(row, column, board.acquire_panel(type, row, column))
	board.assert_ownership()
	return board


func _attack_block(
	width: int,
	height: int,
	type: StringName = &"normal",
) -> Types.AttackBlock:
	return Types.AttackBlock.new(width, height, type)


func _incoming_attack(
	sequence: int,
	blocks: Array[Types.AttackBlock],
	ready_at: int = 0,
	id: String = "",
) -> Types.IncomingGarbageAttack:
	var attack_id := id if not id.is_empty() else "attack-%d" % sequence
	return Types.IncomingGarbageAttack.new(
		attack_id,
		sequence,
		blocks,
		ready_at,
	)


func _outgoing_attack(
	sequence: int,
	blocks: Array[Types.AttackBlock],
) -> Types.OutgoingAttack:
	return Types.OutgoingAttack.new(
		sequence,
		&"combo",
		0,
		4,
		1,
		blocks,
	)


func _garbage_block(
	id: int,
	type: StringName,
	column: int,
	row: int,
	width: int,
	height: int,
	state: StringName = &"idle",
) -> Types.GarbageBlock:
	var block := Types.GarbageBlock.new(
		id,
		type,
		column,
		row,
		width,
		height,
	)
	block.state = state
	return block


func _placement_state(
	garbage_random_state: int,
	width: int,
) -> Types.SimulationState:
	var state := Types.SimulationState.new()
	state.seed = "garbage-placement"
	state.random_state = Rng.seed_to_random_state(state.seed)
	state.garbage_random_state = garbage_random_state
	state.board = BoardEngine.create_empty_board()
	state.incoming_garbage = [
		_incoming_attack(1, [_attack_block(width, 1)], 0, "partial"),
	]
	return state


func _board_signature(board: Types.Board) -> String:
	var values: Array[String] = []
	for panel in board.cells:
		values.push_back("-" if panel == null else String(panel.type))
	values.append("|")
	for type in board.incoming_row:
		values.push_back(String(type))
	return ",".join(values)


func _board_snapshot(board: Types.Board) -> Dictionary:
	var cells: Array = []
	for panel in board.cells:
		if panel == null:
			cells.push_back(null)
			continue
		cells.push_back({
			"id": panel.id,
			"type": String(panel.type),
			"state": String(panel.state),
			"row": panel.row,
			"column": panel.column,
			"offsetX": panel.offset_x,
			"offsetY": panel.offset_y,
		})

	var incoming_row: Array[String] = []
	for type in board.incoming_row:
		incoming_row.push_back(String(type))

	return {
		"columns": board.columns,
		"visibleRows": board.visible_rows,
		"hiddenRows": board.hidden_rows,
		"nextPanelId": board.next_panel_id,
		"incomingRow": incoming_row,
		"cells": cells,
	}


func _block_dicts(blocks: Array[Types.AttackBlock]) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for block in blocks:
		result.push_back(block.to_dictionary())
	return result


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		return
	_failures += 1
	printerr("FAIL: %s" % message)


func _variants_equal(left: Variant, right: Variant) -> bool:
	var left_type := typeof(left)
	var right_type := typeof(right)
	var numeric_types := [TYPE_INT, TYPE_FLOAT]

	if left_type in numeric_types and right_type in numeric_types:
		return float(left) == float(right)
	if left_type != right_type:
		return false

	if left_type == TYPE_ARRAY:
		if left.size() != right.size():
			return false
		for index in left.size():
			if not _variants_equal(left[index], right[index]):
				return false
		return true

	if left_type == TYPE_DICTIONARY:
		if left.size() != right.size():
			return false
		for key in left:
			if not right.has(key) or not _variants_equal(left[key], right[key]):
				return false
		return true

	return left == right
