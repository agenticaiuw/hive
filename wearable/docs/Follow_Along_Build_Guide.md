# Agentic Wearable — Follow-Along Build & Learning Guide

A phase-by-phase roadmap that pairs **what to learn** with **what to build next**, tied to *this* project (nRF9160 wearable + cloud agent + web app). Resources are real and current as of writing — where a deep link might drift, the hub page is given so you can find the course.

---

## How to use this guide

- **Three people, three parallel tracks.** They sync at the milestones, not on a calendar.
  - 🔧 **Hardware/Firmware** — Evan (EE). Starts from C/embedded fundamentals.
  - 🧠 **Backend/AI** — CS teammate. The server "brain" + agent.
  - 🖥️ **Web/Integrations** — CS teammate. Dashboard, database, MCP tools.
- **Phases are gated by milestones, not weeks.** Don't move on until the milestone works.
- **Honest expectation:** if you're new to C/embedded, Phases 0–2 realistically take several weeks, not days. The "5-week plan" assumes you lean hard on the **DK + breakouts + existing code** and treat the **custom PCB (Phase 4–5) as a stretch/next iteration**. Get the DK prototype working end-to-end first.
- **Read first (everyone):** `Design/Design_Package_v1.md` and `Design/System_Architecture_Ecosystem.md` in this project — they define what you're building and where each piece lives.

---

## Phase 0 — Foundations & setup

*Goal: everyone can build, flash, and run "hello world" on their track.*

### 🔧 Programming + embedded fundamentals (start here if new to C)
1. **Programming from zero** — Harvard **CS50x** (free), which teaches C from scratch: <https://cs50.harvard.edu/x/>
2. **Embedded C specifically** — FastBit "Microcontroller Embedded C Programming: Absolute Beginners" (builds real GPIO drivers, no prior experience needed): <https://www.udemy.com/course/microcontroller-embedded-c-programming/>
3. **The toolchain** — install nRF Connect for VS Code + SDK: <https://www.nordicsemi.com/Products/Development-software/nRF-Connect-SDK/GetStarted> · install docs: <https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/installation/install_ncs.html>
4. **First firmware** — Nordic Developer Academy, **nRF Connect SDK Fundamentals**, Lesson 1: <https://academy.nordicsemi.com/all-courses/> (free, self-paced)

> **Milestone 🔧:** write and run a C program that uses pointers + bitwise ops; build & flash "Blinky" (on `native_sim` now, on the DK when it arrives).

### 🧠🖥️ Repo, infra, and accounts
1. **Git** — Pro Git book (free): <https://git-scm.com/book> → create the shared GitHub repo.
2. **Backend skeleton** — FastAPI: <https://fastapi.tiangolo.com/> · PostgreSQL: <https://www.postgresql.org/> · pgvector: <https://github.com/pgvector/pgvector>
3. **API accounts** — Anthropic (agent): <https://docs.claude.com/> · Deepgram (STT): <https://developers.deepgram.com/> · Cartesia (TTS): <https://docs.cartesia.ai/>

> **Milestone 🧠🖥️:** a "hello world" API server running locally, connected to a local Postgres, committed to the shared repo.

---

## Phase 1 — Prove each piece in isolation

*Goal: every subsystem works alone, on the bench.*

### 🔧 Firmware + peripherals
- Work through **nRF Connect SDK Fundamentals** (GPIO → buttons/LEDs → I²C/SPI/I²S samples): <https://academy.nordicsemi.com/all-courses/>
- Wire the breakouts (amp, mic, haptic, LED) to the DK or the ESP32 test rig; drive each from firmware.
- Reference: Zephyr docs (devicetree, drivers): <https://docs.zephyrproject.org/>

> **Milestone 🔧:** button → LED + read an I²C sensor; play a tone over I²S to the amp/speaker; capture audio from the PDM mic.

### 🧠 The server round-trip
- Build the **audio → STT → LLM → TTS → audio** pipeline as a plain HTTP service.
- Anthropic tool use (agent + tools): <https://docs.claude.com/en/docs/build-with-claude/tool-use>
- Test it from your laptop (or the ESP32-over-WiFi rig) — no cellular needed yet.

> **Milestone 🧠:** POST a `.wav`, get a spoken response back.

### 🖥️ Dashboard + database schema
- Stand up the tables from `System_Architecture_Ecosystem.md` §9 (users, devices, sessions, messages, **actions** audit log).
- Minimal web dashboard to view them.

> **Milestone 🖥️:** log a fake session + action to Postgres and see it in the dashboard.

---

## Phase 2 — Connect the tiers (thin client ↔ brain)

*Goal: the wearable talks to the cloud agent — the core loop.*

### 🔧 Cellular transport
- Nordic Developer Academy, **Cellular IoT Fundamentals** (LTE-M attach, TLS, HTTPS POST, power saving): <https://academy.nordicsemi.com/courses/cellular-iot-fundamentals/>

> **Milestone 🔧 (the big one):** the DK captures audio, sends it over LTE-M/TLS to your server, and plays the reply.

### 🧠 Make it a real agent
- Add streaming, conversation memory (embeddings in pgvector), and the outbox/sync logic.

### 🖥️ First integration via MCP
- Learn MCP: quickstart + Python SDK: <https://modelcontextprotocol.io/> · <https://github.com/modelcontextprotocol/python-sdk> · guided course: <https://learn.deeplearning.ai/courses/mcp-build-rich-context-ai-apps-with-anthropic/>
- Build (or adopt) a **Google Calendar MCP server** and wire it to the agent's tool-calling.

> **Milestone 🖥️:** ask "what's on my calendar?" by voice and get a spoken answer.

---

## Phase 3 — The "Jarvis hands" + persistence

*Goal: the agent remembers, acts on your real accounts, and works offline.*

- 🖥️ **Always-on laptop daemon** — expose browser control + computer use as MCP tools; add the **Apple EventKit bridge** for Reminders/Calendar (the only clean path into Apple's apps). Security gates on every side-effecting action.
- 🧠 Wire **memory + the action log** to the dashboard; require confirmations for irreversible actions.
- 🔧 **On-device storage** — LittleFS (internal flash) / FAT (microSD); offline capture + outbox. Then **power profiling** with the Nordic PPK2: <https://www.nordicsemi.com/Products/Development-hardware/Power-Profiler-Kit-2> and PSM/eDRX low-power modes.

> **Milestone:** capture a memo with no signal → it syncs later; the agent completes one real action (with a confirmation) end-to-end.

---

## Phase 4 — Custom PCB (hardware phase 2)

*Goal: move off the DK onto your own board.*

- **KiCad basics** — official getting-started: <https://www.kicad.org/> · docs: <https://docs.kicad.org/>
- **Full hardware design walkthrough** — Phil's Lab KiCad 9 tutorial (schematic + PCB): <https://www.youtube.com/watch?v=O-zNn5k5Bn4> and <https://www.youtube.com/watch?v=igQWdVGZGpI> · channel: <https://www.youtube.com/@PhilsLab>
- **RF / antenna layout** (the part that's genuinely different) — Phil's Lab RF videos + **Nordic's nRF9160 hardware design guidelines & antenna app notes** on the nRF9160 docs page: <https://www.nordicsemi.com/Products/nRF9160>
- **Soldering SMD** — Adafruit's Guide to Excellent Soldering: <https://learn.adafruit.com/adafruit-guide-excellent-soldering>
- Manufacture (JLCPCB/OSHPark) using the DFM notes already in your design package.

> **Milestone 🔧:** bring up your own board, flash it, and run the Phase 1–3 firmware on it.

---

## Phase 5 — Enclosure, integration, polish

- 🔧 Enclosure/CAD (you have a 3D model started), acoustics (mic/speaker ports), wearability, final assembly.
- **All:** end-to-end testing, real battery-life measurement, privacy/retention settings, and a security review of the laptop bridge before anyone relies on it.

> **Milestone:** a wearable prototype you actually wear for a day and use hands-free.

---

## Don't-reinvent shortcuts (study or fork these)

- **Omi** — a full-stack, MIT-licensed AI wearable: nRF + Zephyr firmware *and* a cloud backend. The closest existing thing to your project: <https://github.com/BasedHardware/omi>
- **Home Assistant "Assist" + Wyoming protocol** — the reference design for a voice-satellite → server split: <https://www.home-assistant.io/integrations/wyoming/> · <https://github.com/rhasspy/wyoming-satellite>
- **Zephyr sample apps** — most peripheral/cellular basics already exist as samples in the SDK.
- **Existing MCP servers** — calendar/email/browser tools often already built; wire them, don't rewrite them.

## Cross-cutting references

- Opus audio codec: <https://opus-codec.org/>
- Model Context Protocol (spec + ecosystem): <https://modelcontextprotocol.io/>
- Zephyr Project docs: <https://docs.zephyrproject.org/>
- Nordic Developer Academy (all free courses): <https://academy.nordicsemi.com/all-courses/>

---

## Suggested learning order for Evan (new to C/embedded)

1. CS50 (C fundamentals) — enough to be comfortable with pointers, bitwise, structs.
2. FastBit Embedded C — registers, GPIO, the embedded mindset.
3. Nordic **nRF Connect SDK Fundamentals** — Zephyr, devicetree, build/flash/debug.
4. Buses in practice — I²C/SPI/I²S by wiring the breakouts.
5. Nordic **Cellular IoT Fundamentals** — the LTE loop.
6. **Only then** KiCad + Phil's Lab + RF layout for the custom board.

Everything before step 6 runs on the DK + breakouts you already ordered — so you can go a long way before touching a custom PCB.
