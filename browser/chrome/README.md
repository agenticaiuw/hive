# AI Pendant Browser Bridge

The Browser Bridge lets the authenticated local Mac agent use a browser profile
that is already signed into websites. Chrome and Safari share the same Manifest
V3 source in [`src/`](./src).

## Two peers

The extension has two independent ways in, and the Mac is no longer required
for either.

| Peer | Transport | Credential | Reaches it when |
| --- | --- | --- | --- |
| Mac agent | `http://127.0.0.1:8000`, long-poll | `agentToken` | the Mac is awake |
| Relay | `wss://…workers.dev` doorbell, HTTPS inbox | `deviceToken` (`browser_node`) | always |

Both are *listened* to whenever both are configured — mesh mail is durable and
silent, so an extension that only drained its inbox while the Mac was down
would leave relay mail unread. The Mac is preferred for *outbound* work because
loopback is faster. The whole policy is one pure function, `choosePeer()` in
[`src/relay-peer.js`](./src/relay-peer.js), so it can be asserted rather than
discovered by unplugging things.

**The relay pushes over a socket, with a poller underneath it.** The credential
rides as a subprotocol offer, because the `WebSocket` constructor available to a
service worker cannot set an `Authorization` header:

```js
new WebSocket(url, ['pendant.mesh.v1', 'bearer.' + deviceToken])
```

Two offers, not one: RFC 6455 makes the server echo a protocol the client
offered, and echoing the `bearer.` entry would put the token in a response
header. Measured against production — the server selects `pendant.mesh.v1`, the
token is never reflected, and a socket opened with no `Authorization` header at
all still gets a `403` if it names someone else's `deviceId`, so ownership is
still enforced. The token stays out of the query string, which is what gets
logged.

The poller remains as a safety sweep — every 5 min while the socket is up, 30 s
or 3 s when it is not — for three reasons that are about this runtime rather
than the relay: Safari suspends MV3 workers, so **every wake drains once**
regardless of the socket (mail that arrived while the worker was dead rang a
doorbell nobody heard); a frame is not durable while the D1 row is; and a
credential can stop working under a live socket.

One relay contract worth knowing: **`pending` counts the page it just leased
you.** A one-message drain reports `pending: 1` and only reads `0` after the
ack, so `while (pending > 0)` never terminates. Use `hasMoreMail()`, which
compares `pending` against the page length.

### Setting up both peers: one paste

Open **Settings → Pair this browser**, paste the repo's `PAIRING_CODE`, click
**Pair**. The agent's loopback `POST /pair/browser` route (guarded by socket
address + a timing-safe code match — `local-agent/pairBrowser.js`) returns the
agent bearer and commissions this browser's own `browser_node` relay
credential in the same call. The code is spent, never stored; the two wire
credentials stay per-host, the human just stops carrying them. Re-pairing
with the same device ID rotates the credential — but does **not** revoke the
old one; kill strays with `pendant-credentials.mjs revoke --token-id <id>`.

The manual path still works for unusual topologies (pairing a browser on a
different machine than the agent, narrowing scopes):

```bash
node scripts/pendant-credentials.mjs pair \
  --device-id <this-browser> --role browser_node --name "Safari on the MacBook"
```

Paste the printed token into **Settings → Relay peer** along with the same
`--device-id`, tick the box, and save. Either way, `@relay` is trusted by
default; any other node must be named under *Extra trusted senders* before it
may drive tabs — the relay lets any paired node address this one, so that
allowlist is the only thing standing between a second `browser_node`
credential and the owner's Safari.

## Security model

- `AGENT_TOKEN` is stored in `storage.local`. It is never placed in
  `storage.sync`, a manifest, a URL, or browser logs.
- The agent URL is restricted to `127.0.0.1` or `localhost` over HTTP. It was
  deliberately **not** widened to accept the relay: that field's value is the
  base URL `agentToken` is sent to, so one field covering both hosts would be
  one field that can aim either credential at either host, silently. The relay
  has its own field, its own origin allowlist and its own token.
- The relay URL is checked against a named origin allowlist
  (`RELAY_ORIGIN_ALLOWLIST`), not "any https URL", and `host_permissions` names
  the single relay origin rather than a wildcard.
- Mesh mail is deduped on `envelope.id` in `storage.local`, because the inbox
  lease is 60 s and Safari suspends the worker inside that window.
- Website access is an optional permission. It is granted from the extension
  settings with an explicit browser prompt and can be revoked there.
- `chrome://`, `safari-extension://`, `file://`, and other privileged pages
  cannot be controlled.
- Navigation accepts only HTTP(S) URLs. Password fields require the command to
  explicitly set `allowSensitiveInput: true`.
- Each command result goes back to the same authenticated loopback agent.

The extension is a **sensor/actuator** for the Mac agent.
After website access is granted it can:

- **snapshot** interactive elements with stable refs (prefer over desktop screenshots)
- **list_tabs**, **navigate**, **activate_tab** (find-or-open by URL), **click** / **type** by ref or CSS selector
- **wait_for**, **scroll**, **select**, **press_key**, **read_page**, **capture** (tab PNG)

Install it only in a browser profile you want AI Pendant to control.

## The brain: this node thinks for itself

A command typed into the popup is reasoned about **here**, not on the Mac.
`src/brain.js` is the pure half — the tool catalogue, the prompt, the reply
parser, the transcript and its bounds — and `runBrainLocally()` in
`background.js` is the loop: ask, act, feed the result back, repeat.

The thinking happens over `POST /v1/infer` on the relay
(`cloud-relay/nodeInference.js`), never against a key this extension holds. The
`browser_node` role already grants `llm:infer` (`cloud-relay/deviceAuth.js`), so
**no new scope and no re-pair** — it is a capability the credential has been
carrying unused. Configure the relay peer and the brain is on; without it every
command still needs the Mac awake.

| | |
| --- | --- |
| Tools offered | derived from `COMMAND_TYPES`, so the model can only ask for verbs `validateCommand` accepts (`toolCatalogueDrift()` is asserted empty) |
| Step budget | `BRAIN_MAX_STEPS` tool calls per command |
| Prompt budget | under every relay ceiling, never equal to it — `normalizeInferMessages` *rejects* an over-budget prompt rather than trimming it |
| Output budget | asked for explicitly: the relay defaults to 512, and 512 + `json_object` is the documented way to get JSON that stops mid-brace |
| Backing off | parks on the **presence** of `retryAfter`, which the relay documents as device-scoped — so a reason it adds later is honoured with no change here |

The Mac is the fallback, reached when there is no relay credential, when the
relay has told this device to back off, or when the model itself answers
`handoff` because the task needs files, a shell or another machine. A handoff is
only clean while nothing has run: once the loop has touched a page it finishes
and reports, rather than letting the Mac replay the same steps.

## Affinity: browser work runs in the browser

The Mac fallback path keeps the rule that made it safe. "Open ibkr" once opened
interactivebrokers.com in the *Mac's* browser session instead of the owner's, so
every step of a Mac-planned auto-approved plan is capability-tagged
(`src/affinity.js`): a plan that is entirely browser work (the `browser_*`
family, plus `open_url`, which becomes `activate_tab` here) executes **in this
extension**, through the same validated executor and privacy boundary as
agent-issued commands. One non-browser step (shell, files, other devices) and
the whole plan forwards to the hive as before.

Three rules ride along, all unit-tested, and they bind the brain loop and the
Mac-planned path alike:

- **Outward steps never auto-run.** A click or keystroke that reads as a
  commit point — submit, place order, cancel a subscription/investment, send —
  stops the run and waits for the owner. In the brain loop the gate is
  `createOutwardGuard()`, which watches every snapshot go past so it knows what
  the *page* calls each ref and can judge `{click, ref:"e4"}` on the words the
  owner would have read. The decision is made **in the popup** (Approve / Deny
  on the parked card, `plan:decide` to the background); the dashboard is the
  fallback, not the destination.
- **Completion is honest.** The verdict comes from the ledger of executed
  steps, never from model prose: a run that only opened and read pages says
  "changed nothing", and a command that asked for a cancellation that never
  ran is reported NOT done. The model's own answer survives as colour inside
  the headline, never as the claim.
- **Local is not invisible.** Each locally claimed run is recorded to the hive
  as node-mesh mail to `@relay` (`browser.task.record`, marked
  claimed/executed by this node from creation). Only an admin principal can
  drain `@relay`, so the record can never be claimed as Mac work. Nothing
  renders these into hive history yet — a named gap, not an accident.

## Chrome setup

1. Run `node browser-extension/package.mjs`.
2. Start the installed local agent and confirm `http://127.0.0.1:8000/health`
   responds.
3. Open `chrome://extensions`, enable **Developer mode**, and choose
   **Load unpacked**.
4. Select `browser-extension/build/chrome`.
5. Open the extension. In **Settings**, enter:
   - Agent URL: `http://127.0.0.1:8000`
   - Agent token: the same `AGENT_TOKEN` used by the installed Mac agent
6. Choose **Grant access** and approve website access.
7. Use **Test connection**. The toolbar badge changes to `ON` when connected.

The target for each command may be selected with `tabId`, `windowId`, or
`urlContains`. Otherwise the extension uses the active tab in the most recently
focused browser window. Navigation commands can also request `newTab: true`.

## Chrome package

Run:

```bash
node browser-extension/package.mjs
```

This creates an unpacked directory and ZIP under the ignored
`browser-extension/build/` directory. Vite dashboard builds cannot erase it.

## Safari setup

The committed Xcode wrapper is in `safari-browser-extension/`. It is generated
from a compatibility build of the same `browser-extension/src` source. To
refresh the wrapper after changing shared extension files:

```bash
node browser-extension/package.mjs
xcrun safari-web-extension-converter browser-extension/build/safari \
  --project-location safari-browser-extension \
  --app-name "AI Pendant Browser Bridge" \
  --bundle-identifier com.evanliu.aipendant.browserbridge \
  --swift \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force
```

Open the Xcode project, select your Apple development team, and run the macOS
app. Then enable **AI Pendant Browser Bridge** in Safari → Settings →
Extensions, choose **Always Allow on Every Website**, and configure the same
loopback URL and token from the extension settings.

Safari requires a signed containing app for distribution. Archive that app in
Xcode for Developer ID/App Store distribution. Signing credentials are not
stored in this repository.

## Service-worker behavior

Manifest V3 browsers suspend background workers. The bridge therefore uses a
browser alarm plus short bounded polling windows. It reconnects after browser
startup, extension updates, configuration changes, and manual reconnects.
Commands whose worker disappears mid-flight are reclaimed by the local agent
after their lease expires.
