import datetime
import unittest
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from sign import select

class ProvisioningTests(unittest.TestCase):
    def profile(self, bundle="app.hive.xctrunner", network=True, expired=False):
        return (b"synthetic test profile", {
            "ExpirationDate": datetime.datetime(2000 if expired else 2100, 1, 1),
            "Entitlements": {
                "application-identifier": "TESTTEAM." + bundle,
                "get-task-allow": True,
                "com.apple.developer.networking.networkextension": ["packet-tunnel-provider"] if network else [],
            },
        })

    def test_extension_requires_its_own_identifier_and_capability(self):
        app = self.profile()
        extension = self.profile("app.hive.xctrunner.loopback")
        for profiles in [[app], [self.profile("app.hive.xctrunner.loopback", network=False)], [self.profile("app.hive.xctrunner.loopback", expired=True)]]:
            with self.assertRaises(RuntimeError):
                select(profiles, "app.hive.xctrunner.loopback", True)
        self.assertEqual(select([app, extension], "app.hive.xctrunner.loopback", True)[2]["application-identifier"], "TESTTEAM.app.hive.xctrunner.loopback")

    def test_external_exception_does_not_print_private_profile_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = "private-profile-label-for-test"
            source = str(Path(directory) / marker)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("sign.py")), "Hive.app"],
                env={**os.environ, "HIVE_IOS_PROFILE": source}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn(marker, result.stderr)
            self.assertEqual(result.stdout, "")

    def test_runner_rejects_distribution_profiles(self):
        profile = self.profile()
        profile[1]["Entitlements"]["get-task-allow"] = False
        with self.assertRaises(RuntimeError):
            select([profile], "app.hive.xctrunner", True, development=True)

    def test_wildcard_does_not_authorize_the_extension(self):
        with self.assertRaises(RuntimeError):
            select([self.profile("*")], "app.hive.xctrunner.loopback", True)

if __name__ == "__main__":
    unittest.main()
