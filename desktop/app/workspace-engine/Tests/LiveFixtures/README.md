# Live capture-isolation fixture

These executables create windows and capture a SpaceO display. They are intentionally outside
`SpaceOKitTests` and never run in `make test` or `make verify-release`. Follow
[the live-test guide](../../docs/LIVE_TESTS.md) and use a terminal with the required grants.
Do not run this alongside another live audit. The owner authorized this login for the current audit.

The fixture starts with an ordinary window, then refuses widths below 1800 points after a private
file trigger. The runner creates two 1280-point tiles on one display and launches the fixture into
the first using the public CLI. An unfiltered capture must show more than 1000 magenta marker
pixels in the neighboring tile before the protected CLI screenshot is assessed. Protected capture
must contain zero marker pixels; the oversized source must also report a session health failure.
An explicit capture refusal is retained for review and is not automatically called a pass.

Build in a new private directory from the repository root:

```sh
export SPACEO_FIXTURE_DIR="$(mktemp -d /tmp/spaceo-pixel-XXXXXXXX)"
python3 - <<'PYTHON'
import os, pathlib, plistlib
root = pathlib.Path(os.environ['SPACEO_FIXTURE_DIR'])
contents = root / 'Marker.app' / 'Contents'
(contents / 'MacOS').mkdir(parents=True)
(contents / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': 'dev.spaceo.audit.oversized-marker',
    'CFBundleExecutable': 'Marker',
    'CFBundleName': 'SpaceO Marker Fixture',
    'CFBundlePackageType': 'APPL',
    'CFBundleVersion': '1',
    'CFBundleShortVersionString': '1.0',
    'LSMinimumSystemVersion': '14.0',
    'NSPrincipalClass': 'NSApplication',
    'NSHighResolutionCapable': True,
}))
PYTHON
swiftc -target arm64-apple-macos14.0 Tests/LiveFixtures/OversizedWindow.swift \
  -o "$SPACEO_FIXTURE_DIR/Marker.app/Contents/MacOS/Marker"
codesign --force --sign - "$SPACEO_FIXTURE_DIR/Marker.app"
swiftc -target arm64-apple-macos14.0 -parse-as-library \
  Tests/LiveFixtures/CaptureMarker.swift -o "$SPACEO_FIXTURE_DIR/capture-marker"
python3 Tests/LiveFixtures/RunCaptureIsolation.py "$SPACEO_FIXTURE_DIR" \
  "$PWD/.build/signed/spaceo"
```

The deployment target is explicit because the compiler's default may target an OS newer than the
host. The fixture uses a local ad-hoc signature; the SpaceO binary under test uses the stable
Developer ID build from `make signed`. This is a development regression, not DMG qualification.

`report.json` includes both pixel counts, source identity, tile geometry, health findings, and
pre/post display inventory. Exit zero requires all assertions and teardown checks. The runner
uses its own socket and refuses a baseline with pre-existing SpaceO displays. It never captures
a physical display and it stops only its own daemon. Keep `positive.png`, `protected.png`, and
raw logs private: the display background or other overlays may contain user information. Retain
only reviewed structured evidence and image digests in the repository. Leases remain in memory.

Recorded passing result: [2026-09-05 capture isolation](../../docs/validation/2026-09-05-capture-isolation.json).
