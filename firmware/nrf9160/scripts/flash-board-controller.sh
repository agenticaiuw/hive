#!/usr/bin/env bash
#
# Build and flash the nRF9160 DK's BOARD CONTROLLER (the on-board nRF52840).
#
#   ./firmware/nrf9160/scripts/flash-board-controller.sh --build
#   ./firmware/nrf9160/scripts/flash-board-controller.sh --verify
#   ./firmware/nrf9160/scripts/flash-board-controller.sh          # wait + flash
#
# ============================================================================
# WHEN DO I NEED TO RUN THIS?  (2026-08-13)
# ============================================================================
# The moment EITHER of these is physically wired to the breadboard:
#
#   * the ESP32 command UART  — jumpers on nRF9160 P0.00 (TX) and P0.05 (RX)
#   * the RGB status LED      — legs on nRF9160 P0.03 / P0.04 / P0.07
#
# and NOT before.  Those five pins are the only ones this image frees, so
# with none of them wired the flash changes nothing observable.  It was built
# and verified on 2026-08-13 but deliberately NOT flashed, because the owner
# had run out of jumper wires and resistors and both the UART jumpers and the
# RGB LED were off the bench.  The image is ready; it is waiting on hardware,
# not on software.
#
# The symptom that means you needed this and skipped it: you wire the ESP32
# UART, the ESP32 is provably transmitting, and the nRF9160 still receives
# nothing on uart1 — because the DK's analog switches are still handing
# P0.00/P0.05 to the interface MCU.  For the LED the symptom is a red-only
# indicator with a dead-looking green and blue, because DK LED2/LED3 sit in
# parallel with those legs and steal their current.
#
# THE PROCEDURE, end to end.  Only step 2 and step 4 need a human, and both
# are the same slide switch:
#
#   1. ./scripts/flash-board-controller.sh --build     (once; already done)
#   2. Slide SW10 (PROG/DEBUG, next to the USB socket) to nRF52.
#   3. ./scripts/flash-board-controller.sh             (polls, then flashes)
#   4. When it says "board controller programmed", slide SW10 back to nRF91.
#   5. It reflashes the application by itself and exits.
#
# Steps 3-5 are one command: it polls the probe every 3 s and drives both
# flashes hands-free, so the only human actions are the two switch flips.
# SW10 cannot be moved in software — it mechanically muxes the J-Link's SWD
# lines between the two chips.
#
# IS THIS SAFE?  Yes, and the scary-sounding part is a misconception worth
# killing: the nRF52840 is the BOARD CONTROLLER, not the debugger.  The
# debugger is a separate SEGGER J-Link OB interface MCU — the Zephyr board
# docs describe the board controller as routing nRF9160 pins *to* "the VCOMx
# of the interface MCU", i.e. a different chip, and SW10's very existence
# proves the probe is a third device.  Programming the nRF52840 therefore
# cannot cost you the debug link.  Also checked: CONFIG_NRF_APPROTECT_LOCK is
# NOT set, so the image cannot lock the chip out of debug; and
# vcom0_pins_routing stays ENABLED, so the console survives.  Worst case a
# bad image leaves the switches undriven — you lose the routing and nothing
# else, and SW10 + reflash always recovers.
#
# WHAT IT COSTS, stated plainly: DK LED2, LED3 and Button 2 stop working, and
# VCOM2 stops carrying nRF9160 pins.  The firmware uses none of them (LED1 on
# P0.02 is its only on-board indicator, every button it reads is external).
# ============================================================================
#
# WHAT THIS IS FOR.  The nRF9160's pins do not reach the edge connector
# directly: a bank of analog switches on the DK decides whether each one goes
# to the header or to an on-board part (an LED, a button, a VCOM line).  Those
# switches are held by the nRF52840, whose ONLY job in this project is to run
# board.c and set them.  With the stock image the switches are closed, so
# P0.03/P0.04/P0.07 sit in parallel with DK LED2, LED3 and Button 2 — every
# on-board part steals current from the breadboard LED leg wired to the same
# pin, and the RGB indicator reads as dark.  The fix is not in the app: it is
# this image, built with boards/nrf9160dk_nrf52840.overlay.
#
# THE RECIPE.  There is no separate "board controller sample" to build.  The
# board controller IS boards/nordic/nrf9160dk/board.c, and Zephyr links it
# into ANY application built for the nrf9160dk/nrf52840 target — the routing
# it applies comes entirely from devicetree.  So the image is the smallest
# app in the tree (zephyr/samples/hello_world) plus our overlay, which is
# exactly what the Zephyr board documentation uses.
#
# THE ONE PHYSICAL STEP.  The DK's J-Link talks to one core at a time, chosen
# by the PROG/DEBUG slide switch (SW10) next to the USB socket.  Nothing in
# software can move it.  This script therefore WAITS for it rather than
# guessing, and refuses to program unless the probe reports an nRF52 — the
# guard that stops a board-controller image from ever landing on the nRF9160.
#
# Sequence the script drives, hands-free once you start flipping:
#   1. SW10 -> nRF52 : flashes the board controller
#   2. SW10 -> nRF91 : flashes the application image back
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FW_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=env.sh
source "${SCRIPT_DIR}/env.sh" -q

DEV_ID="${DEV_ID:-960036581}"
BC_BUILD="${BC_BUILD:-${FW_DIR}/build-bc52840}"
APP_BUILD="${APP_BUILD:-${FW_DIR}/build-app-current}"
BC_SRC="${NCS_SDK_DIR}/zephyr/samples/hello_world"
BC_OVERLAY="${FW_DIR}/boards/nrf9160dk_nrf52840.overlay"
BOARD="nrf9160dk@0.14.0/nrf52840"
WAIT_SECS="${WAIT_SECS:-900}"

# Every routing this project needs OPEN.  Verified against the generated
# devicetree before a single byte is programmed, because a silently-dropped
# overlay produces an image that looks fine and changes nothing.
REQUIRED_DISABLED=(
	vcom2_pins_routing   # P0.00/P0.01 - module UART TX, and the PDM pins
	led4_pin_routing     # P0.05 - module UART RX
	led2_pin_routing     # P0.03 - RGB red
	led3_pin_routing     # P0.04 - RGB green
	button2_pin_routing  # P0.07 - RGB blue
)

probe_core() {
	nrfutil device device-info --serial-number "${DEV_ID}" 2>/dev/null |
		sed -n 's/.*deviceName: *//p' | head -1
}

do_build() {
	echo "=== building board controller (${BOARD}) ==="
	cd "${NCS_SDK_DIR}"
	west build -b "${BOARD}" -d "${BC_BUILD}" "${BC_SRC}" \
		-- -DEXTRA_DTC_OVERLAY_FILE="${BC_OVERLAY}"
}

do_verify() {
	local dts="${BC_BUILD}/hello_world/zephyr/zephyr.dts"
	local rc=0

	[[ -f "$dts" ]] || dts="${BC_BUILD}/zephyr/zephyr.dts"
	if [[ ! -f "$dts" ]]; then
		echo "ERROR: no generated devicetree; run --build first." >&2
		return 1
	fi

	echo "=== routing check (${dts}) ==="
	for node in "${REQUIRED_DISABLED[@]}"; do
		# The label line, then the first status line that follows it.
		local status
		status="$(awk -v n="${node}:" '
			$0 ~ n {found=1}
			found && /status = /{
				gsub(/.*status = "|".*/, "");
				print; exit
			}' "$dts")"
		if [[ "$status" == "disabled" ]]; then
			printf '  %-24s disabled  OK\n' "$node"
		else
			printf '  %-24s %-9s NOT DISABLED\n' "$node" "${status:-missing}"
			rc=1
		fi
	done
	if [[ $rc -ne 0 ]]; then
		echo "ERROR: overlay did not take effect; refusing to flash." >&2
	fi
	return $rc
}

# Block until the probe reports the requested core, or give up.  Polls rather
# than prompting so the owner's only action is the switch itself.
wait_for_core() {
	local want="$1" waited=0 seen

	seen="$(probe_core)"
	if [[ "$seen" == "$want"* ]]; then
		echo "=== probe already on ${want} ==="
		return 0
	fi
	echo "=== waiting for PROG/DEBUG (SW10) -> ${want}; probe currently sees ${seen:-nothing} ==="
	while [[ $waited -lt $WAIT_SECS ]]; do
		sleep 3
		waited=$((waited + 3))
		seen="$(probe_core)"
		if [[ "$seen" == "$want"* ]]; then
			echo "=== probe now on ${seen} after ${waited}s ==="
			return 0
		fi
	done
	echo "ERROR: still on '${seen:-nothing}' after ${WAIT_SECS}s." >&2
	return 1
}

case "${1:-}" in
	--build)
		do_build
		do_verify
		exit $?
		;;
	--verify)
		do_verify
		exit $?
		;;
	-h|--help)
		# Print the whole header block, however long it grows, rather
		# than a hardcoded line range that silently truncates it.
		awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
		exit 0
		;;
esac

do_verify

wait_for_core "nRF52"
echo "=== flashing board controller ==="
cd "${NCS_SDK_DIR}"
west flash --skip-rebuild -d "${BC_BUILD}" --runner jlink --dev-id "${DEV_ID}" --erase
echo "=== board controller programmed ==="

if [[ -d "${APP_BUILD}" ]]; then
	wait_for_core "nRF9160"
	echo "=== reflashing application core from ${APP_BUILD} ==="
	cd "${NCS_SDK_DIR}"
	west flash --skip-rebuild -d "${APP_BUILD}" --runner jlink --dev-id "${DEV_ID}"
	echo "=== application programmed ==="
else
	echo "NOTE: ${APP_BUILD} missing; application core left as-is." >&2
fi
