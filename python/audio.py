"""What CoreAudio says about this Mac's sound devices, asked directly (ctypes), so it's always
current: PortAudio only reads the device list when it starts.

    python3 python/audio.py     # prints the microphone it listens with and the speaker
"""

from __future__ import annotations

import ctypes

_ca = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
_cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
_cf.CFRelease.argtypes = [ctypes.c_void_p]

SYSTEM = 1  # kAudioObjectSystemObject


class _Address(ctypes.Structure):
    _fields_ = [("selector", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("element", ctypes.c_uint32)]


def _code(s: str) -> int:
    return int.from_bytes(s.encode(), "big")


def _get(obj: int, selector: str, scope: str = "glob", kind=ctypes.c_uint32):
    address = _Address(_code(selector), _code(scope), 0)
    value, size = kind(), ctypes.c_uint32(ctypes.sizeof(kind))
    if _ca.AudioObjectGetPropertyData(obj, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(value)):
        return None
    return value.value


def default_input() -> int | None:
    return _get(SYSTEM, "dIn ")


def default_output() -> int | None:
    return _get(SYSTEM, "dOut")


def devices() -> list[int]:
    address, size = _Address(_code("dev#"), _code("glob"), 0), ctypes.c_uint32()
    if _ca.AudioObjectGetPropertyDataSize(SYSTEM, ctypes.byref(address), 0, None, ctypes.byref(size)):
        return []
    ids = (ctypes.c_uint32 * (size.value // 4))()
    if _ca.AudioObjectGetPropertyData(SYSTEM, ctypes.byref(address), 0, None, ctypes.byref(size), ids):
        return []
    return list(ids)


def has_input(device: int) -> bool:
    address, size = _Address(_code("stm#"), _code("inpt"), 0), ctypes.c_uint32()
    return not _ca.AudioObjectGetPropertyDataSize(device, ctypes.byref(address), 0, None, ctypes.byref(size)) \
        and size.value > 0


def microphone() -> int | None:
    """The microphone to listen with: the default one, unless that's a Bluetooth headset's.
    Listening through AirPods or headphones switches them to call-quality sound for as long as
    the microphone is open, so then it's the Mac's own microphone."""
    device = default_input()
    if device and _get(device, "tran") in (_code("blue"), _code("blea")):
        for other in devices():
            if _get(other, "tran") == _code("bltn") and has_input(other):
                return other
    return device


def name(device: int | None) -> str:
    ref = _get(device, "lnam", kind=ctypes.c_void_p) if device else None
    if not ref:
        return "?"
    buf = ctypes.create_string_buffer(256)
    _cf.CFStringGetCString(ref, buf, 256, 0x08000100)  # UTF-8
    _cf.CFRelease(ref)
    return buf.value.decode(errors="replace")


def output_is_speakers() -> bool:
    """True when the agent's voice comes out of something the microphone can hear: the Mac's own
    speakers or a display's, rather than headphones, AirPods or a headset."""
    device = default_output()
    if not device:
        return True
    transport = _get(device, "tran")
    if transport == _code("bltn"):
        return _get(device, "ssrc", "outp") != _code("hdpn")  # the headphone jack, or the speakers
    return transport in (_code("hdmi"), _code("dprt"), _code("airp"))


if __name__ == "__main__":
    mic = microphone()
    print(f"microphone: {name(mic)}" + (f" (not {name(default_input())}, the default)" if mic != default_input() else ""))
    print(f"speaker:    {name(default_output())} ({'speakers' if output_is_speakers() else 'headphones'})")
