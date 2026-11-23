#!/bin/sh
# Hive Server.app for Mac: what people download and open (hive-server-macos.zip). macOS approves only an app it can find a
# stapled notarization ticket on, and a bare program can't carry one, so the server goes out as an app; opened from Finder it
# reopens itself in Terminal. Signed with the Developer ID in the keychain if there is one (ad hoc if not); release.yml
# notarizes and staples it. Usage: server/mac/bundle.sh [where, default target/Hive Server.app] [program, default target/release/hive-server]
set -e
cd "$(dirname "$0")/../.."
out=${1:-target/Hive Server.app}; bin=${2:-target/release/hive-server}
new="$out.new"; tmp=$(mktemp -d)
version="1.$(git rev-list --count HEAD 2>/dev/null || echo 0)"
rm -rf "$new"; mkdir -p "$new/Contents/MacOS" "$new/Contents/Resources"
cp "$bin" "$new/Contents/MacOS/hive-server"
cat > "$new/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.hive.server</string><key>CFBundleExecutable</key><string>hive-server</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Hive Server</string><key>CFBundleDisplayName</key><string>Hive Server</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundleShortVersionString</key><string>$version</string><key>CFBundleVersion</key><string>$version</string>
<key>CFBundleIconFile</key><string>Hive</string><key>LSUIElement</key><true/>
</dict></plist>
EOF
mkdir "$tmp/Hive.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}.png" > /dev/null
  [ $s -lt 512 ] && sips -z $((s * 2)) $((s * 2)) desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns "$tmp/Hive.iconset" -o "$new/Contents/Resources/Hive.icns"
id=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ { print $2; exit }')
if [ -n "$id" ]; then codesign -f -s "$id" -o runtime --timestamp "$new"; else codesign -f -s - "$new"; fi
rm -rf "$tmp" "$out.old"; if [ -e "$out" ]; then mv "$out" "$out.old"; fi; mv "$new" "$out"; rm -rf "$out.old"
echo "$out"
