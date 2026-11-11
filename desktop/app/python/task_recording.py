"""Screen recordings of the agent's tasks, paired with a timeline of what Hive and the Mac were doing.

While any task runs, the whole screen is recorded (macOS screencapture, with the cursor and clicks)
into ~/Movies/Hive/<date time> <request>/screen.mov. Next to it:

  timeline.jsonl  one line per event, each with the wall-clock time ("t") and the seconds into the
                  video ("video"): Hive's own lines (the request, tool calls, its words, the result),
                  its status line, who has the mouse and keyboard, and the Mac's state (front app and
                  window, cursor, whether someone is touching it) whenever that changes
  screen.srt      the same as subtitles, so a player that loads them (IINA, VLC) shows Hive's status
                  and the Mac's state in time with the video; nothing is drawn into the video itself
  meta.json       when the video started, its length, and how its clock lines up with the timeline

HIVE_RECORD=0 turns recording off; HIVE_RECORDINGS sets another folder.
"""
from __future__ import annotations

import collections
import ctypes
import datetime
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\r")


def folder() -> Path:
    return Path(os.environ.get("HIVE_RECORDINGS") or Path.home() / "Movies" / "Hive")


def slug(text: str) -> str:
    words = re.sub(r"[^\w\- ]+", " ", text or "").split()
    return " ".join(words)[:48].strip()


def clock(t: float) -> str:
    return datetime.datetime.fromtimestamp(t).strftime("%H:%M:%S.%f")[:-3]


# --- the Mac's state, read without extra permissions beyond Hive's own screen recording ---------
_cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
_cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
_cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
_cf.CFArrayGetCount.restype = ctypes.c_long
_cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
_cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
_cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
_cf.CFDictionaryGetValue.restype = ctypes.c_void_p
_cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_cf.CFStringCreateWithCString.restype = ctypes.c_void_p
_cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
_cf.CFStringGetCString.restype = ctypes.c_bool
_cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
_cf.CFNumberGetValue.restype = ctypes.c_bool
_cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
_cf.CFRelease.argtypes = [ctypes.c_void_p]
_UTF8 = 0x08000100
_KEYS = {name: _cf.CFStringCreateWithCString(None, name.encode(), _UTF8)
         for name in ("kCGWindowOwnerName", "kCGWindowName", "kCGWindowLayer")}


def _string(ref) -> str:
    if not ref:
        return ""
    buffer = ctypes.create_string_buffer(2048)
    return buffer.value.decode("utf-8", "replace") if _cf.CFStringGetCString(ref, buffer, 2048, _UTF8) else ""


def front_window() -> tuple[str, str]:
    """(app, window title) of the frontmost ordinary window."""
    windows = _cg.CGWindowListCopyWindowInfo(1 | 16, 0)  # on screen only, no desktop elements
    if not windows:
        return "", ""
    try:
        for i in range(_cf.CFArrayGetCount(windows)):
            info = _cf.CFArrayGetValueAtIndex(windows, i)
            layer = ctypes.c_int32(0)
            number = _cf.CFDictionaryGetValue(info, _KEYS["kCGWindowLayer"])
            if number:
                _cf.CFNumberGetValue(number, 3, ctypes.byref(layer))  # kCFNumberSInt32Type
            if layer.value == 0:
                return (_string(_cf.CFDictionaryGetValue(info, _KEYS["kCGWindowOwnerName"])),
                        _string(_cf.CFDictionaryGetValue(info, _KEYS["kCGWindowName"])))
    finally:
        _cf.CFRelease(windows)
    return "", ""


def idle_seconds() -> float:
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True, timeout=3).stdout
        found = re.search(r'"HIDIdleTime" = (\d+)', out)
        return int(found.group(1)) / 1e9 if found else -1.0
    except (OSError, subprocess.TimeoutExpired):
        return -1.0


def video_length(path: Path) -> float | None:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


class Recorder:
    """Starts a recording when a task starts and stops it a few seconds after the last one ends.

    running() says whether any task is running, engaged() whether the agent has the mouse and
    keyboard, title() names the recording. event() adds a line to the timeline; lines from shortly
    before a recording starts (the request itself) are kept and added when it starts."""

    def __init__(self, running, engaged=None, title=None, cursor=None, on_finished=None, poll=0.25, grace=3.0,
                 start_thread=True):
        self.running, self.engaged, self.title, self.cursor = running, engaged, title, cursor
        self.on_finished = on_finished  # (folder) after a recording's files are written
        self.poll, self.grace = poll, grace
        self.enabled = os.environ.get("HIVE_RECORD", "1") != "0"
        self.lock = threading.Lock()
        self.recent = collections.deque(maxlen=60)
        self.proc = None
        self.dir: Path | None = None
        self.started = 0.0
        self.events: list[dict] = []
        self.state: dict = {}
        self._file = None
        self._gave_up = False  # screencapture quit on its own: don't restart until the tasks end
        if start_thread:
            threading.Thread(target=self._watch, name="task-recording", daemon=True).start()

    # --- the timeline ---------------------------------------------------------------------------
    def event(self, kind: str, text: str = "", **extra):
        text = ANSI.sub("", str(text)).strip()
        if not text and not extra:
            return
        now = time.time()
        with self.lock:
            if self.proc is None:
                self.recent.append((now, kind, text, extra))
                return
            self._write(now, kind, text, extra)

    def _write(self, now, kind, text, extra):
        line = {"t": datetime.datetime.fromtimestamp(now).isoformat(timespec="milliseconds"),
                "video": round(now - self.started, 3), "kind": kind}
        if text:
            line["text"] = text
        line.update(extra)
        line["_at"] = now
        self.events.append(line)
        if self._file:
            self._file.write(json.dumps({k: v for k, v in line.items() if k != "_at"}, ensure_ascii=False) + "\n")
            self._file.flush()

    # --- starting and stopping ------------------------------------------------------------------
    def start(self):
        title = ""
        try:
            title = self.title() if self.title else ""
        except Exception:
            pass
        stamp = datetime.datetime.now()
        target = folder() / f"{stamp:%Y-%m-%d %H.%M.%S} {slug(title)}".strip()
        target.mkdir(parents=True, exist_ok=True)
        log = open(target / "screencapture.log", "ab")
        with self.lock:
            self.dir, self.events, self.state = target, [], {}
            self.started = time.time()
            self.proc = subprocess.Popen(["screencapture", "-v", "-C", "-k", "-x", str(target / "screen.mov")],
                                         stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            log.close()
            self._file = open(target / "timeline.jsonl", "a", encoding="utf-8")
            self._write(self.started, "recording", "started", {"video_file": "screen.mov"})
            for at, kind, text, extra in self.recent:
                if self.started - at <= 60:
                    self._write(at, kind, text, extra)
            self.recent.clear()
        self.sample(force=True)

    def stop(self):
        with self.lock:
            proc, self.proc = self.proc, None
            if proc is None:
                return
            stopped = time.time()
            self.proc = proc  # still recording while this last line goes in
            self._write(stopped, "recording", "stopped", {})
            self.proc = None
        if proc.poll() is None:
            proc.send_signal(signal.SIGINT)  # screencapture finishes the file on SIGINT
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        self._finish(stopped)

    def _finish(self, stopped):
        with self.lock:
            if self._file:
                self._file.close()
                self._file = None
            target, events, started = self.dir, list(self.events), self.started
        if not target:
            return
        length = video_length(target / "screen.mov")
        # screencapture starts writing a moment after it is launched; line the clock up with the video.
        lag = max(0.0, (stopped - started) - length) if length else 0.0
        for line in events:
            line["video"] = round(line["_at"] - started - lag, 3)
        with open(target / "timeline.jsonl", "w", encoding="utf-8") as f:
            for line in events:
                f.write(json.dumps({k: v for k, v in line.items() if k != "_at"}, ensure_ascii=False) + "\n")
        (target / "screen.srt").write_text(subtitles(events, length), encoding="utf-8")
        (target / "meta.json").write_text(json.dumps({
            "video": "screen.mov",
            "videoStarted": datetime.datetime.fromtimestamp(started + lag).isoformat(timespec="milliseconds"),
            "videoSeconds": length,
            "startLagSeconds": round(lag, 3),
            "note": "timeline.jsonl 'video' = seconds into screen.mov; 't' = wall-clock time on this Mac",
        }, indent=1), encoding="utf-8")
        if self.on_finished:
            try:
                self.on_finished(target)
            except Exception:
                pass

    # --- the Mac's state ------------------------------------------------------------------------
    def sample(self, force=False):
        state = {}
        try:
            app, window = front_window()
            state["front_app"], state["window"] = app, window
        except Exception:
            pass
        if self.engaged:
            try:
                state["control"] = "agent" if self.engaged() else "you"
            except Exception:
                pass
        if self.cursor:
            try:
                x, y = self.cursor()
                state["cursor"] = [int(x), int(y)]
            except Exception:
                pass
        idle = idle_seconds()
        if idle >= 0:
            state["someone_touching"] = idle < 1.5
        changed = {k: v for k, v in state.items() if force or self.state.get(k) != v}
        if changed:
            self.state.update(changed)
            self.event("mac", **changed)

    def _watch(self):
        idle_since, last_sample = None, 0.0
        while True:
            try:
                busy = bool(self.running())
                if not busy:
                    self._gave_up = False
                if busy and self.proc is None and self.enabled and not self._gave_up:
                    self.start()
                    idle_since = None
                elif not busy and self.proc is not None:
                    idle_since = idle_since or time.time()
                    if time.time() - idle_since >= self.grace:
                        self.stop()
                        idle_since = None
                else:
                    idle_since = None
                proc = self.proc
                if proc is not None and proc.poll() is not None:
                    self.event("recording", f"screencapture quit by itself (exit {proc.returncode}); see screencapture.log")
                    with self.lock:
                        self.proc = None
                    self._gave_up = True
                    self._finish(time.time())
                elif proc is not None and time.time() - last_sample >= 1.0:
                    last_sample = time.time()
                    self.sample()
            except Exception:
                pass
            time.sleep(self.poll)


def subtitles(events: list[dict], length: float | None) -> str:
    """SRT cues: at every event, what Hive was last doing and the Mac's state, with the exact time."""
    hive, mac, cues = "", {}, []
    for line in events:
        kind = line.get("kind")
        if kind == "mac":
            mac.update({k: v for k, v in line.items() if k not in ("t", "video", "kind", "_at")})
        elif line.get("text"):
            hive = line["text"] if kind != "status" else f"[{line['text']}]"
        else:
            continue
        where = " — ".join(x for x in (mac.get("front_app"), mac.get("window")) if x)
        hands = {"agent": "agent has mouse & keyboard", "you": "you have control"}.get(mac.get("control"), "")
        bottom = " · ".join(x for x in (where, hands) if x)
        cues.append((max(0.0, line["video"]), f"{clock(line['_at'])}  Hive: {hive[:160]}" + (f"\nMac: {bottom}" if bottom else "")))
    out = []
    for i, (at, text) in enumerate(cues):
        end = cues[i + 1][0] if i + 1 < len(cues) else (length or at + 5)
        end = max(end, at + 0.5)
        out.append(f"{i + 1}\n{_srt_time(at)} --> {_srt_time(end)}\n{text}\n")
    return "\n".join(out)


def _srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
