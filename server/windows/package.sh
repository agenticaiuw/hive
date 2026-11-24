#!/bin/sh
# Hive Server for Windows: what people download (hive-server-windows.exe). Windows runs a plain .exe, so packaging is
# naming the build for the release, as server/mac/bundle.sh does for the Mac app.
# Usage: server/windows/package.sh [out folder, default out]
set -e
cd "$(dirname "$0")/../.."
mkdir -p "${1:-out}" && cp target/release/hive-server.exe "${1:-out}/hive-server-windows.exe"
