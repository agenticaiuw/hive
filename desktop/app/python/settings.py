"""Settings from the .env file at the top of the repo: KEY=value lines, # comments.

A value set in .env wins over the same variable in your shell, so the key you put there is the
one used; empty values are skipped. AGENT_ENV_FILE points somewhere else (the tests use it).

    python3 python/settings.py has TTS_VOICE     exit status 0 when it's set
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUST_SETTINGS = os.path.join(ROOT, "build/hive-settings-reader")
from_file: set[str] = set()  # the variables that came from .env


def load(path: str | None = None):
    path = path or os.environ.get("AGENT_ENV_FILE") or os.path.join(ROOT, ".env")
    if os.path.isfile(RUST_SETTINGS) and os.access(RUST_SETTINGS, os.X_OK):
        result = subprocess.run([RUST_SETTINGS, path], capture_output=True, text=True, check=False)
        if result.returncode:
            raise RuntimeError("Settings could not be read")
        for key, value in json.loads(result.stdout):
            os.environ[key] = value
            from_file.add(key)
        return
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if value:
            os.environ[key] = value
            from_file.add(key)


def fix_newlines():
    """Writes \\r\\n line endings to a terminal. While sudo runs the helper in the same terminal it
    switches it to raw mode, where a bare \\n moves down without going back to the left edge."""
    if sys.stdout.isatty():
        sys.stdout.reconfigure(newline="\r\n")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "has":
        load()
        sys.exit(0 if os.environ.get(sys.argv[2]) else 1)
    print(__doc__)
