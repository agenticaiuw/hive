"""Hive's virtual monitor: a second display the agent works on with the real mouse and keyboard.

macOS treats it as an ordinary screen (tools/hive_monitor.m creates it), so the Mac tools need
nothing special: screenshots are taken of it, clicks land on it, and the app that is clicked
there gets the real keyboard focus. When it is off, the tools work on the main display as before.

Where Hive works is the user's choice, asked when the app starts and kept in the state folder's
`work-screen` file: "real" (their own screen, the default) or "virtual". HIVE_VIRTUAL_MONITOR=1
or =0 overrides the file.
"""
import ctypes
import os
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "build", "hive-monitor")
VENDOR, PRODUCT = 0x4856, 0x0001  # the identity tools/hive_monitor.m gives the display
SIZE = os.environ.get("HIVE_VIRTUAL_MONITOR_SIZE", "1440x900")


class _Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _Size(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _Rect(ctypes.Structure):
    _fields_ = [("origin", _Point), ("size", _Size)]


_cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
_cg.CGGetOnlineDisplayList.restype = ctypes.c_int32
_cg.CGGetOnlineDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
_cg.CGDisplayVendorNumber.restype = ctypes.c_uint32
_cg.CGDisplayVendorNumber.argtypes = [ctypes.c_uint32]
_cg.CGDisplayModelNumber.restype = ctypes.c_uint32
_cg.CGDisplayModelNumber.argtypes = [ctypes.c_uint32]
_cg.CGDisplayBounds.restype = _Rect
_cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
_cg.CGWarpMouseCursorPosition.restype = ctypes.c_int32
_cg.CGWarpMouseCursorPosition.argtypes = [_Point]


def _choice_file():
    from resumable_thread import state_dir
    return state_dir() / "work-screen"


def choice() -> str:
    """'real' (the user's own screen) or 'virtual'."""
    try:
        return "virtual" if _choice_file().read_text().strip() == "virtual" else "real"
    except OSError:
        return "real"


def choose(where: str):
    """Saves the choice and turns the virtual monitor on or off to match."""
    where = "virtual" if where == "virtual" else "real"
    path = _choice_file()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(where + "\n")
    if where == "virtual":
        ensure()
    else:
        off()


def ask(timeout: int = 12) -> str:
    """Asks where Hive should work. No answer within `timeout` seconds keeps the last choice."""
    current = choice()
    default = "Virtual monitor" if current == "virtual" else "This screen"
    script = ('display dialog "Where should Hive work?\n\nThis screen: it uses your real mouse and keyboard here, '
              'and you can watch it.\nVirtual monitor: it works on a second, hidden screen." '
              'with title "Hive" buttons {"Virtual monitor", "This screen"} '
              f'default button "{default}" giving up after {int(timeout)}')
    try:
        done = subprocess.run(["osascript", "-e", "activate", "-e", script], capture_output=True, text=True,
                              timeout=timeout + 10)
    except (OSError, subprocess.TimeoutExpired):
        return current
    if "gave up:true" in done.stdout or done.returncode:
        return current
    picked = "virtual" if "Virtual monitor" in done.stdout else "real"
    choose(picked)
    return picked


def off():
    """Turns the virtual monitor off; macOS moves its windows to the user's screen."""
    subprocess.run(["pkill", "-TERM", "-f", HELPER + " serve"], capture_output=True)


def enabled() -> bool:
    override = os.environ.get("HIVE_VIRTUAL_MONITOR")
    if override in ("0", "1"):
        return override == "1"
    return choice() == "virtual"


def bounds() -> tuple[float, float, float, float] | None:
    """(x, y, width, height) of the virtual monitor in screen points, or None while it is off."""
    if not enabled():
        return None
    ids = (ctypes.c_uint32 * 16)()
    count = ctypes.c_uint32(0)
    if _cg.CGGetOnlineDisplayList(16, ids, ctypes.byref(count)) != 0:
        return None
    for display in ids[: count.value]:
        if _cg.CGDisplayVendorNumber(display) == VENDOR and _cg.CGDisplayModelNumber(display) == PRODUCT:
            r = _cg.CGDisplayBounds(display)
            if r.size.width > 0 and r.size.height > 0:
                return r.origin.x, r.origin.y, r.size.width, r.size.height
    return None


def ensure(timeout: float = 10.0) -> tuple[float, float, float, float] | None:
    """Turns the virtual monitor on if it is off. Its helper keeps running after this process ends,
    so the windows on it survive a restart of the app. None if it could not be turned on."""
    if not enabled():
        return None
    found = bounds()
    if found or not os.access(HELPER, os.X_OK):
        return found
    subprocess.Popen([HELPER, "serve", SIZE], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = bounds()
        if found:
            return found
        time.sleep(0.2)
    return None


def contains(x: float, y: float) -> bool:
    b = bounds()
    return bool(b) and b[0] <= x < b[0] + b[2] and b[1] <= y < b[1] + b[3]


def bring_cursor(position: tuple[float, float]) -> bool:
    """Puts the cursor on the virtual monitor if it is elsewhere, so the mouse moves that follow
    start there instead of crossing the user's screen. True if it moved the cursor."""
    b = bounds()
    if not b or contains(*position):
        return False
    _cg.CGWarpMouseCursorPosition(_Point(b[0] + b[2] / 2, b[1] + b[3] / 2))
    return True


def warp(x: float, y: float):
    _cg.CGWarpMouseCursorPosition(_Point(x, y))


def place(pid: int) -> str:
    """Moves that app's front window onto the virtual monitor. Returns '' or why it could not."""
    if not bounds():
        return "the virtual monitor is off"
    try:
        done = subprocess.run([HELPER, "place", str(int(pid))], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return str(error)
    return "" if done.returncode == 0 else (done.stderr.strip() or f"exit status {done.returncode}")
