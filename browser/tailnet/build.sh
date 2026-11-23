#!/bin/sh
# Builds tailnet.wasm and copies Go's wasm_exec.js beside it. Neither is committed: release.yml runs this before the
# extension is zipped and before the Mac app takes it in.
set -e
cd "$(dirname "$0")"
GOOS=js GOARCH=wasm go build -tags "$(go run tags.go)" -trimpath -ldflags "-s -w" -o tailnet.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .
