# desktop agent

`app` contains a local personal-agent source snapshot with a SHA-256 import
manifest. It is a point-in-time copy, not a live link to the original. Import a
fresh reviewed snapshot into an empty destination with
`node desktop/integration/scripts/import-pc-agent.mjs --source /path/to/personal-agent --destination /path/to/new-copy --apply`.
Omit `--apply` to inspect the import first. The importer refuses to overwrite an
existing snapshot and excludes local credentials, build output, models and caches.

The imported implementation includes Python, Swift, C++ and Rust. A Rust
migration must preserve behavior and pass equivalent tests before replacing it.

`local-request.mjs` provides an explicit local integration boundary for a
running Agent's `control/request.sock`. It returns acceptance or rejection;
acceptance does not mean the task finished. It makes no automatic retries
because a timeout can leave acceptance unknown. The opt-in mesh bridge below uses it; the mobile app UI is not yet wired.

The importer excludes common local credential files, but it cannot detect every
secret embedded inside source files. Review the snapshot before publishing it.

### Opt-in cloud request bridge

`mesh-bridge.mjs` implements one polling cycle over the existing authenticated
node mailbox. Construct `PcMeshBridge` with an HTTPS relay URL, bearer token,
desktop node ID, explicit `allowedSenders`, local request socket, and a private
persistent journal path; call `pollOnce()` from a supervised process. It is
not started by default. A sender posts an authenticated node-mesh envelope of
kind `pc.request.submit` with payload `{ "text": "..." }` addressed to the desktop
node. The bridge replies with `pc.request.result`, sets `correlationId` to the
request envelope ID, and uses status `accepted`, `rejected`, or `unknown`.
`accepted` is only local admission, not task completion. Callers must not claim
that the task completed from this response. Rejections include a reason code;
unknown means the sender must not assume whether execution occurred.

The relay stamps the authenticated sender; the bridge only executes requests
from its configured allowlist, acknowledges after result delivery, and journals
before dispatch to avoid retrying a possibly accepted request. Result envelopes
can be delivered more than once; deduplicate by correlation ID. Run only one
bridge instance for a journal: there is no cross-process lease. Atomic file
replacement does not promise survival through sudden power loss, and the bridge
does not yet report task completion or provide scheduling, mobile UI, or a live deployment. Keep the token out of source and logs.

### Supervised startup

The optional `run-mesh-bridge.mjs` process polls until SIGINT or SIGTERM. It is
not installed or started automatically. Create a private JSON configuration with
`relayUrl`, `deviceId`, `allowedSenders`, `socketPath`, `journalPath`, and
optionally `intervalMs` (1,000–300,000 ms). The journal's parent directory must
already exist. Supply the node's token in `HIVEMIND_MESH_TOKEN` through your
supervisor, then run `node desktop/run-mesh-bridge.mjs /path/to/config.json`.
Pair and authorize devices through the existing relay provisioning flow first;
this runner does not create credentials or pair devices.

The runner holds an exclusive journal lock, preventing two runner instances
from dispatching the same request. After an unclean exit, remove the `.lock`
file only after confirming the previous process has stopped. Poll failures are
retried without logging request contents or credentials. A forced termination
can leave dispatch status unknown; the journal prevents a later retry from
replaying that request.

The supervised runner also records allowed requests in the shared instruction
ledger before dispatch. Set `ledgerPath` in its configuration to override the
default. A persisted stop prevents new dispatches; interrupted attempts are
reported unknown and are not replayed. See [the ledger documentation](../cloud/orchestrator/README.md)
for scope and recovery details.
