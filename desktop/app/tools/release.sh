#!/bin/bash
# Makes the Hive download: a copy of Hive.app signed with your Developer ID certificate and the
# hardened runtime (what macOS needs to open an app from the internet without warning about it),
# notarized by Apple and stapled, in a disk image that is notarized and stapled too:
# build/release/Hive-<version>.dmg. Nothing is published; the download is only made here.
#
#   tools/release.sh [APP]                 APP defaults to build/Agent.app (make builds it)
#   tools/release.sh --no-notarize [APP]   sign and make the disk image only, to check the signing
#
# Notarizing uses the keychain profile "Hive notarization" (xcrun notarytool store-credentials),
# or NOTARY_PROFILE. Build APP from a clean export of the commit you're releasing, not from a
# working tree with other people's unfinished changes in it.
set -euo pipefail
cd "$(dirname "$0")/.."
notarize=1
if [ "${1:-}" = "--no-notarize" ]; then notarize=0; shift; fi
source_app=${1:-build/Agent.app}
profile=${NOTARY_PROFILE:-Hive notarization}

# By its hash: by name, codesign can pick a copy of the certificate without its key, and fails
# with errSecInternalComponent.
identity=$(security find-identity -v -p codesigning | awk '/"Developer ID Application: / {print $2; exit}')
if [ -z "$identity" ]; then
  echo "✗ No Developer ID Application certificate in the keychain." >&2
  exit 1
fi
if [ "$source_app" = build/Agent.app ]; then make -s build/Agent.app; fi
[ -d "$source_app/Contents" ] || { echo "✗ $source_app isn't an app." >&2; exit 1; }

version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$source_app/Contents/Info.plist" 2>/dev/null || true)
version=${version:-$(date +%Y.%m.%d)}
out=build/release
rm -rf "$out" && mkdir -p "$out/image"
app="$out/image/Hive.app"
ditto "$source_app" "$app"

# A teammate's whole setup goes inside, so the download alone sets up the same Hive the owner runs
# (tools/carry.mjs, then tools/first-open.sh on their Mac): a Mac release of the commit, the voice
# files, uv (HIVE_UV, else the one on PATH; it must offer requirements.lock's Python) and Codex.
# RELEASE_SOURCE is the clean export to take them from; by default the last commit is exported.
src=${RELEASE_SOURCE:-}
if [ -z "$src" ]; then
  src="$out/source" && mkdir -p "$src"
  git -C ../.. archive HEAD | tar -x -C "$src"
fi
node ../../cloud/release.mjs mac --from "$src" --dry-run --out "$out/mac.release"
node tools/carry.mjs "$app" --release "$out/mac.release" --source "$src" ${HIVE_UV:+--uv "$HIVE_UV"}
rm -rf "$out/mac.release" "$out/source"

# Inside out, each with a secure timestamp and the hardened runtime: the helper, the Safari
# extension (with its sandbox entitlements: Safari loads no other kind), then the app itself.
sign() { codesign --force --timestamp --options runtime --sign "$identity" "$@"; }
# The development signatures come off first: re-signing reuses the space a signature had without
# clearing it, so the old certificate, which names the owner's Apple ID, would stay underneath.
for code in "$app/Contents/Helpers/workspace-engine" "$app/Contents/PlugIns/Hive.appex" "$app"; do
  if [ -e "$code" ]; then codesign --remove-signature "$code"; fi
done
# Every program the app carries for a teammate's setup (Hive's agent and tools, uv, Codex and what
# it brings): Apple notarizes no app with an unsigned program inside, or one without the hardened runtime.
find "$app/Contents/Resources/hive" "$app/Contents/Helpers/uv" "$app/Contents/Resources/codex" -type f 2>/dev/null |
  while IFS= read -r file; do
    if file -b "$file" | grep -q '^Mach-O'; then
      codesign --remove-signature "$file" 2>/dev/null || true
      sign "$file"
    fi
  done
sign --identifier local.personal-agent.workspace-engine "$app/Contents/Helpers/workspace-engine"
if [ -d "$app/Contents/PlugIns/Hive.appex" ]; then
  sign --identifier local.personal-agent.Agent.Safari --entitlements tools/HiveSafari.entitlements "$app/Contents/PlugIns/Hive.appex"
fi
sign --identifier local.personal-agent.Agent --entitlements tools/Hive-release.entitlements "$app"
codesign --verify --deep --strict "$app"
# Nothing anyone downloads carries this machine's owner: their cloud, home folder or emails. Checked
# once re-signed, since the development signature it replaced names the owner's Apple ID.
node ../../cloud/shared/ownerDetails.mjs "$app" || { echo "release.sh: the app holds the owner's details (listed above); not releasing it" >&2; exit 1; }

notarize_and_staple() {
  local what=$1 upload=$2
  local log="$out/notary-$(basename "$upload").json"
  xcrun notarytool submit "$upload" --keychain-profile "$profile" --wait --timeout 30m --output-format json > "$log"
  local status id
  status=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$log")
  id=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$log")
  if [ "$status" != Accepted ]; then
    echo "✗ Apple didn't accept $what ($status). Its log:" >&2
    xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || true
    exit 1
  fi
  xcrun stapler staple "$what"
}

if [ "$notarize" = 1 ]; then
  ditto -c -k --keepParent "$app" "$out/Hive.zip"
  notarize_and_staple "$app" "$out/Hive.zip"
  rm "$out/Hive.zip"
fi

# The disk image: Hive.app and a link to Applications to drag it onto.
ln -s /Applications "$out/image/Applications"
dmg="$out/Hive-$version.dmg"
hdiutil create -quiet -volname Hive -srcfolder "$out/image" -fs HFS+ -format UDZO "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
if [ "$notarize" = 1 ]; then
  notarize_and_staple "$dmg" "$dmg"
  spctl --assess --type open --context context:primary-signature -v "$dmg"
  spctl --assess --type execute -v "$app"
fi
rm -rf "$out/image"
echo "✓ $dmg"
