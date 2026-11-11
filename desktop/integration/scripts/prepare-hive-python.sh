#!/bin/bash
# Prepare a standalone virtual environment in the canonical desktop source.
# This does not install or launch the macOS app and does not touch an old venv.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
app="$root/desktop/app"
venv="$app/.venv"
[ ! -e "$venv" ] || { echo 'Desktop environment already exists; refusing to overwrite.' >&2; exit 1; }
command -v uv >/dev/null || { echo 'uv is required to create the environment.' >&2; exit 1; }
python_path=${HIVE_PYTHON:-$(command -v python3)}
uv venv --python "$python_path" "$venv"
# Avoid inheriting custom package-index credentials or local pip configuration.
env -i PATH="$PATH" HOME="$HOME" HTTPS_PROXY="${HTTPS_PROXY-}" HTTP_PROXY="${HTTP_PROXY-}" ALL_PROXY="${ALL_PROXY-}" NO_PROXY="${NO_PROXY-}" uv pip install --no-config --python "$venv/bin/python" -r "$app/requirements.txt"
"$venv/bin/python" -c 'import numpy, sounddevice, soxr, livekit, parakeet_mlx, kokoro_onnx, kaldi_native_fbank'
touch "$venv/.installed"
printf 'Prepared desktop Python environment; app not started.\n'
