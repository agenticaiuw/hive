"""Give your Mac or iPhone a task in plain English; Codex does it with the real mouse and keyboard,
or with taps on the phone.

    python3 python/agent.py "make a new note in Notes that says buy milk"
    python3 python/agent.py "open Maps on my phone and find coffee nearby"

Codex looks at the screens and acts with mac_mcp.py's tools (agent-vhid) and phone_mcp.py's on the
iPhone (python/phone.py). Every task gets both; one that says "phone" or "iPhone" starts with the
phone's screen, any other with the Mac's. It runs on `codex app-server` (python/codex_app.py), so on your Codex subscription, with
our instructions (instructions.md) in place of Codex's own. Touch any key, the trackpad or the
mouse to take over; double-tap Right Option to let it continue.

Environment (or .env):
  CODEX_BIN     codex executable (default: the one inside ChatGPT.app, else `codex` on PATH)
  AGENT_MODEL   model (default: gpt-6.1-terra)
  AGENT_EFFORT  reasoning effort for each step: low (default, quickest), medium, high. Higher
                thinks longer before every click, which makes the agent several times slower
"""

from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import settings  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError  # noqa: E402
from codex_app import AppServer, CodexError  # noqa: E402

BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
LOG = os.path.join(tempfile.gettempdir(), "agent-vhid-codex.log")
MODEL = "gpt-6.1-terra"
EFFORT = "low"  # each step is a look and a click; more thinking mostly adds seconds to every one
INSTRUCTIONS = os.path.join(HERE, "instructions.md")

PROMPT = """\
You are operating the user's Mac and iPhone for them. {focus} The user just asked (by voice, so words \
may be mis-transcribed; use the sensible meaning):

    "{task}"
{previous}{conversation}
How to work
- If the request is only a question that needs neither the Mac nor the phone, answer it directly \
without any tools.
- Be quick: the user is waiting, and every call to a tool or the model costs seconds. Don't write \
anything before or between actions (no plans, no progress notes); your only message is the final \
reply.
- Look before you act: use the screenshot attached to this request if there is one, otherwise take \
one of the device you're using. Every action returns a screenshot taken just after it, so don't \
call screenshot again after an action; check that one before the next step.
- When you already know the next few steps, do them in one batch call rather than one call each.
- Use only the mac and phone tools to see and control the devices: the user wants to watch it \
happen. Web search, when you have it, is fine for looking things up.
- Finish the whole task, then reply in short spoken-style sentences (it is read aloud): what you \
did, or the answer. One or two sentences unless the question needs more. If you couldn't finish, \
say what is left.

The Mac (the `mac` tools): you see its screen with screenshots and act with the real mouse and \
keyboard, exactly like a person at the computer.
- Coordinates are pixels in the latest Mac screenshot. Use find_text to get exact positions of \
small buttons, menu items and links.
- Prefer keyboard shortcuts and open_app (Spotlight) when they are quicker than clicking.
- The user can take over at any moment by touching the keyboard, trackpad or mouse. When a tool \
says they took control, stop, call wait_for_control, and look at the new screenshot before going \
on. If they don't hand control back, stop and say where you got to.

The iPhone (the `phone` tools): you see its screen with screenshots and act with taps, swipes and \
typing, like a person holding it.
- Coordinates are points in the latest phone screenshot. Use elements for the exact positions and \
labels of small buttons, and tap_element to tap one by its label.
- open_app opens an app by bundle id; press_home goes to the home screen.
- If a tool says the phone isn't connected, stop and pass on what it said.
- The user may pick the phone up and use it at any time. If the screen changes in a way you didn't \
cause, look again before going on; if they seem to be using it, stop and say where you got to.

Never do these unless the request clearly asks for that exact thing:
- buy anything, pay, or move money
- send, post or publish messages, emails or comments (drafting is fine; stop before Send)
- delete files, emails or other data, or empty the trash
- change system, security, privacy or account settings
- type passwords, card numbers or other secrets; if a sign-in is needed, stop and tell the user
If the task needs one of these, get everything ready, stop before the final step, and say what's \
left for the user to confirm.
"""

# Every task gets both devices' tools (mac.click, phone.tap, ...). The device a request is for
# decides which one it looks at first and where it works when the request doesn't say.
DEVICES = {"mac": "Mac", "phone": "iPhone"}
FOCUS = {
    "mac": "Use the device the request is about. When it doesn't say, use the Mac, unless the request "
           "needs something only the phone has (one of its apps, or what's on it).",
    "phone": "This request is for the iPhone. Another task may be using the Mac meanwhile, so leave the "
             "Mac alone unless the request needs it.",
}
# "on my phone", "open Maps on the iPhone"; not "my phone number"
PHONE = re.compile(r"\biphone\b|\b(?:my|the|on|from|with|using) phone\b(?! numbers?\b)")


def focus(request: str) -> str:
    """The device a request is for: 'phone' when it says so, else 'mac'."""
    return "phone" if PHONE.search(request.lower()) else "mac"


def find_codex() -> str:
    for candidate in (os.environ.get("CODEX_BIN"), BUNDLED_CODEX, shutil.which("codex")):
        if candidate and os.path.exists(candidate):
            return candidate
    raise SystemExit("Codex CLI not found. Install it (npm i -g @openai/codex) or set CODEX_BIN.")


# Codex's own tools and extras the agent doesn't use. Each is more for the model to read on every
# request, and some (sub-agents, the JavaScript `exec` tool) cost it extra steps.
FEATURES_OFF = [
    "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin", "memories", "hooks",
    "multi_agent", "multi_agent_v2", "image_generation", "goals", "tool_suggest", "skill_search",
    "skill_mcp_dependency_install", "computer_use", "browser_use", "browser_use_external", "in_app_browser",
    "sleep_tool", "view_image", "workspace_dependencies",
]


def app_server_command() -> list[str]:
    overrides = [
        "notify=[]",  # no sounds or notifications when a task ends
        # Quick steps and short replies: it's read aloud, and nobody reads the reasoning summaries.
        f'model_reasoning_effort="{effort()}"', 'model_verbosity="low"', 'model_reasoning_summary="none"',
        "skills.include_instructions=false", "tools.update_plan.enabled=false",
        "tools.experimental_request_user_input.enabled=false",
        # Our tools go straight to the model instead of through code mode's JavaScript `exec` tool, which
        # would have it look the tools up first and unpack every screenshot by hand.
        f"features.code_mode.direct_only_tool_namespaces={json.dumps(list(DEVICES))}",
    ]
    overrides += [f"features.{name}=false" for name in FEATURES_OFF]
    overrides += [f"mcp_servers.{name}.enabled=false" for name in configured_mcp_servers()]
    catalog = direct_tools_catalog()
    if catalog:
        overrides.append(f"model_catalog_json={json.dumps(catalog)}")
    cmd = [find_codex(), "app-server"]
    for o in overrides:
        cmd += ["-c", o]
    return cmd


def direct_tools_catalog() -> str | None:
    """Codex's list of models (its cache of what your account offers), with each one set to call
    tools directly rather than in code mode, without sub-agents or the file-patching tool. That
    halves what the model reads on each request. None if Codex hasn't cached the list."""
    try:
        with open(os.path.join(codex_home(), "models_cache.json")) as f:
            models = json.load(f)["models"]
        for m in models:
            m["tool_mode"] = "direct"
            m.pop("multi_agent_version", None)
            m.pop("apply_patch_tool_type", None)
        path = os.path.join(tempfile.gettempdir(), "agent-vhid-models.json")
        with open(path, "w") as f:
            json.dump({"models": models}, f)
        return path
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


_server: AppServer | None = None
_server_lock = threading.Lock()


def codex_server() -> AppServer:
    """The app-server every task shares, started (or restarted) when needed."""
    global _server
    with _server_lock:
        if _server is None or not _server.alive:
            workdir = os.path.join(tempfile.gettempdir(), "agent-vhid-work")
            os.makedirs(workdir, exist_ok=True)
            log = open(LOG, "a", buffering=1)
            _server = AppServer(app_server_command(), stderr=log, cwd=workdir)
            log.close()  # the server has its own copy
        return _server


def warm_up():
    """Starts Codex now, so the first task doesn't wait for it."""
    try:
        codex_server()
    except (CodexError, OSError, SystemExit):
        pass  # the first task reports it


@atexit.register
def stop_server():
    global _server
    with _server_lock:
        if _server is not None:
            _server.close()
            _server = None


def device_tools() -> dict:
    """Each device's tools, which Codex's tool calls come back to. Neither connects until used."""
    from mac_mcp import MacTools
    from phone_mcp import PhoneTools
    return {"mac": MacTools(), "phone": PhoneTools()}


def tool_specs() -> list[dict]:
    """Both devices' tools, as Codex's dynamic tools: the model calls them as `mac.click`,
    `phone.tap` etc. Always the same, so they stay in the prompt cache from task to task."""
    import mac_mcp
    import phone_mcp
    about = {"mac": "The user's Mac: see the screen and use the real mouse and keyboard.",
             "phone": "The user's iPhone: see its screen and tap, swipe and type."}
    tools = {"mac": mac_mcp.TOOLS, "phone": phone_mcp.TOOLS}
    return [{"type": "namespace", "name": device, "description": about[device],
             "tools": [{"type": "function", "name": t["name"], "description": t["description"],
                        "inputSchema": t["inputSchema"]} for t in tools[device]]} for device in DEVICES]


def tool_reply(res: dict) -> dict:
    """An MCP-style tool result (what mac_mcp/phone_mcp return) as Codex's dynamic tool reply."""
    items = []
    for c in res.get("content", []):
        if c.get("type") == "image":
            items.append({"type": "inputImage", "imageUrl": f"data:{c['mimeType']};base64,{c['data']}"})
        elif c.get("type") == "text":
            items.append({"type": "inputText", "text": c["text"]})
    return {"success": not res.get("isError"), "contentItems": items}


def codex_config() -> dict:
    path = os.path.join(codex_home(), "config.toml")
    try:
        import tomllib
        with open(path, "rb") as f:
            return tomllib.load(f)
    except (OSError, ValueError, ImportError):
        return {}


def codex_home() -> str:
    return os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))


def configured_mcp_servers() -> list[str]:
    """Names of the MCP servers in ~/.codex/config.toml, so they can be switched off for this run."""
    return list(codex_config().get("mcp_servers", {}))


def effort() -> str:
    return os.environ.get("AGENT_EFFORT") or EFFORT


def model() -> str:
    return os.environ.get("AGENT_MODEL") or MODEL


def describe_model() -> str:
    """The model and effort the computer agent runs with, e.g. 'gpt-6.1-terra, low effort'."""
    return f"{model()}, {effort()} effort"


def describe_call(item: dict) -> str:
    args = item.get("arguments") or {}
    shown = ", ".join(f"{k}={json.dumps(v)[:60]}" for k, v in args.items() if k != "screenshot")
    on = "phone." if item.get("namespace") == "phone" else ""
    return f"{on}{item.get('tool')}({shown})"


def first_look(tools) -> tuple[str, str] | None:
    """A screenshot of the device right now, for Codex's first step, so it can act straight away
    instead of spending a step (seconds) asking to look. Returns (the image as a data: URL, what the
    tools say about it), or None if it can't be taken."""
    try:
        res = tools.look()
        if res.get("isError"):
            return None
        image = next(c for c in res["content"] if c.get("type") == "image")
        about = " ".join(c["text"] for c in res["content"] if c.get("type") == "text")
        return f"data:{image['mimeType']};base64,{image['data']}", about
    except Exception:  # can't see the screen or reach the phone: Codex takes its own screenshot
        return None


def doing(item: dict) -> str:
    """What a tool call does, said simply: 'Opening Safari', 'Typing "weather"'."""
    a = item.get("arguments") or {}
    quoted = lambda key: "“" + str(a.get(key, ""))[:40].strip() + "”"
    phrases = {
        "screenshot": "Looking at the screen", "click": "Clicking", "move_mouse": "Moving the mouse",
        "drag": "Dragging", "scroll": "Scrolling", "type_text": f"Typing {quoted('text')}",
        "press_key": f"Pressing {a.get('keys', '')}", "open_app": f"Opening {a.get('name', '')}",
        "find_text": f"Looking for {quoted('text')}", "read_screen": "Reading the screen",
        "wait": "Waiting", "wait_for_control": "Waiting for you to hand back control",
        "read_clipboard": "Reading the clipboard",
    }
    if item.get("tool") == "click" and int(a.get("clicks", 1) or 1) == 2:
        return "Double-clicking"
    return phrases.get(item.get("tool"), str(item.get("tool", "Working")).replace("_", " ").capitalize())


def tool_error(item: dict) -> str | None:
    if item.get("success") is False:
        texts = [c.get("text", "") for c in item.get("contentItems") or [] if c.get("type") == "inputText"]
        return " ".join(texts) or "failed"
    return None


class CodexTask:
    """One task, run on the shared app-server in the background. Events go to on_event(kind, text),
    where kind is 'action', 'doing' (what it's doing in plain words, or 'Thinking'), 'error', 'say',
    'think', 'done' or 'failed'. Each event is also written to LOG with the seconds since the start."""

    def __init__(self, task: str, previous: str | None = None, conversation: str | None = None, on_event=None,
                 device: str | None = None):
        """device: the one the request is for, 'mac' or 'phone' (from its words when not given)."""
        self.task = task
        self.device = device or focus(task)
        self.on_event = on_event or (lambda kind, text: None)
        prev = convo = ""
        if previous:
            prev = (f"\nBefore that they had asked: \"{previous}\". You were stopped partway through it; the "
                    "screen shows how far it got. The new request takes priority.\n")
        if conversation:
            convo = f"\nThe conversation before this request, for context:\n{conversation}\n"
        self.prompt = PROMPT.format(task=task.replace('"', "'"), previous=prev, conversation=convo,
                                    focus=FOCUS[self.device])
        self.final: str | None = None
        self.started_at = 0.0  # time.time()
        self.elapsed = 0.0  # seconds it took
        self.tools: dict = {}  # device_tools()
        self._server: AppServer | None = None
        self._thread = self._turn = None  # Codex's ids for this task
        self._log = None
        self._started = self._stopped = False
        self._lock = threading.Lock()
        self._done = threading.Event()

    def start(self, look: bool = True):
        """look: attach a screenshot taken now (first_look) to the request."""
        self._began, self.started_at = time.monotonic(), time.time()
        self._started = True
        threading.Thread(target=self._run, args=(look,), daemon=True).start()
        return self

    def _run(self, look: bool):
        self._log = open(LOG, "a", buffering=1)
        self._log.write(f"\n=== {self.device}: {self.task}  ({describe_model()})\n")
        try:
            self._converse(look)
            self._done.wait()
        except (CodexError, OSError) as e:
            self._finish("failed", f"Codex: {e} (see {LOG})")
        except SystemExit as e:  # Codex isn't installed
            self._finish("failed", str(e))
        finally:
            if self._server and self._thread:
                self._server.detach(self._thread)
            if self.tools:
                self.tools["mac"].mac.close()
            log, self._log = self._log, None
            log.close()

    def _converse(self, look: bool):
        self.tools = device_tools()
        prompt, image = self.prompt, None
        seen = first_look(self.tools[self.device]) if look else None
        if seen:
            image, about = seen
            prompt += (f"\nAttached: a screenshot of the {DEVICES[self.device]} taken as they asked, in the same "
                       f"coordinates as its tools. {about}\n")
            self._event("action", "screenshot (attached to the request)")
        if self._stopped:
            return self._finish("failed", "stopped")
        self._server = codex_server()
        params = {"baseInstructions": instructions(), "dynamicTools": tool_specs(), "model": model(),
                  "ephemeral": True, "sandbox": "read-only", "approvalPolicy": "never",
                  "cwd": os.path.join(tempfile.gettempdir(), "agent-vhid-work")}
        self._thread = self._server.request("thread/start", params)["thread"]["id"]
        self._server.attach(self._thread, self._on_message, self._call_tool)
        inputs = [{"type": "text", "text": prompt}] + ([{"type": "image", "url": image}] if image else [])
        turn = self._server.request("turn/start", {"threadId": self._thread, "input": inputs, "effort": effort(),
                                                   "summary": "none"})["turn"]["id"]
        with self._lock:
            self._turn = turn
            stopped = self._stopped
        if stopped:  # stop() came while the turn was starting
            self._interrupt()

    def _event(self, kind: str, text: str):
        if self._log:
            self._log.write(f"{time.monotonic() - self._began:6.1f}s  {kind}: {text}\n")
        self.on_event(kind, text)

    def _finish(self, kind: str, text: str):
        """Reports the end, once."""
        with self._lock:
            if self._done.is_set():
                return
            self.elapsed = time.monotonic() - self._began if self._started else 0.0
            self._done.set()
        self._event(kind, text)

    def _on_message(self, method: str, params: dict):
        item = params.get("item") or {}
        itype = item.get("type")
        if method == "turn/started":
            self._event("doing", "Thinking")
        elif method == "item/started" and itype == "dynamicToolCall":
            self._event("action", describe_call(item))
            self._event("doing", doing(item))
        elif method == "item/completed" and itype == "dynamicToolCall":
            err = tool_error(item)
            if err:
                self._event("error", err)
            self._event("doing", "Thinking")
        elif method == "item/started" and itype == "webSearch":
            self._event("action", f"web search: {item.get('query') or ''}")
            self._event("doing", "Searching the web")
        elif method == "item/completed" and itype == "agentMessage" and item.get("text", "").strip():
            self.final = item["text"].strip()
            self._event("say", self.final)
        elif method == "item/completed" and itype == "reasoning" and item.get("summary"):
            self._event("think", item["summary"][0].strip().splitlines()[0])
        elif method == "error" and not params.get("willRetry"):
            self._event("error", str((params.get("error") or {}).get("message"))[:300])
        elif method == "turn/completed":
            turn = params.get("turn") or {}
            if self._stopped or turn.get("status") == "interrupted":
                self._finish("failed", "stopped")
            elif turn.get("status") == "failed":
                self._finish("failed", str((turn.get("error") or {}).get("message") or "Codex failed")[:300])
            else:
                self._finish("done", self.final or "Done.")
        elif method == "exited":
            self._finish("failed", f"Codex stopped unexpectedly (exit code {params.get('code')}); see {LOG}")

    def _call_tool(self, params: dict) -> dict:
        tools = self.tools.get(params.get("namespace") or self.device)
        if self._stopped or tools is None:
            text = "Stopped by the user." if self._stopped else f"There are no {params.get('namespace')} tools."
            return {"success": False, "contentItems": [{"type": "inputText", "text": text}]}
        return tool_reply(tools.call(params["tool"], params.get("arguments") or {}))

    def _interrupt(self):
        try:
            self._server.request("turn/interrupt", {"threadId": self._thread, "turnId": self._turn}, timeout=10)
        except CodexError:
            pass

    @property
    def running(self) -> bool:
        return self._started and not self._done.is_set()

    def wait(self) -> str | None:
        self._done.wait()
        return self.final

    def stop(self):
        """Stops Codex's turn. (An action already under way on the Mac stops when control is handed
        back: the helper refuses the rest of it.)"""
        with self._lock:
            self._stopped = True
            turn = self._turn
        if turn:
            threading.Thread(target=self._interrupt, daemon=True).start()
        self.final = None
        self._finish("failed", "stopped")


def instructions() -> str:
    with open(INSTRUCTIONS) as f:
        return f.read()


def print_event(kind: str, text: str):
    if kind == "doing":
        return  # the actions are shown as they start
    if kind == "done":
        text = "done"  # the final message was already shown as it arrived
    marks = {"action": "  →", "error": "  ✗", "say": "  💬", "think": "  …", "done": "✅", "failed": "❌"}
    print(f"{marks.get(kind, '  ')} {text}", flush=True)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    settings.load()
    task = " ".join(argv)
    mac = AgentVHID()
    if focus(task) == "mac":
        try:
            status = mac.status()
        except AgentVHIDError as e:
            print(f"agent-vhid-helper isn't reachable ({e}). Start it with ./run.sh or ./voice.sh.")
            return 1
        if status.get("state") != "engaged":
            print("Double-tap Right Option to hand over the mouse and keyboard.")
    run = CodexTask(task, on_event=print_event).start()
    try:
        run.wait()
    except KeyboardInterrupt:
        run.stop()
        return 130
    finally:
        try:
            mac.disengage()
        except AgentVHIDError:
            pass
    return 0 if run.final is not None else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
