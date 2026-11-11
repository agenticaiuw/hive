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
