#!/usr/bin/env python3
"""Stands in for `codex app-server` in the tests. It answers the JSON-RPC calls the agent makes and
plays out each turn: a screenshot, one real call back to the agent's tools (wait, without a
screenshot, so nothing looks at your screen), some "work", then its final message, written a few
letters at a time as Codex streams it. turn/interrupt ends the turn early.

  FAKE_CODEX_LOG      file it appends to: {"started": thread} for each thread, {"thread", "prompt", "args",
                      "model", "tools", "instructions", "rules", "effort", "images", "tier"} for each turn,
                      {"tool_reply": ...} for each answer to its tool call, {"unsubscribed": thread} when
                      the agent lets a thread go
  FAKE_CODEX_SECONDS  how long the "work" takes (default 0.3); "60,0.3" for each turn in turn (the
                      last for the rest)
  FAKE_CODEX_REPLY    the final message

Like Codex, it refuses a turn on a thread whose last turn hasn't ended.
"""

import json
import os
import sys
import threading
from pathlib import Path
import uuid

LOG = os.environ["FAKE_CODEX_LOG"]
out_lock = threading.Lock()
threads: dict[str, dict] = {}
interrupted: dict[str, threading.Event] = {}
busy: set[str] = set()  # threads with a turn under way
pending: dict[int, list] = {}
counter = [0]
STORE = Path(os.environ.get("FAKE_CODEX_STORE", LOG + ".threads"))
STORE.mkdir(parents=True, exist_ok=True)


def record(entry: dict):
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def send(msg: dict):
    with out_lock:
        print(json.dumps(msg), flush=True)


def emit(method: str, params: dict):
    send({"method": method, "params": params})


def ask(method: str, params: dict) -> dict:
    counter[0] += 1
    waiter = pending[counter[0]] = [threading.Event(), None]
    send({"id": counter[0], "method": method, "params": params})
    waiter[0].wait(30)
    return (waiter[1] or {}).get("result") or {}


def seconds(turn: int) -> float:
    each = os.environ.get("FAKE_CODEX_SECONDS", "0.3").split(",")
    return float(each[min(turn, len(each)) - 1])


def end(thread_id: str, turn_id: str, status: str):
    busy.discard(thread_id)
    if status == "completed":
        threads[thread_id]["completedTurns"] = threads[thread_id].get("completedTurns", 0) + 1
    emit("turn/completed", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": status}})


def play(thread_id: str, turn_id: str):
    ids = {"threadId": thread_id, "turnId": turn_id}
    device = threads[thread_id]["dynamicTools"][0]["name"]
    emit("turn/started", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": "inProgress"}})
    shot = {"type": "dynamicToolCall", "id": "1", "namespace": device, "tool": "screenshot", "arguments": {}}
    emit("item/started", {**ids, "item": shot})
    emit("item/completed", {**ids, "item": {**shot, "success": True, "contentItems": []}})
    wait = {"type": "dynamicToolCall", "id": "2", "namespace": device, "tool": "wait",
            "arguments": {"seconds": 0.1, "screenshot": False}}
    emit("item/started", {**ids, "item": wait})
    reply = ask("item/tool/call", {**ids, "callId": "2", "namespace": device, "tool": "wait",
                                   "arguments": wait["arguments"]})
    record({"tool_reply": reply})
    emit("item/completed", {**ids, "item": {**wait, **reply}})
    crash_marker = STORE / "crashed-once"
    if os.environ.get("FAKE_CODEX_CRASH_ONCE") and not crash_marker.exists():
        crash_marker.write_text("crashed")
        os._exit(23)
    if interrupted[turn_id].wait(seconds(int(turn_id.split("-")[1]))):
        return end(thread_id, turn_id, "interrupted")
    text = os.environ.get("FAKE_CODEX_REPLY", "Calculator shows 408.")
    for i in range(0, len(text), 4):
        emit("item/agentMessage/delta", {**ids, "itemId": "3", "delta": text[i:i + 4]})
    emit("item/completed", {**ids, "item": {"type": "agentMessage", "id": "3", "text": text}})
    end(thread_id, turn_id, "completed")


def handle(msg: dict):
    method, params = msg.get("method"), msg.get("params") or {}
    if method is None:  # the agent answering our tool call
        waiter = pending.pop(msg["id"], None)
        if waiter:
            waiter[1] = msg
            waiter[0].set()
        return
    if "id" not in msg:
        return  # a notification ("initialized")
    result: dict = {}
    if method == "thread/start":
        thread_id = "thread-" + uuid.uuid4().hex
        threads[thread_id] = params
        if not params.get("ephemeral", False):
            (STORE / f"{thread_id}.json").write_text(json.dumps(params))
        record({"started": thread_id})
        result = {"thread": {"id": thread_id}, "model": "fake"}
    elif method == "thread/resume":
        thread_id = params["threadId"]
        record({"resumed": thread_id})
        path = STORE / f"{thread_id}.json"
        if os.environ.get("FAKE_CODEX_RESUME_ERROR") or not path.exists():
            return send({"id": msg["id"], "error": {"code": -32600, "message": "saved thread unavailable"}})
        threads[thread_id] = json.loads(path.read_text())
        result = {"thread": {"id": thread_id}, "model": "fake"}
    elif method == "thread/goal/get":
        if os.environ.get("FAKE_CODEX_GOAL"):
            done = threads[params["threadId"]].get("completedTurns", 0) >= 2
            result = {"goal": {"status": "complete" if done else "active"}}
        else:
            result = {"goal": None}
    elif method == "thread/read":
        result = {"thread": {"status": {"type": "active" if params["threadId"] in busy else "idle"}}}
    elif method == "turn/start" and params["threadId"] in busy:
        return send({"id": msg["id"], "error": {"code": -32600, "message": "a turn is already in progress"}})
    elif method == "turn/start":
        turn_id = f"turn-{len(interrupted) + 1}"
        interrupted[turn_id] = threading.Event()
        busy.add(params["threadId"])
        thread = threads[params["threadId"]]
        record({"thread": params["threadId"], "prompt": params["input"][0]["text"], "args": sys.argv[1:],
                "effort": params.get("effort"), "model": thread.get("model"),
                "tools": [ns["name"] for ns in thread["dynamicTools"]], "instructions": thread["baseInstructions"],
                "rules": thread.get("developerInstructions"), "images": len(params["input"]) - 1,
                "prior_prompts": list(thread.get("_history", [])),
                "tier": params.get("serviceTier") or thread.get("serviceTier")})
        thread.setdefault("_history", []).append(params["input"][0]["text"])
        if not thread.get("ephemeral", False):
            (STORE / f"{params['threadId']}.json").write_text(json.dumps(thread))
        threading.Thread(target=play, args=(params["threadId"], turn_id), daemon=True).start()
        result = {"turn": {"id": turn_id, "items": [], "status": "inProgress"}}
    elif method == "turn/interrupt":
        interrupted[params["turnId"]].set()
    elif method == "thread/unsubscribe":
        record({"unsubscribed": params["threadId"]})
        result = {"status": "unsubscribed"}
    send({"id": msg["id"], "result": result})


for line in sys.stdin:
    handle(json.loads(line))
