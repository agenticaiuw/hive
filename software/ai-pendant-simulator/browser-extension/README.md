# AI Pendant Browser Bridge

The Browser Bridge lets the authenticated local Mac agent use a browser profile
that is already signed into websites. Chrome and Safari share the same Manifest
V3 source in [`src/`](./src).

## Security model

- `AGENT_TOKEN` is stored in `storage.local`. It is never placed in
  `storage.sync`, a manifest, a URL, or browser logs.
- The agent URL is restricted to `127.0.0.1` or `localhost` over HTTP.
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
