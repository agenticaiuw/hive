#!/usr/bin/env bash
# Capture the current firmware's UART console. No debugger or J-Link is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${ROOT}/diagnostics"
LOG="${PENDANT_UART_LOG:-${OUT}/pendant-uart.log}"
BAUD="${PENDANT_UART_BAUD:-115200}"
PORT="${PENDANT_UART_PORT:-}"
TRIGGER_AUDIO="${PENDANT_UART_TRIGGER_AUDIO:-}"
TRIGGER_MARKER="${PENDANT_UART_TRIGGER_MARKER:-I2S mic preallocated}"

mkdir -p "$OUT"

if [[ -z "$PORT" ]]; then
	shopt -s nullglob
	# Nordic DKs expose several CDC ACM interfaces; console is normally the
	# interface ending in 1 (for example ...65811), not the ...3 or ...5 ports.
	candidates=(/dev/cu.usbmodem*1)
	if (( ${#candidates[@]} == 0 )); then
		candidates=(/dev/cu.usbmodem*)
	fi
	if (( ${#candidates[@]} == 0 )); then
		echo "No /dev/cu.usbmodem device found." >&2
		echo "Set PENDANT_UART_PORT to the pendant's UART device." >&2
		exit 1
	fi
	PORT="${candidates[0]}"
fi

if [[ ! -e "$PORT" ]]; then
	echo "UART device does not exist: $PORT" >&2
	exit 1
fi

# Keep the CDC device open while applying termios. On macOS, closing the only
# descriptor and reopening it for tee can restore the port's default baud.
exec 3< "$PORT"
if ! stty "$BAUD" raw -echo -ixon -ixoff <&3 2>/dev/null; then
	echo "Could not configure $PORT at $BAUD baud." >&2
	exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
	echo "=== pendant UART capture start ${STAMP} ==="
	echo "port=${PORT} baud=${BAUD} log=${LOG}"
	echo "Press Ctrl-C to stop."
} | tee -a "$LOG"

trap 'exec 3<&-; echo "=== pendant UART capture stopped ===" | tee -a "$LOG"' EXIT
if [[ -z "$TRIGGER_AUDIO" ]]; then
	tee -a "$LOG" <&3
else
	triggered=0
	while IFS= read -r line <&3; do
		printf '%s\n' "$line"
		if (( triggered == 0 )) && [[ "$line" == *"$TRIGGER_MARKER"* ]]; then
			triggered=1
			/usr/bin/afplay "$TRIGGER_AUDIO" >/dev/null 2>&1 &
		fi
	done | tee -a "$LOG"
fi
