"""Tools that let an AI agent use this Mac the way a person does: screenshots to see, and the
real mouse and keyboard (through agent-vhid-helper) to act. agent.py hands them (MacTools, TOOLS)
straight to Codex; run as a script, this is an MCP server for any other agent (Codex, Claude
Code, ...):

    codex exec -c mcp_servers.mac.command=python3 \\
               -c 'mcp_servers.mac.args=["/path/to/mac_mcp.py"]' "open Calculator"

Every coordinate is a pixel in the screenshot images this server returns. The tools take the
mouse and keyboard only for screen actions and let go of them when the agent turns to other work
(the shell, thinking), so the user can use their Mac meanwhile. When the user touches a key, the
trackpad or a mouse while the agent has them, screen actions stop until they press fn; the tools
tell the model to carry on with work that doesn't need the screen.

Every action that changes something carries a `step`: one sentence, shown to the user, of what it
does. A step that can't be undone (it sends something others will see, deletes, pays or publishes)
begins with "One-way:" and quotes the user's words that ask for it; the tools refuse it when those
words aren't in what the user said (`words`).

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
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import desktop  # noqa: E402
import ingest  # noqa: E402
import virtual_monitor  # noqa: E402
from agent_vhid import (  # noqa: E402
    AgentVHID, AgentVHIDError, Disengaged, Screenshot, TextBox, capture_args, cursor_position, work_display_bounds,
)

PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
MAX_WIDTH = 1440  # one image pixel per screen point on most Mac displays
SETTLE = 0.3  # seconds the screen gets to catch up before the screenshot that follows an action
HUMAN_SOURCES = {"keyboard", "trackpad", "mouse", "mouse_button"}
IDLE_RELEASE = 10.0  # seconds without a screen action after which the agent lets go of the mouse and keyboard
ENGAGE_WAIT = 5.0  # how long a screen action waits for the user's hands to be off the keyboard and trackpad

LOOK = {"type": "boolean", "default": True,
        "description": "Return a screenshot taken just after the action (default true)."}
STEP = {"type": "string", "description": (
    "Shown to the user as you act: one short sentence of what this does, e.g. \"Opening the #general "
    "channel.\" If it can't be undone (it sends or posts something others will see, deletes data, pays "
    "or publishes), begin with \"One-way:\" and quote the user's own words that ask for it, e.g. "
    "\"One-way: posting your message in #general (you said: \\\"send the backup to the general "
    "channel\\\").\"")}


def point(desc: str) -> dict:
    return {"type": "number", "description": desc}


TOOLS = [
    {
        "name": "read_selected_text",
        "description": "Read the entire text currently selected in the focused app directly into this conversation. "
                       "Does not change the clipboard. If the app does not expose the selection, reports that; "
                       "never reads secure password fields. Selections over 500 KB are explicitly refused.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "authenticate",
        "description": "Types the user's saved Mac password into the field that has the keyboard focus and presses "
                       "Return, the way the user would. Click the password field first (for example the "
                       "Passwords/AutoFill prompt's field). Takes no arguments; the password never reaches you. "
                       "Take a screenshot afterwards to see the result.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
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
            "step": STEP, "screenshot": LOOK,
        }, "required": ["step", "x", "y"]},
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
            "to_x": point("End x"), "to_y": point("End y"), "step": STEP, "screenshot": LOOK,
        }, "required": ["step", "from_x", "from_y", "to_x", "to_y"]},
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
            "text": {"type": "string"}, "step": STEP, "screenshot": LOOK,
        }, "required": ["step", "text"]},
    },
    {
        "name": "press_key",
        "description": "Press a key or shortcut, e.g. 'return', 'escape', 'tab', 'cmd+t', 'cmd+shift+4', 'cmd+l', "
                       "'up', 'pagedown', 'delete' (backspace), 'forwarddelete', 'f5'. Modifiers: cmd, ctrl, "
                       "alt/option, shift.",
        "inputSchema": {"type": "object", "properties": {
            "keys": {"type": "string"},
            "repeat": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
            "step": STEP, "screenshot": LOOK,
        }, "required": ["step", "keys"]},
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
        "description": "Use when a tool says the user has the mouse and keyboard and the screen is the only "
                       "way forward (do everything else first). Waits until they hand it back (they press fn or "
                       "say \"continue\"), then returns a fresh screenshot.",
        "inputSchema": {"type": "object", "properties": {
            "timeout_seconds": {"type": "number", "minimum": 5, "maximum": 600, "default": 120},
        }},
    },
    {
        "name": "read_clipboard",
        "description": "Return the text on the clipboard, e.g. after copying something with cmd+c: up to "
                       "8,000 characters from offset, saying how long it is when there's more.",
        "inputSchema": {"type": "object", "properties": {
            "offset": {"type": "integer", "minimum": 0, "default": 0},
        }},
    },
    {
        "name": "read_ingested",
        "description": "Read a part of a text the user added with Add to Context (a transcript, say) that was "
                       "too long to keep in the conversation. Its id and number of parts were given when it "
                       "was added; an empty id means the latest one.",
        "inputSchema": {"type": "object", "properties": {
            "id": {"type": "string", "default": ""},
            "part": {"type": "integer", "minimum": 1, "default": 1},
        }},
    },
    {
        "name": "windows",
        "description": "List every open window, front to back, with its app and title (including ones that are "
                       "minimized, hidden or on another desktop), and the tabs open in Safari and Chrome.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "switch_window",
        "description": "Bring an open window to the front by its title, or part of it, as `windows` lists it: "
                       "switches to its app, then to that window. Use it rather than opening a document that is "
                       "already open. Returns a screenshot.",
        "inputSchema": {"type": "object", "properties": {
            "title": {"type": "string"},
            "app": {"type": "string", "description": "The window's app, when several apps have a window with "
                                                     "that title."},
        }, "required": ["title"]},
    },
]
BATCHABLE = ["click", "move_mouse", "drag", "scroll", "type_text", "press_key", "open_app", "wait"]


def batch_tool(batchable: list[str], example: str) -> dict:
    return {
        "name": "batch",
        "description": "Do several actions in a row and get one screenshot at the end. Use it whenever you "
                       "already know the next steps; each separate call costs the user seconds. Each step is "
                       f"{{\"tool\": name, ...that tool's arguments}}, the tool being one of {', '.join(batchable)}. "
                       f"For example: {example}. Stops at the first step that fails.",
        "inputSchema": {"type": "object", "properties": {
            "steps": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                "type": "object", "properties": {"tool": {"type": "string", "enum": batchable}},
                "required": ["tool"]}},
            "step": {**STEP, "description": "What the whole batch does, the way `step` says it for one action. "
                     + STEP["description"]},
            "screenshot": LOOK,
        }, "required": ["step", "steps"]},
    }


TOOLS.append(batch_tool(BATCHABLE, '[{"tool": "press_key", "keys": "cmd+l"}, '
                                   '{"tool": "type_text", "text": "weather in Paris\\n"}]'))


def run_batch(tools, args: dict, batchable: list[str]) -> dict:
    """Runs args["steps"] through tools.call without screenshots, then looks once."""
    steps = args.get("steps") or []
    if any(isinstance(s, dict) and s.get("tool") == "authenticate" for s in steps):
        # Authentication is never chained with other actions. Alone, as the batch's only step and
        # with no arguments, it is the same as calling authenticate: that is how a conversation whose
        # saved tool list predates the authenticate tool can still use it.
        if len(steps) != 1 or set(steps[0]) != {"tool"}:
            return result(text("authenticate can't be combined with other steps or given arguments; "
                               "send it as the only step: [{\"tool\": \"authenticate\"}]."), error=True)
        return tools.call("authenticate", {})
    done = []
    for i, step in enumerate(args.get("steps") or [], 1):
        step = dict(step)
        name = step.pop("tool", "")
        if name not in batchable:
            return result(text(f"Step {i}: {name!r} can't go in a batch (use one of {', '.join(batchable)})."),
                          error=True)
        res = tools.call(name, {**step, "screenshot": False})
        if res.get("isError"):
            why = " ".join(c.get("text", "") for c in res["content"] if c.get("type") == "text")
            before = f" after {', '.join(done)}" if done else ""
            return result(text(f"Step {i} ({name}) failed{before}: {why}"), error=True)
        done.append(name)
    note = f"Did {len(done)} steps: {', '.join(done)}."
    if args.get("screenshot", True):
        time.sleep(SETTLE)
        return tools.look(note)
    return result(text(note))


def geometry() -> Screenshot:
    """How screenshot pixels map to screen points. Fixed for a given display setup."""
    ox, oy, w, h = work_display_bounds()  # the virtual monitor while it is on
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


def frontmost_pid() -> int | None:
    try:
        asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=2).stdout.strip()
        out = subprocess.run(["lsappinfo", "info", "-only", "pid", asn], capture_output=True, text=True,
                             timeout=2).stdout
        m = re.search(r'=(\d+)', out)
        return int(m.group(1)) if m else None
    except (OSError, subprocess.SubprocessError):
        return None


# Apps where Cmd+N gives the agent a window of its own instead of taking one the user has open.
NEW_WINDOW_APPS = {"Safari", "Google Chrome", "Arc", "Firefox", "Brave Browser", "Microsoft Edge", "Finder"}


def said(words: str) -> str:
    """Lowercase words only, so a quote compares with what the user said whatever the punctuation."""
    return " ".join(re.findall(r"\w+(?:'\w+)*", words.replace("’", "'").lower()))


def check_step(a: dict, words: str) -> dict | None:
    """Refuses a step marked one-way that doesn't quote the user's words for it. The agent says what
    each action does and whether it can be undone; this only checks that the quote is really something
    the user said (words: their requests in this conversation)."""
    step = str(a.get("step") or "")
    if not step.lower().lstrip().startswith("one-way"):
        return None
    quotes = re.findall(r"[\"“]([^\"“”]{3,})[\"”]", step)
    if any(said(q) and f" {said(q)} " in f" {said(words)} " for q in quotes):
        return None
    return result(text(
        "Refused: a one-way step (it can't be undone) needs the user's own words asking for it, quoted "
        f"exactly in `step`, and none of {quotes or 'your quotes'!r} is something the user said. If they "
        "asked for it, quote their words; if they didn't, don't do it: find a way that can be undone, or "
        "stop and ask them, saying exactly what you'd do and where."), error=True)


def notify(message: str):
    subprocess.Popen(["osascript", "-e", f"display notification {json.dumps(message)} with title \"Agent\""],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def result(*content: dict, error: bool = False) -> dict:
    return {"content": list(content), "isError": error}


class MacTools:
    def __init__(self):
        self.mac = AgentVHID(speed=2)  # still a person's curved moves and typing, just a quick one
        self.words = ""  # what the user said in this conversation: a one-way step must quote it
        self._acting = threading.RLock()  # held during a screen action, so control isn't let go mid-action
        self._last_act = 0.0
        self._holding = False  # the agent asked for the mouse and keyboard and hasn't let go of them
        self._fresh = True  # this task hasn't had control yet: a takeover before it doesn't count
        self._closed = threading.Event()
        threading.Thread(target=self._let_go_when_idle, daemon=True).start()

    def close(self):
        self._closed.set()
        self.mac.close()

    # -- the mouse and keyboard, only while the screen is in use --

    def take(self) -> str | None:
        """Takes the mouse and keyboard for a screen action, once the user's hands are off them. None
        when the agent has them; else why not (the user took over, or is busy with them)."""
        status = self.mac.status()
        state, reason = status.get("state"), status.get("reason", "")
        if state == "engaged":
            self._holding, self._fresh = True, False
            return None
        if state == "arming":
            if self.mac.wait_engaged(timeout=ENGAGE_WAIT, announce=False):
                self._holding, self._fresh = True, False
                return None
            reason = self.mac.status().get("reason", "")
        elif reason == "watcher_unavailable":
            return reason
        elif self._fresh or not (reason in HUMAN_SOURCES or reason.startswith("engage_cancelled")):
            # The agent let go after a pause, or this is the task's first screen action: ask again.
            self.mac.engage()
            self._fresh = False
            if self.mac.wait_engaged(timeout=ENGAGE_WAIT, announce=False):
                self._holding = True
                return None
            reason = self.mac.status().get("reason", "") or "busy"
        return reason

    def let_go(self):
        """Hands the mouse and keyboard back while the agent works without the screen."""
        with self._acting:
            if not self._holding:
                return
            self._holding = False
            try:
                if self.mac.status().get("state") in ("engaged", "arming"):
                    self.mac.disengage()
                    self.mac.release_all()
            except AgentVHIDError:
                pass

    def handed_back(self):
        """The user pressed fn to give the screen back: the agent holds it as if it had just used it,
        so it's let go again if the agent doesn't need it for a while."""
        self._holding, self._fresh, self._last_act = True, False, time.monotonic()

    def _let_go_when_idle(self):
        while not self._closed.wait(1.0):
            if self._holding and time.monotonic() - self._last_act > IDLE_RELEASE:
                self.let_go()

    def not_yours(self, reason: str) -> dict:
        if reason in HUMAN_SOURCES or reason.startswith("engage_cancelled") or reason == "busy":
            how = "took over" if reason in HUMAN_SOURCES else "is using them"
            return result(text(
                f"The user {how} the mouse and keyboard ({reason.replace('_', ' ')}), so screen actions wait "
                "until they press fn. Don't stop working: carry on with everything that doesn't need the "
                "screen (the shell, files, APIs, reading what you already have). Call wait_for_control only "
                "when the screen is the one way forward, then look at the new screenshot before acting; "
                "things may have changed."), error=True)
        return result(text(f"You don't have the mouse and keyboard ({reason}). Work without the screen, or "
                           "call wait_for_control."), error=True)

    def check_step(self, a: dict) -> dict | None:
        return check_step(a, self.words)

    # -- seeing --

    def look(self, note: str = "", context: bool = False) -> dict:
        """context: also list every open window and the browsers' tabs (desktop.py), for the first
        look at a task."""
        g = geometry()
        shown = desktop.windows()
        tabs: dict = {}
        fetching = threading.Thread(target=lambda: tabs.update(desktop.browser_tabs(shown)), daemon=True)
        if context:
            fetching.start()  # while the screenshot is taken
        fd, png = tempfile.mkstemp(prefix="mac-mcp-", suffix=".png")
        os.close(fd)
        jpg = png[:-4] + ".jpg"
        try:
            subprocess.run(["screencapture", "-x", *capture_args(), "-C", "-t", "png", png], check=True)
            subprocess.run(["sips", "--resampleWidth", str(g.width), "-s", "format", "jpeg",
                            "-s", "formatOptions", "70", png, "--out", jpg], check=True, capture_output=True)
            with open(jpg, "rb") as f:
                data = base64.b64encode(f.read()).decode()
        finally:
            for path in (png, jpg):
                if os.path.exists(path):
                    os.unlink(path)
        cx, cy = g.from_screen(*cursor_position())
        app = frontmost_app()
        front = next((w for w in shown if w.app == app and w.on_screen and w.title), None)
        where = "Screenshot of the virtual monitor, " if virtual_monitor.bounds() else "Screenshot "
        summary = (f"{where}{g.width}x{g.height} px. Mouse pointer at ({cx:.0f}, {cy:.0f}). "
                   f"Frontmost app: {app}" + (f", window {json.dumps(front.title, ensure_ascii=False)}" if front else "")
                   + ".")
        if context:
            fetching.join(2)
            summary += "\n" + desktop.describe(shown, dict(tabs))
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
        refused = self.check_step(args)
        if refused:
            return refused
        with self._acting:
            try:
                why_not = self.take()
                if why_not:
                    return self.not_yours(why_not)
                if virtual_monitor.bounds() and not virtual_monitor.contains(*cursor_position()):
                    virtual_monitor.bring_cursor(cursor_position())
                    time.sleep(0.3)  # macOS ignores mouse moves for a moment after the cursor is placed
                fn()
            except Disengaged as e:
                m = re.search(r"reason=([\w-]+)", str(e))
                return self.not_yours(m.group(1) if m else "unknown")
            except (AgentVHIDError, ValueError) as e:
                return result(text(f"Failed: {e}"), error=True)
            finally:
                self._last_act = time.monotonic()
        if args.get("screenshot", True):
            time.sleep(SETTLE)
            return self.look(done)
        return result(text(done))

    def to_virtual_monitor(self, before: int | None, running: set):
        """Moves the app that just came to the front onto the virtual monitor (nothing while it is
        off). An app that was already open gets a new window first where that is safe, so a
        window the user is using stays where they left it."""
        if not virtual_monitor.bounds():
            return
        deadline = time.monotonic() + 5
        pid = frontmost_pid()
        while pid == before and time.monotonic() < deadline:
            time.sleep(0.25)
            pid = frontmost_pid()
        app = frontmost_app()
        if app in running and app in NEW_WINDOW_APPS:
            self.mac.key("cmd+n")
            time.sleep(0.8)
        if pid:
            virtual_monitor.place(pid)
            time.sleep(0.4)

    def call(self, name: str, a: dict) -> dict:
        if name == "read_selected_text":
            if a:
                return result(text("This tool takes no arguments."), error=True)
            binary = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build', 'agent-vhid-selection')
            try:
                run = subprocess.run([binary], capture_output=True, text=True, timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                return result(text("Couldn't read the selection. Build agent-vhid-selection and check Accessibility."), error=True)
            if run.returncode:
                return result(text(run.stderr.strip() or "The app didn't expose selected text."), error=True)
            return result(text(run.stdout))
        if name == "authenticate":
            import credentials
            if a:
                return result(text("Authentication takes no arguments; never pass a password."), error=True)
            try:
                with self._acting:
                    if self.take():
                        raise credentials.CredentialError("The user has control. Wait for control before authenticating.")
                    try:
                        return result(text(credentials.authenticate_mac()))
                    finally:
                        self._last_act = time.monotonic()
            except credentials.CredentialError as e:
                return result(text(str(e)), error=True)
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
                before = frontmost_pid()
                running = {w.app for w in desktop.windows()}
                self.mac.key("cmd+space")
                time.sleep(0.4)
                self.mac.type_text(a["name"])
                time.sleep(0.6)  # Spotlight's top hit settles
                self.mac.key("return")
                time.sleep(0.5)  # the app starts coming up; the screenshot after shows how far
                self.to_virtual_monitor(before, running)
            on_monitor = " Its window is on the virtual monitor." if virtual_monitor.bounds() else ""
            return self.act(a, spotlight, f"Opened {a['name']!r} from Spotlight.{on_monitor}")
        if name == "wait":
            time.sleep(min(30.0, float(a["seconds"])))
            return self.look() if a.get("screenshot", True) else result(text("Waited."))
        if name == "wait_for_control":
            timeout = float(a.get("timeout_seconds", 120))
            with self._acting:
                if not self.take():
                    self._last_act = time.monotonic()
                    return self.look("You have the mouse and keyboard.")
            notify("Hive needs the screen. Press fn when it can have the mouse and keyboard.")
            if self.mac.wait_engaged(timeout=timeout, announce=False):
                self._holding, self._last_act = True, time.monotonic()
                return self.look("You have the mouse and keyboard again. The user may have changed things; "
                                 "check this screenshot before continuing.")
            return result(text(f"The user hasn't handed the screen back after {timeout:.0f} s. Finish what "
                               "you can without it, then say where you got to and what needs the screen."),
                          error=True)
        if name == "find_text":
            return self.find_text(a["text"])
        if name == "windows":
            return result(text(desktop.summary()))
        if name == "switch_window":
            return self.switch_window(a["title"], a.get("app"))
        if name == "read_screen":
            return self.read_screen()
        if name == "batch":
            return self.check_step(a) or run_batch(self, a, BATCHABLE)
        if name == "read_clipboard":
            clip = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
            return result(text(ingest.clipboard_slice(clip, a.get("offset") or 0)))
        if name == "read_ingested":
            return result(text(ingest.read_part(a.get("id") or None, int(a.get("part") or 1))))
        return result(text(f"Unknown tool {name!r}"), error=True)

    def switch_window(self, title: str, app: str | None = None) -> dict:
        """Switches to the window's app with Spotlight if it isn't in front, then presses cmd+` (the
        app's next window) until the window is in front, like a person would."""
        wanted, of = title.strip().lower(), (app or "").strip().lower()

        def matches(w: desktop.Window) -> bool:
            return bool(wanted) and wanted in w.title.lower() and of in w.app.lower()

        shown = desktop.windows()
        target = next((w for w in shown if matches(w)), None)
        if target is None:
            return result(text(f"No open window has {title!r} in its title.\n" + desktop.describe(shown, {})),
                          error=True)
        if frontmost_app() != target.app:
            switched = self.call("open_app", {"name": target.app, "screenshot": False})
            if switched["isError"]:
                return switched
        for _ in range(sum(w.app == target.app for w in shown) + 1):
            front = desktop.front_window(target.app)
            if front and matches(front):
                time.sleep(SETTLE)
                return self.look(f"{target.app}'s window {json.dumps(front.title, ensure_ascii=False)} is in front.")
            pressed = self.act({"screenshot": False}, lambda: self.mac.key("cmd+`"), "")
            if pressed["isError"]:
                return pressed
            time.sleep(0.3)  # the window comes forward
        return self.look(f"Couldn't bring {json.dumps(target.title, ensure_ascii=False)} forward with cmd+` (it "
                         f"may be minimized or on another desktop). Try {target.app}'s Window menu, which lists "
                         "its windows.")

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


INSTRUCTIONS = ("Use this Mac like a person: look with screenshot, act with click, type_text and press_key "
                "(or several at once with batch). Coordinates are screenshot pixels. If a tool says the user "
                "has the mouse and keyboard, keep doing the work that doesn't need the screen, and call "
                "wait_for_control only when the screen is the one way forward. Give every action a `step` saying what it "
                "does; one that can't be undone starts with \"One-way:\" and quotes the user's words asking for it.")


class Server:
    def __init__(self, tools=None, tool_list: list[dict] = TOOLS, name: str = "agent-vhid-mac",
                 instructions: str = INSTRUCTIONS):
        self.tools = tools or MacTools()
        self.tool_list, self.name, self.instructions = tool_list, name, instructions

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
                    "serverInfo": {"name": self.name, "version": "1.0"},
                    "instructions": self.instructions,
                })
            if method == "ping":
                return self.reply(msg_id, {})
            if method == "tools/list":
                return self.reply(msg_id, {"tools": self.tool_list})
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


def main(server: Server | None = None):
    server = server or Server()
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
