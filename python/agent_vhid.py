"""Control this Mac the way a person does, through agent-vhid-helper.

The helper drives Karabiner's virtual HID keyboard and mouse, so macOS sees
real hardware input. The moment you touch a real key, the trackpad or a mouse,
the helper takes the agent's hands off: every call here raises Disengaged until
it asks again (engage(), for something you told it to do) and your hands are off.

    from agent_vhid import AgentVHID, Disengaged

    mac = AgentVHID()
    mac.engage()                       # for a task you gave it
    mac.wait_engaged()                 # blocks until your hands are off
    shot = mac.screenshot(max_width=1280)
    try:
        mac.click(*shot.to_screen(640, 400))
        mac.type_text("hello")
        mac.key("cmd+s")
    except Disengaged:
        ...                            # you took over; wait, then look again

Also usable from a shell: `python3 agent_vhid.py --help`.
No third-party packages needed.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass

DEFAULT_SOCKET = os.environ.get("AGENT_VHID_SOCKET", "/tmp/agent-vhid.sock")
OCR_TOOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "agent-vhid-ocr")


class AgentVHIDError(Exception):
    pass


class HelperUnavailable(AgentVHIDError):
    """agent-vhid-helper isn't running."""


class Disengaged(AgentVHIDError):
    """The human has control. Wait for wait_engaged(), then look at the screen again."""


class NotReady(AgentVHIDError):
    """Karabiner's virtual devices aren't up yet (is the daemon running?)."""


class MoveFailed(AgentVHIDError):
    """The cursor didn't reach the target."""


class NotAllowed(AgentVHIDError):
    """The helper refused, e.g. engage() while its safety watcher isn't working."""


# --- CoreGraphics, for reading where the cursor is and how big the screen is ---

class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]


_cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
_cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cg.CGEventCreate.restype = ctypes.c_void_p
_cg.CGEventCreate.argtypes = [ctypes.c_void_p]
_cg.CGEventGetLocation.restype = _CGPoint
_cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
_cg.CGMainDisplayID.restype = ctypes.c_uint32
_cg.CGDisplayBounds.restype = _CGRect
_cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
_cg.CGGetActiveDisplayList.restype = ctypes.c_int32
_cg.CGGetActiveDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
_cf.CFRelease.argtypes = [ctypes.c_void_p]


def cursor_position() -> tuple[float, float]:
    """Cursor position in global screen points (origin at the main display's top-left)."""
    event = _cg.CGEventCreate(None)
    try:
        p = _cg.CGEventGetLocation(event)
        return p.x, p.y
    finally:
        _cf.CFRelease(event)


def display_bounds() -> list[tuple[float, float, float, float]]:
    """(x, y, width, height) of every display, in points. Includes displays that are asleep."""
    ids = (ctypes.c_uint32 * 16)()
    count = ctypes.c_uint32(0)
    _cg.CGGetActiveDisplayList(16, ids, ctypes.byref(count))
    if count.value == 0:  # every display is asleep
        _cg.CGGetOnlineDisplayList(16, ids, ctypes.byref(count))
    result = []
    for display in ids[: count.value]:
        r = _cg.CGDisplayBounds(display)
        result.append((r.origin.x, r.origin.y, r.size.width, r.size.height))
    return result


def main_display_bounds() -> tuple[float, float, float, float]:
    r = _cg.CGDisplayBounds(_cg.CGMainDisplayID())
    return r.origin.x, r.origin.y, r.size.width, r.size.height


# --- Keyboard map (US / ABC layout) ---

MODIFIERS = {
    "ctrl": 0x01, "control": 0x01,
    "shift": 0x02,
    "alt": 0x04, "opt": 0x04, "option": 0x04,
    "cmd": 0x08, "command": 0x08, "super": 0x08, "meta": 0x08, "win": 0x08,
    "rctrl": 0x10, "rshift": 0x20, "ropt": 0x40, "ralt": 0x40, "rcmd": 0x80,
}

NAMED_KEYS = {
    "return": 0x28, "enter": 0x28, "esc": 0x29, "escape": 0x29,
    "backspace": 0x2A, "delete": 0x2A, "tab": 0x2B, "space": 0x2C,
    "forwarddelete": 0x4C, "capslock": 0x39,
    "home": 0x4A, "pageup": 0x4B, "end": 0x4D, "pagedown": 0x4E,
    "right": 0x4F, "left": 0x50, "down": 0x51, "up": 0x52,
    "minus": 0x2D, "equal": 0x2E, "comma": 0x36, "period": 0x37, "slash": 0x38,
}
NAMED_KEYS.update({f"f{i}": 0x3A + i - 1 for i in range(1, 13)})
NAMED_KEYS.update({f"f{i}": 0x68 + i - 13 for i in range(13, 25)})

_PLAIN = {" ": 0x2C, "\n": 0x28, "\t": 0x2B, "-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30,
          "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38}
_SHIFTED = {"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
            "~": "`", "<": ",", ">": ".", "?": "/"}
CHARS: dict[str, tuple[int, bool]] = {}
for _i, _c in enumerate("abcdefghijklmnopqrstuvwxyz"):
    CHARS[_c] = (0x04 + _i, False)
    CHARS[_c.upper()] = (0x04 + _i, True)
for _i, (_c, _s) in enumerate(zip("1234567890", "!@#$%^&*()")):
    CHARS[_c] = (0x1E + _i, False)
    CHARS[_s] = (0x1E + _i, True)
for _c, _u in _PLAIN.items():
    CHARS[_c] = (_u, False)
for _c, _base in _SHIFTED.items():
    CHARS[_c] = (_PLAIN[_base], True)


def parse_combo(combo: str) -> tuple[int, int | None]:
    """'cmd+shift+t' -> (modifier bits, usage). Accepts xdotool-style names like 'ctrl+Return'."""
    parts = [p for p in combo.replace(" ", "").split("+") if p]
    if not parts:
        raise ValueError("empty key combo")
    mods = 0
    key = None
    for i, part in enumerate(parts):
        name = part.lower().replace("_", "")
        if name in MODIFIERS:
            mods |= MODIFIERS[name]
            continue
        if i != len(parts) - 1:
            raise ValueError(f"unknown modifier {part!r} in {combo!r}")
        if name in NAMED_KEYS:
            key = NAMED_KEYS[name]
        elif len(part) == 1 and part in CHARS:
            usage, shifted = CHARS[part]
            key = usage
            if shifted:
                mods |= MODIFIERS["shift"]
        else:
            raise ValueError(f"unknown key {part!r} in {combo!r}")
    return mods, key


# --- Screenshots ---

@dataclass
class Screenshot:
    path: str
    width: int          # image pixels
    height: int
    scale: float        # screen points per image pixel
    origin: tuple[float, float] = (0.0, 0.0)

    def to_screen(self, x: float, y: float) -> tuple[float, float]:
        """Image pixel coordinates (what a model sees) -> screen points (what click() takes)."""
        return self.origin[0] + x * self.scale, self.origin[1] + y * self.scale

    def from_screen(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.origin[0]) / self.scale, (y - self.origin[1]) / self.scale


@dataclass
class TextBox:
    """A word read off the screen. Coordinates are screen points, like click() takes."""
    text: str
    line: str           # the whole line of text the word sits in
    confidence: float
    x: float
    y: float
    w: float
    h: float

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.w / 2, self.y + self.h / 2


def _image_size(path: str) -> tuple[int, int]:
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                         check=True, capture_output=True, text=True).stdout
    values = {}
    for line in out.splitlines():
        if ":" in line and "pixel" in line:
            k, v = line.split(":")
            values[k.strip()] = int(v)
    return values["pixelWidth"], values["pixelHeight"]


def _natural_scrolling() -> bool:
    out = subprocess.run(["defaults", "read", "-g", "com.apple.swipescrolldirection"],
                         capture_output=True, text=True)
    return out.stdout.strip() not in ("0", "false")  # macOS default is on


# --- Talking to the helper ---

class _Connection:
    def __init__(self, path: str, timeout: float | None = 5.0):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(path)
        except (FileNotFoundError, ConnectionRefusedError) as e:
            self.sock.close()
            raise HelperUnavailable(f"agent-vhid-helper isn't running on {path} (./install.sh has the Mac start it; or start it with ./voice.sh)") from e
        except PermissionError as e:
            self.sock.close()
            raise HelperUnavailable(f"no permission to use {path}; start the helper with sudo as this user") from e
        self.reader = self.sock.makefile("rb")

    def request(self, line: str) -> str:
        self.sock.sendall(line.encode() + b"\n")
        return self.readline()

    def readline(self) -> str:
        reply = self.reader.readline()
        if not reply:
            raise HelperUnavailable("agent-vhid-helper closed the connection")
        return reply.decode().rstrip("\n")

    def close(self):
        try:
            self.reader.close()
            self.sock.close()
        except OSError:
            pass


def _parse_fields(text: str) -> dict[str, str]:
    return dict(item.split("=", 1) for item in text.split() if "=" in item)


class AgentVHID:
    """Human-like mouse, keyboard and screen control. All coordinates are screen points."""

    STEP = 0.008  # seconds between mouse reports (~125 Hz, like a USB mouse)

    def __init__(self, socket_path: str = DEFAULT_SOCKET, speed: float = 1.0, human: bool = True):
        """speed: >1 moves and types faster. human=False uses straight, fast moves and no typing jitter."""
        self.socket_path = socket_path
        self.speed = speed
        self.human = human
        self._conn: _Connection | None = None
        self._lock = threading.Lock()
        self._points_per_count = 1.0  # learned from how far the cursor actually moves
        self._natural = None

    # -- plumbing --

    def _send(self, line: str) -> str:
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._conn is None:
                        self._conn = _Connection(self.socket_path)
                    reply = self._conn.request(line)
                    break
                except (BrokenPipeError, ConnectionResetError, HelperUnavailable, socket.timeout):
                    if self._conn:
                        self._conn.close()
                    self._conn = None
                    if attempt == 2:
                        raise
        if reply.startswith("ok"):
            return reply[3:]
        _, _, rest = reply.partition(" ")
        code, _, detail = rest.partition(" ")
        if code == "disengaged":
            raise Disengaged(f"the human has control ({detail})")
        if code == "forbidden":
            raise NotAllowed(detail)
        if code == "not_ready":
            raise NotReady(f"virtual devices not ready ({detail}); is Karabiner-VirtualHIDDevice-Daemon running?")
        raise AgentVHIDError(reply)

    def close(self):
        with self._lock:
            if self._conn:
                self._conn.close()
                self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            self.release_all()
        except AgentVHIDError:
            pass
        self.close()

    def _pause(self, seconds: float):
        time.sleep(max(0.0, seconds / self.speed))

    def _jitter(self, base: float, spread: float = 0.35) -> float:
        if not self.human:
            return base
        return base * random.uniform(1 - spread, 1 + spread)

    # -- state --

    def status(self) -> dict[str, str]:
        return _parse_fields(self._send("status"))

    def is_engaged(self) -> bool:
        return self.status().get("state") == "engaged"

    def watch(self):
        """Yields {'state': ..., 'reason': ...} every time control changes hands, and {'fn': ...} for
        what the human does with fn: 'down', then 'tap' (the voice agent's listening switch) or 'up'
        (the end of a hold, which dictates), and 'other' if they press another key with it."""
        conn = _Connection(self.socket_path, timeout=None)
        try:
            if not conn.request("watch").startswith("ok"):
                raise AgentVHIDError("helper refused watch")
            while True:
                line = conn.readline()
                if line.startswith("event "):
                    yield _parse_fields(line[6:])
        finally:
            conn.close()

    def wait_engaged(self, timeout: float | None = None, announce: bool = True) -> bool:
        """Blocks until control has passed to the agent: after engage(), once the human's hands are off.
        False on timeout."""
        if self.is_engaged():
            return True
        if announce:
            print("[agent-vhid] waiting for control: keep your hands off the keyboard, trackpad and mouse",
                  file=sys.stderr)
        conn = _Connection(self.socket_path, timeout=timeout)
        try:
            conn.request("watch")
            while True:
                fields = _parse_fields(conn.readline().removeprefix("event "))
                if fields.get("state") == "engaged":
                    return True
        except socket.timeout:
            return False
        finally:
            conn.close()

    def release_all(self):
        self._send("release")

    def engage(self):
        """Starts taking control, for a task the human gave (said or typed) or after they said
        "continue". The helper waits for their hands to be off first, and any touch takes it back.
        Raises NotAllowed if its safety watcher isn't working."""
        self._send("engage")

    def disengage(self):
        """Hands control back to the human, e.g. when a task is done."""
        self._send("disengage")

    # -- mouse --

    def cursor(self) -> tuple[float, float]:
        return cursor_position()

    def _target_on_screen(self, x: float, y: float) -> tuple[float, float]:
        for dx, dy, w, h in display_bounds():
            if dx <= x < dx + w and dy <= y < dy + h:
                return x, y
        raise ValueError(f"({x:.0f}, {y:.0f}) is not on any display")

    def _nudge(self, ex: float, ey: float, gain: float = 1.0, at_least_one: bool = False) -> tuple[int, int]:
        """Sends one report that should move the cursor by (ex, ey) points. Returns the counts sent."""
        ppc = self._points_per_count
        cx = round(ex / ppc * gain)
        cy = round(ey / ppc * gain)
        if at_least_one:
            if cx == 0 and abs(ex) > 0.5:
                cx = 1 if ex > 0 else -1
            if cy == 0 and abs(ey) > 0.5:
                cy = 1 if ey > 0 else -1
        cx = max(-127, min(127, cx))
        cy = max(-127, min(127, cy))
        if cx or cy:
            self._send(f"move {cx} {cy}")
        return cx, cy

    def _learn(self, counts: tuple[int, int], before: tuple[float, float], after: tuple[float, float]):
        # macOS accelerates the pointer, so points-per-count depends on speed; track it as we go.
        sent = math.hypot(*counts)
        if sent < 3:
            return
        moved = math.hypot(after[0] - before[0], after[1] - before[1])
        ratio = max(0.05, min(10.0, moved / sent))
        self._points_per_count = 0.7 * self._points_per_count + 0.3 * ratio

    def move_to(self, x: float, y: float, duration: float | None = None, tolerance: float = 0.75):
        """Moves the cursor to (x, y) in screen points along a human-looking path, then settles exactly."""
        tx, ty = self._target_on_screen(x, y)
        sx, sy = self.cursor()
        distance = math.hypot(tx - sx, ty - sy)
        if distance <= tolerance:
            return

        if self.human:
            if duration is None:
                # Fitts's law: longer moves take longer, but not proportionally.
                duration = 0.05 + 0.09 * math.log2(1 + distance / 10)
            duration /= self.speed
            steps = max(2, int(duration / self.STEP))
            # A gentle curve: one control point pushed sideways from the straight line.
            bend = random.uniform(-0.12, 0.12) * distance
            nx, ny = -(ty - sy) / distance, (tx - sx) / distance
            cx, cy = (sx + tx) / 2 + nx * bend, (sy + ty) / 2 + ny * bend
            for i in range(1, steps + 1):
                t = i / steps
                s = 10 * t**3 - 15 * t**4 + 6 * t**5  # minimum-jerk speed profile
                wx = (1 - s) ** 2 * sx + 2 * (1 - s) * s * cx + s**2 * tx
                wy = (1 - s) ** 2 * sy + 2 * (1 - s) * s * cy + s**2 * ty
                before = self.cursor()
                counts = self._nudge(wx - before[0], wy - before[1])
                time.sleep(self.STEP)
                self._learn(counts, before, self.cursor())

        self._settle(tx, ty, tolerance)

    def _settle(self, tx: float, ty: float, tolerance: float):
        stalled = 0
        for _ in range(200):
            before = self.cursor()
            ex, ey = tx - before[0], ty - before[1]
            if abs(ex) <= tolerance and abs(ey) <= tolerance:
                return
            counts = self._nudge(ex, ey, gain=0.8, at_least_one=True)
            time.sleep(0.012)
            after = self.cursor()
            self._learn(counts, before, after)
            if math.hypot(after[0] - before[0], after[1] - before[1]) < 0.01:
                stalled += 1
                if stalled >= 15:
                    raise MoveFailed(f"cursor stopped responding at ({after[0]:.1f}, {after[1]:.1f}); "
                                     "is the virtual mouse ready?")
            else:
                stalled = 0
        x, y = self.cursor()
        raise MoveFailed(f"cursor ended at ({x:.1f}, {y:.1f}), wanted ({tx:.1f}, {ty:.1f})")

    def move_by(self, dx: float, dy: float):
        x, y = self.cursor()
        self.move_to(x + dx, y + dy)

    _BUTTONS = {"left": 1, "right": 2, "middle": 4}

    def mouse_down(self, button: str = "left"):
        self._send(f"buttons {self._BUTTONS[button]}")

    def mouse_up(self):
        self._send("buttons 0")

    def click(self, x: float | None = None, y: float | None = None, button: str = "left", count: int = 1,
              modifiers: str | None = None):
        """Clicks at (x, y), or where the cursor is. count=2 double-clicks, 3 triple-clicks.
        modifiers like 'cmd' or 'shift+alt' are held during the click."""
        mods = parse_combo(modifiers)[0] if modifiers else 0
        if x is not None and y is not None:
            self.move_to(x, y)
            self._pause(self._jitter(0.06))
        if mods:
            self._keys(mods)
            self._pause(self._jitter(0.04))
        try:
            for i in range(count):
                self.mouse_down(button)
                self._pause(self._jitter(0.05))
                self.mouse_up()
                if i < count - 1:
                    self._pause(self._jitter(0.09, 0.2))  # well inside the double-click interval
        finally:
            if mods:
                try:
                    self._keys(0)
                except Disengaged:
                    pass

    def double_click(self, x: float | None = None, y: float | None = None):
        self.click(x, y, count=2)

    def right_click(self, x: float | None = None, y: float | None = None):
        self.click(x, y, button="right")

    def drag(self, x1: float, y1: float, x2: float, y2: float, button: str = "left"):
        self.move_to(x1, y1)
        self._pause(self._jitter(0.08))
        self.mouse_down(button)
        try:
            self._pause(self._jitter(0.1))
            self.move_to(x2, y2)
            self._pause(self._jitter(0.08))
        finally:
            try:
                self.mouse_up()
            except Disengaged:
                pass  # the helper already let go of everything

    def scroll(self, down: int = 0, right: int = 0, x: float | None = None, y: float | None = None):
        """Scrolls by wheel notches. down > 0 shows content further down; right > 0 further right."""
        if x is not None and y is not None:
            self.move_to(x, y)
        if self._natural is None:
            self._natural = _natural_scrolling()
        # Rolling a wheel away from you is +1 in HID; natural scrolling flips what that does.
        sign = 1 if self._natural else -1
        for _ in range(abs(down)):
            self._send(f"scroll {sign * (1 if down > 0 else -1)} 0")
            self._pause(self._jitter(0.03))
        for _ in range(abs(right)):
            self._send(f"scroll 0 {sign * (1 if right > 0 else -1)}")
            self._pause(self._jitter(0.03))

    # -- keyboard --

    def _keys(self, mods: int, *usages: int):
        self._send("keys " + " ".join(str(v) for v in (mods, *usages)))

    def key(self, combo: str, hold: float = 0.05):
        """Presses a shortcut like 'cmd+s', 'cmd+shift+t', 'return', 'ctrl+Page_Up'."""
        mods, usage = parse_combo(combo)
        # Modifiers go down one at a time, like fingers, then the key, then everything lets go.
        held = 0
        for bit in (0x08, 0x01, 0x04, 0x02, 0x80, 0x10, 0x40, 0x20):
            if mods & bit:
                held |= bit
                self._keys(held)
                self._pause(self._jitter(0.025))
        try:
            if usage is not None:
                self._keys(mods, usage)
                self._pause(self._jitter(hold))
                self._keys(mods)
                self._pause(self._jitter(0.02))
        finally:
            if mods:
                try:
                    self._keys(0)
                except Disengaged:
                    pass

    def type_text(self, text: str, interval: float = 0.045):
        """Types text key by key. Characters a US keyboard can't type are pasted instead."""
        run: list[str] = []
        for ch in text:
            if ch not in CHARS:
                run.append(ch)
                continue
            if run:
                self.paste_text("".join(run))
                run = []
            usage, shifted = CHARS[ch]
            mods = MODIFIERS["shift"] if shifted else 0
            if shifted:
                self._keys(mods)
                self._pause(self._jitter(0.015))
            self._keys(mods, usage)
            self._pause(self._jitter(0.03))
            self._keys(mods)
            if shifted:
                self._keys(0)
            self._pause(self._jitter(interval, 0.5))
        if run:
            self.paste_text("".join(run))

    def paste_text(self, text: str):
        """Puts text on the clipboard, presses cmd+v, then restores the previous clipboard text."""
        previous = subprocess.run(["pbpaste"], capture_output=True).stdout
        subprocess.run(["pbcopy"], input=text.encode(), check=True)
        try:
            self.key("cmd+v")
            time.sleep(0.3)  # let the app read the clipboard before restoring it
        finally:
            subprocess.run(["pbcopy"], input=previous, check=True)

    # -- screen --

    def screenshot(self, path: str | None = None, max_width: int | None = None) -> Screenshot:
        """Captures the main display. With max_width, scales it down (models see fewer, bigger pixels).
        Use Screenshot.to_screen() to turn a point in the image into click() coordinates."""
        if path is None:
            fd, path = tempfile.mkstemp(prefix="agent-vhid-", suffix=".png")
            os.close(fd)
        subprocess.run(["screencapture", "-x", "-m", "-t", "png", path], check=True)
        width, height = _image_size(path)
        if max_width and width > max_width:
            subprocess.run(["sips", "--resampleWidth", str(max_width), path], check=True, capture_output=True)
            width, height = _image_size(path)
        ox, oy, points_wide, _ = main_display_bounds()
        return Screenshot(path, width, height, points_wide / width, (ox, oy))

    def read_screen(self, shot: Screenshot | None = None) -> list[TextBox]:
        """Every word on the main display, top to bottom, via Apple's on-device Vision text recognition."""
        own_shot = shot is None
        if own_shot:
            shot = self.screenshot()  # full resolution reads small text best
        try:
            out = subprocess.run([OCR_TOOL, shot.path], check=True, capture_output=True, text=True).stdout
        except FileNotFoundError as e:
            raise AgentVHIDError(f"{OCR_TOOL} is missing; run make") from e
        finally:
            if own_shot:
                os.unlink(shot.path)
        boxes = []
        for line in out.splitlines():
            d = json.loads(line)
            x, y = shot.to_screen(d["x"], d["y"])
            boxes.append(TextBox(d["text"], d["line"], d["confidence"], x, y, d["w"] * shot.scale, d["h"] * shot.scale))
        boxes.sort(key=lambda b: (round(b.y / 4), b.x))
        return boxes

    def find_text(self, word: str, boxes: list[TextBox] | None = None, line_contains: str | None = None) -> TextBox | None:
        """The first word on screen equal to `word` (ignoring case), optionally only in lines containing
        `line_contains`. Returns None when it isn't visible."""
        for box in self.read_screen() if boxes is None else boxes:
            if box.text.lower() == word.lower() and (line_contains is None or line_contains.lower() in box.line.lower()):
                return box
        return None


# --- Command line, so any agent with a shell can use it ---

def _main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="agent_vhid.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--socket", default=DEFAULT_SOCKET)
    parser.add_argument("--fast", action="store_true", help="straight moves, no typing jitter")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("cursor")
    sub.add_parser("release")
    sub.add_parser("watch", help="print every hand-over until Ctrl-C")
    p = sub.add_parser("wait", help="block until control has passed to the agent")
    p.add_argument("--timeout", type=float)
    p = sub.add_parser("engage", help="take control (once your hands are off), then return")
    p.add_argument("--timeout", type=float)
    p = sub.add_parser("move")
    p.add_argument("x", type=float)
    p.add_argument("y", type=float)
    p = sub.add_parser("click")
    p.add_argument("x", type=float, nargs="?")
    p.add_argument("y", type=float, nargs="?")
    p.add_argument("--button", default="left", choices=["left", "right", "middle"])
    p.add_argument("--count", type=int, default=1)
    p = sub.add_parser("drag")
    for name in ("x1", "y1", "x2", "y2"):
        p.add_argument(name, type=float)
    p = sub.add_parser("scroll")
    p.add_argument("down", type=int)
    p.add_argument("right", type=int, nargs="?", default=0)
    p = sub.add_parser("type")
    p.add_argument("text")
    p = sub.add_parser("key")
    p.add_argument("combo")
    p = sub.add_parser("screenshot")
    p.add_argument("path", nargs="?")
    p.add_argument("--max-width", type=int)
    sub.add_parser("read", help="print every word on screen with its position in points")
    p = sub.add_parser("find", help="print where a word is on screen (exit 5 if not visible)")
    p.add_argument("word")
    args = parser.parse_args(argv)

    mac = AgentVHID(args.socket, human=not args.fast)
    try:
        if args.cmd == "status":
            for k, v in mac.status().items():
                print(f"{k}={v}")
        elif args.cmd == "cursor":
            x, y = mac.cursor()
            print(f"{x:.1f} {y:.1f}")
        elif args.cmd == "release":
            mac.release_all()
        elif args.cmd == "watch":
            for event in mac.watch():
                print(*(("fn", event["fn"]) if "fn" in event else (event.get("state"), event.get("reason"))),
                      flush=True)
        elif args.cmd == "wait":
            return 0 if mac.wait_engaged(args.timeout) else 4
        elif args.cmd == "engage":
            mac.engage()
            return 0 if mac.wait_engaged(args.timeout) else 4
        elif args.cmd == "move":
            mac.move_to(args.x, args.y)
        elif args.cmd == "click":
            mac.click(args.x, args.y, args.button, args.count)
        elif args.cmd == "drag":
            mac.drag(args.x1, args.y1, args.x2, args.y2)
        elif args.cmd == "scroll":
            mac.scroll(args.down, args.right)
        elif args.cmd == "type":
            mac.type_text(args.text)
        elif args.cmd == "key":
            mac.key(args.combo)
        elif args.cmd == "screenshot":
            shot = mac.screenshot(args.path, args.max_width)
            print(f"{shot.path} {shot.width}x{shot.height} points_per_pixel={shot.scale:.4f}")
        elif args.cmd == "read":
            for box in mac.read_screen():
                print(f"{box.center[0]:7.1f} {box.center[1]:6.1f}  {box.text}")
        elif args.cmd == "find":
            box = mac.find_text(args.word)
            if box is None:
                return 5
            print(f"{box.center[0]:.1f} {box.center[1]:.1f}")
    except Disengaged as e:
        print(f"disengaged: {e}", file=sys.stderr)
        return 3
    except (AgentVHIDError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    finally:
        mac.close()
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
