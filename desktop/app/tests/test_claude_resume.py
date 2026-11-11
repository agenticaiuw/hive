"""Offline checks of Claude conversation identity across agent restarts."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
os.environ["AGENT_BACKEND"] = "codex"
import claude_agent
from resumable_thread import ResumeError


class ClaudeResumeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        environment = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.directory.name})
        environment.start()
        self.addCleanup(environment.stop)
        # No SDK process or user account is contacted in these tests.
        runner = mock.patch.object(claude_agent, "run", side_effect=lambda coroutine: coroutine.close())
        runner.start()
        self.addCleanup(runner.stop)

    def test_saved_identity_is_reloaded_and_not_replaced(self):
        identity = "46e1152f-78ce-4d35-9a58-41c322fd8db1"
        first = claude_agent.Conn(persistent=True)
        first.remember_session(identity)
        resumed = claude_agent.Conn(persistent=True)
        self.assertEqual(resumed.session_id, identity)
        self.assertEqual(resumed.options().resume, identity)
        with self.assertRaises(ResumeError):
            resumed.remember_session("6fe43f03-0b88-43c0-8d17-f452fc2d8ea1")
        self.assertEqual((Path(self.directory.name) / "claude-session-id").read_text().strip(), identity)

    def test_invalid_saved_identity_fails_closed(self):
        (Path(self.directory.name) / "claude-session-id").write_text("invalid")
        with self.assertRaises(ResumeError):
            claude_agent.Conn(persistent=True)

    def test_secondary_session_does_not_replace_primary(self):
        secondary = claude_agent.Conn()
        secondary.remember_session("46e1152f-78ce-4d35-9a58-41c322fd8db1")
        self.assertFalse((Path(self.directory.name) / "claude-session-id").exists())

    def test_workspace_backend_is_configured_without_physical_display_fallback(self):
        with mock.patch.dict(os.environ, {"AGENT_SPACEO_COMMAND": "/tmp/spaceo"}):
            options = claude_agent.Conn(persistent=True).options()
        self.assertIn("spaceo", options.mcp_servers)
        self.assertEqual(options.mcp_servers["spaceo"]["args"][-1], "/tmp/spaceo")
        self.assertIn("mcp__spaceo__*", options.allowed_tools)
        self.assertIn("Do not silently fall back", options.system_prompt)


if __name__ == "__main__":
    unittest.main()
