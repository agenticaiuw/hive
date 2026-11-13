#!/bin/bash
# Package a prebuilt personal-agent app as Hive without installing or touching
# the owner's existing application. SIGN must be explicitly supplied.
set -euo pipefail
if [ "$#" -ne 2 ] || [ -z "${SIGN:-}" ]; then
  echo 'Usage: SIGN=- desktop/integration/scripts/package-hive-macos.sh /path/to/Agent.app /path/to/new/Hive.app' >&2
  exit 2
fi
source_app=$1
output_app=$2
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
[ -d "$source_app/Contents" ] || { echo 'Input app is missing.' >&2; exit 1; }
[ ! -e "$output_app" ] || { echo 'Output already exists; refusing to overwrite.' >&2; exit 1; }
source_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")
[ "$source_id" = 'local.personal-agent.Agent' ] || { echo 'Unexpected app identity.' >&2; exit 1; }
mkdir -p "$(dirname "$output_app")"
stage="${output_app}.tmp.$$"
trap 'rm -rf "$stage"; rm -f "${stage}.entitlements.plist"' EXIT
[ ! -e "$stage" ] || { echo 'Staging path exists.' >&2; exit 1; }
ditto "$source_app" "$stage"
plist="$stage/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleDisplayName' "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Hive' "$plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconFile' "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string Hive.icns' "$plist"
mkdir -p "$stage/Contents/Resources"
# Built from branding/hive.svg, the icon's only copy.
make -s -C "$repo_root/desktop/app" build/Hive.icns >/dev/null
cp "$repo_root/desktop/app/build/Hive.icns" "$stage/Contents/Resources/Hive.icns"
entitlements="${stage}.entitlements.plist"
codesign -d --entitlements :- "$source_app" > "$entitlements" 2>/dev/null || true
if [ -s "$entitlements" ]; then
  plutil -lint "$entitlements" >/dev/null
  codesign --force --sign "$SIGN" --identifier "$source_id" --entitlements "$entitlements" "$stage"
else
  codesign --force --sign "$SIGN" --identifier "$source_id" "$stage"
fi
rm -f "$entitlements"
codesign --verify --deep --strict "$stage"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = "$source_id" ]
# Reserve output without replacing any file installed by the owner.
mkdir "$output_app"
touch "$output_app/.packaging-incomplete"
mv "$stage/Contents" "$output_app/Contents"
rm "$output_app/.packaging-incomplete"
rmdir "$stage"
trap - EXIT
printf 'Packaged Hive at %s (not installed).\n' "$output_app"
