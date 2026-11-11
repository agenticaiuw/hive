import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import agent
import agent_workspace_tools


class MemoryTests(unittest.TestCase):
    def test_memory_records_are_private_sourced_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            value = {"op": "add", "statement": "A task was listed", "source": "photo-1.jpg", "kind": "fact"}
            agent_workspace_tools.memory(value, state)
            agent_workspace_tools.memory(value, state)
            result = agent_workspace_tools.memory({"op": "list"}, state)
            rows = json.loads(result["content"][0]["text"])
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0][1:4], ["A task was listed", "photo-1.jpg", "fact"])
            self.assertEqual(stat.S_IMODE((state / "memory/personal-memory.sqlite3").stat().st_mode), 0o600)

    def test_unsourced_memory_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                agent_workspace_tools.memory({"op": "add", "statement": "x", "kind": "fact"}, Path(folder))
            self.assertFalse((Path(folder) / "memory").exists())


class WorkspaceDispatchTests(unittest.TestCase):
    def make_task(self):
        task = agent.CodexTask("test", device="mac")
        task.tools = {"mac": mock.Mock()}
        task._record_context = mock.Mock()
        task._event = mock.Mock()
        return task

    def test_physical_mouse_cannot_be_used_in_workspace_mode(self):
        task = self.make_task()
        with mock.patch.dict(os.environ, {"AGENT_SPACEO_COMMAND": "/engine"}):
            result = task._call_tool({"namespace": "mac", "tool": "click", "arguments": {"x": 1, "y": 1}})
        self.assertFalse(result["success"])
        task.tools["mac"].call.assert_not_called()

    def test_workspace_request_is_dispatched_in_host_process(self):
        task = self.make_task()
        reply = {"content": [{"type": "text", "text": "workspace ready"}]}
        with mock.patch.dict(os.environ, {"AGENT_SPACEO_COMMAND": "/engine"}), \
             mock.patch.object(agent_workspace_tools, "workspace", return_value=reply) as workspace:
            result = task._call_tool({"namespace": "mac", "tool": "read_ingested", "arguments": {"id": 'workspace:{"name":"spaceo_session_list"}'}})
        self.assertTrue(result["success"])
        workspace.assert_called_once_with({"name": "spaceo_session_list"})

    def test_legacy_typed_tool_routes_to_workspace_without_physical_input(self):
        task = self.make_task()
        reply = {"content": [{"type": "text", "text": "workspace ready"}]}
        with mock.patch.dict(os.environ, {"AGENT_SPACEO_COMMAND": "/engine"}), \
             mock.patch.object(agent_workspace_tools, "workspace", return_value=reply) as workspace:
            result = task._call_tool({"namespace": "mac", "tool": "type_text", "arguments": {"text": 'workspace:{"method":"list"}'}})
        self.assertTrue(result["success"])
        workspace.assert_called_once_with({"method": "list"})
        task.tools["mac"].call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
