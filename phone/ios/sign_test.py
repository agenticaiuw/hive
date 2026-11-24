import datetime
import unittest
from sign import select

class ProvisioningTests(unittest.TestCase):
    def profile(self, bundle="app.hive.xctrunner", network=True, expired=False):
        return (b"synthetic test profile", {
            "ExpirationDate": datetime.datetime(2000 if expired else 2100, 1, 1),
            "Entitlements": {
                "application-identifier": "TESTTEAM." + bundle,
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

    def test_wildcard_does_not_authorize_the_extension(self):
        with self.assertRaises(RuntimeError):
            select([self.profile("*")], "app.hive.xctrunner.loopback", True)

if __name__ == "__main__":
    unittest.main()
