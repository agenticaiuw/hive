# Who wrote what, 2026-08-08 → 09

Git cannot answer this. Every commit in this repository shares one author
(`Evan Liu <evan20050827@gmail.com>`), and the `Co-Authored-By` trailers name
*models* — "Claude Opus 5", "Claude Fable 5" — not the agents that did the work.
Agent identity has only ever lived in commit-message prose, and at least one
`git commit` without a pathspec swept another agent's uncommitted files into an
unrelated commit, taking that prose with it.

`git log --all -- browser-extension/src/relay-peer.js` returns exactly one
commit, under the wrong author's message. That file has no other history.

**This document exists because the mapping was recoverable from exactly one
place — the coordinating session's working memory — and that expires.** Two
agents independently established that it is not in git, not in the transcript
store, and not mechanically derivable: no test can distinguish "history erased
by a sweep" from "legitimately written in one broad commit", because the
distinguishing information was never recorded anywhere queryable.

Confidence is marked per row. **Spawned** means the coordinator created that
agent with that brief and holds the assignment directly. **Reported** means the
agent said so in its own completion report. **Inferred** means neither — treat
it as a lead, not a fact.

## Relay and credentials

| Files | Agent / task | Confidence |
|---|---|---|
| `cloud-relay/deviceAuth.js` (scoped credentials), `cloud-relay/relayScopes.js`, `relayScopes.test.js`, `devicePairing.test.js`, `scripts/pendant-credentials.mjs`, `local-agent/relayCredential.js` | scoped-tokens · task #16 | Spawned |
| `cloud-relay/nodeMailbox.js`, `shared/nodeMesh.js`, `cloudflare-worker/node-mesh-migration.sql`, mesh routes + socket in `cloud-relay/server.js`, `cloudflare-worker/bridgeHub.js` mesh work, `cloud-relay/nodeInference.js` (`POST /v1/infer`), `DELETE /v1/devices/:id`, subprotocol handshake (`9408983`), diagnostic 403 codes (`6351fbd`) | mesh-sockets · task #26 | Spawned |
| `cloud-relay/deviceAuth.js` `effectiveScopesForCredential` / intersection-at-auth-time | scope-model · task #31 | Spawned |
| `cloud-relay/bridgeDoorbell.js`, `cloudflare-worker/bridgeHub.js` (original doorbell) | push-transport · task #15 | Inferred |
| `cloud-relay/pendantSpeechStore.js` | pendant-speech · task #23 | Inferred |

## iOS

| Files | Agent / task | Confidence |
|---|---|---|
| `src/brain/mobileTools.js`, `mobileDiscovery.js`, `mobileBrain.js`, `relayInference.js`, `phoneBrain.js`, dashboard credential revocation, `403` code handling | ios-brain · task #18 | Spawned |
| `src/brain/meshMailbox.js`, the `mesh` shelf (`mesh_send` / `mesh_inbox` / `mesh_ack` / `mesh_presence`), `openNodeSocket`, `App.jsx` doorbell wiring | phone-mesh · task #32 | Spawned |
| `local-agent/iosControl.js` (creation), `iosControl.test.js` | ios-control · earlier session | Reported |
| `local-agent/iosControl.js` background-control diagnosis (`77b1b75`, `bbb63f8`) | background-control | Spawned |
| `local-agent/iosControl.js` activate-without-fronting proof | background-tap · task #28 | Spawned |

## Browser extension

| Files | Agent / task | Confidence |
|---|---|---|
| **`browser-extension/src/relay-peer.js`, `test/relay-peer.test.js`** — the file whose history was destroyed. Origin allowlist, inbox poller, `choosePeer()`, dedupe ledger, options UI | **extension-relay · task #30** | **Spawned** |
| `browser-extension/src/popup.html` + `popup.js` command box, `brain.js`, `command-console.js`, Safari `Resources/` sync convention, `bundledOnlyModules` | extension-brain · task #17 | Spawned |
| `local-agent/originFanOut.js` + tests, `POST /origins/read`, `GET /origins/budget` | multi-origin | Spawned |

## Pendant firmware

| Files | Agent / task | Confidence |
|---|---|---|
| `firmware/nrf9160/src/pendant_local.c` / `.h`, `convo_uplink_gate` in `main.c`, `REFLEX_TRIG_VOICE`, `tests/host/run_pendant_local_test.sh` (`faafbf2`) | wake-word · task #21 | Spawned |
| `firmware/nrf9160/src/pendant_reflex.c` / `.h`, `haptic.c` (`61dd677`) | pendant-reflex · task #20 | Inferred |
| `firmware/nrf9160/Kconfig` `PENDANT_RELAY_DEVICE_TOKEN`, `PENDANT_RELAY_BEARER` in `pendant_cloud.c` | scoped-tokens · task #16 | Reported |

## Mac agent

| Files | Agent / task | Confidence |
|---|---|---|
| `local-agent/capabilityGapInbox.js`, `scriptEffects.js`, `toolDiscovery.js`, `spokenBudget.js` | various, earlier session | Inferred |
| `hive-dashboard/server.mjs` + `index.html` (original) | hive-dashboard · task #14 | Inferred |
| `local-agent/policyRouter.js` `stripContextTrailer`, `bridge.js` model-verdict path, `local-agent/server.js` error handler, `iosControl.js` `ios_app_switcher` wiring, `SHOPPING-LIST.md`, this file | coordinator (main session) | Spawned |

## Docs

| Files | Agent / task | Confidence |
|---|---|---|
| `wearable/docs/hardware/respin-speaker-mute-secure-element.md` | board-respin · task #25 | Spawned |
| Its §1.1 BOM rows filled from live distributor pages | coordinator, from a parts-sourcing subagent's findings | Spawned |

## Known mis-attributions

Recorded so nobody "corrects" them into something worse. In every case the
content is intact and tested; only the authorship line is wrong.

- **`6351fbd`** (mesh-sockets) swept 16 files, including all of
  `extension-relay`'s `relay-peer.js` work. This is the destructive one — it is
  the *only* commit touching that file.
- **`376812b`** (coordinator) committed mesh-sockets' in-flight
  `nodeInference.js` work under a coordinator message. Deliberate, with a
  correct pathspec — which is the point worth keeping: **a pathspec stops you
  taking work by accident and does nothing about taking it on purpose.**
- **`be5a555`, `5ddce9b`** (multi-origin) swept other agents' derivation
  artifacts under multi-origin messages. Regenerable, so cheap.

## The rule that prevents the next one

`git add <path>` is **not** sufficient. `git commit` with no pathspec commits
the whole index, which is shared state when several agents are working at once —
an agent that stages only its own files can still commit eleven of someone
else's. Use:

    git commit -- <paths>

For agents that mutate overlapping files, prefer worktree isolation so there is
no shared index to sweep at all.
