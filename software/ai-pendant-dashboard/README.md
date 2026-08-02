# AI Pendant Mission Control

App-authenticated dashboard for the AI Pendant hardware and cloud pipeline.

It shows:

- Cloudflare Worker, D1, Workers AI, and Mac bridge health
- live nRF microphone recordings and transcription quality
- the six-stage voice pipeline from speech-to-text through I²S playback
- recent commands, agent responses, timing, PCM, and hardware telemetry
- canonical D1-backed chat/session and memory summaries shared with iOS
- sanitized Mac permission status, browser-extension connectivity, and recent
  local-agent activity

The browser never receives the relay API key. The server-side dashboard route
reads `RELAY_URL` and `RELAY_API_KEY` from hosted runtime settings, then proxies
snapshot requests through the authenticated Cloudflare relay.

Mission Control deploys to the `ai-pendant-dashboard` Cloudflare Worker
(`npm run deploy:cloudflare`). The `ai-pendant-mission-control.*.workers.dev`
relay URL is the protected machine API, so opening it directly in a browser is
expected to return an authentication error.

The dashboard URL can be public because Mission Control enforces its
own pairing-key session before serving the dashboard or any API route. Set
`DASHBOARD_ACCESS_KEY` to a random value of at least 16 characters and
`DASHBOARD_SESSION_SECRET` to an independent random value of at least 32
characters. Authentication fails closed if either value is missing or weak.

## Local development

```bash
npm install
npm run dev
```

Set the four values described in `.env.example` before opening the live data
view.

## Validation

```bash
npm run build
node --test tests/rendered-html.test.mjs
npm run lint
```
