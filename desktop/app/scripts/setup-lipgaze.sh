#!/bin/bash
# Lip reading for the eye keyboard (scripts/lipgaze.py): USR 2.0 Huge's code and weights and a Python 3.10
# runtime, all under Hive's state folder. About 7.6 GB of weights and 1-2 GB of runtime. Safe to run again:
# a finished step is checked, not redone, and an interrupted download resumes.
set -euo pipefail
BASE=${LIPGAZE_DIR:-"${AGENT_STATE_DIR:-$HOME/Library/Application Support/Hive}/lipgaze"}
USR2="$BASE/usr2"
COMMIT=e9e9c94e8d827efbb28e9a4b9d5d2d97a583b129
SHA=42aef587d507aa390873b2744ffb3a306b37267fa88c803e6cb950112794d318
WEIGHTS="$USR2/weights/huge_high_resource_lrs2lrs3vox2avsp.pth"
# The README's "Huge (high-resource)" checkpoint, on Google Drive.
URL='https://drive.usercontent.google.com/download?id=1LzFOTYu45zCLOHGVLQt7pMGjw6jmmo9Y&export=download&confirm=t'
SCRIPTS=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$BASE"
chmod 700 "$BASE"
[ -d "$USR2/.git" ] || git clone -q https://github.com/ahaliassos/usr2.git "$USR2"
git -C "$USR2" fetch -q origin "$COMMIT"
git -C "$USR2" checkout -q "$COMMIT"

if [ ! -f "$WEIGHTS" ]; then
  mkdir -p "$(dirname "$WEIGHTS")"
  curl -fL -C - --progress-bar "$URL" -o "$WEIGHTS.part"
  printf '%s  %s\n' "$SHA" "$WEIGHTS.part" | shasum -a 256 -c -
  mv "$WEIGHTS.part" "$WEIGHTS"
fi

if [ ! -x "$BASE/.venv/bin/python" ]; then
  uv venv -q --python 3.10 "$BASE/.venv"
fi
uv pip install -q --python "$BASE/.venv/bin/python" -r "$SCRIPTS/lipgaze-requirements.txt"

# Loads the model once and reads a still mouth, so a broken runtime shows up now, not mid-sentence.
"$BASE/.venv/bin/python" "$SCRIPTS/lipgaze.py" check --model "$USR2"
echo "Lip reading for the eye keyboard is set up in $BASE."
