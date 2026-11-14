#!/bin/bash
# Build Hive.app's main executable (agent-unified-host) and its virtual workspace engine
# (workspace-engine, which goes in Contents/Helpers) from workspace-engine/, in a copy under
# build/swift so SwiftPM's .build stays out of the source tree.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
source_dir="$root/build/swift"
# Earlier builds kept the copy at build/workspace-engine, where the engine itself goes now. (A
# moved .build doesn't work: SwiftPM's module cache records its absolute path.)
if [ -f build/workspace-engine/Package.swift ]; then rm -rf build/workspace-engine; fi
mkdir -p "$source_dir"
rsync -a --delete --exclude .build "$root/workspace-engine/" "$source_dir/"
for product in agent-unified-host workspace-engine; do
  swift build --package-path "$source_dir" --product "$product"
done
for product in agent-unified-host workspace-engine; do
  cp "$source_dir/.build/debug/$product" "build/$product.tmp"
  mv "build/$product.tmp" "build/$product"
done
