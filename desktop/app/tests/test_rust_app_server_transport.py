"""Offline process and byte-stream tests for the Rust app-server transport."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TRANSPORT = ROOT / 'build/agent-app-server-transport'

@unittest.skipUnless(os.access(TRANSPORT, os.X_OK), 'build app-server transport first')
class RustAppServerTransportTests(unittest.TestCase):
    def test_forwards_exact_bytes_and_preserves_exit_code(self):
        code = "import sys; b=sys.stdin.buffer.readline(); sys.stdout.buffer.write(b+b'last\\n'); sys.stdout.buffer.flush(); sys.exit(7)"
        result = subprocess.run([str(TRANSPORT), sys.executable, '-c', code], input='héllo\n'.encode(), capture_output=True, timeout=5)
        self.assertEqual(result.stdout, 'héllo\nlast\n'.encode())
        self.assertEqual(result.returncode, 7)

    def test_propagates_child_signal(self):
        code = 'import os,signal; os.kill(os.getpid(), signal.SIGTERM)'
        result = subprocess.run([str(TRANSPORT), sys.executable, '-c', code], input=b'', capture_output=True, timeout=5)
        self.assertEqual(result.returncode, -signal.SIGTERM)

    def test_host_disconnect_reaps_uncooperative_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / 'pid'
            code = "import os,sys,time; open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(60)"
            process = subprocess.Popen([str(TRANSPORT), sys.executable, '-c', code, str(pidfile)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                import time
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline: time.sleep(.01)
                self.assertTrue(pidfile.exists())
                pid = int(pidfile.read_text()); process.stdin.close()
                self.assertEqual(process.wait(timeout=6), -signal.SIGKILL)
                with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            finally:
                if process.poll() is None: process.kill(); process.wait()
                process.stdout.close(); process.stderr.close()
