"""Recording and fitting the lip reader to your own face, without a camera or the model."""
import sys
import tempfile
import time
from pathlib import Path
import unittest

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import lipread_personal as personal
from lipread_usr2 import add_personal, pieces

REST, TALK = 0.08, 0.3   # the inner lips' gap over the mouth's width


class PlausibleTest(unittest.TestCase):
    def test_a_take_cut_at_a_pause_is_too_short_for_its_sentence(self):
        said = 'send a message to my mom saying i will be home late'   # 12 words
        self.assertIn('cut short', personal.plausible(int(2.4 * 25), said))   # 1.4 s of talk
        self.assertIsNone(personal.plausible(int(4.5 * 25), said))
        self.assertIn('too long', personal.plausible(20 * 25, said))

    def test_every_tenth_sentence_is_held_out(self):
        self.assertEqual([i for i in range(30) if personal.held_out(i)], [9, 19, 29])


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.where = Path(self.dir.name) / 'personal' / 'sentences'
        self.lines = ['open the door', 'close the window please', 'turn it up']
        self.session = personal.Session(self.where, self.lines)

    def tearDown(self):
        self.session.cutter.cancel()
        self.dir.cleanup()

    def say(self, seconds):
        """Lips moving for `seconds`, then still long enough to end the take; the take's verdict."""
        for opening in [REST] * 10 + [TALK] * int(seconds * 25) + [REST] * 30:
            self.session.feed(np.full((88, 88), 7, np.uint8), opening)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            verdict = self.session.poll()
            if verdict is not None:
                return verdict
            time.sleep(0.01)
        self.fail('no take')

    def test_takes_are_kept_as_the_sentence_on_screen_and_the_next_comes_up(self):
        self.assertTrue(self.say(1.2))
        saved = personal.load(self.where)
        self.assertEqual([(t['index'], t['text']) for t in saved], [(0, 'open the door')])
        self.assertEqual(saved[0]['crops'].shape[1:], (88, 88))
        self.assertEqual(self.session.index, 1)
        self.assertEqual(self.session.recorded(), 1)

    def test_a_take_too_short_for_the_sentence_is_not_kept(self):
        self.session.index = 1
        self.assertFalse(self.say(0.3))
        self.assertIn('cut short', self.session.message)
        self.assertEqual(self.session.recorded(), 0)
        self.assertEqual(self.session.index, 1)

    def test_redo_and_skip(self):
        self.assertTrue(self.say(1.2))
        self.session.redo()
        self.assertEqual((self.session.index, self.session.recorded()), (0, 0))
        self.session.skip()
        self.assertEqual(self.session.index, 1)

    def test_a_new_session_carries_on_where_the_last_stopped(self):
        self.assertTrue(self.say(1.2))
        again = personal.Session(self.where, self.lines)
        self.addCleanup(again.cutter.cancel)
        self.assertEqual(again.index, 1)


class TrainingPartsTest(unittest.TestCase):
    def test_pieces_are_the_fewest_that_spell_each_word(self):
        units = ['<blank>', '<unk>', "'", 'S', 'T', 'H', 'E', '▁', '▁WHAT', '▁THE', '▁TH']
        self.assertEqual([units[i] for i in pieces("What's the", units)], ['▁WHAT', "'", 'S', '▁THE'])
        self.assertEqual([units[i] for i in pieces('thee', units)], ['▁THE', 'E'])

    def test_augmented_takes_keep_their_crop_and_round_to_eight_frames(self):
        crops = np.random.default_rng(1).integers(0, 255, (75, 88, 88), dtype=np.uint8)
        out = personal.augment(crops, np.random.default_rng(2))
        self.assertEqual(out.shape, (72, 88, 88))
        self.assertEqual(out.dtype, np.uint8)

    def test_the_saved_adapter_merged_reads_the_same_as_while_training(self):
        import torch

        class Attention(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.linear_q, self.linear_v = torch.nn.Linear(6, 6), torch.nn.Linear(6, 6)

            def forward(self, x):
                return self.linear_q(x) + self.linear_v(x)

        def tiny():
            torch.manual_seed(0)
            model = torch.nn.Module()
            model.encoder = torch.nn.Module()
            model.encoder.frontend_v = torch.nn.Linear(6, 6)
            model.attention = Attention()
            return model

        x = torch.randn(3, 6)
        trained = tiny()
        layers = personal.add_lora(trained, rank=2, alpha=4)
        with torch.no_grad():
            for layer in layers.values():
                layer.b.normal_()
            trained.encoder.frontend_v.weight.add_(1)
        want = trained.attention(trained.encoder.frontend_v(x))
        saved = {'lora': {name: {'a': l.a.detach(), 'b': l.b.detach(), 'scale': l.scale} for name, l in layers.items()},
                 'frontend': trained.encoder.frontend_v.state_dict()}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'adapter.pt'
            torch.save(saved, path)
            fresh = tiny()
            add_personal(fresh, path)
        got = fresh.attention(fresh.encoder.frontend_v(x))
        self.assertTrue(torch.allclose(got, want, atol=1e-5))


if __name__ == '__main__':
    unittest.main()
