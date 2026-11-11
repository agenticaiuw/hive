# Hive

Hive is the product name for the Hivemind platform: the desktop agent, cloud relay,
mobile and browser surfaces, hardware, and firmware. Existing bundle identifiers,
state paths and service names remain unchanged for compatibility.

## Platform layout

- `browser/chrome` and `browser/safari` — browser extensions.
- `cloud/orchestrator`, `cloud/server` and `cloud/worker` — orchestration,
  relay and Cloudflare entry point;
  `cloud/vm-agent` is the VM worker that posts to Discord and X from the owner's VM (not yet verified against the live sites).
- `desktop` — integrated desktop agent source snapshot and its mesh bridge.
- `mobile/ios` — existing iOS app; an independent mobile agent is not implemented yet.
- `wearable/hardware` and `wearable/firmware` — hardware designs and device firmware.

These component directories contain the physical source code.
Run `node cloud/tools/check-platform.mjs` to verify the layout.
Cloud is intended to coordinate shared state across authorized nodes. The
encrypted record synchronization protocol is a prototype; it is not yet wired
to live nodes or deployed as a shared source of truth.

## Existing implementation paths

- `wearable/firmware/nrf9160` — nRF9160 DK firmware (Zephyr/NCS)
- `wearable/firmware/esp32-airpods-bridge` — HUZZAH32 Bluetooth A2DP audio bridge
- `desktop/local-agent` — local agent; `mobile/simulator` — simulator and shared package
- `desktop/dashboard` — Mission Control dashboard (Cloudflare Worker)
- `wearable/hardware` — datasheets, electrical design, and KiCad sources
- `wearable/docs` — wearable build guides and architecture notes

## Local agent

Keep private credentials in the repo-root `.env` (see `.env.example`). That file
is ignored by Git.

```sh
cd mobile/simulator
npm install
npm test
npm run agent
```

## nRF9160 firmware

Build from `wearable/firmware/nrf9160` using the installed Nordic toolchain (NCS under
`/opt/nordic/ncs`). Build directories are intentionally not stored in this
repository. Private Kconfig values belong in the ignored
`wearable/firmware/nrf9160/secrets.conf` file and must be included with
`-DEXTRA_CONF_FILE=secrets.conf` when creating a fresh build.

```sh
source wearable/firmware/nrf9160/scripts/env.sh          # puts west/nrfutil on PATH
wearable/firmware/nrf9160/scripts/flash.sh --check       # verify probe + tools
# build (see wearable/docs/How_This_System_Runs.md), then:
wearable/firmware/nrf9160/scripts/flash.sh               # nrfutil → J-Link 960036581
```

ESP32 bridge: `wearable/firmware/esp32-airpods-bridge/flash.sh` (PlatformIO in `.venv`).
