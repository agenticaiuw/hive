#!/bin/bash
# Build the workspace engine maintained in this repository inside Agent.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
source_dir="$root/build/agent-workspace-engine"
mkdir -p "$source_dir/Sources" "$source_dir/Tests"
rsync -a --delete "$root/workspace-engine/Sources/" "$source_dir/Sources/"
rsync -a --delete "$root/workspace-engine/Tests/" "$source_dir/Tests/"
cp "$root/workspace-engine/Package.swift" "$root/workspace-engine/LICENSE" "$source_dir/"
swift build --package-path "$source_dir" --product spaceo
swift build --package-path "$source_dir" --product agent-unified-host
mkdir -p "$root/build/spaceo-candidate"
cp "$source_dir/.build/debug/spaceo" "$root/build/spaceo-candidate/spaceo"
cp "$source_dir/.build/debug/agent-unified-host" "$root/build/spaceo-candidate/agent-unified-host"
tools/sign.sh "$root/build/spaceo-candidate/spaceo" local.personal-agent.Agent
cp "$source_dir/LICENSE" "$root/build/spaceo-candidate/LICENSE"
echo 'Agent workspace engine built; no display or input session was started.'
