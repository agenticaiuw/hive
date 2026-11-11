"""Bundle and login migration tests using only temporary fixtures."""
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('hive_migration',Path(__file__).resolve().parents[1]/'scripts/hive_bundle_migration.py')
migration=importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)

class LoginFixture:
    def __init__(self, path=None, status=None, fail_register_target=False):
        self.path=path; self.special=status; self.fail_register_target=fail_register_target; self.calls=[]
    def __call__(self, bundle, operation):
        self.calls.append((bundle.name,operation))
        if operation=='status': return self.special or ('enabled' if self.path==bundle else 'notRegistered')
        if operation=='unregister': self.path=None; return 'notRegistered'
        if operation=='register':
            if self.fail_register_target and bundle.name=='Hive.app': raise RuntimeError('registration failed')
            self.path=bundle; return 'enabled'
        raise AssertionError(operation)

class HiveBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.apps=self.root/'Applications'; self.apps.mkdir()
        self.old=self.apps/'Agent.app'; self.target=self.apps/'Hive.app'; self.stage=self.apps/'.Hive-stage'; self.backup=self.root/'state'/'app-backups'/'previous'
        self.old.mkdir(); (self.old/'old').write_text('preserve'); self.stage.mkdir(); (self.stage/'new').write_text('candidate')
    def test_enabled_login_migrates_at_verified_bundle_paths(self):
        login=LoginFixture(self.old)
        prior=migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertEqual(prior,'enabled'); self.assertEqual(login.path,self.target)
        self.assertEqual(login.calls,[('Agent.app','status'),('Agent.app','unregister'),('Hive.app','register')])
        self.assertFalse(self.old.exists()); self.assertTrue((self.target/'new').exists()); self.assertTrue((self.backup/'old').exists())
        self.assertNotEqual(self.backup.suffix,'.app'); self.assertNotIn(self.apps,self.backup.parents)
    def test_disabled_login_is_not_enabled(self):
        login=LoginFixture()
        prior=migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertEqual(prior,'notRegistered'); self.assertIsNone(login.path)
        self.assertEqual(login.calls,[('Agent.app','status')])
    def test_failed_registration_restores_old_bundle_and_login(self):
        login=LoginFixture(self.old,fail_register_target=True)
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertTrue((self.old/'old').exists()); self.assertTrue((self.stage/'new').exists())
        self.assertFalse(self.target.exists()); self.assertEqual(login.path,self.old)
    def test_launch_failure_rolls_back_enabled_login(self):
        login=LoginFixture(self.old)
        prior=migration.commit(self.old,self.target,self.stage,self.backup,login)
        migration.rollback(self.old,self.target,self.stage,self.backup,prior,login)
        self.assertTrue((self.old/'old').exists()); self.assertTrue((self.stage/'new').exists())
        self.assertFalse(self.target.exists()); self.assertEqual(login.path,self.old)
    def test_unregister_error_after_effect_restores_old_login(self):
        class FailureAfterUnregister(LoginFixture):
            def __call__(self, bundle, operation):
                if operation == 'unregister' and bundle.name == 'Agent.app':
                    self.path=None
                    raise RuntimeError('ambiguous unregister')
                return super().__call__(bundle,operation)
        login=FailureAfterUnregister(self.old)
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertEqual(login.path,self.old); self.assertTrue((self.old/'old').exists())
        self.assertTrue((self.stage/'new').exists()); self.assertFalse(self.target.exists())
    def test_register_error_after_effect_restores_old_login(self):
        class FailureAfterRegister(LoginFixture):
            def __call__(self, bundle, operation):
                if operation == 'register' and bundle.name == 'Hive.app':
                    self.path=bundle
                    raise RuntimeError('ambiguous register')
                return super().__call__(bundle,operation)
        login=FailureAfterRegister(self.old)
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertEqual(login.path,self.old); self.assertTrue((self.old/'old').exists())
        self.assertTrue((self.stage/'new').exists()); self.assertFalse(self.target.exists())
    def test_concurrent_target_appearance_is_not_overwritten(self):
        original=migration._move
        def move(source,target):
            if source==self.stage and target==self.target:
                self.target.mkdir(); (self.target/'other').write_text('preserve')
            return original(source,target)
        login=LoginFixture(self.old)
        with patch.object(migration,'_move',side_effect=move):
            with self.assertRaises(OSError): migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertEqual((self.target/'other').read_text(),'preserve')
        self.assertTrue((self.old/'old').exists()); self.assertTrue((self.stage/'new').exists())
        self.assertEqual(login.path,self.old)
    def test_symlinked_backup_directory_is_refused(self):
        other=self.root/'other'; other.mkdir(); self.backup.parent.parent.mkdir(); self.backup.parent.symlink_to(other, target_is_directory=True)
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,LoginFixture())
        self.assertTrue((self.old/'old').exists()); self.assertTrue(self.stage.exists())

    def test_unknown_login_status_refuses_migration(self):
        login=LoginFixture(status='requiresApproval')
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,login)
        self.assertTrue((self.old/'old').exists()); self.assertFalse(self.target.exists()); self.assertTrue(self.stage.exists())
    def test_duplicate_and_symlink_are_never_overwritten(self):
        self.target.mkdir(); (self.target/'user').write_text('keep')
        with self.assertRaises(RuntimeError): migration.select_installed(self.apps)
        with self.assertRaises(RuntimeError): migration.commit(self.old,self.target,self.stage,self.backup,LoginFixture())
        self.assertEqual((self.target/'user').read_text(),'keep'); self.assertTrue((self.old/'old').exists())
    def test_exclusive_rename_rejects_existing_destination(self):
        self.target.mkdir(); (self.target/'user').write_text('keep')
        with self.assertRaises(OSError): migration._move(self.stage,self.target)
        self.assertEqual((self.target/'user').read_text(),'keep'); self.assertTrue(self.stage.exists())
    def test_updater_relaunches_restored_old_app_after_commit_failure(self):
        source=(Path(__file__).resolve().parents[1]/'tools/update-app.sh').read_text()
        block=source.split('if ! prior_login=$(python3 "$MIGRATOR" commit',1)[1].split('\ndescribe "$APP"',1)[0]
        block='if ! prior_login=$(python3 "$MIGRATOR" commit'+block
        shell="""python3() { return 1; }
launch_without_activation() { printf '%s' "$APP"; }
installed="$1"; APP="$2"; MIGRATOR=ignored; staged=ignored; backup=ignored
"""+block
        result=subprocess.run(['/bin/bash','-c',shell,'test',str(self.old),str(self.target)],capture_output=True,text=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(result.stdout,str(self.old))
        self.assertTrue((self.old/'old').exists())

    def test_existing_hive_update_does_not_toggle_login(self):
        self.old.rename(self.target)
        login=LoginFixture(self.target)
        prior=migration.commit(self.target,self.target,self.stage,self.backup,login)
        self.assertEqual(prior,'unchanged'); self.assertEqual(login.calls,[])
        migration.rollback(self.target,self.target,self.stage,self.backup,prior,login)
        self.assertTrue((self.target/'old').exists()); self.assertEqual(login.calls,[])
