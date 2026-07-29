extends Node

signal connection_state_changed(state: StringName)
signal room_session_changed(session: Dictionary)
signal room_state_changed(room_state: Dictionary)
signal room_error(error: Dictionary)
signal round_prepared(preparation: Dictionary)
signal round_starting(starting: Dictionary)
signal opponent_snapshot_received(snapshot: Dictionary)
signal attack_incoming(attack: Dictionary)
signal attack_confirmed(attack: Dictionary)
signal top_out_accepted
signal desync_detected(diagnostic: Dictionary)
signal clock_synchronized(offset_ms: float, round_trip_ms: float)
signal opponent_snapshot_cleared
signal round_ended(result: Dictionary)
signal match_ended(result: Dictionary)
signal match_paused(pause: Dictionary)
signal match_resuming(resume: Dictionary)
signal event_received(event: StringName, payload: Variant)

const PROTOCOL_VERSION := 1
const DEFAULT_WEBSOCKET_URL := "wss://swapduel.dil.uno/native"
const SESSION_PATH := "user://online-session.cfg"
const RECONNECT_DELAYS_MS := [500, 1000, 2000, 4000, 8000]
const TOP_OUT_RETRY_MS := 1000

const STATE_DISCONNECTED: StringName = &"disconnected"
const STATE_CONNECTING: StringName = &"connecting"
const STATE_CONNECTED: StringName = &"connected"

var connection_state: StringName = STATE_DISCONNECTED
var room_session: Dictionary = {}
var room_state: Dictionary = {}
var round_preparation: Dictionary = {}
var round_start: Dictionary = {}
var opponent_snapshot: Dictionary = {}
var incoming_attacks: Array[Dictionary] = []
var round_result: Dictionary = {}
var match_result: Dictionary = {}
var network_pause: Dictionary = {}
var network_resume: Dictionary = {}
var clock_offset_ms := 0.0
var round_trip_ms := 0.0

var _peer: WebSocketPeer
var _server_url := DEFAULT_WEBSOCKET_URL
var _last_ready_state := WebSocketPeer.STATE_CLOSED
var _next_request_id := 1
var _pending_requests: Dictionary = {}
var _queued_frames: Array[Dictionary] = []
var _intentional_close := false
var _reconnect_attempt := 0
var _reconnect_at_ms := -1
var _reconnect_session_after_open := false
var _pending_attacks: Dictionary = {}
var _attack_retry_at_ms := -1
var _pending_top_out: Dictionary = {}
var _top_out_retry_at_ms := -1
var _top_out_request_in_flight := false


func _ready() -> void:
	_server_url = String(ProjectSettings.get_setting(
		"swapduel/network/websocket_url",
		DEFAULT_WEBSOCKET_URL,
	))
	_load_session()


func _process(_delta: float) -> void:
	if _peer != null:
		_peer.poll()
		var ready_state := _peer.get_ready_state()
		if (
			ready_state == WebSocketPeer.STATE_OPEN
			and _last_ready_state != WebSocketPeer.STATE_OPEN
		):
			_on_connected()
		elif (
			ready_state == WebSocketPeer.STATE_CLOSED
			and _last_ready_state != WebSocketPeer.STATE_CLOSED
		):
			_on_disconnected()
		_last_ready_state = ready_state
		if ready_state == WebSocketPeer.STATE_OPEN:
			while _peer.get_available_packet_count() > 0:
				_receive_packet(_peer.get_packet())

	if (
		_reconnect_at_ms >= 0
		and Time.get_ticks_msec() >= _reconnect_at_ms
	):
		_reconnect_at_ms = -1
		connect_to_server(true)
	if (
		_attack_retry_at_ms >= 0
		and Time.get_ticks_msec() >= _attack_retry_at_ms
		and connection_state == STATE_CONNECTED
	):
		_attack_retry_at_ms = -1
		_retry_pending_attacks()
	if (
		_top_out_retry_at_ms >= 0
		and Time.get_ticks_msec() >= _top_out_retry_at_ms
	):
		_top_out_retry_at_ms = -1
		_retry_pending_top_out()


func connect_to_server(reconnect_session := false) -> Error:
	if (
		_peer != null
		and _peer.get_ready_state() in [
			WebSocketPeer.STATE_CONNECTING,
			WebSocketPeer.STATE_OPEN,
		]
	):
		_reconnect_session_after_open = (
			_reconnect_session_after_open or reconnect_session
		)
		return OK

	_intentional_close = false
	_reconnect_session_after_open = reconnect_session
	_peer = WebSocketPeer.new()
	_peer.inbound_buffer_size = 64 * 1024
	_peer.outbound_buffer_size = 64 * 1024
	_last_ready_state = WebSocketPeer.STATE_CLOSED
	var error := _peer.connect_to_url(_server_url)
	if error != OK:
		_set_connection_state(STATE_DISCONNECTED)
		_schedule_reconnect()
		return error
	_set_connection_state(STATE_CONNECTING)
	return OK


func disconnect_from_server() -> void:
	_intentional_close = true
	_reconnect_at_ms = -1
	_reconnect_attempt = 0
	if _peer != null and _peer.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		_peer.close(1000, "Client closed")
	_set_connection_state(STATE_DISCONNECTED)


func create_room(display_name: String) -> String:
	clear_saved_session()
	return _request(&"room:create", {
		"displayName": display_name.strip_edges(),
	})


func join_room(room_code: String, display_name: String) -> String:
	clear_saved_session()
	return _request(&"room:join", {
		"roomCode": room_code.strip_edges().to_upper(),
		"displayName": display_name.strip_edges(),
	})


func reconnect_saved_session() -> String:
	if not has_saved_session():
		return ""
	return _request(&"room:reconnect", _credentials())


func set_ready(ready: bool) -> String:
	if not has_saved_session():
		return ""
	var payload := _credentials()
	payload["ready"] = ready
	return _request(&"player:ready", payload)


func start_match() -> String:
	if not has_saved_session():
		return ""
	return _request(&"match:start", _credentials())


func mark_round_ready(preparation: Dictionary = {}) -> String:
	var active_preparation := (
		round_preparation if preparation.is_empty() else preparation
	)
	if not has_saved_session() or not _is_round_payload(active_preparation):
		return ""
	var payload := _credentials()
	payload["matchId"] = String(active_preparation["matchId"])
	payload["roundId"] = String(active_preparation["roundId"])
	return _request(&"round:ready", payload)


func send_board_snapshot(snapshot: Dictionary) -> String:
	if not has_saved_session() or not _has_active_round():
		return ""
	var payload := snapshot.duplicate(true)
	payload["protocolVersion"] = PROTOCOL_VERSION
	payload["matchId"] = String(round_preparation["matchId"])
	payload["roundId"] = String(round_preparation["roundId"])
	payload["playerId"] = String(room_session["playerId"])
	payload["clientTimestamp"] = _unix_time_ms()
	return _request(&"board:snapshot", payload)


func send_simulation_checksum(
	sequence: int,
	simulation_step: int,
	checksum: String,
) -> String:
	if not has_saved_session() or not _has_active_round():
		return ""
	return _request(&"simulation:checksum", {
		"protocolVersion": PROTOCOL_VERSION,
		"matchId": String(round_preparation["matchId"]),
		"roundId": String(round_preparation["roundId"]),
		"playerId": String(room_session["playerId"]),
		"sequence": sequence,
		"simulationStep": simulation_step,
		"checksum": checksum,
		"clientTimestamp": _unix_time_ms(),
	})


func send_attack(attack: Dictionary) -> String:
	if not has_saved_session() or not _has_active_round():
		return ""
	var payload := attack.duplicate(true)
	payload["protocolVersion"] = PROTOCOL_VERSION
	payload["matchId"] = String(round_preparation["matchId"])
	payload["roundId"] = String(round_preparation["roundId"])
	payload["senderId"] = String(room_session["playerId"])
	payload["clientTimestamp"] = _unix_time_ms()
	var attack_id := String(payload.get("attackId", ""))
	if attack_id.is_empty():
		return ""
	_pending_attacks[attack_id] = payload
	_save_session()
	return _request(&"attack:create", payload)


func acknowledge_attack(attack: Dictionary) -> String:
	if not has_saved_session() or not _is_round_payload(attack):
		return ""
	var server_sequence := int(attack.get("serverSequence", -1))
	if server_sequence < 0:
		return ""
	return _request(&"attack:ack", {
		"protocolVersion": PROTOCOL_VERSION,
		"matchId": String(attack["matchId"]),
		"roundId": String(attack["roundId"]),
		"playerId": String(room_session["playerId"]),
		"serverSequence": server_sequence,
	})


func drain_incoming_attacks() -> Array[Dictionary]:
	var attacks := incoming_attacks
	incoming_attacks = []
	return attacks


func report_top_out() -> String:
	if not has_saved_session() or not _has_active_round():
		return ""
	if (
		_pending_top_out.is_empty()
		or not _is_own_round_payload(_pending_top_out)
	):
		_pending_top_out = {
			"protocolVersion": PROTOCOL_VERSION,
			"matchId": String(round_preparation["matchId"]),
			"roundId": String(round_preparation["roundId"]),
			"playerId": String(room_session["playerId"]),
			"clientTimestamp": _unix_time_ms(),
		}
		_save_session()
	if _top_out_request_in_flight:
		return ""
	if (
		connection_state != STATE_CONNECTED
		or _peer == null
		or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN
	):
		connect_to_server(true)
		return ""
	_top_out_request_in_flight = true
	return _request(&"round:topout", _pending_top_out)


func ready_for_next_round() -> String:
	if not has_saved_session() or not _is_round_payload(round_result):
		return ""
	var payload := _credentials()
	payload["matchId"] = String(round_result["matchId"])
	payload["roundId"] = String(round_result["roundId"])
	return _request(&"round:next", payload)


func request_rematch() -> String:
	if not has_saved_session():
		return ""
	var match_id := String(match_result.get("matchId", ""))
	if match_id.is_empty():
		return ""
	var payload := _credentials()
	payload["matchId"] = match_id
	return _request(&"match:rematch", payload)


func sample_clock() -> String:
	return _request(&"ping", _unix_time_ms())


func has_saved_session() -> bool:
	return (
		not String(room_session.get("roomId", "")).is_empty()
		and not String(room_session.get("playerId", "")).is_empty()
		and not String(room_session.get("reconnectToken", "")).is_empty()
	)


func clear_saved_session() -> void:
	room_session = {}
	room_state = {}
	_clear_round_state()
	_pending_attacks.clear()
	_pending_top_out = {}
	_top_out_retry_at_ms = -1
	_top_out_request_in_flight = false
	var directory := DirAccess.open("user://")
	if directory != null and directory.file_exists("online-session.cfg"):
		directory.remove("online-session.cfg")
	room_session_changed.emit(room_session)
	room_state_changed.emit(room_state)


func server_time_ms() -> float:
	return _unix_time_ms() + clock_offset_ms


func set_server_url_for_debug(url: String) -> void:
	_server_url = url.strip_edges()


static func decode_frame(text: String) -> Dictionary:
	var json := JSON.new()
	if json.parse(text) != OK:
		return {}
	var decoded = json.data
	if not decoded is Dictionary:
		return {}
	var frame: Dictionary = decoded
	if int(frame.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		return {}
	var frame_type := String(frame.get("type", ""))
	if frame_type not in ["event", "response"]:
		return {}
	return frame


func _request(event: StringName, payload: Variant) -> String:
	var request_id := "%d-%d" % [Time.get_ticks_msec(), _next_request_id]
	_next_request_id += 1
	var frame := {
		"protocolVersion": PROTOCOL_VERSION,
		"type": "request",
		"requestId": request_id,
		"event": String(event),
		"payload": payload,
	}
	_pending_requests[request_id] = {
		"event": event,
		"payload": payload,
		"sentAt": _unix_time_ms(),
	}
	if _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_send_frame(frame)
	else:
		_queued_frames.push_back(frame)
		connect_to_server(false)
	return request_id


func _send_frame(frame: Dictionary) -> void:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		_queued_frames.push_back(frame)
		return
	var error := _peer.send_text(JSON.stringify(frame))
	if error != OK:
		_queued_frames.push_front(frame)


func _receive_packet(packet: PackedByteArray) -> void:
	var frame := decode_frame(packet.get_string_from_utf8())
	if frame.is_empty():
		room_error.emit({
			"code": "INVALID_REQUEST",
			"message": "The server sent an invalid realtime message.",
		})
		return
	if String(frame.get("type", "")) == "response":
		_handle_response(frame)
	else:
		_handle_event(frame)


func _handle_response(frame: Dictionary) -> void:
	var request_id := String(frame.get("requestId", ""))
	var pending: Dictionary = _pending_requests.get(request_id, {})
	_pending_requests.erase(request_id)
	var result = frame.get("result")
	if not result is Dictionary:
		return
	var response: Dictionary = result
	var event := StringName(pending.get("event", &""))
	if not bool(response.get("ok", false)):
		var error = response.get("error")
		if event == &"attack:create":
			_schedule_attack_retry()
		elif event == &"round:topout":
			_top_out_request_in_flight = false
			if (
				error is Dictionary
				and String(error.get("code", "")) == "RATE_LIMITED"
			):
				_schedule_top_out_retry(
					maxi(
						250,
						int(error.get("retryAfterMs", TOP_OUT_RETRY_MS)),
					),
				)
		if error is Dictionary and _should_surface_request_error(event):
			room_error.emit(error)
		return

	var data = response.get("data")
	if event in [&"room:create", &"room:join", &"room:reconnect"]:
		if data is Dictionary:
			_apply_session(data)
			if event == &"room:reconnect":
				_retry_pending_attacks()
				_retry_pending_top_out()
	elif event == &"player:ready":
		if data is Dictionary:
			_apply_room_state(data)
	elif event in [&"match:start", &"round:next", &"match:rematch"]:
		if data is Dictionary:
			_apply_round_preparation(data)
	elif event == &"round:ready":
		if data is Dictionary:
			_apply_round_start(data)
	elif event == &"attack:create":
		if data is Dictionary:
			_confirm_attack(data)
	elif event == &"round:topout":
		_top_out_request_in_flight = false
		_top_out_retry_at_ms = -1
		_pending_top_out = {}
		_save_session()
		top_out_accepted.emit()
	elif event == &"ping":
		if data is Dictionary:
			_apply_clock_sample(pending, data)


func _handle_event(frame: Dictionary) -> void:
	var event := StringName(String(frame.get("event", "")))
	var payload = frame.get("payload")
	match event:
		&"room:created", &"room:joined":
			if payload is Dictionary:
				_apply_session(payload)
		&"room:state":
			if payload is Dictionary:
				_apply_room_state(payload)
		&"room:error":
			if payload is Dictionary:
				room_error.emit(payload)
		&"match:starting", &"round:prepare":
			if payload is Dictionary:
				_apply_round_preparation(payload)
		&"round:starting":
			if payload is Dictionary:
				_apply_round_start(payload)
		&"opponent:snapshot":
			if payload is Dictionary:
				_apply_opponent_snapshot(payload)
		&"attack:incoming":
			if payload is Dictionary:
				_receive_attack(payload)
		&"attack:confirmed":
			if payload is Dictionary:
				_confirm_attack(payload)
		&"simulation:desync":
			if payload is Dictionary and _is_own_round_payload(payload):
				desync_detected.emit(payload)
		&"round:ended":
			if payload is Dictionary and _is_active_round_payload(payload):
				round_result = payload.duplicate(true)
				incoming_attacks = []
				_pending_attacks.clear()
				_pending_top_out = {}
				_top_out_retry_at_ms = -1
				_top_out_request_in_flight = false
				_save_session()
				round_ended.emit(round_result)
		&"match:ended":
			if payload is Dictionary:
				match_result = payload.duplicate(true)
				_save_session()
				match_ended.emit(match_result)
		&"match:paused":
			if payload is Dictionary and _is_active_round_payload(payload):
				network_pause = payload.duplicate(true)
				match_paused.emit(network_pause)
		&"match:resuming":
			if payload is Dictionary and _is_active_round_payload(payload):
				network_pause = {}
				network_resume = payload.duplicate(true)
				match_resuming.emit(network_resume)
		&"player:reconnected":
			if (
				payload is Dictionary
				and String(payload.get("playerId", ""))
					!= String(room_session.get("playerId", ""))
			):
				opponent_snapshot = {}
				opponent_snapshot_cleared.emit()
		&"pong":
			pass
	event_received.emit(event, payload)


func _apply_session(session: Dictionary) -> void:
	var next_room_state = session.get("roomState")
	if (
		not next_room_state is Dictionary
		or String(session.get("playerId", "")).is_empty()
		or String(session.get("reconnectToken", "")).is_empty()
	):
		return
	room_session = {
		"roomId": String(next_room_state.get("roomId", "")),
		"playerId": String(session.get("playerId", "")),
		"reconnectToken": String(session.get("reconnectToken", "")),
	}
	_save_session()
	room_session_changed.emit(room_session)
	_apply_room_state(next_room_state)


func _apply_room_state(next_room_state: Dictionary) -> void:
	if (
		String(next_room_state.get("roomId", "")).is_empty()
		or String(next_room_state.get("roomCode", "")).is_empty()
		or not next_room_state.get("players") is Array
	):
		return
	room_state = next_room_state.duplicate(true)
	room_state_changed.emit(room_state)


func _apply_round_preparation(preparation: Dictionary) -> void:
	if not _is_round_payload(preparation):
		return
	if (
		not round_preparation.is_empty()
		and String(round_preparation.get("matchId", ""))
			== String(preparation.get("matchId", ""))
		and String(round_preparation.get("roundId", ""))
			== String(preparation.get("roundId", ""))
	):
		return
	round_preparation = preparation.duplicate(true)
	round_start = {}
	opponent_snapshot = {}
	incoming_attacks = []
	_pending_attacks.clear()
	_pending_top_out = {}
	_top_out_retry_at_ms = -1
	_top_out_request_in_flight = false
	round_result = {}
	network_pause = {}
	network_resume = {}
	_save_session()
	round_prepared.emit(round_preparation)


func _apply_round_start(starting: Dictionary) -> void:
	if (
		not _is_active_round_payload(starting)
		or float(starting.get("startAt", 0.0)) <= 0.0
	):
		return
	if (
		not round_start.is_empty()
		and float(round_start.get("startAt", 0.0))
			== float(starting.get("startAt", 0.0))
	):
		return
	round_start = starting.duplicate(true)
	network_pause = {}
	network_resume = {}
	_save_session()
	round_starting.emit(round_start)


func _apply_opponent_snapshot(snapshot: Dictionary) -> void:
	if (
		not _is_active_round_payload(snapshot)
		or String(snapshot.get("playerId", ""))
			== String(room_session.get("playerId", ""))
		or (
			not opponent_snapshot.is_empty()
			and int(snapshot.get("sequence", -1))
				<= int(opponent_snapshot.get("sequence", -1))
		)
	):
		return
	opponent_snapshot = snapshot.duplicate(true)
	opponent_snapshot_received.emit(opponent_snapshot)


func _receive_attack(attack: Dictionary) -> void:
	if (
		not _is_active_round_payload(attack)
		or String(attack.get("targetId", ""))
			!= String(room_session.get("playerId", ""))
	):
		return
	var server_sequence := int(attack.get("serverSequence", -1))
	if server_sequence < 0:
		return
	for queued in incoming_attacks:
		if int(queued.get("serverSequence", -1)) == server_sequence:
			return
	incoming_attacks.push_back(attack.duplicate(true))
	incoming_attacks.sort_custom(
		func(left: Dictionary, right: Dictionary) -> bool:
			return (
				int(left.get("serverSequence", -1))
				< int(right.get("serverSequence", -1))
			),
	)
	attack_incoming.emit(attack)


func _confirm_attack(attack: Dictionary) -> void:
	if String(attack.get("senderId", "")) != String(
		room_session.get("playerId", ""),
	):
		return
	var attack_id := String(attack.get("attackId", ""))
	if attack_id.is_empty() or not _pending_attacks.has(attack_id):
		return
	_pending_attacks.erase(attack_id)
	_save_session()
	attack_confirmed.emit(attack)


func _retry_pending_attacks() -> void:
	if (
		connection_state != STATE_CONNECTED
		or not _has_active_round()
		or not network_pause.is_empty()
	):
		_schedule_attack_retry()
		return
	for attack in _pending_attacks.values():
		if attack is Dictionary:
			_request(&"attack:create", attack)


func _schedule_attack_retry(delay_ms := 750) -> void:
	if _pending_attacks.is_empty():
		_attack_retry_at_ms = -1
		return
	_attack_retry_at_ms = Time.get_ticks_msec() + maxi(100, delay_ms)


func _retry_pending_top_out() -> void:
	if _pending_top_out.is_empty():
		_top_out_retry_at_ms = -1
		return
	if (
		connection_state != STATE_CONNECTED
		or not _has_active_round()
		or _peer == null
		or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN
	):
		connect_to_server(true)
		return
	if _top_out_request_in_flight:
		return
	_top_out_request_in_flight = true
	_request(&"round:topout", _pending_top_out)


func _schedule_top_out_retry(delay_ms := TOP_OUT_RETRY_MS) -> void:
	if _pending_top_out.is_empty():
		_top_out_retry_at_ms = -1
		return
	_top_out_retry_at_ms = Time.get_ticks_msec() + maxi(250, delay_ms)


func _has_active_round() -> bool:
	return _is_round_payload(round_preparation)


func _is_round_payload(payload: Dictionary) -> bool:
	return (
		int(payload.get("protocolVersion", PROTOCOL_VERSION))
			== PROTOCOL_VERSION
		and not String(payload.get("matchId", "")).is_empty()
		and not String(payload.get("roundId", "")).is_empty()
	)


func _is_active_round_payload(payload: Dictionary) -> bool:
	return (
		_has_active_round()
		and _is_round_payload(payload)
		and String(payload.get("matchId", ""))
			== String(round_preparation.get("matchId", ""))
		and String(payload.get("roundId", ""))
			== String(round_preparation.get("roundId", ""))
	)


func _is_own_round_payload(payload: Dictionary) -> bool:
	return (
		_is_active_round_payload(payload)
		and String(payload.get("playerId", ""))
			== String(room_session.get("playerId", ""))
	)


func _should_surface_request_error(event: StringName) -> bool:
	return event in [
		&"room:create",
		&"room:join",
		&"player:ready",
		&"match:start",
		&"round:ready",
		&"round:next",
		&"match:rematch",
		&"round:topout",
	]


func _clear_round_state() -> void:
	round_preparation = {}
	round_start = {}
	opponent_snapshot = {}
	incoming_attacks = []
	round_result = {}
	match_result = {}
	network_pause = {}
	network_resume = {}
	_pending_top_out = {}
	_top_out_retry_at_ms = -1
	_top_out_request_in_flight = false


func _apply_clock_sample(pending: Dictionary, pong: Dictionary) -> void:
	var sent_at := float(pending.get("sentAt", 0.0))
	var received_at := _unix_time_ms()
	var server_timestamp := float(pong.get("serverTimestamp", 0.0))
	if sent_at <= 0.0 or server_timestamp <= 0.0:
		return
	var sample_round_trip := maxf(0.0, received_at - sent_at)
	if round_trip_ms <= 0.0 or sample_round_trip < round_trip_ms:
		round_trip_ms = sample_round_trip
		clock_offset_ms = (
			server_timestamp + sample_round_trip / 2.0 - received_at
		)
	clock_synchronized.emit(clock_offset_ms, round_trip_ms)


func _on_connected() -> void:
	_reconnect_attempt = 0
	_reconnect_at_ms = -1
	_set_connection_state(STATE_CONNECTED)
	var should_reconnect_session := _reconnect_session_after_open
	_reconnect_session_after_open = false
	# Re-authenticate before flushing snapshots, attacks, or clock requests that
	# accumulated while the socket was unavailable. WebSocket frames preserve
	# this order on the new connection.
	if should_reconnect_session and has_saved_session():
		reconnect_saved_session()
	var queued := _queued_frames
	_queued_frames = []
	for frame in queued:
		_send_frame(frame)
	sample_clock()


func _on_disconnected() -> void:
	_set_connection_state(STATE_DISCONNECTED)
	_schedule_attack_retry()
	_top_out_request_in_flight = false
	_top_out_retry_at_ms = -1
	if (
		not _intentional_close
		and (has_saved_session() or not _queued_frames.is_empty())
	):
		_schedule_reconnect()


func _schedule_reconnect() -> void:
	if (
		_intentional_close
		or (not has_saved_session() and _queued_frames.is_empty())
	):
		return
	var delay_index := mini(_reconnect_attempt, RECONNECT_DELAYS_MS.size() - 1)
	_reconnect_at_ms = (
		Time.get_ticks_msec() + int(RECONNECT_DELAYS_MS[delay_index])
	)
	_reconnect_attempt += 1


func _set_connection_state(next_state: StringName) -> void:
	if connection_state == next_state:
		return
	connection_state = next_state
	connection_state_changed.emit(connection_state)


func _credentials() -> Dictionary:
	return {
		"roomId": String(room_session.get("roomId", "")),
		"playerId": String(room_session.get("playerId", "")),
		"reconnectToken": String(room_session.get("reconnectToken", "")),
	}


func _load_session() -> void:
	var config := ConfigFile.new()
	if config.load(SESSION_PATH) != OK:
		return
	room_session = {
		"roomId": String(config.get_value("room", "room_id", "")),
		"playerId": String(config.get_value("room", "player_id", "")),
		"reconnectToken": String(
			config.get_value("room", "reconnect_token", ""),
		),
	}
	if not has_saved_session():
		room_session = {}
		return
	var encoded_preparation := String(
		config.get_value("round", "preparation", ""),
	)
	var restored_preparation = JSON.parse_string(encoded_preparation)
	if (
		restored_preparation is Dictionary
		and _is_round_payload(restored_preparation)
		and not String(restored_preparation.get("roundSeed", "")).is_empty()
	):
		round_preparation = restored_preparation
	var encoded_start := String(config.get_value("round", "start", ""))
	var restored_start = JSON.parse_string(encoded_start)
	if (
		restored_start is Dictionary
		and _is_active_round_payload(restored_start)
		and float(restored_start.get("startAt", 0.0)) > 0.0
	):
		round_start = restored_start
	var encoded_attacks := String(
		config.get_value("round", "pending_attacks", ""),
	)
	var restored_attacks = JSON.parse_string(encoded_attacks)
	if restored_attacks is Array:
		for attack in restored_attacks:
			if (
				attack is Dictionary
				and _is_active_round_payload(attack)
				and String(attack.get("senderId", ""))
					== String(room_session.get("playerId", ""))
				and not String(attack.get("attackId", "")).is_empty()
			):
				_pending_attacks[String(attack["attackId"])] = attack
	var encoded_top_out := String(
		config.get_value("round", "pending_top_out", ""),
	)
	var restored_top_out = JSON.parse_string(encoded_top_out)
	if (
		restored_top_out is Dictionary
		and _is_own_round_payload(restored_top_out)
		and float(restored_top_out.get("clientTimestamp", 0.0)) > 0.0
	):
		_pending_top_out = restored_top_out


func _save_session() -> void:
	if not has_saved_session():
		return
	var config := ConfigFile.new()
	config.set_value("room", "room_id", room_session["roomId"])
	config.set_value("room", "player_id", room_session["playerId"])
	config.set_value(
		"room",
		"reconnect_token",
		room_session["reconnectToken"],
	)
	if round_result.is_empty() and not round_preparation.is_empty():
		config.set_value(
			"round",
			"preparation",
			JSON.stringify(round_preparation),
		)
		if not round_start.is_empty():
			config.set_value(
				"round",
				"start",
				JSON.stringify(round_start),
			)
		if not _pending_attacks.is_empty():
			config.set_value(
				"round",
				"pending_attacks",
				JSON.stringify(Array(_pending_attacks.values())),
			)
		if not _pending_top_out.is_empty():
			config.set_value(
				"round",
				"pending_top_out",
				JSON.stringify(_pending_top_out),
			)
	config.save(SESSION_PATH)


func _unix_time_ms() -> float:
	return Time.get_unix_time_from_system() * 1000.0
