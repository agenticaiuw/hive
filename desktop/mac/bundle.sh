#!/bin/sh
# Hive.app for Mac: the hive program (desktop/) with Hive for Safari (browser/) inside, signed with the Developer ID in the
# keychain if there is one (ad hoc if not); release.yml notarizes it. Usage: desktop/mac/bundle.sh [where, default target/Hive.app] [program, default target/release/hive]
set -e
cd "$(dirname "$0")/../.."
out=${1:-target/Hive.app}; bin=${2:-target/release/hive}
new="$out.new"; ext="$out.new/Contents/PlugIns/Safari.appex"; tmp=$(mktemp -d)
version="1.$(git rev-list --count HEAD 2>/dev/null || echo 0)"
rm -rf "$new"; mkdir -p "$new/Contents/MacOS" "$new/Contents/Resources" "$ext/Contents/MacOS" "$ext/Contents/Resources"

plist() { # bundle id, executable, package type, more keys
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$1</string><key>CFBundleExecutable</key><string>$2</string><key>CFBundlePackageType</key><string>$3</string>
<key>CFBundleName</key><string>Hive</string><key>CFBundleDisplayName</key><string>Hive</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundleShortVersionString</key><string>$version</string><key>CFBundleVersion</key><string>$version</string>$4
</dict></plist>
EOF
}

cp "$bin" "$new/Contents/MacOS/hive"
plist app.hive.mac hive APPL '<key>CFBundleIconFile</key><string>Hive</string><key>LSUIElement</key><true/><key>NSCalendarsUsageDescription</key><string>Hive reads and updates your Apple Calendar directly as the single source of truth when you ask an agent.</string><key>NSCalendarsFullAccessUsageDescription</key><string>Hive reads and updates your Apple Calendar directly as the single source of truth when you ask an agent.</string><key>NSRemindersUsageDescription</key><string>Hive reads and updates your Apple Reminders directly as the single source of truth when you ask an agent.</string><key>NSRemindersFullAccessUsageDescription</key><string>Hive reads and updates your Apple Reminders directly as the single source of truth when you ask an agent.</string>' > "$new/Contents/Info.plist"
mkdir "$tmp/Hive.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}.png" > /dev/null
  [ $s -lt 512 ] && sips -z $((s * 2)) $((s * 2)) desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns "$tmp/Hive.iconset" -o "$new/Contents/Resources/Hive.icns"

# Hive for Safari: the same extension as Chrome's, joining Hive through its own Tailscale. An app extension is still a
# program, so it gets an empty one (NSExtensionMain) with no native messaging.
cp -R browser/ "$ext/Contents/Resources/"
plist app.hive.mac.safari HiveSafari XPC! '<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.Safari.web-extension</string></dict>' > "$ext/Contents/Info.plist"
echo 'import Foundation' > "$tmp/Safari.swift"
for a in arm64 x86_64; do
  swiftc -O -parse-as-library -application-extension -module-name HiveSafari -target $a-apple-macos13 "$tmp/Safari.swift" -Xlinker -e -Xlinker _NSExtensionMain -o "$tmp/$a"
done
lipo -create -output "$ext/Contents/MacOS/HiveSafari" "$tmp/arm64" "$tmp/x86_64"
printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>' > "$tmp/sandbox.plist"

id=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ { print $2; exit }')
sign() { if [ -n "$id" ]; then codesign -f -s "$id" -o runtime --timestamp "$@"; else codesign -f -s - "$@"; fi; }
sign --entitlements "$tmp/sandbox.plist" "$ext"
sign "$new"
rm -rf "$tmp" "$out.old"; if [ -e "$out" ]; then mv "$out" "$out.old"; fi; mv "$new" "$out"; rm -rf "$out.old"
echo "$out"
