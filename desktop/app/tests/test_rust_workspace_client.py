"""Exercise both transports against the same disposable workspace server."""
import json
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import agent_workspace_tools as tools


class WorkspaceClientParity(unittest.TestCase):
    def run_client(self, rust, response):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            (state / "control").mkdir()
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(state / "control/workspace.sock"))
            server.listen(1)
            seen = []
            def serve():
                with server, server.accept()[0] as peer:
                    with peer.makefile("rb") as incoming:
                        seen.append(json.loads(incoming.readline()))
                    peer.sendall(json.dumps(response, ensure_ascii=False).encode() + b"\n")
            worker = threading.Thread(target=serve)
            worker.start()
            binary = ROOT / "build/agent-workspace-client" if rust else state / "missing"
            try:
                with mock.patch.object(tools, "STATE", state), mock.patch.object(tools, "WORKSPACE_CLIENT", binary):
                    result = tools.workspace({"name": "click", "arguments": {"x": 42, "text": "你好"}})
            finally:
                worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(seen, [{"name": "click", "arguments": {"x": 42, "text": "你好"}}])
            return result

    def test_results_and_errors_match_python_transport(self):
        self.assertTrue((ROOT / "build/agent-workspace-client").is_file(), "build the Rust helper first")
        for response in [
            {"ok": True, "result": {"content": [{"type": "text", "text": "你好"}]}},
            {"ok": True, "result": {"tools": [{"name": "type", "description": "你好"}]}},
            {"ok": False, "error": "unavailable"},
        ]:
            with self.subTest(response=response):
                self.assertEqual(self.run_client(True, response), self.run_client(False, response))

    def test_failed_rust_client_never_retries_a_possible_side_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / "client"
            binary.write_text("#!/bin/sh\nexit 1\n")
            binary.chmod(0o700)
            with mock.patch.object(tools, "WORKSPACE_CLIENT", binary), \
                    mock.patch.object(tools.socket, "socket") as fallback:
                with self.assertRaises(RuntimeError):
                    tools.workspace({"name": "click"})
                fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
