# AI Pendant Dashboard (SvelteKit)

SvelteKit port of `software/ai-pendant-dashboard`, the app-authenticated
dashboard for the AI Pendant hardware and cloud pipeline. Same UI, same auth,
same relay contract — Svelte 5 runes instead of React, `@sveltejs/adapter-cloudflare`
instead of the hand-written Worker entry.

The React app is still the live deployment. Nothing here has been deployed.

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

Bindings arrive per request through `event.platform.env` and are stashed on
`event.locals.runtimeEnv`. When there is no platform at all (`node --test`, or a
plain Node host) the server falls back to the dynamic private env. Either way,
if there is no `RELAY` service binding the relay helpers use
`fetch(RELAY_URL + path)`.

## Local development

```bash
npm install
npm run dev
```

`vite dev` emulates the Worker bindings through Wrangler against the `local`
environment in `wrangler.jsonc` — same vars, no service binding, because the
remote relay Worker cannot be stood up locally. Put the values described in
`.env.example` in a `.env` (or `.dev.vars`) file; Wrangler loads them into
`platform.env`.

## Deploy

```bash
npm run deploy:cloudflare
```

Deploys the `ai-pendant-dashboard` Worker with the `RELAY` service binding to
`ai-pendant-mission-control`. The three secrets are never in `wrangler.jsonc`:

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
