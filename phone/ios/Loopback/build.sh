#!/bin/sh
# Build the device-local packet tunnel in CI. The app embeds it once both
# provisioning profiles authorize the Network Extension capability.
set -eu
cd "$(dirname "$0")/../../.."
archive=${CARGO_TARGET_DIR:-target/phone-launcher}/aarch64-apple-ios/release/libhive_phone_launcher.a
out=target/HivePhone/HiveLoopback.appex
mkdir -p "$out"
cp phone/ios/Loopback/Info.plist "$out/Info.plist"
xcrun --sdk iphoneos swiftc -target arm64-apple-ios18.0 \
  -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -parse-as-library \
  -emit-executable -module-name HiveLoopback -application-extension \
  -Xlinker -e -Xlinker _NSExtensionMain -Xlinker -dead_strip \
  -framework NetworkExtension -framework UIKit -framework Foundation \
  -framework Security -framework SystemConfiguration -lresolv -lc++ \
  phone/ios/Loopback/PacketTunnelProvider.swift "$archive" -o "$out/HiveLoopback"
codesign -f -s - --timestamp=none "$out"
