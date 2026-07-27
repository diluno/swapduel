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
- deterministic presentation feedback reconstructed outside the simulation:
  accelerated panel falls, landing squash and board shake, ordered clear pops,
  and combo/chain badges with reduced-motion fallbacks;
- an adaptive native shell themed with bundled Fredoka and Nunito variable
  fonts, a safe-area-aware chip-based HUD and controls, dedicated home,
  how-to-play, settings, pause, and result cards, and reduced-motion-aware
  card and button transitions;
- the shipping scoring and attack tables;
- an exact integer clock shared with TypeScript: 3 units per millisecond and
  50 per 60 Hz step;
- golden RNG fixtures generated directly from the TypeScript engine.

Canonical traces and TypeScript checksum fixtures live in
`../tools/conformance/`. Godot matches every checkpoint in the full time-limit,
swap, and incoming-garbage traces.

The presentation is an initial functional pass; authored sprites,
platform-aware accessibility defaults, and online duel networking are not
implemented yet.

## Play offline

Open `project.godot` in Godot 4.7, run the project, and choose Endless or the
Two-minute trial. Tap two neighboring panels or swipe horizontally to swap.
Hold **Hold to raise** to push the stack.

Desktop controls use arrows or WASD to move the two-cell cursor, Space or Enter
to swap, and Shift to raise.

## Test on iPhone

The checked-in iOS export preset writes generated output to `builds/ios/`,
which is ignored by Git.

1. Install the matching Godot 4.7.1 export templates from
   **Editor → Manage Export Templates**.
2. Connect and unlock the iPhone, trust the Mac, and enable Developer Mode.
3. Choose **Project → Export → iOS → Export Project**.
4. Open the generated Xcode project, select the development team and connected
   iPhone, then run it once. After initial provisioning, the runnable preset can
   also use Godot's one-click device button.

Increment `application/version` in `export_presets.cfg` before uploading a new
build to TestFlight. Generated Xcode projects, archives, and IPAs should not be
committed.

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
