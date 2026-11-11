"""What the Agent Context panel (Agent menu → Show Agent Context, tools/app.swift) shows: this
session's conversation, grouped by request, with what was sent to the model under each, and what's
known about the model's context right now. The voice agent rewrites
sessions/<id>/panel.json a moment after anything is journaled or recorded; the panel reloads it.

It's built from two records the app keeps itself:
  journal.jsonl      what you said, what became of it, what the agent said and did (session_journal)
  context/*.json     each payload exchanged with Codex: the text and screenshots sent with each
                     request, tool calls and results, token counts (agent_context)
Neither is the model's exact current context: Codex holds that, with its own instructions, and
compacts (summarizes) it when it grows. The panel says so, gives the last token count Codex
reported, when it last compacted, and where Codex's full saved thread (the rollout file) is.

Screenshots aren't copied into panel.json: it counts them and points to the exact record.

    .venv/bin/python python/context_panel.py [SESSION_DIR]   # print the panel's data
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from resumable_thread import atomic_write, state_dir  # noqa: E402

DETAIL = 20_000  # characters of a detail kept in panel.json; the record has every one
SUMMARY = 240
MODEL_WINDOW = 272_000
GROUPS = 60  # the latest requests; older ones are in the journal

CONVERSATION = {"you said", "agent said", "say", "done", "failed", "error", "action", "dictation",
                "ingest started", "ingest part", "ingest done", "voice left out", "lip reading"}
NOTICE = ("What this app sent to and got from the model, as it happened. It is not "
          "the model's exact current context, which Codex holds and can't be observed from here: Codex "
          "adds its own instructions and summarizes (compacts) the conversation as it grows, after which "
          "the model has the summary rather than these words.")


def short(text: str, n: int = SUMMARY) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n - 1] + "…"


def detail(text: str) -> str:
    text = str(text)
    if len(text) <= DETAIL:
        return text
    return text[:DETAIL] + f"\n\n… {len(text) - DETAIL:,} more characters in the exact record."


def count_images(value) -> int:
    if isinstance(value, str):
        return int(value.startswith("data:image/"))
    if isinstance(value, list):
        return sum(count_images(v) for v in value)
    if isinstance(value, dict):
        if value.get("type") == "image" or value.get("type") == "inputImage":
            return 1
        return sum(count_images(v) for v in value.values())
    return 0


def texts(value) -> list[str]:
    """The text in a payload's content items, leaving images out."""
    if isinstance(value, list):
        return [t for v in value for t in texts(v)]
    if isinstance(value, dict):
        if value.get("type") in ("text", "inputText", "outputText") and isinstance(value.get("text"), str):
            return [value["text"]]
        return [t for k, v in value.items() if k not in ("url", "data", "image_url") for t in texts(v)]
    return []


def summarize_record(record: dict) -> dict | None:
    """One recorded payload as a panel item, or None for bookkeeping the panel leaves out. Also
    {"tokens": n} / {"compacted": True} for what it says about the model's context."""
    kind, payload = record.get("kind", ""), record.get("payload") or {}
    item = {"time": record.get("time", 0), "lane": "input", "kind": kind, "task": record.get("task")}
    if kind == "turn/start input":
        body = "\n".join(texts(payload.get("input")))
        images = count_images(payload.get("input"))
        label = "Sent to the model with the request" + (f" · {images} screenshot" + "s" * (images > 1) if images else "")
        return {**item, "label": label, "summary": short(body), "detail": detail(body), "images": images}
    if kind == "tool input":
        args = json.dumps(payload.get("arguments") or {}, ensure_ascii=False)
        name = f"{payload.get('namespace') or ''}.{payload.get('tool')}".strip(".")
        return {**item, "label": f"Tool call · {name}", "summary": short(args), "detail": detail(args)}
    if kind == "tool output":
        result = payload.get("result") or {}
        body = "\n".join(texts(result.get("contentItems")))
        images = count_images(result.get("contentItems"))
        label = "Tool result" + (" (failed)" if result.get("success") is False else "") + \
            (f" · {images} screenshot" + "s" * (images > 1) if images else "")
        return {**item, "label": label, "summary": short(body) or "(no text)", "detail": detail(body), "images": images}
    if kind == "thread/tokenUsage/updated":
        last = (payload.get("tokenUsage") or {}).get("last") or {}
        total = (payload.get("tokenUsage") or {}).get("modelContextWindow")
        return {"tokens": last.get("inputTokens", 0) + last.get("outputTokens", 0), "window": total,
                "time": item["time"]}
    if kind in ("item/started", "item/completed"):
        it = payload.get("item") or {}
        if it.get("type") == "contextCompaction":
            if kind == "item/started":
                return {**item, "lane": "conversation", "label": "Codex compacted the conversation",
                        "summary": "From here the model has a summary of what came before, not the words.",
                        "compacted": True}
            return None
        if kind == "item/completed" and it.get("type") == "agentMessage" and it.get("text"):
            return {**item, "label": "The model's reply", "summary": short(it["text"]), "detail": detail(it["text"])}
        return None
    if kind in ("session connected", "thread/resume output", "thread/start output", "thread/resume input",
                "thread/start input"):
        body = json.dumps(payload, ensure_ascii=False)[:2000]
        return {**item, "label": "Codex thread · " + kind, "summary": short(record.get("threadId") or ""),
                "detail": detail(body)}
    if kind == "error":
        return {**item, "lane": "conversation", "label": "Codex error", "summary": short(json.dumps(payload))}
    return None


ICON = {"you said": "🗣", "say": "💬", "agent said": "💬", "done": "✅", "failed": "❌", "error": "⚠️",
        "action": "→", "dictation": "✍️", "ingest started": "📥", "ingest part": "📥", "ingest done": "📥",
        "voice left out": "🔇", "lip reading": "📷"}


def journal_item(entry: dict) -> dict:
    kind = entry.get("kind", "")
    text = entry.get("text", "")
    extra = {k: v for k, v in entry.items() if k not in ("time", "kind", "text")}
    label = {"you said": "You said", "say": "Agent said", "agent said": "Agent said", "done": "Done",
             "failed": "Failed", "error": "Error", "action": "Did", "dictation": "Dictated",
             "ingest started": "Adding text to context", "ingest part": "Part",
             "ingest done": "Added text", "voice left out": "Left out its own voice",
             "lip reading": "Lip reading"}.get(kind, kind)
    if kind == "you said" and entry.get("outcome") not in (None, "request"):
        label += f" ({entry['outcome']})"
    if kind == "ingest started":
        text = f"“{text}”: {entry.get('chars', 0):,} characters, about {entry.get('tokens_estimated', 0):,} " \
               f"tokens (estimated), {entry.get('parts')} parts, {entry.get('mode')}"
    return {"time": entry.get("time", 0), "lane": "conversation", "kind": kind, "icon": ICON.get(kind, "·"),
            "label": label, "summary": short(text, 600), "detail": detail(json.dumps(extra, ensure_ascii=False,
                                                                                     indent=1)) if extra else "",
            "status": entry.get("status")}


class Builder:
    """Keeps record summaries between builds: a record (with its screenshots) is read once."""

    def __init__(self, session_dir: Path, context_dir: Path | None = None):
        self.session_dir = Path(session_dir)
        self.context_dir = Path(context_dir) if context_dir else state_dir() / "context"
        self._seen: dict[str, dict | None] = {}

    def records(self, session_id: str, since: float) -> list[tuple[str, dict]]:
        out = []
        if not self.context_dir.exists():
            return out
        floor = f"{int(since * 1e9) - int(5e9):020d}"  # names start with the time in ns
        for path in sorted(self.context_dir.glob("[0-9]*.json")):
            if path.name < floor:
                continue
            if path.name not in self._seen:
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue  # being written
                summary = summarize_record(record) if record.get("session") == session_id else None
                if summary is not None:
                    summary["record"] = str(path.with_suffix(".html"))
                self._seen[path.name] = summary
            if self._seen[path.name] is not None:
                out.append((path.name, self._seen[path.name]))
        return out

    def build(self) -> dict:
        import session_journal
        manifest = json.loads((self.session_dir / "manifest.json").read_text(encoding="utf-8"))
        entries = session_journal.read(self.session_dir)
        session = manifest["session"]
        groups: list[dict] = [{"title": "Session started", "time": manifest.get("started", 0), "kind": "session",
                               "items": []}]
        by_task: dict[str, dict] = {}
        for entry in entries:
            kind = entry.get("kind")
            if kind == "request":
                group = {"title": entry.get("text", ""), "time": entry["time"], "kind": "request",
                         "device": entry.get("device"), "status": "running", "items": []}
                groups.append(group)
                by_task[entry.get("text", "")] = group
                continue
            if kind == "ingest started":
                groups.append({"title": "Added: " + entry.get("text", ""), "time": entry["time"], "kind": "ingest",
                               "status": "running", "items": []})
            if kind not in CONVERSATION:
                continue
            group = by_task.get(entry.get("request")) if entry.get("request") else None
            if group is None:
                if kind == "you said" and entry.get("outcome") == "request":
                    group = {"title": entry.get("text", ""), "time": entry["time"], "kind": "pending", "items": []}
                    groups.append(group)  # its "request" entry comes next and takes its place
                else:
                    group = groups[-1]
            if group.get("kind") == "pending" and kind != "you said":
                group = groups[-1]
            group["items"].append(journal_item(entry))
            if kind in ("done", "failed") and group.get("kind") == "request":
                group["status"] = kind
            if kind == "ingest done":
                group["status"] = entry.get("status")
        # A "you said … request" placeholder followed by its request: fold the words into the request.
        folded = []
        for group in groups:
            if folded and folded[-1].get("kind") == "pending" and group.get("kind") == "request":
                group["items"] = folded.pop()["items"] + group["items"]
            folded.append(group)
        groups = [g for g in folded if g.get("kind") != "pending" or g["items"]]

        model = {"tokens": None, "window": MODEL_WINDOW, "measured_at": None, "compacted_at": None}
        try:
            from agent import COMPACT_AT
        except Exception:
            COMPACT_AT = 150_000
        model["compact_at"] = COMPACT_AT
        requests = [g for g in groups if g.get("kind") in ("request", "ingest")]
        for _, item in self.records(session, manifest.get("started", 0)):
            if "tokens" in item and "lane" not in item:
                model.update(tokens=item["tokens"], measured_at=item["time"],
                             window=item.get("window") or model["window"])
                continue
            if item.get("compacted"):
                model["compacted_at"] = item["time"]
            target = by_task.get(item.get("task")) if item.get("task") else None
            if target is None:  # by time: the last request that had started by then
                target = next((g for g in reversed(requests) if g["time"] <= item["time"] + 1), groups[0])
            target["items"].append({k: v for k, v in item.items() if k != "task"})
        for group in groups:
            group["items"].sort(key=lambda i: i.get("time", 0))
            group["inputs"] = sum(i.get("lane") == "input" for i in group["items"])
        groups = groups[:1] + groups[1:][-GROUPS:]
        threads = manifest.get("threads") or []
        return {"version": 1, "session": session, "started": manifest.get("started"), "updated": time.time(),
                "ended": manifest.get("ended"), "code": manifest.get("code"), "backend": manifest.get("backend"),
                "notice": NOTICE, "model_context": {**model, "threads": threads,
                                                    "note": self.model_note(model, threads)},
                "groups": groups, "journal": str(self.session_dir / "journal.jsonl"),
                "context_index": str(self.context_dir / "index.html")}

    @staticmethod
    def model_note(model: dict, threads: list) -> str:
        parts = []
        if model["tokens"]:
            parts.append(f"Codex last reported {model['tokens']:,} tokens in the model's context "
                         f"(of {model['window']:,}); it compacts past about {model['compact_at']:,}.")
        else:
            parts.append("Codex hasn't reported the context size in this session yet.")
        if model["compacted_at"]:
            parts.append("It compacted at " + time.strftime("%H:%M:%S", time.localtime(model["compacted_at"]))
                         + ": what came before is a summary to the model now.")
        if threads:
            parts.append("Codex's own full record of the thread: " + (threads[-1].get("rollout") or "(not found)"))
        return " ".join(parts)

    def write(self) -> Path:
        path = self.session_dir / "panel.json"
        atomic_write(path, json.dumps(self.build(), ensure_ascii=False))
        os.chmod(path, 0o600)
        return path


def main(argv: list[str]) -> int:
    import session_journal
    session = Path(argv[0]) if argv else session_journal.find(None)
    print(json.dumps(Builder(session).build(), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
