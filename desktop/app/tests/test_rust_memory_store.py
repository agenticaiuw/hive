"""Production bridge compatibility against existing Python SQLite databases."""
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import agent_workspace_tools as tools

@unittest.skipUnless(os.access(tools.MEMORY_STORE, os.X_OK), 'build Rust memory helper first')
class RustMemoryStoreTests(unittest.TestCase):
    def test_python_and_rust_share_database_and_deduplicate(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            with mock.patch.object(tools, 'MEMORY_STORE', Path('/nonexistent/helper')):
                tools.memory({'op':'add', 'statement':'  Café task  ', 'source':' photo ', 'kind':'fact'}, state)
            tools.memory({'op':'add', 'statement':'Café task', 'source':'photo', 'kind':'fact'}, state)
            tools.memory({'op':'add', 'statement':'Next', 'source':'notes', 'kind':'question'}, state)
            rows = json.loads(tools.memory({'op':'list'}, state)['content'][0]['text'])
            self.assertEqual([r[1] for r in rows], ['Next', 'Café task'])
            self.assertEqual(stat.S_IMODE((state / 'memory').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((state / 'memory/personal-memory.sqlite3').stat().st_mode), 0o600)

    def test_missing_list_does_not_create_or_contact_helper(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            self.assertIn('No memories', tools.memory({'op':'list'}, state)['content'][0]['text'])
            self.assertFalse((state / 'memory').exists())

    def test_failed_helper_never_retries_write_using_python(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(tools, 'MEMORY_STORE', Path('/usr/bin/false')):
            state = Path(folder)
            with self.assertRaises(RuntimeError):
                tools.memory({'op':'add', 'statement':'x', 'source':'s', 'kind':'fact'}, state)
            self.assertFalse((state / 'memory').exists())

    def test_failed_read_rolls_back_new_record(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); directory = state / 'memory'; directory.mkdir()
            database = directory / 'personal-memory.sqlite3'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE memories(id INTEGER PRIMARY KEY, statement TEXT, source TEXT, kind TEXT)')
            with self.assertRaises(RuntimeError):
                tools.memory({'op':'add', 'statement':'new', 'source':'notes', 'kind':'fact'}, state)
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM memories').fetchone()[0], 0)

    def test_bad_database_fails_without_exposing_or_replacing_it(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); directory = state / 'memory'; directory.mkdir()
            database = directory / 'personal-memory.sqlite3'; database.write_bytes(b'broken')
            with self.assertRaises(RuntimeError): tools.memory({'op':'list'}, state)
            self.assertEqual(database.read_bytes(), b'broken')
