"""Your iPhone, through the relay from the "Phone Control Automation" project: the iPhone runs
WebDriverAgent inside its controller app (started by the "Pocket Connect" Shortcut), which keeps a
connection open to a Cloudflare Worker; this asks that Worker. Works over Wi-Fi or cellular, no
cable.

    .venv/bin/python python/phone.py            # is the phone connected?

  PHONE_RELAY   the relay's folder: endpoint.txt has its address, private/secrets.json its
                CONTROL_TOKEN (read when needed, never printed or passed on the command line)
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

OFFLINE = ("The iPhone isn't connected to its relay. On the iPhone (unlocked), run the Shortcut "
           "“Pocket Connect” to start its controller, then try again.")


class PhoneError(Exception):
    pass


_library = None


def _phone_library():
    global _library
    if _library is None:
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "libagent-core.dylib")
        try:
            lib = ctypes.CDLL(path)
            lib.agent_phone_call.argtypes = [ctypes.c_char_p]
            lib.agent_phone_call.restype = ctypes.c_void_p
            lib.agent_phone_free.argtypes = [ctypes.c_void_p]
            lib.agent_phone_free.restype = None
        except (OSError, AttributeError) as e:
            raise PhoneError("Phone relay transport is unavailable; build the Rust agent core.") from e
        _library = lib
    return _library


class Phone:
    def __init__(self, folder: str | None = None):
        self.folder = folder or os.environ.get("PHONE_RELAY", "")
        if not self.folder:
            raise PhoneError("Phone control isn't set up: PHONE_RELAY (in .env) isn't set.")
        try:
            with open(os.path.join(self.folder, "endpoint.txt")) as f:
                self.base = f.read().strip().rstrip("/")
        except OSError as e:
            raise PhoneError(f"Phone control isn't set up: can't read the relay's endpoint.txt ({e.strerror}).")
        self._session: str | None = None
        self._size: tuple[int, int] | None = None  # points

    def _secrets(self) -> dict:
        with open(os.path.join(self.folder, "private", "secrets.json")) as f:
            return json.load(f)

    def _call(self, operation, path="", method="GET", body=None, *, sensitive=False):
        library = _phone_library()
        payload = json.dumps({"operation": operation, "folder": self.folder, "base": self.base,
                              "session": self._session, "path": path, "method": method,
                              "body": body, "sensitive": sensitive}).encode()
        result = library.agent_phone_call(payload)
        if not result:
            raise PhoneError("The phone relay transport failed.")
        try:
            response = json.loads(ctypes.string_at(result))
        finally:
            library.agent_phone_free(result)
        self._session = response.get("session")
        if "error" in response:
            raise PhoneError(response["error"])
        return response["value"]

    def request(self, path: str, method: str = "GET", body=None, *, sensitive=False) -> dict:
        return self._call("request", path, method, body, sensitive=sensitive)

    def connected(self) -> bool:
        return bool(self.request("/health").get("connected"))

    def session(self) -> str:
        return self._call("session")

    def in_session(self, path: str, method: str = "GET", body=None) -> dict:
        return self._call("in_session", path, method, body)

    # -- seeing --

    def screenshot(self) -> bytes:
        """PNG, in pixels (3 per point on most iPhones)."""
        return base64.b64decode(self.request("/api/screenshot")["value"])

    def size(self, png: bytes | None = None) -> tuple[int, int]:
        """The screen in points, which taps use. Asked again if the screenshot's shape changes (rotated)."""
        if png and self._size:
            w, h = int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
            if (w > h) != (self._size[0] > self._size[1]):
                self._size = None
        if not self._size:
            value = self.in_session("/window/size")["value"]
            self._size = (int(value["width"]), int(value["height"]))
        return self._size

    def front_app(self) -> str:
        try:
            value = self.request("/api/wda/activeAppInfo")["value"]
            return f"{value.get('name') or '?'} ({value.get('bundleId')})"
        except (PhoneError, KeyError, TypeError):
            return "unknown"

    def elements(self) -> list[str]:
        """The visible things on screen: '(x, y) Button "Send"', with x, y its center in points."""
        source = self.in_session("/source")["value"]
        try:
            return self._call("visible_elements", body={"source": source})
        except PhoneError as e:
            if str(e) == "Phone accessibility XML requires Python parsing":
                return self._elements_compat(source)
            if str(e) == "Invalid phone accessibility XML":
                raise ET.ParseError(str(e)) from e
            raise

    def _elements_compat(self, source: str) -> list[str]:
        # ElementTree resolves namespace names and internal DTD entities as before.
        try:
            for secret in self._secrets().values():
                if isinstance(secret, str) and len(secret) >= 16:
                    source = source.replace(secret, "[hidden]")
        except (OSError, ValueError):
            pass
        out = []
        for e in ET.fromstring(source).iter():
            a = e.attrib
            if a.get("visible") != "true" or e.tag in ("AppiumAUT", "XCUIElementTypeApplication",
                                                       "XCUIElementTypeWindow"):
                continue
            label = a.get("label") or a.get("name") or ""
            if e.tag == "XCUIElementTypeOther" and not label:
                continue
            try:
                x, y = float(a["x"]) + float(a["width"]) / 2, float(a["y"]) + float(a["height"]) / 2
            except (KeyError, ValueError):
                continue
            kind = e.tag.removeprefix("XCUIElementType")
            line = f"({x:.0f}, {y:.0f}) {kind} {json.dumps(label[:120], ensure_ascii=False)}"
            value = a.get("value")
            if value and value != label and "Secure" not in kind:
                line += f" value={json.dumps(value[:120], ensure_ascii=False)}"
            out.append(line)
        return out

    # -- acting --

    def _action(self, name: str, **args):
        plan = self._call("action_plan", body={"name": name, "args": args})
        send = self.in_session if plan["in_session"] else self.request
        send(plan["path"], "POST", plan["body"])

    def tap(self, x: float, y: float):
        self._action("tap", x=float(x), y=float(y))

    def tap_element(self, label: str):
        literal = json.dumps(label)
        element = self._call("tap_element", body={"label": label, "literal": literal})
        if not element or not re.fullmatch(r"[\w-]+", element):
            raise PhoneError(f"Nothing called {literal} on screen.")
        self.in_session(f"/element/{element}/click", "POST", {})

    def swipe(self, from_x: float, from_y: float, to_x: float, to_y: float, seconds: float = 0.3):
        self._action("swipe", from_x=from_x, from_y=from_y, to_x=to_x, to_y=to_y, seconds=seconds)

    def type_text(self, text: str):
        self._action("type_text", text=text)

    def home(self):
        self._action("home")

    def open_app(self, bundle_id: str):
        if not re.fullmatch(r"[-\w.]{3,200}", bundle_id):
            raise PhoneError(f"{bundle_id!r} isn't an app's bundle id (like com.apple.mobilesafari).")
        self._action("open_app", bundle_id=bundle_id)


def main() -> int:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import settings
    settings.load()
    try:
        phone = Phone()
        if not phone.connected():
            print(OFFLINE)
            return 1
        print(f"Connected. Screen {phone.size()[0]}x{phone.size()[1]} points; in front: {phone.front_app()}.")
    except PhoneError as e:
        print(e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
