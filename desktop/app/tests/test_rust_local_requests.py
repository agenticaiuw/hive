"""Rust socket server integration; all state and sockets are temporary."""
import json
import os
from pathlib import Path
import queue
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from local_request import LocalRequests, RUST_LOCAL_REQUESTS

@unittest.skipUnless(os.access(RUST_LOCAL_REQUESTS, os.X_OK), 'build Rust socket helper first')
class RustLocalRequestsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.events = queue.Queue()
        self.server = LocalRequests(Path(self.temp.name) / 'control', self.events)
        self.server.start(); self.addCleanup(self.server.close)

    def request(self, raw):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3); client.connect(str(self.server.path)); client.sendall(raw)
            data = b''
            while b'\n' not in data: data += client.recv(4096)
            return json.loads(data)

    def test_invalid_input_does_not_reach_host(self):
        for raw in (b'{"text":" "}\n', b'{"text":"hello","resume_goal":1}\n',
                    b'{"text":"hello","goal_objective":"goal"}\n'):
            self.assertFalse(self.request(raw)['ok'])
        try:
            self.assertFalse(self.request(b'x' * 16385 + b'\n')['ok'])
        except OSError:
            pass  # The server can close while the oversized client is still writing.
        self.assertTrue(self.events.empty())

    def test_fragmented_request_waits_for_complete_line(self):
        result = []
        def client():
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(3); connection.connect(str(self.server.path))
                connection.sendall(b'{"text":')
                time.sleep(0.1)
                connection.sendall(b'"fragmented"}\n')
                result.append(json.loads(connection.recv(1024)))
        worker = threading.Thread(target=client); worker.start()
        _, payload = self.events.get(timeout=3)
        self.assertEqual(payload[0], 'fragmented')
        payload[1].put({'ok': True}); worker.join(3)
        self.assertTrue(result[0]['ok'])

    def test_concurrent_requests_keep_replies_with_their_clients(self):
        results = {}
        receipts = {}
        def client(text): results[text] = self.request(json.dumps({'text':text}).encode() + b'\n')
        threads = [threading.Thread(target=client, args=(str(i),)) for i in range(4)]
        for t in threads: t.start()
        for _ in threads:
            kind, (text, reply, deadline, resume, objective, receipt) = self.events.get(timeout=3)
            self.assertEqual(kind, 'local_request'); self.assertGreater(deadline, time.monotonic())
            self.assertFalse(resume); self.assertIsNone(objective); receipts[text] = receipt
            reply.put({'ok': True, 'text': text})
        for t in threads: t.join(3)
        self.assertEqual({k:v['text'] for k,v in results.items()}, {str(i):str(i) for i in range(4)})
        self.assertEqual({k:v['receiptId'] for k,v in results.items()}, receipts)

    def test_resume_fields_and_active_socket_refusal(self):
        second = LocalRequests(self.server.directory, queue.Queue())
        with self.assertRaises(RuntimeError): second.start()
        result = []
        t = threading.Thread(target=lambda: result.append(self.request(b'{"text":" go ","resume_goal":true,"goal_objective":" goal "}\n')))
        t.start()
        _, payload = self.events.get(timeout=3)
        self.assertEqual((payload[0], payload[3], payload[4]), ('go', True, ' goal '))
        payload[1].put({'ok':True}); t.join(3)
        self.assertTrue(result[0]['ok'])

    def test_crashed_server_socket_is_reclaimed(self):
        self.server.process.kill()
        self.server.process.wait(timeout=3)
        self.server.close()
        self.assertTrue(self.server.path.exists())
        replacement = LocalRequests(self.server.directory, self.events)
        replacement.start()
        try:
            received = []
            worker = threading.Thread(target=lambda: received.append(self.request(b'{"text":"hello"}\n')))
            worker.start()
            _, payload = self.events.get(timeout=3)
            payload[1].put({'ok':True}); worker.join(3)
            self.assertTrue(received[0]['ok'])
        finally:
            replacement.close()

    def test_close_does_not_unlink_replacement(self):
        self.server.path.unlink(); self.server.path.write_text('preserve')
        self.server.close()
        self.assertEqual(self.server.path.read_text(), 'preserve')
