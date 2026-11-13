"""Your lip-reading data: Parakeet's words as clips, the video frames for a clip, word errors."""
import os
import sys
from pathlib import Path
from types import SimpleNamespace as Token
import unittest
from unittest.mock import patch

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lipread_collect import clip_frames, errors, home, split


def tokens(*timed):
    """("text", start, duration) triples as Parakeet's AlignedTokens."""
    return [Token(text=t, start=s, duration=d) for t, s, d in timed]


class SplitTest(unittest.TestCase):
    def test_a_pause_or_a_sentence_end_starts_a_new_clip(self):
        said = tokens((' open', 0.0, 0.3), (' saf', 0.3, 0.2), ('ari', 0.5, 0.2),
                      (' now', 1.6, 0.3), ('.', 1.9, 0.05), (' then', 2.1, 0.3), (' stop', 2.4, 0.3))
        self.assertEqual(split(said), [
            {'start': 0.0, 'end': 0.7, 'text': 'open safari'},
            {'start': 1.6, 'end': 1.95, 'text': 'now.'},
            {'start': 2.1, 'end': 2.7, 'text': 'then stop'},
        ])

    def test_long_speech_is_cut_between_words(self):
        said = tokens(*[(' word' if i % 2 == 0 else 'ing', i * 0.25, 0.25) for i in range(60)])
        clips = split(said, longest=6.0)
        self.assertGreater(len(clips), 2)
        self.assertTrue(all(c['end'] - c['start'] <= 6.0 for c in clips), clips)
        self.assertTrue(all(w == 'wording' for c in clips for w in c['text'].split()), clips)
        self.assertEqual(sum(len(c['text'].split()) for c in clips), 30)


class FramesTest(unittest.TestCase):
    def test_nearest_frame_to_each_tick_within_the_recording(self):
        times = np.arange(0, 10, 1 / 30) + 0.01  # a 30 fps camera
        index = clip_frames(times, 2.0, 3.0, pad=0.1)
        self.assertEqual(len(index), 30)  # 1.2 s at 25 fps
        ticks = 1.9 + np.arange(30) / 25
        self.assertTrue((np.abs(times[index] - ticks) <= 1 / 60 + 1e-9).all())
        self.assertEqual(clip_frames(times, 0.0, 0.2, pad=0.15)[0], 0)  # nothing before the first frame


class ErrorsTest(unittest.TestCase):
    def test_word_edits(self):
        self.assertEqual(errors('Open Safari, now.', 'open safari now'), (0, 3))
        self.assertEqual(errors('open safari now', 'open the safari'), (2, 3))
        self.assertEqual(errors('open safari', ''), (2, 2))


class HomeTest(unittest.TestCase):
    def test_hives_lip_reading_folder(self):
        with patch.dict(os.environ, {'LIPREAD_DIR': '', 'AGENT_STATE_DIR': '/state'}):
            self.assertEqual(home(), Path('/state/lipread'))
        with patch.dict(os.environ, {'LIPREAD_DIR': '/lips'}):
            self.assertEqual(home(), Path('/lips'))


if __name__ == '__main__':
    unittest.main()
