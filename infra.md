# Swapduel — Infrastructure

Last audited: 2026-07-24 · Audited from repo contents only (see "Gaps" below).

## Shape of the thing

Single long-running Node service. `pnpm build` generates the Nuxt client as
**static** assets (`nuxt generate`), and the Express + Socket.IO process serves
those assets *and* the realtime connection from **one origin**. There is no
separate frontend host and no database.

    apps/web        Nuxt 4 client (generated to .output/public)
    apps/server     Express 5 + Socket.IO 4, in-memory room state
    packages/contracts      Zod-validated network contracts
    packages/game-engine    Pure deterministic simulation

## Hosting

- **Provider:** Railway, deployed from `railway.json` + `Dockerfile`
  (`builder: DOCKERFILE`, service root `/`, public networking enabled).
- **Health check:** `GET /health` → `{"service":"swapduel","status":"ok"}`,
  120s timeout, `ON_FAILURE` restart (max 10), 10s drain.
- **Runtime:** `node:22-bookworm-slim`, pnpm 11.17.0 via corepack.
  Runs as the non-root `node` user. Entry: `node --import tsx src/index.ts`.
- **Server IP / SSH alias:** none. Railway containers aren't SSH-managed and
  there is no swapduel alias in `~/.zshrc`. Shell access would be
  `railway ssh` (CLI not currently installed locally).
- **PHP:** N/A — this is not a PHP project.

## Deploys

Push to `main` on `git@github.com:diluno/swapduel.git`. If the Railway
service is connected to this repo, Railway rebuilds automatically on push;
that connection lives in the Railway dashboard and is **not** in the repo,
so it can't be confirmed from here.

`.github/workflows/ci.yml` runs on push to `main` and on PRs:
`pnpm install --frozen-lockfile` → `pnpm test` → `pnpm typecheck`.
Note this is **CI only — it does not gate or perform the deploy.** A red CI
run will not stop Railway from shipping a broken build.

Deploy is the Dockerfile: copy → `pnpm install --frozen-lockfile` →
`NODE_ENV=production` → `pnpm build` → run the server.

Local production check:

    pnpm build
    NODE_ENV=production pnpm start

## Environment variables

None are required for the standard same-origin setup — Railway supplies `PORT`.
No `.env` is committed and none exists locally; `.gitignore` excludes
`.env` / `.env.*`. There is no `.env.example`. Real values, if any were
added, live in the **Railway service variables** dashboard.

| Variable | Default | When to set it |
|---|---|---|
| `PORT` | `3001` | Supplied by Railway |
| `APP_ORIGIN` | `http://localhost:3000` | Only if the client is on another origin (CORS) |
| `NUXT_PUBLIC_SOCKET_URL` | `''` in prod, `http://localhost:3001` in dev | Only if the client is on another origin |
| `TRUST_PROXY` | `true` when `NODE_ENV=production` | Set `false` if exposed directly, not behind a proxy |
| `WEB_PUBLIC_DIR` | `apps/web/.output/public` | Rarely — non-standard asset location |
| `NODE_ENV` | — | Set to `production` in the image |

No secrets, API keys, or credentials exist anywhere in this project.

## Domains, DNS, mail

- **Domains:** unknown — no custom domain appears in the repo. Whatever
  `*.up.railway.app` subdomain or custom domain is in use is configured in
  the Railway dashboard. (`game.example.com` in the spec is placeholder prose.)
- **DNS host:** unknown, same reason.
- **Mail:** none. The application sends no email and has no mail provider.

## Scheduled work

**No cron jobs.** All periodic work is in-process `setInterval` inside the
server, so it lives and dies with the container:

- Attack retry sweep — every **250ms**, redelivers attacks unacked after 750ms
- Room cleanup + rate-limiter prune — every **60s**

Both are cleared on `SIGTERM`/`SIGINT`, with a 10s forced-exit backstop.

## Quirks worth knowing

- **All state is in memory.** `RoomStore` is `Map`-backed with no persistence.
  *Any deploy or restart drops every active room and match in progress.*
  This is the single most important operational fact here — deploys are not
  zero-downtime for players mid-match. There is also no horizontal scaling:
  a second replica would not share room state, so **keep this at one instance**
  unless a shared store (Redis adapter) is introduced.
- Room lifetimes: 2h inactivity expiry, 5min waiting reservation,
  30s disconnect-forfeit, 3s reconnect countdown, 4s round countdown lead.
- `/lab` (the board laboratory) is **404 in production** by design, and is
  excluded from prerender in `nuxt.config.ts`.
- Static assets are served with `maxAge: 1h` in production.
- Rate limiting is per-address fixed-window across seven categories (room
  create/join, auth, control events, snapshots, pings, malformed events) and
  depends on `trust proxy` being correct — if `TRUST_PROXY` is wrong, every
  client looks like the proxy and limits apply globally.
- Local dev needs **two** processes: `pnpm dev` (web, :3000) and
  `pnpm dev:server` (socket server, :3001). The client defaults to
  `localhost:3001` in dev, so the web app must not take that port — if :3000
  is occupied Nuxt grabs :3001 and the socket server can't bind.
- A live match needs both tabs actually visible; a backgrounded tab suspends
  its loop and won't confirm round-ready.

## Gaps — not verifiable from the repo

These need the Railway dashboard (or `railway link` + CLI) to confirm:

- Railway project / service / environment names, and the region
- Whether GitHub auto-deploy on `main` is actually enabled
- The live URL and any custom domain, plus its DNS host
- Variables actually set on the service
- Instance count and resource limits (see the single-instance caveat above)
