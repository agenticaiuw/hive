# Agentic Wearable — System Architecture & Ecosystem

*How the device, your laptop, and the cloud split the work — plus what to store where, how to reach your calendar/email/reminders, and which open-source standards to build on instead of reinventing them.*

---

## 1. Guiding principles (learned from what already shipped)

The 2024–2025 wave of AI wearables is a graveyard with a few survivors, and the pattern is clear:

- **Humane AI Pin** and **Rabbit R1** tried to *replace the phone* (standalone cellular, "do anything" action models). Both collapsed under that ambition — broken features, heat, bad battery, mass returns.
- **Limitless Pendant** and **Omi/Friend** picked *one job* (capture conversations, remember things) and did it well. They survived (Limitless was acquired by Meta; Omi is a thriving open-source project).
- **Weight/comfort is the single biggest predictor** of whether a wearable is still used after week one.
- The viable devices are **complements to the phone, not replacements**.

**What this means for us.** Our edge is not "replace the phone" — it's **remove the phone's distraction while keeping its usefulness, hands-free.** Voice-first, screenless, fast. Cook, clean, study, walk — talk to it without stopping or looking. That thesis should veto any feature that pulls you back to a screen.

One deliberate divergence from the cheapest proven path: Omi streams audio to a **phone over Bluetooth** (the phone provides connectivity + compute). We're going **standalone cellular (LTE-M)** so the device is independent of the phone — which is truer to the distraction-free thesis, at the cost of more power/complexity. (See open question #1.)

---

## 2. The three tiers — where things actually run

Think of it as **brain / hands / senses**, deliberately separated because the wearable can't run an LLM (it's a 64 MHz Cortex-M33 with 1 MB flash / 256 KB RAM — nowhere near enough).

### Tier 1 — The wearable (senses + mouth)
Runs on the nRF9160 under **Zephyr RTOS**. Its whole job is capture, transport, and playback:
- Push-to-talk / button handling, LED + haptic notifications
- Microphone capture → **Opus** compression
- **LTE-M + TLS** transport to the server (batched, not always-streaming, to save power)
- Local playback of returned audio (TTS) — through the speaker, **or privately to AirPods over Bluetooth A2DP** (see §10)
- A small **local cache + outbox** (details in §3)

It holds **no AI and no long-term memory** — it's a thin, reliable client.

### Tier 2 — The always-on laptop / home box (hands) — *optional but powerful*
A machine you leave on (lid closed, online) running a small **local agent daemon**. This is where your browser-extension / computer-use idea lives. It exposes local capabilities as **tools** the cloud agent can call:
- **Browser control** (a Claude-in-Chrome-style extension) to act on web apps
- **Computer use** to drive native apps
- **Bridges to closed ecosystems** — e.g., Apple **Reminders/Calendar via EventKit**, Mail — which have no open cloud API and *only* work from a machine signed into your account

This box is an **actuator**, not a memory store. It's how the agent gets real "hands" on your actual accounts and screen.

### Tier 3 — The cloud server (the brain)
The intelligence and the durable state:
- **STT** (Deepgram / Whisper), **LLM agent** (Claude with tools), **TTS** (Cartesia)
- **Persistent memory** — conversation history, summaries, personal knowledge (vector index + profile). *You were right: this belongs here, not on the device.*
- **Orchestration** — decides which tool/integration to call, talks to external APIs and to your Tier-2 laptop
- **Encrypted account credentials/tokens**

---

## 3. Data-placement matrix (local vs server vs your devices)

The rule: **on-device storage is only for things that are (a) directly useful to you, (b) latency-sensitive, or (c) needed offline.** Everything else lives server-side.

| Data | Where | Why |
|---|---|---|
| Today / next-few-days **reminders & calendar events** (read-only cache) | **Device** | Answer "what's next?" instantly and offline |
| **Voice memos / recordings** (until uploaded) | **Device** | Capture works with no signal; upload later |
| **Outbox** (commands/notes captured offline) | **Device** | Nothing lost during dead zones; sync when back |
| Cached **TTS for canned replies** ("got it", "no signal") | **Device** | Instant feedback without a round-trip |
| **User settings / device identity / keys** | **Device** (keys in secure storage / TrustZone) | Config + secure boot |
| **Persistent memory** (history, summaries, embeddings, profile) | **Server** | Needs the LLM; too big and too sensitive for the device |
| **Account tokens** (Google, Microsoft, etc.) | **Server** (encrypted) | Central, revocable, never on the wearable |
| **Media library** (audiobooks, music, articles) + index | **Server** streams / **Device** caches the current item | Big; stream on demand, cache what you're playing |
| The **actual accounts, apps, files, browser** | **Your devices** (laptop/phone) | The agent *acts on* these; it doesn't own them |

---

## 4. Talking to calendar, reminders, and email

The clean, modern way to wire any of these into an agent is the **Model Context Protocol (MCP)** — the open standard (created by Anthropic, now under the Linux Foundation) that every major AI vendor adopted in 2025. You expose each integration as an **MCP server**; the cloud agent calls it as a tool. Thousands already exist, including calendar/email ones, so you rarely build from scratch.

**Google & Microsoft (the easy 90%).** Google Calendar API and Microsoft Graph (calendar + mail + to-do) are proper REST APIs with OAuth and webhooks. These cover most people and are the place to start.

**Apple is the hard one — and where your always-on laptop earns its keep.** iCloud Calendar is reachable only via **CalDAV** (XML-over-HTTP, an Apple-ID app-specific password, no OAuth, no webhooks, you must poll — and free/busy is flaky). **Apple Reminders has no server API at all.** The reliable path is a small app running on your **always-on Mac** using **EventKit** (Apple's native Calendar/Reminders framework), exposed to the agent as an MCP tool. So the laptop isn't just a nice-to-have for browser control — it's the *only* clean bridge into Apple's closed apps.

**Email.** Gmail API, Microsoft Graph, or IMAP/SMTP for everything else — again, wrap as MCP tools.

**Pragmatic v1 suggestion.** Commit to **Google Calendar + a cross-platform task app with a real API (Todoist/Notion)** first, rather than fighting Apple's ecosystem on day one. Add Apple Reminders/Calendar via the EventKit-on-your-Mac bridge once the core loop works.

---

## 5. The always-on laptop pattern (your browser / computer-use idea)

This is a strong idea and it maps cleanly onto today's tooling:

1. A **local agent daemon** on the always-on machine keeps a persistent, authenticated connection out to your server (so you don't have to expose the laptop to the internet).
2. It publishes **MCP tools**: `browser.*` (a Chrome extension like Claude-in-Chrome), `computer.*` (computer use), `apple.*` (EventKit for Reminders/Calendar), `mail.*`.
3. The cloud agent, mid-task, calls those tools; the laptop **executes locally** — books the appointment in the browser, reads your Reminders, drives an app — and returns the result up to the agent, which speaks it back through the wearable.
4. **Lid-closed always-on:** disable sleep (`caffeinate` / `pmset`), auto-restart the daemon, reconnect on wake.

**Security is the real design constraint here** — this is Jarvis-grade power over your real machine and accounts. Non-negotiables: scope each tool tightly, require explicit confirmation for anything irreversible (sending, purchasing, deleting), keep the connection on your own network/VPN (e.g., Tailscale), and log every action. Treat the wearable's audio as *requests*, never as authenticated commands to move money or change security settings.

---

## 6. OS and open-source standards to build on (don't reinvent)

| Layer | Use / copy | Notes |
|---|---|---|
| **Device firmware OS** | **Zephyr RTOS** via **nRF Connect SDK** | Exactly what Omi and Nordic use; C. Not Linux (chip's too small). |
| **Voice pipeline architecture** | **Home Assistant "Assist" + Wyoming protocol** | Clean open standard that decouples wake-word / STT / TTS / intent as swappable network services. Study it even if you don't run HA — it's the reference design for a "voice satellite → server" split. |
| **Wake word** | **openWakeWord** (server-side) or **microWakeWord** (on-device, ESP32-class) | Trainable custom wake words. nRF9160 has no NPU, so start with **push-to-talk**; add wake-word later (possibly on a co-processor). |
| **Audio codec** | **Opus** (libopus) | Speech-optimized, tiny bitrates. |
| **Agent ↔ tools** | **MCP** (Model Context Protocol) | The standard for calendar/email/browser/computer tools. Build integrations as MCP servers. |
| **STT / LLM / TTS** | Deepgram or Whisper / Claude / Cartesia | As in the original stack. |
| **Reference project to study or fork** | **Omi** (`BasedHardware/omi`) | Full-stack **MIT-licensed**: nRF + Zephyr firmware *and* a cloud backend. The closest existing thing to what you're building. Also the ESP32 "Xiaozhi" voice-assistant projects. |

The big win: between **Zephyr + Wyoming + MCP + Omi's open code**, most of the scaffolding already exists. Your novel work is the *integration and the product thesis*, not the plumbing.

---

## 7. Why this shape serves the "Jarvis, minus the distraction" vision

Everything above is in service of one idea: an assistant that's **present without a screen**. The value isn't a new gadget to stare at — it's *not* staring at anything. So:

- **Voice-first, hands-free** → talk while cooking, cleaning, walking, or with your textbook open.
- **Complement, don't replace** → it doesn't need to do everything your phone does; it needs to do the *frequent, interruptive* things (capture a thought, set a reminder, ask a quick question, hear your next event) without the phone's rabbit-holes.
- **Persistent memory (server) + directly-useful cache (device)** → continuity and instant local answers, without pretending the device is smart on its own.

---

## 8. Open architectural questions to decide next

1. **Phone-tethered (BLE) vs. standalone cellular.** Standalone (current design) is truer to the distraction-free thesis and needs no phone; BLE-to-phone (Omi's path) is cheaper, lower-power, and proven. *Recommendation: stay standalone, but know the tradeoff.*
2. **Wake word vs. push-to-talk for v1.** *Recommendation: PTT first* (simpler, lower power, better privacy); add wake-word later.
3. **Always-listening vs. explicit activation.** *Recommendation: explicit activation* — better trust, battery, and legal footing (two-party consent laws).
4. **First integration target.** *Recommendation: Google Calendar + Todoist/Notion*; Apple via the EventKit-on-Mac bridge later.
5. **How central is the always-on laptop?** Required for Apple + deep computer control; optional if you live in Google/Microsoft land. Decide whether v1 assumes it.
6. **Privacy/security model for Tier 2.** Confirmation gates, network isolation, action logging — design before you give the agent hands.

## 9. The backend web app + database (your system of record)

Yes — you need a **web dashboard backed by your own database**, and it's not a fourth thing: it's the Tier‑3 server given a face. The **database is the system of record**; the wearable and the laptop daemon are clients that sync to it. Everything the agent captures or does flows through here.

**What the web app is for:**
- Account + onboarding, and **connecting integrations** — the OAuth "Allow Google / Microsoft" consent flow *must* happen in a browser, so this is where it lives.
- **Device pairing** (register the wearable and the laptop daemon).
- **History** — browse and replay voice memos, read transcripts.
- **Action timeline** — a human-readable "what did my agent actually do?" view (the audit log).
- **Memory management** — view / edit / delete what the agent knows about you. This is the single biggest trust feature.
- **Settings** — privacy, retention, confirmation rules, wake behavior.

A web dashboard is enough for v1; a thin mobile app can come later.

**What to store in your database:**

| Group | Tables / data | Notes |
|---|---|---|
| Identity | `users`, `devices` | device = wearable / laptop-daemon / phone; track fw version, last-seen, pairing keys |
| Conversations | `sessions`, `messages` (role, text, audio_ref, ts) | one row per utterance; **audio blobs go to object storage** (S3/R2) — DB holds references, not the audio |
| **Action log** | `actions` (tool, params, result, target_device, ts, confirmation_state) | **append-only audit trail** — the cross-device "what happened" history; essential for a device that takes real actions |
| Memory | `memory_facts`, `summaries` + a **vector index** | the agent's brain; embeddings for semantic recall |
| Integrations | `integrations` (provider, scopes, status) | **tokens live in a secrets manager / KMS, not raw in the DB** — store only references |
| User content | `memos`, `reminders/tasks`, `media_library` (+ playback position) | canonical copies of the directly-useful data the device caches |
| Sync | per-device sync state, outbox receipts | reconcile device cache ↔ server |
| Ops | usage / billing, consent + retention settings, logs | |

**A stack that keeps v1 simple:** **Postgres** (structured data) **+ pgvector** (memory embeddings, so you don't need a separate vector DB yet) **+ object storage** (S3 / Cloudflare R2 for audio and media). Model the `actions` log as **append-only / event-sourced** so you keep a perfect, immutable record of everything the agent did.

**Handle with care — this is unusually sensitive data:**
- **Encrypt at rest.** Keep OAuth tokens and device keys in a **secrets manager (Vault / KMS)**, never plaintext in the DB.
- Audio and transcripts can capture **other people's voices** → tight access control, **retention limits**, one-click delete, and respect two-party-consent laws.
- Give users **view / export / delete-everything** (GDPR / CCPA) — and because it's a *personal* device, it's simply the right default.

## 10. Private audio output — AirPods (committed decision)

**Decision:** the agent's replies play privately to the user's **AirPods** over **Bluetooth A2DP (output only)**. The user still speaks to the device's on-board PDM mic (kept for quality + speech-to-text), so we deliberately avoid Bluetooth HFP.

**Why a co-processor:** the nRF9160 has no Bluetooth, and AirPods use **Bluetooth Classic**, which Nordic's BLE-only silicon can't do. So a dedicated Classic-BT audio module sits alongside the nRF9160:
- **Prototype:** a classic **ESP32** (original ESP32-WROOM — *not* the S2/S3/C3, which lack Classic BT) running an A2DP-source library. Doubles as the WiFi test rig.
- **Product:** a **Microchip BM83** turnkey audio module — runs the whole BT-audio stack, fed I²S, controlled over UART; smaller and lower-power than a second MCU. *(Add to the production BOM.)*

**Flow:** server TTS → nRF9160 → I²S → BT module → A2DP → AirPods. The nRF9160 drives the module (pair / connect / volume) over UART.

**Design consequences to carry forward:**
- **Power:** Classic-BT streaming draws tens of mA continuously → size the battery for it and only stream during an active conversation.
- **AirPods single-link UX:** pairing to the device pulls the AirPods off the user's iPhone (and back afterward) — this hand-off is the main UX challenge; design the connect flow early.
- **Latency** ~100–200 ms — fine for spoken replies.

---

*Sources: prior-art and standards survey (Humane/Rabbit/Limitless/Omi; Home Assistant Assist + Wyoming; Model Context Protocol; Google/Microsoft/Apple calendar APIs). Specific API-access details (especially Apple CalDAV/EventKit) should be re-validated against current docs at implementation time.*
