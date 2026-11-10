"""The session journal (python/session_journal.py), in a temporary folder: no app, mic or audio."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import session_journal  # noqa: E402


class JournalTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="journal-")
        env = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.dir, "CODEX_HOME": self.dir})
        env.start()
        self.addCleanup(env.stop)

    def test_each_line_is_on_disk_as_soon_as_it_happens(self):
        journal = session_journal.SessionJournal({"backend": "test"})
        journal.add("you said", "Open Safari.", outcome="request")
        lines = (journal.dir / "journal.jsonl").read_text().splitlines()  # before end(): a crash keeps it
        self.assertEqual(json.loads(lines[-1])["text"], "Open Safari.")
        self.assertEqual(oct((journal.dir / "journal.jsonl").stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(journal.dir.stat().st_mode & 0o777), "0o700")
        journal.end()

    def test_a_line_cut_off_by_a_crash_is_skipped(self):
        journal = session_journal.SessionJournal()
        journal.add("you said", "one")
        with open(journal.dir / "journal.jsonl", "a") as f:
            f.write('{"time": 1, "kind": "you sa')
        self.assertEqual([e["text"] for e in session_journal.read(journal.dir)][-1], "one")

    def test_threads_point_to_codex_s_full_context(self):
        rollout = Path(self.dir, "sessions/2026/11/08/rollout-2026-11-08T21-18-56-abc123.jsonl")
        rollout.parent.mkdir(parents=True)
        rollout.write_text("{}\n")
        journal = session_journal.SessionJournal()
        journal.add("done", "ok", thread="abc123")
        journal.add("done", "again", thread="abc123")
        manifest = json.loads((journal.dir / "manifest.json").read_text())
        self.assertEqual(manifest["threads"], [{"thread": "abc123", "rollout": str(rollout)}])

    def test_a_journal_that_cant_be_written_doesnt_stop_the_agent(self):
        journal = session_journal.SessionJournal()
        journal._journal.close()
        journal.add("you said", "still fine")  # no exception
        self.assertIn("closed", journal.error)

    def test_reading_it(self):
        journal = session_journal.SessionJournal({"backend": "test"})
        journal.add("you said", "What time is it?", outcome="request")
        journal.add("say", "It's 9:30.", device="mac")
        journal.end()
        for command in (["list"], ["show"], ["show", journal.id[:8]], ["paths"]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(session_journal.main(command), 0)
            self.assertTrue(out.getvalue())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            session_journal.main(["show"])
        self.assertIn("🗣 you said: What time is it?", out.getvalue())
        self.assertIn("It's 9:30.", out.getvalue())
        sessions = (Path(self.dir) / "sessions/index.html").read_text()
        self.assertIn(journal.id, sessions)
        self.assertNotIn("<script", (journal.dir / "index.html").read_text())

    def test_html_is_escaped(self):
        journal = session_journal.SessionJournal()
        journal.add("you said", "<script>alert(1)</script>")
        self.assertNotIn("<script>alert", (journal.dir / "index.html").read_text())


if __name__ == "__main__":
    unittest.main()
