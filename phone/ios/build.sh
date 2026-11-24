#!/bin/sh
# Hive starts as a normal UIKit app, brings up its device-local packet tunnel,
# mounts the personalized developer image, then loads its own XCTest bundle.
# The test bundle keeps full screen control and connects directly to Hive Server;
# the dashboard and Tailscale stay inside Hive. No WebDriverAgent is involved.
# Makes target/Hive.ipa. CI signs it with the owner's IOS_* repository secrets;
# IOS_PROFILE contains the app and Network Extension provisioning profiles.
# `build.sh test` checks the tools through Xcode, then probes the packaged app
# launched from its icon, including taps and control while it is in the background.
# Needs Xcode, Go and Rust (CI installs the iOS Rust target).
set -e
cd "$(dirname "$0")/../.."
ts=target/libtailscale; lib=target/libtailscale.xcframework; out=target/HivePhone
rev=dacde75057ff350e146505829beff446e6823966
if [ ! -d $lib ]; then
  [ -d $ts/.git ] || { git init -q $ts && git -C $ts fetch -q --depth 1 https://github.com/tailscale/libtailscale $rev && git -C $ts checkout -q FETCH_HEAD; }
  # A c-archive per platform, with libtailscale's own clang wrappers (its Makefile's iOS targets); Go fetches the
  # toolchain its go.mod asks for.
  for p in ios ios-sim-arm; do
    (cd $ts && GOOS=ios GOARCH=arm64 CGO_ENABLED=1 CC="$PWD/swift/script/clangwrap-$p.sh" go build -trimpath -ldflags -w -tags ios -buildmode=c-archive -o libtailscale-$p.a)
  done
  mkdir -p $ts/include && cp $ts/tailscale.h $ts/include/
  xcodebuild -create-xcframework -library $ts/libtailscale-ios.a -headers $ts/include -library $ts/libtailscale-ios-sim-arm.a -headers $ts/include -output $lib
fi
project="-project phone/ios/HivePhone.xcodeproj -scheme HivePhone -configuration Debug"
id=app.hive.xctrunner
# The installed app and its test bundle share Hive’s identity, icon and version.
dress() {
  for p in $1/Info.plist $1/PlugIns/*.xctest/Info.plist; do plutil -replace CFBundleIdentifier -string $id $p; done
  plutil -replace CFBundleDisplayName -string Hive $1/Info.plist
  # A runner template has no launch screen and otherwise gets a 320x480
  # compatibility viewport, which makes its window and screen coordinates differ.
  plutil -replace UILaunchScreen -json '{}' $1/Info.plist
  plutil -replace HiveVersion -string "$(git log -1 --format=%h --abbrev=12 -- phone/ios 2> /dev/null || echo dev)" $1/Info.plist
  sips -z 120 120 dashboard/icon.png --out $1/AppIcon60x60@2x.png > /dev/null; cp dashboard/icon.png $1/AppIcon60x60@3x.png
  plutil -replace CFBundleIcons -json '{"CFBundlePrimaryIcon":{"CFBundleIconFiles":["AppIcon60x60"]}}' $1/Info.plist
  find $1 -name '*.framework' -o -name '*.xctest' -o -name '*.dylib' | sort -r | xargs -I{} codesign -f -s - --timestamp=none {} 2> /dev/null
  if [ -d "$1/PlugIns/HiveLoopback.appex" ]; then
    codesign -f -s - --timestamp=none --entitlements phone/ios/Loopback/Entitlements.plist $1/PlugIns/HiveLoopback.appex
    codesign -f -s - --timestamp=none --entitlements phone/ios/Loopback/Entitlements.plist $1
  else
    codesign -f -s - --timestamp=none $1
  fi
}
# The @rpath libraries the app's binaries load that the app doesn't carry (Frameworks/X.framework or Frameworks/X.dylib):
# xcodebuild finds them in Xcode, a device in its developer disk image.
missing() {
  find $1 -type f | while read -r f; do otool -L "$f" 2> /dev/null | awk '/@rpath\// { sub("@rpath/", "", $1); split($1, p, "/"); print p[1] }'; done |
    sort -u | while read -r l; do [ -e "$1/Frameworks/$l" ] || echo "$l"; done
}
if [ "$1" = test ]; then
  sim=$(xcrun simctl list devices available | awk -F '[()]' '/iPhone/ { print $2; exit }')
  xcrun simctl boot "$sim" 2> /dev/null || true
  rm -rf $out/smoke.xcresult $out/probe; mkdir -p $out/probe
  docs() { echo "$(xcrun simctl get_app_container "$sim" $id data 2> /dev/null)/Documents"; }
  # 1. Every call the server makes, with the runner started by xcodebuild.
  xcodebuild build-for-testing $project -destination "id=$sim" -derivedDataPath $out/sim ARCHS=arm64
  smoke=$out/sim/Build/Products/Debug-iphonesimulator/HivePhone-Runner.app
  plutil -replace UILaunchScreen -json '{}' $smoke/Info.plist
  codesign -f -s - --timestamp=none $smoke
  TEST_RUNNER_HIVE_SMOKE=1 xcodebuild test-without-building $project -destination "id=$sim" -derivedDataPath $out/sim -resultBundlePath $out/smoke.xcresult \
    -only-testing:HivePhone/HivePhone/testSmoke ARCHS=arm64 || failed=1
  cp "$(docs)"/probe-smoke* $out/probe/ 2> /dev/null || true
  # 2. As a person uses it: the packaged app launched from its icon (what simctl launch does), its window probed while
  # the runner carries on (Probe.icon), and at 30 seconds launched from its icon again. A simulator has no developer
  # disk image, so this one keeps the XCTest frameworks Xcode put in it.
  app=$out/icon/Hive.app
  rm -rf $out/icon; mkdir -p $out/icon
  ditto $out/sim/Build/Products/Debug-iphonesimulator/HivePhone-Runner.app $app
  # A simulator has no developer disk image: what xcodebuild would take from Xcode goes in the app (lib_TestingInterop.dylib,
  # for one, which Testing.framework loads), until nothing is missing.
  dev=$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer
  for round in 1 2 3; do
    for l in $(missing $app); do
      src=$(find "$dev/Library" "$dev/usr/lib" -maxdepth 2 -name "$l" 2> /dev/null | head -1)
      if [ -n "$src" ]; then ditto "$src" "$app/Frameworks/$l"; echo "added from Xcode: $l" >> $out/probe/host.txt
      else echo "missing, not in Xcode either: $l" >> $out/probe/host.txt; fi
    done
  done
  # Prove that a normal UIKit executable can defer loading XCTest and still
  # start our full automation bundle. It carries no XCTest load command.
  executable=$(plutil -extract CFBundleExecutable raw $app/Info.plist)
  xcrun --sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=18.0 -fobjc-arc \
    -framework UIKit -framework Foundation -Wl,-rpath,@executable_path/Frameworks \
    phone/ios/Bootstrap/Main.m -o $app/$executable
  if otool -L $app/$executable | grep -q XCTest; then echo "Bootstrap links XCTest before mount" >&2; exit 1; fi
  dress $app
  xcrun simctl uninstall "$sim" $id 2> /dev/null || true
  xcrun simctl install "$sim" $app
  launch() {
    SIMCTL_CHILD_HIVE_PROBE=1 xcrun simctl launch --stdout=$PWD/$out/probe/stdout-$1.txt --stderr=$PWD/$out/probe/stderr-$1.txt "$sim" $id \
      >> $out/probe/host.txt 2>&1 || echo "launch $1 failed: $?" >> $out/probe/host.txt
  }
  launch 1
  for t in $(seq 1 90); do
    sleep 1
    case $t in 5|12|22|28|38) xcrun simctl io "$sim" screenshot $out/probe/host-$t.png > /dev/null 2>&1 || true ;; esac
    if [ $t = 30 ]; then launch 2; fi
    if grep -q '"step":"done"' "$(docs)/probe-icon.log" 2> /dev/null; then break; fi
  done
  echo "waited $t s" >> $out/probe/host.txt
  cp "$(docs)"/probe-icon* $out/probe/ 2> /dev/null || true
  xcrun simctl spawn "$sim" log show --last 3m --style compact --predicate 'process == "HivePhone-Runner"' > $out/probe/log.txt 2>&1 || true
  # Starting testRun alone is insufficient: the icon launch must retain full
  # screen control and complete its foreground/background/tap probe.
  python3 - "$out/probe/probe-icon.log" <<'PYPROBE' || failed=1
import json, sys
with open(sys.argv[1]) as file:
    states = [json.loads(line) for line in file if line.strip()]
assert any(s.get("step") == "done" and s.get("taps", 0) >= 3 for s in states), "icon probe did not finish with three successful taps"
assert any(s.get("step") == "Settings in front (an agent's action)" and s.get("app") == "background" for s in states), "icon probe could not activate Settings"
assert any(s.get("step") == "home screen after seven seconds" and s.get("app") == "background" for s in states), "icon runner did not retain control in the background"
PYPROBE
  exit ${failed:-0}
fi
xcodebuild build-for-testing $project -quiet -destination generic/platform=iOS -derivedDataPath $out/derived \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 DEBUG_INFORMATION_FORMAT=dwarf
rm -rf $out/Payload; mkdir -p $out/Payload
app=$out/Payload/Hive.app
ditto $out/derived/Build/Products/Debug-iphoneos/HivePhone-Runner.app $app
# The normal UIKit executable runs before the DDI exists; the .xctest bundle
# stays inside the app and loads only after the image is mounted.
archive=${CARGO_TARGET_DIR:-target/phone-bootstrap}/aarch64-apple-ios/release/libhive_phone_bootstrap.a
if [ ! -f "$archive" ]; then
  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-target/phone-bootstrap} cargo build --locked --release --target aarch64-apple-ios --manifest-path phone/ios/bootstrap/Cargo.toml
fi
phone/ios/Bootstrap/build.sh
phone/ios/Loopback/build.sh
executable=$(plutil -extract CFBundleExecutable raw $app/Info.plist)
cp target/HivePhone/HiveBootstrap $app/$executable
ditto target/HivePhone/HiveLoopback.appex $app/PlugIns/HiveLoopback.appex
plutil -replace UIFileSharingEnabled -bool true $app/Info.plist
plutil -replace NSLocalNetworkUsageDescription -string "Hive connects to this iPhone’s own developer services for phone control." $app/Info.plist
plutil -replace NSBonjourServices -json '["_remotepairing._tcp"]' $app/Info.plist
# The XCTest frameworks come from the phone's developer disk image, matched to its iOS.
rm -rf $app/Frameworks
dress $app
# Signed by the owner's Apple team when its provisioning profile for app.hive.xctrunner is here (HIVE_IOS_PROFILE, ad hoc or
# development, listing the iPhones that may install it; for the extension, a zip of both profiles) and its certificate is in the keychain. Those iPhones then install
# it from Safari with a link to target/manifest.plist: itms-services://?action=download-manifest&url=<manifest.plist's address>.
if [ -n "$HIVE_IOS_PROFILE" ]; then
  python3 phone/ios/sign.py "$app"
  cat > target/manifest.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>https://github.com/agenticaiuw/hive/releases/download/latest/Hive.ipa</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>$id</string><key>bundle-version</key><string>$(plutil -extract CFBundleVersion raw $app/Info.plist)</string><key>kind</key><string>software</string><key>title</key><string>Hive</string></dict>
</dict></array></dict></plist>
EOF
fi
echo "From the developer disk image:" $(missing $app) | tee $out/disk-image.txt
(cd $out && rm -f ../Hive.ipa && zip -qry ../Hive.ipa Payload) && echo target/Hive.ipa
