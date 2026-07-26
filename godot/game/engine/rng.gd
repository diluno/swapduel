extends RefCounted

const UINT32_MASK := 0xFFFFFFFF
const UINT32_RANGE := 0x100000000


class RandomResult extends RefCounted:
	var random_state: int
	var value: float

	func _init(state: int, random_value: float) -> void:
		random_state = state
		value = random_value


class RandomIntegerResult extends RefCounted:
	var random_state: int
	var value: int

	func _init(state: int, random_value: int) -> void:
		random_state = state
		value = random_value


static func seed_to_random_state(seed: String) -> int:
	var hash := 2166136261

	# JavaScript's charCodeAt hashes UTF-16 code units. GDScript iterates Unicode
	# code points, so astral characters must be expanded into their surrogate
	# pair to preserve parity for every possible seed.
	for index in seed.length():
		var codepoint := seed.unicode_at(index)
		if codepoint <= 0xFFFF:
			hash = _fnv_code_unit(hash, codepoint)
		else:
			var adjusted := codepoint - 0x10000
			hash = _fnv_code_unit(hash, 0xD800 + (adjusted >> 10))
			hash = _fnv_code_unit(hash, 0xDC00 + (adjusted & 0x3FF))

	return hash if hash != 0 else 0x6D2B79F5


static func next_random(random_state: int) -> RandomResult:
	var next_state := random_state & UINT32_MASK
	next_state = (next_state ^ (next_state << 13)) & UINT32_MASK
	next_state = (next_state ^ (next_state >> 17)) & UINT32_MASK
	next_state = (next_state ^ (next_state << 5)) & UINT32_MASK
	return RandomResult.new(next_state, float(next_state) / UINT32_RANGE)


static func random_integer(
	random_state: int,
	maximum_exclusive: int,
) -> RandomIntegerResult:
	assert(maximum_exclusive > 0, "maximum_exclusive must be positive")
	var next := next_random(random_state)
	return RandomIntegerResult.new(
		next.random_state,
		int(floor(next.value * maximum_exclusive)),
	)


static func _fnv_code_unit(hash: int, code_unit: int) -> int:
	return ((hash ^ code_unit) * 16777619) & UINT32_MASK

