"""The Agent Context panel's data (python/context_panel.py), from a journal and context records in a
temporary folder: no app, Codex or screen."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import context_panel  # noqa: E402
import session_journal  # noqa: E402
from agent_context import ContextLog  # noqa: E402

PNG = "data:image/png;base64," + "iVBORw0KGgo" * 50


class PanelTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="panel-")
        env = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.dir, "CODEX_HOME": self.dir})
        env.start()
        self.addCleanup(env.stop)
        self.journal = session_journal.SessionJournal({"backend": "test"})
        session_journal.current = self.journal
        self.addCleanup(setattr, session_journal, "current", None)

    def request(self, text):
        self.journal.add("you said", text, outcome="request")
        self.journal.add("request", text, device="mac")
        log = ContextLog()
        log.record("turn/start input", {"threadId": "t1", "input": [
            {"type": "text", "text": "The user just asked: " + text}, {"type": "image", "url": PNG}]},
            task=text, thread="t1")
        log.record("tool input", {"namespace": "mac", "tool": "click", "arguments": {"x": 1, "y": 2}},
                   task=text, thread="t1")
        log.record("tool output", {"callId": "c", "result": {"success": True, "contentItems": [
            {"type": "inputText", "text": "Clicked."}, {"type": "inputImage", "imageUrl": PNG}]}}, task=text, thread="t1")
        log.record("thread/tokenUsage/updated", {"tokenUsage": {"last": {"inputTokens": 41000, "outputTokens": 200},
                                                                "modelContextWindow": 272000}}, task=text, thread="t1")
        self.journal.add("say", "Done that.", device="mac", request=text, thread="t1")
        self.journal.add("done", "Done that.", device="mac", request=text, thread="t1")

    def test_requests_are_grouped_with_what_went_to_the_model(self):
        self.request("Open Safari")
        self.request("Search for the weather")
        feed = context_panel.Builder(self.journal.dir).build()
        requests = [g for g in feed["groups"] if g["kind"] == "request"]
        self.assertEqual([g["title"] for g in requests], ["Open Safari", "Search for the weather"])
        first = requests[0]
        self.assertEqual(first["status"], "done")
        self.assertEqual(first["inputs"], 3)  # the prompt, the tool call, its result
        labels = [i["label"] for i in first["items"]]
        self.assertIn("You said", labels)
        self.assertIn("Agent said", labels)
        sent = next(i for i in first["items"] if i["kind"] == "turn/start input")
        self.assertIn("The user just asked: Open Safari", sent["detail"])
        self.assertEqual(sent["images"], 1)
        self.assertTrue(sent["record"].endswith(".html"))
        self.assertNotIn("iVBORw0KGgo", json.dumps(feed))  # screenshots are counted, not copied
        self.assertEqual(feed["model_context"]["tokens"], 41200)
        self.assertIn("not the model's exact current context", feed["notice"])
        self.assertIn("41,200", feed["model_context"]["note"])

    def test_other_sessions_records_are_left_out(self):
        self.request("Open Safari")
        session_journal.current = None
        ContextLog().record("turn/start input", {"input": [{"type": "text", "text": "someone else's"}]}, task="x")
        feed = context_panel.Builder(self.journal.dir).build()
        self.assertNotIn("someone else's", json.dumps(feed))

    def test_compaction_and_ingestion_show(self):
        self.request("Open Safari")
        ContextLog().record("item/started", {"item": {"type": "contextCompaction"}}, task="Open Safari")
        self.journal.add("ingest started", "Meeting", chars=50000, tokens_estimated=12500, parts=5,
                         mode="in the conversation", id="x")
        self.journal.add("ingest done", "Meeting: in the conversation, verified", id="x", status="verified")
        feed = context_panel.Builder(self.journal.dir).build()
        self.assertTrue(feed["model_context"]["compacted_at"])
        self.assertIn("compacted", feed["model_context"]["note"])
        ingest_group = feed["groups"][-1]
        self.assertEqual(ingest_group["kind"], "ingest")
        self.assertEqual(ingest_group["status"], "verified")
        self.assertIn("12,500 tokens (estimated)", ingest_group["items"][0]["summary"])

    def test_the_journal_keeps_panel_json_current_and_private(self):
        self.request("Open Safari")
        deadline = time.time() + 5
        while not self.journal.panel_path.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(self.journal.panel_path.exists(), self.journal.panel_error)
        self.assertEqual(oct(self.journal.panel_path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(json.loads(self.journal.panel_path.read_text())["session"], self.journal.id)

    def test_long_details_say_how_much_more_there_is(self):
        self.assertIn("5,000 more characters", context_panel.detail("x" * (context_panel.DETAIL + 5000)))


if __name__ == "__main__":
    unittest.main()
