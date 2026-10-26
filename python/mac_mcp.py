"""MCP server that lets an AI agent (Codex, Claude Code, ...) use this Mac the way a person does:
screenshots to see, and the real mouse and keyboard (through agent-vhid-helper) to act.

    codex exec -c mcp_servers.mac.command=python3 \\
               -c 'mcp_servers.mac.args=["/path/to/mac_mcp.py"]' "open Calculator"

Every coordinate is a pixel in the screenshot images this server returns. When the
human touches a key, the trackpad or a mouse, actions stop and the tools tell the
model to wait for control instead of fighting for it.

Speaks MCP over stdio (one JSON-RPC message per line). No third-party packages.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_vhid import (  # noqa: E402
    AgentVHID, AgentVHIDError, Disengaged, Screenshot, TextBox, cursor_position, main_display_bounds,
)

PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
MAX_WIDTH = 1440  # one image pixel per screen point on most Mac displays
SETTLE = 0.6  # seconds the screen gets to catch up before the screenshot that follows an action
HUMAN_SOURCES = {"keyboard", "trackpad", "mouse", "mouse_button"}

LOOK = {"type": "boolean", "default": True,
        "description": "Return a screenshot taken just after the action (default true)."}


def point(desc: str) -> dict:
    return {"type": "number", "description": desc}


TOOLS = [
    {
        "name": "screenshot",
        "description": "See the screen. Returns an image of the main display with the mouse pointer drawn in. "
                       "Every x/y in the other tools is a pixel in this image.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "click",
        "description": "Move the mouse to (x, y) like a person and click. clicks=2 double-clicks, 3 triple-clicks.",
        "inputSchema": {"type": "object", "properties": {
            "x": point("Pixel x in the latest screenshot"),
            "y": point("Pixel y in the latest screenshot"),
            "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
            "clicks": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1},
            "modifiers": {"type": "string", "description": "Keys held during the click, like 'cmd' or 'shift+cmd'."},
            "screenshot": LOOK,
        }, "required": ["x", "y"]},
    },
    {
        "name": "move_mouse",
        "description": "Move the mouse to (x, y) without clicking, e.g. to open a hover menu or show a tooltip.",
        "inputSchema": {"type": "object", "properties": {
            "x": point("Pixel x"), "y": point("Pixel y"), "screenshot": LOOK,
        }, "required": ["x", "y"]},
    },
    {
        "name": "drag",
        "description": "Press the left button at one point, move to another, and let go (move files, select text, "
                       "resize windows).",
        "inputSchema": {"type": "object", "properties": {
            "from_x": point("Start x"), "from_y": point("Start y"),
            "to_x": point("End x"), "to_y": point("End y"), "screenshot": LOOK,
        }, "required": ["from_x", "from_y", "to_x", "to_y"]},
    },
    {
        "name": "scroll",
        "description": "Scroll the area under (x, y). down > 0 reveals content further down, down < 0 goes back "
                       "up; likewise right. One notch is roughly three lines of text.",
        "inputSchema": {"type": "object", "properties": {
            "x": point("Pixel x of the area to scroll"), "y": point("Pixel y of the area to scroll"),
            "down": {"type": "integer", "minimum": -50, "maximum": 50, "default": 0},
            "right": {"type": "integer", "minimum": -50, "maximum": 50, "default": 0},
            "screenshot": LOOK,
        }, "required": ["x", "y"]},
    },
    {
        "name": "type_text",
        "description": "Type text on the keyboard into whatever has focus (click the field first). "
                       "'\\n' presses Return. Emoji and other characters a US keyboard can't type are pasted.",
        "inputSchema": {"type": "object", "properties": {
            "text": {"type": "string"}, "screenshot": LOOK,
        }, "required": ["text"]},
    },
    {
        "name": "press_key",
        "description": "Press a key or shortcut, e.g. 'return', 'escape', 'tab', 'cmd+t', 'cmd+shift+4', 'cmd+l', "
                       "'up', 'pagedown', 'delete' (backspace), 'forwarddelete', 'f5'. Modifiers: cmd, ctrl, "
                       "alt/option, shift.",
        "inputSchema": {"type": "object", "properties": {
            "keys": {"type": "string"},
            "repeat": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
            "screenshot": LOOK,
        }, "required": ["keys"]},
    },
    {
        "name": "open_app",
        "description": "Open an app (or a System Settings pane, file, or anything Spotlight finds) by typing its "
                       "name into Spotlight and pressing Return.",
        "inputSchema": {"type": "object", "properties": {
            "name": {"type": "string"}, "screenshot": LOOK,
        }, "required": ["name"]},
    },
    {
        "name": "find_text",
        "description": "Find a word or phrase on screen with on-device text recognition and return the exact "
                       "center of each match. More precise than estimating from the screenshot, especially for "
                       "small buttons, menu items and links.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "read_screen",
        "description": "Read all the text on screen with on-device text recognition, line by line, each with "
                       "the pixel center of the line. Good for small print the screenshot shows poorly.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "wait",
        "description": "Wait for something to load or finish, then look again.",
        "inputSchema": {"type": "object", "properties": {
            "seconds": {"type": "number", "minimum": 0.1, "maximum": 30}, "screenshot": LOOK,
        }, "required": ["seconds"]},
    },
    {
        "name": "wait_for_control",
        "description": "Use when a tool says the user has control. Waits until they hand it back (they "
                       "double-tap Right Option), then returns a fresh screenshot.",
        "inputSchema": {"type": "object", "properties": {
            "timeout_seconds": {"type": "number", "minimum": 5, "maximum": 600, "default": 120},
        }},
    },
    {
        "name": "read_clipboard",
        "description": "Return the text on the clipboard, e.g. after copying something with cmd+c.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def geometry() -> Screenshot:
    """How screenshot pixels map to screen points. Fixed for a given display setup."""
    ox, oy, w, h = main_display_bounds()
    width = int(min(w, MAX_WIDTH))
    return Screenshot("", width, round(h * width / w), w / width, (ox, oy))


def frontmost_app() -> str:
    try:
        asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=2).stdout.strip()
        out = subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True,
                             timeout=2).stdout
        m = re.search(r'="([^"]*)"', out)
        return m.group(1) if m else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def notify(message: str):
    subprocess.Popen(["osascript", "-e", f"display notification {json.dumps(message)} with title \"Agent\""],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def result(*content: dict, error: bool = False) -> dict:
    return {"content": list(content), "isError": error}


class MacTools:
    def __init__(self):
        self.mac = AgentVHID(speed=1.3)

    # -- seeing --

    def look(self, note: str = "") -> dict:
        g = geometry()
        fd, png = tempfile.mkstemp(prefix="mac-mcp-", suffix=".png")
        os.close(fd)
        jpg = png[:-4] + ".jpg"
        try:
            subprocess.run(["screencapture", "-x", "-m", "-C", "-t", "png", png], check=True)
            subprocess.run(["sips", "--resampleWidth", str(g.width), "-s", "format", "jpeg",
                            "-s", "formatOptions", "70", png, "--out", jpg], check=True, capture_output=True)
            with open(jpg, "rb") as f:
                data = base64.b64encode(f.read()).decode()
        finally:
            for path in (png, jpg):
                if os.path.exists(path):
                    os.unlink(path)
        cx, cy = g.from_screen(*cursor_position())
        summary = (f"Screenshot {g.width}x{g.height} px. Mouse pointer at ({cx:.0f}, {cy:.0f}). "
                   f"Frontmost app: {frontmost_app()}.")
        return result(text(f"{note}\n{summary}" if note else summary),
                      {"type": "image", "data": data, "mimeType": "image/jpeg"})

    def boxes(self) -> list[TextBox]:
        """Words on screen, with positions converted to screenshot pixels."""
        g = geometry()
        out = []
        for b in self.mac.read_screen():
            x, y = g.from_screen(b.x, b.y)
            out.append(TextBox(b.text, b.line, b.confidence, x, y, b.w / g.scale, b.h / g.scale))
        return out

    # -- acting --

    def act(self, args: dict, fn, done: str) -> dict:
        try:
            if self.mac.status().get("state") == "arming":
                self.mac.wait_engaged(timeout=3, announce=False)  # control is on its way
            fn()
        except Disengaged as e:
            m = re.search(r"reason=([\w-]+)", str(e))
            reason = m.group(1) if m else "unknown"
            if reason in HUMAN_SOURCES or reason.startswith("engage_cancelled"):
                msg = (f"Stopped: the user took over ({reason.replace('_', ' ')}). Don't keep trying. Call "
                       "wait_for_control, then look at the new screenshot before continuing; things may have "
                       "changed.")
            else:
                msg = ("You don't have the mouse and keyboard: the user hasn't handed control over "
                       f"(reason: {reason}). Call wait_for_control.")
            return result(text(msg), error=True)
        except (AgentVHIDError, ValueError) as e:
            return result(text(f"Failed: {e}"), error=True)
        if args.get("screenshot", True):
            time.sleep(SETTLE)
            return self.look(done)
        return result(text(done))

    def call(self, name: str, a: dict) -> dict:
        g = geometry()

        def at(x_key="x", y_key="y"):
            return g.to_screen(float(a[x_key]), float(a[y_key]))

        if name == "screenshot":
            return self.look()
        if name == "click":
            x, y = at()
            clicks = int(a.get("clicks", 1))
            return self.act(a, lambda: self.mac.click(x, y, a.get("button", "left"), clicks, a.get("modifiers")),
                            f"Clicked ({a['x']}, {a['y']}).")
        if name == "move_mouse":
            x, y = at()
            return self.act(a, lambda: self.mac.move_to(x, y), f"Mouse at ({a['x']}, {a['y']}).")
        if name == "drag":
            x1, y1 = at("from_x", "from_y")
            x2, y2 = at("to_x", "to_y")
            return self.act(a, lambda: self.mac.drag(x1, y1, x2, y2), "Dragged.")
        if name == "scroll":
            x, y = at()
            return self.act(a, lambda: self.mac.scroll(int(a.get("down", 0)), int(a.get("right", 0)), x, y),
                            "Scrolled.")
        if name == "type_text":
            return self.act(a, lambda: self.mac.type_text(a["text"]), "Typed.")
        if name == "press_key":
            def press():
                for _ in range(int(a.get("repeat", 1))):
                    self.mac.key(a["keys"])
            return self.act(a, press, f"Pressed {a['keys']}.")
        if name == "open_app":
            def spotlight():
                self.mac.key("cmd+space")
                time.sleep(0.7)
                self.mac.type_text(a["name"])
                time.sleep(1.0)
                self.mac.key("return")
                time.sleep(1.2)
            return self.act(a, spotlight, f"Opened {a['name']!r} from Spotlight.")
        if name == "wait":
            time.sleep(min(30.0, float(a["seconds"])))
            return self.look() if a.get("screenshot", True) else result(text("Waited."))
        if name == "wait_for_control":
            timeout = float(a.get("timeout_seconds", 120))
            if self.mac.status().get("state") != "engaged":
                notify("Paused. Double-tap Right Option to let it continue.")
            if self.mac.wait_engaged(timeout=timeout, announce=False):
                return self.look("You have control again. The user may have changed things; "
                                 "check this screenshot before continuing.")
            return result(text(f"The user hasn't handed control back after {timeout:.0f} s. Stop and say "
                               "where you got to."), error=True)
        if name == "find_text":
            return self.find_text(a["text"])
        if name == "read_screen":
            return self.read_screen()
        if name == "read_clipboard":
            clip = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
            return result(text(clip[:8000] if clip else "(the clipboard has no text)"))
        return result(text(f"Unknown tool {name!r}"), error=True)

    def find_text(self, phrase: str) -> dict:
        words = phrase.lower().split()
        if not words:
            return result(text("Give some text to find."), error=True)
        boxes = self.boxes()
        matches = []
        for i, b in enumerate(boxes):
            run = boxes[i:i + len(words)]
            if len(run) == len(words) and all(r.line == b.line for r in run) and \
                    [r.text.lower().strip(".,:;!?") for r in run] == words:
                left, top = run[0].x, min(r.y for r in run)
                right, bottom = max(r.x + r.w for r in run), max(r.y + r.h for r in run)
                matches.append(((left + right) / 2, (top + bottom) / 2, b.line))
        partial = False
        if not matches:  # fall back to lines that contain the phrase
            partial = True
            seen = set()
            for b in boxes:
                if phrase.lower() in b.line.lower() and (b.line, round(b.y / 8)) not in seen:
                    seen.add((b.line, round(b.y / 8)))
                    line = [r for r in boxes if r.line == b.line and abs(r.y - b.y) < 8]
                    hits = [r for r in line if words[0] in r.text.lower()] or line
                    matches.append((hits[0].x + hits[0].w / 2, hits[0].y + hits[0].h / 2, b.line))
        if not matches:
            return result(text(f"{phrase!r} is not visible on screen (text recognition found no match)."))
        lines = [f"({x:.0f}, {y:.0f})  in line: {line!r}" for x, y, line in matches[:12]]
        head = "No exact match; lines containing it:" if partial else f"Found {phrase!r} at:"
        return result(text(head + "\n" + "\n".join(lines)))

    def read_screen(self) -> dict:
        lines: dict[tuple[str, int], list[TextBox]] = {}
        for b in self.boxes():
            lines.setdefault((b.line, round(b.y / 6)), []).append(b)
        out = []
        for (line, _), words in lines.items():
            left, top = min(w.x for w in words), min(w.y for w in words)
            right, bottom = max(w.x + w.w for w in words), max(w.y + w.h for w in words)
            out.append(f"({(left + right) / 2:.0f}, {(top + bottom) / 2:.0f}) {line}")
        if not out:
            return result(text("No text recognized on screen."))
        return result(text("\n".join(out[:400])))


class Server:
    def __init__(self):
        self.tools = MacTools()

    def handle(self, msg: dict) -> dict | None:
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:
            return None  # notifications: initialized, cancelled, ...
        try:
            if method == "initialize":
                asked = msg.get("params", {}).get("protocolVersion")
                return self.reply(msg_id, {
                    "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "agent-vhid-mac", "version": "1.0"},
                    "instructions": "Use this Mac like a person: look with screenshot, act with click, "
                                    "type_text and press_key. Coordinates are screenshot pixels. If a tool "
                                    "says the user took over, call wait_for_control.",
                })
            if method == "ping":
                return self.reply(msg_id, {})
            if method == "tools/list":
                return self.reply(msg_id, {"tools": TOOLS})
            if method == "tools/call":
                params = msg.get("params", {})
                try:
                    return self.reply(msg_id, self.tools.call(params.get("name", ""), params.get("arguments") or {}))
                except Exception as e:  # report to the model instead of failing the call
                    traceback.print_exc(file=sys.stderr)
                    return self.reply(msg_id, result(text(f"Tool error: {e}"), error=True))
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"no method {method}"}}
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(e)}}

    @staticmethod
    def reply(msg_id, res: dict) -> dict:
        return {"jsonrpc": "2.0", "id": msg_id, "result": res}


def main():
    server = Server()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            if isinstance(msg, list):
                reply = [r for r in (server.handle(m) for m in msg) if r is not None] or None
            else:
                reply = server.handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
