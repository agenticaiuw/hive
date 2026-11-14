# cloud/shared

The relay's protocol and record shapes, used by every node that talks to it: the relay itself
(`cloud/server`, `cloud/worker`), the Mac's local agent (`desktop/local-agent`), the browser
extension (`browser/chrome`) and the dashboard (`desktop/dashboard`). Plain ES modules with no
npm dependencies, so each of those can import them directly.

- `loadEnv.mjs`: reads the repo-root `.env` and derives `AGENT_TOKEN` / `SESSION_SECRET` from
  `PAIRING_CODE` (`deriveSecret`).
- `bridgeSocketProtocol.js`, `nodeMesh.js`, `capabilityRegistry.js`, `protocolText.js`: how
  nodes register, what they can do and the messages between them.
- `approvalHandoff.js`, `approvalMesh.js`, `authorizedAccess.js`: approvals that cross devices.
- `contextHandoff.js`, `domainCapture.js`, `domainMemory.js`, `domains/`, `productSync.js`,
  `audioDelivery.js`: shared context, memory and product state.
- `mesh-pairing.mjs`, `pc-mesh-client.mjs`, `pc-mesh-store.mjs`: a phone or browser pairing with
  the relay (`/v1/devices/pair`) and sending requests to a PC through it. Submit records an
  unknown state before sending and never retries an ambiguous send; poll accepts results only
  from the configured PC and saves them before acknowledging. The dashboard's `/pc` page uses
  them.

Tests: `npm test` in `cloud/server` runs these with the relay's.
