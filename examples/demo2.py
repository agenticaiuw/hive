"""Second demo: the agent looks at the screen and acts on what it sees.

  1. Opens Calculator through Spotlight, works out 1234 x 5678, copies the answer and checks it.
  2. Opens a 200-line note and scrolls, reading the screen each time, until it sees a hidden word.
  3. Double-clicks that word, copies it, and checks the clipboard.
  4. Right-clicks it, reads the context menu, and closes it.
  5. Closes everything and puts your clipboard back.
Touch anything at any point to take control back.

    python3 examples/demo2.py
"""

import os
import random
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from agent_vhid import AgentVHID, Disengaged  # noqa: E402

# Picked at run time so the word can't already be on screen somewhere else.
HIDDEN_WORDS = ["pineapple", "lighthouse", "marmalade", "porcupine", "trombone", "avalanche"]
HIDDEN_LINE = 160


def clipboard() -> str:
    return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout


def report(ok: bool, what: str):
    print(f"  {'OK  ' if ok else 'FAIL'} {what}")
    return ok


def visible_line_numbers(mac: AgentVHID, boxes) -> list[int]:
    numbers = []
    for box in boxes:
        m = re.match(r"Line (\d{3})\b", box.line)
        if m and box.text == m.group(1):
            numbers.append(int(m.group(1)))
    return sorted(set(numbers))


def main() -> int:
    mac = AgentVHID()
    if mac.status().get("vhid") != "ready":
        print("virtual devices are not ready; is the helper running?")
        return 1
    saved_clipboard = subprocess.run(["pbpaste"], capture_output=True).stdout
    word = random.choice(HIDDEN_WORDS)
    results = []

    mac.wait_engaged()
    print("engaged")
    try:
        # 1. Spotlight -> Calculator
        print("Calculator via Spotlight")
        mac.key("cmd+space")
        time.sleep(0.8)
        mac.type_text("Calculator")
        time.sleep(1.0)
        mac.key("return")
        time.sleep(2.0)
        mac.key("escape")
        mac.key("escape")
        mac.type_text("1234*5678=")
        time.sleep(0.5)
        mac.key("cmd+c")
        time.sleep(0.3)
        answer = clipboard().replace(",", "").strip()
        results.append(report(answer == "7006652", f"1234 x 5678 = {answer or '(nothing copied)'}"))
        mac.key("cmd+q")
        time.sleep(0.8)

        # 2. Scroll until the hidden word shows up
        print("Scroll until the hidden word is visible")
        fd, path = tempfile.mkstemp(prefix="agent-vhid-note-", suffix=".txt")
        with os.fdopen(fd, "w") as f:
            for n in range(1, 201):
                if n == HIDDEN_LINE:
                    f.write(f"Line {n:03d} here is the {word} you were looking for\n")
                else:
                    f.write(f"Line {n:03d} the quick brown fox jumps over the lazy dog\n")
        subprocess.run(["open", "-e", path], check=True)
        time.sleep(1.5)

        boxes = mac.read_screen()
        first = mac.find_text("001", boxes, line_contains="Line 001")
        if not first:
            results.append(report(False, "could not see the note's first line"))
            raise SystemExit(1)
        mac.move_to(first.center[0] + 120, first.center[1] + 60)  # over the text, so the scroll lands there

        target = None
        previous_top = visible_line_numbers(mac, boxes)[0]
        for _ in range(30):
            mac.scroll(down=5)
            time.sleep(0.4)
            boxes = mac.read_screen()
            lines = visible_line_numbers(mac, boxes)
            top = lines[0] if lines else previous_top
            print(f"    scrolled 5 notches: lines {lines[0] if lines else '?'}-{lines[-1] if lines else '?'} visible")
            if top < previous_top:
                results.append(report(False, "scrolling went the wrong way"))
                break
            previous_top = top
            target = mac.find_text(word, boxes, line_contains=f"Line {HIDDEN_LINE}")
            if target:
                break
        results.append(report(target is not None, f"found '{word}' on line {HIDDEN_LINE}" if target else "never saw the word"))

        if target:
            # 3. Double-click the word and copy it
            print("Double-click and copy")
            mac.double_click(*target.center)
            time.sleep(0.3)
            mac.key("cmd+c")
            time.sleep(0.3)
            copied = clipboard()
            results.append(report(copied == word, f"clipboard holds {copied!r}"))

            # 4. Right-click and read the menu
            print("Right-click menu")
            mac.right_click(*target.center)
            time.sleep(0.8)
            cx, cy = target.center
            nearby = [b for b in mac.read_screen() if cx - 60 < b.x < cx + 450 and cy - 450 < b.y < cy + 600]
            menu = {b.line for b in nearby}
            has_lookup = any("Look Up" in line for line in menu)
            has_copy = any(line.strip() == "Copy" for line in menu)
            results.append(report(has_lookup and has_copy, "menu shows " + ", ".join(
                sorted(l for l in menu if l.strip() in ("Copy", "Cut", "Paste") or "Look Up" in l))))
            mac.key("escape")
            time.sleep(0.3)

        # 5. Clean up
        mac.key("cmd+w")
        time.sleep(0.5)
    except Disengaged as e:
        print(f"you took over ({e}); demo stopped")
        return 3
    finally:
        subprocess.run(["pbcopy"], input=saved_clipboard, check=True)

    print(f"{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
