"""The Rust chunker must preserve Unicode and the Python boundary choices."""
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import ingest

@unittest.skipUnless(os.access(ingest.RUST_INGEST, os.X_OK), 'build ingestion helper first')
class RustIngestTests(unittest.TestCase):
    def test_matches_python_boundaries_for_unicode_and_random_text(self):
        random.seed(71)
        fixtures = ['', '😀界é\n\n' * 40, 'abc. next\nmore ' * 30]
        alphabet = 'abc  \n.界😀é'
        fixtures += [''.join(random.choice(alphabet) for _ in range(random.randrange(150))) for _ in range(40)]
        for text in fixtures:
            for size in (1, 2, 7, 23, 100):
                native = ingest.split(text, size)
                with mock.patch.object(ingest, 'RUST_INGEST', Path('/nonexistent/helper')):
                    python = ingest.split(text, size)
                self.assertEqual(native, python)
                self.assertEqual(''.join(native), text)

    def test_broken_helper_does_not_drop_text(self):
        with mock.patch.object(ingest, 'RUST_INGEST', Path('/usr/bin/false')):
            with self.assertRaises(RuntimeError): ingest.split('important text')

    def test_rollout_marker_checks_only_present_lines_and_tolerates_invalid_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'rollout.jsonl'
            path.write_bytes(b'bad-utf8-\xff\nuser marker\npartial\nmarker\n')
            self.assertTrue(ingest.in_rollout(str(path), 'user marker'))
            self.assertFalse(ingest.in_rollout(str(path), 'partialmarker'))
            self.assertFalse(ingest.in_rollout(str(path / 'missing'), 'user marker'))
            with mock.patch.object(ingest, 'RUST_INGEST', Path('/usr/bin/false')):
                with self.assertRaises(OSError): ingest.in_rollout(str(path), 'user marker')

    def test_invalid_chunk_size_is_rejected(self):
        with self.assertRaises(ValueError): ingest.split('text', 0)
