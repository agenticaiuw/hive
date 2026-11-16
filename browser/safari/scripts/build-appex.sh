#!/bin/bash
# Builds Hive's Safari extension as an app extension for Hive.app to carry in Contents/PlugIns, so
# Safari lists it as "Hive" and there's no separate app to install or keep updated. The code is the
# same as the Chrome extension's (browser/chrome/src).
#
#   browser/safari/scripts/build-appex.sh OUT.appex BUNDLE_ID
#
# BUNDLE_ID must start with Hive.app's own identifier, and must stay the same across releases: a
# Hive update swaps the whole app bundle, which can reset Safari's storage for the extension, and the
# pairing then comes back from the copy SafariWebExtensionHandler.swift keeps in the extension's own
# container, which is named by BUNDLE_ID.
#
# The result is unsigned; the caller signs it (desktop/app/Makefile).
set -euo pipefail
out=$1 bundle_id=$2
root=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Package in a copy: browser/chrome/build is the folder Chrome loads the extension from.
mkdir -p "$work/repo/browser" "$work/repo/cloud"
rsync -a --exclude /build --exclude /node_modules "$root/browser/chrome/" "$work/repo/browser/chrome/"
ln -s "$root/browser/chrome/node_modules" "$work/repo/browser/chrome/node_modules"
cp -R "$root/cloud/shared" "$work/repo/cloud/shared"
(cd "$work/repo/browser/chrome" && node package.mjs >/dev/null)

rsync -a --exclude /build "$root/browser/safari/Hive Browser Bridge/" "$work/project/"
rsync -a --delete "$work/repo/browser/chrome/build/safari/" "$work/project/Shared (Extension)/Resources/"
xcodebuild -quiet -project "$work/project/Hive Browser Bridge.xcodeproj" \
  -target "Hive Browser Bridge Extension (macOS)" -configuration Release \
  SYMROOT="$work/build" OBJROOT="$work/obj" \
  PRODUCT_NAME=Hive PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" INFOPLIST_KEY_CFBundleDisplayName=Hive \
  CODE_SIGNING_ALLOWED=NO

rm -rf "$out"
cp -R "$work/build/Release/Hive.appex" "$out"
