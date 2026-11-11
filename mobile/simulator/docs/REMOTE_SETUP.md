# Remote Access Setup (Cloudflare Relay)

The remote pendant stack uses Cloudflare rather than Google Cloud:

```text
nRF9160 or mobile controller
              |
              v
Cloudflare Worker
  - authenticated relay API
  - Workers AI speech-to-text
  - D1 jobs and device state
              |
              v
Home Mac bridge -> local agent -> LLM -> macOS speech -> Ogg Opus
              |
              v
Cloudflare D1 -> nRF9160 -> ESP32 -> Bluetooth audio
```

Google Cloud, Cloud Run, Firestore, and Google Speech credentials are not
required.

## Current deployment

The checked-in Wrangler configuration deploys:

- Worker: `ai-pendant-relay`
- D1 database: `ai-pendant-relay-db`
- Worker URL:
  `https://ai-pendant-relay.evan20050827.workers.dev`
- Speech model: `@cf/openai/whisper-large-v3-turbo`

The relay API key and pairing code are Cloudflare Worker secrets and are not
stored in `wrangler.jsonc`.

## Local configuration

Copy `.env.example` to `.env` and set:

```dotenv
RELAY_API_KEY=replace-with-a-random-relay-api-key
PAIRING_CODE=replace-with-a-random-pairing-code

RELAY_URL=https://your-worker.your-subdomain.workers.dev
VITE_RELAY_URL=https://your-worker.your-subdomain.workers.dev
BRIDGE_DEVICE_ID=home-macbook-bridge
LOCAL_AGENT_URL=http://127.0.0.1:8000
```

`RELAY_API_KEY` and `PAIRING_CODE` are server/agent secrets. Never prefix
either with `VITE_`: Vite variables are embedded in the browser and iOS web
bundles. The mobile app exchanges the one-time pairing code for a scoped device
credential, which iOS stores in Keychain.

The local agent still uses `LLM_API_KEY` for planning. Cloudflare Workers AI
handles pendant microphone transcription, while macOS speech creates the reply
audio on the Mac.

## Deploy

Authenticate Wrangler once:

```bash
npx wrangler login
npx wrangler whoami
```

Create the D1 database if it does not exist:

```bash
npx wrangler d1 create ai-pendant-relay-db --location enam
```

Copy the emitted database ID into the `DB` binding in `wrangler.jsonc`, then
initialize the schema:

```bash
npx wrangler d1 execute ai-pendant-relay-db --remote \
  --file=cloudflare-worker/schema.sql
```

Configure secrets:

```bash
npx wrangler secret put RELAY_API_KEY
npx wrangler secret put PAIRING_CODE
```

Deploy:

```bash
npm run relay:cloudflare:deploy
```

Verify:

```bash
curl https://your-worker.your-subdomain.workers.dev/health
```

A healthy production response reports:

- `"platform": "cloudflare-workers"`
- `"store": "d1"`
- `"speechToTextConfigured": true`
- `"relayApiKeyConfigured": true`

## Run the home Mac

Start the local agent and bridge in separate terminals:

```bash
npm run agent
npm run bridge
```

The bridge registers once, sends heartbeats, long-polls D1-backed work, calls
the local agent, generates 24 kHz mono speech, encodes it as 16 kb/s Ogg Opus,
and returns both the compressed pendant stream and raw preview PCM.

The health response reports `macBridgeOnline: true` while the bridge heartbeat
is current.

## nRF9160 configuration

The firmware relay hostname is defined in:

```text
firmware/nrf9160/src/pendant_cloud.c
```

The shared API key is provided through:

```text
firmware/nrf9160/secrets.conf
```

Do not commit or display that secret. Rebuild and flash after changing the
Worker hostname.

The firmware flow is:

1. First button press starts mono I2S microphone capture.
2. Second press stops capture; the nRF encodes and uploads Ogg Opus.
3. Workers AI transcribes it and D1 queues the transcript.
4. The Mac bridge runs the local agent and returns a 24 kHz Ogg Opus reply.
5. The nRF downloads and decodes the reply to PCM on microSD.
6. When the LED flashes in pairs, the next button press sends the reply over
   I2S to the ESP32 Bluetooth bridge.

## Relay routes

| Route | Method | Purpose |
|---|---:|---|
| `/health` | GET | Public service and bridge status |
| `/v1/devices/register` | POST | Pair a Mac bridge or mobile client |
| `/v1/devices/heartbeat` | POST | Refresh registered device state |
| `/v1/pendant/command` | POST | Transcribe raw pendant audio and queue it |
| `/v1/mac/plan` | POST | Queue a text plan request |
| `/v1/mac/execute` | POST | Queue confirmed actions |
| `/v1/mac/jobs/:jobId` | GET | Read job state and response audio |
| `/v1/bridge/work` | GET | Long-poll work for the Mac bridge |
| `/v1/bridge/work/:jobId/result` | POST | Return Mac results |
| `/v1/pendant/jobs/:jobId/events` | POST | Report device pipeline telemetry |

Every route except `/health` requires:

```text
Authorization: Bearer <RELAY_API_KEY>
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Relay returns 401 | `RELAY_API_KEY` differs between Worker, Mac, and firmware |
| Pairing returns 403 | `PAIRING_CODE` differs between Worker and `.env` |
| Bridge is offline | `npm run bridge` is stopped or points to the wrong Worker |
| Transcription returns 503 | The `AI` binding is missing from `wrangler.jsonc` |
| D1 table error | Re-run `wrangler d1 execute ... --file=cloudflare-worker/schema.sql --remote` |
| nRF TLS fails | Confirm the Worker hostname and root certificate chain |
