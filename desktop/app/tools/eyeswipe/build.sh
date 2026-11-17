#!/bin/sh
# Builds Hive's eye keyboard for the Mac (build/hive-eye-keyboard, with its language model beside it) and the
# accuracy simulator (build/eyeswipe-sim). The iPhone app builds EyeSwipe.swift and eyeswipe-lm.bin itself.
set -e
cd "$(dirname "$0")/../.."
mkdir -p build
swiftc -O -parse-as-library tools/eyeswipe/EyeSwipe.swift tools/eyeswipe/keyboard.swift -o build/hive-eye-keyboard.tmp
mv build/hive-eye-keyboard.tmp build/hive-eye-keyboard
swiftc -O -parse-as-library tools/eyeswipe/EyeSwipe.swift tools/eyeswipe/sim.swift -o build/eyeswipe-sim.tmp
mv build/eyeswipe-sim.tmp build/eyeswipe-sim
cp tools/eyeswipe/eyeswipe-lm.bin build/eyeswipe-lm.bin
