# Swapduel — Infrastructure

Last audited: 2026-07-24 · Verified against the live Railway project via CLI.

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
- **Workspace:** Samuel Alder's Projects (`020ad7d4-4e25-4688-bd03-dec83c717f8a`)
- **Project:** `swapduel` — `10183411-df26-4259-9b3e-7092b36067be`
- **Environment:** `production` — `0f807469-5be7-405b-8814-888ddbe11380`
- **Service:** `swapduel` — `08d0e0d4-0a71-442f-8e31-c102900edc78`
- **Internal DNS:** `swapduel.railway.internal`
- **Health check:** `GET /health` → `{"service":"swapduel","status":"ok"}`,
  120s timeout, `ON_FAILURE` restart (max 10), 10s drain.
- **Runtime:** `node:22-bookworm-slim`, pnpm 11.17.0 via corepack.
  Runs as the non-root `node` user. Entry: `node --import tsx src/index.ts`.
- **Server IP / SSH alias:** none. Railway containers aren't SSH-managed and
  there is no swapduel alias in `~/.zshrc`. Shell access would be
  `railway ssh` (CLI not currently installed locally).
- **PHP:** N/A — this is not a PHP project.

## Deploys

**Auto-deploy on push to `main`** — confirmed. The service source is the
GitHub repo `diluno/swapduel`, so pushes rebuild automatically.

Deploy is the Dockerfile: copy → `pnpm install --frozen-lockfile` →
`NODE_ENV=production` → `pnpm build` → run the server.

`.github/workflows/ci.yml` runs on push to `main` and on PRs:
`pnpm install --frozen-lockfile` → `pnpm test` → `pnpm typecheck` →
`pnpm build`. Note this is **CI only — it does not gate or perform the
deploy.** A red CI run will not stop Railway from shipping. The `pnpm build`
step exists so a build-breaking change fails visibly in CI rather than only
at deploy time; CI and Railway build in parallel, so treat it as a signal,
not a guard.

Manual deploy of the working directory (bypasses git entirely):

    railway up

Note the CLI installs to `~/.railway/bin`, which is **not** on the default
PATH — use the full path or add it to `~/.zshrc`.

### History / gotcha

Until 2026-07-24 20:35 UTC the service had **no source connected**
(`source: {"image": null, "repo": null}`). The only deployments were two
one-off `railway up` uploads at 18:17–18:18, so pushes to `main` silently
did nothing — there was no trigger to fire, and no error anywhere to notice.
Fixed with:

    railway service source connect --repo diluno/swapduel --branch main --service swapduel

If deploys ever appear to stop again, check the service source **first**:

    railway status --json   # look at serviceInstances[].source

Local production check:

    pnpm build
    NODE_ENV=production pnpm start

## Environment variables

**Confirmed: no application variables are set on the service.** `railway
variable list` returns only Railway-injected `RAILWAY_*` values, so the
same-origin defaults below are what production actually runs on.

No `.env` is committed and none exists locally; `.gitignore` excludes
`.env` / `.env.*`. There is no `.env.example`. Any values added later live
in the **Railway service variables** dashboard.

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

Both `ACTIVE`, both verified serving `200` on `/` and `/health`:

| Domain | Type |
|---|---|
| `swapduel.dil.uno` | custom (this is `RAILWAY_PUBLIC_DOMAIN`) |
| `swapduel-production.up.railway.app` | Railway-provided |

- **DNS host:** `dil.uno` — registrar/DNS provider not recorded here; the
  CNAME target is managed in the Railway dashboard.
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

## Gaps

Still unconfirmed:

- **Region and replica count.** The single-instance caveat above is a
  property of the code (in-memory state), not something verified against
  the service config — worth checking before anyone scales it up.
- **Branch binding.** `--branch main` was passed when connecting the source,
  but the service instance reports `branch: null`. Deploys fire correctly,
  so it appears to track the repo default (also `main`); revisit if pushes
  to other branches ever deploy unexpectedly.
- **DNS registrar** for `dil.uno`.
