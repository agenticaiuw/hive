"""No real app, process control, microphone, network, or user files are used."""
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "restart_once", Path(__file__).resolve().parents[1] / "scripts/restart-agent-once.py")
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.app = self.root / "Applications/Agent.app"
        self.stage = self.root / "agent-restart-test"
        (self.repo / "build").mkdir(parents=True)
        (self.repo / ".venv/bin").mkdir(parents=True)
        python = self.repo / ".venv/bin/python"
        python.write_text("fixture")
        python.chmod(0o700)
        (self.app / "Contents").mkdir(parents=True)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": restart.IDENTIFIER, "AgentRepository": str(self.repo)}))
        (self.app / "old").write_text("old app")
        (self.stage / "Agent.app").mkdir(parents=True)
        (self.stage / "Agent.app/new").write_text("new app")
        (self.stage / "agent-vhid-captions").write_text("new overlay")
        (self.repo / "build/agent-vhid-captions").write_text("old overlay")

    def test_default_is_plan_only(self):
        with patch("sys.argv", ["restart"]), patch.object(restart, "prepare") as prepare:
            restart.main()
        prepare.assert_not_called()

    def test_source_patch_fails_closed(self):
        for text in ("missing", "anchor anchor"):
            with self.assertRaises(RuntimeError):
                restart.replace_once(text, "anchor", "new")

    def test_real_sources_patch_without_editing_them(self):
        app, captions = restart.patched_sources(restart.REPO, self.stage)
        self.assertIn('if statusLine.title == "Ready", listenOnce', app)
        self.assertIn('if !listening { toggle() }', app)
        self.assertNotIn("security find-identity", app)
        self.assertNotIn("try? manager.removeItem(at: old)", app)
        self.assertIn("self.window.isVisible", captions)

    def test_actual_swift_parser_toggles_once_only_after_ready(self):
        app, _ = restart.patched_sources(restart.REPO, self.stage)
        parser = app.split("    func took(_ data: Data) {", 1)[1].split("    func show()", 1)[0]
        harness = '''import Foundation
enum State { case on, off }
final class Line { var title = ""; var isEnabled = false; var state = State.off }
final class Panel { var feedURL: URL?; var isVisible = false; func load(force: Bool) {} }
final class Harness {
    var output = Data()
    var listening = false, dictating = false, listenOnce = true, camera = false
    var contextURL: URL?, panelURL: URL?
    let statusLine = Line(), contextItem = Line(), clipboardItem = Line(), fileItem = Line()
    let voiceItem = Line(), lipsItem = Line(), panel = Panel()
    var toggles = 0
    func show() {}
    func write(_ text: String) {}
    func toggle() { toggles += 1 }
    func feed(_ text: String) { took(Data(text.utf8)) }
    func took(_ data: Data) {''' + parser + '''
}
let a = Harness()
a.feed("@@ listening 0\\n@@ status Waiting for helper\\n@@ status Re")
precondition(a.toggles == 0)
a.feed("ady\\n")
precondition(a.toggles == 1)
a.feed("@@ status Ready\\n@@ listening 1\\n@@ status Ready\\n")
precondition(a.toggles == 1 && a.listening)
let b = Harness()
b.feed("@@ listening 1\\n@@ status Ready\\n")
precondition(b.toggles == 0)
let c = Harness()
c.listenOnce = false
c.feed("@@ listening 0\\n@@ status Ready\\n")
precondition(c.toggles == 0)
print("Readiness, split lines, repeated Ready, already listening, and opt-in checks passed")
'''
        source, binary = self.root / "parser.swift", self.root / "parser-test"
        source.write_text(harness)
        subprocess.run(["/usr/bin/swiftc", "-module-cache-path", str(self.root / "cache"),
                        str(source), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)

    def test_success_preserves_backups_and_orders_quit_before_launch(self):
        calls = []
        def fake_run(*args):
            calls.append(args[1])
            if args[1] == "quit":
                self.assertTrue((self.app / "old").exists())
            if args[1] == "launch":
                self.assertTrue((self.app / "new").exists())
                (self.stage / "listening").touch()
                (self.stage / "visible").touch()
        with patch.object(restart, "run", side_effect=fake_run):
            restart.execute(self.stage, self.repo, self.app)
        self.assertEqual(calls, ["quit", "launch"])
        self.assertEqual((self.app.with_name("Agent.backup-agent-restart-test.app") / "old").read_text(), "old app")
        self.assertEqual((self.repo / "build/agent-vhid-captions.backup-agent-restart-test").read_text(), "old overlay")

    def test_refused_quit_does_not_replace_app(self):
        with patch.object(restart, "run", side_effect=RuntimeError("refused")):
            with self.assertRaises(RuntimeError):
                restart.execute(self.stage, self.repo, self.app)
        self.assertTrue((self.app / "old").exists())

    def test_missing_acknowledgement_is_failure_without_retry(self):
        with patch.object(restart, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "No listening"):
                restart.execute(self.stage, self.repo, self.app, timeout=0)
        self.assertEqual([call.args[1] for call in run.call_args_list], ["quit", "launch"])

    def test_mismatched_install_refused_before_process_control(self):
        with patch.object(restart, "run") as run:
            with self.assertRaises(RuntimeError):
                restart.execute(self.stage, self.root, self.app)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
