#!/bin/sh
# Hive Phone, the iPhone app: the phone as Hive's node, and Hive's dashboard. iOS lets an app see and touch the whole
# screen only as a UI test, so Hive Phone is one, our own (HivePhone/, no WebDriverAgent): it dials out to Hive's server
# and answers the server's WebDriverAgent-style calls in-process; nothing can reach in. A Hive on a tailnet (*.ts.net) is
# reached through Tailscale inside the app: tailscale/libtailscale (BSD-3-Clause), built here from a pinned commit.
# Makes target/HivePhone.ipa, unsigned (SideStore or the owner's Apple developer team signs it). Packaging follows
# OpenMinis/iCTRL (Apache-2.0) so it starts from its icon while the phone's developer disk image is mounted.
# `build.sh test` instead runs HivePhone's smoke test on an iPhone simulator (target/HivePhone/smoke.xcresult).
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
if [ "$1" = test ]; then
  sim=$(xcrun simctl list devices available | awk -F '[()]' '/iPhone/ { print $2; exit }')
  rm -rf $out/smoke.xcresult
  TEST_RUNNER_HIVE_SMOKE=1 xcodebuild test $project -destination "id=$sim" -derivedDataPath $out/sim -resultBundlePath $out/smoke.xcresult \
    -only-testing:HivePhone/HivePhone/testSmoke ARCHS=arm64
  exit
fi
xcodebuild build-for-testing $project -quiet -destination generic/platform=iOS -derivedDataPath $out/derived \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 DEBUG_INFORMATION_FORMAT=dwarf
rm -rf $out/Payload; mkdir -p $out/Payload
app=$out/Payload/HivePhone.app
ditto $out/derived/Build/Products/Debug-iphoneos/HivePhone-Runner.app $app
# Everything Xcode embeds in Frameworks is XCTest's, which comes from the phone's developer disk image, matched to its iOS.
rm -rf $app/Frameworks
for p in $app/Info.plist $app/PlugIns/*.xctest/Info.plist; do plutil -replace CFBundleIdentifier -string app.hive.phone.xctrunner $p; done
plutil -replace CFBundleDisplayName -string "Hive Phone" $app/Info.plist
plutil -replace HiveVersion -string "$(git log -1 --format=%h --abbrev=12 -- phone/ios 2> /dev/null || echo dev)" $app/Info.plist
sips -z 120 120 dashboard/icon.png --out $app/AppIcon60x60@2x.png > /dev/null; cp dashboard/icon.png $app/AppIcon60x60@3x.png
plutil -replace CFBundleIcons -json '{"CFBundlePrimaryIcon":{"CFBundleIconFiles":["AppIcon60x60"]}}' $app/Info.plist
find $app -name '*.framework' -o -name '*.xctest' -o -name '*.dylib' | sort -r | xargs -I{} codesign -f -s - --timestamp=none {} 2> /dev/null
codesign -f -s - --timestamp=none $app
(cd $out && rm -f ../HivePhone.ipa && zip -qry ../HivePhone.ipa Payload) && echo target/HivePhone.ipa
