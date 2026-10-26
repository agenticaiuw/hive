"""Runs the real helper in --dry-run mode (no root, no virtual devices) and checks
the reports it would send, the hand-over gate, and the Python wrapper.

    python3 tests/test_dry_run.py
"""

import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

import agent_vhid  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError, Disengaged, MoveFailed, NotAllowed, Screenshot  # noqa: E402

HELPER = os.path.join(ROOT, "build", "agent-vhid-helper")


class Helper:
    def __init__(self, *extra):
        self.dir = tempfile.mkdtemp(prefix="avh-")
        self.socket = os.path.join(self.dir, "s.sock")
        self.lines: list[str] = []
        self.proc = subprocess.Popen(
            [HELPER, "--dry-run", "--no-watch", "--no-sound", "--verbose", "--quiet-ms", "100",
             "--socket", self.socket, *extra],
            stderr=subprocess.PIPE, text=True)
        threading.Thread(target=self._read, daemon=True).start()
        deadline = time.time() + 5
        while not os.path.exists(self.socket):
            if time.time() > deadline or self.proc.poll() is not None:
                raise RuntimeError("helper did not start:\n" + "\n".join(self.lines))
            time.sleep(0.02)

    def _read(self):
        for line in self.proc.stderr:
            self.lines.append(line.rstrip("\n"))

    def raw(self, line: str) -> str:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(self.socket)
            s.sendall(line.encode() + b"\n")
            with s.makefile() as reply:
                return reply.readline().strip()

    def reports(self, since: int) -> list[str]:
        time.sleep(0.1)  # dry-run reports are logged from the dispatcher thread
        return [l.removeprefix("[dry-run] ") for l in self.lines[since:] if l.startswith("[dry-run]")]

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)


def keyboard(mods: int, *keys: int) -> str:
    return f"keyboard mods=0x{mods:x} keys=" + "".join(f" 0x{k:x}" for k in keys)


class DryRunTest(unittest.TestCase):
    def setUp(self):
        self.helper = Helper("--start-engaged")
        self.mac = AgentVHID(self.helper.socket, human=False)

    def tearDown(self):
        self.mac.close()
        self.helper.stop()

    def test_status(self):
        status = self.mac.status()
        self.assertEqual(status["state"], "engaged")
        self.assertEqual(status["dry_run"], "1")
        self.assertEqual(status["vhid"], "dry_run")

    def test_shortcut_presses_modifier_then_key(self):
        n = len(self.helper.lines)
        self.mac.key("cmd+s")
        self.assertEqual(self.helper.reports(n), [
            keyboard(0x8), keyboard(0x8, 0x16), keyboard(0x8), keyboard(0),
        ])

    def test_typing_uses_shift_for_capitals_and_symbols(self):
        n = len(self.helper.lines)
        self.mac.type_text("Hi!")
        self.assertEqual(self.helper.reports(n), [
            keyboard(0x2), keyboard(0x2, 0x0b), keyboard(0x2), keyboard(0),  # H
            keyboard(0, 0x0c), keyboard(0),                                   # i
            keyboard(0x2), keyboard(0x2, 0x1e), keyboard(0x2), keyboard(0),  # !
        ])

    def test_characters_off_the_keyboard_are_pasted(self):
        pasted = []
        self.mac.paste_text = pasted.append
        n = len(self.helper.lines)
        self.mac.type_text("a中文b")
        self.assertEqual(pasted, ["中文"])
        self.assertEqual(self.helper.reports(n), [
            keyboard(0, 0x04), keyboard(0), keyboard(0, 0x05), keyboard(0),
        ])

    def test_scroll_direction_follows_natural_scrolling(self):
        self.mac._natural = True
        n = len(self.helper.lines)
        self.mac.scroll(down=2)
        self.mac._natural = False
        self.mac.scroll(down=1)
        self.assertEqual(self.helper.reports(n), [
            "pointing buttons=0 x=0 y=0 wheel=1,0",
            "pointing buttons=0 x=0 y=0 wheel=1,0",
            "pointing buttons=0 x=0 y=0 wheel=-1,0",
        ])

    def test_large_moves_are_split_into_hid_sized_reports(self):
        n = len(self.helper.lines)
        self.mac._send("move 300 -10")
        self.assertEqual(self.helper.reports(n), [
            "pointing buttons=0 x=127 y=-10 wheel=0,0",
            "pointing buttons=0 x=127 y=0 wheel=0,0",
            "pointing buttons=0 x=46 y=0 wheel=0,0",
        ])

    def test_drag_keeps_button_held_while_moving(self):
        n = len(self.helper.lines)
        self.mac._send("buttons 1")  # same connection: closing one releases everything
        self.mac._send("move 5 5")
        self.assertEqual(self.helper.reports(n)[:2], [
            "pointing buttons=1 x=0 y=0 wheel=0,0",
            "pointing buttons=1 x=5 y=5 wheel=0,0",
        ])

    def test_human_input_disengages_and_releases_everything(self):
        self.mac._send("keys 8 22")
        n = len(self.helper.lines)
        self.assertEqual(self.helper.raw("human trackpad"), "ok")
        self.assertEqual(self.helper.reports(n), [keyboard(0), "pointing buttons=0 x=0 y=0 wheel=0,0"])
        with self.assertRaises(Disengaged):
            self.mac.key("a")
        with self.assertRaises(Disengaged):
            self.mac.click()
        status = self.mac.status()
        self.assertEqual((status["state"], status["reason"]), ("disengaged", "trackpad"))
        self.mac.release_all()  # always allowed

    def test_engage_waits_for_quiet_period(self):
        self.helper.raw("human keyboard")
        result = {}
        waiter = threading.Thread(target=lambda: result.setdefault("ok", self.mac.wait_engaged(3, announce=False)))
        waiter.start()
        time.sleep(0.1)
        self.helper.raw("engage")
        self.assertEqual(self.mac.status()["state"], "arming")
        waiter.join(3)
        self.assertTrue(result.get("ok"))
        self.mac.key("a")  # works again

    def test_touch_while_arming_cancels(self):
        self.helper.raw("human keyboard")
        self.helper.raw("engage")
        self.helper.raw("human trackpad")
        time.sleep(0.25)
        status = self.mac.status()
        self.assertEqual((status["state"], status["reason"]), ("disengaged", "engage_cancelled_by_trackpad"))

    def test_watch_streams_hand_overs(self):
        events = []
        def collect():
            for event in self.mac.watch():
                events.append(event)
                if len(events) == 2:
                    return
        t = threading.Thread(target=collect, daemon=True)
        t.start()
        time.sleep(0.1)
        self.helper.raw("human mouse")
        t.join(2)
        self.assertEqual([e["state"] for e in events], ["engaged", "disengaged"])
        self.assertEqual(events[1]["reason"], "mouse")

    def test_voice_agent_can_engage_once_after_a_talk_hold(self):
        self.helper.raw("human keyboard")
        with self.assertRaises(NotAllowed):
            self.mac.engage_after_talk()  # nobody spoke
        self.helper.raw("talk down")
        with self.assertRaises(NotAllowed):
            self.mac.engage_after_talk()  # still holding the key
        self.helper.raw("talk up")
        self.mac.engage_after_talk()
        self.assertEqual(self.mac.status()["state"], "arming")
        self.assertTrue(self.mac.wait_engaged(2, announce=False))
        self.assertEqual(self.mac.status()["reason"], "engaged_by_voice")
        self.mac.disengage()
        status = self.mac.status()
        self.assertEqual((status["state"], status["reason"]), ("disengaged", "released_by_agent"))
        with self.assertRaises(NotAllowed):
            self.mac.engage_after_talk()  # one grant per hold

    def test_watch_streams_talk_holds(self):
        events = []
        def collect():
            for event in self.mac.watch():
                events.append(event)
                if len(events) == 3:
                    return
        t = threading.Thread(target=collect, daemon=True)
        t.start()
        time.sleep(0.1)
        self.helper.raw("talk down")
        self.helper.raw("talk up")
        t.join(2)
        self.assertEqual(events[1:], [{"talk": "down"}, {"talk": "up"}])

    def test_modifier_click_holds_the_modifier(self):
        n = len(self.helper.lines)
        self.mac.click(modifiers="cmd")
        self.assertEqual(self.helper.reports(n), [
            keyboard(0x8),
            "pointing buttons=1 x=0 y=0 wheel=0,0",
            "pointing buttons=0 x=0 y=0 wheel=0,0",
            keyboard(0),
        ])

    def test_keys_are_released_when_a_client_disconnects(self):
        n = len(self.helper.lines)
        self.helper.raw("keys 2 4")  # raw() closes the connection right after
        self.assertEqual(self.helper.reports(n)[-2:], [keyboard(0), "pointing buttons=0 x=0 y=0 wheel=0,0"])

    def test_move_reports_when_cursor_does_not_follow(self):
        # In a dry run nothing moves the real cursor, so the closed loop must give up.
        x, y = self.mac.cursor()
        x2 = x - 40 if x > 100 else x + 40
        start = time.time()
        with self.assertRaises(MoveFailed):
            self.mac.move_to(x2, y)
        self.assertLess(time.time() - start, 2)

    def test_bad_requests(self):
        self.assertTrue(self.helper.raw("move 1").startswith("err bad_request"))
        self.assertTrue(self.helper.raw("keys 300").startswith("err bad_request"))
        self.assertTrue(self.helper.raw("launch missiles").startswith("err bad_request"))
        with self.assertRaises(ValueError):
            self.mac.key("cmd+nosuchkey")


class OfflineTest(unittest.TestCase):
    def test_screenshot_coordinates(self):
        shot = Screenshot("x.png", 1280, 800, 1440 / 1280)
        self.assertEqual(shot.to_screen(640, 400), (720.0, 450.0))
        self.assertEqual(shot.from_screen(720, 450), (640.0, 400.0))

    def test_helper_refuses_to_run_without_root_or_watcher(self):
        out = subprocess.run([HELPER, "--no-watch"], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("only allowed with --dry-run", out.stderr)
        out = subprocess.run([HELPER], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1)
        self.assertIn("must run as root", out.stderr)

    def test_helper_starts_disengaged_by_default(self):
        helper = Helper()
        try:
            self.assertTrue(helper.raw("move 1 1").startswith("err disengaged state=disengaged reason=startup"))
        finally:
            helper.stop()

    def test_helper_unavailable(self):
        with self.assertRaises(agent_vhid.HelperUnavailable):
            AgentVHID("/tmp/agent-vhid-nonexistent.sock").status()


if __name__ == "__main__":
    unittest.main(verbosity=2)
