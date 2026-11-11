"""Native recovery transitions preserve stop fences and process serialization."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import resumable_thread
import task_recovery

@unittest.skipUnless(os.access(resumable_thread.RUST_STATE_LIBRARY, os.R_OK), 'build state library first')
class RustTaskRecoveryTests(unittest.TestCase):
    def test_python_and_native_transition_results_match(self):
        results=[]
        for library in (resumable_thread.RUST_STATE_LIBRARY, Path('/nonexistent/lib')):
            with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'AGENT_STATE_DIR':tmp}), mock.patch.object(resumable_thread, 'RUST_STATE_LIBRARY', library), mock.patch.object(task_recovery.uuid, 'uuid4', return_value=mock.Mock(hex='fixed-id')):
                ident=task_recovery.begin('never save this text','mac','thread-1')
                initial=task_recovery.current()
                startup=task_recovery.reserve('startup',ident)
                repeated=task_recovery.reserve('startup',ident)
                wrong=task_recovery.finish('other','stopped')
                stopped=task_recovery.finish(ident,'stopped')
                after=task_recovery.reserve('blocked',ident)
                results.append((ident,initial,startup,repeated,wrong,stopped,after,task_recovery.current()))
                self.assertNotIn('never save this text',(Path(tmp)/'task-recovery.json').read_text())
        self.assertEqual(*results)

    def test_multiple_processes_can_reserve_only_once(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'AGENT_STATE_DIR':tmp}):
            task_recovery.begin('task','mac','thread-1')
            script="import json,task_recovery; print(json.dumps(task_recovery.reserve('startup')))"
            env=dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]/'python'))
            def reserve(_):
                proc=subprocess.run([sys.executable,'-c',script],env=env,capture_output=True,text=True,check=True,timeout=10)
                return json.loads(proc.stdout)
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results=list(pool.map(reserve,range(6)))
            self.assertEqual(sum(result is not None for result in results),1)
            self.assertEqual(task_recovery.current()['startup_attempts'],1)

    def test_oversized_invalid_state_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'AGENT_STATE_DIR':tmp}):
            path=Path(tmp)/'task-recovery.json'; path.write_text('x'*(512*1024+1))
            before=path.read_bytes()
            with self.assertRaises(ValueError): task_recovery.begin('new','mac','thread-1')
            self.assertEqual(path.read_bytes(),before)
