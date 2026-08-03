# AI Pendant Simulator

## Short Description

AI Pendant Simulator is a minimal phone-style controller plus Mac local agent prototype. The browser acts like an AI pendant: it accepts a command, prepares a short plan, asks for confirmation, then sends safe predefined actions to a local Mac worker.

## Features

- Real Voice Pendant Interaction using the browser Web Speech API
- Minimal Pendant Controller UI
- Mac Control Mode as the default experience
- Large pendant button and concise connection status
- Pendant tap starts voice input and automatically prepares a plan
- Natural-language Agent Plan summary
- Confirm / Cancel before execution
- Execution result as the primary output
- Advanced / Developer Panel for setup and logs
- Saved Mac Agent URL and Agent Token fields
- Test Mac Connection button
- Safe predefined Mac actions only
- Mac Activity Log from the local agent
- Ontology-style Context Graph stored in `local-agent/memory/context_graph.json`
- Follow-up command resolution for references like `that email` and `him`
- Hidden Mock Demo Mode for developer testing
- Export Demo Log as `ai-pendant-demo-log.json`
- Reset Demo Data

## How To Run

Install dependencies:

```bash
npm install
```

Start the Mac local agent:

```bash
npm run agent:setup
```

This installs `~/Applications/AI Pendant Agent.app` with an embedded Node
runtime and signs it with the first available Apple code-signing identity. The
app is the permanent macOS privacy identity, so changing terminals, repository
folders, or NVM versions does not create a new permission target. Approve
Accessibility, Screen Recording, and the requested Automation targets for
**AI Pendant Agent**, then enable the login service:

```bash
npm run agent:autostart
```

Follow the local service logs from any directory with:

```bash
npm --prefix /path/to/agentic-gadget/software/ai-pendant-simulator run agent:logs
```

The local agent requires a shared token. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Then edit `.env`:

```text
AGENT_TOKEN=some-random-token
VITE_AGENT_TOKEN=some-random-token
```

`VITE_AGENT_TOKEN` is only for local demo convenience. It pre-fills the token in the browser controller. Do not use this pattern for a public deployment.

Start the browser controller:

```bash
npm run dev
```

For phone testing on the same Wi-Fi, run:

```bash
npm run dev:host
```

Find the Mac local IP:

```bash
ipconfig getifaddr en0
```

Then open this URL on the phone:

```text
http://<mac-local-ip>:5173
```

In the controller UI, set:

```text
Mac Agent URL: http://<mac-local-ip>:8000
Agent Token: <AGENT_TOKEN from .env>
```

Click `Save Agent URL`, then `Test Mac Connection`.

## Main UI

The default screen is intentionally minimal:

- Pendant button for voice command input
- Mac connection status
- Command input
- Three quick actions: Open Gmail, Create Note, Run Project
- Short Agent Plan summary
- Confirm / Cancel
- Last execution result

Technical controls and logs are hidden under `Advanced / Developer Panel`.

## Voice Interaction

On mobile Chrome:

1. Open the controller page.
2. Tap the pendant button.
3. Allow microphone permission.
4. Speak a command, such as `Open Gmail on my Mac`.
5. Review the generated plan.
6. Tap `Confirm`.

If the browser does not support the Web Speech API, the controller shows:

```text
Voice input is not supported in this browser. Please type your command instead.
```

iPhone Safari may have limited Web Speech API support. Use the text command input as the fallback.

## Mac Agent API

- `GET /health`
- `POST /plan`
- `POST /execute`
- `GET /logs`
- `GET /context-graph`
- `POST /context-graph/reset`

Protected endpoints require:

```text
Authorization: Bearer <AGENT_TOKEN>
```

Example:

```bash
curl -X POST http://localhost:8000/plan \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <AGENT_TOKEN>' \
  -d '{"command":"Open Gmail on my Mac."}'
```

## Supported Actions (Full Control Mode)

When `FULL_CONTROL_MODE=true` and `LLM_API_KEY` is set, the LLM can plan any combination of:

- `run_shell` — terminal commands (git, npm, brew, curl, etc.)
- `run_applescript` — deep macOS automation
- `open_url` / `open_app` / `open_path` — any site, app, or file
- `write_file` / `read_file` / `list_directory` — document creation and editing
- `delete_path` / `copy_path` / `move_path` — file management
- `type_text` / `press_keys` — keyboard control of the frontmost app
- `send_email` — send or draft via Mail.app
- `screenshot` / `get_clipboard` / `copy_to_clipboard`
- `create_note` / `run_project` / `search_file`

Shopping, Google Docs, and browser-based tasks use a combination of `open_url`, `type_text`, and `press_keys`.

macOS will ask for **Accessibility**, **Screen Recording**, and **Automation**
permissions for the signed **AI Pendant Agent** app during
`npm run agent:setup`.

## Supported Safe Actions (Legacy Demo Mode)

Set `FULL_CONTROL_MODE=false` to restore:
- `open_url(url)` for whitelisted URLs: Gmail, Google Calendar, Google Drive, GitHub
- `open_app(appName)` for whitelisted apps: Chrome, Calendar, Finder, VS Code
- `open_folder(path)` for whitelisted folders only
- `create_note(filename, content)` inside the configured workspace only
- `copy_to_clipboard(text)`
- `run_project(path)` for whitelisted project folders only
- `search_file(query)` inside whitelisted roots only

## Demo Commands

- `Open Gmail on my Mac.`
- `Open Calendar on my Mac.`
- `Open my AI pendant project in VS Code.`
- `Create a note called meeting notes.`
- `Draft an email to David about computing resources and copy it to clipboard.`
- `Run the AI pendant simulator project.`
- `Search my Downloads folder for simulator zip.`
- `Make that email shorter.`
- `Create a reminder to follow up with him tomorrow.`

The last two commands use the local Context Graph. For example, after drafting an
email to David about GPU resources, `that email` resolves to the latest
`EmailDraft` entity and `him` resolves to the related `Person` entity.

## Context Graph

The Mac local agent keeps a lightweight ontology-style graph in:

```text
local-agent/memory/context_graph.json
```

Entity types include `Person`, `Project`, `Task`, `File`, `EmailDraft`,
`Resource`, `Tool`, `Action`, `Device`, and `Model`.

Relation types include `related_to`, `about`, `sent_to`, `created_file`,
`executed_on`, `belongs_to_project`, `requires`, `uses`, `follows_up`,
`stored_at`, and `available_through`.

The graph is updated after successful confirmed actions. It is shown only in
the `Advanced / Developer Panel`, not on the main pendant controller screen.
Open the panel and use `Refresh Context Graph` to load the current graph, or
`Load Demo Graph` to seed a prepared ontology demo with David, GPU resources,
an email draft, a follow-up task, tools, and MacBook relations.

## Security Constraints

When `FULL_CONTROL_MODE=true` (default), the agent can run shell commands, manage files, send Mail.app email, and automate the keyboard. Remote access still requires API keys and pairing. Every action still requires **Confirm** before execution.

Set `FULL_CONTROL_MODE=false` to restore whitelist-only demo mode:

- No arbitrary shell command execution
- No destructive delete, move, or system-setting actions
- No real email sending
- File and folder paths restricted to configured whitelist locations

## Current Limitations

- Full control requires `LLM_API_KEY` for open-ended natural language commands.
- Keyboard automation needs macOS Accessibility permission for the signed
  `AI Pendant Agent.app`.
- Mail sending uses Mail.app, not Gmail API.
- Browser shopping automation depends on visible UI automation (no headless browser yet).
- Voice input depends on browser Web Speech API support.

## Dashboard & Session History

- **Mac Ops dashboard** (full control room): `http://localhost:8000/dashboard` after `npm run build && npm run agent` — see [docs/OPS_DASHBOARD.md](docs/OPS_DASHBOARD.md)
- Sessions, context graph editing, job queue, relay/bridge health, and activity logs live there
- Pendant UI also has a lighter **Dashboard** panel for session turns
- Sessions are stored on the home Mac at `AI-Pendant-Workspace/pendant-sessions.json`

## Relay History, Playback & Memory APIs

Every route below lives on the Cloudflare relay, sits behind the normal auth
middleware, and requires the admin `RELAY_API_KEY` (the `/v1/ops/` prefix maps
to the `admin` scope, so a per-device token can never reach them). The
dashboard must keep proxying them server-side; a recording URL must never carry
the key.

| Route | Purpose |
| --- | --- |
| `GET /v1/ops/history?limit=&cursor=&q=&origin=` | Newest-first page of runs: transcript, origin (`microsd` / `dashboard`), status, spoken reply, timestamps, and whether a recording exists. |
| `GET /v1/ops/history/:pipelineId` | One run: full event timeline, planned actions, execution results, and the spoken reply. Also served as `GET /v1/ops/voice-runs/:pipelineId`. |
| `GET /v1/ops/history/:pipelineId/audio` | Streams that run's recording (R2, falling back to the inline D1 copy) with `Accept-Ranges: bytes` and `Cache-Control: private, no-store`. |
| `DELETE /v1/ops/history/:pipelineId/audio` | Deletes one recording. |
| `GET /v1/ops/memory?q=&sessionLimit=&turnLimit=` | Canonical `product_memory_entities` / `product_memory_relations` plus sessions and turns. Reads D1 directly, so it keeps working while the Mac bridge is offline. |
| `GET /v1/ops/audio-retention` | Reports the retention policy and how many recordings are already past it. Read-only. |
| `POST /v1/ops/audio-retention/sweep` | Expires old recordings in bulk. Dry-run by default. |

Pagination is keyset based: `cursor` is the opaque `<createdAt>|<jobId>` value
returned as `nextCursor`, so two runs sharing a millisecond cannot hide each
other across a page boundary. `q` searches the transcript and the spoken reply.

Every history response carries a `retention` block, because relay run records
are pruned after `JOB_TTL_MS` (24 hours by default). Recordings, their
transcripts, and `product_turns` outlive that window; the run timeline does
not.

### Audio retention policy

Voice recordings are the owner's private audio and are deliberately exempt from
the 24-hour queue cleanup, so they need their own policy:

- `AUDIO_RETENTION_MAX_AGE_MS` — how long a recording is kept. Default 30 days.
  A blank, zero, or negative value falls back to the default; an accidental
  `0` must never mean "erase everything".
- `AUDIO_RETENTION_SWEEP_ENABLED` — must be `true` before a sweep may delete
  anything. Unset by default.

Delete paths:

1. **One run, on demand:** `DELETE /v1/ops/history/:pipelineId/audio` (or
   `DELETE /v1/ops/audio-captures/:captureId/audio`). Removes the R2 object and
   clears any inline Base64 copy, but keeps the capture row so the transcript
   and history stay intact. Add `?mode=record` to drop the row as well.
2. **Everything expired:** `POST /v1/ops/audio-retention/sweep`. Deletes only
   when the request passes `{"dryRun": false}` **and** the deployment sets
   `AUDIO_RETENTION_SWEEP_ENABLED=true`. Any other combination returns the list
   of recordings it would have removed and touches nothing.

## Context Engineering

- Recent turns (last 6–10) are injected into the LLM planner prompt
- Follow-up phrases like `that email`, `방금`, `그 사람`, `continue that` are resolved before planning
- Context graph memory (people, drafts, files) is included in the prompt block

## Browser Session Reuse (No OAuth Plugins)

Build the shared browser-extension package, then load the Chrome bundle:

```bash
node browser-extension/package.mjs
```

```text
chrome://extensions → Load unpacked → browser-extension/build/chrome
```

Set the loopback Agent URL + Agent Token in extension options. The token is
kept in local extension storage, never browser sync. The agent can then plan:

- `browser_navigate` / `browser_click` / `browser_type` / `browser_read_page`

These run inside Chrome with your existing logged-in cookies.

For Safari, open
`safari-browser-extension/AI Pendant Browser Bridge/AI Pendant Browser Bridge.xcodeproj`
in Xcode. The wrapper shares the same extension source and includes macOS and
iOS schemes.

## Built-in Programs (No LLM)

Instant programs routed by **exemplar scoring** (not brittle single keywords):

| Builtin | Example commands |
|---------|------------------|
| time | `What time is it?`, `지금 몇 시` |
| weather | `Weather in Seoul`, `오늘 날씨` |
| translate | `Translate hello to Korean`, `번역해줘` |
| meeting | `Record this meeting`, `미팅 기록` |

When confidence is high, the response returns instantly with `status: instant` (no Confirm step).

When confidence is medium, the intent is passed as a hint to the LLM planner.

## External Access Options

Remote cloud relay is now implemented. See [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md) for the full setup guide.

Architecture:

- **Remote Cloud mode** (default): mobile/nRF → Cloudflare Worker + D1
  metadata (+ private R2 audio when enabled) → home Mac bridge → local agent
- **Local Mac mode**: same Wi-Fi direct connection (original behavior)
- **LLM planner**: enable with `LLM_API_KEY` in `.env` (falls back to rules without it)

Quick start for local remote testing:

```bash
npm run relay    # cloud relay (port 8787)
npm run agent    # Mac local agent (port 8000)
npm run bridge   # home Mac bridge
npm run dev:host # mobile controller
```

### Live pendant pipeline

With `npm run agent` and `npm run bridge` running, open:

```text
http://localhost:8000/dashboard#pipeline
```

The live trace correlates one relay job across remote transcription, the local
agent/LLM, TTS generation, cloud handoff, nRF download, and I²S playback. It
also exposes sanitized timing/audio metadata and a playable copy of the exact
outgoing TTS waveform. “Thinking” means model-visible streamed output and tool
decisions; private hidden chain-of-thought is not exposed.

Deploy the relay with the authenticated Wrangler CLI:

```bash
npx wrangler d1 execute ai-pendant-relay-db --remote \
  --file=cloudflare-worker/schema.sql
npx wrangler secret put RELAY_API_KEY
npx wrangler secret put PAIRING_CODE
npm run relay:cloudflare:deploy
```

Diagnostic recordings are backward compatible with D1-only deployments. For
durable binary storage, create the private `ai-pendant-audio` R2 bucket, then
uncomment the `AUDIO_BUCKET` binding in `wrangler.jsonc` before deployment.
New recordings will store only private R2 object metadata in D1; existing D1
Base64 recordings remain readable. Audio-capture metadata is retained across
the normal 24-hour queue cleanup. The relay accepts diagnostic objects up to
8 MiB with R2 enabled and keeps the legacy D1 fallback capped at 1 MiB to stay
below D1's row limit. No bucket is exposed publicly.

Then set `RELAY_URL` and `VITE_RELAY_URL` to the emitted `workers.dev`
URL. Workers AI provides transcription; the home Mac generates the pendant
reply locally and compresses it as 16 kb/s Ogg Opus for the LTE return path.

## Next Steps

- Add signed action plans to prevent tampering between `/plan` and `/execute`.
- Add richer Mac automation with permission controls.
- Publish the mobile controller as an installable PWA.

## Project Structure

```text
src/
  App.jsx       Browser controller UI
  agent.js      Browser-only mock parser
  tools.js      Browser-only mock executor
  storage.js    localStorage helpers
  styles.css    UI styling

local-agent/
  server.js       Express API server
  bridge.js       Cloud relay bridge for remote access
  runBridge.js    Bridge entrypoint
  llmPlanner.js   LLM + rule-based planner
  planner.js      Rule-based Mac action planner
  executor.js     Safe Mac action executor
  contextGraph.js Ontology-style local JSON memory
  security.js     Whitelist path validation
  logger.js       Mac activity log persistence
  config.js       Allowed URLs, apps, folders, and projects

cloud-relay/
  server.js       Shared relay API (local Node or Cloudflare Worker)
  audioStorage.js Private R2 audio with legacy D1 Base64 fallback
  store/          In-memory local store and Cloudflare D1 store

cloudflare-worker/
  worker.js       Workers entrypoint for the shared Express relay
  schema.sql      Persistent D1 queue/device schema

wrangler.jsonc    Worker, D1, optional R2, and Workers AI bindings
```
