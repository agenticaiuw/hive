"""Runs python/live_agent.py against a fake GPT-Live server, the helper in --dry-run mode and a
fake Codex, and checks the conversation plumbing: session setup, audio, handing a request to the
computer agent, reporting back, stopping, closing when idle and remembering on reconnect.

    .venv/bin/python tests/test_live.py
"""

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from test_dry_run import Helper  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError  # noqa: E402

try:
    from websockets.asyncio.server import serve
except ImportError:
    serve = None

LIVE_AGENT = os.path.join(ROOT, "python", "live_agent.py")
FAKE_CODEX = os.path.join(HERE, "fake_codex.py")


class FakeLive:
    """Plays GPT-Live's side of the WebSocket and records what the agent sends (audio is counted)."""

    def __init__(self):
        self.received: list[dict] = []
        self.audio_bytes = 0
        self.auth = None
        self.conn = None
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        async def start():
            return await serve(self.handle, "127.0.0.1", 0)
        self.server = self.run(start())
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(10)

    async def handle(self, conn):
        self.auth = conn.request.headers.get("Authorization")
        self.conn = conn
        silence = asyncio.ensure_future(self.stream_silence(conn))
        try:
            async for raw in conn:
                event = json.loads(raw)
                if event["type"] == "session.input_audio.append":
                    self.audio_bytes += len(base64.b64decode(event["audio"]))
                    continue
                self.received.append(event)
                if event["type"] == "session.start":
                    await conn.send(json.dumps({"type": "session.started", "event_id": "evt_1",
                                                "session": {"id": "sess_1", "status": "active", "model": "gpt-live-1"}}))
                elif event["type"] == "session.close":
                    await conn.send(json.dumps({"type": "session.closed", "event_id": "evt_2",
                                                "reason": "close_requested", "usage": {"seconds": 3}}))
                    await conn.close()
        finally:
            silence.cancel()

    async def stream_silence(self, conn):
        """Like the real thing: output audio never stops, it's just zeros between sentences."""
        silence = json.dumps({"type": "session.output_audio.delta", "delta": base64.b64encode(bytes(4800)).decode()})
        await asyncio.sleep(0.2)  # after session.started
        try:
            while True:
                await conn.send(silence)
                await asyncio.sleep(0.1)
        except Exception:  # the conversation closed
            pass

    def send(self, *events: dict):
        async def go():
            for event in events:
                await self.conn.send(json.dumps(event))
        self.run(go())

    def wait_for(self, kind: str, timeout: float = 10, **fields) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for event in self.received:
                if event["type"] == kind and all(event.get(k) == v for k, v in fields.items()):
                    return event
            time.sleep(0.05)
        raise AssertionError(f"no {kind} {fields}; got {[e['type'] for e in self.received]}")

    def stop(self):
        self.server.close()
        self.loop.call_soon_threadsafe(self.loop.stop)


def said(role: str, text: str) -> dict:
    kind = "session.input_transcript.delta" if role == "user" else "session.output_transcript.delta"
    return {"type": kind, "event_id": "t", "delta": text, "start_ms": 0, "end_ms": 100}


def delegate(delegation_id: str) -> dict:
    return {"type": "session.delegation.created", "event_id": "d", "offset_ms": 1000,
            "delegation": {"id": delegation_id, "type": "delegation", "target": "client"}}


@unittest.skipIf(serve is None, "needs the .venv packages: run with .venv/bin/python")
class LiveAgentTest(unittest.TestCase):
    def setUp(self):
        self.helper = Helper()
        self.addCleanup(self.helper.stop)
        self.live = FakeLive()
        self.addCleanup(self.live.stop)
        self.agent = None
        self.addCleanup(self.stop_agent)
        self.dir = tempfile.mkdtemp(prefix="live-")
        self.codex_log = os.path.join(self.dir, "codex.jsonl")
        self.output: list[str] = []
        self.gate: list[dict] = []
        threading.Thread(target=self._watch_gate, daemon=True).start()

    def stop_agent(self):
        if self.agent and self.agent.poll() is None:
            self.agent.terminate()
            self.agent.wait(15)
        if self.agent:
            self.agent.stdout.close()

    def _watch_gate(self):
        try:
            for event in AgentVHID(self.helper.socket).watch():
                self.gate.append(event)
        except AgentVHIDError:
            pass  # the helper stopped at the end of the test

    def start_agent(self, **env):
        env = {**os.environ, "AGENT_ENV_FILE": os.devnull, "OPENAI_API_KEY": "sk-test", "LIVE_URL": self.live.url,
               "LIVE_AUDIO": "none", "LIVE_IDLE_SECONDS": "1.5", "AGENT_VHID_SOCKET": self.helper.socket,
               "CODEX_BIN": FAKE_CODEX, "FAKE_CODEX_LOG": self.codex_log, "PYTHONUNBUFFERED": "1", **env}
        self.agent = subprocess.Popen([sys.executable, LIVE_AGENT], env=env, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=lambda: [self.output.append(l.rstrip()) for l in self.agent.stdout], daemon=True).start()
        self.wait_output("Ready.")

    def wait_output(self, text: str, timeout: float = 10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(text in line for line in self.output):
                return
            time.sleep(0.05)
        raise AssertionError(f"no {text!r} in output:\n" + "\n".join(self.output))

    def talk(self):
        self.helper.raw("talk down")
        time.sleep(0.3)
        self.helper.raw("talk up")

    def prompts(self) -> list[str]:
        try:
            with open(self.codex_log) as f:
                return [json.loads(line)["prompt"] for line in f]
        except FileNotFoundError:
            return []

    def test_request_goes_to_the_computer_agent_and_the_result_comes_back(self):
        self.start_agent()
        self.talk()
        start = self.live.wait_for("session.start")["session"]
        self.assertEqual(self.live.auth, "Bearer sk-test")
        self.assertEqual(start["model"], "gpt-live-1")
        self.assertEqual(start["delegation"], {"type": "client"})
        self.assertEqual(start["audio"], {"format": {"type": "audio/pcm", "rate": 24000}, "output": {"voice": "marin"}})
        self.assertNotIn("input", start)  # nothing to remember yet

        self.live.send(said("user", "Open Calculator and "), said("user", "work out 12 times 34."),
                       said("assistant", "On it. [hum"), said("assistant", "]"),
                       {"type": "session.output_audio.delta", "delta": base64.b64encode(bytes(4800)).decode()},
                       delegate("item_1"))
        result = self.live.wait_for("session.commentary.append", delegation_id="item_1")
        self.assertIn("Calculator shows 408.", result["content"])
        self.assertGreater(self.live.audio_bytes, 0)  # silence keeps streaming between turns
        self.assertIn('"Open Calculator and work out 12 times 34."', self.prompts()[0])
        states = [(e.get("state"), e.get("reason")) for e in self.gate if "state" in e]
        self.assertIn(("engaged", "engaged_by_voice"), states)
        self.assertEqual(states[-1], ("disengaged", "released_by_agent"))

        # Quiet for LIVE_IDLE_SECONDS: the conversation closes (GPT-Live bills by the second), even
        # though GPT-Live keeps streaming silent audio.
        self.live.wait_for("session.close", timeout=10)
        self.wait_output("conversation closed: 3 s")

        # Talking again opens a new conversation that remembers the last one.
        self.live.received.clear()
        self.talk()
        history = self.live.wait_for("session.start")["session"]["input"]
        self.assertEqual(history[0], {"type": "message", "role": "user",
                                      "content": [{"type": "input_text", "text": "Open Calculator and work out 12 times 34."}]})
        self.assertEqual(history[1]["role"], "assistant")
        self.assertEqual(history[1]["content"][0], {"type": "output_text", "text": "On it."})

    def test_saying_stop_stops_the_computer_agent(self):
        self.start_agent(FAKE_CODEX_SECONDS="60", LIVE_IDLE_SECONDS="30")
        self.talk()
        self.live.wait_for("session.start")
        self.live.send(said("user", "Open Safari."), delegate("item_1"))
        deadline = time.time() + 10
        while not self.prompts() and time.time() < deadline:
            time.sleep(0.05)
        self.wait_output("🧠 computer agent: Open Safari.")

        self.talk()
        self.live.send(said("user", "Stop."), delegate("item_2"))
        self.wait_output("⏹  stopped")
        reply = self.live.wait_for("session.commentary.append", delegation_id="item_2")
        self.assertEqual(reply["content"], "The computer agent has stopped.")
        self.assertFalse(any(e["type"] == "session.commentary.append" and e["delegation_id"] == "item_1"
                             for e in self.live.received))  # the stopped task reports nothing
        self.assertEqual(len(self.prompts()), 1)

    def test_a_new_request_replaces_the_running_task(self):
        self.start_agent(FAKE_CODEX_SECONDS="2", LIVE_IDLE_SECONDS="30")
        self.talk()
        self.live.wait_for("session.start")
        self.live.send(said("user", "Open Safari."), delegate("item_1"))
        self.wait_output("🧠 computer agent: Open Safari.")
        self.talk()
        self.live.send(said("user", "Actually, open Notes instead."), delegate("item_2"))
        self.wait_output("(interrupted the previous task)")
        self.live.wait_for("session.commentary.append", delegation_id="item_2", timeout=15)
        second = self.prompts()[1]
        self.assertIn('"Actually, open Notes instead."', second)
        self.assertIn("Before that they had asked: \"Open Safari.\"", second)
        self.assertIn("User: Open Safari.", second)


if __name__ == "__main__":
    unittest.main(verbosity=2)
