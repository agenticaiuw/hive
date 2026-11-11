"""Adding chosen text to the conversation (python/ingest.py), in a temporary folder: no Codex, app or network."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import ingest  # noqa: E402

TRANSCRIPT = "\n\n".join(f"Speaker {i % 3}: this is paragraph {i} of the meeting, about alignment." * 4
                         for i in range(400))


class IngestTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ingest-")
        env = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.dir})
        env.start()
        self.addCleanup(env.stop)

    def test_parts_join_back_to_the_text_and_cut_at_paragraphs(self):
        parts = ingest.split(TRANSCRIPT, 5000)
        self.assertEqual("".join(parts), TRANSCRIPT)
        self.assertTrue(all(len(p) <= 5000 for p in parts))
        self.assertTrue(all(p.endswith("\n\n") for p in parts[:-1]))
        self.assertEqual(ingest.split("x" * 25, 10), ["x" * 10, "x" * 10, "x" * 5])  # no breaks: cut anywhere
        self.assertEqual(ingest.split("short"), ["short"])

    def test_it_is_saved_privately_and_planned(self):
        ing = ingest.prepare("Line one\r\nline two\x00", "Notes")
        self.assertEqual(Path(ing.path).read_text(), "Line one\nline two")
        self.assertEqual(oct(Path(ing.path).stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(Path(ing.path).parent.stat().st_mode & 0o777), "0o700")
        self.assertTrue(ing.inline)
        about = json.loads(Path(ing.path).with_suffix(".json").read_text())
        self.assertEqual(about["parts"], 1)
        with self.assertRaises(ValueError):
            ingest.prepare("   \n ")

    def test_a_long_transcript_is_read_on_demand_not_stuffed_in(self):
        big = TRANSCRIPT * 4  # ~ 110k tokens
        ing = ingest.prepare(big, "Project Hivemind Alignment Meeting")
        self.assertFalse(ing.inline)
        (mark, prompt), = ingest.prompts(ing)
        self.assertIn("read_ingested", prompt)
        self.assertIn(ing.id, prompt)
        self.assertLess(len(prompt), 3000)
        self.assertIn(f"part 2/{len(ing.parts)}", ingest.read_part(ing.id, 2))
        self.assertEqual(ingest.read_part(ing.id, 2).split("\n", 1)[1], ing.parts[1])
        self.assertIn("has parts 1 to", ingest.read_part(ing.id, 999))
        self.assertIn("No saved text", ingest.read_part("../etc/passwd", 1))
        self.assertIn(ing.id, ingest.read_part("", 1))  # the latest

    def test_each_part_is_marked_as_material_not_instructions(self):
        ing = ingest.prepare(TRANSCRIPT[:30000], "Meeting")
        turns = ingest.prompts(ing)
        self.assertEqual(len(turns), len(ing.parts))
        for i, (mark, prompt) in enumerate(turns, 1):
            self.assertTrue(prompt.startswith(mark))
            self.assertIn("not instructions", prompt)
            self.assertIn(ing.parts[i - 1], prompt)

    def send(self, ing, rollout_has, on_session=True, error_at=None):
        rollout = Path(self.dir, "rollout.jsonl")
        rollout.write_text("")
        log, calls = [], []

        def run_turn(prompt):
            calls.append(prompt)
            if error_at is not None and len(calls) == error_at:
                return "t1", on_session, None, "Codex: boom"
            if rollout_has:
                with open(rollout, "a") as f:  # Codex saves the user message, JSON-escaped
                    f.write(json.dumps({"type": "user_message", "text": prompt}) + "\n")
            return "t1", on_session, "Got it.", None
        outcome = ingest.send(ing, run_turn, lambda thread: str(rollout), lambda *a, **k: log.append((a, k)),
                              wait=lambda s: None, verify_for=0)
        return outcome, log, calls

    def test_verified_only_when_it_is_in_codex_s_saved_thread(self):
        ing = ingest.prepare(TRANSCRIPT[:30000], "Meeting")
        outcome, log, calls = self.send(ing, rollout_has=True)
        self.assertEqual(outcome["status"], "verified")
        self.assertEqual(len(calls), len(ing.parts))
        self.assertEqual(log[0][0][0], "ingest started")
        self.assertEqual(log[-1][1]["status"], "verified")
        outcome, log, _ = self.send(ing, rollout_has=False)
        self.assertEqual(outcome["status"], "sent")  # Codex answered, but it isn't in the saved thread
        self.assertIn("not verified", log[-1][0][1])
        outcome, _, _ = self.send(ing, rollout_has=True, on_session=False)
        self.assertEqual(outcome["status"], "sent")  # a side thread isn't the conversation

    def test_it_stops_at_the_first_failure(self):
        ing = ingest.prepare(TRANSCRIPT[:30000], "Meeting")
        outcome, log, calls = self.send(ing, rollout_has=True, error_at=2)
        self.assertEqual(outcome["status"], "failed")
        self.assertEqual(len(calls), 2)
        self.assertIn("boom", log[-1][0][1])

    def test_the_clipboard_tool_says_when_there_is_more(self):
        text = "a" * 20000
        first = ingest.clipboard_slice(text)
        self.assertIn("of 20,000", first)
        self.assertIn("offset=8000", first)
        self.assertEqual(first.split("\n", 1)[1], "a" * 8000)
        last = ingest.clipboard_slice(text, 16000)
        self.assertNotIn("offset=", last)
        self.assertEqual(ingest.clipboard_slice("hi"), "hi")
        self.assertEqual(ingest.clipboard_slice(""), "(the clipboard has no text)")


if __name__ == "__main__":
    unittest.main()
