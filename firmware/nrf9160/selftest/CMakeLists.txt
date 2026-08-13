#
# Bench self-test for the pendant breadboard.
#
# A SEPARATE Zephyr application, not a Kconfig branch of the pendant app,
# and deliberately so: the pendant brings up LTE, TF-M crypto, Opus and a
# WebSocket before it ever touches a wire, and every one of those is a way
# for a wiring answer to come back "failed" for a reason that has nothing
# to do with wiring. This app links none of them. What it reports about a
# pin is about that pin.
#
# Build it against its own -d directory so it never collides with the
# application build dirs (build-*):
#
#   west build -b nrf9160dk/nrf9160/ns \
#     -d firmware/nrf9160/build-selftest firmware/nrf9160/selftest --pristine
#
# Flash and read at 115200 on the DK's VCOM0 (/dev/cu.usbmodem*1 on this
# Mac) — see selftest/README.txt for the whole bench procedure.
#
cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(pendant_selftest)

target_sources(app PRIVATE src/main.c)
