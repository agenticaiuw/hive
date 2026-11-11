"""Tools that let Codex use the user's iPhone (python/phone.py): screenshots to see, taps, swipes
and typing to act. agent.py hands them (PhoneTools, TOOLS) straight to Codex, alongside a Mac task
if there is one, so the voice agent can work on the phone while it, or you, use the Mac. Run as a
script, this is an MCP server like mac_mcp.py.

Every coordinate is a point on the phone's screen, which is what the screenshots it returns are
measured in.
"""

from __future__ import annotations

import base64
import ctypes
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mac_mcp import LOOK, Server, batch_tool, main, result, run_batch, text  # noqa: E402
from phone import Phone, PhoneError, _phone_library  # noqa: E402

SETTLE = 0.4  # seconds for the phone's screen to catch up before the screenshot after an action


def point(desc: str) -> dict:
    return {"type": "number", "description": desc}


TOOLS = [
    {
        "name": "authenticate",
        "description": "Use the locally saved device passcode at a verified iPhone system passcode prompt. "
                       "Requires the configured phone to stay connected through Pocket Connect. "
                       "Takes no secret arguments; this is not for app passwords or payments. "
                       "Returns status only. If unavailable or rejected, stop and let the user authenticate; never retry or ask for the passcode in chat.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "screenshot",
        "description": "See the iPhone's screen. Every x/y in the other tools is a point in this image.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "tap",
        "description": "Tap the phone's screen at (x, y).",
        "inputSchema": {"type": "object", "properties": {
            "x": point("x in the latest phone screenshot"), "y": point("y in the latest phone screenshot"),
            "screenshot": LOOK,
        }, "required": ["x", "y"]},
    },
    {
        "name": "tap_element",
        "description": "Tap a button, link or field by its label (from elements, or the text on it). More "
                       "reliable than coordinates for small targets.",
        "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}, "screenshot": LOOK},
                        "required": ["label"]},
    },
    {
        "name": "swipe",
        "description": "Drag a finger from one point to another: to scroll a list swipe up (from_y > to_y), "
                       "to go back swipe right from the left edge, to search the home screen swipe down from "
                       "its middle.",
        "inputSchema": {"type": "object", "properties": {
            "from_x": point("Start x"), "from_y": point("Start y"), "to_x": point("End x"), "to_y": point("End y"),
            "screenshot": LOOK,
        }, "required": ["from_x", "from_y", "to_x", "to_y"]},
    },
    {
        "name": "type_text",
        "description": "Type into the field that has focus (tap it first). '\\n' presses Return.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "screenshot": LOOK},
                        "required": ["text"]},
    },
    {
        "name": "press_home",
        "description": "Go to the home screen.",
        "inputSchema": {"type": "object", "properties": {"screenshot": LOOK}},
    },
    {
        "name": "open_app",
        "description": "Open an app by its bundle id, e.g. com.apple.mobilesafari, com.apple.MobileSMS, "
                       "com.apple.mobilenotes, com.apple.mobilemail, com.apple.Maps, com.apple.Preferences, "
                       "com.apple.camera, com.apple.mobilephone, com.google.chrome.ios. For an app whose id you "
                       "don't know, swipe down on the home screen and type its name.",
        "inputSchema": {"type": "object", "properties": {"bundle_id": {"type": "string"}, "screenshot": LOOK},
                        "required": ["bundle_id"]},
    },
    {
        "name": "elements",
        "description": "List what's on the phone's screen (buttons, fields, text) with the center of each, from "
                       "the accessibility tree: exact positions and labels for tap or tap_element.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "wait",
        "description": "Wait for something on the phone to load, then look again.",
        "inputSchema": {"type": "object", "properties": {
            "seconds": {"type": "number", "minimum": 0.1, "maximum": 30}, "screenshot": LOOK,
        }, "required": ["seconds"]},
    },
]
BATCHABLE = ["tap", "tap_element", "swipe", "type_text", "press_home", "open_app", "wait"]
TOOLS.append(batch_tool(BATCHABLE, '[{"tool": "tap", "x": 220, "y": 90}, {"tool": "type_text", "text": "pizza\\\\n"}]'))
INSTRUCTIONS = ("Use the user's iPhone like a person: look with screenshot, act with tap, swipe and type_text (or "
                "several at once with batch). Coordinates are points in the phone screenshots.")


def shrink(png: bytes, width: int) -> bytes:
    """The screenshot at one pixel per point, as JPEG: coordinates in it are what taps use."""
    lib = _phone_library()
    lib.agent_phone_shrink.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int64,
                                       ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_size_t)]
    lib.agent_phone_shrink.restype = ctypes.c_int
    lib.agent_phone_bytes_free.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    lib.agent_phone_bytes_free.restype = None
    data = ctypes.create_string_buffer(png, len(png))
    result, length = ctypes.c_void_p(), ctypes.c_size_t()
    status = lib.agent_phone_shrink(data, len(png), width, ctypes.byref(result), ctypes.byref(length))
    if status < 0:
        raise OSError("Phone screenshot conversion failed")
    if status:
        raise subprocess.CalledProcessError(status, "sips")
    try:
        return ctypes.string_at(result, length.value)
    finally:
        lib.agent_phone_bytes_free(result, length.value)


class PhoneTools:
    def __init__(self, phone: Phone | None = None):
        self._phone = phone

    @property
    def phone(self) -> Phone:
        if self._phone is None:
            self._phone = Phone()  # PhoneError if PHONE_RELAY isn't set: reported by call()
        return self._phone

    def look(self, note: str = "") -> dict:
        png = self.phone.screenshot()
        width, height = self.phone.size(png)
        data = base64.b64encode(shrink(png, width)).decode()
        summary = f"Phone screenshot {width}x{height} points. In front: {self.phone.front_app()}."
        return result(text(f"{note}\n{summary}" if note else summary),
                      {"type": "image", "data": data, "mimeType": "image/jpeg"})

    def act(self, args: dict, fn, done: str) -> dict:
        fn()
        if args.get("screenshot", True):
            time.sleep(SETTLE)
            return self.look(done)
        return result(text(done))

    def call(self, name: str, a: dict) -> dict:
        try:
            return self._call(name, a)
        except PhoneError as e:
            return result(text(str(e)), error=True)

    def _call(self, name: str, a: dict) -> dict:
        if name == "authenticate":
            import credentials
            if a:
                return result(text("Authentication takes no arguments; never pass a passcode."), error=True)
            try:
                return result(text(credentials.authenticate_phone(self.phone)))
            except (credentials.CredentialError, PhoneError, ValueError, OSError):
                return result(text("Phone authentication was not confirmed. Check that Pocket Connect is online, "
                                   "the device passcode is configured in Agent → Authentication, and a system passcode prompt is visible. "
                                   "Do not retry a failed attempt; check the phone yourself."), error=True)
        if name == "wait":
            time.sleep(min(30.0, float(a["seconds"])))
            return self.look() if a.get("screenshot", True) else result(text("Waited."))
        p = self.phone
        if name == "screenshot":
            return self.look()
        if name == "tap":
            return self.act(a, lambda: p.tap(float(a["x"]), float(a["y"])), f"Tapped ({a['x']}, {a['y']}).")
        if name == "tap_element":
            return self.act(a, lambda: p.tap_element(a["label"]), f"Tapped {a['label']!r}.")
        if name == "swipe":
            return self.act(a, lambda: p.swipe(float(a["from_x"]), float(a["from_y"]), float(a["to_x"]),
                                               float(a["to_y"])), "Swiped.")
        if name == "type_text":
            return self.act(a, lambda: p.type_text(a["text"]), "Typed.")
        if name == "press_home":
            return self.act(a, p.home, "Home screen.")
        if name == "open_app":
            return self.act(a, lambda: p.open_app(a["bundle_id"]), f"Opened {a['bundle_id']}.")
        if name == "elements":
            lines = p.elements()
            return result(text("\n".join(lines[:300]) if lines else "Nothing recognizable on screen."))
        if name == "batch":
            return run_batch(self, a, BATCHABLE)
        return result(text(f"Unknown tool {name!r}"), error=True)


if __name__ == "__main__":
    main(Server(PhoneTools(), TOOLS, "agent-vhid-phone", INSTRUCTIONS))
