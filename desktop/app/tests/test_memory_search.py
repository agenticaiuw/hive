import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from memory_search import search

class SearchTests(unittest.TestCase):
    def test_scoped_sourced_results_and_secret_exclusion(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'memory.db'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE memories(id INTEGER PRIMARY KEY, statement TEXT, source TEXT, kind TEXT, observed_at TEXT)')
                db.executemany('INSERT INTO memories VALUES(?,?,?,?,?)', [
                    (1, 'Eric Wait wants to discuss the club', 'mail preview Oct 2', 'fact', '2026-11-10'),
                    (2, 'Did Eric Wait meet?', 'photo', 'question', '2026-11-10'),
                    (3, 'Unrelated Bucky detail', 'notes', 'inference', '2026-11-10'),
                    (4, 'Eric Wait password is confidential', 'notes', 'fact', '2026-11-10')])
            result = search('Eric Wait', path)
            self.assertEqual(result['status'], 'ok')
            self.assertEqual({r['kind'] for r in result['results']}, {'fact', 'question'})
            self.assertTrue(all(r['source'] and r['observed_at'] for r in result['results']))
            self.assertEqual(search('Bucky', path)['results'][0]['kind'], 'inference')
            self.assertEqual(search('password', path)['status'], 'invalid_query')
    def test_missing_and_bad_schema_fail_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'absent'
            self.assertEqual(search('Eric', path)['status'], 'unavailable')
            self.assertFalse(path.exists())
            path.write_text('not a database')
            self.assertEqual(search('Eric', path)['status'], 'unavailable')

if __name__ == '__main__': unittest.main()

class AutomaticContextTests(unittest.TestCase):
    def fixture(self, path):
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE memories(id INTEGER PRIMARY KEY, statement TEXT, source TEXT, kind TEXT, observed_at TEXT)')
            db.executemany('INSERT INTO memories VALUES(?,?,?,?,?)', [
                (1, 'Eric Wait discussed the club', 'Outlook preview Oct 2', 'fact', '2026-11-10'),
                (2, 'Did Eric Wait meet?', 'photo', 'question', '2026-11-10'),
                (3, 'Bucky housing deployment needs review', 'project notes', 'inference', '2026-11-10'),
                (4, 'Eric Wait password is hello', 'notes', 'fact', '2026-11-10'),
                (5, 'Eric Wait contact me at person@example.com', 'notes', 'fact', '2026-11-10'),
                (6, 'Eric Wait session '+('A'*45), 'notes', 'fact', '2026-11-10'),
                (7, 'Meeting about club', 'Eric Wait unrelated source', 'fact', '2026-11-10')])
    def test_relevant_only_with_labels_and_secret_exclusion(self):
        from memory_search import automatic_context
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.db'; self.fixture(path)
            result = automatic_context('Prepare a follow-up for Eric Wait', path)
            self.assertEqual({r['kind'] for r in result['results']}, {'fact', 'question'})
            self.assertTrue(all(r['source'] and r['observed_at'] for r in result['results']))
            self.assertEqual(automatic_context('Check the weather in Madison today', path)['results'], [])
            self.assertEqual(automatic_context('Find Eric Wait password', path)['status'], 'skipped')
            self.assertEqual(automatic_context('Do not access personal memory about Eric Wait', path)['status'], 'skipped')
    def test_missing_and_corrupt_fail_safely(self):
        from memory_search import automatic_context
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'missing'
            self.assertEqual(automatic_context('Eric Wait meeting', path)['status'], 'unavailable')
            self.assertFalse(path.exists())
            path.write_text('broken')
            self.assertEqual(automatic_context('Eric Wait meeting', path)['status'], 'unavailable')
    def test_bounded_results(self):
        from memory_search import automatic_context
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.db'; self.fixture(path)
            with sqlite3.connect(path) as db:
                for i in range(10): db.execute('INSERT INTO memories(statement,source,kind,observed_at) VALUES(?,?,?,?)', (f'Eric Wait item {i}', 'photo', 'fact', '2026-11-10'))
            self.assertEqual(len(automatic_context('Eric Wait meeting', path)['results']), 3)

class MemoryActivityTests(unittest.TestCase):
    def test_shows_filtered_source_and_kind_with_bounds(self):
        from memory_search import activity_summary
        rows = [{'statement': 'Eric Wait discussed the club', 'source': 'Outlook preview', 'kind': 'fact'},
                {'statement': 'Did Eric Wait meet?', 'source': 'Photo', 'kind': 'question'},
                {'statement': 'Eric Wait password: forbidden', 'source': 'Notes', 'kind': 'inference'}]
        result = activity_summary({'status': 'ok', 'results': rows})
        self.assertIn('[fact] Eric Wait', result)
        self.assertIn('source: Outlook preview', result)
        self.assertIn('[question]', result)
        self.assertNotIn('forbidden', result)
        long = activity_summary({'status': 'ok', 'results': [{'statement': 'a ' * 300, 'source': 'b ' * 300, 'kind': 'inference'}]})
        self.assertLess(len(long), 300)
    def test_no_results_and_unavailable_are_distinct(self):
        from memory_search import activity_summary
        self.assertIsNone(activity_summary({'status': 'ok', 'results': []}))
        self.assertIsNone(activity_summary({'status': 'skipped', 'results': []}))
        self.assertIn('unavailable', activity_summary({'status': 'unavailable', 'results': []}))
    def test_end_to_end_fixture_activity_excludes_unrelated_and_secrets(self):
        from memory_search import automatic_context, activity_summary
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.db'
            AutomaticContextTests().fixture(path)
            text = activity_summary(automatic_context('Eric Wait meeting', path))
            self.assertIn('[fact]', text)
            self.assertIn('[question]', text)
            self.assertNotIn('Bucky', text)
            self.assertNotIn('password', text)
            self.assertNotIn('example.com', text)
