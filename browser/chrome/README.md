# Hive browser extension

Hive's browser extension (Chrome and Safari list it as "Hive"). Chrome and Safari share the same
Manifest V3 source in [`src/`](./src).

## What it does

- **Hive's agents reach this browser through the cloud.** The background
  ([`background.js`](./src/background.js), [`cloud-peer.js`](./src/cloud-peer.js)) asks Hive's
  cloud board for the next command for this browser and runs it with
  [`executor.js`](./src/executor.js): open or focus a tab, click, type, read a page, capture it.
  Results go through the privacy boundary in [`bridge-core.js`](./src/bridge-core.js) before they
  leave the browser. The key to the board comes from Hive on this Mac (Safari: the native
  handler's `hive:key`; Chrome: the `hive.board_key` native host), so nobody pastes anything. The
  toolbar badge says `ON` while the board answers.
- **The ask box.** The popup's ask box ([`ask-hive.js`](./src/ask-hive.js)) is the same one the
  dashboard, the phone app and Hive's floating window on the Mac have. What the owner asks goes to
  Hive in the cloud with the page they're on; "show just my courses on this page" becomes a page
  rule ([`page-rules.js`](./src/page-rules.js)) that every visit applies.
- **Hive's dashboard beside the page.** The popup's **Dashboard** button opens Hive's one
  dashboard, the same page as the website: in Chrome's side panel (`sidepanel.html`,
  [`dashboard-panel.js`](./src/dashboard-panel.js)), in a tab in Safari.

## Building

`node package.mjs` (or `npm run package`) bundles the source into `build/chrome` (Chrome loads it
unpacked from there; press the extension's reload button on `chrome://extensions` after a build)
and `build/safari`.

Hive.app carries the Safari extension inside it (`Contents/PlugIns/Hive.appex`).
`desktop/app/Makefile` builds it (`make build/Hive.appex`) with
[`browser/safari/scripts/build-appex.sh`](../safari/scripts/build-appex.sh). Bump `version` in
`src/manifest.json` with every change: Safari caches the extension's files by version.

## Service-worker behavior

Manifest V3 browsers suspend background workers. An alarm wakes the background every half
minute, and each ask to the cloud board is held open for up to 20 seconds, so a command reaches
the browser the moment it is sent. The board hands each command to one browser once, and a
command nobody took within 90 seconds expires instead of running late.
