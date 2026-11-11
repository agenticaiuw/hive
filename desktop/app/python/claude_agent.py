"""The computer agent on Claude, through your Claude subscription (the logged-in `claude` CLI, run by
the Claude Agent SDK), in place of Codex. Same interface as agent.CodexTask, which agent.py swaps
this in for when AGENT_BACKEND=claude (Codex is the default).

One Claude Code process per conversation (Session), started when you tap fn so it is ready before
you've finished talking; each request is a turn on it, so it has the earlier ones in context. Its
built-in tools are off: the only tools are the Mac's and the iPhone's (mcp__mac__*, mcp__phone__*),
run in this process. Replies stream, so each sentence goes to the voice as soon as it is written.

Environment (or .env):
  AGENT_MODEL   model (default: claude-opus-5-5; claude-sonnet-5-5 or claude-haiku-5-5 are quicker, less careful)
  AGENT_FAST    1: Claude Code's fast mode (needs extra usage turned on for your account; else it is off)
  AGENT_EFFORT  low (default), medium, high
Log in once with `claude auth login` if it says the session expired.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import asdict, is_dataclass
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from resumable_thread import atomic_write, state_dir, ResumeError

import agent as A

MODEL = "claude-opus-5-5"
LOG = A.LOG.replace("codex", "claude")

_loop: asyncio.AbstractEventLoop | None = None
_loop_lock = threading.Lock()


def loop() -> asyncio.AbstractEventLoop:
    """The event loop all the Claude connections run on, in a thread of its own."""
    global _loop
    with _loop_lock:
        if _loop is None:
            _loop = asyncio.new_event_loop()
            threading.Thread(target=_loop.run_forever, daemon=True, name="claude-loop").start()
        return _loop


def run(coro):
    return asyncio.run_coroutine_threadsafe(coro, loop())


def model() -> str:
    m = os.environ.get("AGENT_MODEL") or ""
    return m if m.startswith("claude") else MODEL


def effort() -> str:
    return os.environ.get("AGENT_EFFORT") or A.EFFORT


def describe_model() -> str:
    return f"{model()}, {effort()} effort" + (", fast mode" if A.fast() else "") + ", on your Claude subscription"


def warm_up():
    import desktop
    threading.Thread(target=desktop.browser_tabs, kwargs={"timeout": 120}, daemon=True).start()
    A._session.prepare()


class Conn:
    """One Claude Code process and the task whose turn is on it."""

    def __init__(self, persistent=False):
        self.task: ClaudeTask | None = None
        self.identity_path = state_dir() / "claude-session-id" if persistent else None
        self.session_id = None
        if self.identity_path and self.identity_path.exists():
            saved = self.identity_path.read_text(encoding="utf-8").strip()
            try:
                self.session_id = str(uuid.UUID(saved))
            except ValueError as error:
                raise ResumeError("Invalid saved Claude session ID; refusing to replace the conversation") from error
        self.client = None
        self.lock: asyncio.Lock | None = None
        self.ready = run(self._connect())

    def options(self):
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool
        import mac_mcp
        import phone_mcp
        servers, allowed = {}, ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]
        for device, specs in (("mac", mac_mcp.TOOLS), ("phone", phone_mcp.TOOLS)):
            tools = []
            for spec in specs:
                def handler(device=device, name=spec["name"]):
                    async def call(args):
                        task = self.task
                        if task is None:
                            return {"content": [{"type": "text", "text": "No task."}], "is_error": True}
                        res = await asyncio.to_thread(task._call_tool, device, name, args or {})
                        return {"content": res.get("content", []), "is_error": bool(res.get("isError"))}
                    return call
                tools.append(tool(spec["name"], spec["description"], spec["inputSchema"])(handler()))
                allowed.append(f"mcp__{device}__{spec['name']}")
            servers[device] = create_sdk_mcp_server(device, tools=tools)
        spaceo = os.environ.get("AGENT_SPACEO_COMMAND", "")
        if spaceo:
            servers["spaceo"] = {"type": "stdio", "command": sys.executable,
                                  "args": [os.path.join(A.HERE, "spaceo_mcp_bridge.py"), spaceo]}
            allowed.append("mcp__spaceo__*")
        return ClaudeAgentOptions(
            model=model(), effort=effort(), tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
            allowed_tools=allowed, mcp_servers=servers,
            strict_mcp_config=True, setting_sources=[], skills=[],
            system_prompt=A.instructions() + "\n\n" + A.RULES + (A.spaceo_rules() if spaceo else ""), include_partial_messages=True,
            cwd=os.path.dirname(A.HERE),
            settings=json.dumps({"fastMode": True}) if A.fast() else None,
            resume=self.session_id,
            extra_args={} if self.identity_path else {"no-session-persistence": None})

    def remember_session(self, value):
        if not self.identity_path:
            return
        try:
            identity = str(uuid.UUID(value))
        except (ValueError, TypeError, AttributeError) as error:
            raise ResumeError("Claude returned an invalid session ID") from error
        if self.session_id and self.session_id != identity:
            raise ResumeError("Claude session ID changed; refusing to replace the conversation")
        if not self.session_id:
            atomic_write(self.identity_path, identity + "\n")
            self.session_id = identity

    async def _connect(self):
        from claude_agent_sdk import ClaudeSDKClient
        os.makedirs(os.path.join(os.environ.get("TMPDIR", "/tmp"), "agent-vhid-work"), exist_ok=True)
        self.lock = asyncio.Lock()
        self.client = ClaudeSDKClient(self.options())
        await self.client.connect()

    def close(self):
        async def stop():
            try:
                await self.client.disconnect()
            except Exception:
                pass
        if self.client is not None:
            run(stop())


class Session:
    """The requests from when you tap fn to talk: turns on one Claude Code process (so each has the
    ones before it in context). A request for the other device while one is under way gets a process
    of its own, told what was said so far."""

    def __init__(self):
        self.tasks: list[ClaudeTask] = []
        self.primary: Conn | None = None
        self._lock = threading.Lock()
        self._closed = False

    @property
    def busy(self) -> bool:
        return any(t.running for t in self.tasks)

    def add(self, task):
        self.tasks.append(task)

    def prepare(self):
        """Starts the process now, so the first request doesn't wait for it."""
        with self._lock:
            if self.primary is None and not self._closed:
                self.primary = Conn(persistent=True)

    def acquire(self, task) -> tuple[Conn, bool]:
        with self._lock:
            if self.primary is None:
                self.primary = Conn(persistent=True)
            if self.primary.task is None or not self.primary.task.running:
                self.primary.task = task
                return self.primary, True
        conn = Conn()
        conn.task = task
        return conn, False

    def close(self):
        with self._lock:
            self._closed = True
            conn, self.primary = self.primary, None
        if conn:
            conn.close()

    def said_before(self, task, everything: bool) -> str:
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


def new_session() -> bool:
    """Keep the existing conversation when listening is toggled."""
    with A._session_lock:
        old = A._session
        if old.busy:
            return False
        old.prepare()
    return True


def split_data_url(url: str) -> tuple[str, str]:
    head, data = url.split(",", 1)
    return head[5:].split(";")[0], data


class ClaudeTask(A.CodexTask):
    """A request, run on Claude in the background; events and fields as for CodexTask."""

    def __init__(self, task, previous=None, on_event=None, device=None, session=None, ahead=None):
        super().__init__(task, previous=previous, on_event=on_event, device=device,
                         session=session or A._session, ahead=ahead)
        self._conn: Conn | None = None
        self._message = ""  # id of the message being written

    # -- running --------------------------------------------------------------------------------
    def _run(self, look: bool):
        self._log = open(LOG, "a", buffering=1)
        self._log.write(f"\n=== {self.device}: {self.task}  ({describe_model()})\n")
        try:
            self.tools = A.device_tools()
            content, seen = self._prompt_with_look(look)
            if self._stopped:
                return self._finish("failed", "stopped")
            self._conn, self.on_thread = self.session.acquire(self)
            earlier = self.session.said_before(self, everything=not self.on_thread)
            content[0]["text"] = earlier + content[0]["text"]
            fut = run(self._take_turn(content))
            self._time("codex")
            try:
                fut.result()
            except Exception as e:
                self._finish("failed", f"Claude: {e} (see {LOG})")
            self._done.wait()
        finally:
            if self._conn is not None:
                self._conn.task = None
                if not self.on_thread:
                    self._conn.close()
            if self.tools:
                self.tools["mac"].mac.close()
            log, self._log = self._log, None
            log.close()

    def _prompt_with_look(self, look: bool):
        attached, seen = "", None
        if look:
            seen = self.ahead.seen() if self.ahead else None
            self.looked_ahead = seen is not None
            if seen is None:
                seen = A.first_look(self.tools[self.device], context=self.device == "mac")
            self._time("look")
        content = [{"type": "text", "text": ""}]
        if seen:
            image, about = seen
            attached = (f"\nAttached: a screenshot of the {A.DEVICES[self.device]} taken as they asked, in the same "
                        f"coordinates as its tools. {about}\n")
            mime, data = split_data_url(image)
            content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
            self._event("action", "screenshot (taken as you started talking)" if self.looked_ahead
                        else "screenshot (attached to the request)")
        content[0]["text"] = self.prompt + attached
        return content, seen

    async def _take_turn(self, content):
        conn = self._conn
        await asyncio.wrap_future(conn.ready)

        async def messages():
            yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None}

        async with conn.lock:  # the process takes one turn at a time (a stopped one is over in a moment)
            if self._stopped:
                return self._finish("failed", "stopped")
            self._record_context("Claude request", {"system_prompt": A.instructions() + "\n\n" + A.RULES,
                                                    "content": content})
            await conn.client.query(messages())
            self._event("doing", "Thinking")
            async for m in conn.client.receive_response():
                self._handle(m)

    # -- what Claude sends ----------------------------------------------------------------------
    def _handle(self, m):
        from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent, SystemMessage, ToolResultBlock, ToolUseBlock, \
            TextBlock, UserMessage
        if not isinstance(m, StreamEvent) and is_dataclass(m):
            self._record_context(type(m).__name__, asdict(m))
        if isinstance(m, SystemMessage) and m.subtype == "init":
            self._conn.remember_session(m.data.get("session_id"))
        elif isinstance(m, StreamEvent):
            if m.parent_tool_use_id or self._stopped:
                return
            e = m.event
            kind = e.get("type")
            if kind == "message_start":
                self.model_calls += 1
                self._message = (e.get("message") or {}).get("id", "")
                self._written[self._message] = ""
            elif kind == "content_block_start" and (e.get("content_block") or {}).get("type") == "tool_use":
                name = e["content_block"].get("name", "")
                self._event("doing", A.doing({"tool": name.split("__")[-1], "arguments": {}}))
            elif kind == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                text = self._written[self._message] = self._written.get(self._message, "") + e["delta"]["text"]
                self._speak(self._message, text)
        elif isinstance(m, AssistantMessage):
            if m.error:
                self._event("error", " ".join(b.text for b in m.content if isinstance(b, TextBlock))[:300] or m.error)
            texts = []
            for b in m.content:
                if isinstance(b, ToolUseBlock):
                    _, device, tool = b.name.split("__", 2) if b.name.startswith("mcp__") else ("", "", b.name)
                    item = {"tool": tool, "namespace": device, "arguments": b.input}
                    self._event("action", A.describe_call(item))
                    self._event("doing", A.doing(item))
                elif isinstance(b, TextBlock):
                    texts.append(b.text)
            text = "".join(texts).strip()
            if text and not m.error:
                self.final = text
                if not self._stopped:
                    self._speak(m.message_id or self._message, text, whole=True)
        elif isinstance(m, UserMessage) and isinstance(m.content, list):
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    if b.is_error:
                        body = b.content if isinstance(b.content, str) else " ".join(
                            c.get("text", "") for c in b.content or [] if isinstance(c, dict))
                        self._event("error", body[:300] or "failed")
                    self._event("doing", "Thinking")
        elif isinstance(m, ResultMessage):
            self._conn.remember_session(m.session_id)
            usage = m.usage or {}
            self._wrote = usage.get("output_tokens", 0)
            if self._stopped:
                self._finish("failed", "stopped")
            elif m.is_error:
                self._finish("failed", (m.result or self.final or m.subtype)[:300])
            else:
                self._finish("done", self.final or m.result or "Done.")

    def _call_tool(self, device: str, name: str, args: dict) -> dict:
        self._record_context("Claude tool input", {"namespace": device, "tool": name, "arguments": args})
        tools = self.tools.get(device)
        if self._stopped or tools is None:
            text = "Stopped by the user." if self._stopped else f"There are no {device} tools."
            result = {"content": [{"type": "text", "text": text}], "isError": True}
        else:
            try:
                result = tools.call(name, args)
            except Exception as error:
                result = {"content": [{"type": "text", "text": f"Failed: {error}"}], "isError": True}
        self._record_context("Claude tool output", result)
        return result

    def stop(self):
        with self._lock:
            self._stopped = True
        conn = self._conn
        if conn is not None and conn.client is not None:
            async def interrupt():
                try:
                    await conn.client.interrupt()
                except Exception:
                    pass
            run(interrupt())
        self.final = None
        self._finish("failed", "stopped")
