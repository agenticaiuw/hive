"""Compare Rust settings parsing with the established Python implementation."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import settings

@unittest.skipUnless(os.access(settings.RUST_SETTINGS, os.X_OK), 'build settings helper first')
class RustSettingsTests(unittest.TestCase):
    def test_python_and_rust_parsers_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'env'
            path.write_text("# comment\nexport KEY=first\nKEY=second # note\nQUOTED=' value # kept '\nDOUBLE=\"x=y\"\nEMPTY=\nNOEQUAL\nUNICODE=你好\u2028NEXT=ok\n", encoding='utf-8')
            results = []
            for helper in (settings.RUST_SETTINGS, '/nonexistent/helper'):
                with mock.patch.object(settings, 'RUST_SETTINGS', helper), mock.patch.dict(os.environ, {}, clear=True):
                    settings.from_file.clear(); settings.load(str(path))
                    results.append((dict(os.environ), set(settings.from_file)))
            self.assertEqual(*results)
            self.assertEqual(results[0][0]['QUOTED'], ' value # kept ')
            self.assertEqual(results[0][0]['KEY'], 'second')

    def test_unavailable_file_leaves_environment_unchanged(self):
        with mock.patch.dict(os.environ, {'KEEP':'yes'}, clear=True):
            settings.load('/nonexistent/missing-settings-file')
            self.assertEqual(dict(os.environ), {'KEEP':'yes'})

    def test_helper_failure_never_loads_other_file(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(settings, 'RUST_SETTINGS', '/usr/bin/false'):
            path = Path(tmp) / 'env'; path.write_text('TEST=x')
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError): settings.load(str(path))
                self.assertNotIn('TEST', os.environ)
