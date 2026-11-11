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
        _journal_operation("initialize", directory=str(self.dir))
        self.error: str | None = None
        self._lock = threading.Lock()
        self._entries: list[dict] = []
        self._threads: list[str] = []
        self.manifest = {"session": self.id, "started": started, "ended": None, "pid": os.getpid(),
                         "code": git_commit(), **(about or {}), "threads": []}
        self._journal = open(self.dir / "journal.jsonl", "a", buffering=1, encoding="utf-8")
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
                _append_journal(self._journal, json.dumps(entry, ensure_ascii=False) + "\n")
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
        threads = [{"thread": t, "rollout": rollout_for(t)} for t in self._threads]
        self.manifest["threads"] = threads
        _journal_operation("save_manifest", directory=str(self.dir), manifest=self.manifest, threads=threads)

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
def _append_journal(stream, text: str):
    # Pass only a duplicate descriptor into the helper; the owner keeps the stream.
    reader = Path(HERE).parent / "build/agent-journal-reader"
    fd = stream.fileno()  # Raises on a closed stream, as the previous writer did.
    result = subprocess.run([str(reader), "--append", str(fd)], input=text.encode("utf-8"),
                            pass_fds=(fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            check=False)
    if result.returncode:
        raise OSError("Journal append failed")


def _journal_operation(op: str, **values):
    reader = Path(HERE).parent / "build/agent-journal-reader"
    result = subprocess.run([str(reader), "--render"], input=json.dumps({"op": op, **values}, ensure_ascii=False),
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("Could not render session journal")
    return json.loads(result.stdout)


def _render(op: str, **values) -> str:
    rendered = _journal_operation(op, **values)
    if not isinstance(rendered, str):
        raise ValueError("Invalid journal renderer response")
    return rendered


def line(entry: dict) -> str:
    return _render("line", entry=entry)


def read(session: Path) -> list[dict]:
    """Read durable JSONL entries using the Rust journal reader."""
    reader = Path(HERE).parent / "build/agent-journal-reader"
    result = subprocess.run([str(reader), str(session)], capture_output=True, text=True, check=False)
    if result.returncode:
        raise OSError("Could not read session journal")
    entries = json.loads(result.stdout)
    if not isinstance(entries, list):
        raise ValueError("Invalid journal reader response")
    return entries


def session_page(manifest: dict, entries: list[dict]) -> str:
    return _render("session_page", manifest=manifest, entries=entries)


def write_sessions_page(directory: Path):
    atomic_write(directory / "index.html", _render("sessions_page", directory=str(directory)))


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
