"""Credential helper selection uses temporary bundles only; no Keychain calls."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import credentials

class CredentialExecutableTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.home=self.root/'home'; self.repo=self.root/'repo'
        self.home.mkdir(); self.repo.mkdir()
        h=patch.object(Path,'home',return_value=self.home); h.start(); self.addCleanup(h.stop)
        r=patch.object(credentials,'ROOT',self.repo); r.start(); self.addCleanup(r.stop)
    def bundle(self, path):
        binary=path/'Contents/MacOS/Agent'; binary.parent.mkdir(parents=True); binary.write_text('fixture'); binary.chmod(0o700); return binary
    def test_prefers_installed_hive_over_legacy_and_build(self):
        legacy=self.bundle(self.home/'Applications/Agent.app'); build=self.bundle(self.repo/'build/Agent.app'); hive=self.bundle(self.home/'Applications/Hive.app')
        self.assertEqual(credentials.executable(),str(hive)); self.assertNotEqual(str(hive),str(legacy)); self.assertNotEqual(str(hive),str(build))
    def test_fallback_only_when_hive_bundle_is_absent(self):
        legacy=self.bundle(self.home/'Applications/Agent.app'); self.assertEqual(credentials.executable(),str(legacy))
        for p in [legacy, legacy.parent, legacy.parent.parent, legacy.parent.parent.parent]:
            if p.is_file(): p.unlink()
            else: p.rmdir()
        build=self.bundle(self.repo/'build/Agent.app'); self.assertEqual(credentials.executable(),str(build))
    def test_damaged_or_symlinked_hive_never_falls_back(self):
        self.bundle(self.home/'Applications/Agent.app')
        hive=self.home/'Applications/Hive.app'; hive.mkdir()
        with self.assertRaises(credentials.CredentialError): credentials.executable()
        hive.rmdir(); hive.symlink_to(self.home/'Applications/Agent.app',target_is_directory=True)
        with self.assertRaises(credentials.CredentialError): credentials.executable()
    def test_nonexecutable_hive_never_falls_back(self):
        self.bundle(self.home/'Applications/Agent.app'); hive=self.bundle(self.home/'Applications/Hive.app'); hive.chmod(0o600)
        with self.assertRaises(credentials.CredentialError): credentials.executable()
    def test_missing_bundles_fail_without_invocation(self):
        with self.assertRaises(credentials.CredentialError): credentials.executable()
