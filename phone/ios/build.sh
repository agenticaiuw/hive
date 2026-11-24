#!/bin/sh
# Hive, the iPhone app: the phone as Hive's node, and the dashboard. iOS lets an app see and touch the whole screen only
# as a UI test, so Hive is one, our own (HivePhone/, no WebDriverAgent): it dials out to the Hive Server and answers the
# server's WebDriverAgent-style calls in-process (nothing can reach in), and shows the dashboard in its own window
# whenever it's in front. A Hive Server on a tailnet is reached through Tailscale inside the app: tailscale/libtailscale
# (BSD-3-Clause), built here from a pinned commit.
# Makes target/Hive.ipa, unsigned (SideStore or the owner's Apple developer team signs it). Packaging follows
# OpenMinis/iCTRL (Apache-2.0) so it starts from its icon while the phone's developer disk image is mounted.
# `build.sh test` instead tries it on an iPhone simulator: the smoke test under xcodebuild (target/HivePhone/smoke.xcresult),
# then the packaged app launched from its icon, as a person would, with its window probed (target/HivePhone/probe).
# Needs Xcode and Go.
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
# Xcode's test runner app with our test inside, as the app a person installs: its name, id, icon and version, ad-hoc signed.
dress() {
  for p in $1/Info.plist $1/PlugIns/*.xctest/Info.plist; do plutil -replace CFBundleIdentifier -string $id $p; done
  plutil -replace CFBundleDisplayName -string Hive $1/Info.plist
  plutil -replace HiveVersion -string "$(git log -1 --format=%h --abbrev=12 -- phone/ios 2> /dev/null || echo dev)" $1/Info.plist
  sips -z 120 120 dashboard/icon.png --out $1/AppIcon60x60@2x.png > /dev/null; cp dashboard/icon.png $1/AppIcon60x60@3x.png
  plutil -replace CFBundleIcons -json '{"CFBundlePrimaryIcon":{"CFBundleIconFiles":["AppIcon60x60"]}}' $1/Info.plist
  find $1 -name '*.framework' -o -name '*.xctest' -o -name '*.dylib' | sort -r | xargs -I{} codesign -f -s - --timestamp=none {} 2> /dev/null
  codesign -f -s - --timestamp=none $1
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
  TEST_RUNNER_HIVE_SMOKE=1 xcodebuild test $project -destination "id=$sim" -derivedDataPath $out/sim -resultBundlePath $out/smoke.xcresult \
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
  exit ${failed:-0}
fi
xcodebuild build-for-testing $project -quiet -destination generic/platform=iOS -derivedDataPath $out/derived \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 DEBUG_INFORMATION_FORMAT=dwarf
rm -rf $out/Payload; mkdir -p $out/Payload
app=$out/Payload/Hive.app
ditto $out/derived/Build/Products/Debug-iphoneos/HivePhone-Runner.app $app
# Everything Xcode embeds in Frameworks is XCTest's, which comes from the phone's developer disk image, matched to its iOS.
rm -rf $app/Frameworks
dress $app
echo "From the developer disk image:" $(missing $app) | tee $out/disk-image.txt
(cd $out && rm -f ../Hive.ipa && zip -qry ../Hive.ipa Payload) && echo target/Hive.ipa
