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

    def attach(self, *args):
        pass

    def detach(self, *args):
        pass


class Isolated(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="agent-resumption-test-"))
        patcher = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": str(self.directory),
                                               "CODEX_HOME": str(self.directory), "AGENT_ENV_FILE": "/dev/null"})
        patcher.start()
        self.addCleanup(patcher.stop)
        # Physical-mode tests must not inherit the caller's live workspace mode.
        for key in ("AGENT_SPACEO_COMMAND", "AGENT_WORKSPACE_CONNECTION"):
            os.environ.pop(key, None)
        self.path = self.directory / "thread-id"

    def test_general_prompt_mentions_computer_input_without_personal_task_rules(self):
        text = (agent.instructions() + " " + agent.RULES).lower()
        self.assertIn("mouse", text)
        self.assertIn("keyboard", text)
        self.assertIn("workspace", text)
        self.assertNotIn("eric wait", text)
        self.assertNotIn("don't add tasks", text)
        self.assertNotIn("use safari", text)

    def test_active_goal_retains_task_for_next_turn(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = agent.time.monotonic()
        task._turn = "first"
        task._thread = "thread"
        task._between_goal_turns = True
        task._server = mock.Mock()
        task._server.request.return_value = {"goal": {"status": "active"}}
        task._done.wait = mock.Mock(side_effect=lambda _: setattr(task, "_between_goal_turns", False))
        task._await_goal_continuation("first")
        self.assertTrue(task.running)
        task._between_goal_turns = True
        task._record_context = mock.Mock()
        task._on_message("turn/started", {"turn": {"id": "second"}})
        self.assertEqual(task._turn, "second")
        self.assertTrue(task.running)

    def test_goal_blocked_ends_task_without_retry(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = agent.time.monotonic()
        task._turn = "first"
        task._thread = "thread"
        task._between_goal_turns = True
        task._server = mock.Mock()
        task._server.request.return_value = {"goal": {"status": "blocked"}}
        task.session = mock.Mock()
        task._await_goal_continuation("first")
        self.assertFalse(task.running)
        self.assertIn("blocked", task._ended)
        task._server.request.assert_called_once()

    def test_watchdog_continues_only_an_idle_active_thread(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = 0
        task._turn = "first"
        task._thread = "thread"
        task._between_goal_turns = True
        task._server = mock.Mock()
        def request(method, params, timeout):
            if method == "thread/goal/get": return {"goal": {"status": "active"}}
            if method == "thread/read": return {"thread": {"status": {"type": "idle"}}}
            if method == "turn/start":
                task._between_goal_turns = False
                return {"turn": {"id": "next"}}
            self.fail(method)
        task._server.request.side_effect = request
        task._done.wait = mock.Mock()
        with mock.patch("agent.time.monotonic", side_effect=[0, 31, 32]):
            task._await_goal_continuation("first")
        calls = [call.args[0] for call in task._server.request.call_args_list]
        self.assertEqual(calls, ["thread/goal/get", "thread/read", "thread/goal/get", "turn/start"])
        self.assertTrue(task.running)

    def test_watchdog_never_wakes_a_running_thread(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = 0
        task._turn = "first"
        task._thread = "thread"
        task._between_goal_turns = True
        task._server = mock.Mock()
        task._server.request.side_effect = lambda method, *a, **kw: (
            {"goal": {"status": "active"}} if method == "thread/goal/get" else
            {"thread": {"status": {"type": "active", "activeFlags": []}}})
        task._done.wait = mock.Mock(side_effect=lambda _: setattr(task, "_between_goal_turns", False))
        with mock.patch("agent.time.monotonic", side_effect=[0, 31, 32]):
            task._await_goal_continuation("first")
        self.assertNotIn("turn/start", [call.args[0] for call in task._server.request.call_args_list])

    def test_provider_recovery_does_not_retry_usage_or_auth_failures(self):
        classify = agent.CodexTask._recoverable_goal_error
        self.assertTrue(classify({"codexErrorInfo": "serverOverloaded"}))
        self.assertTrue(classify({"codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": 503}}}))
        self.assertFalse(classify({"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 429}}}))
        self.assertFalse(classify({"codexErrorInfo": "usageLimitExceeded"}))
        self.assertFalse(classify({"codexErrorInfo": "unauthorized"}))

    def test_watchdog_rechecks_goal_before_waking_thread(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = 0
        task._turn, task._thread = "first", "thread"
        task._between_goal_turns = True
        task._server = mock.Mock()
        responses = iter([{"goal": {"status": "active"}},
                          {"thread": {"status": {"type": "idle"}}},
                          {"goal": {"status": "paused"}}])
        task._server.request.side_effect = lambda *a, **kw: next(responses)
        task._done.wait = mock.Mock(side_effect=lambda _: setattr(task, "_between_goal_turns", False))
        with mock.patch("agent.time.monotonic", side_effect=[0, 31, 32]):
            task._await_goal_continuation("first")
        self.assertNotIn("turn/start", [call.args[0] for call in task._server.request.call_args_list])

    def test_explicit_stop_pauses_active_goal_before_interrupt(self):
        task = agent.CodexTask("continue")
        task.on_thread = True
        task._thread, task._turn = "thread", "turn"
        task._server = mock.Mock()
        task._server.request.return_value = {"goal": {"status": "active"}}
        task._pause_goal_and_interrupt()
        self.assertEqual([c.args[0] for c in task._server.request.call_args_list],
                         ["thread/goal/get", "thread/goal/set", "turn/interrupt"])
        self.assertEqual(task._server.request.call_args_list[1].args[1]["status"], "paused")

    def test_watchdog_rechecks_after_transient_status_failure(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = 0
        task._turn, task._thread = "first", "thread"
        task._between_goal_turns = True
        task._server = mock.Mock(alive=True)
        task._server.request.side_effect = [agent.CodexError("timeout"),
                                           {"goal": {"status": "active"}}]
        waits = []
        def wait(seconds):
            waits.append(seconds)
            if len(waits) == 2:
                task._between_goal_turns = False
        task._done.wait = mock.Mock(side_effect=wait)
        with mock.patch("agent.time.monotonic", return_value=0):
            task._await_goal_continuation("first")
        self.assertEqual(task._server.request.call_count, 2)
        self.assertTrue(task.running)
        self.assertNotIn("turn/start", [c.args[0] for c in task._server.request.call_args_list])

    def test_stale_goal_reply_does_not_finish_new_continuation(self):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = agent.time.monotonic()
        task._turn, task._thread = "first", "thread"
        task._between_goal_turns = True
        task._server = mock.Mock(alive=True)
        task._record_context = mock.Mock()
        task.session = mock.Mock()
        def request(*args, **kwargs):
            task._on_message("turn/started", {"turn": {"id": "second"}})
            return {"goal": {"status": "blocked"}}
        task._server.request.side_effect = request
        task._await_goal_continuation("first")
        self.assertTrue(task.running)
        self.assertEqual(task._turn, "second")
        task.session.release.assert_not_called()

    def test_late_continuation_after_stop_is_interrupted(self):
        task = agent.CodexTask("continue")
        task._thread, task._turn = "thread", "first"
        task._between_goal_turns = True
        task._stopped = True
        task._server = mock.Mock()
        with mock.patch("agent.threading.Thread") as thread:
            task._on_message("turn/started", {"turn": {"id": "second"}})
        self.assertEqual(task._turn, "second")
        self.assertEqual(thread.call_args.kwargs["target"], task._interrupt)
        thread.return_value.start.assert_called_once()

    def test_server_recovery_resumes_saved_thread_without_replaying_request(self):
        task = agent.CodexTask("original action")
        task._started = task.on_thread = True
        task._thread, task._turn = "saved-thread", "old-turn"
        task.session = mock.Mock()
        task.session.thread_for.return_value = ("saved-thread", "")
        server = mock.Mock()
        def request(method, params, timeout):
            if method == "thread/goal/get": return {"goal": {"status": "active"}}
            if method == "thread/read": return {"thread": {"status": {"type": "idle"}}}
            if method == "turn/start": return {"turn": {"id": "new-turn"}}
            self.fail(method)
        server.request.side_effect = request
        with mock.patch("agent.codex_server", return_value=server), mock.patch("agent.thread_params", return_value={}), \
             mock.patch("agent.threading.Thread"):
            task._recover_goal_server()
        params = server.request.call_args_list[-1].args[1]
        self.assertEqual(params["threadId"], "saved-thread")
        self.assertNotIn("original action", params["input"][0]["text"])
        self.assertTrue(task.running)

    def test_recovery_start_timeout_is_monitored_without_replay(self):
        task = agent.CodexTask("original action")
        task._started = task.on_thread = True
        task.began = agent.time.monotonic()
        task._thread, task._turn = "saved-thread", "old-turn"
        task.session = mock.Mock()
        task.session.thread_for.return_value = ("saved-thread", "")
        server = mock.Mock(alive=True)
        def request(method, params, timeout):
            if method == "thread/goal/get": return {"goal": {"status": "active"}}
            if method == "thread/read": return {"thread": {"status": {"type": "idle"}}}
            if method == "turn/start": raise agent.CodexError("response timed out")
            self.fail(method)
        server.request.side_effect = request
        with mock.patch("agent.codex_server", return_value=server), \
             mock.patch("agent.thread_params", return_value={}), \
             mock.patch("agent.threading.Thread") as thread:
            task._recover_goal_server()
        self.assertTrue(task.running)
        self.assertEqual([c.args[0] for c in server.request.call_args_list].count("turn/start"), 1)
        self.assertEqual(thread.call_args.kwargs["target"], task._await_goal_continuation)
        task.session.release.assert_not_called()

    def test_dead_server_during_goal_check_starts_only_one_recovery(self):
        task = agent.CodexTask("continue")
        task._started = task.on_thread = True
        task.began = agent.time.monotonic()
        task._thread, task._turn = "saved-thread", "old-turn"
        task._between_goal_turns = True
        task._server = mock.Mock(alive=False)
        task._server.request.side_effect = agent.CodexError("Codex stopped")
        task.session = mock.Mock()
        with mock.patch("agent.threading.Thread") as thread:
            task._await_goal_continuation("old-turn")
            task._on_message("exited", {"code": 1})
        self.assertTrue(task.running)
        task.session.release.assert_not_called()
        self.assertEqual(thread.call_count, 1)
        thread.return_value.start.assert_called_once()

    def test_server_recovery_never_wakes_a_paused_goal(self):
        task = agent.CodexTask("original action")
        task._started = task.on_thread = True
        task.began = agent.time.monotonic()
        task._thread, task._turn = "saved-thread", "old-turn"
        task.session = mock.Mock()
        task.session.thread_for.return_value = ("saved-thread", "")
        server = mock.Mock()
        server.request.return_value = {"goal": {"status": "paused"}}
        with mock.patch("agent.codex_server", return_value=server), mock.patch("agent.thread_params", return_value={}):
            task._recover_goal_server()
        self.assertFalse(task.running)
        self.assertEqual([c.args[0] for c in server.request.call_args_list], ["thread/goal/get"])

    def test_recovery_monitors_running_thread_without_start_notification(self):
        task = agent.CodexTask("original action")
        task._started = task.on_thread = True
        task.began = agent.time.monotonic()
        task._thread, task._turn = "saved-thread", "old-turn"
        task.session = mock.Mock()
        task.session.thread_for.return_value = ("saved-thread", "")
        server = mock.Mock(alive=True)
        def request(method, params, timeout):
            if method == "thread/goal/get": return {"goal": {"status": "active"}}
            if method == "thread/read": return {"thread": {"status": {"type": "active"}}}
            self.fail(method)
        server.request.side_effect = request
        with mock.patch("agent.codex_server", return_value=server), \
             mock.patch("agent.thread_params", return_value={}), \
             mock.patch("agent.threading.Thread") as thread:
            task._recover_goal_server()
        self.assertTrue(task.running)
        self.assertTrue(task._between_goal_turns)
        self.assertEqual(thread.call_args.kwargs["target"], task._await_goal_continuation)
        self.assertEqual(thread.call_args.kwargs["args"], ("__recovery_wait__",))
        task._on_message("turn/started", {"turn": {"id": "new-turn"}})
        self.assertEqual(task._turn, "new-turn")
        self.assertFalse(task._between_goal_turns)

    def test_recovery_wait_resumes_only_after_thread_becomes_idle(self):
        task = agent.CodexTask("original action")
        task._started = task.on_thread = True
        task._thread, task._turn = "saved-thread", "__recovery_wait__"
        task._between_goal_turns = True
        task.session = mock.Mock()
        task._server = mock.Mock(alive=True)
        statuses = iter(["active", "idle"])
        def request(method, params, timeout):
            if method == "thread/goal/get": return {"goal": {"status": "active"}}
            if method == "thread/read": return {"thread": {"status": {"type": next(statuses)}}}
            if method == "turn/start":
                task._between_goal_turns = False
                return {"turn": {"id": "new-turn"}}
            self.fail(method)
        task._server.request.side_effect = request
        task._done.wait = mock.Mock()
        with mock.patch("agent.time.monotonic", side_effect=[0, 31, 31, 92, 92]):
            task._await_goal_continuation("__recovery_wait__")
        starts = [c for c in task._server.request.call_args_list if c.args[0] == "turn/start"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].args[1]["threadId"], "saved-thread")
        self.assertNotIn("original action", starts[0].args[1]["input"][0]["text"])
        task.session.release.assert_not_called()


class ActAndLeftoverGoalTest(unittest.TestCase):
    def _ended_with(self, goal, before):
        task = agent.CodexTask("continue")
        task._started = True
        task.began = agent.time.monotonic()
        task._turn = "first"
        task._thread = "thread"
        task._between_goal_turns = True
        task._goal_before = before
        task._server = mock.Mock()
        task._server.request.return_value = {"goal": goal}
        task.session = mock.Mock()
        task._await_goal_continuation("first")
        self.assertFalse(task.running)
        return task

    def test_a_goal_left_blocked_by_an_earlier_task_does_not_fail_this_one(self):
        task = self._ended_with({"status": "blocked", "createdAt": 1, "updatedAt": 2}, (1, 2))
        self.assertNotIn("blocked", task._ended)
        task._server.request.assert_called_once()  # no "diagnose the blocker" turn

    def test_a_goal_this_task_blocked_still_fails_it(self):
        task = self._ended_with({"status": "blocked", "createdAt": 1, "updatedAt": 3}, (1, 2))
        self.assertIn("blocked", task._ended)

    def test_the_agent_always_acts_rather_than_explains(self):
        self.assertIn("whenever you could either act or explain, act", " ".join(agent.RULES.split()))
        self.assertNotIn("Explain without doing it", agent.RULES)
        self.assertIn("do it for them", agent.REQUEST)


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

    @mock.patch("resumable_thread.RUST_IDENTITY", Path("/nonexistent/agent-thread-identity"))
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

    @mock.patch("resumable_thread.RUST_STATE_LIBRARY", Path("/nonexistent/libagent-core.dylib"))
    @mock.patch("resumable_thread.RUST_IDENTITY", Path("/nonexistent/agent-thread-identity"))
    def test_failed_initial_state_write_never_contacts_server(self):
        server = Fake()
        with mock.patch("resumable_thread.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                ResumableThread(self.path).connect(server, {})
        self.assertEqual(server.calls, [])

    @mock.patch("resumable_thread.RUST_IDENTITY", Path("/nonexistent/agent-thread-identity"))
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

    def test_workspace_command_is_visible_without_exposing_arguments(self):
        events = []
        task = agent.CodexTask("test", on_event=lambda *e: events.append(e))
        task._on_message("item/started", {"item": {"type": "commandExecution", "command":
            "python scripts/workspace-tool.py call spaceo_open_url '{secret}'"}})
        task._on_message("item/completed", {"item": {"type": "commandExecution", "exitCode": 0}})
        self.assertIn(("action", "Virtual workspace: spaceo_open_url"), events)
        self.assertTrue(any(kind == "data" and "completed" in value for kind, value in events))
        self.assertNotIn("secret", str(events))

    def test_context_failure_warns_without_breaking_tools(self):
        events = []
        task = agent.CodexTask("test", on_event=lambda *e: events.append(e))
        task._stopped = True
        with mock.patch("agent.ContextLog.record", side_effect=OSError("disk full")):
            reply = task._call_tool({"tool": "click"})
        self.assertFalse(reply["success"])
        self.assertTrue(any("context could not be saved" in event[1] for event in events))

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
        voice.mac = mock.Mock()
        voice.voice = None
        voice.tasks = {}
        voice.doing = {}
        voice._heard_barrier = 0
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
if os.environ.get("FAKE_CODEX_GOAL"):
    agent.GOAL_WATCHDOG_IDLE_SECONDS = 0.05
    agent.GOAL_WATCHDOG_CHECK_SECONDS = 0.02
server = AppServer([sys.executable, str(Path(os.environ["TEST_ROOT"]) / "tests/fake_codex.py")])
servers = [server]
def server_factory():
    if not servers[-1].alive:
        servers.append(AppServer([sys.executable, str(Path(os.environ["TEST_ROOT"]) / "tests/fake_codex.py")]))
    return servers[-1]
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
with mock.patch("agent.codex_server", side_effect=server_factory), mock.patch("agent.device_tools", return_value={"mac": tool, "phone": tool}), mock.patch("agent.first_look", return_value=("data:image/png;base64,QUJD", "Synthetic windows: Notes")):
    task = agent.CodexTask(os.environ.get("TEST_PROMPT", "first request"), on_event=on_event).start()
    if not finished.wait(10):
        raise RuntimeError("task hung")
    if task._turn:
        task._turn_over.wait(3)
    print(json.dumps({"thread": task._thread, "final": task.final, "error": task._ended, "events": events}))
for server in servers:
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

    def test_watchdog_continues_the_same_thread_and_reuses_tools(self):
        result = self.worker(FAKE_CODEX_GOAL="1")
        turns = [e for e in self.entries() if "prompt" in e]
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["thread"], turns[1]["thread"])
        self.assertEqual(result["thread"], turns[0]["thread"])
        self.assertIn("Continue the active goal", turns[1]["prompt"])
        self.assertEqual(len([e for e in self.entries() if "tool_reply" in e]), 2)
        self.assertEqual(result["final"], "Synthetic success")

    def test_server_crash_reconnects_the_same_thread_without_replaying_request(self):
        result = self.worker(FAKE_CODEX_GOAL="1", FAKE_CODEX_CRASH_ONCE="1", TEST_PROMPT="do the original task")
        entries = self.entries()
        turns = [e for e in entries if "prompt" in e]
        self.assertGreaterEqual(len(turns), 2)
        self.assertEqual(len([e for e in entries if "started" in e]), 1)
        self.assertEqual([e["resumed"] for e in entries if "resumed" in e], [result["thread"]])
        self.assertTrue(all(e["thread"] == result["thread"] for e in turns))
        self.assertEqual(sum("do the original task" in e["prompt"] for e in turns), 1)
        self.assertEqual(result["final"], "Synthetic success")

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
        self.assertEqual(turns[1]["tools"], ["mac", "phone", "knowledge"])
        records = [json.loads(p.read_text()) for p in (self.directory / "context").glob("*.json")]
        requests = [r for r in records if r["kind"] == "turn/start input"]
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["payload"]["input"][1]["url"], "data:image/png;base64,QUJD")
        self.assertTrue(any(r["kind"] == "thread/resume output" for r in records))

    def test_workspace_mode_resumes_same_thread_without_physical_screenshot(self):
        first = self.worker(AGENT_SPACEO_COMMAND="/synthetic/spaceo")
        second = self.worker(AGENT_SPACEO_COMMAND="/synthetic/spaceo", TEST_PROMPT="workspace follow-up")
        self.assertEqual(first["thread"], second["thread"])
        self.assertEqual(second["final"], "Synthetic success")
        entries = self.entries()
        self.assertEqual(len([e for e in entries if "started" in e]), 1)
        self.assertEqual([e["resumed"] for e in entries if "resumed" in e], [first["thread"]])
        records = [json.loads(p.read_text()) for p in (self.directory / "context").glob("*.json")]
        requests = [r for r in records if r["kind"] == "turn/start input"]
        self.assertTrue(all(len(r["payload"]["input"]) == 1 for r in requests))

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
