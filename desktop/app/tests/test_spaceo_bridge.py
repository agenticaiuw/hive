import sys
import json
import os
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock
import socket

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from spaceo_mcp_bridge import Bridge, WorkspaceRequests, capability_report, EnvironmentObservations, passwords_target
import workspace_fence


class WorkspaceRequestsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.bridge = Mock()
        self.bridge.observations = EnvironmentObservations()
        self.bridge.call.return_value = {"content": [{"type": "text", "text": "ready"}]}
        self.bridge.request.return_value = {"tools": [{"name": "spaceo_session_list"}, {"name": "spaceo_session_destroy"}]}
        self.server = WorkspaceRequests(Path(self.folder.name) / "control", self.bridge)
        self.server.start()

    def tearDown(self):
        self.server.close()
        self.folder.cleanup()

    def test_retry_only_explicit_pre_dispatch_transient_health_receipt(self):
        refused = {"isError": True, "content": [{"text":
            "[display_creation_failed] could not create the agent display: "
            "pre_dispatch_transient_host_health: host health refused: memory_pressure; inspect"}]}
        success = {"content": [{"text": "done"}]}
        self.bridge.call.side_effect = [refused, success]
        with unittest.mock.patch("spaceo_mcp_bridge.time.sleep"):
            self.assertEqual(self.server.call_with_transient_health_retry("spaceo_click", {}), success)
        self.assertEqual(self.bridge.call.call_count, 2)

    def test_no_retry_for_ambiguous_or_post_dispatch_failure(self):
        for text in ("[display_creation_failed] host health refused: memory_pressure; inspect",
                     "[display_creation_failed] could not create the agent display: host health refused: swap_activity; inspect",
                     "[other] pre_dispatch_transient_host_health: host health refused: memory_pressure; inspect"):
            self.bridge.call.reset_mock()
            self.bridge.call.side_effect = None
            failure = {"isError": True, "content": [{"text": text}]}
            self.bridge.call.return_value = failure
            self.assertEqual(self.server.call_with_transient_health_retry("spaceo_click", {}), failure)
            self.assertEqual(self.bridge.call.call_count, 1)

    def test_transient_health_retry_is_bounded(self):
        failure = {"isError": True, "content": [{"text":
            "[display_creation_failed] could not create the agent display: "
            "pre_dispatch_transient_host_health: host health refused: swap_activity; inspect"}]}
        self.bridge.call.return_value = failure
        with unittest.mock.patch("spaceo_mcp_bridge.time.monotonic", side_effect=[0, 31]):
            self.assertEqual(self.server.call_with_transient_health_retry("spaceo_click", {}), failure)
        self.assertEqual(self.bridge.call.call_count, 1)

    def send(self, value):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3)
            client.connect(str(self.server.path))
            client.sendall((json.dumps(value) + "\n").encode())
            data = b""
            while b"\n" not in data:
                data += client.recv(65536)
            return json.loads(data)

    def test_list_only_exposes_workspace_tools(self):
        result = self.send({"method": "list"})
        self.assertEqual([x["name"] for x in result["result"]["tools"]],
                         ["spaceo_session_list", "workspace_authenticate_passwords"])

    def test_calls_use_existing_workspace(self):
        result = self.send({"name": "spaceo_open_app", "arguments": {"app": "Calculator"}})
        self.assertTrue(result["ok"])
        self.bridge.call.assert_called_once_with("spaceo_open_app", {"app": "Calculator", "session": "personal-agent-workspace"})

    def test_reversible_workspace_access_does_not_require_proven_isolation(self):
        result = self.send({"name": "spaceo_open_app", "arguments": {
            "app": "Safari", "strict": True, "require_isolation": ["key_input_route"]}})
        self.assertTrue(result["ok"])
        self.bridge.call.assert_called_once_with("spaceo_open_app", {
            "app": "Safari", "session": "personal-agent-workspace"})

    def test_chrome_launch_is_still_disabled(self):
        with unittest.mock.patch("spaceo_mcp_bridge.prefer_safari", return_value=True):
            result = self.send({"name": "spaceo_open_app", "arguments": {"app": "Google Chrome"}})
        self.assertFalse(result["ok"])
        self.bridge.call.assert_not_called()

    def test_browser_default_is_not_hardcoded_to_safari(self):
        with unittest.mock.patch("spaceo_mcp_bridge.prefer_safari", return_value=False):
            result = self.send({"name": "spaceo_open_app", "arguments": {"app": "Google Chrome"}})
        self.assertTrue(result["ok"])

    def test_refuses_foreign_session_and_destructive_tools(self):
        self.assertFalse(self.send({"name": "spaceo_read_screen", "arguments": {"session": "other"}})["ok"])
        self.assertFalse(self.send({"name": "spaceo_session_destroy", "arguments": {}})["ok"])
        self.bridge.call.assert_not_called()

    def test_workspace_auth_uses_verified_target_without_secret_arguments(self):
        self.bridge.proc.args = ["/agent/spaceo"]
        with unittest.mock.patch("spaceo_mcp_bridge.passwords_target", return_value=(123, 456)), \
             unittest.mock.patch("credentials.native", return_value="Authentication submitted") as native:
            result = self.send({"name": "workspace_authenticate_passwords", "arguments": {}})
        self.assertTrue(result["ok"])
        native.assert_called_once_with("fill-workspace-passwords", "123", "456")
        self.assertNotIn("credential-value", str(result))

    def test_passwords_target_requires_one_owned_unpaused_window(self):
        session = {"id": "personal-agent-workspace", "runtimeAttached": True, "inputPaused": False,
                   "apps": [{"bundleID": "com.apple.Passwords", "pid": 123}],
                   "windows": [{"pid": 123, "windowID": 456, "onStage": True}]}
        run = Mock(stdout=json.dumps({"ok": True, "sessions": [session]}))
        with unittest.mock.patch("spaceo_mcp_bridge.subprocess.run", return_value=run):
            self.assertEqual(passwords_target("/agent/spaceo"), (123, 456))
            session["inputPaused"] = True
            run.stdout = json.dumps({"ok": True, "sessions": [session]})
            with self.assertRaisesRegex(ValueError, "paused"):
                passwords_target("/agent/spaceo")

    def test_activity_reports_tool_and_loaded_text_without_input_arguments(self):
        events = []
        self.server.on_activity = lambda *event: events.append(event)
        self.bridge.call.return_value = {"content": [{"type": "text", "text": "Page content"}]}
        self.send({"name": "spaceo_read_text", "arguments": {"secret": "do-not-display"}})
        self.assertEqual(events, [("action", "Virtual workspace: spaceo_read_text"),
                                  ("data", "spaceo_read_text: Page content")])
        self.assertNotIn("do-not-display", str(events))


class CapabilityReportingTest(unittest.TestCase):
    def test_injected_verification_activity_preserves_coverage(self):
        report = capability_report({"content": [{"text": "isolation: partial\n- key_input_route: unknown [unknown]\n- menu_bar_owner: passed [observed]\n- window_server_front_process: passed [inferred]"}]})
        self.assertIn("private profile, not the user's signed-in session", report)
        self.assertIn("key_input_route=unknown/unknown", report)
        self.assertIn("window_server_front_process=passed/inferred", report)
        self.assertIn("text_input_route=unreported", report)
        self.assertIn("partial", report)
        self.assertNotIn("isolation: intact", report)

    def test_adoption_and_placement_are_rejected_before_bridge_call(self):
        # Exercise the actual workspace command gate without a socket or live session.
        for name in ("spaceo_adopt", "spaceo_place", "spaceo_session_adopt", "spaceo_window_place"):
            bridge = Mock()
            server = WorkspaceRequests(Path('/tmp/unused'), bridge)
            connection = unittest.mock.MagicMock()
            connection.__enter__.return_value = connection
            connection.__exit__.return_value = False
            connection.recv.return_value = (json.dumps({"name": name, "arguments": {"pid": 123, "window": 456}}) + "\n").encode()
            server._handle(connection)
            response = json.loads(connection.sendall.call_args.args[0])
            self.assertFalse(response["ok"], name)
            bridge.call.assert_not_called()

    def test_unavailable_audit_never_claims_proof(self):
        self.assertIn("unverified", capability_report({"isError": True, "content": [{"text": "isolation: intact"}]}))
        self.assertIn("unverified", capability_report())


class EnvironmentReportTest(unittest.TestCase):
    def test_bounded_redacted_and_labelled_observations(self):
        obs = EnvironmentObservations()
        initial = obs.report()
        self.assertEqual(initial["workspace"]["user_holds_control"].split(";")[0], "unknown")
        self.assertIn("unknown", initial["isolation"]["last_audit"])
        obs.display_seen("42")
        obs.record("spaceo_verify_isolation", {"content": [{"text": "isolation: partial\n- key_input_route: unknown [unknown]\nSECRET_DO_NOT_RETAIN"}]})
        for _ in range(8):
            obs.record("spaceo_type", {"isError": True, "content": [{"text": "SECRET_DO_NOT_RETAIN"}]})
        report = obs.report()
        self.assertEqual(report["workspace"]["observed_display_at_last_bootstrap"], "42")
        self.assertIn("key_input_route=unknown/unknown", report["isolation"]["last_audit"])
        self.assertEqual(len(report["recent_failures"]), 5)
        self.assertNotIn("SECRET_DO_NOT_RETAIN", json.dumps(report))
        obs.record("spaceo_verify_isolation", {"isError": True})
        self.assertIn("unknown", obs.report()["isolation"]["last_audit"])

    def test_session_refresh_bounded_pause_and_staleness(self):
        from unittest.mock import patch
        header = "[yours] session 'personal-agent-workspace' on whole display 6, 1920x1080\n"
        def result(text):
            return {"content": [{"type": "text", "text": text}]}
        obs = EnvironmentObservations()
        with patch("spaceo_mcp_bridge.time.monotonic", return_value=100):
            obs.refresh_session(lambda *_: result(header + "  input: PAUSED (agent: SECRET)\n  window SECRET\n"))
            now = obs.report()["workspace"]["current_session_and_display"]
            self.assertEqual((now["status"], now["display"], now["input_state"]), ("observed", "6", "paused"))
            self.assertNotIn("SECRET", json.dumps(now))
            obs.refresh_session(lambda *_: result(header + "  input: PAUSED (operator has Control)\n"))
            self.assertIn("operator control reported", obs.report()["workspace"]["current_session_and_display"]["reason"])
            obs.refresh_session(lambda *_: result(header + "  input: UNPAUSED\n"))
            self.assertEqual(obs.report()["workspace"]["current_session_and_display"]["input_state"], "unpaused")
            obs.refresh_session(lambda *_: result(header + "  title: SECRET\n"))
            self.assertEqual(obs.report()["workspace"]["current_session_and_display"]["input_state"], "unknown")
        with patch("spaceo_mcp_bridge.time.monotonic", return_value=131):
            self.assertEqual(obs.report()["workspace"]["current_session_and_display"]["status"], "stale")
        obs.refresh_session(lambda *_: {"isError": True, "content": [{"text": "SECRET"}]})
        self.assertEqual(obs.report()["workspace"]["current_session_and_display"]["status"], "stale")
        self.assertNotIn("SECRET", json.dumps(obs.report()))
        for text in ("bad", header + "  input: PAUSED\n  input: UNPAUSED\n", header + header):
            empty = EnvironmentObservations()
            empty.refresh_session(lambda *_: result(text))
            self.assertEqual(empty.report()["workspace"]["current_session_and_display"]["status"], "unavailable")
        empty = EnvironmentObservations()
        empty.refresh_session(lambda *_: (_ for _ in ()).throw(OSError("SECRET")))
        self.assertNotIn("SECRET", json.dumps(empty.report()))
        self.assertEqual(empty.report()["workspace"]["current_session_and_display"]["status"], "unavailable")

    def test_status_refreshes_owned_session_read_only(self):
        bridge = Mock()
        bridge.observations = EnvironmentObservations()
        events = []
        server = WorkspaceRequests(Path('/tmp/unused'), bridge, lambda *e: events.append(e))
        connection = unittest.mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.__exit__.return_value = False
        connection.recv.return_value = b'{"method":"status"}\n'
        server._handle(connection)
        response = json.loads(connection.sendall.call_args.args[0])
        self.assertTrue(response["ok"])
        self.assertIn("input unknown", events[0][1])
        bridge.call.assert_called_once_with("spaceo_session_list", {})
        bridge.request.assert_not_called()


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = unittest.mock.patch('spaceo_mcp_bridge.state_dir', return_value=Path(self.state.name))
        patcher.start(); self.addCleanup(patcher.stop)

    def allow_once(self):
        workspace_fence.set_policy(Path(self.state.name), 'allow-once')

    def bridge(self, responses):
        bridge = Bridge.__new__(Bridge)
        bridge.call = Mock(side_effect=responses)
        bridge.publish_display = Mock()
        return bridge

    def test_claim_existing_workspace(self):
        bridge = self.bridge([{"content": [{"text": "claimed"}]}])
        bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list], ["spaceo_session_claim"])
        bridge.publish_display.assert_called_once()

    def test_create_only_when_explicitly_unknown(self):
        self.allow_once()
        bridge = self.bridge([{"isError": True, "content": [{"text": "[unknown_session] no session"}]},
                              {"content": [{"text": "created"}]}])
        bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list],
                         ["spaceo_session_claim", "spaceo_session_create"])
        self.assertEqual(bridge.call.call_args.args[1]["preset"], "exclusive")

    def test_explicit_closed_fence_blocks_claim_and_creation(self):
        workspace_fence.set_policy(Path(self.state.name), 'closed')
        bridge = self.bridge([])
        with self.assertRaisesRegex(RuntimeError, 'explicitly closed'):
            bridge.bootstrap()
        bridge.call.assert_not_called()

    def test_missing_session_alone_never_authorizes_creation(self):
        bridge = self.bridge([{'isError': True, 'content': [{'text': '[unknown_session] missing'}]}])
        with self.assertRaisesRegex(RuntimeError, 'explicit user request'):
            bridge.bootstrap()
        self.assertEqual([c.args[0] for c in bridge.call.call_args_list], ['spaceo_session_claim'])

    def test_claiming_existing_session_consumes_pending_creation_permit(self):
        self.allow_once()
        bridge = self.bridge([{'content': [{'text': 'claimed'}]}])
        bridge.bootstrap()
        self.assertEqual(workspace_fence.policy(Path(self.state.name)), 'existing-only')
        next_bridge = self.bridge([{'isError': True, 'content': [{'text': '[unknown_session] missing'}]}])
        with self.assertRaisesRegex(RuntimeError, 'explicit user request'): next_bridge.bootstrap()
        self.assertEqual(next_bridge.call.call_count, 1)

    def test_uncertain_creation_consumes_permit_without_retry(self):
        self.allow_once()
        bridge = self.bridge([{'isError': True, 'content': [{'text': '[unknown_session] missing'}]}, TimeoutError('ambiguous')])
        with self.assertRaises(TimeoutError): bridge.bootstrap()
        self.assertEqual(workspace_fence.policy(Path(self.state.name)), 'existing-only')
        next_bridge = self.bridge([{'isError': True, 'content': [{'text': '[unknown_session] missing'}]}])
        with self.assertRaisesRegex(RuntimeError, 'explicit user request'): next_bridge.bootstrap()
        self.assertEqual(next_bridge.call.call_count, 1)

    def test_close_during_claim_prevents_publish(self):
        bridge = self.bridge([])
        def claim(*_args):
            workspace_fence.set_policy(Path(self.state.name), 'closed')
            return {'content': [{'text': 'claimed'}]}
        bridge.call.side_effect = claim
        with self.assertRaisesRegex(RuntimeError, 'explicitly closed'): bridge.bootstrap()
        bridge.publish_display.assert_not_called()

    def test_live_owner_or_failure_never_creates_another_session(self):
        for reason in ("[session_busy] owner is alive", "[unknown_error] daemon failed"):
            bridge = self.bridge([{"isError": True, "content": [{"text": reason}]}])
            with self.assertRaises(RuntimeError):
                bridge.bootstrap()
            self.assertEqual(bridge.call.call_count, 1)

    def test_detached_record_is_replaced_only_after_daemon_reports_cleanup(self):
        self.allow_once()
        detached = {"isError": True, "content": [{"text": "[session_detached] cleanup pending"}]}
        unknown = {"isError": True, "content": [{"text": "[unknown_session] no session"}]}
        bridge = self.bridge([detached, detached, unknown, {"content": [{"text": "created"}]}])
        with unittest.mock.patch("spaceo_mcp_bridge.time.sleep"):
            bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list],
                         ["spaceo_session_claim"] * 3 + ["spaceo_session_create"])
        bridge.publish_display.assert_called_once()

    def test_live_legacy_detached_claim_waits_for_explicit_cleanup(self):
        self.allow_once()
        detached = {"isError": True, "content": [{"text":
            "[bad_request] session 'personal-agent-workspace' belongs to a previous daemon and is detached: "
            "no display or window handle survived the restart, so it cannot be claimed. Let recovery clean it up"}]}
        unknown = {"isError": True, "content": [{"text": "[unknown_session] no session"}]}
        bridge = self.bridge([detached, unknown, {"content": [{"text": "created"}]}])
        with unittest.mock.patch("spaceo_mcp_bridge.time.sleep"):
            bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list],
                         ["spaceo_session_claim", "spaceo_session_claim", "spaceo_session_create"])

    def test_other_bad_request_is_not_treated_as_detached(self):
        response = {"isError": True, "content": [{"text":
            "[bad_request] session 'someone-else' belongs to a previous daemon and is detached: no display"}]}
        bridge = self.bridge([response])
        with self.assertRaises(RuntimeError):
            bridge.bootstrap()
        self.assertEqual(bridge.call.call_count, 1)

    def test_detached_cleanup_timeout_does_not_create_or_remove_session(self):
        detached = {"isError": True, "content": [{"text": "[session_detached] cleanup blocked"}]}
        bridge = self.bridge([detached])
        with unittest.mock.patch("spaceo_mcp_bridge.time.monotonic", side_effect=[0, 0, 46]):
            with self.assertRaisesRegex(RuntimeError, "cleanup did not finish"):
                bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list], ["spaceo_session_claim"])

    def test_detached_followed_by_other_failure_does_not_create(self):
        detached = {"isError": True, "content": [{"text": "[session_detached] cleanup pending"}]}
        failure = {"isError": True, "content": [{"text": "[session_busy] owned"}]}
        bridge = self.bridge([detached, failure])
        with unittest.mock.patch("spaceo_mcp_bridge.time.sleep"):
            with self.assertRaises(RuntimeError):
                bridge.bootstrap()
        self.assertEqual(bridge.call.call_count, 2)

    def test_disappearing_existing_workspace_is_not_replaced(self):
        bridge = self.bridge([{"isError": True, "content": [{"text": "only an abandoned session may be claimed"}]},
                              {"isError": True, "content": [{"text": "[unknown_session] no session"}]}])
        with unittest.mock.patch("spaceo_mcp_bridge.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "Existing workspace"):
                bridge.bootstrap()
        self.assertEqual([call.args[0] for call in bridge.call.call_args_list],
                         ["spaceo_session_claim", "spaceo_session_claim"])

    def test_display_selection_rejects_other_sessions_and_nonexclusive_tiles(self):
        for text in ("[yours] session 'someone-else' on whole display 15, 1920x1080",
                     "[yours] session 'personal-agent-workspace' on tile 1 display 15"):
            bridge = Bridge.__new__(Bridge)
            bridge.call = Mock(return_value={"content": [{"text": text}]})
            with self.assertRaisesRegex(RuntimeError, "could not be identified"):
                bridge.publish_display()

    def test_mcp_handshake_bootstraps_without_leaking_internal_responses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace_fence.set_policy(root, 'allow-once')
            events = root / "events"
            fake = root / "spaceo"
            fake.write_text('''#!/usr/bin/env python3
import json,sys,os
for line in sys.stdin:
    msg=json.loads(line)
    with open(os.environ["FAKE_EVENTS"],"a") as out: out.write(json.dumps(msg)+"\\n")
    if "id" not in msg: continue
    name=msg.get("params",{}).get("name")
    if name == "spaceo_session_claim": result={"isError":True,"content":[{"text":"[unknown_session] no session"}]}
    elif name == "spaceo_session_create": result={"content":[{"text":"created"}]}
    elif name == "spaceo_session_list": result={"content":[{"text":"[yours] session 'personal-agent-workspace' on whole display 15, 1920x1080"}]}
    else: result={"ok":True}
    print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":result}),flush=True)
''')
            fake.chmod(0o755)
            script = Path(__file__).resolve().parents[1] / "python/spaceo_mcp_bridge.py"
            process = subprocess.Popen([sys.executable, str(script), str(fake)], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       env={**os.environ, "FAKE_EVENTS": str(events), "AGENT_STATE_DIR": str(root)})
            try:
                def send(msg):
                    process.stdin.write(json.dumps(msg) + "\n")
                    process.stdin.flush()
                send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
                self.assertEqual(json.loads(process.stdout.readline())["id"], 1)
                send({"jsonrpc": "2.0", "method": "notifications/initialized"})
                send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
                self.assertEqual(json.loads(process.stdout.readline())["id"], 2)
                messages = [json.loads(line) for line in events.read_text().splitlines()]
                names = [message.get("params", {}).get("name") for message in messages]
                self.assertIn("spaceo_session_claim", names)
                self.assertIn("spaceo_session_create", names)
                self.assertEqual((root / "workspace-display-id").read_text().strip(), "15")
            finally:
                process.stdin.close()
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
