"""End-to-end check with the real virtual devices.

Waits for you to hand over control, then:
  1. moves the cursor to a few points and reports how close it landed,
  2. opens a scratch file in TextEdit, types a sentence, saves, and checks the file,
  3. takes a screenshot.
Touch anything at any point to take control back; the demo stops cleanly.

    python3 examples/demo.py
"""

import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from agent_vhid import AgentVHID, Disengaged, main_display_bounds  # noqa: E402

# Plain dictionary words, so TextEdit's autocorrect has nothing to change.
SENTENCE = "Hello, World! The quick brown fox jumps over the lazy dog. 1234567890 !@#$%^&*()"


def main() -> int:
    mac = AgentVHID()
    status = mac.status()
    print("helper:", " ".join(f"{k}={v}" for k, v in status.items()))
    if status.get("vhid") != "ready":
        print("virtual devices are not ready; is the daemon running?")
        return 1

    mac.wait_engaged()
    print("engaged")
    try:
        # 1. Mouse accuracy
        _, _, w, h = main_display_bounds()
        start = mac.cursor()
        for name, (x, y) in [("center", (w / 2, h / 2)), ("top-left", (120, 120)),
                             ("bottom-right", (w - 120, h - 120)), ("start", start)]:
            t = time.time()
            mac.move_to(x, y)
            cx, cy = mac.cursor()
            print(f"  move {name:12} -> ({cx:7.1f}, {cy:6.1f})  off by ({cx - x:+.2f}, {cy - y:+.2f})  {time.time() - t:.2f}s")

        # 2. Keyboard: type into a scratch file and save it
        fd, path = tempfile.mkstemp(prefix="agent-vhid-demo-", suffix=".txt")
        os.close(fd)
        subprocess.run(["open", "-e", path], check=True)
        time.sleep(1.5)  # let TextEdit open and focus the window
        mac.type_text(SENTENCE)
        mac.key("cmd+s")
        time.sleep(0.8)
        mac.key("cmd+w")
        with open(path) as f:
            saved = f.read()
        print(f"  typed and saved: {'OK' if saved == SENTENCE else 'MISMATCH'}")
        if saved != SENTENCE:
            print(f"    expected {SENTENCE!r}\n    got      {saved!r}")

        # 3. Screen
        shot = mac.screenshot(max_width=1280)
        print(f"  screenshot: {shot.path} {shot.width}x{shot.height}, {shot.scale:.3f} points per pixel")
    except Disengaged as e:
        print(f"you took over ({e}); demo stopped")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
