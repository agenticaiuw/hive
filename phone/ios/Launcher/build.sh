#!/bin/sh
# Compile the initial executable independently from the XCTest test bundle, against
# HiveApp.framework, which build.sh's xcodebuild makes.
set -eu
cd "$(dirname "$0")/../../.."
archive=${CARGO_TARGET_DIR:-target/phone-launcher}/aarch64-apple-ios/release/libhive_phone_launcher.a
products=target/HivePhone/derived/Build/Products/Debug-iphoneos
out=target/HivePhone/HiveLauncher
mkdir -p "$(dirname "$out")"
xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=18.0 -fobjc-arc -fmodules -F "$products" -framework HiveApp \
  -framework UIKit -framework Foundation -framework CoreFoundation -framework NetworkExtension \
  -framework Security -framework SystemConfiguration -lresolv -lc++ \
  -Wl,-rpath,@executable_path/Frameworks \
  -Wl,-rpath,/System/Developer/Library/Frameworks \
  -Wl,-rpath,/System/Developer/Library/PrivateFrameworks \
  -Wl,-rpath,/System/Developer/usr/lib \
  -Wl,-rpath,/Developer/Library/Frameworks \
  -Wl,-rpath,/Developer/Library/PrivateFrameworks -Wl,-rpath,/Developer/usr/lib \
  phone/ios/Launcher/Main.m phone/ios/Launcher/Mount.m "$archive" -o "$out"
if otool -L "$out" "$products/HiveApp.framework/HiveApp" | grep -q XCTest; then
  echo "The launcher links XCTest before the developer image can be mounted" >&2
  exit 1
fi
