#
# Copyright (c) 2025 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
#

cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(blinky)

#
# libopus 1.6.1 is vendored from the official Xiph.Org release.  Its normal
# top-level CMake project changes global compiler settings, so consume the
# official source manifests directly and inherit Zephyr's Cortex-M33 flags.
#
set(OPUS_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/third_party/opus)
include(${OPUS_ROOT}/cmake/OpusFunctions.cmake)
get_opus_sources(SILK_SOURCES ${OPUS_ROOT}/silk_sources.mk opus_silk_sources)
get_opus_sources(SILK_SOURCES_FIXED ${OPUS_ROOT}/silk_sources.mk opus_silk_fixed_sources)
get_opus_sources(CELT_SOURCES ${OPUS_ROOT}/celt_sources.mk opus_celt_sources)
get_opus_sources(OPUS_SOURCES ${OPUS_ROOT}/opus_sources.mk opus_sources)
get_opus_sources(OPUS_SOURCES_FLOAT ${OPUS_ROOT}/opus_sources.mk opus_float_sources)
foreach(opus_source_list
    opus_silk_sources
    opus_silk_fixed_sources
    opus_celt_sources
    opus_sources
    opus_float_sources)
  list(TRANSFORM ${opus_source_list} PREPEND "${OPUS_ROOT}/")
endforeach()

add_library(opus STATIC
  ${opus_silk_sources}
  ${opus_silk_fixed_sources}
  ${opus_celt_sources}
  ${opus_sources}
  ${opus_float_sources}
)
target_include_directories(opus PUBLIC ${OPUS_ROOT}/include)
target_include_directories(opus PRIVATE
  ${OPUS_ROOT}
  ${OPUS_ROOT}/celt
  ${OPUS_ROOT}/silk
  ${OPUS_ROOT}/silk/fixed
)
# Xiph OpusFAQ: on limited embedded, NONTHREADSAFE_PSEUDOSTACK moves SILK
# temps off the call stack into a fixed buffer (pendant_opus_scratch).
# GLOBAL_STACK_SIZE must match PENDANT_OPUS_SCRATCH_BYTES in audio_opus.h.
# Not thread-safe: only main thread may call opus_encode/decode.
target_compile_definitions(opus PRIVATE
  OPUS_BUILD
  FIXED_POINT=1
  DISABLE_FLOAT_API
  DISABLE_DEBUG_FLOAT
  ENABLE_HARDENING
  NONTHREADSAFE_PSEUDOSTACK
  GLOBAL_STACK_SIZE=28672
)
#
# Opus is the CPU budget on this device: the downlink decode and the uplink
# encode run concurrently on one 64 MHz core, and the achievable audio
# sample rate follows directly from how fast they are.
#
# -O3 rather than Zephyr's default -Os: this is DSP code in tight loops, and
# size is not the binding constraint (flash is ~54% used).
#
# The Cortex-M33 implements the ARM DSP extension, so libopus's ARMv5E
# integer paths (SMULWB/SMLABB and friends in celt/arm/fixed_armv5e.h and
# silk/arm/SigProc_FIX_armv5e.h) apply. They are header-only inline asm — no
# NEON, no .s files, nothing that needs runtime CPU detection.
#
#
# -O3 must be applied as a SOURCE property, not a target option: Zephyr's
# zephyr_interface appends its own -Os after any target-level flags, and the
# last -O wins. Verified via compile_commands.json — the target-level form
# produced "-O3 -Os" and silently kept building for size.
#
target_compile_options(opus PRIVATE -fstack-usage)
set_source_files_properties(
  ${opus_silk_sources}
  ${opus_silk_fixed_sources}
  ${opus_celt_sources}
  ${opus_sources}
  ${opus_float_sources}
  TARGET_DIRECTORY opus
  PROPERTIES COMPILE_OPTIONS "-O3"
)
target_compile_definitions(opus PRIVATE
  OPUS_ARM_ASM
  OPUS_ARM_INLINE_ASM
  OPUS_ARM_INLINE_EDSP
)
target_link_libraries(opus PRIVATE zephyr_interface)

target_sources(app PRIVATE
  src/main.c
  src/audio_opus.c
  src/pendant_cloud.c
  src/pendant_ws.c
  src/pendant_store.c
)
target_compile_options(app PRIVATE -fstack-usage)

target_link_libraries(app PRIVATE opus)

generate_inc_file_for_target(
  app
  cert/globalsign_root_ca.pem
  ${ZEPHYR_BINARY_DIR}/include/generated/globalsign_root_ca.pem.inc
)
