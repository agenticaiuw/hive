#!/bin/bash
# Builds "AI Pendant.app" (menu-bar + desktop companion) into build/ and codesigns it.
set -euo pipefail
cd "$(dirname "$0")"

APP="AI Pendant.app"
OUT="build/$APP"

mkdir -p build

# Regenerate the app icon when the generator changed (or icon is missing).
if [ ! -f build/AppIcon.icns ] || [ Tools/make-icon.swift -nt build/AppIcon.icns ]; then
  xcrun swift Tools/make-icon.swift build/AppIcon.icns
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

xcrun swiftc -O -o "$OUT/Contents/MacOS/AI Pendant" Sources/main.swift
cp Info.plist "$OUT/Contents/Info.plist"
cp build/AppIcon.icns "$OUT/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$OUT/Contents/PkgInfo"

# Prefer an Apple Development identity; fall back to ad-hoc signing.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Apple Development/ {print $2; exit}')"
IDENTITY="${IDENTITY:--}"

codesign --force --sign "$IDENTITY" "$OUT"
echo "Built: $PWD/$OUT"
echo "Signed with: $IDENTITY"
