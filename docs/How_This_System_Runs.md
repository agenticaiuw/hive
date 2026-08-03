# How this system actually runs (plain English)

You asked what “flash the firmware,” “deploy the relay,” “TTS,” “bridge,” and “LaunchAgent” mean. Here is the map of the moving parts.

```
[Your voice] → nRF9160 board → internet (LTE) → Cloudflare “relay” computer
                                                      ↓
                                              Mac agent (this laptop)
                                                      ↓
                                              opens Outlook, etc.
                                                      ↓
                                              spoken reply (“TTS”)
                                                      ↓
                                              back to board → speaker
```

---

## 1. Flash nRF9160 firmware

**What it is:** Copying a new program onto the small computer on the Nordic board (the nRF9160 chip).

**Why you care:** Code changes in `firmware/nrf9160/` do **nothing** until they are written onto the chip. Editing files on your Mac only changes the *source*. Flashing is like installing an app update onto the board.

**How (this Mac, this project):**

Tools live under `/opt/nordic/ncs` (NCS v3.4.0 + toolchain `ccc010f809`) but are **not** on the default shell PATH. Either use the helpers, or export the env once per shell.

```bash
# One-liner env (preferred)
source ~/agentic-gadget/firmware/nrf9160/scripts/env.sh
# Or: eval "$(pendant-ncs-env)"   # ~/.local/bin wrappers for west/nrfutil

# Probe + tools only (no program)
~/agentic-gadget/firmware/nrf9160/scripts/flash.sh --check

# Build (from NCS workspace)
cd /opt/nordic/ncs/v3.4.0
west build -b nrf9160dk/nrf9160/ns \
  -d ~/agentic-gadget/firmware/nrf9160/build-cloud \
  ~/agentic-gadget/firmware/nrf9160 \
  -- -DEXTRA_CONF_FILE=~/agentic-gadget/firmware/nrf9160/secrets.conf

# Flash — default runner is nrfutil; jlink also works
# USB cable to the DK, onboard J-Link serial 960036581 (PCA10090)
~/agentic-gadget/firmware/nrf9160/scripts/flash.sh
# equivalent:
# west flash -d ~/agentic-gadget/firmware/nrf9160/build-cloud --runner nrfutil --dev-id 960036581
# west flash -d ~/agentic-gadget/firmware/nrf9160/build-cloud --runner jlink  --dev-id 960036581
```

Image flashed is the TF-M merged hex:
`firmware/nrf9160/build-cloud/nrf9160/zephyr/tfm_merged.hex`.

UART console after flash: `/dev/cu.usbmodem0009600365811` (interface ending in `1`), 115200 baud.

USB must be plugged in. After flash, the board reboots with the new behavior (live Opus encode, single-shot upload, etc.).

**ESP32 (HUZZAH32 AirPods bridge, optional):**

```bash
~/agentic-gadget/firmware/esp32-airpods-bridge/flash.sh --check
~/agentic-gadget/firmware/esp32-airpods-bridge/flash.sh
# or: cd firmware/esp32-airpods-bridge && .venv/bin/pio run --target upload
```

CP2104 port observed as `/dev/cu.usbserial-0287A9CA`.
---

## 2. Deploy the cloud relay worker

**What it is:** The **relay** is a small always-on program in Cloudflare’s cloud (`ai-pendant-mission-control…workers.dev`). It:

- Receives audio from the board  
- Turns speech into text (and optionally a plan)  
- Hands work to your Mac  
- Stores history  

**“Deploy”** means: upload the latest JavaScript from  
`software/ai-pendant-simulator/cloud-relay/`  
to Cloudflare so the public URL runs the new code (multimodal STT, single-shot command path, etc.).

**How:**

```bash
cd ~/agentic-gadget/software/ai-pendant-simulator
# needs wrangler logged in + secrets already set
npx wrangler deploy
# (exact command may be in README / wrangler.jsonc — same idea)
```

Until you deploy, the **internet side** still runs the *old* worker. Your Mac can run a local relay for testing, but the board talks to the **cloud** URL.

---

## 3. TTS (text-to-speech)

**What it is:** Turning the agent’s short answer text (“Opened Outlook on Mac”) into **sound** so the pendant can play it on the speaker.

On your Mac this currently uses the built-in `say` command → raw PCM → Opus.  
**Cached TTS** = remember that audio for “Done.” so the second time is instant.

Without TTS you would only see results on the dashboard; the pendant would stay silent.

---

## 4. Bridge

**What it is:** A small program on **this Mac** that:

1. Polls the cloud relay: “Any jobs for me?”  
2. Runs them (plan + open apps / click UI)  
3. Sends the spoken reply back  

It is the **link between the cloud and your laptop**. Without the bridge, the board can upload audio, but nothing on the Mac will open Outlook.

Code lives mainly in:

- `software/ai-pendant-simulator/local-agent/bridge.js`  
- `software/ai-pendant-simulator/local-agent/server.js` (local tools/LLM)

---

## 5. LaunchAgent

**What it is:** macOS’s way of **auto-starting** the Mac agent when you log in (and restarting it if it crashes). Name used earlier: `com.aipendant.agent`.

Think: “always keep the AI Pendant Mac agent running in the background.”

Useful commands (user domain):

```bash
# status
launchctl print gui/$(id -u)/com.aipendant.agent 2>/dev/null | head

# stop / start (paths may match how it was installed)
launchctl bootout gui/$(id -u)/com.aipendant.agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aipendant.agent.plist
```

After you pull new `local-agent` code, **restart the LaunchAgent** (or kill and relaunch the agent) so it loads the new bridge/TTS cache behavior.

---

## Cheat sheet: when do I need which step?

| You changed… | You must… |
|--------------|-----------|
| `firmware/nrf9160/**` | **Build + flash** the board |
| `cloud-relay/**` | **Deploy** the Cloudflare worker |
| `local-agent/**` | **Restart** the Mac agent / LaunchAgent |
| Dashboard only | Deploy dashboard worker (separate) |

Latency work for “open Outlook under 3 seconds” needs **all three**: new firmware on the board, new relay in the cloud, new agent on the Mac.
