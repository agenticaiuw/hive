#!/usr/bin/env bash
# Flash pendant firmware to the nRF9160 DK (PCA10090).
#
# Usage:
#   ./firmware/nrf9160/scripts/flash.sh              # flash build-cloud via nrfutil
#   ./firmware/nrf9160/scripts/flash.sh --check       # probe + tools only (no program)
#   ./firmware/nrf9160/scripts/flash.sh --runner jlink
#   BUILD_DIR=build-rawstream ./firmware/nrf9160/scripts/flash.sh
#   DEV_ID=960036581 ./firmware/nrf9160/scripts/flash.sh
#
# Does not flash unless --check is omitted. Prefer --check first on a new machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FW_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=env.sh
source "${SCRIPT_DIR}/env.sh" -q

BUILD_NAME="${BUILD_DIR:-build-cloud}"
# Allow absolute path or name under firmware/nrf9160
if [[ "$BUILD_NAME" = /* ]]; then
	BUILD_PATH="$BUILD_NAME"
else
	BUILD_PATH="${FW_DIR}/${BUILD_NAME}"
fi

# Documented DK onboard J-Link serial (also appears in dual-capture UART paths).
DEV_ID="${DEV_ID:-960036581}"
# Default runner from runners.yaml is nrfutil; jlink is the documented alternate.
RUNNER="${RUNNER:-nrfutil}"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--check|-n|--dry-run)
			CHECK_ONLY=1
			shift
			;;
		--runner)
			RUNNER="${2:?}"
			shift 2
			;;
		--dev-id)
			DEV_ID="${2:?}"
			shift 2
			;;
		--build-dir|-d)
			BUILD_PATH="${2:?}"
			shift 2
			;;
		-h|--help)
			sed -n '2,14p' "$0"
			exit 0
			;;
		*)
			echo "Unknown arg: $1" >&2
			exit 2
			;;
	esac
done

echo "=== tool check ==="
need() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "MISSING: $1" >&2
		exit 1
	fi
	echo "  $1: $(command -v "$1")"
}
need west
need nrfutil
need JLinkExe

echo "=== probe check (serial ${DEV_ID}) ==="
if ! nrfutil device list 2>/dev/null | grep -q "${DEV_ID}"; then
	echo "ERROR: J-Link serial ${DEV_ID} not seen by nrfutil device list." >&2
	echo "Plug the nRF9160 DK USB cable and re-run." >&2
	nrfutil device list 2>&1 || true
	exit 1
fi
nrfutil device device-info --serial-number "${DEV_ID}" 2>&1 | head -20

HEX="${BUILD_PATH}/nrf9160/zephyr/tfm_merged.hex"
# Non-sysbuild layouts put hex under zephyr/ directly
if [[ ! -f "$HEX" ]]; then
	HEX="${BUILD_PATH}/zephyr/tfm_merged.hex"
fi
if [[ ! -f "$HEX" ]]; then
	HEX="${BUILD_PATH}/zephyr/zephyr.hex"
fi

echo "=== build dir ==="
echo "  path: ${BUILD_PATH}"
if [[ ! -d "$BUILD_PATH" ]]; then
	echo "ERROR: build directory missing: $BUILD_PATH" >&2
	echo "Build first, e.g.:" >&2
	echo "  source ${SCRIPT_DIR}/env.sh" >&2
	echo "  cd ${NCS_SDK_DIR:-/opt/nordic/ncs/v3.4.0}" >&2
	echo "  west build -b nrf9160dk/nrf9160/ns -d ${FW_DIR}/build-cloud ${FW_DIR} -- -DEXTRA_CONF_FILE=${FW_DIR}/secrets.conf" >&2
	exit 1
fi
if [[ -f "$HEX" ]]; then
	echo "  hex:  $HEX ($(wc -c <"$HEX" | tr -d ' ') bytes)"
else
	echo "  hex:  (not found yet — west flash will rebuild)"
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
	echo "=== --check OK (not flashing) ==="
	echo "Flash command that would run:"
	echo "  west flash -d ${BUILD_PATH} --runner ${RUNNER} --dev-id ${DEV_ID}"
	exit 0
fi

echo "=== flashing with runner=${RUNNER} dev-id=${DEV_ID} ==="
# Run west from NCS workspace so extensions resolve; -d points at app build.
cd "${NCS_SDK_DIR:-/opt/nordic/ncs/v3.4.0}"
west flash -d "${BUILD_PATH}" --runner "${RUNNER}" --dev-id "${DEV_ID}"
echo "=== flash complete ==="
