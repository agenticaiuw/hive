"""What's open on the Mac: every window, front to back, with its app and title, and the tabs open
in Safari and Chrome. The agent gets this with its first look at each task, so when you name a
document or a page ("the GSSF presentation") it can find it even when it's behind the window in
front, and switch to it instead of opening it again.

Window titles come from CoreGraphics. macOS only shows other apps' titles to an app allowed to
record the screen, which the agent's screenshots need anyway. Browser tabs come from AppleScript:
macOS asks once per browser whether the app the agent runs in may control it (Privacy & Security
› Automation). Addresses are cut to the page, without the ?query or #fragment, which can hold
sign-in codes.

    python3 python/desktop.py     prints what the agent would be told
"""

from __future__ import annotations

import ctypes
import json
import subprocess
import sys
from typing import NamedTuple
from urllib.parse import urlsplit

_cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
_cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
_cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
_cf.CFArrayGetCount.restype = ctypes.c_long
_cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
_cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
_cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
_cf.CFDictionaryGetValue.restype = ctypes.c_void_p
_cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_cf.CFStringCreateWithCString.restype = ctypes.c_void_p
_cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
_cf.CFStringGetCString.restype = ctypes.c_bool
_cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
_cf.CFNumberGetValue.restype = ctypes.c_bool
_cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
_cf.CFBooleanGetValue.restype = ctypes.c_bool
_cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
_cf.CFRelease.argtypes = [ctypes.c_void_p]

UTF8 = 0x08000100
ALL, ON_SCREEN_ONLY, EXCLUDE_DESKTOP = 0, 1 << 0, 1 << 4
DOUBLE = 13  # kCFNumberDoubleType
NOT_WINDOWS = {"Window Server", "Dock", "Control Center", "Notification Center", "Spotlight", "SystemUIServer",
               "WindowManager", "agent-vhid-captions", "Wallpaper"}
BROWSERS = ["Safari", "Google Chrome"]
MOST_TABS = 60


class Window(NamedTuple):
    app: str
    title: str
    on_screen: bool  # False: minimized, hidden, or on another desktop
    pid: int


def _key(name: str) -> int:
    return _cf.CFStringCreateWithCString(None, name.encode(), UTF8)


_KEYS = {name: _key(name) for name in ("kCGWindowOwnerName", "kCGWindowName", "kCGWindowLayer",
                                       "kCGWindowIsOnscreen", "kCGWindowOwnerPID", "kCGWindowBounds",
                                       "Width", "Height")}


def _string(ref) -> str:
    if not ref:
        return ""
    buffer = ctypes.create_string_buffer(4096)
    return buffer.value.decode("utf-8", "replace") if _cf.CFStringGetCString(ref, buffer, 4096, UTF8) else ""


def _number(ref) -> float:
    value = ctypes.c_double(0)
    if ref:
        _cf.CFNumberGetValue(ref, DOUBLE, ctypes.byref(value))
    return value.value


def windows() -> list[Window]:
    """The apps' windows, front to back: the ones on screen first, then the rest. Windows without a
    title are left out unless they're on screen and big enough to be a real window."""
    found: list[Window] = []
    listed = _cg.CGWindowListCopyWindowInfo(ALL | EXCLUDE_DESKTOP, 0)  # front to back
    if not listed:
        return found
    try:
        for i in range(_cf.CFArrayGetCount(listed)):
            info = _cf.CFArrayGetValueAtIndex(listed, i)
            get = lambda key: _cf.CFDictionaryGetValue(info, _KEYS[key])
            app = _string(get("kCGWindowOwnerName"))
            if _number(get("kCGWindowLayer")) != 0 or not app or app in NOT_WINDOWS:
                continue
            title = _string(get("kCGWindowName"))
            on_screen = bool(get("kCGWindowIsOnscreen")) and _cf.CFBooleanGetValue(get("kCGWindowIsOnscreen"))
            bounds = get("kCGWindowBounds")
            width = _number(_cf.CFDictionaryGetValue(bounds, _KEYS["Width"])) if bounds else 0
            height = _number(_cf.CFDictionaryGetValue(bounds, _KEYS["Height"])) if bounds else 0
            if not title and (not on_screen or width < 200 or height < 100):
                continue
            found.append(Window(app, title, on_screen, int(_number(get("kCGWindowOwnerPID")))))
    finally:
        _cf.CFRelease(listed)
    return sorted(found, key=lambda w: not w.on_screen)  # stable: each group stays front to back


def front_window(app: str) -> Window | None:
    """The app's window that's in front of its others, if it has one on screen."""
    return next((w for w in windows() if w.app == app and w.on_screen), None)


# JavaScript for Automation: a window's tab titles and addresses take one Apple event each. A window
# without tabs (Settings, Downloads) is skipped.
TABS_SCRIPT = """
function run(argv) {
  const out = {};
  for (const name of argv) {
    try {
      const app = Application(name);
      if (!app.running()) continue;
      const safari = name === "Safari";
      out[name] = [];
      for (const w of app.windows()) {
        try {
          const titles = safari ? w.tabs.name() : w.tabs.title();
          const urls = w.tabs.url();
          let current = null;
          try { current = safari ? w.currentTab.index() : w.activeTabIndex(); } catch (e) {}
          out[name].push({current: current, tabs: titles.map((t, i) => [t, urls[i]])});
        } catch (e) {}
      }
    } catch (e) {
      out[name] = {error: String(e)};
    }
  }
  return JSON.stringify(out);
}
"""


def page(url: str | None) -> str:
    """The address without its ?query and #fragment."""
    if not url:
        return ""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.netloc else url.split("?")[0].split("#")[0]


def browser_tabs(shown: list[Window] | None = None, timeout: float = 1.5) -> dict[str, list[dict]]:
    """{browser: [{'current': index (1-based), 'tabs': [(title, address), ...]}, one per window]} for
    the browsers with windows open (in `shown`, else now). A browser macOS hasn't let us control
    yet is left out; so is everything if macOS is still asking (the request carries on without it)."""
    apps = {w.app for w in (windows() if shown is None else shown)}
    running = [b for b in BROWSERS if b in apps]
    if not running:
        return {}
    try:
        out = subprocess.run(["osascript", "-l", "JavaScript", "-e", TABS_SCRIPT, *running],
                             capture_output=True, text=True, timeout=timeout).stdout
        found = json.loads(out or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}
    return {b: [{"current": w.get("current"), "tabs": [(t or "", page(u)) for t, u in w.get("tabs", [])]}
                for w in ws] for b, ws in found.items() if isinstance(ws, list)}


def describe(shown: list[Window], tabs: dict[str, list[dict]]) -> str:
    """The windows and tabs as lines for the agent's request."""
    if not shown:
        return "Open windows: none found (or macOS hides their titles from this app)."
    lines = ["Open windows, front to back (app: title):"]
    for w in shown:
        where = "" if w.on_screen else "   [not on screen: minimized, hidden or on another desktop]"
        lines.append(f"  - {w.app}: {json.dumps(w.title, ensure_ascii=False) if w.title else '(no title)'}{where}")
    listed = 0
    for browser, browser_windows in tabs.items():
        for n, bw in enumerate(browser_windows, 1):
            if not bw["tabs"]:
                continue
            lines.append(f"{browser} window {n} tabs (* = the one showing):")
            for i, (title, url) in enumerate(bw["tabs"], 1):
                if listed == MOST_TABS:
                    lines.append("  ... (more tabs not listed)")
                    return "\n".join(lines)
                mark = "*" if i == bw["current"] else " "
                lines.append(f"  {mark} {json.dumps(title[:100], ensure_ascii=False)} {url[:120]}".rstrip())
                listed += 1
    return "\n".join(lines)


def summary() -> str:
    shown = windows()
    return describe(shown, browser_tabs(shown))


if __name__ == "__main__":
    if "-h" in sys.argv or "--help" in sys.argv:
        print(__doc__)
    else:
        print(summary())
