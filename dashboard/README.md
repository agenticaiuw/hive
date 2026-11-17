# Hive Dashboard (SvelteKit)

The one Hive dashboard. The same source runs everywhere Hive does: in Hive's Mac app, on the
website, and next on the phone and in the browser extension. Nothing else in the repository is a
dashboard; a surface that needs one hosts this folder's build.

Its home page (`/`) is the task board: every task the owner has given any agent (Claude Code,
Codex, Hive) on any machine, saved by `hive-tasks` and synced to the cloud board (`cloud/tasks`),
with a box to hand an agent the next one. What needs the owner comes first, then what's being
worked on, what hasn't started, and what's done.

## One app, every host

| Host | Build | Served from | `/api/*` answered by |
| --- | --- | --- | --- |
| Hive's Mac app | `npm run build:desktop` → `build-desktop/` (`make build/dashboard` in `desktop/app` copies it to `desktop/app/build/dashboard`) | `hive://app/` in Hive.app's Dashboard window | the window itself (`desktop/app/workspace-engine/Sources/UnifiedAgent/dashboard.swift`) |
| Website | `npm run build` → `.svelte-kit/cloudflare` | the `hive-dashboard` Worker | this app's server routes |
| Phone app, browser extension side panel | the website, loaded in the app's web view or the side panel | the `hive-dashboard` Worker | this app's server routes |

Every host answers the same task routes, so the pages never branch on where they run:

- `GET /api/tasks` → `{source: "cloud" | "local", note?, board}`. The cloud board has every
  machine; `local` is the Mac's own ledger when the cloud is out of reach (`$lib/tasks` reads
  both).
- `GET /api/agents` → `{agents: [{id, name, where, available, note?}]}`.
- `POST /api/agents/send` with `{agent, text}` → `{accepted: true | false | null, receiptId?,
  error?}`. `null` means it may have started.

In the Mac app, the agent is Hive itself, through its request socket. On the website, the routes
reach the board through the `TASKS` service binding with the `TASKS_TOKEN` secret.

`src/lib/dataSource.ts` is the one data layer; the routes are the same everywhere, so it needs no
switch.

## Authentication

`src/hooks.server.ts` is the gate: an HMAC-signed `__Host-hive_session` cookie with a 30-day
TTL, `POST /api/auth/login` and `POST /api/auth/logout` handled before any session check,
`/login` plus static assets public, page requests redirected to `/login?returnTo=…`, and `/api/*`
answered with a 401 before the board is asked anything.

Set `DASHBOARD_ACCESS_KEY` to a random value of at least 16 characters and
`DASHBOARD_SESSION_SECRET` to an independent random value of at least 32
characters. Authentication fails closed if either value is missing or weak.

## Runtime environment

Bindings arrive per request through `event.platform.env` and are merged with
SvelteKit's server-only dynamic private env before being stashed on
`event.locals.runtimeEnv`. Worker bindings take precedence. Vite reads the one
repo-root `.env`; the shared `PAIRING_CODE` / `SESSION_SECRET` names are mapped
server-side to the dashboard auth names, and no credential is copied into a
`VITE_*` variable. Without the `TASKS` service binding the board is reached by `TASKS_URL`.

## Local development

```bash
npm install
npm run dev
```

`vite dev` emulates the Worker bindings through Wrangler against the `local`
environment in `wrangler.jsonc` — same vars, no service binding. Put the values described in
the repository's `.env.example` in the single repo-root `.env`; Vite loads them only into the
server environment.

## Deploy

```bash
npm run deploy:cloudflare
```

Deploys the `hive-dashboard` Worker with the `TASKS` binding to `hive-tasks`. The secrets are
never in `wrangler.jsonc`:

```bash
wrangler secret put DASHBOARD_ACCESS_KEY
wrangler secret put DASHBOARD_SESSION_SECRET
wrangler secret put TASKS_TOKEN   # the task board's machine token (hive-tasks' cloud token)
```

`wrangler dev --env local` runs without the remote service binding.

## Validation

```bash
npm run build
node --test tests/rendered-html.test.mjs
npm run check
```
