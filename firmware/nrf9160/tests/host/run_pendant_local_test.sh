#!/usr/bin/env bash
#
# Build and run the on-device command matcher against synthetic utterances.
#
# pendant_local.c is compiled verbatim — no #ifdef HOST paths in the shipping
# source — so the Zephyr surface it uses is supplied here as a handful of
# stub headers instead. If a future edit reaches for a kernel service that is
# not stubbed, this test fails to compile, which is the correct signal: the
# matcher is meant to be pure arithmetic over a buffer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/tests/host/pendant_local_test.c"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pendant_local_test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/zephyr/sys" "$WORK/zephyr/fs"

cat > "$WORK/zephyr/kernel.h" <<'EOF'
#ifndef HOST_STUB_KERNEL_H_
#define HOST_STUB_KERNEL_H_
#include <stdint.h>
#include <sys/types.h>
/* Cycle counter: the module only ever differences two reads, so a
 * monotonic counter is a faithful stand-in for measuring on the host. */
static inline uint32_t k_cycle_get_32(void)
{
	static uint32_t tick;
	return ++tick;
}
static inline uint32_t sys_clock_hw_cycles_per_sec(void) { return 32768U; }
#endif
EOF

cat > "$WORK/zephyr/sys/printk.h" <<'EOF'
#ifndef HOST_STUB_PRINTK_H_
#define HOST_STUB_PRINTK_H_
#include <stdio.h>
#define printk printf
#endif
EOF

cat > "$WORK/zephyr/sys/util.h" <<'EOF'
#ifndef HOST_STUB_UTIL_H_
#define HOST_STUB_UTIL_H_
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define CLAMP(v, lo, hi) MIN(MAX(v, lo), hi)
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#endif
EOF

# Filesystem stubs: persistence is exercised on hardware, not here. Every
# call fails cleanly so pendant_local_init() takes its "no keyword file"
# branch and local_save() reports and returns.
cat > "$WORK/zephyr/fs/fs.h" <<'EOF'
#ifndef HOST_STUB_FS_H_
#define HOST_STUB_FS_H_
#include <stddef.h>
#include <sys/types.h>
#define FS_O_CREATE 1
#define FS_O_WRITE 2
#define FS_O_TRUNC 4
#define FS_O_READ 8
struct fs_file_t { int unused; };
static inline void fs_file_t_init(struct fs_file_t *f) { (void)f; }
static inline int fs_open(struct fs_file_t *f, const char *p, int fl)
{ (void)f; (void)p; (void)fl; return -2; }
static inline ssize_t fs_write(struct fs_file_t *f, const void *b, size_t n)
{ (void)f; (void)b; (void)n; return -5; }
static inline ssize_t fs_read(struct fs_file_t *f, void *b, size_t n)
{ (void)f; (void)b; (void)n; return -5; }
static inline int fs_close(struct fs_file_t *f) { (void)f; return 0; }
#endif
EOF

BIN="$WORK/pendant_local_test"
cc -std=c11 -Wall -Wextra -Wno-unused-function -O2 \
   -I"$WORK" -I"$ROOT/src" "$SRC" -o "$BIN" -lm
"$BIN"
