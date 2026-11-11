"""Give your Mac or iPhone a task in plain English; Codex does it with the real mouse and keyboard,
or with taps on the phone.

    python3 python/agent.py "make a new note in Notes that says buy milk"
    python3 python/agent.py "open Maps on my phone and find coffee nearby"

Codex looks at the screens and acts with mac_mcp.py's tools (agent-vhid) and phone_mcp.py's on the
iPhone (python/phone.py). Every task gets both; one that says "phone" or "iPhone" starts with the
phone's screen, any other with the Mac's. It runs on `codex app-server` (python/codex_app.py), so on your Codex subscription, with
our instructions (instructions.md) in place of Codex's own. Everything you ask from when you tap fn
to talk is one conversation (Session): one Codex thread with a turn for each request, so it has all
of it in context, and Codex compacts (summarizes) the thread when it gets long. Touch any key, the
trackpad or the mouse to take over; say "continue" to the voice agent, or run
`python3 python/agent_vhid.py engage`, to let it carry on.

Environment (or .env):
  CODEX_BIN     codex executable (default: the one inside ChatGPT.app, else `codex` on PATH)
  AGENT_MODEL   model (default: gpt-6.1-terra)
  AGENT_EFFORT  reasoning effort for each step: low (default, quickest), medium, high. Higher
                thinks longer before every click, which makes the agent several times slower
  AGENT_FAST    1: Codex's Fast tier, which OpenAI says is 1.5x quicker but uses up your plan's
                usage sooner (off by default)
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
from resumable_thread import ResumableThread, ResumeError, state_dir  # noqa: E402
from agent_context import ContextLog  # noqa: E402

BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
LOG = os.path.join(tempfile.gettempdir(), "agent-vhid-codex.log")
MODEL = "gpt-6.1-terra"
EFFORT = "low"  # each step is a look and a click; more thinking mostly adds seconds to every one
INSTRUCTIONS = os.path.join(HERE, "instructions.md")
# Tokens of context past which Codex compacts (summarizes) a session's thread. The models hold 272k,
# but every step re-reads the context, and each screenshot in it is a thousand tokens or more.
COMPACT_AT = 150_000

# The rules for every request, given once when a session's thread starts (as developer
# instructions, which Codex keeps when it compacts the thread).
RULES = """\
You are operating the user's Mac and iPhone for them. Each user message is a request they just made \
by voice, so words may be mis-transcribed; use the sensible meaning. This conversation holds \
everything they have asked since they started talking to you, with what you saw, did and said, and \
a request may follow on from an earlier one: an answer to your question, "the other one", "do that \
again". The screens may have changed since (the user can use the devices too), so trust the latest \
screenshot over what you remember.

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
- The first Mac screenshot comes with every open window (app and title, front to back) and the \
browsers' tabs. When the user names a document, file, page or app, find it in that list first: it \
may be open behind the window in front, minimized, or on another desktop. Bring it forward with \
switch_window; never open a file that is already open. The windows tool gives a fresh list.
- "This" or "here" usually means the window in front. When a task involves two things, such as \
copying from one document into another, work out from the list which is the source and which the \
destination before acting, and look at the source to see what to copy.
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

REQUEST = """\
{focus} The user just asked:

    "{task}"
{previous}"""

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
        # Codex's own lines on its sandbox ("only permits reading files") are about its shell and file
        # tools, which are off; the model took them to mean it couldn't edit what's on the screen.
        "include_permissions_instructions=false",
        "tools.experimental_request_user_input.enabled=false",
        # Our tools go straight to the model instead of through code mode's JavaScript `exec` tool, which
        # would have it look the tools up first and unpack every screenshot by hand.
        f"features.code_mode.direct_only_tool_namespaces={json.dumps(list(DEVICES))}",
        f"model_auto_compact_token_limit={COMPACT_AT}",
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


def running_server() -> AppServer | None:
    """The app-server, if it's running; never starts one."""
    with _server_lock:
        return _server if _server is not None and _server.alive else None


def thread_params() -> dict:
    """Persistent threads with our instructions, rules and tools."""
    params = {"baseInstructions": instructions(), "developerInstructions": RULES, "dynamicTools": tool_specs(),
              "model": model(), "ephemeral": False, "sandbox": "read-only", "approvalPolicy": "never",
              "cwd": os.path.join(tempfile.gettempdir(), "agent-vhid-work")}
    if fast():
        params["serviceTier"] = "priority"  # the id Codex's model list gives its Fast tier
    return params


def warm_up():
    """Starts Codex now, so the first task doesn't wait for it. Reads the browsers' tabs once too:
    the first time, macOS asks whether the agent may (so it asks now, not halfway through a task)."""
    import desktop
    threading.Thread(target=desktop.browser_tabs, kwargs={"timeout": 120}, daemon=True).start()
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


def fast() -> bool:
    return (os.environ.get("AGENT_FAST") or "").strip().lower() in ("1", "true", "yes", "on")


def describe_model() -> str:
    """The model and effort the computer agent runs with, e.g. 'gpt-6.1-terra, low effort'."""
    return f"{model()}, {effort()} effort" + (", Fast tier" if fast() else "")


def describe_call(item: dict) -> str:
    args = item.get("arguments") or {}
    shown = ", ".join(f"{k}={json.dumps(v)[:60]}" for k, v in args.items() if k != "screenshot")
    on = "phone." if item.get("namespace") == "phone" else ""
    return f"{on}{item.get('tool')}({shown})"


def first_look(tools, context: bool = False) -> tuple[str, str] | None:
    """A screenshot of the device right now, for Codex's first step, so it can act straight away
    instead of spending a step (seconds) asking to look. Returns (the image as a data: URL, what the
    tools say about it), or None if it can't be taken. context: the Mac's tools also list its open
    windows and browser tabs."""
    try:
        res = tools.look(context=True) if context else tools.look()
        if res.get("isError"):
            return None
        image = next(c for c in res["content"] if c.get("type") == "image")
        about = " ".join(c["text"] for c in res["content"] if c.get("type") == "text")
        return f"data:{image['mimeType']};base64,{image['data']}", about
    except Exception:  # can't see the screen or reach the phone: Codex takes its own screenshot
        return None


LOOK_AHEAD_FRESH = 30  # seconds a look taken as you started talking stays good for your request


class LookAhead:
    """The Mac's first look at a request (the screenshot, every window and the browsers' tabs),
    taken in the background while you're still saying it: the voice agent starts one as you start
    talking and gives it to the request's task (CodexTask(ahead=...)), which then goes to Codex the
    moment you've finished instead of looking first. take(), if given, looks instead (the tests)."""

    def __init__(self, take=None):
        self.at = time.monotonic()
        self._seen: tuple[str, str] | None = None
        self._done = threading.Event()
        threading.Thread(target=self._take, args=(take,), daemon=True).start()

    def seen(self) -> tuple[str, str] | None:
        """The look, once it's taken (None if it couldn't be, or it's too old to trust)."""
        if time.monotonic() - self.at > LOOK_AHEAD_FRESH or not self._done.wait(5):
            return None
        return self._seen

    def _take(self, take):
        try:
            if take:
                self._seen = take()
                return
            from mac_mcp import MacTools
            tools = MacTools()
            try:
                self._seen = first_look(tools, context=True)
            finally:
                tools.mac.close()
        finally:
            self._done.set()


SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")


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
        "read_clipboard": "Reading the clipboard", "read_ingested": "Reading what you added", "windows": "Checking what's open",
        "switch_window": f"Switching to {quoted('title')}",
    }
    if item.get("tool") == "click" and int(a.get("clicks", 1) or 1) == 2:
        return "Double-clicking"
    return phrases.get(item.get("tool"), str(item.get("tool", "Working")).replace("_", " ").capitalize())


def forget(server: AppServer, thread: str):
    """Unsubscribe from a thread without deleting its persisted history."""
    server.detach(thread)
    try:
        server.request("thread/unsubscribe", {"threadId": thread}, timeout=5)
    except CodexError:
        pass


class Session:
    """A conversation: the requests from when you tap fn to talk (new_session) are turns on one
    Codex thread, so each has the ones before it in context: what you said, what it saw and did,
    and what it answered. Codex compacts the thread when it gets long (COMPACT_AT).

    The primary identity survives app/server restarts. A thread takes one turn at a time.
    A request that replaces one being stopped waits a moment
    for Codex to end that turn. One for the other device while a turn is under way (the phone
    while the Mac works) gets a thread of its own, told what was said so far, and the session's
    thread is told what came of it with its next request.

    prepare() starts the thread before the first request: Codex gets its connection to the model
    ready when a thread starts, and the first request on a thread started a few seconds earlier gets
    its first words 1 to 2.5 s sooner."""

    def __init__(self, state_path=None):
        self._state_path = state_path
        self._identity = None  # loaded lazily, after settings and test isolation are configured
        self.context_error = None
        self.tasks: list[CodexTask] = []  # its requests, oldest first
        self._server: AppServer | None = None
        self._thread: str | None = None  # the session's thread on _server
        self._owner: CodexTask | None = None  # the task whose turn is on the thread, or was last
        self._idle = threading.Event()  # no turn under way on the thread
        self._idle.set()
        self._lock = threading.Lock()
        self._closed = False

    @property
    def busy(self) -> bool:
        return any(t.running for t in self.tasks)

    def add(self, task: CodexTask):
        self.tasks.append(task)  # (no lock: prepare() may hold it while Codex starts the thread)

    def prepare(self):
        """Starts the session's thread now, in the background, if Codex is running."""
        threading.Thread(target=self._prepare, daemon=True).start()

    def _prepare(self):
        server = running_server()
        if server is None:
            return  # the first request starts Codex, and the thread
        with self._lock:
            if self._closed or self._thread is not None or self._server not in (None, server):
                return
            try:
                thread = self._connect(server, thread_params())
            except (CodexError, OSError, ResumeError):
                return  # the first request tries again, and says what's wrong
            self._server, self._thread = server, thread
            server.attach(thread, self._on_message, self._call_tool)

    def _connect(self, server, params):
        if self._identity is None:
            self._identity = ResumableThread(self._state_path or state_dir() / "codex-thread-id")
        def observe(kind, payload):
            try:
                ContextLog().record(kind, payload, thread=self._identity.thread_id)
            except Exception as error:
                self.context_error = str(error)
        return self._identity.connect(server, params, observe=observe)

    def thread_for(self, task: CodexTask, server: AppServer, params: dict) -> tuple[str, str]:
        """The thread for task's turn (the session's own when it's free, else a new one; params
        start it) and what to tell it before the request: what was said that it hasn't seen."""
        with self._lock:
            if self._closed:
                raise ResumeError("Conversation is closed")
            if self._server is not server:  # the first request, or Codex restarted
                self._server, self._thread, self._owner = server, None, None
                self._idle.set()
            owner = self._owner
        if owner is not None and not owner.running:
            self._idle.wait(10)  # it was stopped: Codex ends its turn in a moment
        with self._lock:
            if self._idle.is_set():
                if self._thread is None:
                    self._thread = self._connect(server, params)
                    server.attach(self._thread, self._on_message, self._call_tool)
                self._idle.clear()
                self._owner, task.on_thread = task, True
                return self._thread, self._said_before(task, everything=False)
            told = self._said_before(task, everything=True)
        task._record_context("thread/start input", params)
        result = server.request("thread/start", params)
        task._record_context("thread/start output", result)
        thread = result["thread"]["id"]
        server.attach(thread, task._on_message, task._call_tool)
        return thread, told

    def release(self, task: CodexTask):
        """task's turn didn't start after all."""
        with self._lock:
            if self._owner is task:
                self._idle.set()

    def close(self):
        threading.Thread(target=self._close, daemon=True).start()  # prepare() may still be at it

    def _close(self):
        with self._lock:
            self._closed = True
            server, thread, self._thread = self._server, self._thread, None
        if server and thread and server.alive:
            forget(server, thread)

    def _said_before(self, task: CodexTask, everything: bool) -> str:
        """The requests before task and what came of them: all of them, for a thread of its own;
        for the session's thread, those that ran elsewhere and it hasn't been told about."""
        lines = []
        for t in self.tasks[:self.tasks.index(task)]:
            if everything or not (t.on_thread or t.told):
                lines += [f"  They asked: {json.dumps(t.task, ensure_ascii=False)}", f"  You: {t.outcome()}"]
                if not everything and not t.running:
                    t.told = True
        if not lines:
            return ""
        return ("Also said in this conversation, which you haven't seen here (oldest first):\n"
                + "\n".join(lines) + "\n\n")

    def _on_message(self, method: str, params: dict):
        owner = self._owner
        if owner is not None:
            owner._on_message(method, params)
        if method in ("turn/completed", "exited"):
            self._idle.set()

    def _call_tool(self, params: dict) -> dict:
        return self._owner._call_tool(params)


_session = Session()
_session_lock = threading.Lock()


def new_session() -> bool:
    """Compatibility entry point: prepare the durable conversation when listening starts.

    Listening toggles must never reset conversation identity, including after a restart.
    """
    with _session_lock:
        old = _session
        if old.busy:
            return False
        _session.prepare()
    return True


def tool_error(item: dict) -> str | None:
    if item.get("success") is False:
        texts = [c.get("text", "") for c in item.get("contentItems") or [] if c.get("type") == "inputText"]
        return " ".join(texts) or "failed"
    return None


class CodexTask:
    """One task, run on the shared app-server in the background. Events go to on_event(kind, text),
    where kind is 'action', 'doing' (what it's doing in plain words, or 'Thinking'), 'error', 'say',
    'think', 'done' or 'failed'. Each event is also written to LOG with the seconds since the start."""

    def __init__(self, task: str, previous: str | None = None, on_event=None, device: str | None = None,
                 session: Session | None = None, ahead: LookAhead | None = None):
        """device: the one the request is for, 'mac' or 'phone' (from its words when not given).
        session: the conversation it's part of (default: the current one, see new_session).
        ahead: the Mac's look, taken as you started saying it (for a Mac request)."""
        self.task = task
        self.device = device or focus(task)
        self.on_event = on_event or (lambda kind, text: None)
        self.session = session or _session
        self.ahead = ahead if self.device == "mac" else None
        prev = ""
        if previous:
            prev = (f"\nBefore that they had asked: \"{previous}\". You were stopped partway through it; the "
                    "screen shows how far it got. The new request takes priority.\n")
        self.prompt = REQUEST.format(task=task.replace('"', "'"), previous=prev, focus=FOCUS[self.device])
        self.final: str | None = None
        self.started_at = 0.0  # time.time()
        self.elapsed = 0.0  # seconds it took
        self.tools: dict = {}  # device_tools()
        self.on_thread = False  # it ran on its session's thread (else on one of its own)
        self.told = False  # the session's thread has been told what came of it
        self._ended = ""  # why it failed, or "stopped"
        self._server: AppServer | None = None
        self._thread = self._turn = None  # Codex's ids for this task
        self._context = 0  # tokens of context the thread has
        self.times: dict[str, float] = {}  # seconds from start: 'look', 'codex' (turn started), 'words', 'end'
        self.looked_ahead = False  # its screenshot was taken as you started talking
        self.model_calls = self._thought = self._wrote = 0  # model calls this turn; their reasoning, output tokens
        self.calls_to_words = 0  # model calls up to and including the one that started the reply
        self._written: dict[str, str] = {}  # message id -> its text so far, as Codex writes it
        self._said: dict[str, int] = {}  # message id -> how much of it has gone to 'say'
        self._log = None
        self._started = self._stopped = False
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._turn_over = threading.Event()  # Codex has ended its turn
        self._context_log = None
        self._context_warning = False

    def start(self, look: bool = True):
        """look: attach a screenshot taken now (first_look) to the request."""
        self.began, self.started_at = time.monotonic(), time.time()
        self._started = True
        self.session.add(self)
        threading.Thread(target=self._run, args=(look,), daemon=True).start()
        return self

    def _run(self, look: bool):
        self._log = open(LOG, "a", buffering=1)
        self._log.write(f"\n=== {self.device}: {self.task}  ({describe_model()})\n")
        try:
            self._converse(look)
            self._done.wait()
            if self._turn:
                self._turn_over.wait(10)  # when it was stopped, Codex ends the turn in a moment
        except (CodexError, OSError, ResumeError) as e:
            self._finish("failed", f"Codex: {e} (see {LOG})")
        except SystemExit as e:  # Codex isn't installed
            self._finish("failed", str(e))
        finally:
            if self._server and self._thread and not self.on_thread:
                forget(self._server, self._thread)
            if self.tools:
                self.tools["mac"].mac.close()
            log, self._log = self._log, None
            log.close()

    def _converse(self, look: bool):
        self.tools = device_tools()
        attached, image, seen = "", None, None
        if look:
            seen = self.ahead.seen() if self.ahead else None
            self.looked_ahead = seen is not None
            if seen is None:
                seen = first_look(self.tools[self.device], context=self.device == "mac")
            self._time("look")
        if seen:
            image, about = seen
            attached = (f"\nAttached: a screenshot of the {DEVICES[self.device]} taken as they asked, in the same "
                        f"coordinates as its tools. {about}\n")
            self._event("action", "screenshot (taken as you started talking)" if self.looked_ahead
                        else "screenshot (attached to the request)")
        if self._stopped:
            return self._finish("failed", "stopped")
        self._server = codex_server()
        self._thread, earlier = self.session.thread_for(self, self._server, thread_params())
        self._record_context("session connected", {"threadId": self._thread,
                             "note": "Codex restores saved instructions and tools on resume."})
        if self.session.context_error:
            self._event("error", f"Thread context could not be saved: {self.session.context_error}")
        if not self.on_thread:
            self._log.write("(the session's thread is busy: this one runs on a thread of its own)\n")
        if self._stopped:
            self.session.release(self)
            return self._finish("failed", "stopped")
        inputs = [{"type": "text", "text": earlier + self.prompt + attached}]
        if image:
            inputs.append({"type": "image", "url": image})
        start = {"threadId": self._thread, "input": inputs, "effort": effort(), "summary": "none"}
        if fast():
            start["serviceTier"] = "priority"
        try:
            self._record_context("turn/start input", start)
            turn = self._server.request("turn/start", start)["turn"]["id"]
        except CodexError:
            self.session.release(self)
            raise
        self._time("codex")
        with self._lock:
            self._turn = turn
            stopped = self._stopped
        if stopped:  # stop() came while the turn was starting
            self._interrupt()

    def _record_context(self, kind, payload):
        try:
            if self._context_log is None:
                self._context_log = ContextLog()
            path = self._context_log.record(kind, payload, task=self.task, thread=self._thread)
            self.on_event("context", path)
        except Exception as error:
            # An inspector failure must not kill the JSON-RPC reader or obscure a
            # tool result, and the user must know that their view is incomplete.
            if not self._context_warning:
                self._context_warning = True
                self._event("error", f"Agent context could not be saved: {error}")

    def _event(self, kind: str, text: str):
        if self._log:
            self._log.write(f"{time.monotonic() - self.began:6.1f}s  {kind}: {text}\n")
        self.on_event(kind, text)

    def _time(self, step: str):
        self.times.setdefault(step, time.monotonic() - self.began)

    def describe_times(self) -> str:
        """Where its time went, e.g. 'screenshot 0.0 s (taken as you talked), Codex 0.1 s, first
        words at 3.2 s (2 model calls, 310 tokens thinking), done at 4.0 s'."""
        t = self.times
        parts = []
        if "look" in t:
            parts.append(f"screenshot {t['look']:.1f} s" + (" (taken as you talked)" if self.looked_ahead else ""))
        if "codex" in t:
            parts.append(f"Codex started at {t['codex']:.1f} s")
        if "words" in t:
            parts.append(f"first words at {t['words']:.1f} s")
        if self.model_calls:
            calls = self.model_calls
            parts.append(f"{calls} model call{'s' * (calls > 1)}, {self._thought} tokens thinking, "
                         f"{self._wrote} written")
        if "end" in t:
            parts.append(f"done at {t['end']:.1f} s")
        return ", ".join(parts)

    def _speak(self, item_id: str, text: str, whole: bool = False):
        """Says each sentence of a message as soon as Codex has written it, rather than waiting for
        the whole message: the voice starts on the first while the rest is still coming."""
        said = self._said.get(item_id, 0)
        rest = text[said:]
        if not whole:
            ends = [m.end() for m in SENTENCE_END.finditer(rest)]
            rest = rest[:ends[-1]] if ends else ""
        if rest.strip():
            self._said[item_id] = said + len(rest)
            if "words" not in self.times:
                self.calls_to_words = self.model_calls + 1  # (its usage comes once it's done writing)
            self._time("words")
            self._event("say", rest.strip())

    def _finish(self, kind: str, text: str):
        """Reports the end, once."""
        with self._lock:
            if self._done.is_set():
                return
            self.elapsed = time.monotonic() - self.began if self._started else 0.0
            if kind != "done":
                self._ended = text
            self._done.set()
        if self._started:
            self._time("end")
            if self._log:
                self._log.write(f"   ({self.describe_times()})\n")
        self._event(kind, text)

    def outcome(self) -> str:
        """What came of it, for a thread that didn't see it."""
        if self.running:
            return "(still working on it)"
        if self.final:
            return json.dumps(self.final, ensure_ascii=False)
        return "(stopped before finishing)" if self._ended == "stopped" else f"(failed: {self._ended[:150]})"

    def _on_message(self, method: str, params: dict):
        turn_id = params.get("turnId") or (params.get("turn") or {}).get("id")
        if turn_id and self._turn and turn_id != self._turn:
            return  # from a turn before this one
        if method in ("item/started", "item/completed", "turn/started", "turn/completed",
                      "error", "exited", "thread/tokenUsage/updated"):
            self._record_context(method, params)
        item = params.get("item") or {}
        itype = item.get("type")
        if method in ("turn/completed", "exited"):
            self._turn_over.set()
            if self._log and self._context:
                self._log.write(f"   (the conversation is {self._context / 1000:.0f}k tokens)\n")
        if method == "thread/tokenUsage/updated":  # after each call to the model
            last = (params.get("tokenUsage") or {}).get("last") or {}
            self._context = last.get("inputTokens", 0) + last.get("outputTokens", 0)
            self.model_calls += 1
            self._thought += last.get("reasoningOutputTokens", 0)
            self._wrote += max(0, last.get("outputTokens", 0) - last.get("reasoningOutputTokens", 0))
        elif method == "item/agentMessage/delta" and not self._stopped:
            written = self._written[params.get("itemId", "")] = self._written.get(params.get("itemId", ""), "") + \
                params.get("delta", "")
            self._speak(params.get("itemId", ""), written)
        elif method == "item/started" and itype == "contextCompaction":
            self._event("action", "compacting the conversation")
            self._event("doing", "Summing up the conversation so far")
        elif method == "turn/started":
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
            if not self._stopped:
                self._speak(item.get("id", ""), item["text"], whole=True)  # what the deltas haven't said
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
        self._record_context("tool input", params)
        tools = self.tools.get(params.get("namespace") or self.device)
        if self._stopped or tools is None:
            text = "Stopped by the user." if self._stopped else f"There are no {params.get('namespace')} tools."
            reply = {"success": False, "contentItems": [{"type": "inputText", "text": text}]}
        else:
            try:
                reply = tool_reply(tools.call(params["tool"], params.get("arguments") or {}))
            except Exception as error:
                reply = {"success": False, "contentItems": [{"type": "inputText", "text": f"Failed: {error}"}]}
        self._record_context("tool output", {"callId": params.get("callId"), "result": reply})
        return reply

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
    if kind == "context":
        return  # main() prints the viewer location once
    if kind == "doing":
        return  # the actions are shown as they start
    if kind == "done":
        text = "done"  # the final message was already shown as it arrived
    marks = {"action": "  →", "error": "  ✗", "say": "  💬", "think": "  …", "done": "✅", "failed": "❌"}
    print(f"{marks.get(kind, '  ')} {text}", flush=True)


def use_claude():
    """Runs requests on Claude (python/claude_agent.py) instead of Codex: the same names, swapped in
    here so everything that imports them from this module gets the Claude ones. Only with
    AGENT_BACKEND=claude; Codex is the default."""
    global CodexTask, new_session, warm_up, describe_model, _session
    import claude_agent
    CodexTask, new_session = claude_agent.ClaudeTask, claude_agent.new_session
    warm_up, describe_model = claude_agent.warm_up, claude_agent.describe_model
    _session = claude_agent.Session()


if __name__ != "__main__" and (os.environ.get("AGENT_BACKEND") or "codex").lower() == "claude":
    use_claude()


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    settings.load()
    print(f"Agent context: {state_dir() / 'context/index.html'}")
    task = " ".join(argv)
    mac = AgentVHID()
    if focus(task) == "mac":
        try:
            status = mac.status()
        except AgentVHIDError as e:
            print(f"agent-vhid-helper isn't reachable ({e}). Start it with ./run.sh or ./voice.sh.")
            return 1
        if status.get("state") != "engaged":
            try:
                mac.engage()  # you typed the task; it takes over once your hands are off
            except AgentVHIDError as e:
                print(f"Couldn't take the mouse and keyboard: {e}")
    import agent as swapped  # (not __main__'s copy: the one that swapped in Claude)
    run = swapped.CodexTask(task, on_event=print_event).start()
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
