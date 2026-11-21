#!/bin/sh
# Hive Phone, the app that lets Hive's agents use an iPhone. iOS lets an app see and touch the whole screen only as a UI test,
# so it is WebDriverAgent's test runner (appium/WebDriverAgent, BSD license) plus PhoneRelay.h, which dials out to Hive's
# phone relay and passes its calls to the runner on 127.0.0.1:8100; nothing can reach in.
# Makes target/HivePhone.ipa, unsigned (SideStore or the owner's Apple developer team signs it). Packaging follows
# OpenMinis/iCTRL (Apache-2.0) so it starts from its icon while the phone's developer disk image is mounted.
set -e
cd "$(dirname "$0")/../.."
wda=target/WebDriverAgent; out=target/HivePhone; app=$out/Payload/WebDriverAgentRunner-Runner.app
[ -d $wda ] || git clone -q --depth 1 --branch v16.14.2 https://github.com/appium/WebDriverAgent $wda
cp phone/ios/PhoneRelay.h $wda/WebDriverAgentRunner/
t=$wda/WebDriverAgentRunner/UITestingUITests.m
grep -q PhoneRelay $t || perl -0pi -e 's|(#import <XCTest/XCTest.h>)|$1\n#import "PhoneRelay.h"|; s|(\+ \(void\)setUp\n\{)|$1\n  setenv("USE_IP", "127.0.0.1", 1);\n  setenv("USE_PORT", "8100", 1);|; s|(  \[webServer startServing\];)|  PhoneRelay *relay = [PhoneRelay new];\n  [relay start];\n$1\n  [relay stop];|' $t
xcodebuild build-for-testing -project $wda/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -configuration Debug -quiet \
  -destination generic/platform=iOS -derivedDataPath $out/derived CODE_SIGNING_ALLOWED=NO ARCHS=arm64 DEBUG_INFORMATION_FORMAT=dwarf
rm -rf $out/Payload; mkdir -p $out/Payload
ditto $out/derived/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app $app
# XCTest comes from the phone's developer disk image, matched to its iOS.
find $app -name 'XC*.framework' -prune -o -name Testing.framework -prune -o -name 'libXCTestSwiftSupport.dylib' | grep -E 'Frameworks/(XC|Testing|libXCTest)' | xargs rm -rf
for p in $app/Info.plist $app/PlugIns/*.xctest/Info.plist; do plutil -replace CFBundleIdentifier -string app.hive.phone.xctrunner $p; done
plutil -replace CFBundleDisplayName -string "Hive Phone" $app/Info.plist
sips -z 120 120 dashboard/icon.png --out $app/AppIcon60x60@2x.png > /dev/null; cp dashboard/icon.png $app/AppIcon60x60@3x.png
plutil -replace CFBundleIcons -json '{"CFBundlePrimaryIcon":{"CFBundleIconFiles":["AppIcon60x60"]}}' $app/Info.plist
find $app -name '*.framework' -o -name '*.xctest' -o -name '*.dylib' | sort -r | xargs -I{} codesign -f -s - --timestamp=none {} 2> /dev/null
codesign -f -s - --timestamp=none $app
(cd $out && rm -f ../HivePhone.ipa && zip -qry ../HivePhone.ipa Payload) && echo target/HivePhone.ipa
