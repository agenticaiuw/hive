"""Checks scripts/lipgaze.py without the lip model or a camera: the gaze scoring against a brute-force
alignment, and the fused search with a stand-in lip model that can't tell p, b and m apart.

    uv run --with numpy python tests/test_lipgaze.py
"""
import itertools
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import lipgaze  # noqa: E402
from lipgaze import CENTERS, GazeScorer, GazeSettings, fused_search, key_path  # noqa: E402


def swipe(text, noise, rng, per_key=5, shift=(0.0, 0.0)):
    """A made-up gaze path: a few samples near each key of the text (the fixation missing by `noise`
    keys, then jitter), a couple of samples on the way between."""
    out, last = [], None
    for k in key_path(text):
        aim = CENTERS[k] + np.asarray(shift) + rng.normal(0, 0.7 * noise, 2)
        if last is not None:
            out.append(tuple((last + aim) / 2))
        for _ in range(per_key):
            out.append(tuple(aim + rng.normal(0, 0.5 * noise, 2)))
        last = aim
    return out


def brute_force(scorer, keys):
    """The finished score by trying every way to split the samples: some anywhere, then each key in turn
    for at least `dwell` samples, then the rest anywhere."""
    T, d, e = scorer.T, scorer.s.dwell, scorer.emit
    best = -math.inf
    for cuts in itertools.combinations(range(T + 1), len(keys) + 1):
        lead, ends = cuts[0], cuts[1:]
        starts = (lead,) + ends[:-1]
        if any(b - a < d for a, b in zip(starts, ends)):
            continue
        v = scorer.anywhere * lead + scorer.anywhere * (T - ends[-1])
        for k, a, b in zip(keys, starts, ends):
            v += e[a:b, k].sum()
        best = max(best, v)
    return best


class KeyPathTest(unittest.TestCase):
    def test_letters_only_and_repeats_once_across_words(self):
        letters = ''.join(lipgaze.ROWS)
        word = lambda s: ''.join(letters[k] for k in key_path(s))
        self.assertEqual(word("will look"), "wilok")
        self.assertEqual(word("▁DON'T"), "dont")
        self.assertIsNone(key_path("20"))
        self.assertEqual(key_path("▁LOOK", last=lipgaze.KEY['l']), [lipgaze.KEY['o'], lipgaze.KEY['k']])


class GazeScorerTest(unittest.TestCase):
    def test_matches_brute_force(self):
        rng = np.random.default_rng(3)
        for dwell in (1, 2):
            for _ in range(20):
                samples = rng.uniform((0, 0), (10, 3), (int(rng.integers(3, 8)), 2))
                scorer = GazeScorer(samples, GazeSettings(dwell=dwell))
                keys = list(rng.choice(len(CENTERS), int(rng.integers(1, 4))))
                keys = [k for i, k in enumerate(keys) if i == 0 or k != keys[i - 1]]
                want = brute_force(scorer, keys)
                got = scorer.score(keys)
                if want == -math.inf:
                    self.assertEqual(got, -math.inf)
                else:
                    self.assertAlmostEqual(got, want, places=9)

    def test_bound_is_never_below_the_finished_score(self):
        rng = np.random.default_rng(5)
        scorer = GazeScorer(swipe("hello there", 0.9, rng))
        state = scorer.start()
        for piece in ["▁HE", "LL", "O", "▁THERE"]:
            state = scorer.extend(state, key_path(piece))
            self.assertGreaterEqual(scorer.bound(state) + 1e-9, scorer.final(state))

    def test_extending_piece_by_piece_equals_the_whole_path(self):
        rng = np.random.default_rng(6)
        scorer = GazeScorer(swipe("can you send", 0.8, rng))
        state, last = scorer.start(), None
        for piece in ["▁CAN", "▁YOU", "▁SE", "ND"]:
            keys = key_path(piece, last)
            state = scorer.extend(state, keys)
            last = keys[-1] if keys else last
        self.assertAlmostEqual(scorer.final(state), scorer.score(key_path("can you send")), places=9)

    def test_rough_swipe_tells_lip_lookalikes_apart(self):
        """p, b and m look the same on the lips and sit far apart on the keyboard."""
        rng = np.random.default_rng(1)
        right = 0
        for _ in range(50):
            scorer = GazeScorer(swipe("pat", 0.86, rng))
            scores = {w: scorer.score(key_path(w)) for w in ("pat", "bat", "mat")}
            right += max(scores, key=scores.get) == "pat"
        self.assertGreaterEqual(right, 45)

    def test_best_shift_finds_the_drift(self):
        rng = np.random.default_rng(2)
        scorer = GazeScorer(swipe("tomorrow afternoon", 0.3, rng, shift=(0.75, 0.5)))
        _, (sx, sy) = scorer.best_shift(key_path("tomorrow afternoon"))
        self.assertAlmostEqual(sx, 0.75, delta=0.3)
        self.assertAlmostEqual(sy, 0.5, delta=0.3)


class StandInLips:
    """Whole words as pieces. It reads 'the' then a word it can't tell apart from its look-alikes
    (bat/pat/mat all equally likely but 'bat' a little more), then stops."""

    def __init__(self, lookalikes=("▁BAT", "▁PAT", "▁MAT"), first="▁THE"):
        self.units = ["<blank>", "<unk>", "▁THE", "▁A", "▁BAT", "▁PAT", "▁MAT", "▁DOG", "2", "<eos>"]
        self.eos = len(self.units) - 1
        self.first, self.lookalikes = first, lookalikes

    def start(self, features):
        return [[]], None

    def step(self, ys, features, cache):
        out = np.full((len(ys), len(self.units)), math.log(1e-4))
        for b, y in enumerate(ys):
            if len(y) == 0:
                out[b, self.units.index(self.first)] = math.log(0.9)
            elif len(y) == 1:
                for i, u in enumerate(self.lookalikes):
                    out[b, self.units.index(u)] = math.log(0.32 if i else 0.34)
            else:
                out[b, self.eos] = math.log(0.95)
        out -= np.log(np.exp(out).sum(1, keepdims=True))
        return out, cache

    def extend(self, ys, parents, tokens, cache):
        return [ys[p] + [t] for p, t in zip(parents, tokens)], cache

    def words(self, ids):
        return ' '.join(self.units[i].strip('▁').lower() for i in ids)


class FusedSearchTest(unittest.TestCase):
    def test_eyes_pick_among_what_the_lips_allow(self):
        rng = np.random.default_rng(4)
        lips = StandInLips()
        fused_right = alone_right = 0
        for _ in range(30):
            scorer = GazeScorer(swipe("the pat", 0.86, rng))
            alone = fused_search(lips, None, scorer, use_gaze=False)
            fused = fused_search(lips, None, scorer)
            alone_right += alone[0][0] == "the pat"
            fused_right += fused[0][0] == "the pat"
        self.assertEqual(alone_right, 0)           # the lips alone always say "the bat"
        self.assertGreaterEqual(fused_right, 27)

    def test_untypable_pieces_never_come_out(self):
        lips = StandInLips(lookalikes=("2", "▁PAT", "▁MAT"))
        scorer = GazeScorer(swipe("the pat", 0.5, np.random.default_rng(8)))
        for text, _, _ in fused_search(lips, None, scorer, use_gaze=False):
            self.assertNotIn("2", text)

    def test_no_gaze_still_reads_the_lips(self):
        lips = StandInLips()
        got = fused_search(lips, None, GazeScorer([]))
        self.assertEqual(got[0][0], "the bat")


class SpeakingTest(unittest.TestCase):
    def test_cuts_to_the_moving_mouth_with_a_margin(self):
        openings = [0.05] * 40 + [0.3] * 30 + [0.05] * 40
        self.assertEqual(lipgaze.speaking(openings, 30), (25, 85))
        self.assertIsNone(lipgaze.speaking([0.05] * 60, 30))


class CtcPrefixTest(unittest.TestCase):
    def brute(self, x, labels, blank=0):
        """ln P(labels | frames) summing every frame-by-frame path that collapses to the labels."""
        T, V = x.shape
        total = -math.inf
        for path in itertools.product(range(V), repeat=T):
            out = [p for i, p in enumerate(path) if p != blank and (i == 0 or p != path[i - 1])]
            if out == list(labels):
                total = np.logaddexp(total, sum(x[t, p] for t, p in enumerate(path)))
        return total

    def test_matches_every_alignment(self):
        rng = np.random.default_rng(11)
        for _ in range(5):
            x = rng.normal(0, 1.5, (5, 3))
            x -= np.log(np.exp(x).sum(1, keepdims=True))
            ctc = lipgaze.CtcPrefix(x)
            for labels in ([1], [1, 2], [2, 2], [1, 2, 1]):
                state = ctc.start()
                for c in labels:
                    state = ctc.extend([state], [c])[0]
                want = self.brute(x, labels)
                self.assertAlmostEqual(ctc.final(state), want, places=9)
                self.assertGreaterEqual(state[2] + 1e-9, want)     # these pieces, then anything or nothing

    def test_the_search_stops_where_the_frames_say(self):
        """A decoder that would happily go on; CTC frames that only hold 'the bat'."""
        lips = StandInLips()
        T, V = 12, len(lips.units)
        x = np.full((T, V), math.log(1e-6))
        x[:, 0] = 0
        x[2, lips.units.index("▁THE")] = 0
        x[7, lips.units.index("▁PAT")] = 0
        x -= np.log(np.exp(x).sum(1, keepdims=True))
        lips.ctc_prefix = lambda features: lipgaze.CtcPrefix(x)
        lips.ctc_weight = 0.5
        got = fused_search(lips, None, GazeScorer([]))
        self.assertEqual(got[0][0], "the pat")


class AtFpsTest(unittest.TestCase):
    def test_thirty_to_twenty_five(self):
        times = np.arange(31) / 30
        out = lipgaze.at_fps(times, list(range(31)))
        self.assertEqual(len(out), 26)
        self.assertEqual(out[0], 0)
        self.assertEqual(out[-1], 30)
        self.assertEqual(len(set(out)), 26)


class CutterTest(unittest.TestCase):
    def feed(self, cutter, openings):
        parts = []
        for i, o in enumerate(openings):
            part = cutter.feed(i / 30, f"crop{i}", o)
            if part:
                parts.append((part[0][1], part[-1][1]))
        return parts

    def test_cuts_like_the_offline_cut_once_the_mouth_has_stopped(self):
        openings = [0.05] * 40 + [0.3] * 30 + [0.05] * 40
        self.assertEqual(self.feed(lipgaze.Cutter(30), openings), [("crop25", "crop84")])

    def test_short_closures_stay_in_one_sentence_and_twitches_are_dropped(self):
        talk = [0.3] * 20 + [0.05] * 8 + [0.3] * 20           # lips shut for a quarter second mid-sentence
        twitch = [0.05] * 40 + [0.3] * 3 + [0.05] * 40
        parts = self.feed(lipgaze.Cutter(30), [0.05] * 40 + talk + [0.05] * 40 + twitch)
        self.assertEqual(parts, [("crop25", "crop102")])

    def test_two_sentences_and_finish(self):
        cutter = lipgaze.Cutter(30)
        parts = self.feed(cutter, [0.05] * 30 + [0.3] * 20 + [0.05] * 30 + [0.3] * 20)
        self.assertEqual(len(parts), 1)
        last = cutter.finish()
        self.assertEqual((last[0][1], last[-1][1]), ("crop65", "crop99"))
        self.assertIsNone(cutter.finish())

    def test_long_talk_is_cut_at_the_longest(self):
        parts = self.feed(lipgaze.Cutter(30, longest=4), [0.05] * 20 + [0.3] * 200)
        self.assertGreaterEqual(len(parts), 1)
        self.assertLessEqual(len(parts), 2)


class StandInMouth:
    """In place of the face mesh: the frame's mean brightness says how open the mouth is."""

    def __init__(self):
        self.opening = None

    def __call__(self, bgr):
        self.opening = float(bgr.mean()) / 255
        return np.zeros((88, 88), np.uint8)


class ServerTest(unittest.TestCase):
    def test_frames_and_gaze_in_a_sentence_out(self):
        import io
        import json

        class Lips(StandInLips):
            def encode(self, crops):
                return len(crops)

        rng = np.random.default_rng(9)
        stream = io.BytesIO()
        path = swipe("the pat", 0.6, rng, per_key=6)
        t = 0.0
        frames = [12] * 40 + [77] * 45 + [12] * 40       # 0.05 and 0.3 of 255
        for i, level in enumerate(frames):
            t = i / 30
            stream.write(json.dumps({"frame": {"t": t, "w": 4, "h": 2}}).encode() + b"\n")
            stream.write(bytes([level]) * 8)
            if 40 <= i < 40 + len(path):
                x, y = path[i - 40]
                stream.write(json.dumps({"gaze": [t, x, y]}).encode() + b"\n")
        stream.write(b"not json\n")
        stream.write(json.dumps({"on": False}).encode() + b"\n")
        stream.seek(0)
        out = io.StringIO()
        server = lipgaze.Server(Lips(), out)
        server.crops = StandInMouth()
        server.listen(stream)
        server.run()
        said = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([m["text"] for m in said], ["the pat"])
        self.assertEqual(said[0]["gaze_points"], len(path))

    def test_record_keeps_each_take(self):
        import io
        import json
        import tempfile

        class Lips(StandInLips):
            def encode(self, crops):
                return len(crops)

        with tempfile.TemporaryDirectory() as folder:
            stream = io.BytesIO()
            for i, level in enumerate([12] * 40 + [77] * 30 + [12] * 40):
                stream.write(json.dumps({"frame": {"t": i / 30, "w": 2, "h": 2}}).encode() + b"\n")
                stream.write(bytes([level]) * 4)
            stream.seek(0)
            out = io.StringIO()
            server = lipgaze.Server(Lips(), out, record=folder, prompts=["The bat!"])
            server.crops = StandInMouth()
            server.listen(stream)
            server.run()
            said = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(said[0], {"prompt": "The bat!"})
            result = said[1]["result"]
            self.assertEqual((result["meant"], result["lips"], result["wrong"]["lips"]), ("the bat", "the bat", 0))
            take = np.load(Path(folder) / "0000.npz")
            self.assertEqual(take["crops"].shape[1:], (88, 88))
            self.assertEqual(str(take["meant"]), "The bat!")


if __name__ == "__main__":
    unittest.main()
