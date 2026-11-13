# Hive repository layout

Hive is the product name; Hivemind remains the repository and platform name.
The repository groups its components into five product areas:

- `browser/`: Chrome and Safari extensions.
- `cloud/`: relay and edge worker.
- `desktop/`: the desktop app, agent, dashboard, orchestrator and integration tooling.
- `mobile/`: simulator and iOS application.
- `wearable/`: physical designs, firmware and build guides.

Hive's icon is `branding/hive.svg` at the root, its only copy (the Mac app's `.icns`, the Chrome extension's icons and the dashboard all come from it); architecture documentation is in `cloud/docs/`. Device-specific tests and tools are placed with their components. Run `node cloud/tools/check-platform.mjs` to check component paths.

The desktop app was imported as a reviewed snapshot; this layout does not establish live sync, full integration, permission continuity or publication readiness. The mobile agent is still a placeholder; the VM worker (`cloud/vm-agent`) is tested locally but not yet verified against live Discord or X. Imported code and third-party licenses, supported builds, user-state continuity and separate repository history still need verification before publication or retirement of the separate repository.

The optional macOS packaging and migration scripts in `desktop/integration/scripts/` require a selected signing identity and retain backups. Local fixture tests do not establish live permission or login-item continuity. Model and Python environment preparation are separate, opt-in operations; dependency imports do not prove inference or audio hardware behavior.
