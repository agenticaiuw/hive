#!/bin/bash
# Builds "AI Pendant.app" (menu-bar + desktop companion) into build/ and codesigns it.
set -euo pipefail
cd "$(dirname "$0")"

APP="AI Pendant.app"
OUT="build/$APP"

mkdir -p build

# THE ONE PRODUCT ICON: builds consume the checked-in master
# (assets/icon/pendant.icns at the git root, fanned out everywhere by
# scripts/sync-icons.mjs). This block used to regenerate artwork per build via
# Tools/make-icon.swift, which is exactly how the product ended up wearing
# four different faces at once — the generator drifted from every other
# surface. make-icon.swift remains as the DESIGN tool: run it to draw new
# artwork INTO assets/icon (then sync-icons), never into a build.
cp ../../assets/icon/pendant.icns build/AppIcon.icns

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

xcrun swiftc -O -o "$OUT/Contents/MacOS/AI Pendant" Sources/main.swift
cp Info.plist "$OUT/Contents/Info.plist"
cp build/AppIcon.icns "$OUT/Contents/Resources/AppIcon.icns"

# Prefer an Apple Development identity; fall back to ad-hoc signing.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Apple Development/ {print $2; exit}')"
IDENTITY="${IDENTITY:--}"

codesign --force --sign "$IDENTITY" "$OUT"
echo "Built: $PWD/$OUT"
echo "Signed with: $IDENTITY"
