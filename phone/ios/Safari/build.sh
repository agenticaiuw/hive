#!/bin/sh
# The same independent browser node, bundled with the iPhone app.
set -eu
cd "$(dirname "$0")/../../.."
out=target/HivePhone/HiveSafari.appex
[ -f browser/tailnet/tailnet.wasm ] || sh tailnet/wasm.sh
mkdir -p "$out"
cp phone/ios/Safari/Info.plist "$out/Info.plist"
cp browser/*.js browser/*.html "$out/"
cp -R browser/icons browser/tailnet "$out/"
python3 - "$out" <<'MANIFEST'
import json, sys
from pathlib import Path
manifest = json.loads(Path('browser/manifest.json').read_text())
manifest.pop('minimum_chrome_version', None)
manifest['permissions'] = [p for p in manifest['permissions'] if p not in ('offscreen', 'userScripts')]
manifest['background'] = {'scripts': ['worker.js'], 'type': 'module', 'persistent': False}
Path(sys.argv[1], 'manifest.json').write_text(json.dumps(manifest, indent=2))
MANIFEST
sdk=iphoneos
target=arm64-apple-ios18.0
if [ "${1:-}" = test ]; then sdk=iphonesimulator; target=arm64-apple-ios18.0-simulator; fi
xcrun --sdk "$sdk" swiftc -target "$target" \
  -sdk "$(xcrun --sdk "$sdk" --show-sdk-path)" -parse-as-library \
  -emit-executable -module-name HiveSafari -application-extension \
  -Xlinker -e -Xlinker _NSExtensionMain \
  phone/ios/Safari/Main.swift -o "$out/HiveSafari"
codesign -f -s - --timestamp=none "$out"
