#!/bin/bash
# SpaceO's recovery command checks owner exclusion, display inventory and host health;
# it refuses to clear the latch if any prerequisite is not satisfied.
set -euo pipefail
cd "$(dirname "$0")/.."
engine="$PWD/build/spaceo-candidate/spaceo"
if [ ! -x "$engine" ]; then
  echo 'Build the workspace candidate first: bash scripts/build-spaceo.sh' >&2
  exit 1
fi
"$engine" safety clear-host-health --operator
"$engine" doctor
