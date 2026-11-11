"""Lip reading's plumbing (python/lipread.py) with a fake worker: no camera, model or download."""

import os
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import lipread  # noqa: E402

FAKE = textwrap.dedent('''
    import json, sys
    def say(**e): print(json.dumps(e), flush=True)
    say(ready=True)
    on = False
    session = 0
    for line in sys.stdin:
        msg = json.loads(line)
        if msg["command"] == "start":
            session = msg["session"]
            on = True; say(camera="on", session=session)
            say(partial="open", final=False, session=session)
            say(text="STALE", final=True, session=session-1)
        elif msg["command"] == "stop" and on:
            on = False; say(camera="off", session=session)
            say(session=session, **({"error": "camera denied"} if "FAIL" in sys.argv else {"text": " open safari "}))
''')


class LipReadTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lips-")
        env = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.dir, "LIPREAD_DIR": self.dir + "/lipread"})
        env.start()
        self.addCleanup(env.stop)
        self.worker = os.path.join(self.dir, "worker.py")
        with open(self.worker, "w") as f:
            f.write(FAKE)

    def reader(self, *extra):
        events = []
        reader = lipread.LipReader([sys.executable, self.worker, *extra], cwd=self.dir, on_event=events.append)
        self.addCleanup(reader.close)
        return reader, events

    def test_camera_only_between_start_and_stop(self):
        reader, events = self.reader()
        reader.start()
        self.assertEqual(reader.stop(timeout=10), "open safari")
        self.assertIn({"camera": "on", "session": 1}, events)
        self.assertIn({"camera": "off", "session": 1}, events)
        self.assertIn({"partial": "open", "final": False, "session": 1}, events)
        self.assertFalse(any(e.get("text") == "STALE" for e in events))
        self.assertEqual(reader.stop(), "")  # not recording: nothing to read
        reader.start()  # and again, the model loaded once
        self.assertEqual(reader.stop(timeout=10), "open safari")

    def test_a_failure_says_why(self):
        reader, _ = self.reader("FAIL")
        reader.start()
        with self.assertRaisesRegex(lipread.LipReaderError, "camera denied"):
            reader.stop(timeout=10)

    def test_voice_is_the_default_and_the_choice_is_kept(self):
        self.assertEqual(lipread.get_mode(), "voice")
        lipread.set_mode("lips")
        self.assertEqual(lipread.get_mode(), "lips")
        with self.assertRaises(ValueError):
            lipread.set_mode("telepathy")

    def test_not_set_up_says_how(self):
        ok, why = lipread.available()
        self.assertFalse(ok)
        self.assertIn("setup-lipread.sh", why)


if __name__ == "__main__":
    unittest.main()
