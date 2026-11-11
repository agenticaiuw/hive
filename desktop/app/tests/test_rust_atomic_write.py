"""Exercise the in-process Rust writer on temporary files only."""
import concurrent.futures
import os
from pathlib import Path
import stat
import subprocess
import time
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import resumable_thread

@unittest.skipUnless(os.access(resumable_thread.RUST_STATE_LIBRARY, os.R_OK), 'build Rust state library first')
class RustAtomicWriteTests(unittest.TestCase):
    def test_utf8_empty_replacement_and_private_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state' / '界.json'
            resumable_thread.atomic_write(path, 'a\x00界😀')
            self.assertEqual(path.read_bytes(), 'a\x00界😀'.encode())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            resumable_thread.atomic_write(path, '')
            self.assertEqual(path.read_bytes(), b'')

    def test_journal_append_is_immediately_visible_and_handles_closed_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal'
            with path.open('a', encoding='utf-8') as stream:
                resumable_thread.append_synced(stream, 'first 界\n')
                resumable_thread.append_synced(stream, 'second 😀\n')
                self.assertEqual(path.read_text(), 'first 界\nsecond 😀\n')
            with self.assertRaises(ValueError): resumable_thread.append_synced(stream, 'late')

    def test_competing_writers_never_mix_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state'
            values = [str(n) * 10000 for n in range(10)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                list(pool.map(lambda text: resumable_thread.atomic_write(path, text), values))
            self.assertIn(path.read_text(), values)

    def test_killed_writer_never_leaves_a_partial_committed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state'
            script = """import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import resumable_thread as r
p = Path(sys.argv[2])
r.atomic_write(p, 'b' * 1000000)
Path(sys.argv[3]).touch()
while True:
    r.atomic_write(p, 'a' * 1000000)
    r.atomic_write(p, 'b' * 1000000)
"""
            marker = Path(tmp) / 'started'
            resumable_thread.atomic_write(path, 'a' * 1000000)
            child = subprocess.Popen([sys.executable, '-c', script, str(Path(__file__).resolve().parents[1] / 'python'), str(path), str(marker)])
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(marker.exists(), 'child did not start writing')
            finally:
                child.kill(); child.wait(timeout=3)
            first = path.read_bytes()
            self.assertIn(first, (b'a' * 1000000, b'b' * 1000000))
            time.sleep(0.05)
            self.assertEqual(path.read_bytes(), first)

    def test_failed_replace_does_not_delete_existing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'directory'; path.mkdir()
            with self.assertRaises(OSError): resumable_thread.atomic_write(path, 'data')
            self.assertTrue(path.is_dir())

    def test_rust_and_python_writers_have_same_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            native = Path(tmp) / 'native'; fallback = Path(tmp) / 'fallback'
            resumable_thread.atomic_write(native, 'private\ntext')
            with mock.patch.object(resumable_thread, 'RUST_STATE_LIBRARY', Path('/nonexistent/lib')):
                resumable_thread.atomic_write(fallback, 'private\ntext')
            self.assertEqual(native.read_bytes(), fallback.read_bytes())
