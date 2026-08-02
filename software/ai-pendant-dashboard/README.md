# AI Pendant Mission Control

Private deployed dashboard for the AI Pendant hardware and cloud pipeline.

It shows:

- Cloudflare Worker, D1, Workers AI, and Mac bridge health
- live nRF microphone recordings and transcription quality
- the six-stage voice pipeline from speech-to-text through I²S playback
- recent commands, agent responses, timing, PCM, and hardware telemetry

The browser never receives the relay API key. The server-side dashboard route
reads `RELAY_URL` and `RELAY_API_KEY` from hosted runtime settings, then proxies
snapshot requests through the authenticated Cloudflare relay.

Open the deployed `*.chatgpt.site` URL to use Mission Control. The
`*.workers.dev` relay URL is the protected machine API, so opening it directly
in a browser is expected to return an authentication error.

## Local development

```bash
npm install
npm run dev
```

Set the two values described in `.env.example` before opening the live data
view.

## Validation

```bash
npm run build
node --test tests/rendered-html.test.mjs
```
