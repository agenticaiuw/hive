# Agentic Gadget

Unified monorepo for the Agentic Gadget hardware, firmware, local agent, cloud
relay, and Bluetooth audio bridge.

## Layout

- `firmware/nrf9160` — nRF9160 DK firmware (Zephyr/NCS)
- `firmware/esp32-airpods-bridge` — HUZZAH32 Bluetooth A2DP audio bridge
- `software/ai-pendant-simulator` — local Mac agent, cloud relay, and simulator
- `software/dashboard-sveltekit` — Mission Control dashboard (Cloudflare Worker)
- `hardware` — datasheets, electrical design, and KiCad sources
- `docs` — build guides and architecture notes

## Local agent

Keep private credentials in the repo-root `.env` (see `.env.example`). That file
is ignored by Git.

```sh
cd software/ai-pendant-simulator
npm install
npm test
npm run agent
```

## nRF9160 firmware

Build from `firmware/nrf9160` using the installed Nordic toolchain (NCS under
`/opt/nordic/ncs`). Build directories are intentionally not stored in this
repository. Private Kconfig values belong in the ignored
`firmware/nrf9160/secrets.conf` file and must be included with
`-DEXTRA_CONF_FILE=secrets.conf` when creating a fresh build.

```sh
source firmware/nrf9160/scripts/env.sh          # puts west/nrfutil on PATH
firmware/nrf9160/scripts/flash.sh --check       # verify probe + tools
# build (see docs/How_This_System_Runs.md), then:
firmware/nrf9160/scripts/flash.sh               # nrfutil → J-Link 960036581
```

ESP32 bridge: `firmware/esp32-airpods-bridge/flash.sh` (PlatformIO in `.venv`).
