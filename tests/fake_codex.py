#!/usr/bin/env python3
"""Stands in for `codex app-server` in the tests. It answers the JSON-RPC calls the agent makes and
plays out each turn: a screenshot, one real call back to the agent's tools (wait, without a
screenshot, so nothing looks at your screen), some "work", then its final message. turn/interrupt
ends the turn early.

  FAKE_CODEX_LOG      file it appends to: {"prompt", "args", "tools", "instructions", "effort"} for
                      each task, {"tool_reply": ...} for each answer to its tool call
  FAKE_CODEX_SECONDS  how long the "work" takes (default 0.3)
  FAKE_CODEX_REPLY    the final message
"""

import json
import os
import sys
import threading

LOG = os.environ["FAKE_CODEX_LOG"]
out_lock = threading.Lock()
threads: dict[str, dict] = {}
interrupted: dict[str, threading.Event] = {}
pending: dict[int, list] = {}
counter = [0]


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
    if interrupted[turn_id].wait(float(os.environ.get("FAKE_CODEX_SECONDS", "0.3"))):
        emit("turn/completed", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": "interrupted"}})
        return
    text = os.environ.get("FAKE_CODEX_REPLY", "Calculator shows 408.")
    emit("item/completed", {**ids, "item": {"type": "agentMessage", "id": "3", "text": text}})
    emit("turn/completed", {"threadId": thread_id, "turn": {"id": turn_id, "items": [], "status": "completed"}})


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
        thread_id = f"thread-{len(threads) + 1}"
        threads[thread_id] = params
        result = {"thread": {"id": thread_id}, "model": "fake"}
    elif method == "turn/start":
        turn_id = f"turn-{len(interrupted) + 1}"
        interrupted[turn_id] = threading.Event()
        thread = threads[params["threadId"]]
        record({"prompt": params["input"][0]["text"], "args": sys.argv[1:], "effort": params.get("effort"),
                "tools": [ns["name"] for ns in thread["dynamicTools"]], "instructions": thread["baseInstructions"],
                "images": len(params["input"]) - 1})
        threading.Thread(target=play, args=(params["threadId"], turn_id), daemon=True).start()
        result = {"turn": {"id": turn_id, "items": [], "status": "inProgress"}}
    elif method == "turn/interrupt":
        interrupted[params["turnId"]].set()
    send({"id": msg["id"], "result": result})


for line in sys.stdin:
    handle(json.loads(line))
