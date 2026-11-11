# Hive

Hive is the product name for the Hivemind platform: the desktop agent, cloud relay,
mobile and browser surfaces, hardware, and firmware. Existing bundle identifiers,
state paths and service names remain unchanged for compatibility.

## Design principles

- **The cloud always has all the data.** Everything an agent task produces goes to the cloud
  (Cloudflare): the screen recording of the task, the timeline of the agent's status and the
  computer's state at exact times, the artifacts the agent makes and the code it writes. Copies on
  a device are working copies; the cloud is the record.
- **The agent's brain runs in the cloud and drives your own computer.** The agent's Codex session
  is signed in on the cloud and operates the user's personal computer the way the user would,
  with its real mouse and keyboard on its real screen.
- **The agent builds the user's knowledge base while it works.** Every task that shows the agent a
  lasting fact about the user or their world (their phone number on their Contacts card, a club's
  meeting room, a friend's email, the outcome of a request) adds it to a knowledge base in the
  cloud, after checking it isn't stored already. The more it holds, the better: before searching
  the computer for a fact, the agent looks there first. Passwords, codes, keys and financial or
  government numbers are never stored; those stay in the password manager.

Where this stands today:

- Done: every desktop agent task is screen-recorded with a timestamped timeline and uploaded to
  the R2 bucket `hive-recordings` (`desktop/app/crates/hive/hive-knowledge/src/task_recording.rs`,
  `desktop/app/crates/hive/hive-knowledge/src/cloud_archive.rs`; see `desktop/app/README.md`, "Task recordings").
- Done: the knowledge base is the D1 database `hive-knowledge` (schema in `cloud/knowledge`), which
  the desktop agent reads and adds to on every task (`desktop/app/crates/hive/hive-knowledge/src/knowledge.rs`; see
  `desktop/app/README.md`, "Knowledge base").
- Not yet: uploading the agent's other artifacts and the code it produces, running the Codex
  session in the cloud (the desktop agent still starts Codex on the Mac), and giving the phone and
  VM agents the knowledge base (they need an HTTP route to it in `cloud/worker`).

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
