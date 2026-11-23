#!/bin/sh
# Hive Server.app for Mac: what people download and open (hive-server-macos.zip). Its window (App.swift) moves it into
# Applications and shows setup; hive-server sits beside it in Contents/MacOS. macOS approves only an app it can find a stapled
# notarization ticket on, so the server goes out as an app. Signed with the Developer ID in the keychain if there is one (ad hoc
# if not); release.yml notarizes and staples it.
# Usage: server/mac/bundle.sh [where, default target/Hive Server.app] [program, default target/release/hive-server]
set -e
cd "$(dirname "$0")/../.."
out=${1:-target/Hive Server.app}; bin=${2:-target/release/hive-server}
new="$out.new"; tmp=$(mktemp -d)
version="1.$(git rev-list --count HEAD 2>/dev/null || echo 0)"
rm -rf "$new"; mkdir -p "$new/Contents/MacOS" "$new/Contents/Resources"
cp "$bin" "$new/Contents/MacOS/hive-server"
for a in arm64 x86_64; do
  swiftc -O -parse-as-library -target $a-apple-macos13 server/mac/App.swift -o "$tmp/$a"
done
lipo -create -output "$new/Contents/MacOS/Hive Server" "$tmp/arm64" "$tmp/x86_64"
cat > "$new/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.hive.server</string><key>CFBundleExecutable</key><string>Hive Server</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Hive Server</string><key>CFBundleDisplayName</key><string>Hive Server</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundleShortVersionString</key><string>$version</string><key>CFBundleVersion</key><string>$version</string>
<key>CFBundleIconFile</key><string>Hive</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF
mkdir "$tmp/Hive.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}.png" > /dev/null
  [ $s -lt 512 ] && sips -z $((s * 2)) $((s * 2)) desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns "$tmp/Hive.iconset" -o "$new/Contents/Resources/Hive.icns"
id=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ { print $2; exit }')
sign() { if [ -n "$id" ]; then codesign -f -s "$id" -o runtime --timestamp "$@"; else codesign -f -s - "$@"; fi; }
sign "$new/Contents/MacOS/hive-server"
sign "$new"
rm -rf "$tmp" "$out.old"; if [ -e "$out" ]; then mv "$out" "$out.old"; fi; mv "$new" "$out"; rm -rf "$out.old"
echo "$out"
