extends RefCounted

const Config = preload("res://game/engine/config.gd")
const Simulation = preload("res://game/engine/simulation.gd")
const Types = preload("res://game/engine/types.gd")
const Garbage = preload("res://game/engine/garbage.gd")

const TRACE_VERSION := 1
const TRACE_NAMES: Array[String] = [
	"smoke-swaps",
	"incoming-garbage",
	"time-limit",
]


static func load_trace(name: String) -> Dictionary:
	var path := _conformance_root().path_join("traces/%s.json" % name)
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	assert(parsed is Dictionary, "Conformance trace is not valid JSON")
	assert(parsed["version"] == TRACE_VERSION, "Unsupported trace version")
	assert(
		parsed["configHash"] == Config.SHIPPING_CONFIG_HASH,
		"Conformance trace config hash does not match",
	)
	return parsed


static func load_checkpoints(name: String) -> Array[Dictionary]:
	var path := _conformance_root().path_join(
		"expected/%s.jsonl" % name,
	)
	var contents := FileAccess.get_file_as_string(path)
	var checkpoints: Array[Dictionary] = []
	for line in contents.split("\n", false):
		var parsed = JSON.parse_string(line)
		assert(parsed is Dictionary, "Conformance checkpoint is invalid")
		checkpoints.push_back(parsed)
	return checkpoints


static func create_initial_state(trace: Dictionary):
	var time_limit_ms := -1
	if trace["timeLimitMs"] != null:
		time_limit_ms = int(trace["timeLimitMs"])
	return Simulation.create_simulation(
		trace["seed"],
		null,
		time_limit_ms,
	)


static func run_trace(trace: Dictionary) -> Array[Dictionary]:
	var state = create_initial_state(trace)
	var events: Array[Dictionary] = []
	for input in trace["inputs"]:
		events.push_back({"type": "input", "event": input})
	for attack in trace["attacks"]:
		events.push_back({"type": "attack", "event": attack})
	events.sort_custom(
		func(left: Dictionary, right: Dictionary) -> bool:
			var left_event: Dictionary = left["event"]
			var right_event: Dictionary = right["event"]
			if left_event["step"] != right_event["step"]:
				return left_event["step"] < right_event["step"]
			return left_event["order"] < right_event["order"],
	)

	var event_index := 0
	var checkpoints: Array[Dictionary] = [_checkpoint(state)]
	for attempted_step in int(trace["steps"]):
		while event_index < events.size():
			var wrapped := events[event_index]
			var event: Dictionary = wrapped["event"]
			if int(event["step"]) != attempted_step:
				break
			if wrapped["type"] == "input":
				if event["kind"] == "swap":
					Simulation.request_swap(
						state,
						int(event["row"]),
						int(event["column"]),
						int(event["direction"]),
					)
				else:
					Simulation.set_manual_raise(state, event["active"])
			else:
				Garbage.enqueue_incoming_garbage(
					state,
					_parse_attack(event),
				)
			event_index += 1

		Simulation.step_simulation(state)
		if state.step % 30 == 0 or attempted_step == int(trace["steps"]) - 1:
			checkpoints.push_back(_checkpoint(state))
		if state.status == &"lost":
			if checkpoints[-1]["step"] != state.step:
				checkpoints.push_back(_checkpoint(state))
			break
	return checkpoints


static func _parse_attack(value: Dictionary) -> Types.IncomingGarbageAttack:
	var blocks: Array[Types.AttackBlock] = []
	for block in value["blocks"]:
		blocks.push_back(
			Types.AttackBlock.new(
				int(block["width"]),
				int(block["height"]),
				StringName(block["type"]),
			),
		)
	var ready_at := -1
	if value.has("readyAt"):
		ready_at = Config.milliseconds_to_clock(int(value["readyAt"]))
	return Types.IncomingGarbageAttack.new(
		value["attackId"],
		int(value["serverSequence"]),
		blocks,
		ready_at,
	)


static func _checkpoint(state) -> Dictionary:
	return {
		"step": state.step,
		"checksum": Simulation.simulation_checksum(state),
		"score": state.score,
		"status": String(state.status),
		"endReason": null if state.end_reason == &"" else String(state.end_reason),
	}


static func _conformance_root() -> String:
	var godot_root := ProjectSettings.globalize_path("res://")
	return godot_root.path_join("../tools/conformance").simplify_path()
