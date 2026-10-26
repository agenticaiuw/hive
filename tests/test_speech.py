"""Checks python/speech.py: splitting text, making audio with Kokoro (when models/ has it),
stopping mid-sentence, and falling back to the Mac's voice. Nothing is played aloud.

    .venv/bin/python tests/test_speech.py
"""

import os
import sys
import time
import unittest
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
    """Records what it would play instead of playing it."""

    def __init__(self):
        self.played = []
        super().__init__()

    def _play(self):
        while True:
            generation, samples = self._audio.get()
            if samples is None:
                self._done()
            elif generation == self._generation:
                self.played.append(samples)
                time.sleep(len(samples) / 24000)  # as long as it takes to hear


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
        seconds = sum(len(s) for s in voice.played) / 24000
        self.assertGreater(seconds, 3)
        self.assertLess(seconds, 12)

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
