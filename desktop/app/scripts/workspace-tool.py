#!/usr/bin/env python3
"""Call the personal-agent's existing virtual-workspace tools from a local task.

  python scripts/workspace-tool.py list
  python scripts/workspace-tool.py call spaceo_session_list '{}'
"""
import base64
import json
import os
import socket
import sys
import tempfile
from pathlib import Path

STATE = Path.home() / "Library/Application Support/Personal Agent"
SOCKET = STATE / "control/workspace.sock"
MAX_RESPONSE = 64 * 1024 * 1024


def call(request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(50)
        client.connect(str(SOCKET))
        client.sendall((json.dumps(request) + "\n").encode())
        output = bytearray()
        while b"\n" not in output:
            part = client.recv(65536)
            if not part:
                raise RuntimeError("Workspace connection closed before replying")
            output.extend(part)
            if len(output) > MAX_RESPONSE:
                raise RuntimeError("Workspace response was too large")
    return json.loads(output.split(b"\n", 1)[0])


def materialize_images(value):
    for content in value.get("result", {}).get("content", []):
        if content.get("type") != "image":
            continue
        mime = content.get("mimeType", "")
        if mime not in ("image/png", "image/jpeg"):
            raise ValueError("Unexpected workspace image format")
        directory = STATE / "captures"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(prefix="workspace-", suffix=".png" if mime == "image/png" else ".jpg",
                                         dir=directory, delete=False) as image:
            image.write(base64.b64decode(content.pop("data"), validate=True))
        content.update({"type": "text", "text": "Workspace image saved at " + image.name})


def main(args):
    if args == ["status"]:
        request = {"method": "status"}
    elif args == ["list"]:
        request = {"method": "list"}
    elif len(args) == 3 and args[0] == "call":
        request = {"name": args[1], "arguments": json.loads(args[2])}
    else:
        raise ValueError("Use: workspace-tool.py status | list | call TOOL '{JSON arguments}'")
    result = call(request)
    materialize_images(result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") and not result.get("result", {}).get("isError") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)
