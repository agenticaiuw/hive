"""A connection to `codex app-server`: the server the Codex app and its IDE extensions use, signed in
with your ChatGPT account, so it runs on your Codex subscription. agent.py keeps one running the
whole time, with a thread on it for each conversation and a turn for each request, which beats
`codex exec` because
- our own few lines of instructions replace Codex's coding-agent system prompt,
- the model gets our Mac and iPhone tools directly, and calls back into this process to use them
  (no MCP server in between),
- nothing starts up per task, and the prompt cache stays warm from one task to the next.

The protocol is JSON-RPC, one message per line on stdin/stdout (`codex app-server
generate-json-schema` describes it).
"""

from __future__ import annotations

import json
import subprocess
import threading
import time


class CodexError(Exception):
    pass


class AppServer:
    """on_message(method, params) gets a thread's notifications, and ("exited", {}) if the server
    stops; on_tool_call(params) answers its tool calls, each on its own thread since tools can
    take a while."""

    def __init__(self, command: list[str], stderr=None, cwd: str | None = None):
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                     cwd=cwd, text=True, start_new_session=True)
        self._write = threading.Lock()
        self._lock = threading.Lock()
        self._next = 0
        self._pending: dict[int, list] = {}  # id -> [Event, reply]
        self._threads: dict[str, tuple] = {}  # thread id -> (on_message, on_tool_call)
        threading.Thread(target=self._read, daemon=True).start()
        self.request("initialize", {"clientInfo": {"name": "personal-agent", "title": "personal-agent voice agent",
                                                   "version": "1.0"},
                                    "capabilities": {"experimentalApi": True}})  # dynamicTools is experimental
        self.notify("initialized")

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def request(self, method: str, params: dict, timeout: float = 60) -> dict:
        with self._lock:
            self._next += 1
            msg_id = self._next
            waiter = self._pending[msg_id] = [threading.Event(), None]
        self._send({"id": msg_id, "method": method, "params": params})
        if not waiter[0].wait(timeout):
            self._pending.pop(msg_id, None)
            raise CodexError(f"{method}: no answer from Codex in {timeout:.0f} s")
        reply = waiter[1]
        if reply is None:
            raise CodexError(f"{method}: Codex stopped")
        if "error" in reply:
            raise CodexError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result") or {}

    def notify(self, method: str, params: dict | None = None):
        self._send({"method": method, **({"params": params} if params is not None else {})})

    def attach(self, thread_id: str, on_message, on_tool_call):
        with self._lock:
            self._threads[thread_id] = (on_message, on_tool_call)

    def detach(self, thread_id: str):
        with self._lock:
            self._threads.pop(thread_id, None)

    def close(self):
        try:
            self.proc.stdin.close()  # it exits when its input ends
            self.proc.wait(3)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()

    def _send(self, msg: dict):
        with self._write:
            try:
                self.proc.stdin.write(json.dumps(msg) + "\n")
                self.proc.stdin.flush()
            except (OSError, ValueError) as e:
                raise CodexError(f"Codex isn't running ({e})") from e

    def _read(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" not in msg:  # the answer to one of our requests
                waiter = self._pending.pop(msg.get("id"), None)
                if waiter:
                    waiter[1] = msg
                    waiter[0].set()
            elif "id" in msg:  # Codex asks us something
                threading.Thread(target=self._answer, args=(msg,), daemon=True).start()
            else:
                handlers = self._threads.get((msg.get("params") or {}).get("threadId"))
                if handlers:
                    handlers[0](msg["method"], msg.get("params") or {})
        self.proc.wait()
        for waiter in list(self._pending.values()):
            waiter[0].set()
        for on_message, _ in list(self._threads.values()):
            on_message("exited", {"code": self.proc.returncode})

    def _answer(self, msg: dict):
        method, params = msg["method"], msg.get("params") or {}
        handlers = self._threads.get(params.get("threadId"))
        reply: dict = {"id": msg["id"]}
        try:
            if method == "item/tool/call" and handlers:
                reply["result"] = handlers[1](params)
            elif method == "currentTime/read":
                reply["result"] = {"currentTimeAt": int(time.time())}
            elif method.endswith("requestApproval"):  # the agent has no shell or file edits to approve
                reply["result"] = {"decision": "decline"}
            else:
                reply["error"] = {"code": -32601, "message": f"{method} isn't supported here"}
        except Exception as e:  # a tool that crashed: tell the model rather than leave it waiting
            reply["result"] = {"success": False, "contentItems": [{"type": "inputText", "text": f"Failed: {e}"}]}
        try:
            self._send(reply)
        except CodexError:
            pass
