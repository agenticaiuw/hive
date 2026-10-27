"""Checks the tools Codex gets beyond single Mac actions: batch (several Mac actions, one
screenshot) against the helper in --dry-run mode, the iPhone tools (python/phone.py,
python/phone_mcp.py) against a stand-in for the phone's relay, a task's trip through `codex
app-server` (python/codex_app.py) against a stand-in for Codex (tests/fake_codex.py), and the
captions overlay drawn into a PNG. Nothing touches the real phone, takes a screenshot of your
screen, or shows a window.

    .venv/bin/python tests/test_tools.py
"""

import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from test_dry_run import Helper, keyboard  # noqa: E402
from agent_vhid import AgentVHID  # noqa: E402
import agent  # noqa: E402
import captions  # noqa: E402
import mac_mcp  # noqa: E402
import phone  # noqa: E402
import phone_mcp  # noqa: E402

TOKEN = "relay-control-token-0123456789"


def png(width: int, height: int) -> bytes:
    """A plain grey PNG."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + b"\x80\x80\x80" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


SOURCE = f"""<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Safari" visible="true" x="0" y="0" width="44" height="96">
<XCUIElementTypeButton type="XCUIElementTypeButton" name="Send" label="Send" visible="true" x="30" y="80" width="10" height="6"/>
<XCUIElementTypeTextField type="XCUIElementTypeTextField" label="Address" value="{TOKEN}" visible="true" x="2" y="4" width="40" height="5"/>
<XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" label="Password" value="hunter2" visible="true" x="2" y="20" width="40" height="5"/>
<XCUIElementTypeButton type="XCUIElementTypeButton" label="Hidden" visible="false" x="0" y="0" width="1" height="1"/>
</XCUIElementTypeApplication></AppiumAUT>"""


class Relay(BaseHTTPRequestHandler):
    """Answers like the Cloudflare relay with WebDriverAgent behind it: a 44x96-point phone."""
    calls: list = []
    online = True

    def log_message(self, *args):
        pass

    def _answer(self, status: int, value: dict):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method: str):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._answer(401, {"error": "unauthorized"})
        Relay.calls.append((method, self.path, body))
        if self.path == "/health":
            return self._answer(200, {"connected": Relay.online, "pending": 0})
        if not Relay.online:
            return self._answer(503, {"error": "phone offline"})
        if self.path == "/api/status":
            return self._answer(200, {"sessionId": "S1", "value": {"ready": True}})
        if self.path == "/api/screenshot":
            return self._answer(200, {"value": base64.b64encode(png(132, 288)).decode()})
        if self.path == "/api/wda/activeAppInfo":
            return self._answer(200, {"value": {"bundleId": "com.apple.mobilesafari", "name": "Safari"}})
        if self.path == "/api/session/S1/window/size":
            return self._answer(200, {"value": {"width": 44, "height": 96}})
        if self.path == "/api/session/S1/source":
            return self._answer(200, {"value": SOURCE})
        if self.path == "/api/session/S1/element":
            if body["value"] == "Send":
                return self._answer(200, {"value": {"ELEMENT": "E-1"}})
            return self._answer(404, {"value": {"error": "no such element", "message": "unable to find"}})
        return self._answer(200, {"value": None})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


class PhoneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.folder = tempfile.mkdtemp(prefix="relay-")
        os.makedirs(os.path.join(cls.folder, "private"))
        with open(os.path.join(cls.folder, "endpoint.txt"), "w") as f:
            f.write(f"http://127.0.0.1:{cls.server.server_port}\n")
        with open(os.path.join(cls.folder, "private", "secrets.json"), "w") as f:
            json.dump({"CONTROL_TOKEN": TOKEN}, f)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        Relay.calls, Relay.online = [], True
        self.tools = phone_mcp.PhoneTools(phone.Phone(self.folder))

    def test_screenshot_is_in_points_with_the_app_in_front(self):
        res = self.tools.call("screenshot", {})
        self.assertFalse(res["isError"])
        note, image = res["content"]
        self.assertIn("44x96 points", note["text"])
        self.assertIn("Safari (com.apple.mobilesafari)", note["text"])
        jpeg = base64.b64decode(image["data"])
        self.assertEqual(jpeg[:2], b"\xff\xd8")
        out = os.path.join(self.folder, "shot.jpg")
        with open(out, "wb") as f:
            f.write(jpeg)
        size = subprocess.run(["sips", "-g", "pixelWidth", out], capture_output=True, text=True).stdout
        self.assertIn("pixelWidth: 44", size)  # one pixel per point: what taps use

    def test_actions_go_to_webdriveragent(self):
        self.tools.call("tap", {"x": 10, "y": 20, "screenshot": False})
        self.tools.call("type_text", {"text": "pizza\n", "screenshot": False})
        self.tools.call("open_app", {"bundle_id": "com.apple.Maps", "screenshot": False})
        self.tools.call("press_home", {"screenshot": False})
        self.tools.call("swipe", {"from_x": 20, "from_y": 80, "to_x": 20, "to_y": 20, "screenshot": False})
        posts = [(path, body) for method, path, body in Relay.calls if method == "POST"]
        self.assertIn(("/api/session/S1/wda/tap", {"x": 10.0, "y": 20.0}), posts)
        self.assertIn(("/api/session/S1/wda/keys", {"value": ["pizza\n"]}), posts)
        self.assertIn(("/api/session/S1/wda/apps/activate", {"bundleId": "com.apple.Maps"}), posts)
        self.assertIn(("/api/wda/homescreen", {}), posts)
        self.assertIn(("/api/session/S1/wda/dragfromtoforduration",
                       {"fromX": 20.0, "fromY": 80.0, "toX": 20.0, "toY": 20.0, "duration": 0.3}), posts)
        settings = [body for path, body in posts if path.endswith("/appium/settings")]
        self.assertEqual(settings, [{"settings": {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0}}])

    def test_elements_list_whats_visible_and_hide_secrets(self):
        res = self.tools.call("elements", {})
        listing = res["content"][0]["text"]
        self.assertIn('(35, 83) Button "Send"', listing)
        self.assertIn("Address", listing)
        self.assertNotIn(TOKEN, listing)
        self.assertNotIn("hunter2", listing)  # a password field's contents
        self.assertNotIn("Hidden", listing)

    def test_tap_element_by_label(self):
        self.assertFalse(self.tools.call("tap_element", {"label": "Send", "screenshot": False})["isError"])
        self.assertIn(("POST", "/api/session/S1/element/E-1/click", {}), Relay.calls)
        res = self.tools.call("tap_element", {"label": "Nope", "screenshot": False})
        self.assertTrue(res["isError"])

    def test_batch(self):
        res = self.tools.call("batch", {"steps": [{"tool": "tap", "x": 1, "y": 2},
                                                  {"tool": "type_text", "text": "hi"}], "screenshot": False})
        self.assertEqual(res["content"][0]["text"], "Did 2 steps: tap, type_text.")
        res = self.tools.call("batch", {"steps": [{"tool": "elements"}]})
        self.assertTrue(res["isError"])

    def test_offline_phone_says_how_to_connect_it(self):
        Relay.online = False
        self.assertFalse(phone.Phone(self.folder).connected())
        res = self.tools.call("tap", {"x": 1, "y": 1})
        self.assertTrue(res["isError"])
        self.assertIn("Pocket Connect", res["content"][0]["text"])

    def test_the_token_stays_off_the_command_line(self):
        seen = []
        real = subprocess.run
        with mock.patch("subprocess.run", lambda cmd, **kw: (seen.append(cmd), real(cmd, **kw))[1]):
            phone.Phone(self.folder).connected()
        self.assertTrue(seen)
        self.assertFalse(any(TOKEN in arg for cmd in seen for arg in cmd))

    def test_without_a_relay_it_explains(self):
        with mock.patch.dict(os.environ, {"PHONE_RELAY": ""}):
            res = phone_mcp.PhoneTools().call("screenshot", {})
        self.assertTrue(res["isError"])
        self.assertIn("PHONE_RELAY", res["content"][0]["text"])


class MacBatchTest(unittest.TestCase):
    def setUp(self):
        self.helper = Helper("--start-engaged")
        self.addCleanup(self.helper.stop)
        self.tools = mac_mcp.MacTools()
        self.tools.mac = AgentVHID(self.helper.socket, human=False)
        self.addCleanup(self.tools.mac.close)

    def test_several_actions_in_one_call(self):
        n = len(self.helper.lines)
        res = self.tools.call("batch", {"steps": [{"tool": "press_key", "keys": "cmd+l"},
                                                  {"tool": "type_text", "text": "a"}], "screenshot": False})
        self.assertEqual(res["content"][0]["text"], "Did 2 steps: press_key, type_text.")
        self.assertEqual(self.helper.reports(n), [
            keyboard(0x8), keyboard(0x8, 0x0f), keyboard(0x8), keyboard(0),  # cmd+l
            keyboard(0, 0x04), keyboard(0),                                   # a
        ])

    def test_stops_at_a_step_it_cant_do(self):
        res = self.tools.call("batch", {"steps": [{"tool": "press_key", "keys": "escape"}, {"tool": "screenshot"},
                                                  {"tool": "type_text", "text": "never"}], "screenshot": False})
        self.assertTrue(res["isError"])
        self.assertIn("Step 2", res["content"][0]["text"])


class CodexTaskTest(unittest.TestCase):
    """A task on the stand-in app-server: it calls back into our tools (the phone's wait, which
    doesn't need the phone) and finishes with its reply."""

    def setUp(self):
        self.log = os.path.join(tempfile.mkdtemp(prefix="codex-"), "codex.jsonl")
        env = {"CODEX_BIN": os.path.join(HERE, "fake_codex.py"), "FAKE_CODEX_LOG": self.log,
               "FAKE_CODEX_SECONDS": "0.3", "FAKE_CODEX_REPLY": "Done on the phone."}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        agent.stop_server()
        self.addCleanup(agent.stop_server)
        self.events: list[tuple[str, str]] = []

    def entries(self) -> list[dict]:
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def task(self) -> agent.CodexTask:
        return agent.CodexTask("open Maps", device="phone", on_event=lambda *e: self.events.append(e)).start(look=False)

    def test_a_task_uses_our_instructions_and_tools(self):
        task = self.task()
        self.assertEqual(task.wait(), "Done on the phone.")
        run, reply = self.entries()
        self.assertEqual(run["tools"], ["mac", "phone"])  # every task can use both
        self.assertEqual(run["model"], "gpt-6.1-terra")
        self.assertEqual(run["instructions"], agent.instructions())  # in place of Codex's own
        self.assertIn("This request is for the iPhone", run["prompt"])
        self.assertEqual(run["effort"], "low")
        self.assertIn('"open Maps"', run["prompt"])
        self.assertEqual(reply["tool_reply"], {"success": True, "contentItems": [{"type": "inputText", "text": "Waited."}]})
        self.assertIn(("action", "wait(seconds=0.1)"), self.events)
        self.assertEqual(self.events[-1], ("done", "Done on the phone."))

    def test_tasks_share_one_codex(self):
        self.task().wait()
        server = agent.codex_server()
        self.task().wait()
        self.assertIs(agent.codex_server(), server)
        self.assertEqual(len([e for e in self.entries() if "prompt" in e]), 2)

    def test_stop_ends_the_turn(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        task = self.task()
        while not any(kind == "action" for kind, _ in self.events):
            time.sleep(0.05)
        task.stop()
        self.assertEqual(self.events[-1], ("failed", "stopped"))
        self.assertFalse(task.running)
        self.assertIsNone(task.final)

    def test_codex_runs_lean(self):
        cmd = agent.app_server_command()
        self.assertEqual(cmd[1], "app-server")
        self.assertIn('features.code_mode.direct_only_tool_namespaces=["mac", "phone"]', cmd)
        self.assertIn("features.shell_tool=false", cmd)
        self.assertIn("notify=[]", cmd)
        catalog = [c.split("=", 1)[1] for c in cmd if c.startswith("model_catalog_json=")]
        if catalog:  # when Codex has cached its model list
            with open(json.loads(catalog[0])) as f:
                models = json.load(f)["models"]
            self.assertTrue(models)
            self.assertTrue(all(m["tool_mode"] == "direct" and "multi_agent_version" not in m for m in models))

    def test_tool_results_become_codex_replies(self):
        res = mac_mcp.result(mac_mcp.text("Clicked."), {"type": "image", "data": "QUJD", "mimeType": "image/jpeg"})
        self.assertEqual(agent.tool_reply(res), {"success": True, "contentItems": [
            {"type": "inputText", "text": "Clicked."}, {"type": "inputImage", "imageUrl": "data:image/jpeg;base64,QUJD"}]})
        self.assertFalse(agent.tool_reply(mac_mcp.result(mac_mcp.text("no"), error=True))["success"])
        specs = agent.tool_specs()
        self.assertEqual([s["name"] for s in specs], ["mac", "phone"])
        self.assertIn("batch", [t["name"] for t in specs[0]["tools"]])
        self.assertIn("tap", [t["name"] for t in specs[1]["tools"]])

    def test_a_request_that_says_phone_starts_on_the_phone(self):
        self.assertEqual(agent.focus("Open Maps on my phone"), "phone")
        self.assertEqual(agent.focus("check the weather on the iPhone"), "phone")
        self.assertEqual(agent.focus("what's my phone number"), "mac")
        self.assertEqual(agent.focus("open Safari"), "mac")
        self.assertEqual(agent.CodexTask("open Maps on my phone").device, "phone")


class CaptionsTest(unittest.TestCase):
    def test_overlay_draws_the_words(self):
        if not os.path.exists(captions.OVERLAY):
            self.skipTest("build/agent-vhid-captions isn't built (make)")
        out = os.path.join(tempfile.mkdtemp(prefix="captions-"), "c.png")
        subprocess.run([captions.OVERLAY, "--snapshot", out, "I opened Safari for you.", "Typing “weather”"],
                       check=True, timeout=20)
        size = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out], capture_output=True,
                              text=True).stdout
        width = int(size.split("pixelWidth:")[1].split()[0])
        height = int(size.split("pixelHeight:")[1].split()[0])
        self.assertGreater(width, 300)
        self.assertGreater(height, 60)  # two lines: the words and what it's doing

    def test_hidden_captions_do_nothing(self):
        quiet = captions.Captions(show=False)
        quiet.say("hello")
        quiet.doing("Thinking")
        quiet.close()


if __name__ == "__main__":
    unittest.main()
