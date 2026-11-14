#!/bin/bash
# Build Hive.app's main executable (agent-unified-host) from workspace-engine/, in a copy under
# build/ so SwiftPM's .build stays out of the source tree.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
source_dir="$root/build/workspace-engine"
mkdir -p "$source_dir"
rsync -a --delete --exclude .build "$root/workspace-engine/" "$source_dir/"
swift build --package-path "$source_dir" --product agent-unified-host
cp "$source_dir/.build/debug/agent-unified-host" build/agent-unified-host.tmp
mv build/agent-unified-host.tmp build/agent-unified-host
