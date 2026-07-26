# Cross-engine conformance

Each trace uses zero-based simulation steps. Events are applied immediately
before their step, with `order` providing one total ordering across player
inputs and incoming attacks on the same step.

Expected files contain the initial checksum and then a checksum every 30
completed steps, plus the final step when it is not already a checkpoint.

Regenerate the checked-in fixtures after an intentional engine or config
change:

```sh
pnpm exec vitest run tools/conformance/generate-fixtures.test.ts
```

Godot consumes these files through `godot/game/engine/conformance.gd`. The test
suite compares every checkpoint in all three canonical traces.
