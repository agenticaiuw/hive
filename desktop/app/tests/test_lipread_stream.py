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

    def test_empty_session_finishes_without_decoding(self):
        events=[]
        stream=Stream(lambda *a, **k: self.fail('empty decode'), lambda **e: events.append(e))
        stream.finish()
        self.assertTrue(stream.done.wait(2))
        self.assertEqual(events, [{'text':'', 'final':True}])

if __name__ == '__main__': unittest.main()
