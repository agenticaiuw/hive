"""Give your Mac a task in plain English; Codex does it with the real mouse and keyboard.

    python3 python/agent.py "make a new note in Notes that says buy milk"

Codex looks at the screen and acts through mac_mcp.py (agent-vhid). Touch any key, the
trackpad or the mouse to take over; double-tap Right Option to let it continue.

Environment (or .env):
  CODEX_BIN     codex executable (default: the one inside ChatGPT.app, else `codex` on PATH)
  AGENT_MODEL   model (default: your Codex config's model)
  AGENT_EFFORT  reasoning effort: low, medium, high (default: your Codex config's; lower is faster)
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import settings  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError  # noqa: E402

BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
LOG = os.path.join(tempfile.gettempdir(), "agent-vhid-codex.log")

PROMPT = """\
You are operating the user's Mac for them through the `mac` tools: you see the screen with \
screenshots and act with the real mouse and keyboard, exactly like a person at the computer. \
The user just asked (by voice, so words may be mis-transcribed; use the sensible meaning):

    "{task}"
{previous}{conversation}
How to work
- If the request is only a question that needs neither the screen nor the computer, answer it \
directly without any tools.
- Otherwise start with a screenshot. Each action returns a fresh screenshot; check it before the \
next step.
- Coordinates are pixels in the latest screenshot. Use find_text to get exact positions of small \
buttons, menu items and links.
- Prefer keyboard shortcuts and open_app (Spotlight) when they are quicker than clicking.
- Use only the mac tools to see and control the computer. Don't use shell commands, scripts, \
file edits, cua_repl, node_repl or sub-agents: the user wants to watch it happen on screen. Web \
search, when you have it, is fine for looking things up.
- Finish the whole task, then reply in short spoken-style sentences (it is read aloud): what you \
did, or the answer. One or two sentences unless the question needs more. If you couldn't finish, \
say what is left.

The user is in charge
- They can take over at any moment by touching the keyboard, trackpad or mouse. When a tool says \
they took control, stop, call wait_for_control, and look at the new screenshot before going on. \
If they don't hand control back, stop and say where you got to.

Never do these unless the request clearly asks for that exact thing:
- buy anything, pay, or move money
- send, post or publish messages, emails or comments (drafting is fine; stop before Send)
- delete files, emails or other data, or empty the trash
- change system, security, privacy or account settings
- type passwords, card numbers or other secrets; if a sign-in is needed, stop and tell the user
If the task needs one of these, get everything ready, stop before the final step, and say what's \
left for the user to confirm.
"""


def find_codex() -> str:
    for candidate in (os.environ.get("CODEX_BIN"), BUNDLED_CODEX, shutil.which("codex")):
        if candidate and os.path.exists(candidate):
            return candidate
    raise SystemExit("Codex CLI not found. Install it (npm i -g @openai/codex) or set CODEX_BIN.")


def codex_command(prompt: str, last_message_path: str) -> list[str]:
    server = os.path.join(HERE, "mac_mcp.py")
    overrides = [
        # Our tools only: no connectors (email etc.), plugins or other MCP servers from your config.
        "notify=[]", "features.apps=false",
        'mcp_servers.mac.command="python3"',
        f"mcp_servers.mac.args={json.dumps([server])}",
        'mcp_servers.mac.default_tools_approval_mode="approve"',
        "mcp_servers.mac.tool_timeout_sec=900",
    ]
    if os.environ.get("AGENT_EFFORT"):  # otherwise your config's, e.g. high
        overrides.append(f'model_reasoning_effort="{os.environ["AGENT_EFFORT"]}"')
    if os.environ.get("AGENT_VHID_SOCKET"):  # Codex doesn't pass our environment to MCP servers
        overrides.append(f"mcp_servers.mac.env={{AGENT_VHID_SOCKET={json.dumps(os.environ['AGENT_VHID_SOCKET'])}}}")
    overrides += [f'plugins."{p}@openai-bundled".enabled=false' for p in
                  ("computer-use", "unified-computer-use", "browser", "chrome", "codex-app-tools")]
    overrides += [f"mcp_servers.{name}.enabled=false" for name in configured_mcp_servers() if name != "mac"]
    cmd = [find_codex(), "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
           "-o", last_message_path]
    if os.environ.get("AGENT_MODEL"):
        cmd += ["-m", os.environ["AGENT_MODEL"]]
    for o in overrides:
        cmd += ["-c", o]
    return cmd + [prompt]


def codex_config() -> dict:
    path = os.path.join(os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex")), "config.toml")
    try:
        import tomllib
        with open(path, "rb") as f:
            return tomllib.load(f)
    except (OSError, ValueError, ImportError):
        return {}


def configured_mcp_servers() -> list[str]:
    """Names of the MCP servers in ~/.codex/config.toml, so they can be switched off for this run."""
    return list(codex_config().get("mcp_servers", {}))


def describe_model() -> str:
    """The model and effort the computer agent runs with, e.g. 'gpt-6-astra, high effort'."""
    config = codex_config()
    model = os.environ.get("AGENT_MODEL") or config.get("model") or "Codex's default model"
    effort = os.environ.get("AGENT_EFFORT") or config.get("model_reasoning_effort")
    return f"{model}, {effort} effort" if effort else model


def describe_call(item: dict) -> str:
    args = item.get("arguments") or {}
    shown = ", ".join(f"{k}={json.dumps(v)[:60]}" for k, v in args.items() if k != "screenshot")
    return f"{item.get('tool')}({shown})"


def tool_error(item: dict) -> str | None:
    if item.get("error"):
        return item["error"].get("message", "failed")
    res = item.get("result") or {}
    if res.get("isError") or res.get("is_error"):
        texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
        return " ".join(texts) or "failed"
    return None


class CodexTask:
    """One Codex run in the background. Events go to on_event(kind, text), where kind is
    'action', 'error', 'say', 'think', 'done' or 'failed'."""

    def __init__(self, task: str, previous: str | None = None, conversation: str | None = None, on_event=None):
        self.task = task
        self.on_event = on_event or (lambda kind, text: None)
        prev = convo = ""
        if previous:
            prev = (f"\nBefore that they had asked: \"{previous}\". You were stopped partway through it; the "
                    "screen shows how far it got. The new request takes priority.\n")
        if conversation:
            convo = f"\nThe conversation before this request, for context:\n{conversation}\n"
        self.prompt = PROMPT.format(task=task.replace('"', "'"), previous=prev, conversation=convo)
        self.final: str | None = None
        self.proc: subprocess.Popen | None = None
        self._stopped = False
        self._done = threading.Event()

    def start(self):
        fd, self._last = tempfile.mkstemp(prefix="agent-last-", suffix=".txt")
        os.close(fd)
        workdir = os.path.join(tempfile.gettempdir(), "agent-vhid-work")
        os.makedirs(workdir, exist_ok=True)
        log = open(LOG, "a")
        log.write(f"\n=== {self.task}\n")
        log.flush()
        self.proc = subprocess.Popen(codex_command(self.prompt, self._last), cwd=workdir, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=log, text=True, start_new_session=True)
        log.close()
        threading.Thread(target=self._read, daemon=True).start()
        return self

    def _read(self):
        last_message = None
        for line in self.proc.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind, item = event.get("type"), event.get("item") or {}
            itype = item.get("type")
            if kind == "item.started" and itype == "mcp_tool_call":
                self.on_event("action", describe_call(item))
            elif kind == "item.completed" and itype == "mcp_tool_call":
                err = tool_error(item)
                if err:
                    self.on_event("error", err)
            elif kind == "item.completed" and itype == "agent_message":
                last_message = item.get("text", "").strip()
                self.on_event("say", last_message)
            elif kind == "item.completed" and itype == "reasoning" and item.get("text"):
                self.on_event("think", item["text"].strip().splitlines()[0])
            elif kind == "item.started" and itype == "command_execution":
                self.on_event("action", f"$ {item.get('command')}")
            elif kind in ("turn.failed", "error"):
                msg = event.get("error", {}).get("message") if kind == "turn.failed" else event.get("message")
                self.on_event("error", str(msg)[:300])
        self.proc.wait()
        try:
            with open(self._last) as f:
                self.final = f.read().strip() or last_message
            os.unlink(self._last)
        except OSError:
            self.final = last_message
        if self._stopped:
            self.on_event("failed", "stopped")
        elif self.proc.returncode == 0:
            self.on_event("done", self.final or "Done.")
        else:
            self.on_event("failed", f"codex exited with {self.proc.returncode}; see {LOG}")
        self._done.set()

    @property
    def running(self) -> bool:
        return self.proc is not None and not self._done.is_set()

    def wait(self) -> str | None:
        self._done.wait()
        return self.final

    def stop(self):
        """Stops Codex and the tool server it started."""
        self._stopped = True
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def print_event(kind: str, text: str):
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
