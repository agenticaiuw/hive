#!/bin/bash
# Sets up optional silent lip reading (python/lipread.py): Chaplin at a fixed commit, its own Python
# environment, and the Auto-AVSR LRS3 weights from Hugging Face (about 1.1 GB). Run it yourself
# when you want lip reading; nothing else downloads them. No sudo, no permission changes: the first
# time you use lip reading macOS asks whether Agent may use the camera.
#
# The model's code and weights are for non-commercial research and private study only.
set -euo pipefail
DIR=${LIPREAD_DIR:-"$HOME/Library/Application Support/Personal Agent/lipread"}
COMMIT=7aee1f8fca776ce4f63690063310b53573b7d804
HF=https://huggingface.co

mkdir -p "$DIR" && chmod 700 "$DIR"
cd "$DIR"
if [ ! -d chaplin ]; then
  git clone https://github.com/amanvirparhar/chaplin.git
fi
git -C chaplin fetch -q origin "$COMMIT" 2>/dev/null || true
git -C chaplin checkout -q "$COMMIT"

if [ ! -x .venv/bin/python ]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.12 .venv; else python3.12 -m venv .venv; fi
fi
# Chaplin's requirements are unpinned, and the newest releases broke it: newer MediaPipe (1.x) dropped
# mp.solutions, torchvision 0.22+ dropped io.read_video, and PyAV 14 broke torchvision 0.21's reader.
PINS=("mediapipe==0.10.21" "torch==2.6.0" "torchvision==0.21.0" "torchaudio==2.6.0" "av==13.1.0")
if command -v uv >/dev/null; then
  VIRTUAL_ENV="$DIR/.venv" uv pip install -q -r chaplin/requirements.txt "${PINS[@]}"
else
  .venv/bin/pip install -q -r chaplin/requirements.txt "${PINS[@]}"
fi

get() {  # url destination
  [ -s "$2" ] && return
  mkdir -p "$(dirname "$2")"
  echo "Downloading $(basename "$(dirname "$2")")/$(basename "$2")…"
  curl -fL --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"
}
M=chaplin/benchmarks/LRS3/models/LRS3_V_WER19.1
L=chaplin/benchmarks/LRS3/language_models/lm_en_subword
get "$HF/Amanvir/LRS3_V_WER19.1/resolve/main/model.pth" "$M/model.pth"
get "$HF/Amanvir/LRS3_V_WER19.1/resolve/main/model.json" "$M/model.json"
get "$HF/Amanvir/lm_en_subword/resolve/main/model.pth" "$L/model.pth"
get "$HF/Amanvir/lm_en_subword/resolve/main/model.json" "$L/model.json"
echo "Lip reading is set up in $DIR. Choose Agent menu → Input → Lip Reading."
