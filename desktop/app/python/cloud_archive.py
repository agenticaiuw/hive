"""Copies each task recording (see task_recording.py) to Cloudflare R2, bucket "hive-recordings".

The video is re-encoded for the upload (1440 px wide, 10 fps, quality-based H.264, at low
priority): a mostly still screen comes to well under 1 MB a minute. Only if a copy would still pass
R2's 300 MB single-upload limit is it split into parts. The full-resolution original stays on the Mac. The timeline, subtitles and metadata go up as they
are. Uploads use the signed-in Cloudflare CLI (`cf`). A folder is marked done with `.uploaded`;
anything not yet uploaded (Mac offline, cf signed out) is tried again after the next recording
and when Hive starts.

Objects: recordings/<folder name with dashes>/{screen.mp4 | screen-part-01.mp4 ..., timeline.jsonl,
screen.srt, meta.json, manifest.json}. HIVE_R2_BUCKET sets another bucket.
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

import task_recording

BUCKET = os.environ.get("HIVE_R2_BUCKET", "hive-recordings")
LIMIT = 280 * 1024 * 1024  # under R2's 300 MB single-upload limit
_lock = threading.Lock()
TYPES = {".mp4": "video/mp4", ".jsonl": "application/x-ndjson", ".json": "application/json",
         ".srt": "application/x-subrip", ".log": "text/plain"}


def _cf() -> tuple[str, dict] | None:
    env = dict(os.environ)
    found = shutil.which("cf")
    if not found:
        candidates = sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/cf")))
        found = candidates[-1] if candidates else None
    if not found:
        return None
    env["PATH"] = os.path.dirname(found) + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    return found, env


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.exists(p)), None)


def key_prefix(folder: Path) -> str:
    return "recordings/" + re.sub(r"[^A-Za-z0-9._-]+", "-", folder.name).strip("-")


def shrink(folder: Path) -> list[Path]:
    """Smaller copies of screen.mov to upload: one file, or parts of equal length under the limit."""
    source = folder / "screen.mov"
    ffmpeg = _ffmpeg()
    if not source.exists() or not ffmpeg:
        return []
    out = folder / "upload"
    out.mkdir(exist_ok=True)
    for old in out.glob("screen*.mp4"):
        old.unlink()
    single = out / "screen.mp4"
    # A mostly still screen compresses to well under 1 MB a minute this way (the raw 60 fps Retina
    # file is ~25 MB a minute). Quality-based x264 at 10 fps and the screen's point size (1440 wide).
    encode = ["nice", "-n", "15", ffmpeg, "-y", "-loglevel", "error", "-i", str(source), "-an",
              "-vf", "scale=1440:-2,fps=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
              "-tune", "stillimage", "-movflags", "+faststart", str(single)]
    if subprocess.run(encode, capture_output=True, timeout=6 * 3600).returncode != 0:
        return []
    if single.stat().st_size <= LIMIT:
        return [single]
    length = task_recording.video_length(single) or 0
    parts = int(single.stat().st_size // LIMIT) + 1
    seconds = max(30, int(length / parts) - 5) if length else 600
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(single), "-c", "copy", "-f", "segment",
                    "-segment_time", str(seconds), "-reset_timestamps", "1",
                    str(out / "screen-part-%02d.mp4")], capture_output=True, timeout=3600)
    pieces = sorted(out.glob("screen-part-*.mp4"))
    if pieces:
        single.unlink()
        (out / "parts.json").write_text(json.dumps({"secondsPerPart": seconds,
                                                     "parts": [p.name for p in pieces]}, indent=1))
    return pieces


def put(cf, env, key: str, path: Path) -> tuple[bool, str]:
    run = subprocess.run([cf, "r2", "objects", "put", key, "--bucket-name", BUCKET, "--file", str(path),
                          "--content-type", TYPES.get(path.suffix, "application/octet-stream")],
                         capture_output=True, text=True, timeout=3600, env=env)
    return run.returncode == 0, (run.stderr or run.stdout).strip()[-300:]


def archive(folder: Path) -> str:
    """Uploads one finished recording folder. Returns a one-line result."""
    found = _cf()
    if not found:
        return "cf (Cloudflare CLI) not found"
    cf, env = found
    files = shrink(folder)
    extra = [folder / name for name in ("timeline.jsonl", "screen.srt", "meta.json", "screencapture.log")]
    parts = folder / "upload" / "parts.json"
    files += [p for p in extra + [parts] if p.exists() and p.stat().st_size > 0]
    prefix, uploaded = key_prefix(folder), []
    for path in files:
        ok, detail = put(cf, env, f"{prefix}/{path.name}", path)
        if not ok:
            return f"upload of {path.name} failed: {detail}"
        uploaded.append({"key": f"{prefix}/{path.name}", "bytes": path.stat().st_size})
    manifest = {"bucket": BUCKET, "uploaded": datetime.datetime.now().isoformat(timespec="seconds"),
                "objects": uploaded, "originalVideoOnMac": str(folder / "screen.mov")}
    (folder / "upload" / "manifest.json").write_text(json.dumps(manifest, indent=1))
    put(cf, env, f"{prefix}/manifest.json", folder / "upload" / "manifest.json")
    (folder / ".uploaded").write_text(json.dumps(manifest, indent=1))
    return f"uploaded {len(uploaded)} files to R2 {BUCKET}/{prefix}"


def archive_pending(report=None):
    """Uploads every finished recording that isn't uploaded yet, one at a time."""
    if not _lock.acquire(blocking=False):
        return
    try:
        root = task_recording.folder()
        for folder in sorted(root.glob("*")) if root.exists() else []:
            if folder.is_dir() and (folder / "meta.json").exists() and not (folder / ".uploaded").exists():
                try:
                    result = archive(folder)
                except Exception as error:  # never let an upload problem reach the agent
                    result = f"upload failed: {error}"
                if report:
                    report(f"Recording {folder.name}: {result}")
    finally:
        _lock.release()


def archive_in_background(report=None):
    threading.Thread(target=archive_pending, args=(report,), name="cloud-archive", daemon=True).start()
