"""Task recordings: the timeline and subtitles line up with the video; nothing is really recorded."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import task_recording


class FakeProc:
    def __init__(self, *a, **kw):
        self.returncode = None
    def poll(self):
        return self.returncode
    def send_signal(self, _):
        self.returncode = 0
    def wait(self, timeout=None):
        return 0
    def kill(self):
        self.returncode = -9


class RecordingTest(unittest.TestCase):
    def test_timeline_keeps_the_request_and_lines_up_with_the_video(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, HIVE_RECORDINGS=root), \
                patch("task_recording.subprocess.Popen", FakeProc), \
                patch("task_recording.front_window", return_value=("Safari", "WIN")), \
                patch("task_recording.idle_seconds", return_value=30.0), \
                patch("task_recording.video_length", return_value=1.5):
            finished = []
            r = task_recording.Recorder(running=lambda: True, engaged=lambda: True, title=lambda: "Fill the form!",
                                        cursor=lambda: (10.4, 20.6), on_finished=finished.append, start_thread=False)
            r.event("hive", "🗣  Fill the form!")  # before the recording starts: kept
            r.start()
            r.event("status", "Clicking")
            r.event("hive", "   → click(x=1, y=2)")
            time.sleep(0.05)
            r.stop()
            folder = finished[0]
            self.assertTrue(folder.name.endswith("Fill the form"))
            lines = [json.loads(x) for x in (folder / "timeline.jsonl").read_text().splitlines()]
            kinds = [x["kind"] for x in lines]
            self.assertEqual(kinds[0], "recording")
            self.assertIn("mac", kinds)
            mac = next(x for x in lines if x["kind"] == "mac")
            self.assertEqual((mac["front_app"], mac["control"], mac["cursor"], mac["someone_touching"]),
                             ("Safari", "agent", [10, 20], False))
            self.assertTrue(any(x.get("text") == "🗣  Fill the form!" for x in lines))
            self.assertTrue(all("video" in x and "t" in x for x in lines))
            srt = (folder / "screen.srt").read_text()
            self.assertIn("Hive: → click(x=1, y=2)", srt)
            self.assertIn("Mac: Safari — WIN · agent has mouse & keyboard", srt)
            self.assertEqual(json.loads((folder / "meta.json").read_text())["videoSeconds"], 1.5)

    def test_srt_times(self):
        self.assertEqual(task_recording._srt_time(3725.5), "01:02:05,500")


if __name__ == "__main__":
    unittest.main()
