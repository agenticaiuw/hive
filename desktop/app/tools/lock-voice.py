"""Writes requirements.lock: the voice sidecars' packages (requirements.txt and everything they need)
at the exact versions installed in this .venv, and its Python version. A downloaded Hive.app sets up
that same Python and those same packages on first open (tools/first-open.sh), so a teammate gets the
voice the owner runs, not whatever is newest that day.

    .venv/bin/python tools/lock-voice.py        after changing requirements.txt or the .venv
"""
import os
import platform
import sys
from importlib import metadata

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def wanted(path):
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if line:
            yield Requirement(line)


def closure(roots):
    found, stack = {}, list(roots)
    while stack:
        req = stack.pop()
        try:
            dist = metadata.distribution(req.name)
        except metadata.PackageNotFoundError:
            sys.exit(f"{req.name} isn't installed in this .venv; run ./voice.sh --setup first")
        key = (canonicalize_name(req.name), tuple(sorted(req.extras)))
        if key in found:
            continue
        found[key] = dist
        for spec in dist.requires or []:
            need = Requirement(spec)
            extras = req.extras or {""}
            if need.marker is None or any(need.marker.evaluate({"extra": e}) for e in extras):
                stack.append(need)
    return sorted({(d.metadata["Name"], d.version) for d in found.values()}, key=lambda p: canonicalize_name(p[0]))


def main():
    pins = closure(wanted(os.path.join(HERE, "requirements.txt")))
    lines = [
        "# The voice sidecars' packages at the versions the owner runs: tools/lock-voice.py writes this",
        "# from desktop/app/.venv; a downloaded Hive.app installs exactly these (tools/first-open.sh).",
        f"# python: {platform.python_version()}",
        *(f"{name}=={version}" for name, version in pins),
    ]
    with open(os.path.join(HERE, "requirements.lock"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"requirements.lock: {len(pins)} packages, Python {platform.python_version()}")


if __name__ == "__main__":
    main()
