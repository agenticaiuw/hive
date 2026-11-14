# Hive Dashboard (SvelteKit)

The one Hive dashboard. The same source runs everywhere Hive does: in Hive's Mac app, on the
website, and next on the phone and in the browser extension. Nothing else in the repository is a
dashboard; a surface that needs one hosts this folder's build.

Its home page (`/`) is the task board: every task the owner has given any agent (Claude Code,
Codex, Hive) on any machine, saved by `hive-tasks` and synced to the cloud board (`cloud/tasks`),
with a box to hand an agent the next one. What needs the owner comes first, then what's being
worked on, what hasn't started, and what's done. `/hive`
and `/pc` are as before.

## One app, every host

| Host | Build | Served from | `/api/*` answered by |
| --- | --- | --- | --- |
| Hive's Mac app | `npm run build:desktop` → `build-desktop/` (`make build/dashboard` in `desktop/app` copies it to `desktop/app/build/dashboard`) | `hive://app/` in Hive.app's Dashboard window | the window itself (`desktop/app/workspace-engine/Sources/UnifiedAgent/dashboard.swift`) |
| Website | `npm run build` → `.svelte-kit/cloudflare` | the `hive-dashboard` Worker | this app's server routes |
| Phone, browser extension | next: the desktop build, hosted the same way | | |
| Old Mac agent | `npm run build:agent` → `build-agent/` | `http://127.0.0.1:8000/dashboard` | the Python agent's routes |

Every host answers the same task routes, so the pages never branch on where they run:

- `GET /api/tasks` → `{source: "cloud" | "local", note?, board}`. The cloud board has every
  machine; `local` is the Mac's own ledger when the cloud is out of reach (`$lib/tasks` reads
  both).
- `GET /api/agents` → `{agents: [{id, name, where, available, note?}]}`.
- `POST /api/agents/send` with `{agent, text}` → `{accepted: true | false | null, receiptId?,
  error?}`. `null` means it may have started.

In the Mac app, the agent is Hive itself, through its request socket. On the website, `/api/tasks`
reads the board through the `TASKS` service binding with the `TASKS_TOKEN` secret, and sending
isn't wired yet.

`src/lib/dataSource.ts` is the only file that knows which backend the pipeline views talk to.
The task routes are the same everywhere, so they need no switch.

## Authentication

`src/hooks.server.ts` reproduces the Worker gate exactly: an HMAC-signed
`__Host-pendant_session` cookie with a 30-day TTL, `POST /api/auth/login` and
`POST /api/auth/logout` handled before any session check, `/login` plus static
assets public, page requests redirected to `/login?returnTo=…`, and `/api/*`
answered with a 401 before any relay call.

Set `DASHBOARD_ACCESS_KEY` to a random value of at least 16 characters and
`DASHBOARD_SESSION_SECRET` to an independent random value of at least 32
characters. Authentication fails closed if either value is missing or weak.

## Runtime environment

Bindings arrive per request through `event.platform.env` and are merged with
SvelteKit's server-only dynamic private env before being stashed on
`event.locals.runtimeEnv`. Worker bindings take precedence. Vite reads the one
repo-root `.env`; the shared `PAIRING_CODE` / `SESSION_SECRET` names are mapped
server-side to the dashboard auth names, and no credential is copied into a
`VITE_*` variable. If there is no `RELAY` service binding, the relay helpers use
`fetch(RELAY_URL + path)`.

## Local development

```bash
npm install
npm run dev
```

`vite dev` emulates the Worker bindings through Wrangler against the `local`
environment in `wrangler.jsonc` — same vars, no service binding, because the
remote relay Worker cannot be stood up locally. Put the values described in
the repository's `.env.example` in the single repo-root `.env`; Vite loads them
only into the server environment and the relay falls back to `RELAY_URL`.

## Deploy

```bash
npm run deploy:cloudflare
```

Deploys the `hive-dashboard` Worker with the `RELAY` service binding to
`hive-relay` and the `TASKS` binding to `hive-tasks`. The secrets are never in
`wrangler.jsonc`:

```bash
wrangler secret put RELAY_API_KEY
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
