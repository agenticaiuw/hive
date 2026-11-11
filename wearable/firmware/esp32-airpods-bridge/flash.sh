#!/usr/bin/env bash
# Build/upload HUZZAH32 (ESP32) AirPods bridge firmware via PlatformIO.
#
# Usage:
#   ./firmware/esp32-airpods-bridge/flash.sh --check   # list port + chip (no write)
#   ./firmware/esp32-airpods-bridge/flash.sh           # pio run --target upload
#   PORT=/dev/cu.usbserial-XXXX ./firmware/esp32-airpods-bridge/flash.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIO="${ROOT}/.venv/bin/pio"
ESPTOOL="${HOME}/.platformio/penv/bin/esptool"
# CP2104 on Adafruit Feather HUZZAH32 (observed on this machine).
PORT="${PORT:-/dev/cu.usbserial-0287A9CA}"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--check|-n|--dry-run) CHECK_ONLY=1; shift ;;
		--port) PORT="${2:?}"; shift 2 ;;
		-h|--help) sed -n '2,10p' "$0"; exit 0 ;;
		*) echo "Unknown arg: $1" >&2; exit 2 ;;
	esac
done

if [[ ! -x "$PIO" ]]; then
	echo "PlatformIO missing at $PIO" >&2
	echo "Create the project venv: python3.13 -m venv .venv && .venv/bin/pip install platformio" >&2
	exit 1
fi

echo "=== pio: $($PIO --version) ==="
echo "=== ports ==="
"$PIO" device list

if [[ ! -e "$PORT" ]]; then
	echo "WARN: default PORT $PORT not present; set PORT= to the CP2104 device." >&2
fi

if [[ -x "$ESPTOOL" && -e "$PORT" ]]; then
	echo "=== esptool chip detect (read-only) on $PORT ==="
	"$ESPTOOL" --port "$PORT" chip-id || true
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
	echo "=== --check OK (not uploading) ==="
	echo "Upload command:"
	echo "  cd $ROOT && .venv/bin/pio run --target upload --upload-port $PORT"
	exit 0
fi

cd "$ROOT"
"$PIO" run --target upload --upload-port "$PORT"
echo "=== upload complete ==="
