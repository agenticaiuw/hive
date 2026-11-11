#!/usr/bin/env python3
"""Atomically rename on macOS only if the destination does not exist."""
import ctypes
import os
import sys

if len(sys.argv) != 3 or sys.platform != 'darwin':
    raise SystemExit('Usage: rename-exclusive.py SOURCE DESTINATION (macOS)')
libc = ctypes.CDLL(None, use_errno=True)
rename = libc.renamex_np
rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
if rename(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0x00000004) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), sys.argv[2])
