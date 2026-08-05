# AI Pendant Dashboard (SvelteKit)

App-authenticated Mission Control dashboard for the AI Pendant hardware and
cloud pipeline. Svelte 5 + `@sveltejs/adapter-cloudflare`, deployed as the
`ai-pendant-dashboard` Worker.

It shows:

- Cloudflare Worker, D1, Workers AI, and Mac bridge health
- live nRF microphone recordings and transcription quality
- the six-stage voice pipeline from speech-to-text through I²S playback
  (two stages for runs that originated in this dashboard)
- recent commands, agent responses, timing, PCM, and hardware telemetry
- canonical D1-backed chat/session and memory summaries shared with iOS
- sanitized Mac permission status, browser-extension connectivity, and recent
  local-agent activity

The browser never receives the relay API key. Every `/api/*` route runs on the
server, reads `RELAY_URL` / `RELAY_API_KEY` from the runtime bindings, and
proxies through the authenticated Cloudflare relay.

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

Deploys the `ai-pendant-dashboard` Worker with the `RELAY` service binding to
`ai-pendant-relay`. The three secrets are never in `wrangler.jsonc`:

```bash
wrangler secret put RELAY_API_KEY
wrangler secret put DASHBOARD_ACCESS_KEY
wrangler secret put DASHBOARD_SESSION_SECRET
```

`wrangler dev --env local` runs without the remote service binding.

## Validation

```bash
npm run build
node --test tests/rendered-html.test.mjs
npm run check
```
