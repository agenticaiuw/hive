#!/usr/bin/env python3
"""Stands in for `codex exec --json` in the tests: records its prompt, prints a tool call and a
final message as JSONL, and writes the final message to the -o file.

  FAKE_CODEX_LOG      file to append {"prompt": ..., "args": [...]} to
  FAKE_CODEX_SECONDS  how long the "work" takes (default 0.3)
  FAKE_CODEX_REPLY    the final message
"""

import json
import os
import sys
import time

args = sys.argv[1:]
with open(os.environ["FAKE_CODEX_LOG"], "a") as f:
    f.write(json.dumps({"prompt": args[-1], "args": args}) + "\n")


def emit(event):
    print(json.dumps(event), flush=True)


emit({"type": "thread.started", "thread_id": "fake"})
emit({"type": "item.started", "item": {"type": "mcp_tool_call", "tool": "screenshot", "arguments": {}}})
emit({"type": "item.completed", "item": {"type": "mcp_tool_call", "tool": "screenshot", "result": {"content": []}}})
time.sleep(float(os.environ.get("FAKE_CODEX_SECONDS", "0.3")))
reply = os.environ.get("FAKE_CODEX_REPLY", "Calculator shows 408.")
emit({"type": "item.completed", "item": {"type": "agent_message", "text": reply}})
with open(args[args.index("-o") + 1], "w") as f:
    f.write(reply)
emit({"type": "turn.completed"})
