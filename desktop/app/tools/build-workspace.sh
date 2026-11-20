#!/bin/bash
# Build Hive.app's main executable (agent-unified-host) and its virtual workspace engine
# (workspace-engine, which goes in Contents/Helpers) from workspace-engine/, in a copy under
# build/swift so SwiftPM's .build stays out of the source tree.
#
#   tools/build-workspace.sh                  the development build (debug) into build/
#   tools/build-workspace.sh --release <dir>  the download's (tools/release.sh): optimized, into <dir>,
#                                             without the debugging symbols, which name the build
#                                             folder in the home folder (cloud/shared/ownerDetails.mjs)
set -euo pipefail
config=debug
out=build
if [ "${1:-}" = --release ]; then config=release; out=${2:?usage: build-workspace.sh --release <dir>}; fi
cd "$(dirname "$0")/.."
root="$PWD"
source_dir="$root/build/swift"
# Earlier builds kept the copy at build/workspace-engine, where the engine itself goes now. (A
# moved .build doesn't work: SwiftPM's module cache records its absolute path.)
if [ -f build/workspace-engine/Package.swift ]; then rm -rf build/workspace-engine; fi
mkdir -p "$source_dir"
rsync -a --delete --exclude .build "$root/workspace-engine/" "$source_dir/"
for product in agent-unified-host workspace-engine; do
  swift build --package-path "$source_dir" --configuration "$config" --product "$product"
done
mkdir -p "$out"
for product in agent-unified-host workspace-engine; do
  cp "$source_dir/.build/$config/$product" "$out/$product.tmp"
  if [ "$config" = release ]; then strip -S "$out/$product.tmp"; fi
  mv "$out/$product.tmp" "$out/$product"
done
