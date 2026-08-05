#!/bin/bash
# Rebuild cloud-relay/wasm/libopus.wasm from the SAME vendored libopus the
# firmware uses. Requires emscripten (brew install emscripten) and cmake.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OPUS_SRC="$REPO/firmware/nrf9160/third_party/opus"
OUT_DIR="$REPO/software/ai-pendant-simulator/cloud-relay/wasm"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cd "$BUILD"
emcmake cmake "$OPUS_SRC" -DOPUS_FIXED_POINT=ON -DOPUS_ENABLE_FLOAT_API=OFF \
  -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_STACK_PROTECTOR=OFF \
  -DCMAKE_BUILD_TYPE=Release
emmake make -j8 opus
emcc "$OUT_DIR/opus_wrapper.c" libopus.a -I "$OPUS_SRC/include" -O2 \
  -DFIXED_POINT=1 --no-entry -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=4194304 -sSTANDALONE_WASM=1 \
  -o "$OUT_DIR/libopus.wasm"
echo "Rebuilt $OUT_DIR/libopus.wasm"
