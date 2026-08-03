#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/tests/host/pcm_tx_ring_test.c"
BIN="${TMPDIR:-/tmp}/pcm_tx_ring_test_$$"
cc -std=c11 -Wall -Wextra -O2 -I"$ROOT/src" "$SRC" -o "$BIN"
"$BIN"
rm -f "$BIN"
