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
- incoming garbage validation, telegraph ordering, placement, and falling;
- row-wise attack cancellation and top-out danger timing;
- simulation initialization, exact clock stepping, horizontal swap lifecycle,
  and derived phase summaries;
- a canonical trace loader and TypeScript-compatible checksum serializer;
- the shipping scoring and attack tables;
- an exact integer clock shared with TypeScript: 3 units per millisecond and
  50 per 60 Hz step;
- golden RNG fixtures generated directly from the TypeScript engine.

Canonical traces and TypeScript checksum fixtures live in
`../tools/conformance/`. Godot now matches every initial checkpoint, the full
time-limit trace, the swap trace through step 180, and the incoming-garbage
trace through step 60. Later checkpoints are gated on resolution and garbage
lifecycle work that has not been ported yet.

Simulation resolution, chains, garbage conversion, recovery, and presentation
are not implemented yet.

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
