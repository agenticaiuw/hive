#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "${TEST_DIR}/../../src" && pwd)"
BINARY="${TMPDIR:-/tmp}/pendant-audio-opus-math-test"

"${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
	-I"${SOURCE_DIR}" "${TEST_DIR}/audio_opus_math_test.c" -o "$BINARY"
"$BINARY"
