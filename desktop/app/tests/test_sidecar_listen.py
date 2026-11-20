"""The dictation socket's {"listen": true}: another program (Hive's Safari popup, through Hive.app)
hears you the way the floating window does, live, and the agent hears none of it.

    .venv/bin/python -m unittest tests/test_sidecar_listen.py

No models: a stand-in for listen.Ears takes the place of the microphone and Parakeet.
"""

from __future__ import annotations

import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import sidecar_voice  # noqa: E402


class FakeEars:
    """listen.Ears' part the server uses: listening, listen(), cut(then), talking."""

    def __init__(self, listening=False):
        self.listening = listening
        self.talking = False
        self.model = object()
        self.error = None
        self.heard_times = {}
        self.cuts = []
        self.server = None

    def listen(self, on):
        self.listening = on

    def cut(self, then=None):
        self.cuts.append(then)
        if then:  # the transcribing thread runs it after what was heard
            threading.Thread(target=then, daemon=True).start()

    # what you'd say
    def say(self, *drafts, final):
        self.server.on_speech()
        for draft in drafts:
            self.server.on_text(draft, False)
        self.server.on_text(final, True)


class ListenTest(unittest.TestCase):
    def setUp(self):
        self.out = io.StringIO()
        self.server = sidecar_voice.Server(self.out)
        self.ears = FakeEars()
        self.ears.server = self.server
        self.server.ears = self.ears
        self.folder = tempfile.mkdtemp()
        self.path = os.path.join(self.folder, "dictation.sock")
        self.server.serve_dictation(self.path)

    def tearDown(self):
        self.server.quitting.set()

    def events(self):
        return [json.loads(line) for line in self.out.getvalue().splitlines()]

    def connect(self):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(5)
        conn.connect(self.path)
        conn.sendall(b'{"listen": true}\n')
        reader = conn.makefile("r")
        self.assertEqual(json.loads(reader.readline()), {"state": "listening"})
        return conn, reader

    def test_it_gets_the_words_as_you_say_them_and_the_agent_gets_none(self):
        conn, reader = self.connect()
        self.assertTrue(self.ears.listening)
        self.ears.say("make sure", "make sure it works", final="Make sure it works in full screen.")
        lines = [json.loads(reader.readline()) for _ in range(3)]
        self.assertEqual(lines, [{"draft": "make sure"}, {"draft": "make sure it works"},
                                 {"text": "Make sure it works in full screen.", "done": True}])
        self.assertEqual(reader.readline(), "")  # and it's over
        conn.close()
        kinds = [e["event"] for e in self.events()]
        self.assertNotIn("text", kinds)
        self.assertNotIn("speech", kinds)  # talking to the popup isn't a cut-in
        self.assertFalse(self.ears.listening)  # the agent wasn't listening, so the ears close again

    def test_the_agent_listening_before_goes_on_listening_after(self):
        self.ears.listening = True
        conn, reader = self.connect()
        self.server.handle({"cmd": "listen", "on": False})  # the agent asks meanwhile...
        self.assertTrue(self.ears.listening)  # ...but the popup has the ears
        self.server.handle({"cmd": "listen", "on": True})
        self.ears.say(final="Hello.")
        self.assertEqual(json.loads(reader.readline())["text"], "Hello.")
        self.assertTrue(self.ears.listening)
        self.ears.say(final="Now for the agent.")
        texts = [e for e in self.events() if e["event"] == "text"]
        self.assertEqual(texts[-1]["text"], "Now for the agent.")
        conn.close()

    def test_stop_ends_it_with_what_was_heard(self):
        conn, reader = self.connect()
        self.server.on_speech()
        self.server.on_text("open my", False)
        self.assertEqual(json.loads(reader.readline()), {"draft": "open my"})
        conn.sendall(b'{"stop": true}\n')
        self.assertEqual(json.loads(reader.readline()), {"text": "", "done": True})
        self.assertEqual(len(self.ears.cuts), 1)

    def test_hanging_up_cancels_and_nothing_reaches_the_agent(self):
        conn, reader = self.connect()
        self.server.on_speech()
        reader.close()  # (the socket stays open while its file is)
        conn.close()
        deadline = time.monotonic() + 3
        while self.server._listener is not None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertIsNone(self.server._listener)
        self.assertFalse(self.ears.listening)
        self.assertNotIn("text", [e["event"] for e in self.events()])

    def test_it_stops_if_you_never_start_talking(self):
        old = sidecar_voice.LISTEN_FOR_START
        sidecar_voice.LISTEN_FOR_START = 0.3
        try:
            conn, reader = self.connect()
            self.assertEqual(json.loads(reader.readline()), {"text": "", "done": True})
        finally:
            sidecar_voice.LISTEN_FOR_START = old
        conn.close()

    def test_a_second_listener_takes_over_from_the_first(self):
        first, first_reader = self.connect()
        second, second_reader = self.connect()
        self.assertEqual(json.loads(first_reader.readline()), {"text": "", "done": True})
        self.ears.say(final="For the second.")
        self.assertEqual(json.loads(second_reader.readline())["text"], "For the second.")
        first.close()
        second.close()

    def test_a_recording_still_reads_as_before(self):
        self.server.dictate = lambda path: f"read {path}"
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(5)
        conn.connect(self.path)
        conn.sendall(b'{"wav": "/tmp/x.wav"}\n')
        self.assertEqual(json.loads(conn.makefile("r").readline()), {"text": "read /tmp/x.wav"})
        conn.close()


if __name__ == "__main__":
    unittest.main()
