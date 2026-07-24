# Swapduel MVP Specification

## 0. Instructions for the implementation agent

Build the MVP described in this document as a production-ready, mobile-first web application.

Priorities, in order:

1. Correct and enjoyable core puzzle mechanics.
2. Responsive local input with no perceived network delay.
3. Reliable private two-player online matches.
4. Excellent portrait-mode mobile usability.
5. Maintainable, well-tested TypeScript code.
6. Original visual and audio assets only.

Do not use Nintendo artwork, music, sound effects, characters, logos, or branding. The game may reproduce the general mechanics of a rising-stack panel-matching puzzle game, but the published product must have an original identity.

When a rule or timing value is unclear, implement it as a named configuration value rather than hard-coding it. Prefer a playable approximation over blocking progress while chasing frame-perfect emulation.

---

# 1. Product summary

Build a small browser game inspired by the versus mode of **Panel de Pon / Puzzle League**.

Two players open a private room link on their phones and play against each other live. Each player:

- Controls a six-column rising panel stack.
- Swaps horizontally adjacent panels.
- Matches three or more panels of the same type.
- Creates combos and chains.
- Sends garbage blocks to the opponent.
- Converts garbage back into normal panels by clearing next to it.
- Loses a round when the stack remains at the top after a short grace period.

A match is **best of three rounds**. The first player to win two rounds wins the match.

The initial working title is **Swapduel**.

---

# 2. MVP goals

The MVP must:

- Work in modern mobile browsers.
- Be optimized for portrait orientation.
- Support iPhone Safari and Android Chrome.
- Let one player create a private room.
- Let the second player join through a shareable URL or room code.
- Require no account or registration.
- Provide immediate local touch response.
- Support live two-player gameplay.
- Implement best-of-three matches.
- Implement the essential Panel de Pon-style versus mechanics.
- Run as one small deployable application.
- Require no database for the first release.
- Use only original visual and audio assets.

---

# 3. Non-goals

The MVP does not include:

- Public matchmaking.
- Ranked play.
- Leaderboards.
- User accounts.
- Persistent profiles.
- Match history.
- Spectators.
- Computer opponents.
- Single-player modes.
- Character selection.
- Handicap settings.
- Chat.
- Voice chat.
- Native iOS or Android applications.
- Desktop-specific controls.
- Nintendo-owned assets.
- Frame-perfect SNES emulation.
- Strong anti-cheat protection.

The app is intended for private matches between known players. A lightweight client-authoritative networking model is acceptable for the MVP.

---

# 4. Recommended technology

## 4.1 Repository

Use a pnpm workspace.

```text
swapduel/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── composables/
│   │   ├── game/
│   │   │   ├── audio/
│   │   │   ├── input/
│   │   │   └── renderer/
│   │   ├── pages/
│   │   └── stores/
│   └── server/
│       ├── rooms/
│       ├── sockets/
│       ├── validation/
│       └── index.ts
├── packages/
│   └── game-engine/
│       ├── src/
│       │   ├── board.ts
│       │   ├── chains.ts
│       │   ├── config.ts
│       │   ├── garbage.ts
│       │   ├── gravity.ts
│       │   ├── matches.ts
│       │   ├── panels.ts
│       │   ├── random.ts
│       │   ├── simulation.ts
│       │   ├── types.ts
│       │   └── index.ts
│       └── tests/
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## 4.2 Frontend

Use:

- Nuxt 4.
- Vue 3.
- TypeScript.
- HTML Canvas 2D for the game boards.
- Normal HTML and CSS for menus, buttons, dialogs, and status UI.
- Vue composables for connection and match state.
- Pinia only if the application state becomes difficult to manage without it.
- Zod for shared payload validation.
- Vitest for unit tests.
- Playwright for browser and multiplayer-flow tests.

## 4.3 Game engine

The game engine must be a pure TypeScript package.

It must not depend on:

- Vue.
- Nuxt.
- Canvas.
- Browser APIs.
- Socket.IO.
- DOM APIs.

The same seed and the same sequence of actions must produce the same simulation result.

## 4.4 Server

Use:

- Node.js.
- Express or the Nuxt Node server.
- Socket.IO.
- In-memory room storage.
- One server process.
- No database.

The server is responsible for:

- Room creation.
- Room membership.
- Player reconnection tokens.
- Match and round IDs.
- Round seeds.
- Synchronized countdowns.
- Garbage-event ordering.
- Round scores.
- Match completion.
- Disconnect handling.
- Expiring inactive rooms.

## 4.5 Deployment

Deploy the client and Socket.IO server together as one Node service.

Railway is the recommended MVP host because the application requires a long-running process and WebSocket support.

Do not deploy the real-time server as stateless serverless functions.

---

# 5. Application screens

## 5.1 Home screen

Display:

- Original game logo or wordmark.
- Player-name input.
- `Create private match` button.
- Room-code input.
- `Join match` button.
- Brief instructions.

Player-name rules:

- Required.
- Maximum 20 characters.
- Trim surrounding whitespace.
- Escape or sanitize before display.
- Save locally in the browser.

No account is required.

## 5.2 Waiting room

Display:

- Six-character room code.
- Shareable invitation URL.
- `Share invitation` button.
- Copy-link fallback.
- Two player slots.
- Player names.
- Ready and connection indicators.
- Match format: `First to 2 rounds`.
- `Start match` button.

Only the room creator can start the first match.

The start button is enabled only when:

- Both player slots are occupied.
- Both Socket.IO connections are active.
- Both clients report that required assets are loaded.

Example URL:

```text
https://game.example.com/room/K7M4DP
```

## 5.3 Game screen

The primary game screen is portrait-first.

Suggested layout:

```text
┌────────────────────────────┐
│ You  ●●○        ○○●  Alex │
│ Round 2                    │
├────────────────┬───────────┤
│                │ Opponent  │
│                │ miniature │
│                │ board     │
│   Own board    ├───────────┤
│                │ Incoming  │
│                │ garbage   │
│                │ preview   │
├────────────────┴───────────┤
│       HOLD TO RAISE        │
└────────────────────────────┘
```

Requirements:

- The own board receives approximately 70–75% of the usable game width.
- The opponent board is smaller but remains readable.
- The interface must fit within the mobile viewport without page scrolling.
- Respect safe-area insets.
- Do not place critical controls under browser chrome.
- The raise button must be easy to hold with either thumb.

The opponent preview must communicate:

- Stack height.
- Falling and clearing panels.
- Active chains.
- Garbage blocks.
- Danger state.
- Disconnection state.

## 5.4 Round-result screen

Display:

- Round winner.
- Updated match score.
- Optional short round statistic summary.
- `Ready for next round` control.
- Automatic countdown after both players are ready.

Do not start the next round until both clients have loaded and acknowledged the new round state.

## 5.5 Match-result screen

Display:

- Match winner.
- Final score, such as `2–1`.
- `Play again` button.
- `Leave room` button.

A rematch:

- Keeps the room.
- Resets the score.
- Generates new seeds.
- Does not require sharing a new link.

---

# 6. Core game rules

## 6.1 Board dimensions

Use:

- Six columns.
- Twelve visible rows.
- One hidden incoming row below the visible board.
- Fractional vertical positioning while the stack rises.

The simulation must represent the rise offset independently from logical panel rows.

## 6.2 Panel types

Use five normal panel types by default.

Support a sixth normal type through configuration.

Each normal type must differ by:

- Color.
- Shape or symbol.

Suggested original symbols:

- Circle.
- Triangle.
- Star.
- Diamond.
- Heart.
- Crescent.

Also support:

- Shock panel.
- Normal garbage.
- Metal garbage.

Do not rely on color alone.

## 6.3 Starting board

Each player starts with six populated rows.

Generation rules:

- The initial board must contain no horizontal match of three or more.
- The initial board must contain no vertical match of three or more.
- The next incoming row must not create an unavoidable automatic match as it enters.
- Incoming rows are generated from a deterministic round seed.
- Both players receive the same sequence of normal incoming rows.
- Garbage placement may use a separate deterministic stream derived from the same seed.
- Shock-panel frequency is configurable.

## 6.4 Swapping

Players swap two horizontally adjacent cells.

Allowed:

- Panel with panel.
- Panel with an empty cell.
- A swap elsewhere while unrelated panels are flashing or clearing.
- Active-chain swaps while the chain remains open.

Not allowed:

- Vertical swaps.
- Swapping garbage.
- Swapping a clearing panel.
- Swapping a panel locked during garbage conversion.
- Swapping a panel currently falling.
- Swapping outside the board.
- Swapping non-adjacent cells.

A swap should take approximately 100 milliseconds and visibly animate.

After the swap:

1. Mark the two cells as swapping.
2. Finish the swap animation.
3. Detect relevant matches.
4. Begin clear resolution.
5. Apply gravity where appropriate.
6. Continue evaluating chain reactions.

## 6.5 Match detection

A match consists of three or more panels of the same type in a continuous horizontal or vertical line.

Rules:

- Only normal panels and shock panels can match.
- Garbage does not match.
- Horizontal and vertical matches may overlap.
- Intersecting groups clear in the same clear event.
- The engine must deduplicate cells belonging to more than one line.

Resolution sequence:

1. Detect all stable matches.
2. Mark matched panels.
3. Flash matched panels.
4. Clear matched panels.
5. Wait for the configured fall delay.
6. Apply gravity.
7. Detect subsequent matches.
8. Continue or end the chain.

The player may continue making valid swaps elsewhere during clear animations.

## 6.6 Gravity

Gravity acts downward toward the rising stack.

Rules:

- Unsupported normal panels enter a falling state.
- Falling panels cannot be swapped.
- Garbage falls as a rectangular block.
- Panels released from garbage conversion use normal gravity.
- Gravity must be deterministic.
- The simulation must not allow overlapping panels or garbage cells.

---

# 7. Combos

A combo occurs when four or more panels clear in one resolution event.

The first implementation should use this attack table:

| Panels cleared | Garbage sent |
|---:|---|
| 3 | None |
| 4 | 1 × 3 |
| 5 | 1 × 4 |
| 6 | 1 × 5 |
| 7 | 1 × 6 |
| 8 | 1 × 3 and 1 × 4 |
| 9 | 1 × 4 and 1 × 5 |
| 10 | Two 1 × 5 blocks |
| 11 | Two 1 × 6 blocks |
| 12+ | Configurable extended table |

Display feedback such as:

```text
6 COMBO
```

The table must be data-driven.

Do not scatter combo-size conditionals throughout the engine.

---

# 8. Chains

A chain occurs when a clear leads to another qualifying clear before the active chain ends.

Examples:

- Panels fall after a clear and create another match.
- Panels released from converted garbage create another match.
- The player makes an active-chain swap while the previous clear is resolving.

The initial clear is the chain origin.

The next qualifying clear displays `×2`, then `×3`, and so on.

Initial chain attack table:

| Chain level | Garbage sent |
|---:|---|
| ×1 | None |
| ×2 | 1 row × 6 columns |
| ×3 | 2 rows × 6 columns |
| ×4 | 3 rows × 6 columns |
| ×5 | 4 rows × 6 columns |
| ×N | `N - 1` full-width rows |

## 8.1 Chain eligibility

Each panel must carry chain-related metadata.

A later clear belongs to the active chain when at least one panel in the match:

- Fell as a result of the previous clear.
- Was released from garbage transformed during the chain.
- Was manually moved into position while the active chain window remained open.

The chain ends when:

- No panels are clearing.
- No panels are falling.
- No garbage is converting.
- The board is stable.
- No qualifying new match appears before the configured chain window closes.

The chain system is one of the highest-risk parts of the implementation. Cover it with focused unit tests before adding networking.

---

# 9. Shock panels and metal garbage

Shock panels are a special matchable panel type.

Rules:

- Three or more connected shock panels clear as a shock match.
- Shock matches send metal garbage.
- Metal garbage is distinct from normal garbage.
- Normal-garbage conversion must not automatically convert adjacent metal garbage.
- Metal garbage converts only when directly touched by a qualifying clear.

Initial shock attack table:

| Shock panels cleared | Metal garbage sent |
|---:|---|
| 3 | One full-width row |
| 4 | Two full-width rows |
| 5 | Three full-width rows |
| 6+ | Configurable extended table |

Shock-panel frequency and attack values must remain configurable.

---

# 10. Garbage system

## 10.1 Incoming queue

Outgoing attacks become ordered incoming attacks for the opponent.

Rules:

- Every attack has a unique ID.
- The server assigns a target sequence number.
- The target acknowledges receipt.
- Duplicate attacks are ignored.
- Attacks from an old round are ignored.
- Queued attacks do not appear in the board until a safe insertion point.
- Different garbage pieces remain separate objects.

## 10.2 Garbage placement

Normal combo garbage:

- May be partial-width.
- Must fit entirely within the six-column board.
- Uses deterministic horizontal placement.
- Falls from above.

Chain garbage:

- Is full-width.
- May be multiple rows tall.

Metal garbage:

- Uses the same physical placement rules.
- Retains its distinct type.

## 10.3 Garbage conversion

A normal-panel clear touching a garbage block starts conversion.

Rules:

- Directly connected garbage of the same type joins the conversion.
- Normal and metal garbage remain separate.
- For garbage taller than one row, convert only its lowest row during one conversion event.
- Conversion proceeds cell-by-cell across the row.
- Converted cells remain locked until that conversion step finishes.
- Converted cells become normal panels.
- Converted panel types are generated deterministically.
- Gravity applies after release.
- Matches formed by released panels may continue the active chain.

The conversion implementation must preserve the rectangular structure of any remaining garbage rows.

## 10.4 Garbage cancellation

Do not implement attack cancellation in the MVP.

Outgoing attacks and already queued incoming attacks remain independent.

Structure the attack pipeline so cancellation could be added later without rewriting the match engine.

---

# 11. Stack rising

## 11.1 Automatic rise

The full panel stack rises continuously.

Initial tuning values:

```ts
export const riseConfig = {
  startingRowsPerSecond: 0.05,
  speedIncreaseIntervalSeconds: 30,
  speedMultiplierPerIncrease: 1.12,
  maximumRowsPerSecond: 0.25,
}
```

These are playtesting defaults, not immutable rules.

## 11.2 Stop time

Automatic rising pauses while:

- Panels are actively clearing.
- A chain is resolving.
- Garbage is converting.

Combos and chains may add additional stop time.

Store all stop-time values in configuration.

Manual raising cancels any unused stop time.

## 11.3 Manual raise

Display a large `Hold to raise` button.

Behavior:

- Start raising after approximately 80 ms of continuous touch.
- Continue while the pointer remains held.
- Stop immediately on pointer release or cancellation.
- Stop if the pointer leaves the control.
- Raise faster than the automatic rate.
- Allow use during ordinary stop time.
- Disable during pause, countdown, round result, and match result.

Use pointer events, not separate mouse and touch implementations.

---

# 12. Danger and losing

When a panel or garbage reaches the top limit:

- Stop automatic rising.
- Enter danger state.
- Start a grace timer.
- Continue allowing valid swaps and clears.
- Show strong visual and audio feedback.

Initial configuration:

```ts
export const dangerConfig = {
  graceMs: 1800,
}
```

If the board returns below the top before the timer expires:

- Leave danger state.
- Resume normal play.

If the grace timer expires while the board remains blocked:

- The player loses the round.

The danger timer pauses while a qualifying clear or garbage conversion is actively rescuing the board.

The exact rescue behavior must be implemented in one well-tested state machine rather than through unrelated timer checks.

---

# 13. Mobile input

## 13.1 Primary input: direct horizontal swipe

The default interaction is a direct swipe on the board.

Behavior:

- Swipe a panel left to swap with its left neighbor.
- Swipe a panel right to swap with its right neighbor.
- One gesture can produce at most one swap.
- A gesture must begin inside a valid cell.
- Vertical movement must not trigger a swap.
- Ignore a gesture if vertical travel becomes greater than horizontal travel before the swap threshold.
- Use a horizontal threshold of roughly 25–30% of a cell width.
- Lock the gesture after a swap is triggered.

## 13.2 Tap alternative

Support tap-to-select as an alternative:

1. Tap one cell.
2. Highlight it.
3. Tap the adjacent cell to its left or right.
4. Perform the swap.

Tapping a non-adjacent cell changes the selection.

Tapping outside the board cancels the selection.

## 13.3 Touch behavior

Requirements:

- Use `touch-action: none` only on the board and hold-to-raise control.
- Do not disable scrolling globally.
- Prevent text selection within the game surface.
- Avoid accidental double-tap zoom.
- Support one active board pointer at a time.
- Handle `pointercancel`.
- Handle a finger sliding outside the board.
- Respect safe-area insets.
- Non-board controls must have at least 44 × 44 CSS-pixel hit targets.

## 13.4 Feedback

Successful swap:

- Immediate visual movement.
- Short sound.
- Optional short vibration when supported and enabled.

Invalid swap:

- Small nudge or bounce.
- No blocking modal.
- No toast that obscures the board.

---

# 14. Match flow

## 14.1 Room creation

1. Player enters a display name.
2. Player chooses `Create private match`.
3. Server creates a room.
4. Server returns:
   - Room code.
   - Room URL.
   - Player ID.
   - Private reconnection token.
5. The browser stores the token locally.
6. The waiting room appears.

## 14.2 Joining

1. The second player opens the invitation URL or enters the room code.
2. They enter a display name.
3. Server assigns the second player slot.
4. Both clients receive the updated room state.

Room capacity is exactly two players.

## 14.3 Match start

1. Both clients report assets loaded and ready.
2. Host presses `Start match`.
3. Server generates:
   - Match ID.
   - Round ID.
   - Round seed.
   - Future start timestamp.
4. Both clients initialize their local game state.
5. Both acknowledge readiness.
6. Server confirms the countdown.
7. Clients show `3, 2, 1, GO`.
8. The round begins at the server-defined time.

## 14.4 Round end

A client reports top-out.

The server:

- Validates match and round IDs.
- Records the event.
- Ends the round.
- Updates the score.
- Broadcasts the result.

If both top-out reports arrive within 150 ms:

- Mark the round as a draw.
- Do not increment either score.
- Replay the round with a new seed.

## 14.5 Match end

The first player to reach two round wins wins the match.

The server is authoritative for the score.

Clients may never directly set their own match score.

## 14.6 Rematch

A rematch:

- Uses the same room.
- Creates a new match ID.
- Resets scores.
- Generates new seeds.
- Requires both players to confirm.
- Alternates internal player ordering for symmetry.

---

# 15. Networking model

## 15.1 Authority model

For the MVP:

- Each client is authoritative for its own board simulation.
- The server is authoritative for room state, seeds, attack ordering, scores, and match state.
- The server does not run a complete board simulation.
- Opponent board snapshots are visual only.
- Anti-cheat is out of scope.

This model is chosen to keep local input immediate and avoid rollback networking.

## 15.2 Client responsibilities

Each client:

- Runs its own deterministic simulation.
- Applies local swaps immediately.
- Generates outgoing attack events.
- Applies incoming server-ordered attacks.
- Sends compact visual snapshots.
- Reports top-out.
- Sends periodic checksums.
- Reconnects using its stored player token.

## 15.3 Server responsibilities

The server:

- Creates and expires rooms.
- Restricts rooms to two players.
- Issues player and reconnection tokens.
- Generates match and round IDs.
- Generates round seeds.
- Defines synchronized start times.
- Orders attack events.
- Rejects duplicate attacks.
- Relays opponent snapshots.
- Tracks round and match scores.
- Handles disconnections and forfeits.
- Rejects stale events.

## 15.4 Snapshot frequency

Send an opponent-board snapshot approximately ten times per second.

Do not send a full simulation state every animation frame.

The receiving client should interpolate visual movement between snapshots.

## 15.5 Shared message requirements

Every gameplay message must include:

- Protocol version.
- Match ID.
- Round ID.
- Sender player ID.
- Sequence number where applicable.

Old-round messages must be ignored.

Unknown message types or invalid payloads must not crash the room.

---

# 16. Shared TypeScript contracts

## 16.1 Board snapshot

```ts
export interface BoardSnapshot {
  protocolVersion: 1
  matchId: string
  roundId: string
  playerId: string
  sequence: number
  clientTimestamp: number
  riseOffset: number
  dangerRemainingMs: number | null
  chainLevel: number
  cells: EncodedCell[]
  garbage: EncodedGarbage[]
  incomingGarbage: EncodedAttackPreview[]
}
```

## 16.2 Attack event

```ts
export interface AttackEvent {
  protocolVersion: 1
  attackId: string
  matchId: string
  roundId: string
  senderId: string
  localSequence: number
  clientTimestamp: number
  kind: 'combo' | 'chain' | 'shock'
  blocks: Array<{
    width: number
    height: number
    type: 'normal' | 'metal'
  }>
}
```

## 16.3 Server-ordered attack

```ts
export interface OrderedAttackEvent extends AttackEvent {
  targetId: string
  serverSequence: number
  serverTimestamp: number
}
```

## 16.4 Player session

```ts
export interface PlayerSession {
  playerId: string
  roomId: string
  displayName: string
  slot: 1 | 2
  connected: boolean
  ready: boolean
}
```

## 16.5 Room state

```ts
export interface RoomState {
  roomId: string
  roomCode: string
  hostPlayerId: string
  players: PlayerSession[]
  status: 'waiting' | 'starting' | 'playing' | 'finished'
  activeMatchId: string | null
}
```

Validate every network payload with shared Zod schemas.

---

# 17. Socket events

## 17.1 Client to server

```text
room:create
room:join
room:leave
player:ready
match:start
match:rematch
round:ready
board:snapshot
simulation:checksum
attack:create
attack:ack
round:topout
ping
```

## 17.2 Server to client

```text
room:created
room:joined
room:state
room:error
match:starting
round:prepare
round:starting
opponent:snapshot
attack:incoming
attack:confirmed
round:ended
match:ended
player:disconnected
player:reconnected
match:paused
match:resuming
pong
```

## 17.3 Reliability rules

- Attack IDs are idempotency keys.
- The target acknowledges each incoming attack.
- The server retries unacknowledged attacks.
- Clients ignore duplicate server sequence numbers.
- Clients ignore messages for old match or round IDs.
- The server rate-limits malformed or excessive messages.
- Snapshot loss is acceptable; snapshots do not require acknowledgement.
- Match-state and attack events require reliable delivery.

---

# 18. Disconnection behavior

## 18.1 Waiting room

If a player disconnects:

- Reserve their slot for five minutes.
- Allow reconnection with the private token.
- Show the other player a disconnected state.
- Do not let a third player take the reserved slot.

## 18.2 During a round

If a connection is missing for more than one second:

- Pause both boards.
- Show `Waiting for opponent…`.
- Stop simulation timers.
- Retain current board state.

Allow 30 seconds for reconnection.

If the player reconnects:

1. Reassociate the socket with the existing player.
2. Exchange current round state.
3. Reconcile pending ordered attacks.
4. Begin a synchronized three-second countdown.
5. Resume both boards.

If the player does not reconnect:

- They forfeit the round.
- The opponent receives the round win.

## 18.3 Browser reload

A reload should attempt reconnection using:

- Room ID.
- Player ID.
- Private reconnection token.

Keep a recent serialized local board snapshot in session storage so a quick reload may recover.

If recovery fails, treat the reload as a normal disconnect and eventual forfeit.

Long-term persistent recovery is not required.

---

# 19. Game-engine state model

## 19.1 Cell state

```ts
export type CellState =
  | 'empty'
  | 'idle'
  | 'swapping'
  | 'hovering'
  | 'falling'
  | 'matched'
  | 'flashing'
  | 'clearing'
  | 'garbage-locked'
```

## 19.2 Panel model

```ts
export interface Panel {
  id: number
  type: NormalPanelType | 'shock'
  state: CellState
  row: number
  column: number
  offsetX: number
  offsetY: number
  chainEligible: boolean
  chainId: number | null
  animationStartedAt: number | null
}
```

## 19.3 Garbage model

```ts
export interface GarbageBlock {
  id: number
  type: 'normal' | 'metal'
  column: number
  row: number
  width: number
  height: number
  conversionRow: number | null
  state: 'queued' | 'falling' | 'idle' | 'converting'
}
```

## 19.4 Chain state

```ts
export interface ChainState {
  id: number
  level: number
  startedAt: number
  lastQualifyingEventAt: number
  status: 'active' | 'closing'
}
```

## 19.5 Round state

```ts
export interface RoundState {
  seed: string
  elapsedMs: number
  board: Board
  riseOffset: number
  riseSpeed: number
  stopTimeRemainingMs: number
  dangerRemainingMs: number | null
  chain: ChainState | null
  incomingGarbage: GarbageBlock[]
  status:
    | 'countdown'
    | 'playing'
    | 'network-paused'
    | 'lost'
    | 'won'
}
```

---

# 20. Simulation timing

Store all timings in one configuration module.

Initial values:

```ts
export const gameTiming = {
  fixedStepMs: 1000 / 60,

  swapDurationMs: 100,
  matchFlashDurationMs: 300,
  clearDurationMs: 220,
  fallDelayMs: 100,
  fallCellsPerSecond: 18,

  garbageCellConvertMs: 45,
  garbageReleaseDelayMs: 150,

  chainWindowMs: 250,
  dangerGraceMs: 1800,

  opponentSnapshotIntervalMs: 100,
  ownChecksumIntervalMs: 1000,

  disconnectPauseThresholdMs: 1000,
  disconnectForfeitMs: 30_000,
}
```

The engine uses a fixed timestep.

Rendering may run at the display refresh rate and interpolate between simulation states.

Do not base gameplay outcomes directly on variable frame duration.

---

# 21. Rendering

Use:

- One Canvas for the local board.
- One smaller Canvas for the opponent board.
- HTML for surrounding UI.

Requirements:

- Scale Canvas buffers using `devicePixelRatio`.
- Keep simulation values in logical board units.
- Resize cleanly when viewport dimensions change.
- Avoid object allocation inside the animation loop where practical.
- Target 60 frames per second.
- Use original vector-drawn shapes or an original sprite sheet.
- Pause nonessential rendering when the document is hidden.
- Continue receiving and buffering network events while hidden.
- Resynchronize clocks when the app returns to the foreground.

Clearly render:

- Selected panel.
- Swapping panel.
- Falling panel.
- Matched panel.
- Flashing and clearing panel.
- Active-chain panel.
- Normal garbage.
- Metal garbage.
- Converting garbage.
- Incoming garbage.
- Danger state.
- Paused state.
- Disconnected opponent.

Large effects must not obscure the local board.

---

# 22. Audio

Use original sound effects.

Required sounds:

- Selection.
- Swap.
- Match.
- Combo.
- Increasing chain levels.
- Garbage sent.
- Garbage received.
- Garbage conversion.
- Danger warning.
- Round win.
- Round loss.
- Match win.

Requirements:

- Audio remains disabled until the first user interaction.
- Provide a persistent sound toggle.
- Do not include background music in the first implementation unless an original track already exists.
- Do not use Nintendo audio.

---

# 23. Accessibility

Requirements:

- Every panel type differs by color and symbol.
- Respect `prefers-reduced-motion`.
- Reduced-motion mode disables board shake and reduces flashing.
- Menus and waiting-room controls are keyboard accessible.
- Buttons have accessible labels.
- Network and match status changes use an ARIA live region.
- Ready, danger, disconnected, win, and loss states are not communicated by color alone.
- Text meets reasonable contrast requirements.
- Do not require precise tapping for non-game controls.

Gameplay itself is optimized for touch, but all non-game flows should remain usable with keyboard and assistive technologies.

---

# 24. Privacy and security

Requirements:

- Store no account data.
- Store only temporary display names.
- Expire rooms after both players leave or after two hours of inactivity.
- Reconnection tokens must be random and unguessable.
- Room codes may be short and human-readable.
- Maximum room capacity is two.
- Maximum display-name length is 20 characters.
- Sanitize player names.
- Validate all payloads with Zod.
- Limit message and snapshot sizes.
- Rate-limit room creation, join attempts, and malformed socket events.
- Restrict production CORS to the application origin.
- Ignore events for completed matches.
- Never trust client-provided scores.
- Do not expose reconnection tokens in URLs shared with the other player.

---

# 25. Testing requirements

## 25.1 Unit tests

The shared game engine must test:

- Initial boards contain no automatic matches.
- Incoming rows are deterministic.
- Horizontal matches.
- Vertical matches.
- Intersecting matches.
- Four-, five-, and six-panel combos.
- Combo attack lookup.
- Swapping panel with panel.
- Swapping panel with empty cell.
- Invalid swaps.
- Gravity.
- Stable-board detection.
- Two-step chains.
- Long chains.
- Active chains caused by a manual swap.
- Chain closure.
- Normal garbage placement.
- Full-width chain garbage.
- Garbage conversion.
- Multi-row garbage converting only its lowest row.
- Normal and metal garbage remaining separate.
- Converted panels continuing a chain.
- Manual raise.
- Rise-speed progression.
- Danger entry.
- Danger rescue.
- Danger timeout.
- Old-round events being ignored.
- Duplicate attacks being ignored.

## 25.2 Property tests

Run randomized simulations and assert:

- No two panels occupy one cell.
- Garbage rectangles remain within board width.
- Stable boards contain no unresolved matches.
- Initial generation never creates prohibited matches.
- No coordinate or timer becomes `NaN`.
- Timers never become unexpectedly negative.
- The same seed and action sequence produce the same checksum.
- Garbage conversion never creates invalid dimensions.
- Simulation steps terminate.

## 25.3 Browser tests

Use Playwright with two browser contexts.

Test:

- Creating a room.
- Joining through a URL.
- Joining through a room code.
- Starting a match.
- Both clients receiving the same start timestamp.
- Sending combo garbage.
- Sending chain garbage.
- Receiving garbage.
- Winning a round.
- Drawing a round.
- Winning a best-of-three match.
- Disconnect pause.
- Successful reconnection.
- Forfeit after timeout.
- Rematch.
- Stale round messages being ignored.
- Mobile layouts at widths of 320, 375, 390, and 430 CSS pixels.

## 25.4 Manual device testing

Test at minimum:

- Current iPhone Safari.
- Current Android Chrome.
- One older or slower phone.
- Wi-Fi.
- Mobile data.
- Simulated 150 ms latency.
- Packet loss.
- Brief network interruption.
- Switching to another app and returning.
- Browser address-bar expansion and collapse.
- Portrait orientation.
- Safe-area devices.

---

# 26. Debug tools

Create a development-only game laboratory page.

It should support:

- Starting an offline board.
- Pausing simulation.
- Advancing one fixed timestep.
- Advancing one animation phase.
- Loading a board from JSON.
- Exporting a board to JSON.
- Selecting a deterministic seed.
- Setting rise speed.
- Adding garbage.
- Forcing a combo.
- Forcing a chain.
- Displaying panel state and chain metadata.
- Displaying the current checksum.
- Simulating incoming attacks.
- Simulating danger state.

The debug page must not be included in the production navigation.

This tool is important for validating complex chain and garbage behavior.

---

# 27. MVP acceptance criteria

The MVP is complete when all of the following are true:

1. A player can enter a name and create a private room.
2. The app produces a shareable invitation URL and room code.
3. A second player can join from another mobile browser.
4. Both players can start a synchronized match.
5. The board uses six columns and a rising stack.
6. Players can swap adjacent panels with horizontal touch gestures.
7. Tap-to-select swapping is available as a fallback.
8. Three matching panels clear.
9. Four or more panels create combos.
10. Falling panels can create chains.
11. Active manual swaps can extend chains.
12. Combos and chains send garbage.
13. Garbage falls onto the opponent’s board.
14. Clearing next to garbage converts it into panels.
15. Multi-row garbage converts one bottom row at a time.
16. Normal and metal garbage behave independently.
17. Shock matches send metal garbage.
18. Players can hold a button to raise the board.
19. Reaching the top starts a danger grace period.
20. Remaining blocked at the top causes a round loss.
21. The first player to win two rounds wins the match.
22. A temporary disconnect pauses the match.
23. A player can reconnect within 30 seconds.
24. A player who does not reconnect forfeits the round.
25. Both players can start a rematch without creating a new room.
26. The game works smoothly in portrait mode on iOS Safari.
27. The game works smoothly in portrait mode on Android Chrome.
28. No Nintendo-owned visual or audio assets are included.
29. Core game-engine behavior has automated tests.
30. The deployed application works through HTTPS and WebSockets.

---

# 28. Implementation order

## Phase 1: Project foundation

Create:

- pnpm workspace.
- Nuxt app.
- Node/Socket.IO server.
- Shared TypeScript package.
- Shared Zod contracts.
- Vitest setup.
- Playwright setup.
- Basic CI.

Do not begin visual polish before the engine tests run reliably.

## Phase 2: Offline game engine

Implement:

- Board representation.
- Seeded random generator.
- Starting-board generation.
- Incoming-row generation.
- Horizontal swapping.
- Match detection.
- Clear resolution.
- Gravity.
- Automatic rising.
- Manual rising.
- Danger state.
- Top-out.

Deliverable:

- Playable offline board.
- Unit tests.
- Debug laboratory page.

## Phase 3: Chains and garbage

Implement:

- Combo detection.
- Chain metadata.
- Active chains.
- Stop time.
- Combo attack table.
- Chain attack table.
- Garbage queue.
- Garbage falling.
- Garbage conversion.
- Shock panels.
- Metal garbage.

Deliverable:

- Offline versus simulation or attack test harness.
- Comprehensive chain and garbage tests.

## Phase 4: Mobile interface

Implement:

- Responsive portrait layout.
- Canvas renderer.
- Swipe input.
- Tap fallback.
- Hold-to-raise control.
- Effects.
- Opponent-board renderer.
- Accessible menus.
- Audio controls.

Deliverable:

- Smooth offline gameplay on real phones.

## Phase 5: Online rooms

Implement:

- Create room.
- Join room.
- Waiting room.
- Ready state.
- Synchronized countdown.
- Snapshot relay.
- Attack relay and ordering.
- Round results.
- Best-of-three score.
- Rematch.

Deliverable:

- Two phones can complete an online match.

## Phase 6: Reliability

Implement:

- Reconnection tokens.
- Network pause.
- Resume countdown.
- Forfeit timeout.
- Duplicate-event handling.
- Stale-event handling.
- Payload limits.
- Rate limiting.
- Background and foreground handling.

Deliverable:

- Match survives common mobile connectivity interruptions.

## Phase 7: Tuning and polish

Tune:

- Swap duration.
- Clear timing.
- Fall timing.
- Rise speed.
- Stop time.
- Chain window.
- Danger grace period.
- Shock frequency.
- Combo attack table.
- Garbage conversion timing.
- Garbage drop timing.
- Touch thresholds.
- Opponent-board readability.

The goal is faithful game feel, not frame-perfect emulation.

---

# 29. Suggested first implementation task

Start with the shared game engine.

Produce the following before networking:

1. `Board` and cell models.
2. Seeded random generator.
3. Initial-board generator without pre-existing matches.
4. Incoming-row generator.
5. Horizontal swaps.
6. Match detection.
7. Clear resolution.
8. Gravity.
9. Fixed-timestep simulation.
10. Unit tests for all of the above.
11. A development-only board visualizer.

Do not implement Socket.IO until an offline board can be played and reproduced deterministically from a seed and action log.

---

# 30. Definition of done

A feature is done only when:

- Its behavior is represented in typed code.
- Invalid input is handled.
- Relevant automated tests pass.
- It works at supported mobile viewport sizes.
- It does not introduce browser console errors.
- It does not depend on Nintendo assets.
- Configuration values are documented.
- The implementation agent updates the project README when architecture or setup changes.
