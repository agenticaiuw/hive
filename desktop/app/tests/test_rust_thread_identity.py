"""Integration tests for the production Python-to-Rust identity bridge."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import resumable_thread as identity


@unittest.skipUnless(os.access(identity.RUST_IDENTITY, os.X_OK), "build Rust identity helper first")
class RustIdentityBridgeTest(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "thread"
        self.server = mock.Mock()
        self.server.request.side_effect = lambda method, params: {
            "thread": {"id": params.get("threadId", "thread-123")}}

    def test_start_resume_and_in_process_missing_identity(self):
        thread = identity.ResumableThread(self.path)
        self.assertEqual(thread.connect(self.server, {"model": "example"}), "thread-123")
        self.assertEqual(thread.connect(self.server, {"model": "ignored"}), "thread-123")
        self.assertEqual(self.server.request.call_args_list[1].args, ("thread/resume", {"threadId": "thread-123"}))
        self.path.unlink()
        with self.assertRaisesRegex(identity.ResumeError, "changed or disappeared"):
            thread.connect(self.server, {})
        self.assertEqual(self.server.request.call_count, 2)

    def test_failed_start_is_never_retried(self):
        self.server.request.side_effect = TimeoutError("timeout")
        for _ in range(2):
            with self.assertRaises(identity.ResumeError):
                identity.ResumableThread(self.path).connect(self.server, {})
        self.assertEqual(self.server.request.call_count, 1)
        self.assertEqual(self.path.read_text(), "!thread-start-pending\n")

    def test_helper_failure_never_falls_back(self):
        with mock.patch.object(identity, "RUST_IDENTITY", Path("/usr/bin/false")):
            with self.assertRaises(identity.ResumeError):
                identity.ResumableThread(self.path).connect(self.server, {})
        self.server.request.assert_not_called()
        self.assertFalse(self.path.exists())
