"""Offline durability and context tests; no app, account, screen or device access.

    AGENT_ENV_FILE=/dev/null .venv/bin/python tests/test_resumption.py

Artifacts are retained in temporary directories (these tests never delete files).
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
os.environ["AGENT_BACKEND"] = "codex"
from resumable_thread import ResumableThread, ResumeError
from agent_context import ContextLog, render_payload
import agent


class Fake:
    def __init__(self, error=None, identity=None):
        self.calls = []
        self.error = error
        self.identity = identity

    def request(self, method, params):
        self.calls.append((method, params))
        if self.error:
            raise self.error
        return {"thread": {"id": self.identity or params.get("threadId", "thread-123")}}


class Isolated(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="agent-resumption-test-"))
        patcher = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": str(self.directory),
                                               "CODEX_HOME": str(self.directory), "AGENT_ENV_FILE": "/dev/null"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.path = self.directory / "thread-id"


class IdentityTest(Isolated):
    def test_start_and_resume_from_new_instance(self):
        server = Fake()
        self.assertEqual(ResumableThread(self.path).connect(server, {"ephemeral": True}), "thread-123")
        self.assertFalse(server.calls[0][1]["ephemeral"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(ResumableThread(self.path).connect(server, {}), "thread-123")
        self.assertEqual(server.calls[1], ("thread/resume", {"threadId": "thread-123"}))

    def test_resume_error_retains_identity_and_never_starts(self):
        self.path.write_text("thread-original\n")
        server = Fake(error=RuntimeError("unavailable"))
        identity = ResumableThread(self.path)
        for _ in range(2):
            with self.assertRaisesRegex(ResumeError, "Conversation was not replaced"):
                identity.connect(server, {})
        self.assertEqual([m for m, _ in server.calls], ["thread/resume"] * 2)
        self.assertEqual(self.path.read_text(), "thread-original\n")

    def test_mismatch_never_overwrites(self):
        self.path.write_text("thread-original\n")
        with self.assertRaisesRegex(ResumeError, "mismatch"):
            ResumableThread(self.path).connect(Fake(identity="thread-different"), {})
        self.assertEqual(self.path.read_text(), "thread-original\n")

    def test_known_identity_cannot_be_silently_replaced_by_missing_state(self):
        identity = ResumableThread(self.path)
        server = Fake()
        identity.connect(server, {})
        with mock.patch.object(Path, "read_text", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ResumeError, "changed or disappeared"):
                identity.connect(server, {})
        self.assertEqual(len(server.calls), 1)

    def test_known_identity_cannot_be_silently_switched_by_changed_state(self):
        identity = ResumableThread(self.path)
        server = Fake()
        identity.connect(server, {})
        self.path.write_text("thread-another")
        with self.assertRaisesRegex(ResumeError, "changed or disappeared"):
            identity.connect(server, {})
        self.assertEqual(len(server.calls), 1)

    def test_invalid_existing_state_never_contacts_server(self):
        for state in ("", "\n", "thread-one\nthread-two", "../other", "!thread-start-pending"):
            with self.subTest(state=state):
                self.path.write_text(state)
                server = Fake()
                with self.assertRaises(ResumeError):
                    ResumableThread(self.path).connect(server, {})
                self.assertEqual(server.calls, [])
                self.assertEqual(self.path.read_text(), state)

    def test_unreadable_state_does_not_start(self):
        self.path.mkdir()
        server = Fake()
        with self.assertRaises(OSError):
            ResumableThread(self.path).connect(server, {})
        self.assertEqual(server.calls, [])

    def test_non_utf8_state_does_not_start(self):
        self.path.write_bytes(b"\xff")
        server = Fake()
        with self.assertRaises(ResumeError):
            ResumableThread(self.path).connect(server, {})
        self.assertEqual(server.calls, [])

    def test_ephemeral_response_is_rejected(self):
        server = mock.Mock()
        server.request.return_value = {"thread": {"id": "thread-123", "ephemeral": True}}
        with self.assertRaisesRegex(ResumeError, "ephemeral"):
            ResumableThread(self.path).connect(server, {})

    def test_start_timeout_blocks_another_start_after_restart(self):
        server = Fake(error=TimeoutError("no answer"))
        with self.assertRaises(ResumeError):
            ResumableThread(self.path).connect(server, {})
        with self.assertRaises(ResumeError):
            ResumableThread(self.path).connect(server, {})
        self.assertEqual(len(server.calls), 1)
        self.assertEqual(self.path.read_text(), "!thread-start-pending\n")

    def test_invalid_start_response_is_not_committed(self):
        server = Fake(identity="bad id")
        with self.assertRaises(ResumeError):
            ResumableThread(self.path).connect(server, {})
        self.assertEqual(self.path.read_text(), "!thread-start-pending\n")

    def test_failed_initial_state_write_never_contacts_server(self):
        server = Fake()
        with mock.patch("resumable_thread.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                ResumableThread(self.path).connect(server, {})
        self.assertEqual(server.calls, [])

    def test_failed_final_commit_blocks_replacement(self):
        from resumable_thread import atomic_write
        def write(path, text):
            if text.startswith("thread-"):
                raise OSError("disk full")
            atomic_write(path, text)
        server = Fake()
        with mock.patch("resumable_thread.atomic_write", side_effect=write):
            with self.assertRaises(ResumeError):
                ResumableThread(self.path).connect(server, {})
        with self.assertRaises(ResumeError):
            ResumableThread(self.path).connect(server, {})
        self.assertEqual(len(server.calls), 1)

    def test_concurrent_connections_create_once(self):
        server = Fake()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda _: ResumableThread(self.path).connect(server, {}), range(4)))
        self.assertEqual(ids, ["thread-123"] * 4)
        self.assertEqual([m for m, _ in server.calls].count("thread/start"), 1)


class ContextTest(Isolated):
    def records(self):
        return [json.loads(p.read_text()) for p in sorted((self.directory / "context").glob("*.json"))]

    def test_full_payload_and_screenshot_survive_viewer_restart(self):
        payload = {"input": [{"type": "text", "text": "long " * 2000},
                             {"type": "image", "url": "data:image/png;base64,QUJD"}]}
        log = ContextLog()
        log.record("turn/start input", payload, thread="thread-123")
        ContextLog().record("tool input", {"arguments": {"text": "next"}})
        self.assertEqual(self.records()[0]["payload"], payload)
        index = log.index.read_text()
        self.assertIn("turn/start input", index)
        self.assertIn("tool input", index)
        pages = [p.read_text() for p in log.directory.glob("[0-9]*.html")]
        self.assertTrue(any('src="data:image/png;base64,QUJD"' in p for p in pages))
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in log.directory.iterdir()))

    def test_untrusted_payload_is_escaped_and_cannot_load_remote_images(self):
        body = render_payload({"text": '<script>alert("x")</script>', "url": "https://example.com/x.png"})
        self.assertNotIn("<script>", body)
        self.assertIn("&lt;script&gt;", body)
        self.assertNotIn("<img", body)

    def test_mcp_and_claude_screenshots_render(self):
        for image in ({"type": "image", "mimeType": "image/jpeg", "data": "QUJD"},
                      {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}):
            self.assertIn('src="data:image/jpeg;base64,QUJD"', render_payload(image))

    def test_tool_records_exact_arguments_result_and_call_id(self):
        task = agent.CodexTask("test")
        result = {"content": [{"type": "text", "text": "output " * 1000},
                              {"type": "image", "mimeType": "image/png", "data": "QUJD"}]}
        tool = mock.Mock()
        tool.call.return_value = result
        task.tools = {"mac": tool}
        params = {"callId": "call-1", "namespace": "mac", "tool": "read_screen", "arguments": {"text": "input " * 1000}}
        reply = task._call_tool(params)
        records = self.records()
        self.assertEqual(records[0]["payload"], params)
        self.assertEqual(records[1]["payload"], {"callId": "call-1", "result": reply})
        self.assertEqual(reply, agent.tool_reply(result))

    def test_tool_exception_is_visible_in_the_exact_error_reply(self):
        task = agent.CodexTask("test")
        task.tools = {"mac": mock.Mock()}
        task.tools["mac"].call.side_effect = ValueError("tool broke")
        reply = task._call_tool({"tool": "click", "callId": "bad", "arguments": {}})
        self.assertFalse(reply["success"])
        self.assertIn("tool broke", self.records()[-1]["payload"]["result"]["contentItems"][0]["text"])

    def test_context_failure_warns_without_breaking_tools(self):
        events = []
        task = agent.CodexTask("test", on_event=lambda *e: events.append(e))
        task._stopped = True
        with mock.patch("agent.ContextLog.record", side_effect=OSError("disk full")):
            reply = task._call_tool({"tool": "click"})
        self.assertFalse(reply["success"])
        self.assertEqual(len(events), 1)
        self.assertIn("context could not be saved", events[0][1])

    def test_claude_tool_context(self):
        from claude_agent import ClaudeTask
        task = ClaudeTask("test", session=mock.Mock())
        task.tools = {"mac": mock.Mock()}
        result = {"content": [{"type": "image", "mimeType": "image/png", "data": "QUJD"}]}
        task.tools["mac"].call.return_value = result
        self.assertEqual(task._call_tool("mac", "screenshot", {}), result)
        self.assertEqual([r["kind"] for r in self.records()], ["Claude tool input", "Claude tool output"])


class SessionTest(Isolated):
    def test_server_replacement_resumes_without_replaying_primary_summaries(self):
        session = agent.Session(self.path)
        first = agent.CodexTask("first", session=session)
        session.add(first)
        one, two = Fake(), Fake()
        one.attach = two.attach = mock.Mock()
        identity, _ = session.thread_for(first, one, {})
        session.release(first)
        second = agent.CodexTask("second", session=session)
        session.add(second)
        resumed, earlier = session.thread_for(second, two, {})
        self.assertEqual(identity, resumed)
        self.assertEqual(earlier, "")
        self.assertEqual(two.calls, [("thread/resume", {"threadId": identity})])

    def test_prepare_failure_is_retried_as_resume_not_start(self):
        self.path.write_text("thread-existing")
        session = agent.Session(self.path)
        server = Fake(error=RuntimeError("offline"))
        with mock.patch("agent.running_server", return_value=server), mock.patch("agent.thread_params", return_value={}):
            session._prepare()
        task = agent.CodexTask("test", session=session)
        session.add(task)
        with self.assertRaises(ResumeError):
            session.thread_for(task, server, {})
        self.assertEqual([m for m, _ in server.calls], ["thread/resume"] * 2)

    def test_closed_session_does_not_start_thread(self):
        session = agent.Session(self.path)
        session._close()
        server = Fake()
        with self.assertRaises(ResumeError):
            session.thread_for(agent.CodexTask("test", session=session), server, {})
        self.assertEqual(server.calls, [])


class VoiceContextTest(Isolated):
    def test_context_event_is_forwarded_even_for_an_interrupted_task(self):
        from voice_agent import VoiceAgent
        voice = VoiceAgent.__new__(VoiceAgent)
        voice.tell = mock.Mock()
        voice.on_task_event(mock.Mock(), "context", "/tmp/synthetic/index.html")
        voice.tell.assert_called_once_with("context", "/tmp/synthetic/index.html")

    def test_listening_toggle_preserves_session_identity(self):
        from voice_agent import VoiceAgent
        voice = VoiceAgent.__new__(VoiceAgent)
        voice.listening = False
        voice.held = None
        voice.ears = mock.Mock()
        voice.captions = mock.Mock()
        voice.tell = voice.out = mock.Mock()
        session = agent.Session(self.path)
        with mock.patch.object(agent, "_session", session), mock.patch.object(session, "prepare"):
            voice.set_listening(True)
            voice.set_listening(False)
            voice.set_listening(True)
            self.assertIs(agent._session, session)


WORKER = r'''
import json, os, sys, threading
from pathlib import Path
from unittest import mock
import agent
from codex_app import AppServer
server = AppServer([sys.executable, str(Path(os.environ["TEST_ROOT"]) / "tests/fake_codex.py")])
tool = mock.Mock()
tool.call.return_value = {"content": [{"type": "text", "text": "synthetic tool result"},
                                     {"type": "image", "mimeType": "image/png", "data": "QUJD"}]}
events = []
finished = threading.Event()
def on_event(kind, text):
    events.append((kind, text))
    if kind in ("done", "failed"):
        finished.set()
agent._session = agent.Session()
with mock.patch("agent.codex_server", return_value=server), mock.patch("agent.device_tools", return_value={"mac": tool, "phone": tool}), mock.patch("agent.first_look", return_value=("data:image/png;base64,QUJD", "Synthetic windows: Notes")):
    task = agent.CodexTask(os.environ.get("TEST_PROMPT", "first request"), on_event=on_event).start()
    if not finished.wait(10):
        raise RuntimeError("task hung")
    if task._turn:
        task._turn_over.wait(3)
    print(json.dumps({"thread": task._thread, "final": task.final, "error": task._ended, "events": events}))
server.close()
'''


class ProcessRestartTest(Isolated):
    def worker(self, **extra):
        env = dict(os.environ, PYTHONPATH=str(ROOT / "python"), TEST_ROOT=str(ROOT),
                   FAKE_CODEX_LOG=str(self.directory / "server.jsonl"), FAKE_CODEX_SECONDS="0.01",
                   FAKE_CODEX_REPLY="Synthetic success", **extra)
        completed = subprocess.run([sys.executable, "-c", WORKER], env=env,
                                   capture_output=True, text=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def entries(self):
        return [json.loads(line) for line in (self.directory / "server.jsonl").read_text().splitlines()]

    def test_new_application_and_server_process_resume_same_conversation(self):
        first = self.worker()
        second = self.worker(TEST_PROMPT="follow-up")
        self.assertEqual(first["final"], "Synthetic success")
        self.assertEqual(second["final"], "Synthetic success")
        self.assertEqual(second["thread"], first["thread"])
        entries = self.entries()
        self.assertEqual(len([e for e in entries if "started" in e]), 1)
        self.assertEqual([e["resumed"] for e in entries if "resumed" in e], [first["thread"]])
        turns = [e for e in entries if "prompt" in e]
        self.assertIn("first request", turns[1]["prior_prompts"][0])
        self.assertEqual(turns[1]["tools"], ["mac", "phone"])
        records = [json.loads(p.read_text()) for p in (self.directory / "context").glob("*.json")]
        requests = [r for r in records if r["kind"] == "turn/start input"]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["payload"]["input"][1]["url"], "data:image/png;base64,QUJD")
        self.assertTrue(any(r["kind"] == "thread/resume output" for r in records))

    def test_failed_resume_is_reported_and_never_starts_or_runs_a_turn(self):
        first = self.worker()
        failed = self.worker(FAKE_CODEX_RESUME_ERROR="1")
        self.assertIsNone(failed["final"])
        self.assertIn("Conversation was not replaced", failed["error"])
        self.assertTrue(any(e[0] == "failed" for e in failed["events"]))
        self.assertEqual(len([e for e in self.entries() if "started" in e]), 1)
        self.assertEqual(len([e for e in self.entries() if "prompt" in e]), 1)
        self.assertEqual((self.directory / "codex-thread-id").read_text().strip(), first["thread"])
        self.assertEqual(self.worker()["thread"], first["thread"])


if __name__ == "__main__":
    unittest.main()
