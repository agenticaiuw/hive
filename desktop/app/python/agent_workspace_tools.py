"""Workspace and personal-memory operations called by the agent's host process."""
import json
import os
import socket
import sqlite3
import subprocess
from pathlib import Path

STATE = Path.home() / "Library/Application Support/Personal Agent"
MAX_RESPONSE = 64 * 1024 * 1024
MEMORY_STORE = Path(__file__).resolve().parent.parent / "build/agent-memory-store"
WORKSPACE_CLIENT = Path(__file__).resolve().parent.parent / "build/agent-workspace-client"


def workspace(value):
    if WORKSPACE_CLIENT.is_file() and os.access(WORKSPACE_CLIENT, os.X_OK):
        completed = subprocess.run([str(WORKSPACE_CLIENT), str(STATE / "control/workspace.sock")],
                                   input=json.dumps(value), capture_output=True, text=True, check=False)
        if completed.returncode:
            raise RuntimeError("Workspace request failed; check agent availability")
        response = json.loads(completed.stdout)
        return _workspace_result(response)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(50)
        client.connect(str(STATE / "control/workspace.sock"))
        client.sendall((json.dumps(value) + "\n").encode())
        data = bytearray()
        while b"\n" not in data:
            part = client.recv(65536)
            if not part:
                raise RuntimeError("Workspace connection closed before replying")
            data.extend(part)
            if len(data) > MAX_RESPONSE:
                raise RuntimeError("Workspace reply exceeds the size limit")
    response = json.loads(data.split(b"\n", 1)[0])
    return _workspace_result(response)


def _workspace_result(response):
    if not response.get("ok"):
        return {"isError": True, "content": [{"type": "text", "text": response.get("error", "Workspace unavailable")}]}
    result = response.get("result", {})
    if "tools" in result:
        return {"content": [{"type": "text", "text": json.dumps(result["tools"], ensure_ascii=False)}]}
    return result


def memory(value, state=STATE):
    """Store sourced, editable memories without requiring the model's shell access."""
    op = value.get("op")
    if op not in ("list", "add"):
        raise ValueError("Memory operation must be list or add")
    directory = state / "memory"
    database = directory / "personal-memory.sqlite3"
    if op == "list" and not database.exists():
        return {"content": [{"type": "text", "text": "No memories stored yet."}]}
    if op == "add":
        statement, source, kind = value.get("statement"), value.get("source"), value.get("kind")
        if not isinstance(statement, str) or not statement.strip() or len(statement) > 2000:
            raise ValueError("A statement of at most 2000 characters is required")
        if not isinstance(source, str) or not source.strip() or len(source) > 1024:
            raise ValueError("A source of at most 1024 characters is required")
        if kind not in ("fact", "inference", "question"):
            raise ValueError("kind must be fact, inference, or question")
    if MEMORY_STORE.is_file() and os.access(MEMORY_STORE, os.X_OK):
        completed = subprocess.run([str(MEMORY_STORE), str(state)], input=json.dumps(value),
                                   capture_output=True, text=True, check=False)
        if completed.returncode:
            raise RuntimeError("Memory store unavailable")
        return json.loads(completed.stdout)
    if op == "add":
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        fd = os.open(database, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
    with sqlite3.connect(database, timeout=5) as db:
        db.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, statement TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(statement, source, kind))")
        if op == "add":
            db.execute("INSERT OR IGNORE INTO memories(statement, source, kind) VALUES (?, ?, ?)",
                       (statement.strip(), source.strip(), kind))
        rows = db.execute("SELECT id, statement, source, kind, observed_at FROM memories ORDER BY id DESC LIMIT 100").fetchall()
    return {"content": [{"type": "text", "text": json.dumps(rows, ensure_ascii=False)}]}
