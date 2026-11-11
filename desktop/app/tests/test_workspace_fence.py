"""Explicit creation policy; tests never touch a display or daemon."""
import concurrent.futures
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import workspace_fence

class WorkspaceFenceTests(unittest.TestCase):
    def test_absence_and_corruption_never_authorize_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            self.assertEqual(workspace_fence.policy(root),'unconfigured')
            with self.assertRaises(RuntimeError): workspace_fence.create_once(root, lambda: self.fail('created'))
            (root/workspace_fence.FILE).write_text('{broken')
            self.assertEqual(workspace_fence.policy(root),'closed')
            with self.assertRaises(RuntimeError): workspace_fence.create_once(root, lambda: self.fail('created'))
    def test_closed_state_survives_new_reader(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); workspace_fence.set_policy(root,'closed')
            self.assertEqual(json.loads((root/workspace_fence.FILE).read_text())['mode'],'closed')
            self.assertEqual(workspace_fence.policy(root),'closed')
    def test_closed_policy_survives_a_new_process(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); workspace_fence.set_policy(root,'closed')
            code="import workspace_fence; print(workspace_fence.policy(workspace_fence.state_dir()))"
            environment=dict(os.environ, AGENT_STATE_DIR=folder,
                             PYTHONPATH=str(Path(__file__).resolve().parents[1]/'python'))
            result=subprocess.run([sys.executable,'-c',code],env=environment,capture_output=True,text=True,check=True,timeout=5)
            self.assertEqual(result.stdout.strip(),'closed')

    def test_concurrent_one_time_permit_creates_at_most_once(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); workspace_fence.set_policy(root,'allow-once'); calls=[]
            def attempt(_):
                try: return workspace_fence.create_once(root, lambda: calls.append('created') or True)
                except RuntimeError: return False
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results=list(pool.map(attempt,range(8)))
            self.assertEqual(results.count(True),1); self.assertEqual(calls,['created'])
            self.assertEqual(workspace_fence.policy(root),'existing-only')
    def test_close_is_serialized_against_an_inflight_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); workspace_fence.set_policy(root,'allow-once')
            entered=threading.Event(); release=threading.Event(); closed=threading.Event()
            def create(): entered.set(); release.wait(2)
            worker=threading.Thread(target=lambda: workspace_fence.create_once(root,create)); worker.start()
            self.assertTrue(entered.wait(2))
            closer=threading.Thread(target=lambda: (workspace_fence.set_policy(root,'closed'),closed.set())); closer.start()
            self.assertFalse(closed.wait(0.05)); release.set(); worker.join(2); closer.join(2)
            self.assertTrue(closed.is_set()); self.assertEqual(workspace_fence.policy(root),'closed')
            with self.assertRaises(RuntimeError): workspace_fence.create_once(root,lambda: self.fail('created again'))
