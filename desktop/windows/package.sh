#!/bin/sh
# The Hive app for Windows: what people download (hive-windows.exe). Windows runs a plain .exe, so packaging is naming
# the build for the release, as desktop/mac/bundle.sh does for the Mac app.
# Usage: desktop/windows/package.sh [out folder, default out]
set -e
cd "$(dirname "$0")/../.."
mkdir -p "${1:-out}" && cp target/release/hive.exe "${1:-out}/hive-windows.exe"
