import json
import os
import queue
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from local_request import LocalRequests
from voice_agent import VoiceAgent


class LocalRequestTests(unittest.TestCase):
    def test_private_socket_delivers_and_removes_only_its_own_path(self):
        with tempfile.TemporaryDirectory() as parent:
            events = queue.Queue()
            server = LocalRequests(Path(parent) / "control", events)
            server.start()
            self.addCleanup(server.close)
            self.assertEqual(stat.S_IMODE(server.path.stat().st_mode), 0o600)
            def accept():
                kind, payload = events.get(timeout=3)
                text, reply, deadline = payload[:3]
                self.assertEqual((kind, text), ("local_request", "plan"))
                self.assertGreater(deadline, time.monotonic())
                reply.put({"ok": True})
            t = threading.Thread(target=accept)
            t.start()
            with socket.socket(socket.AF_UNIX) as client:
                client.connect(str(server.path))
                client.sendall(b'{"text":"plan"}\n')
                self.assertTrue(json.loads(client.recv(1024))["ok"])
            t.join(timeout=3)
            server.close()
            self.assertFalse(server.path.exists())

    def test_existing_non_socket_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as parent:
            folder = Path(parent) / "control"
            folder.mkdir()
            (folder / "request.sock").write_text("keep")
            with self.assertRaises(RuntimeError):
                LocalRequests(folder, queue.Queue()).start()
            self.assertEqual((folder / "request.sock").read_text(), "keep")

    def test_active_task_is_not_interrupted(self):
        agent = VoiceAgent.__new__(VoiceAgent)
        agent.tasks = {"mac": mock.Mock(running=True)}
        agent.captions = mock.Mock()
        agent.on_transcript = mock.Mock()
        reply = queue.Queue()
        agent.on_local_request("plan", reply, time.monotonic() + 2)
        self.assertFalse(reply.get()["ok"])
        agent.on_transcript.assert_not_called()

    def test_expired_request_does_not_start(self):
        agent = VoiceAgent.__new__(VoiceAgent)
        agent.on_transcript = mock.Mock()
        reply = queue.Queue()
        agent.on_local_request("plan", reply, time.monotonic() - 1)
        self.assertFalse(reply.get()["ok"])
        agent.on_transcript.assert_not_called()

    def test_explicit_resume_uses_the_existing_thread(self):
        agent = VoiceAgent.__new__(VoiceAgent)
        agent.tasks = {}
        agent.captions = mock.Mock()
        agent.on_transcript = mock.Mock()
        reply = queue.Queue()
        server = mock.Mock()
        server.request.return_value = {"goal": {"status": "active"}}
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch("voice_agent.state_dir", return_value=Path(directory)), \
             mock.patch("agent.running_server", return_value=server):
            (Path(directory) / "codex-thread-id").write_text("existing-thread")
            agent.on_local_request("continue", reply, time.monotonic() + 2, True)
        self.assertTrue(reply.get()["ok"])
        server.request.assert_called_once_with("thread/goal/set", {
            "threadId": "existing-thread", "status": "active", "origin": "user"}, timeout=3)
        agent.on_transcript.assert_called_once_with("continue", typed=True, captured=True, ingress_receipt=None)

    def test_explicit_goal_rewrite_updates_existing_thread(self):
        agent = VoiceAgent.__new__(VoiceAgent)
        agent.tasks = {}
        agent.captions = mock.Mock()
        agent.on_transcript = mock.Mock()
        reply = queue.Queue()
        server = mock.Mock()
        server.request.return_value = {"goal": {"status": "active"}}
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch("voice_agent.state_dir", return_value=Path(directory)), \
             mock.patch("agent.running_server", return_value=server):
            (Path(directory) / "codex-thread-id").write_text("existing-thread")
            agent.on_local_request("continue", reply, time.monotonic() + 2, True, "New objective")
        self.assertTrue(reply.get()["ok"])
        server.request.assert_called_once_with("thread/goal/set", {
            "threadId": "existing-thread", "status": "active", "origin": "user",
            "objective": "New objective"}, timeout=3)


if __name__ == "__main__":
    unittest.main()
