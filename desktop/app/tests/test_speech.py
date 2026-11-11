"""Checks python/speech.py: splitting text, making audio with Kokoro (when models/ has it),
stopping mid-sentence, waiting for you to finish talking, and falling back to the Mac's voice. Nothing is
played aloud.

    .venv/bin/python tests/test_speech.py
"""

import os
import subprocess
import sys
import time
import unittest
import wave
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import speech  # noqa: E402

try:
    import kokoro_onnx  # noqa: F401
    HAVE_KOKORO = os.path.exists(speech.MODEL)
except ImportError:
    HAVE_KOKORO = False


class Silent(speech.Voice):
    """Records what it would play, and spends as long on each sentence as playing it would take."""

    def __init__(self, **kwargs):
        self.played: list[float] = []  # seconds of each sentence
        super().__init__(**kwargs)

    def _start(self, command):
        seconds = 1.0
        if command[0] == "afplay":
            with wave.open(command[1]) as w:
                seconds = w.getnframes() / w.getframerate()
        self.played.append(seconds)
        return subprocess.Popen(["sleep", str(seconds)])


class SpeechTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("TTS_VOICE", None)
        os.environ.pop("TTS_SPEED", None)

    def test_sentences(self):
        self.assertEqual(speech.sentences("Done. I opened Calculator: it shows 408. Anything else?"),
                         ["Done. I opened Calculator:", "it shows 408.", "Anything else?"])
        self.assertEqual(speech.sentences("The first line here\n\nAnother line"), ["The first line here", "Another line"])
        self.assertEqual(speech.sentences("Short\nThen a longer one"), ["Short Then a longer one"])
        self.assertEqual(speech.sentences("  "), [])

    @unittest.skipUnless(HAVE_KOKORO, "needs .venv and the model in models/ (./voice.sh sets both up)")
    def test_kokoro_speaks_sentence_by_sentence(self):
        voice = Silent()
        self.assertEqual(voice.describe(), "Kokoro (af_heart)")
        voice.say("Done. I opened Calculator and worked it out. Twelve times thirty-four is four hundred and eight.")
        self.assertTrue(voice.wait(60))
        self.assertEqual(len(voice.played), 2)
        self.assertGreater(sum(voice.played), 3)
        self.assertLess(sum(voice.played), 12)

    @unittest.skipUnless(HAVE_KOKORO, "needs .venv and the model in models/ (./voice.sh sets both up)")
    def test_stop_drops_the_rest(self):
        voice = Silent()
        voice.describe()
        voice.say("This is the first sentence, and it goes on for a little while. This one should never be heard. "
                  "Nor this one.")
        deadline = time.time() + 30
        while not voice.played and time.time() < deadline:
            time.sleep(0.05)
        voice.stop()
        self.assertTrue(voice.wait(30))
        self.assertEqual(len(voice.played), 1)
        voice.say("Talking again works.")  # a new generation
        self.assertTrue(voice.wait(30))
        self.assertEqual(len(voice.played), 2)

    @unittest.skipUnless(HAVE_KOKORO, "needs .venv and the model in models/ (./voice.sh sets both up)")
    def test_it_waits_for_you_to_finish_talking(self):
        you_talking = [True]
        voice = Silent(may_speak=lambda: not you_talking[0])
        voice.describe()
        voice.say("Something to say once you're done.")
        self.assertFalse(voice.wait(2))
        self.assertEqual(voice.played, [])
        you_talking[0] = False
        self.assertTrue(voice.wait(30))
        self.assertEqual(len(voice.played), 1)

    @unittest.skipUnless(HAVE_KOKORO, "needs .venv and the model in models/ (./voice.sh sets both up)")
    def test_audible_while_playing_and_a_moment_after(self):
        voice = Silent()
        voice.describe()
        self.assertFalse(voice.audible())
        voice.say("Short and sweet.")
        deadline = time.time() + 30
        while not voice.played and time.time() < deadline:
            time.sleep(0.02)
        time.sleep(0.05)  # the player has been handed back and kept
        self.assertTrue(voice.audible())
        self.assertTrue(voice.wait(30))
        self.assertTrue(voice.audible())  # the room is still echoing
        time.sleep(speech.ECHO + 0.1)
        self.assertFalse(voice.audible())

    def test_falls_back_to_the_macs_voice(self):
        with mock.patch.object(speech, "MODEL", "/nonexistent/kokoro.onnx"):
            voice = Silent()
            self.assertIn("the Mac's voice", voice.describe())
        os.environ["TTS_VOICE"] = "say"
        self.assertEqual(Silent().describe(), "the Mac's voice")

    @unittest.skipUnless(HAVE_KOKORO, "needs .venv and the model in models/ (./voice.sh sets both up)")
    def test_unknown_voice(self):
        os.environ["TTS_VOICE"] = "nobody"
        self.assertIn("no voice 'nobody'", Silent().describe())


if __name__ == "__main__":
    unittest.main(verbosity=2)
