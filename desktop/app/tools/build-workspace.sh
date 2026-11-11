#!/bin/bash
# Build the maintained, attributed workspace source already in this repository.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build-spaceo.sh
cp build/spaceo-candidate/agent-unified-host build/agent-unified-host.tmp
mv build/agent-unified-host.tmp build/agent-unified-host
