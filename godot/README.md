# Swapduel for Godot

This directory is the project root for the native Godot 4.7 client. The port is
being built from the deterministic engine outward so the web and native clients
can share seeds, rules, and eventually online matches.

## Current implementation

The first engine tranche includes:

- the exact TypeScript seed hash and xorshift32 random stream;
- a flat, mutable board with pooled panels and debug ownership assertions;
- deterministic, match-safe starting boards and hidden incoming rows;
- row insertion, line/shock match detection, and gravity;
- incoming garbage validation, telegraph ordering, placement, falling, and
  row-by-row conversion into match-safe panels;
- row-wise attack cancellation and top-out danger timing;
- simulation initialization, exact clock stepping, horizontal swap lifecycle,
  overlapping clear groups, per-panel hover gravity, chain progression, and
  derived phase summaries;
- a canonical trace loader and TypeScript-compatible checksum serializer;
- explicit version 4 snapshot serialization, validation, restoration, and
  version 3 integer-clock migration compatible with the TypeScript schema;
- a playable offline mode shell with endless and exact two-minute time-trial
  runs, touch/tap/swipe input, keyboard cursor controls, hold-to-raise, pause,
  local best scores, countdowns, danger, result states, and automatic
  two-second recovery snapshots that reopen paused after interruption;
- generated native WAV effects for swaps, clears, combos, chains, garbage
  landings, danger, results, and sound-toggle feedback, played through a
  reusable pooled audio service with a persistent preference;
- persistent native settings for reduced motion, 30 FPS battery saver, sound,
  and gated handheld haptics for clears, chains, and garbage landings;
- the shipping scoring and attack tables;
- an exact integer clock shared with TypeScript: 3 units per millisecond and
  50 per 60 Hz step;
- golden RNG fixtures generated directly from the TypeScript engine.

Canonical traces and TypeScript checksum fixtures live in
`../tools/conformance/`. Godot matches every checkpoint in the full time-limit,
swap, and incoming-garbage traces.

The presentation is an initial functional pass; authored sprites, richer
effects, platform-aware accessibility defaults, and networking are not
implemented yet.

## Play offline

Open `project.godot` in Godot 4.7, run the project, and choose Endless or the
Two-minute trial. Tap two neighboring panels or swipe horizontally to swap.
Hold **Hold to raise** to push the stack.

Desktop controls use arrows or WASD to move the two-cell cursor, Space or Enter
to swap, and Shift to raise.

## Run the engine checks

Godot 4.7:

```sh
godot --headless --path godot --script res://tests/run_tests.gd
```

Regenerate the TypeScript RNG fixture after an intentional RNG change:

```sh
node --experimental-strip-types godot/tools/generate_rng_fixture.mjs
pnpm exec vitest run godot/tools/generate_board_fixture.test.ts
```

Do not hand-edit the files under `tests/fixtures/`.

Regenerate the native sound effects after an intentional audio change:

```sh
node godot/tools/generate_audio.mjs
```
