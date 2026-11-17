# Hive repository layout

- `browser/`: the browser extension, "Hive" (`browser/chrome` is the source for Chrome and Safari;
  `browser/safari` is the Safari wrapper that ships inside Hive.app).
- `cloud/`: everything Hive runs in the cloud. `tasks` is the owner's task board (a Worker), which
  every node reaches every other node through; `knowledge` holds its database's migrations;
  `hive-cloud` is the private file cloud; `vm-agent` is Hive's agent on the cloud VM; `dream`
  runs the nightly review; `shared` is code the browser extension and the cloud share.
- `dashboard/`: Hive's one dashboard. The website, the desktop app, the phone app and the
  extension's side panel all show it.
- `desktop/`: Hive.app on the Mac and the Mac's tools for reaching the VM.
- `mobile/`: the iOS app, a shell around the dashboard website.
- `branding/hive.svg`: Hive's icon, its only copy (the Mac app's `.icns`, the extension's icons and
  the dashboard all come from it).

Tests sit with their components. `node cloud/tools/check-platform.mjs` checks that the component
folders are where this page says.
