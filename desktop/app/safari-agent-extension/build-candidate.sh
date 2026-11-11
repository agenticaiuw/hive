#!/bin/bash
# Build only in a new temp directory; never alter, install, or launch the input app.
set -euo pipefail
cd "$(dirname "$0")/.."
base=${1:?pass path to an existing signed Agent.app}
identity=${SIGN:?set SIGN explicitly; '-' is for isolated structural tests only}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-safari-candidate.XXXXXXXX")
app="$tmp/Agent.app"
ditto "$base" "$app"
ext="$app/Contents/PlugIns/AgentSafariStatus.appex"
mkdir -p "$ext/Contents/MacOS" "$ext/Contents/Resources" "$tmp/module-cache"
cp safari-agent-extension/Info.plist "$ext/Contents/Info.plist"
cp safari-agent-extension/resources/{manifest.json,window-discovery.js,background.js} "$ext/Contents/Resources/"
swiftc -module-cache-path "$tmp/module-cache" -parse-as-library -emit-library -module-name AgentSafariStatus safari-agent-extension/{MessagePolicy,SafariWebExtensionHandler}.swift -o "$ext/Contents/MacOS/AgentSafariStatus"
codesign --force --sign "$identity" --identifier local.personal-agent.Agent.SafariStatus --entitlements safari-agent-extension/entitlements.plist "$ext"
if [ "$identity" = "-" ]; then
  codesign --force --sign - --preserve-metadata=entitlements,flags --identifier local.personal-agent.Agent "$app"
else
  codesign --force --sign "$identity" --preserve-metadata=entitlements,requirements,flags --identifier local.personal-agent.Agent "$app"
fi
if [ "$identity" != "-" ]; then
  requirement() { codesign -d -r- "$1" 2>&1 | sed -n "s/^designated => //p"; }
  [ "$(requirement "$base")" = "$(requirement "$app")" ] || { echo "Signing identity requirement mismatch; candidate rejected." >&2; exit 1; }
fi
codesign --verify --strict --verbose=1 "$ext"
codesign --verify --deep --strict --verbose=1 "$app"
echo "Candidate: $app"
if [ "$identity" = '-' ]; then echo 'Ad-hoc test signature: NOT the installed Agent identity; do not install.'; fi
