"""Exercise the Rust workspace socket with a fake workspace owner only."""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from local_request import RUST_LOCAL_REQUESTS
from spaceo_mcp_bridge import WorkspaceRequests, EnvironmentObservations

@unittest.skipUnless(os.access(RUST_LOCAL_REQUESTS, os.X_OK), 'build Rust socket helper first')
class RustWorkspaceServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.bridge = Mock(); self.bridge.observations = EnvironmentObservations()
        self.bridge.call.side_effect = lambda name, args: {'content':[{'type':'text','text': args.get('app','')}]}
        self.server = WorkspaceRequests(Path(self.temp.name) / 'control', self.bridge)
        self.server.start(); self.addCleanup(self.server.close)

    def request(self, value):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(10); client.connect(str(self.server.path))
            client.sendall(json.dumps(value).encode() + b'\n')
            chunks = bytearray()
            while b'\n' not in chunks:
                part = client.recv(65536)
                if not part: raise RuntimeError('closed')
                chunks.extend(part)
            return json.loads(chunks)

    def test_large_request_and_response(self):
        app = 'a' * 14000
        self.bridge.call.return_value = {'content':[{'type':'text','text':'x' * 1000000}]}
        self.bridge.call.side_effect = None
        result = self.request({'name':'spaceo_open_app','arguments':{'app':app}})
        self.assertEqual(len(result['result']['content'][0]['text']), 1000000)
        self.bridge.call.assert_called_once_with('spaceo_open_app', {'app':app, 'session':'personal-agent-workspace'})

    def test_utf8_request_near_limit_is_not_expanded(self):
        value = {'name':'spaceo_open_app','arguments':{'app':'界' * 4000}}
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        self.assertLess(len(raw), 16384)
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3); client.connect(str(self.server.path)); client.sendall(raw)
            data = bytearray()
            while b'\n' not in data: data.extend(client.recv(65536))
        self.assertTrue(json.loads(data)['ok'])
        self.bridge.call.assert_called_once()

    def test_concurrent_responses_are_not_crossed(self):
        results = {}
        def call(name): results[name] = self.request({'name':'spaceo_open_app','arguments':{'app':name}})
        threads = [threading.Thread(target=call,args=(str(i),)) for i in range(4)]
        for t in threads: t.start()
        for t in threads: t.join(5)
        self.assertEqual({k:v['result']['content'][0]['text'] for k,v in results.items()}, {str(i):str(i) for i in range(4)})

    def test_non_object_and_forbidden_tools_never_dispatch(self):
        self.assertFalse(self.request([])['ok'])
        self.assertFalse(self.request({'name':'spaceo_session_destroy'})['ok'])
        self.bridge.call.assert_not_called()

    def test_second_workspace_server_cannot_replace_live_socket(self):
        second = WorkspaceRequests(self.server.directory, self.bridge)
        with self.assertRaises(RuntimeError): second.start()
        self.assertTrue(self.request({'name':'spaceo_open_app','arguments':{'app':'Safari'}})['ok'])
