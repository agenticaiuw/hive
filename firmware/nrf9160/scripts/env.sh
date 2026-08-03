#!/usr/bin/env bash
# Source this file to put the Nordic Connect SDK (NCS) flash/build tools on PATH.
#
#   source firmware/nrf9160/scripts/env.sh
#
# Tools expected (already installed on this Mac under /opt/nordic):
#   west, nrfutil, arm-zephyr-eabi-*, cmake, ninja
# Host tools also used: JLinkExe (/usr/local/bin)
#
# nrfjprog is NOT required — default west flash runner is nrfutil; jlink works too.

# Allow re-sourcing without stacking PATH forever.
if [[ -n "${_PENDANT_NCS_ENV_LOADED:-}" ]]; then
	return 0 2>/dev/null || exit 0
fi

NCS_ROOT="${NCS_ROOT:-/opt/nordic/ncs}"
NCS_VERSION="${NCS_VERSION:-v3.4.0}"
# Hash directory name from nRF Connect toolchain install (see toolchains/).
NCS_TOOLCHAIN="${NCS_TOOLCHAIN:-ccc010f809}"

TOOLCHAIN_DIR="${NCS_ROOT}/toolchains/${NCS_TOOLCHAIN}"
SDK_DIR="${NCS_ROOT}/${NCS_VERSION}"

if [[ ! -d "$TOOLCHAIN_DIR" ]]; then
	echo "NCS toolchain not found at: $TOOLCHAIN_DIR" >&2
	echo "Install nRF Connect SDK / toolchain via nRF Connect for Desktop." >&2
	return 1 2>/dev/null || exit 1
fi

if [[ ! -d "$SDK_DIR/zephyr" ]]; then
	echo "NCS SDK not found at: $SDK_DIR" >&2
	return 1 2>/dev/null || exit 1
fi

export PATH="${TOOLCHAIN_DIR}/bin:${TOOLCHAIN_DIR}/usr/bin:${TOOLCHAIN_DIR}/nrfutil/bin:${PATH}"
export ZEPHYR_BASE="${SDK_DIR}/zephyr"
# environment.json uses zephyr/gnu; docs historically used "zephyr" — both work with this SDK layout.
export ZEPHYR_TOOLCHAIN_VARIANT="${ZEPHYR_TOOLCHAIN_VARIANT:-zephyr}"
export ZEPHYR_SDK_INSTALL_DIR="${TOOLCHAIN_DIR}/opt/zephyr-sdk"
export NRFUTIL_HOME="${TOOLCHAIN_DIR}/nrfutil/home"
export NCS_SDK_DIR="${SDK_DIR}"

# west workspace root for this NCS install (manifest in nrf/)
export WEST_TOPDIR="${SDK_DIR}"

_PENDANT_NCS_ENV_LOADED=1

if [[ "${1:-}" == "-q" || "${1:-}" == "--quiet" ]]; then
	return 0 2>/dev/null || exit 0
fi

echo "NCS env ready:"
echo "  west      → $(command -v west 2>/dev/null || echo MISSING)"
echo "  nrfutil   → $(command -v nrfutil 2>/dev/null || echo MISSING)"
echo "  JLinkExe  → $(command -v JLinkExe 2>/dev/null || echo MISSING)"
echo "  ZEPHYR_BASE=$ZEPHYR_BASE"
echo "  toolchain=$TOOLCHAIN_DIR"
