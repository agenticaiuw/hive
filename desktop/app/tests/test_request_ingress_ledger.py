"""Durability, privacy and crash ordering for local request admission."""
import json
import os
from pathlib import Path
import queue
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from local_request import LocalRequests, RUST_LOCAL_REQUESTS
ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / 'build/agent-request-ledger'

@unittest.skipUnless(os.access(RUST_LOCAL_REQUESTS, os.X_OK) and os.access(LEDGER, os.X_OK), 'build Rust helpers first')
class RequestIngressLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'control'; self.events = queue.Queue()
        self.server = LocalRequests(self.directory, self.events); self.server.start(); self.addCleanup(self.server.close)
    def call(self, request):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(8); client.connect(str(self.server.path)); client.sendall(json.dumps(request).encode()+b'\n')
            data = bytearray()
            while b'\n' not in data:
                part = client.recv(65536)
                if not part: raise RuntimeError('connection closed')
                data.extend(part)
            return json.loads(data)
    def list(self):
        return json.loads(subprocess.run([str(LEDGER), str(self.directory)], capture_output=True, text=True, check=True).stdout)
    def test_persisted_before_dispatch_and_duplicates_never_dispatch(self):
        result=[]; source='mesh:pc1:nmsg_abc'; text='Prepare the project outline'
        thread=threading.Thread(target=lambda: result.append(self.call({'text':text,'sourceId':source}))); thread.start()
        _, payload=self.events.get(timeout=5)
        rows=self.list(); self.assertEqual((rows[0]['status'],rows[0]['text']),('dispatching',text))
        self.assertEqual(payload[5], rows[0]['receiptId'])
        self.assertNotIn(text.encode(), (self.directory/'request-ledger.sqlite3').read_bytes())
        self.assertEqual(stat.S_IMODE((self.directory/'request-ledger.key').stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE((self.directory/'request-ledger.sqlite3').stat().st_mode),0o600)
        payload[1].put({'ok':True}); thread.join(5)
        self.assertEqual(result[0]['status'],'accepted'); self.assertEqual(self.list()[0]['status'],'accepted')
        duplicate=self.call({'text':'other text','sourceId':source})
        self.assertFalse(duplicate['ok']); self.assertEqual(duplicate['status'],'accepted')
        self.assertEqual(duplicate['receiptId'],result[0]['receiptId']); self.assertTrue(self.events.empty())
    def test_simultaneous_same_source_dispatches_once(self):
        source='mesh:pc1:nmsg_concurrent'; results=[]; lock=threading.Lock()
        def caller():
            value=self.call({'text':'Work on the plan','sourceId':source})
            with lock: results.append(value)
        threads=[threading.Thread(target=caller) for _ in range(8)]
        for thread in threads: thread.start()
        _,payload=self.events.get(timeout=5)
        payload[1].put({'ok':True})
        for thread in threads: thread.join(8)
        self.assertEqual(len(results),8)
        self.assertEqual(sum(result['ok'] is True for result in results),1)
        self.assertEqual(len({result['receiptId'] for result in results}),1)
        self.assertTrue(self.events.empty()); self.assertEqual(len(self.list()),1)

    def test_crash_after_dispatch_leaves_unknown_without_replay(self):
        source='mesh:pc1:nmsg_crash'; outcome=[]
        def client():
            try: outcome.append(self.call({'text':'Review the budget','sourceId':source}))
            except (OSError,RuntimeError): pass
        thread=threading.Thread(target=client); thread.start()
        self.events.get(timeout=5)
        self.server.process.kill(); self.server.process.wait(timeout=3); self.server.close(); thread.join(5)
        self.server=LocalRequests(self.directory,self.events); self.server.start(); self.addCleanup(self.server.close)
        duplicate=self.call({'text':'Review the budget','sourceId':source})
        self.assertFalse(duplicate['ok']); self.assertEqual(duplicate['status'],'dispatching')
        self.assertEqual(self.list()[0]['text'],'Review the budget'); self.assertTrue(self.events.empty())
    def test_credential_pattern_omits_content_but_preserves_admission(self):
        secret='password is never-save-this'; result=[]
        thread=threading.Thread(target=lambda: result.append(self.call({'text':secret}))); thread.start()
        _,payload=self.events.get(timeout=5); self.assertEqual(payload[0],secret); payload[1].put({'ok':True}); thread.join(5)
        row=self.list()[0]; self.assertIsNone(row['text']); self.assertTrue(row['textOmitted'])
        for path in self.directory.iterdir():
            if path.is_file(): self.assertNotIn(secret.encode(),path.read_bytes())
    def test_only_explicit_pre_start_refusals_are_rejected(self):
        outcomes = [
            ('Request not accepted; check agent availability.', 'unknown'),
            ('Unexpected failure after dispatch', 'unknown'),
            ('The request expired before it could start.', 'rejected'),
            ('The personal-agent is already working.', 'rejected'),
        ]
        for error, expected in outcomes:
            result=[]
            thread=threading.Thread(target=lambda: result.append(self.call({'text':'Review the plan'})))
            thread.start(); _,payload=self.events.get(timeout=5)
            payload[1].put({'ok':False, 'error':error}); thread.join(5)
            self.assertEqual(result[0]['status'],expected)
            self.assertEqual(self.list()[0]['status'],expected)

    def test_objective_is_saved_encrypted_or_omitted_as_one_unit(self):
        result=[]
        thread=threading.Thread(target=lambda: result.append(self.call({'text':'Continue','resume_goal':True,'goal_objective':'Finish the report'}))); thread.start()
        _,payload=self.events.get(timeout=5); self.assertEqual(payload[4],'Finish the report'); payload[1].put({'ok':True}); thread.join(5)
        row=self.list()[0]; self.assertEqual(row['goalObjective'],'Finish the report')
        thread=threading.Thread(target=lambda: result.append(self.call({'text':'Continue','resume_goal':True,'goal_objective':'password is private'}))); thread.start()
        _,payload=self.events.get(timeout=5); payload[1].put({'ok':True}); thread.join(5)
        row=self.list()[0]; self.assertIsNone(row['text']); self.assertIsNone(row['goalObjective']); self.assertTrue(row['textOmitted'])

    def test_lost_key_is_not_regenerated_over_existing_receipts(self):
        thread=threading.Thread(target=lambda: self.call({'text':'Retain the notes'})); thread.start()
        _,payload=self.events.get(timeout=5); payload[1].put({'ok':True}); thread.join(5)
        (self.directory/'request-ledger.key').unlink()
        results=[]
        threads=[threading.Thread(target=lambda: results.append(self.call({'text':'Another task'}))) for _ in range(6)]
        for worker in threads: worker.start()
        for worker in threads: worker.join(5)
        self.assertEqual(len(results),6)
        self.assertTrue(all(not result['ok'] for result in results))
        self.assertFalse((self.directory/'request-ledger.key').exists())
        self.assertTrue(self.events.empty())

    def test_invalid_source_and_unreadable_key_never_dispatch(self):
        self.assertFalse(self.call({'text':'valid task','sourceId':'not valid whitespace'})['ok']); self.assertTrue(self.events.empty())
        (self.directory/'request-ledger.key').write_bytes(b'bad')
        os.chmod(self.directory/'request-ledger.key',0o600)
        self.assertFalse(self.call({'text':'valid task','sourceId':'mesh:pc1:nmsg_bad'})['ok']); self.assertTrue(self.events.empty())
