# Swapduel Godot port — implementation handoff

Reviewed on 2026-07-26 against the current source in this monorepo.

## Decision

The Godot client belongs in the existing Swapduel monorepo:

```text
swapduel/
  apps/
  packages/
  godot/
    project.godot
    game/
    assets/
    tests/
  tools/
    conformance/
```

The full port specification is in `godot/godot-port.md`. The Godot project
should use `godot/` as its project root rather than adding another nested
`godot/` directory.

## Readiness

Implementation can start at Phase 0. The specification accurately reflects the
current major source surfaces:

- `packages/game-engine`: pure deterministic TypeScript simulation.
- `apps/web/app/game/renderer/drawBoard.ts`: Canvas renderer.
- `apps/web/app/composables/useBoardPointer.ts` and `useBoardCursor.ts`: input.
- `apps/web/app/composables/useGameAudio.ts`: generated Web Audio effects.
- `apps/web/app/composables/useRoomSocket.ts`: Socket.IO room client.
- `packages/contracts`: Zod wire contracts.
- `apps/server`: Express, Socket.IO, rooms, match flow, and leaderboard.

No product decision blocks the engine port or the offline endless and
time-trial modes.

## Required correction before Phase 0

Do not implement the specification's proposed
`roundi(ms / (1000.0 / 60.0))` conversion. Rounding durations to whole physics
steps changes gameplay. For example, the current 220 ms clear duration becomes
13 steps (216.67 ms) when rounded, while the TypeScript engine currently waits
until the 14th step (233.33 ms).

Use an exact integer simulation clock instead:

- 3 clock units = 1 millisecond.
- 50 clock units = one 60 Hz simulation step.
- Integer millisecond config values convert exactly with `ms * 3`.
- Store `step` for trace scheduling and integer clock units for engine timers.
- Derive milliseconds only at UI, persistence, or protocol boundaries.
- Keep `riseOffset` and continuous rise calculations as f64, with the same
  operation order in TypeScript and GDScript.

This preserves the existing timing thresholds, stop-time awards and drains,
and 120-second limit without float accumulation or rounded-duration changes.

The TypeScript engine should receive this clock migration first. Its full
existing test suite must remain green before the GDScript port begins. The
current recovery snapshot format is version 3, so the changed serialized state
requires version 4 (or an explicit version-3 migration if preserving active
sessions is important).

## Recommended starting sequence

1. Add integer clock units and `step` to the TypeScript engine while preserving
   the public millisecond behavior used by the web UI.
2. Update recovery validation/serialization and all affected engine tests.
3. Define the canonical conformance trace format, including ordering for
   multiple inputs or attacks on the same step and a canonical config hash.
4. Add the TypeScript trace runner and small checked-in golden fixtures.
5. Scaffold the Godot 4.7 project and test setup.
6. Port RNG first and verify at least 1,000 outputs against a TypeScript fixture.
7. Port state/config and engine modules one-to-one, keeping the exact
   `fixedStep` operation order.
8. Port focused unit suites as each module lands, then the soak/random-board
   suites.
9. Run cross-engine fixtures continuously; expand to the planned 500 generated
   traces before presentation work.

Avoid starting the renderer before conformance is green.

## Implementation details to retain

- The hidden incoming row is separate from the 12 visible rows.
- Preserve the current 60 Hz simulation cadence and seeded RNG.
- Preserve explicit ordering; do not rely on dictionary iteration.
- Use in-place GDScript mutation and preallocated/pool-backed panels, but add
  debug ownership assertions to catch aliasing.
- Keep recovery and conformance serialization explicit rather than serializing
  arbitrary Godot objects.
- Treat the checked-in TypeScript config as the shipping source of truth.

## Deferred decisions

These are not blockers for Phases 0–3:

1. Whether the web client remains live after native launch. If it does,
   cross-play and the conformance suite become permanent CI gates.
2. Whether online play remains private-room-code-only or gains matchmaking.
3. Whether push notifications are part of the initial native room flow.

## Corrections for the later networking phase

- The current contracts use protocol version 1 through literal Zod schemas.
  Accepting both versions will require version-aware schemas or negotiation; it
  is not only a constant bump.
- The existing attack event is named `attack:create`, not the
  `attack:send` example in the port document.
- `apps/server/src/index.ts` calls Socket.IO APIs directly throughout its
  handlers and timers. The transport split is still feasible, but it is a real
  adapter/handler extraction and is likely larger than the estimated two days.
- During an active match, disconnect recovery forfeits after 30 seconds. The
  five-minute reservation applies to waiting-room state, not active play.
- Prefer hand-written strict GDScript parsers backed by shared JSON contract
  fixtures unless a stable schema generator is introduced deliberately.

## Environment and assets

- The initial review did not have Godot installed. Development now targets
  Godot 4.7.
- The web app loads Fredoka and Nunito remotely and does not contain local font
  files. Native work must vendor the required font files and their licenses
  before the UI phase.
- The audio code is coupled to Web Audio nodes. Baking WAV files will require
  an offline renderer or a small reimplementation of the synthesis functions;
  it is not a direct Node import of the composable.

## Source state observed during review

- `../swapduel` was clean on `main` at commit `66c9379`.
- Recovery snapshots were version 3.
- Wire protocol version was 1.
- The engine had 16 test suites plus `tests/helpers.ts`.

Recheck these facts before changing them if implementation begins after other
work has landed.
