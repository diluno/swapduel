# Swapduel

Swapduel is a mobile-first, private two-player rising-stack puzzle game. The
repository currently contains the deterministic offline engine and a
development laboratory; online rooms and versus networking are the next major
phase.

## Requirements

- Node.js 22 or newer
- pnpm 11

## Setup

```bash
pnpm install
pnpm test
pnpm dev
```

Open `/lab` in development to use the offline board laboratory. It supports
swipe and tap swapping, pause/step controls, manual raising, deterministic seed
reset, and JSON import/export. The lab route returns a 404 in production.

## Workspace

```text
apps/web                 Nuxt 4 client and development laboratory
apps/server              Socket.IO server entry point (room logic pending)
packages/contracts       Shared, Zod-validated network contracts
packages/game-engine     Pure deterministic TypeScript simulation
```

The game engine has no browser or framework dependencies. Rows are indexed from
the bottom (`row = 0`) upward. The hidden incoming row is stored separately
below the 12 visible cell rows. All simulation timing and tuning values live in
`packages/game-engine/src/config.ts`.

## Current engine scope

- Seeded deterministic random generation
- Match-free six-row starting boards
- Safe deterministic incoming rows
- Horizontal panel-to-panel and panel-to-empty swaps
- Horizontal, vertical, and intersecting match detection
- Timed swap, flash, clear, fall-delay, and gravity phases
- Data-driven combo attacks
- Gravity and active-swap chain detection with deterministic chain closure
- Ordered local attack output ready for the networking layer
- Ordered, deduplicated incoming garbage attacks
- Deterministic partial/full-width garbage placement and rectangular falling
- Row-by-row normal and metal garbage conversion
- Converted panels participating in active chains
- Configurable shock-panel generation and connected-group matching
- Data-driven shock attacks that send metal garbage
- Fixed-timestep automatic and manual rise
- Danger entry, rescue pauses, grace timeout, and top-out
- Deterministic checksums and JSON-serializable simulation state

Online rooms and reconnection are not implemented yet.
