# cloud/shared

Plain ES modules with no npm dependencies that the browser extension (`browser/chrome`), the
phone app's build (`mobile`) and the dashboard (`dashboard`) import directly. (The old relay
they were written for, the AI Pendant's `cloud/server` and `cloud/worker` with the Mac's
`desktop/local-agent`, was deleted on 2026-11-17; it hadn't been deployed since the rename.)

- `bridgeSocketProtocol.js`, `nodeMesh.js`, `approvalMesh.js`, `authorizedAccess.js`: how the
  extension's nodes register and approvals that cross devices.
- `domains/`: what each kind of node can do.
- `hiveCloud.mjs`: fills in the owner's Hive Cloud address in the extension and phone builds.
- `mesh-pairing.mjs`, `pc-mesh-client.mjs`, `pc-mesh-store.mjs`: the dashboard's Settings page
  pairing a phone or browser and sending requests to a PC.

Tests: `node --test cloud/shared` (the `privacy` test checks the whole repository).
