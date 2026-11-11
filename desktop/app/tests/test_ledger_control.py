"""Offline checks for receipt control and recovery linkage."""
import json
import os
import sqlite3
import stat
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
import task_recovery
LEDGER = ROOT / 'build/agent-request-ledger'
SERVER = ROOT / 'build/agent-local-requests'

@unittest.skipUnless(os.access(LEDGER, os.X_OK) and os.access(SERVER, os.X_OK), 'build Rust helpers first')
class LedgerControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name) / 'control'
    def invoke(self, mode, data):
        return subprocess.run([str(LEDGER), str(self.directory), mode], input=json.dumps(data), text=True, capture_output=True, timeout=5)
    def test_admit_finish_deduplicate_and_no_plaintext_output(self):
        task='Prepare a private project outline'
        first=self.invoke('admit', {'text':task,'sourceId':'voice:stable-id'})
        self.assertEqual(first.returncode,0); self.assertNotIn(task,first.stdout+first.stderr)
        receipt=json.loads(first.stdout); self.assertFalse(receipt['duplicate']); self.assertEqual(receipt['status'],'dispatching')
        second=self.invoke('admit', {'text':task,'sourceId':'voice:stable-id'})
        self.assertTrue(json.loads(second.stdout)['duplicate']); self.assertEqual(json.loads(second.stdout)['receiptId'],receipt['receiptId'])
        finished=self.invoke('finish', {'receiptId':receipt['receiptId'],'status':'accepted'})
        self.assertEqual(json.loads(finished.stdout),{'ok':True})
        self.assertEqual(json.loads(self.invoke('admit', {'text':task,'sourceId':'voice:stable-id'}).stdout)['status'],'accepted')
        self.assertNotIn(task.encode(),(self.directory/'request-ledger.sqlite3').read_bytes())
    def test_cursor_pagination_and_rescan_for_mutations(self):
        ids=[]
        for index in range(5):
            result=self.invoke('admit', {'text':f'task {index}','sourceId':f'voice:{index}'})
            ids.append(json.loads(result.stdout)['receiptId'])
        first=json.loads(self.invoke('list-page', {'cursor':None,'limit':2}).stdout)
        self.assertEqual([r['receiptId'] for r in first['receipts']],ids[::-1][:2])
        self.assertIsNotNone(first['nextCursor'])
        # Status changes to already-read rows require a fresh scan.
        self.invoke('finish', {'receiptId':ids[-1],'status':'accepted'})
        new=json.loads(self.invoke('admit', {'text':'new task','sourceId':'voice:new'}).stdout)['receiptId']
        collected=first['receipts']; cursor=first['nextCursor']
        while cursor is not None:
            page=json.loads(self.invoke('list-page', {'cursor':cursor,'limit':2}).stdout)
            collected += page['receipts']; cursor=page['nextCursor']
        self.assertEqual([r['receiptId'] for r in collected],ids[::-1])
        refreshed=json.loads(self.invoke('list-page', {'cursor':None,'limit':2}).stdout)
        self.assertEqual([r['receiptId'] for r in refreshed['receipts']],[new,ids[-1]])
        self.assertEqual(refreshed['receipts'][1]['status'],'accepted')
        default=subprocess.run([str(LEDGER),str(self.directory)],text=True,capture_output=True,check=True)
        self.assertIsInstance(json.loads(default.stdout),list)
        self.assertNotEqual(self.invoke('list-page', {'cursor':'bad'}).returncode,0)
        self.assertNotEqual(self.invoke('list-page', {'limit':101}).returncode,0)

    def test_list_page_never_mutates_or_creates_ledger_files(self):
        result=self.invoke('admit', {'text':'Review the project','sourceId':'voice:readonly'})
        self.assertEqual(result.returncode,0)
        (self.directory/'request-ledger.key.lock').unlink()
        os.chmod(self.directory, 0o750)
        before={p.name:(p.read_bytes(),p.stat().st_mtime_ns,stat.S_IMODE(p.stat().st_mode)) for p in self.directory.iterdir()}
        mode=stat.S_IMODE(self.directory.stat().st_mode)
        result=self.invoke('list-page', {'cursor':None})
        self.assertEqual(result.returncode,0)
        self.assertEqual(len(json.loads(result.stdout)['receipts']),1)
        after={p.name:(p.read_bytes(),p.stat().st_mtime_ns,stat.S_IMODE(p.stat().st_mode)) for p in self.directory.iterdir()}
        self.assertEqual(before,after); self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode),mode)

    def test_missing_corrupt_or_missing_key_fails_closed_without_creation(self):
        result=self.invoke('list-page', {'cursor':None})
        self.assertNotEqual(result.returncode,0); self.assertFalse(self.directory.exists())
        self.directory.mkdir(); path=self.directory/'request-ledger.sqlite3'
        path.write_bytes(b'not sqlite'); os.chmod(path,0o600); before=path.read_bytes()
        self.assertNotEqual(self.invoke('list-page', {'cursor':None}).returncode,0)
        self.assertEqual(path.read_bytes(),before); self.assertEqual([p.name for p in self.directory.iterdir()],[path.name])
        path.unlink()
        with sqlite3.connect(path) as db: db.execute('CREATE TABLE unrelated (id INTEGER)')
        os.chmod(path,0o600); before=path.read_bytes()
        self.assertNotEqual(self.invoke('list-page', {'cursor':None}).returncode,0)
        self.assertEqual(path.read_bytes(),before); self.assertEqual([p.name for p in self.directory.iterdir()],[path.name])
        path.unlink()
        self.assertEqual(self.invoke('admit', {'text':'Valid task','sourceId':'voice:missing-key'}).returncode,0)
        (self.directory/'request-ledger.key').unlink()
        before={p.name:p.read_bytes() for p in self.directory.iterdir()}
        self.assertNotEqual(self.invoke('list-page', {'cursor':None}).returncode,0)
        self.assertEqual({p.name:p.read_bytes() for p in self.directory.iterdir()},before)

    def test_empty_ledger_requires_its_existing_key(self):
        self.assertEqual(self.invoke('admit', {'text':'Valid task','sourceId':'voice:empty'}).returncode,0)
        path=self.directory/'request-ledger.sqlite3'
        with sqlite3.connect(path) as db: db.execute('DELETE FROM receipts')
        result=self.invoke('list-page', {'cursor':None})
        self.assertEqual(result.returncode,0); self.assertEqual(json.loads(result.stdout)['receipts'],[])
        (self.directory/'request-ledger.key').unlink()
        self.assertNotEqual(self.invoke('list-page', {'cursor':None}).returncode,0)
        self.assertFalse((self.directory/'request-ledger.key').exists())

    def test_bad_input_is_rejected_without_echo(self):
        result=self.invoke('admit', {'text':'password never print this','sourceId':'bad id'})
        self.assertNotEqual(result.returncode,0); self.assertNotIn('password',result.stdout+result.stderr)
    def test_socket_event_includes_same_receipt_as_reply(self):
        process=subprocess.Popen([str(SERVER),str(self.directory)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            self.assertEqual(json.loads(process.stdout.readline())['type'],'ready')
            client=socket.socket(socket.AF_UNIX); client.settimeout(5); client.connect(str(self.directory/'request.sock'))
            client.sendall(b'{"text":"request", "sourceId":"typed:123"}\n')
            event=json.loads(process.stdout.readline()); self.assertEqual(event['type'],'request')
            process.stdin.write(json.dumps({'id':event['id'],'result':{'ok':True}})+'\n'); process.stdin.flush()
            reply=json.loads(client.recv(4096)); client.close()
            self.assertEqual(event['receiptId'],reply['receiptId']); self.assertEqual(reply['status'],'accepted')
        finally:
            process.stdin.close(); process.wait(timeout=5); process.stdout.close(); process.stderr.close()
    def test_native_recovery_record_keeps_only_valid_receipt_id(self):
        with mock.patch.dict(os.environ, {'AGENT_STATE_DIR':self.tmp.name}):
            receipt='a'*32
            enabled,result=task_recovery._native({'op':'begin','id':'task-id','device':'mac','thread':'thread-id','receiptId':receipt})
            self.assertTrue(enabled); self.assertEqual(result,'task-id')
            self.assertEqual(task_recovery.current()['receiptId'],receipt)
            with self.assertRaises(ValueError):
                task_recovery._native({'op':'begin','id':'task-id','device':'mac','thread':'thread-id','receiptId':'secret-like text'})
            self.assertEqual(task_recovery.current()['receiptId'],receipt)
