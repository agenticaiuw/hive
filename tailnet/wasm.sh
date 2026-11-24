#!/bin/sh
# Builds the browser extension's Tailscale (wasm.go) into browser/tailnet/: tailnet.wasm, with Go's wasm_exec.js beside it,
# where ../browser/tailnet.js loads them. Neither is committed: release.yml runs this before the extension is zipped and
# before the Mac app takes in browser/.
set -e
cd "$(dirname "$0")"
out=../browser/tailnet
mkdir -p $out
GOOS=js GOARCH=wasm go build -tags "$(go run tags.go)" -trimpath -ldflags "-s -w" -o $out/tailnet.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" $out/
