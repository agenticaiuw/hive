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
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

OFFLINE = ("The iPhone isn't connected to its relay. On the iPhone (unlocked), run the Shortcut "
           "“Pocket Connect” to start its controller, then try again.")


class PhoneError(Exception):
    pass


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

    def request(self, path: str, method: str = "GET", body=None) -> dict:
        config = f'header = "Authorization: Bearer {self._secrets()["CONTROL_TOKEN"]}"\n'  # stdin, not argv
        command = ["curl", "--ipv4", "--http1.1", "--connect-timeout", "8", "--max-time", "35", "--silent",
                   "--show-error", "--user-agent", "Mozilla/5.0", "--config", "-", "--request", method,
                   "--header", "Content-Type: application/json", "--write-out", "\n%{http_code}"]
        if body is not None:
            command += ["--data-binary", json.dumps(body)]
        for attempt in range(5):
            run = subprocess.run(command + [self.base + path], input=config, text=True, capture_output=True)
            if run.returncode == 35 and attempt < 2:  # TLS handshake failed: nothing was sent
                time.sleep(0.4)
                continue
            if run.returncode != 0:
                raise PhoneError(f"Can't reach the phone's relay ({run.stderr.strip() or run.returncode}).")
            reply, status = run.stdout.rsplit("\n", 1)
            try:
                value = json.loads(reply)
            except json.JSONDecodeError:
                raise PhoneError(f"The relay answered HTTP {status}: {reply[:200]}")
            if status == "429" and attempt < 4:  # busy: a few requests already in flight
                time.sleep(0.5 * (attempt + 1))
                continue
            if status == "503":
                raise PhoneError(OFFLINE)
            if status == "504":
                raise PhoneError("The iPhone didn't answer in time. Is it unlocked, with its controller app running?")
            if int(status) >= 400:
                raise PhoneError(f"The relay said HTTP {status}: {value.get('error', value)}")
            error = value.get("value") if isinstance(value.get("value"), dict) else {}
            if error.get("error"):
                raise PhoneError(f"{error['error']}: {error.get('message', '')}".strip(": "))
            return value
        raise PhoneError("The phone's relay stayed busy.")

    def connected(self) -> bool:
        return bool(self.request("/health").get("connected"))

    # -- the WebDriverAgent session --

    def session(self) -> str:
        if not self._session:
            sid = self.request("/api/status").get("sessionId")
            if not sid:
                made = self.request("/api/session", "POST",
                                    {"capabilities": {"alwaysMatch": {"shouldWaitForQuiescence": False}}})
                sid = made.get("sessionId") or (made.get("value") or {}).get("sessionId")
            if not sid:
                raise PhoneError("The iPhone's controller has no session; run “Pocket Connect” again.")
            self._session = sid
            try:  # don't wait for animations to finish before acting
                self.request(f"/api/session/{sid}/appium/settings", "POST",
                             {"settings": {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0}})
            except PhoneError:
                pass
        return f"/api/session/{self._session}"

    def in_session(self, path: str, method: str = "GET", body=None) -> dict:
        try:
            return self.request(self.session() + path, method, body)
        except PhoneError as e:
            if "session" not in str(e).lower():
                raise
            self._session = None  # it expired: start another and try once more
            return self.request(self.session() + path, method, body)

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
        try:  # a settings page can show the relay's own token: never pass it on
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

    def tap(self, x: float, y: float):
        self.in_session("/wda/tap", "POST", {"x": float(x), "y": float(y)})

    def tap_element(self, label: str):
        literal = json.dumps(label)
        try:
            found = self.in_session("/element", "POST", {"using": "accessibility id", "value": label})["value"]
        except PhoneError as e:
            if "unable to find" not in str(e).lower() and "no such element" not in str(e).lower():
                raise
            found = self.in_session("/element", "POST", {"using": "predicate string",
                                                          "value": f"name == {literal} OR label == {literal}"})["value"]
        element = found.get("ELEMENT") or found.get("element-6066-11e4-a52e-4f735466cecf")
        if not element or not re.fullmatch(r"[\w-]+", element):
            raise PhoneError(f"Nothing called {literal} on screen.")
        self.in_session(f"/element/{element}/click", "POST", {})

    def swipe(self, from_x: float, from_y: float, to_x: float, to_y: float, seconds: float = 0.3):
        self.in_session("/wda/dragfromtoforduration", "POST",
                        {"fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y, "duration": seconds})

    def type_text(self, text: str):
        self.in_session("/wda/keys", "POST", {"value": [text]})

    def home(self):
        self.request("/api/wda/homescreen", "POST", {})

    def open_app(self, bundle_id: str):
        if not re.fullmatch(r"[-\w.]{3,200}", bundle_id):
            raise PhoneError(f"{bundle_id!r} isn't an app's bundle id (like com.apple.mobilesafari).")
        self.in_session("/wda/apps/activate", "POST", {"bundleId": bundle_id})


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
