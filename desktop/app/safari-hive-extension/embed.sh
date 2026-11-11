#!/bin/bash
# Embed the Hivemind browser bridge into an existing Hive build before signing it.
set -euo pipefail
cd "$(dirname "$0")/.."
app=${1:?pass the app bundle being built}
ext="$app/Contents/PlugIns/HiveBrowser.appex"
source_dir="../../browser/safari/AI Pendant Browser Bridge/Shared (Extension)"
if [ ! -f "$source_dir/SafariWebExtensionHandler.swift" ]; then
  echo "Missing shared Safari extension source: $source_dir" >&2
  exit 1
fi
mkdir -p "$ext/Contents/MacOS" "$ext/Contents/Resources"
cp safari-hive-extension/Info.plist "$ext/Contents/Info.plist"
ditto "$source_dir/Resources" "$ext/Contents/Resources"
# Keep the shared extension source unmodified and adapt only Hive's display name.
python3 - "$ext/Contents/Resources" <<'PY'
import json, pathlib, sys
resources = pathlib.Path(sys.argv[1])
manifest_path = resources / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
manifest['name'] = 'Hive Browser'
manifest['description'] = 'Lets your local Hive agent control explicitly permitted browser tabs on this Mac.'
manifest['action']['default_title'] = 'Hive Browser'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
popup = resources / 'popup.html'
popup.write_text(popup.read_text().replace('<title>AI Pendant Browser Bridge</title>', '<title>Hive Browser</title>'))
PY
swiftc -parse-as-library -emit-library -module-name HiveBrowser "$source_dir/SafariWebExtensionHandler.swift" -o "$ext/Contents/MacOS/HiveBrowser"
tools/sign.sh "$ext" local.personal-agent.Agent.BrowserExtension safari-hive-extension/entitlements.plist
codesign --verify --strict "$ext"
