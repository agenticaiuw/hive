"""Compare memory reader candidates and disclosure filters against Python."""
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import memory_search

@unittest.skipUnless(os.access(memory_search.RUST_SEARCH, os.X_OK), 'build Rust search helper first')
class RustMemorySearchTests(unittest.TestCase):
    def test_queries_match_python_and_exclude_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'memory.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE memories(id INTEGER PRIMARY KEY, statement, source, kind, observed_at)')
                db.executemany('INSERT INTO memories VALUES(?,?,?,?,?)', [
                    (1, 'Eric Wait discussed club', 'message', 'fact', '2026-01-01'),
                    (2, 'Eric Wait password secret', 'message', 'fact', '2026-01-02'),
                    (3, 'Eric_Wait meeting', 'document', 'question', '2026-01-03'),
                    (4, 'Eric Wait wrote', 'hello@example.com', 'fact', '2026-01-04'),
                    (5, 'Eric Wait thing', 'notes', 'untrusted', '2026-01-05'),
                    (6, 'Eric Wait thing', sqlite3.Binary(b'blob'), 'fact', '2026-01-06')])
            rust, python = [], []
            for helper, output in ((memory_search.RUST_SEARCH, rust), (Path('/nonexistent/helper'), python)):
                with mock.patch.object(memory_search, 'RUST_SEARCH', helper):
                    output.extend((memory_search.search('Eric Wait', path), memory_search.search('Eric_Wait', path),
                                   memory_search.automatic_context('Eric Wait club', path)))
            self.assertEqual(rust, python)
            self.assertEqual([r['statement'] for r in rust[1]['results']], ['Eric_Wait meeting'])
            self.assertFalse(any('password' in r['statement'] for r in rust[0]['results']))
            self.assertFalse(any('@' in r['source'] for r in rust[2]['results']))

    def test_helper_failure_returns_unavailable_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'db'; path.write_text('not a database')
            with mock.patch.object(memory_search, 'RUST_SEARCH', Path('/usr/bin/false')):
                self.assertEqual(memory_search.search('Eric', path)['status'], 'unavailable')
                self.assertEqual(memory_search.automatic_context('Eric Wait', path)['status'], 'unavailable')
            self.assertEqual(path.read_text(), 'not a database')
