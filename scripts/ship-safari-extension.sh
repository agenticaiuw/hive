#!/bin/bash
#
# ship-safari-extension.sh — the ONE way to ship the AI Pendant Safari extension.
#
# WHY THIS SCRIPT EXISTS. The owner, 2026-08-12: "we likely gonna keep updating
# the extension, make sure this issue doesn't happen again." Twice (2026-08-10
# and again 2026-08-12) an update wiped the owner's stored pairing, because the
# ship deleted or re-registered the installed app bundle and Safari treated the
# reinstall as a brand-new extension — new storage identity, credentials gone.
# This script encodes the recipe that is proven NOT to do that. Deviate from it
# and you will re-learn those two days the hard way.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIMULATOR="$ROOT/software/ai-pendant-simulator"
SRC_MANIFEST="$SIMULATOR/browser-extension/src/manifest.json"
XCODE_DIR="$SIMULATOR/safari-browser-extension/AI Pendant Browser Bridge"
RESOURCES_DIR="$XCODE_DIR/Shared (Extension)/Resources"
DERIVED="$XCODE_DIR/build"
BUILT_APP="$DERIVED/Build/Products/Release/AI Pendant Browser Bridge.app"
INSTALLED_APP="$HOME/Applications/AI Pendant Browser Bridge.app"
INSTALLED_APPEX="$INSTALLED_APP/Contents/PlugIns/AI Pendant Browser Bridge Extension.appex"
INSTALLED_MANIFEST="$INSTALLED_APPEX/Contents/Resources/manifest.json"
EXT_ID="com.evanliu.aipendant.browserbridge"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

manifest_version() {
  /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1"
}

echo "==> Step 1/8: version guard (Safari caches extension resources BY VERSION)"
SRC_VERSION="$(manifest_version "$SRC_MANIFEST")"
if [[ ! -d "$INSTALLED_APP" ]]; then
  echo "ERROR: no installed app at $INSTALLED_APP." >&2
  echo "This script only UPDATES an existing install (updating in place is the" >&2
  echo "whole point — it preserves Safari's storage identity). For a first" >&2
  echo "install, build and copy the app once by hand, then use this script." >&2
  exit 1
fi
INSTALLED_VERSION="$(manifest_version "$INSTALLED_MANIFEST")"
echo "    src/manifest.json: $SRC_VERSION   installed: $INSTALLED_VERSION"
if [[ "$SRC_VERSION" == "$INSTALLED_VERSION" ]]; then
  echo "ERROR: src version ($SRC_VERSION) equals the INSTALLED version." >&2
  echo "Safari caches the extension by version — shipping the same version is a" >&2
  echo "silent no-op: Safari keeps serving the old cached resources and you will" >&2
  echo "spend an evening debugging code that never loaded. Bump \"version\" in" >&2
  echo "$SRC_MANIFEST first." >&2
  exit 1
fi

echo "==> Step 2/8: package the extension (node browser-extension/package.mjs)"
(cd "$SIMULATOR" && node browser-extension/package.mjs)

echo "==> Step 3/8: sync build/safari into the Xcode extension Resources (with --delete)"
# --delete so removed files (e.g. options.html, deleted 2026-08-12) do not
# linger inside the shipped appex and resurrect dead surfaces.
rsync -a --delete "$SIMULATOR/browser-extension/build/safari/." "$RESOURCES_DIR/"

echo "==> Step 4/8: xcodebuild Release"
xcodebuild -project "$XCODE_DIR/AI Pendant Browser Bridge.xcodeproj" \
  -scheme "AI Pendant Browser Bridge (macOS)" \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  build

echo "==> Step 5/8: copy the built app OVER the installed one (in place, never delete-first)"
###############################################################################
# NEVER rm/delete/move the installed bundle first. NEVER "reinstall".
#
# Deleting or re-registering the installed app resets Safari's storage
# identity for the extension and WIPES THE OWNER'S STORED CREDENTIALS. This
# happened live on 2026-08-10 and again on 2026-08-12; the entire reason this
# script exists is to make it impossible.
#
# Why rsync --delete INTO the bundle and not `ditto`: ditto MERGES, so a file
# removed from the build (options.html, 2026-08-12) would survive inside the
# installed appex — and the "obvious" fix, rm -rf'ing the bundle before ditto,
# is exactly the credential-wiping move this script forbids. rsync --delete
# updates and prunes the bundle's CONTENTS while the bundle directory itself —
# its path and its LaunchServices registration — stays put the whole time.
# Safari sees an update, not a new extension.
###############################################################################
# Sync at the Contents/ level: the .app bundle root is never deleted or
# re-created, only its contents converge on the build. --delete prunes files
# the build no longer ships.
#
# PROOF THIS PRESERVES IDENTITY (do not "simplify" back to ditto or rm+copy):
# the 1.7.0 -> 1.7.1 ship on 2026-08-12 left the pluginkit registration UUID
# unchanged (715C469E-B95F-4026-B22A-BA9AE0AA5442 before and after) — Safari
# saw an update, not a new extension, and the stored pairing survived.
rsync -a --delete "$BUILT_APP/Contents/" "$INSTALLED_APP/Contents/"

echo "==> Step 6/8: lsregister -u the derivedData build-products copy ONLY"
# The Release build the previous step produced sits inside derivedData and
# LaunchServices may have noticed it. If BOTH copies stay registered, Safari
# can bind the extension to the derivedData copy — which is exactly the
# identity switch that loses credentials. Unregister ONLY the build copy.
# NEVER lsregister -u the ~/Applications install.
"$LSREGISTER" -u "$BUILT_APP" || true

echo "==> Step 7/8: verify"
PLUGINKIT_ROWS="$(pluginkit -mAv -i "$EXT_ID.Extension" 2>/dev/null || true)"
echo "$PLUGINKIT_ROWS"
ROW_COUNT="$(printf '%s' "$PLUGINKIT_ROWS" | grep -c "$EXT_ID" || true)"
if [[ "$ROW_COUNT" -ne 1 ]]; then
  echo "ERROR: expected exactly 1 pluginkit row for $EXT_ID, found $ROW_COUNT." >&2
  echo "A second row means a stray copy is registered — Safari may bind to it" >&2
  echo "and drop the stored pairing. Unregister the stray (NOT ~/Applications)." >&2
  exit 1
fi
if ! printf '%s' "$PLUGINKIT_ROWS" | grep -q '^+'; then
  echo "ERROR: the pluginkit row is not enabled (+)." >&2
  exit 1
fi
if ! printf '%s' "$PLUGINKIT_ROWS" | grep -q "$HOME/Applications/"; then
  echo "ERROR: the pluginkit row does not point at ~/Applications." >&2
  exit 1
fi
codesign -v "$INSTALLED_APP"
echo "    codesign: valid"
if ! grep -q "\"version\": \"$SRC_VERSION\"" "$INSTALLED_MANIFEST"; then
  echo "ERROR: installed manifest is not at $SRC_VERSION after the copy." >&2
  exit 1
fi
echo "    installed manifest is at $SRC_VERSION"

echo "==> Step 8/8: done. Shipped $INSTALLED_VERSION -> $SRC_VERSION."
echo "    Now quit and reopen Safari so it picks up the new version."
