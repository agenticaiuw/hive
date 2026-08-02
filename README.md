# Agentic Gadget

Unified monorepo for the Agentic Gadget hardware, firmware, local agent, cloud
relay, and Bluetooth audio bridge.

## Layout

- `firmware/nrf9160` — nRF9160 DK firmware (Zephyr/NCS)
- `firmware/esp32-airpods-bridge` — HUZZAH32 Bluetooth A2DP audio bridge
- `software/ai-pendant-simulator` — local Mac agent, cloud relay, and simulator
- `software/airpods-control` — local Bluetooth control surface
- `hardware` — datasheets, electrical design, and KiCad sources
- `docs` — build guides, BOM, plan, and architecture images
- `diagnostics` — captured audio used for debugging
- `experiments` — standalone experiments

## Local agent

Keep private credentials in `software/ai-pendant-simulator/.env`. That file is
ignored by Git.

```sh
cd software/ai-pendant-simulator
npm install
npm test
npm run agent
```

## nRF9160 firmware

Build from `firmware/nrf9160` using the installed Nordic toolchain. Build
directories are intentionally not stored in this repository. Private Kconfig
values belong in the ignored `firmware/nrf9160/secrets.conf` file and must be
included with `-DEXTRA_CONF_FILE=secrets.conf` when creating a fresh build.

## Original working trees

The previous folders under `/Users/you/Claude/Projects` are retained as
backups until this consolidated tree is fully verified.
