"""Local, durable viewer of payloads actually exchanged with the agent.

One JSON and HTML record per event; the lightweight index refreshes independently
of an open record. No server, remote assets, JavaScript, or browser launch required.
"""
from __future__ import annotations

import html
import json
from pathlib import Path
import re
import threading
import time
import uuid

from resumable_thread import atomic_write, state_dir

_lock = threading.Lock()
IMAGE = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+\Z")
STYLE = "body{font:16px system-ui;margin:32px;max-width:1100px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:16px;color:#111}img{max-width:100%;height:auto}li{margin:12px 0}a{color:#1466ba}"


def page(title, body, refresh=False):
    return ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
            'img-src data:; style-src \'unsafe-inline\'">'
            + ('<meta http-equiv="refresh" content="5">' if refresh else '')
            + f'<title>{html.escape(title)}</title><style>{STYLE}</style></head><body>'
            + f'<h1>{html.escape(title)}</h1>{body}</body></html>')


def render_payload(payload):
    images = []

    def display(value):
        if isinstance(value, str) and IMAGE.fullmatch(value):
            images.append(value)
            return f"[Screenshot {len(images)}; exact bytes in JSON]"
        if isinstance(value, list):
            return [display(v) for v in value]
        if isinstance(value, dict):
            # MCP/Claude image blocks, as well as Codex data URLs.
            if value.get("type") == "image":
                source = value.get("source") or value
                mime = source.get("media_type") or source.get("mimeType")
                data = source.get("data")
                if mime and isinstance(data, str):
                    url = f"data:{mime};base64,{data}"
                    if IMAGE.fullmatch(url):
                        return {"type": "image", "preview": display(url)}
            return {k: display(v) for k, v in value.items()}
        return value

    text = html.escape(json.dumps(display(payload), ensure_ascii=False, indent=2))
    return f"<pre>{text}</pre>" + "".join(
        f'<figure><figcaption>Screenshot {n}</figcaption><img alt="Screenshot {n}" src="{html.escape(url, quote=True)}"></figure>'
        for n, url in enumerate(images, 1))


class ContextLog:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else state_dir() / "context"
        self.index = self.directory / "index.html"

    def record(self, kind, payload, *, task=None, thread=None):
        with _lock:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            name = f"{time.time_ns():020d}-{uuid.uuid4().hex}"
            import session_journal
            journal = session_journal.current
            record = {"time": time.time(), "kind": kind, "task": task,
                      "session": journal.id if journal else None,
                      "threadId": thread, "payload": payload}
            atomic_write(self.directory / f"{name}.json", json.dumps(record, ensure_ascii=False))
            body = (f'<p><a href="index.html">All context</a> · <a href="{name}.json">Exact JSON payload</a></p>'
                    + render_payload(record))
            atomic_write(self.directory / f"{name}.html", page(kind, body))
            title = time.strftime("%Y-%m-%d %H:%M:%S") + " · " + kind
            if thread:
                title += " · " + thread
            atomic_write(self.directory / f"{name}.title", title)
            # Read small labels, not historical screenshot payloads, for the index.
            links = []
            for entry in sorted(self.directory.glob("[0-9]*.html"), reverse=True):
                label = entry.with_suffix(".title")
                title = label.read_text(encoding="utf-8") if label.exists() else entry.stem
                links.append(f'<li><a href="{entry.name}">{html.escape(title)}</a></li>')
            atomic_write(self.index, page("Agent context", '<p><a href="../sessions/index.html">Sessions: '
                         'everything you said and the agent did, one run of the app at a time</a></p><p>Exact app-visible instructions, requests, '
                         'screenshots, tool inputs/outputs and server events, newest first. '
                         'This is an event history, not hidden reasoning or a reconstruction of the '
                         'model’s current context after compaction. The index refreshes every 5 seconds.</p>'
                         + '<ol>' + ''.join(links) + '</ol>', refresh=True))
        if journal:
            journal.touch()  # the Agent Context panel shows it
        return str(self.index)
