import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from workspace_update import decision


def report(running, matches=None, instance="one"):
    return {"daemon": {"running": running, "matchesCLI": matches, "instanceID": instance}}


class WorkspaceUpdateTests(unittest.TestCase):
    def test_new_helper_when_no_live_daemon(self):
        self.assertEqual(decision(report(False), report(False)), "new")

    def test_existing_live_daemon_accepts_same_build(self):
        self.assertEqual(decision(report(True, True), report(True, True)), "new")

    def test_changed_helper_keeps_live_engine_until_idle(self):
        self.assertEqual(decision(report(True, False), report(True, True)), "preserve")

    def test_uncertain_or_changed_owner_is_not_overwritten(self):
        self.assertEqual(decision({}, report(True, True)), "unsafe")
        self.assertEqual(decision(report(True, False), report(True, True, "other")), "unsafe")
        self.assertEqual(decision(report(True, False), report(False)), "unsafe")


if __name__ == "__main__":
    unittest.main()
