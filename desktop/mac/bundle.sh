#!/bin/sh
# Hive.app for Mac: the hive program (desktop/) with Hive for Safari (browser/) inside, signed with this Mac's Developer ID
# if it has one (ad hoc if not). Usage: desktop/mac/bundle.sh [where, default target/Hive.app] [program, default target/release/hive]
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
plist app.hive.mac hive APPL '<key>CFBundleIconFile</key><string>Hive</string><key>NSHighResolutionCapable</key><true/>' > "$new/Contents/Info.plist"
mkdir "$tmp/Hive.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}.png" > /dev/null
  [ $s -lt 512 ] && sips -z $((s * 2)) $((s * 2)) desktop/mac/icon.png --out "$tmp/Hive.iconset/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns "$tmp/Hive.iconset" -o "$new/Contents/Resources/Hive.icns"

# Hive for Safari: the same extension as Chrome's. Its one native piece hands it the Mac's pairing (read-only), so it connects
# to Hive by itself, with the app open or not.
cp -R browser/ "$ext/Contents/Resources/"
plist app.hive.mac.safari HiveSafari XPC! '<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.Safari.web-extension</string><key>NSExtensionPrincipalClass</key><string>SafariWebExtensionHandler</string></dict>' > "$ext/Contents/Info.plist"
cat > "$tmp/Safari.swift" <<'EOF'
import Foundation
import SafariServices
@objc(SafariWebExtensionHandler) class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let home = String(cString: getpwuid(getuid())!.pointee.pw_dir)
        let data = (try? Data(contentsOf: URL(fileURLWithPath: home + "/.config/hive/node.json"))) ?? Data()
        let conf = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let item = NSExtensionItem()
        item.userInfo = [SFExtensionMessageKey: ["server": conf["server"] ?? "", "token": conf["token"] ?? ""]]
        context.completeRequest(returningItems: [item])
    }
}
EOF
for a in arm64 x86_64; do
  swiftc -O -parse-as-library -application-extension -module-name HiveSafari -target $a-apple-macos13 "$tmp/Safari.swift" -Xlinker -e -Xlinker _NSExtensionMain -o "$tmp/$a"
done
lipo -create -output "$ext/Contents/MacOS/HiveSafari" "$tmp/arm64" "$tmp/x86_64"
printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.temporary-exception.files.home-relative-path.read-only</key><array><string>/.config/hive/</string></array></dict></plist>' > "$tmp/sandbox.plist"

id=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Developer ID Application/ { print $2; exit }')
sign() { if [ -n "$id" ]; then codesign -f -s "$id" -o runtime --timestamp "$@"; else codesign -f -s - "$@"; fi; }
sign --entitlements "$tmp/sandbox.plist" "$ext"
sign "$new"
rm -rf "$tmp" "$out.old"; if [ -e "$out" ]; then mv "$out" "$out.old"; fi; mv "$new" "$out"; rm -rf "$out.old"
echo "$out"
