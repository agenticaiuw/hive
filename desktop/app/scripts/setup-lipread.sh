#!/bin/bash
# Optional local, live lip reading. FLARE code/weights and an isolated Python 3.10 runtime.
# The 4.85 GB upstream checkpoint includes training optimizer state, ignored at inference.
set -euo pipefail
BASE=${LIPREAD_DIR:-"$HOME/Library/Application Support/Personal Agent/lipread"}
DIR="$BASE/flare"
COMMIT=7c8f76c788a01f9270a3badfd2eeab45a979c44a
SHA=ceaaf364ab47cda05dddc05dc109752cede57c989d7f9481b765e29e227cbf25
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$BASE"
chmod 700 "$BASE"
if [ ! -d "$DIR/.git" ]; then
  git clone https://github.com/jxzhanggg/FLARE.git "$DIR"
fi
git -C "$DIR" fetch -q origin "$COMMIT"
git -C "$DIR" checkout -q "$COMMIT"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.10 "$DIR/.venv";
  else python3.10 -m venv "$DIR/.venv"; fi
fi
if command -v uv >/dev/null; then
  uv pip install -q --python "$DIR/.venv/bin/python" -r "$REPO_ROOT/scripts/lipread-requirements.txt"
else
  "$DIR/.venv/bin/python" -m pip install -r "$REPO_ROOT/scripts/lipread-requirements.txt"
fi
if [ ! -f "$DIR/large.pt" ]; then
  curl -fL -C - --progress-bar \
    'https://huggingface.co/Anony94/FLARE-checkpoints/resolve/main/exp_22_2_large/finetuned/checkpoints/checkpoint_last.pt' \
    -o "$DIR/large.pt.part"
  printf '%s  %s\n' "$SHA" "$DIR/large.pt.part" | shasum -a 256 -c -
  mv "$DIR/large.pt.part" "$DIR/large.pt"
else
  printf '%s  %s\n' "$SHA" "$DIR/large.pt" | shasum -a 256 -c -
fi
# Fail setup visibly if a dependency, architecture or device is incompatible; no camera opens.
LIPREAD_FLARE_DIR="$DIR" "$DIR/.venv/bin/python" "$REPO_ROOT/scripts/lipread_worker.py" </dev/null
echo "FLARE is set up. Choose Agent menu → Input → Lip Reading."
# USR 2.0 Huge, opt-in (LIPREAD_USR2=1 here, LIPREAD_MODEL=usr2 for Hive), on FLARE's Python.
# Its 7.6 GB checkpoint is on Google Drive (the README's "Huge (high-resource)"), so it is
# fetched by hand and checked here.
if [ "${LIPREAD_USR2:-}" = 1 ]; then
  USR2="$BASE/usr2"
  USR2_COMMIT=e9e9c94e8d827efbb28e9a4b9d5d2d97a583b129
  USR2_SHA=42aef587d507aa390873b2744ffb3a306b37267fa88c803e6cb950112794d318
  WEIGHTS="$USR2/weights/huge_high_resource_lrs2lrs3vox2avsp.pth"
  if [ ! -d "$USR2/.git" ]; then
    git clone https://github.com/ahaliassos/usr2.git "$USR2"
  fi
  git -C "$USR2" fetch -q origin "$USR2_COMMIT"
  git -C "$USR2" checkout -q "$USR2_COMMIT"
  if [ ! -f "$WEIGHTS" ]; then
    echo "Put huge_high_resource_lrs2lrs3vox2avsp.pth from USR 2.0's README at $WEIGHTS and run this again." >&2
    exit 1
  fi
  printf '%s  %s\n' "$USR2_SHA" "$WEIGHTS" | shasum -a 256 -c -
  LIPREAD_MODEL=usr2 LIPREAD_FLARE_DIR="$DIR" "$DIR/.venv/bin/python" "$REPO_ROOT/scripts/lipread_worker.py" </dev/null
  echo "USR 2.0 is set up. Start Hive with LIPREAD_MODEL=usr2 to read lips with it."
fi
