#!/bin/sh
# Compile the initial executable independently from the XCTest test bundle.
set -eu
cd "$(dirname "$0")/../../.."
archive=${CARGO_TARGET_DIR:-target/phone-bootstrap}/aarch64-apple-ios/release/libhive_phone_bootstrap.a
out=target/HivePhone/HiveBootstrap
mkdir -p "$(dirname "$out")"
xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=18.0 -fobjc-arc \
  -framework UIKit -framework Foundation -framework NetworkExtension \
  -framework Security -framework SystemConfiguration -lresolv -lc++ \
  -Wl,-rpath,@executable_path/Frameworks \
  -Wl,-rpath,/System/Developer/Library/Frameworks \
  -Wl,-rpath,/System/Developer/Library/PrivateFrameworks \
  -Wl,-rpath,/System/Developer/usr/lib \
  -Wl,-rpath,/Developer/Library/Frameworks \
  -Wl,-rpath,/Developer/Library/PrivateFrameworks -Wl,-rpath,/Developer/usr/lib \
  phone/ios/Bootstrap/Main.m phone/ios/Bootstrap/Mount.m "$archive" -o "$out"
if otool -L "$out" | grep -q XCTest; then
  echo "Bootstrap links XCTest before the developer image can be mounted" >&2
  exit 1
fi
