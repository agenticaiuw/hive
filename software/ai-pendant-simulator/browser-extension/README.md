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

### Setting up the relay peer

```bash
node scripts/pendant-credentials.mjs pair \
  --device-id <this-browser> --role browser_node --name "Safari on Evan's Mac"
```

Paste the printed token into **Settings → Relay peer** along with the same
`--device-id`, tick the box, and save. `@relay` is trusted by default; any
other node must be named under *Extra trusted senders* before it may drive
tabs — the relay lets any paired node address this one, so that allowlist is
the only thing standing between a second `browser_node` credential and the
owner's Safari.

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

The extension is a **sensor/actuator** for the Mac agent (no LLM in the
extension). After website access is granted it can:

- **snapshot** interactive elements with stable refs (prefer over desktop screenshots)
- **list_tabs**, **navigate**, **click** / **type** by ref or CSS selector
- **wait_for**, **scroll**, **select**, **press_key**, **read_page**, **capture** (tab PNG)

Install it only in a browser profile you want AI Pendant to control.

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
