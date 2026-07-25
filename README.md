# Swapduel

Swapduel is a mobile-first, private two-player rising-stack puzzle game. The
repository contains the deterministic offline engine, a development
laboratory, and the first online-room slice: create, join, reconnect, and
waiting-room ready state. Hosts can also initiate an authoritative match
handshake that waits for both clients before issuing one synchronized
countdown timestamp. The portrait match screen runs the local deterministic
board and relays validated opponent snapshots at approximately 10 Hz.
Combo, chain, and shock attacks are assigned a server sequence, delivered only
to the opponent, deduplicated, inserted into the deterministic garbage queue,
and acknowledged by the receiving client. Unconfirmed sends survive temporary
client disconnects, while the server retries unacknowledged deliveries and
replays them to a player's replacement socket after reconnect.
Top-outs are resolved after a 150 ms simultaneous-loss window. The server owns
round scores, replays draws with a fresh seed, waits for both players between
rounds, and ends the match when one player reaches two wins.
Completed matches support same-room rematches after both players confirm. Each
rematch gets new match and round identifiers, resets scores, and swaps player
slots for symmetry.
Live rounds tolerate sub-second connection blips. Longer disconnects pause
both boards, allow 30 seconds for recovery, and resume from one shared
three-second countdown; an expired recovery window awards the round.
Waiting-room slots remain reserved for five minutes after disconnecting.
Abandoned rooms and rooms without authenticated activity for two hours are
removed with their pending server timers and stale client sessions.
Room creation, joins, reconnection attempts, gameplay control messages,
snapshots, pings, and malformed events have separate bounded in-memory rate
limits. Shared payload schemas reject unknown fields, oversized collections,
unsafe numeric ranges, and control characters in display names.
When a match tab moves into the background, rendering and fixed-step simulation
stop while Socket.IO continues buffering match events. Returning to the
foreground recalibrates against the lowest-latency server-time sample and
resets frame timing before play continues, preventing suspended time from being
processed as a burst.
During live play, the deterministic engine continues using 60 Hz fixed steps
while the battery-sensitive presentation path is capped at approximately 30
canvas frames per second, 2× device pixel density, and 10 reactive UI updates
per second.
Active simulations are also serialized to session storage every two seconds and
when the page is suspended. A quick reload can restore only a fresh, versioned
snapshot for the exact match, round, and seed; malformed or stale state falls
back to deterministic round creation.
Live input and simulation events drive original synthesized sound effects for
swaps, clears, combos, chains, incoming garbage, danger, and round results.
Audio unlocks only after interaction, and the player's sound preference
persists locally.
Clients report a checksum every two simulated seconds. The server retains a
bounded per-player timeline, ignores duplicates and stale sequences, and logs
plus returns a visible diagnostic only if the same player reports conflicting
checksums for one simulation step. Opponents are intentionally never compared
because their independently controlled boards are expected to diverge.

Two solo modes sit alongside the duel. Endless score attack runs until the
stack tops out; the two-minute time trial ends on the buzzer — or early if the
stack tops out first — and submits its score to a shared leaderboard over
`/api/leaderboard`. Leaderboard scores come from a client-side simulation and
are accepted on trust, bounded only by schema limits and per-address rate
limits, so treat the table as a scoreboard among friends rather than a record.

## Requirements

- Node.js 22 or newer
- pnpm 11

## Setup

```bash
pnpm install
pnpm test
pnpm dev
```

In development, the web app connects to the realtime server at
`http://localhost:3001`. Override that with `NUXT_PUBLIC_SOCKET_URL` when the
two processes use different origins.

## Production deployment

The production build generates the Nuxt client as static assets and serves
them from the Express and Socket.IO process. This keeps the website and
realtime connection on one origin:

```bash
pnpm build
NODE_ENV=production pnpm start
```

The included `Dockerfile` and `railway.json` deploy the workspace as one
long-running Railway service with a `/health` deployment check. Connect this
repository to a Railway service, keep the service root at `/`, and enable
public networking. Railway supplies `PORT`; no application variables are
required for the same-origin setup.

The time-trial leaderboard is a SQLite file, the only durable state in the
service. It lives at `LEADERBOARD_DB_PATH` (default `data/leaderboard.db` in the
repository root, `/app/data/leaderboard.db` in the container, where a Railway
volume is mounted). Its directory is created on boot; if the path cannot be
opened the leaderboard endpoints return 503 and everything else runs normally.
`node:sqlite` is still flagged on Node 22, so the server is started with
`--experimental-sqlite`.

Set `APP_ORIGIN` and `NUXT_PUBLIC_SOCKET_URL` only when the web client is hosted
on a different origin. Production defaults to trusting one reverse-proxy hop
for per-address rate limits; set `TRUST_PROXY=false` if the service is exposed
directly.

Open `/lab` in development to use the offline board laboratory. It supports
swipe and tap swapping, pause/step controls, manual raising, deterministic seed
reset, and JSON import/export. The lab route returns a 404 in production.

## Workspace

```text
apps/web                 Nuxt 4 client and development laboratory
apps/server              Socket.IO server and in-memory room state
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
- Configurable combo and chain stop time with manual-raise cancellation
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

The next visual networking slice is interpolating opponent-board snapshots.
