"""The session journal: everything said in one run of the voice agent, saved as it happens, for
reviewing and improving the agent later (a self-evolving harness reads these).

Each run of the voice agent (from opening Agent.app to quitting it) is a session, in
    ~/Library/Application Support/Personal Agent/sessions/<started>-<pid>/
  journal.jsonl   one JSON object per line, in order: every transcript of what you said and what
                  became of it (a request, "stop", a filler, its own voice, ...), each request with
                  its device and Codex thread, everything the agent did, said and showed, errors,
                  and how each task ended. Appended and flushed line by line, so a crash keeps it.
  manifest.json   when it started, the backend and model, the git commit of the code, and every
                  Codex thread it used, with the path of that thread's full saved context
  index.html      the same, readable (Agent menu → Show Agent Context → Sessions)

The full model context of a Codex thread (base and developer instructions, every input with its
screenshots, tool calls and their results, the replies) is Codex's own rollout file,
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl, which the manifest points to; the
context viewer (agent_context.py) has each payload the app exchanged, tagged with the session.

    .venv/bin/python python/session_journal.py              # the sessions, newest first
    .venv/bin/python python/session_journal.py show [ID]    # one session (default: the latest), readable
    .venv/bin/python python/session_journal.py paths [ID]   # its files and its Codex rollouts

What you dictate into other apps (hold fn) is yours, not a request: only how many words is saved,
unless AGENT_JOURNAL_DICTATION=1.
"""

from __future__ import annotations

import glob
import html
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from resumable_thread import atomic_write, state_dir  # noqa: E402

current: "SessionJournal | None" = None  # this process's session, for the context viewer to tag records with


def sessions_dir() -> Path:
    return state_dir() / "sessions"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def rollout_for(thread: str) -> str | None:
    """The file Codex keeps a thread's full context in."""
    found = glob.glob(str(codex_home() / "sessions" / "*" / "*" / "*" / f"rollout-*-{thread}.jsonl"))
    return found[0] if found else None


def git_commit() -> str:
    try:
        root = os.path.dirname(HERE)
        commit = subprocess.run(["git", "-C", root, "rev-parse", "--short", "HEAD"], capture_output=True,
                                text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
                               capture_output=True, text=True, timeout=5).stdout.strip()
        return commit + (" (with uncommitted changes)" if dirty else "")
    except Exception:
        return "unknown"


class SessionJournal:
    def __init__(self, about: dict | None = None, directory: Path | None = None):
        started = time.time()
        self.id = time.strftime("%Y%m%d-%H%M%S", time.localtime(started)) + f"-{os.getpid()}"
        self.dir = Path(directory) if directory else sessions_dir() / self.id
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.dir.parent, 0o700)  # (mkdir's mode applies only to the last folder)
        self.error: str | None = None
        self._lock = threading.Lock()
        self._entries: list[dict] = []
        self._threads: list[str] = []
        self.manifest = {"session": self.id, "started": started, "ended": None, "pid": os.getpid(),
                         "code": git_commit(), **(about or {}), "threads": []}
        self._journal = open(self.dir / "journal.jsonl", "a", buffering=1, encoding="utf-8")
        os.chmod(self.dir / "journal.jsonl", 0o600)
        self._save_manifest()
        self._changed = threading.Event()
        self._panel = None  # context_panel.Builder, made by the panel's thread
        self.panel_error: str | None = None
        self.add("session started", **(about or {}))
        self._link_latest()
        threading.Thread(target=self._keep_panel, daemon=True).start()

    @property
    def panel_path(self) -> Path:
        return self.dir / "panel.json"

    def touch(self):
        """Something new to show in the Agent Context panel (a journal line, a context record)."""
        self._changed.set()

    def _keep_panel(self):
        """Rewrites panel.json at most twice a second, while there's something new."""
        import context_panel
        while True:
            self._changed.wait()
            time.sleep(0.5)  # let a burst of events land first
            self._changed.clear()
            try:
                if self._panel is None:
                    self._panel = context_panel.Builder(self.dir)
                self._panel.write()
                self.panel_error = None
            except Exception as e:  # the panel must never break the agent
                self.panel_error = f"{type(e).__name__}: {e}"

    # -- writing ------------------------------------------------------------------------------
    def add(self, kind: str, text: str = "", **fields) -> dict:
        """Saves one thing that happened. Never raises: the journal must not break the agent."""
        entry = {"time": time.time(), "kind": kind, "text": text,
                 **{k: v for k, v in fields.items() if v is not None}}
        try:
            with self._lock:
                self._journal.write(json.dumps(entry, ensure_ascii=False) + "\n")
                self._journal.flush()
                os.fsync(self._journal.fileno())
                self._entries.append(entry)
                thread = fields.get("thread")
                if thread and thread not in self._threads:
                    self._threads.append(thread)
                    self._save_manifest()
                self._write_page()
            self.touch()
        except Exception as e:  # a full disk, say: say so once, carry on
            self.error = self.error or f"{type(e).__name__}: {e}"
        return entry

    def end(self):
        self.add("session ended")
        with self._lock:
            self.manifest["ended"] = time.time()
            try:
                self._save_manifest()
                self._journal.close()
                self.touch()
            except Exception as e:
                self.error = self.error or str(e)

    def _save_manifest(self):
        self.manifest["threads"] = [{"thread": t, "rollout": rollout_for(t)} for t in self._threads]
        atomic_write(self.dir / "manifest.json", json.dumps(self.manifest, ensure_ascii=False, indent=2))

    def _link_latest(self):
        latest = self.dir.parent / "latest"
        try:
            if latest.is_symlink() or latest.exists():
                latest.unlink()
            latest.symlink_to(self.dir.name)
        except OSError:
            pass
        write_sessions_page(self.dir.parent)

    def _write_page(self):
        atomic_write(self.dir / "index.html", session_page(self.manifest, self._entries))


# -- reading ----------------------------------------------------------------------------------
LABELS = {"you said": "🗣", "agent said": "💬", "agent spoke": "🔊", "action": "→", "error": "✗",
          "done": "✅", "failed": "❌", "request": "▶", "dictation": "✍️"}


def line(entry: dict) -> str:
    when = time.strftime("%H:%M:%S", time.localtime(entry["time"]))
    kind, text = entry["kind"], entry.get("text", "")
    extra = {k: v for k, v in entry.items() if k not in ("time", "kind", "text")}
    detail = "  " + json.dumps(extra, ensure_ascii=False) if extra else ""
    return f"{when}  {LABELS.get(kind, '·')} {kind}: {text}{detail}"


def read(session: Path) -> list[dict]:
    entries = []
    with open(session / "journal.jsonl", encoding="utf-8") as f:
        for raw in f:
            try:
                entries.append(json.loads(raw))
            except ValueError:  # a line cut off by a crash
                pass
    return entries


STYLE = ("body{font:15px system-ui;margin:32px;max-width:1100px}li{margin:6px 0;white-space:pre-wrap;"
         "overflow-wrap:anywhere}code{background:#eee;color:#111;padding:1px 4px}a{color:#1466ba}")


def page(title: str, body: str) -> str:
    return ('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
            "content=\"default-src 'none'; style-src 'unsafe-inline'\"><meta http-equiv=\"refresh\" content=\"5\">"
            f"<title>{html.escape(title)}</title><style>{STYLE}</style></head><body><h1>{html.escape(title)}</h1>"
            f"{body}</body></html>")


def session_page(manifest: dict, entries: list[dict]) -> str:
    threads = "".join(f"<li>Codex thread <code>{html.escape(t['thread'])}</code>: full context in "
                      f"<code>{html.escape(t['rollout'] or '(not saved yet)')}</code></li>"
                      for t in manifest.get("threads", []))
    body = (f'<p><a href="../index.html">All sessions</a> · <a href="journal.jsonl">journal.jsonl</a> · '
            f'<a href="manifest.json">manifest.json</a> · <a href="../../context/index.html">Every payload '
            f'(context viewer)</a></p><p>Code: <code>{html.escape(str(manifest.get("code")))}</code></p>'
            f'<ul>{threads}</ul><ol>' + "".join(f"<li>{html.escape(line(e))}</li>" for e in entries) + "</ol>")
    return page(f"Session {manifest['session']}", body)


def write_sessions_page(directory: Path):
    items = []
    for session in sorted((p for p in directory.iterdir() if p.is_dir() and not p.is_symlink()), reverse=True):
        try:
            manifest = json.loads((session / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        items.append(f'<li><a href="{html.escape(session.name)}/index.html">{html.escape(session.name)}</a> '
                     f'· {html.escape(str(manifest.get("backend", "")))}</li>')
    atomic_write(directory / "index.html", page("Agent sessions", "<ol>" + "".join(items) + "</ol>"))


def find(session_id: str | None) -> Path:
    base = sessions_dir()
    if not session_id:
        return (base / "latest").resolve()
    matches = sorted(p for p in base.glob(f"{session_id}*") if p.is_dir())
    if not matches:
        raise SystemExit(f"No session {session_id!r} in {base}")
    return matches[-1]


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "list"
    if command == "list":
        base = sessions_dir()
        for session in sorted((p for p in base.glob("*") if p.is_dir() and not p.is_symlink()), reverse=True):
            entries = read(session)
            said = sum(e["kind"] == "you said" for e in entries)
            print(f"{session.name}  {said} things you said, {len(entries)} entries")
        return 0
    session = find(argv[1] if len(argv) > 1 else None)
    if command == "show":
        for entry in read(session):
            print(line(entry))
        return 0
    if command == "paths":
        manifest = json.loads((session / "manifest.json").read_text(encoding="utf-8"))
        print(f"journal:  {session / 'journal.jsonl'}\nmanifest: {session / 'manifest.json'}\n"
              f"page:     {session / 'index.html'}\ncontext:  {state_dir() / 'context/index.html'}")
        for t in manifest.get("threads", []):
            print(f"codex thread {t['thread']}: {rollout_for(t['thread']) or '(no rollout found)'}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
