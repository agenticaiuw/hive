"""Rolling inference lifecycle tests; no model download or camera."""
import sys
from pathlib import Path
import threading
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lipread_stream import Stream, join_overlap


class StreamTest(unittest.TestCase):
    def test_draft_arrives_before_stop_and_final_contains_all_frames(self):
        events, called = [], threading.Event()
        def emit(**e):
            events.append(e)
            if 'partial' in e:
                called.set()
        stream = Stream(lambda frames, final=False: f'read {len(frames)} frames', emit, interval=0.01)
        for i in range(25):
            stream.feed(i)
        self.assertTrue(called.wait(2))
        self.assertFalse(stream.closed)
        self.assertFalse(any(e.get('final') for e in events))
        for i in range(5):
            stream.feed(i)
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events[-1]['text'], 'read 30 frames')
        self.assertTrue(events[-1]['final'])

    def test_cancel_discards_inflight_hypothesis(self):
        entered, release = threading.Event(), threading.Event()
        events = []
        def decode(frames, final=False):
            entered.set(); release.wait(2); return 'stale command'
        stream = Stream(decode, lambda **e: events.append(e))
        for i in range(25): stream.feed(i)
        self.assertTrue(entered.wait(2))
        stream.cancel(); release.set()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events, [])

    def test_slow_model_cannot_grow_unbounded_or_silently_drop_input(self):
        entered, release = threading.Event(), threading.Event()
        events = []
        def decode(frames, final=False):
            entered.set(); release.wait(2); return 'draft'
        stream = Stream(decode, lambda **e: events.append(e), window=2)
        for i in range(25): stream.feed(i)
        self.assertTrue(entered.wait(2))
        for i in range(1000): stream.feed(i)
        self.assertLessEqual(len(stream.frames), 100)
        release.set()
        self.assertTrue(stream.done.wait(2))
        self.assertIn('cannot keep up', events[-1]['error'])

    def test_overlap(self):
        self.assertEqual(join_overlap('please open the browser', 'the browser and search'),
                         'please open the browser and search')
        self.assertEqual(join_overlap('', 'hello'), 'hello')

    def test_stop_refines_the_last_draft_even_without_more_frames(self):
        events, draft = [], threading.Event()
        def emit(**event):
            events.append(event)
            if 'partial' in event: draft.set()
        stream = Stream(lambda frames, final=False: 'final words' if final else 'draft words', emit)
        for i in range(25): stream.feed(i)
        self.assertTrue(draft.wait(2))
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events[-1]['text'], 'final words')

    def test_a_full_window_is_kept_from_the_careful_decode(self):
        # A phrase longer than `whole` is read in windows, joined by text.
        events, kept = [], threading.Event()
        def emit(**event):
            events.append(event)
            if event.get('partial') == 'careful25': kept.set()
        decode = lambda frames, final=False: f"{'careful' if final else 'draft'}{len(frames)}"
        stream = Stream(decode, emit, window=1, overlap=0.2, interval=0.01, whole=1.2)
        for i in range(25): stream.feed(i)
        self.assertTrue(kept.wait(2))
        self.assertEqual(stream.committed, 'careful25')
        for i in range(10): stream.feed(i)
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertIsNone(stream.phrase)
        self.assertEqual(events[-1], {'text': 'careful25 careful15', 'final': True,
                                      'inference_seconds': events[-1]['inference_seconds'],
                                      'video_seconds': 1.4})

    def test_a_phrase_just_past_one_window_is_read_whole_not_joined(self):
        # Five frames per word. Like the real models, a window that starts mid-phrase reads its
        # first word differently ("domain shifts" / "domain shifting"), so a text join repeats it.
        def decode(frames, final=False):
            words = [f'w{frames[i] // 5}' for i in range(0, len(frames), 5)]
            if frames[0]: words[0] += 'ing'
            return ' '.join(words)
        events = []
        stream = Stream(decode, lambda **e: events.append(e), window=1, overlap=0.2, interval=0.01)
        for i in range(40): stream.feed(i)
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events[-1]['text'], 'w0 w1 w2 w3 w4 w5 w6 w7')
        self.assertEqual(events[-1]['video_seconds'], 1.6)

    def test_empty_session_finishes_without_decoding(self):
        events=[]
        stream=Stream(lambda *a, **k: self.fail('empty decode'), lambda **e: events.append(e))
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events, [{'text':'', 'final':True}])

if __name__ == '__main__': unittest.main()
