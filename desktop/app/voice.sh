#!/bin/bash
# Talk to your Mac. Starts the helper (one password prompt) and the voice agent.
# Then, in any window, tap fn and say what you want; tap fn again to stop it listening.
# Ctrl-C stops everything. To have it start with the Mac instead, in the menu bar: ./install.sh
#
# Parakeet writes down what you say as you say it, the computer agent does it, and Kokoro tells
# you what it's doing (build/hive-agent, from crates/hive). The models are open source and run on
# this Mac in a Python sidecar (python/sidecar_voice.py); what the Mac plays is taken back out of
# what the microphone hears (python/mic.py).
#
#   ./voice.sh [--no-speak]
#   ./voice.sh --enroll     teach it your voice, so it ignores other people talking nearby
#   ./voice.sh --setup      only build it and fetch what it needs (./install.sh does this)
set -euo pipefail
cd "$(dirname "$0")"

make -s

# First run only: the Python packages and the models (Parakeet 2.4 GB, Kokoro 350 MB, Silero VAD 2 MB).
if [ ! -x .venv/bin/python ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "Setting up .venv..."
  [ -x .venv/bin/python ] || python3 -m venv .venv
  .venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
  touch .venv/.installed
fi
models=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ ! -f "models/$f" ]; then
    echo "Downloading the agent's voice (Kokoro, models/$f)..."
    mkdir -p models
    if curl -fL --progress-bar -o "models/$f.part" "$models/$f"; then
      mv "models/$f.part" "models/$f"
    else
      echo "Couldn't download it; the Mac's own voice will speak instead."
    fi
  fi
done

.venv/bin/python python/listen.py --download  # Parakeet and Silero VAD, once
.venv/bin/python python/voiceprint.py --download  # WeSpeaker, which tells your voice from others, once
make -s build/hive-agent build/hive-auth-mcp build/hive-vhid  # the agent (Rust, crates/hive); rebuilt after a change

if [ "${1:-}" = "--enroll" ]; then
  exec .venv/bin/python python/voiceprint.py --enroll
fi
[ "${1:-}" = "--setup" ] && exit 0

agent=(build/hive-agent)
args=("$@")

if pgrep -qf "hive-agent --app"; then
  echo "Agent.app is running, and it's already the one listening for fn. Quit it from its menu bar icon first."
  exit 1
fi

status=$(build/hive-vhid status 2>/dev/null || true)
if [ -n "$status" ]; then
  if grep -q '^fn=1' <<<"$status"; then
    exec "${agent[@]}" ${args[@]+"${args[@]}"}  # the helper is already running (after ./install.sh, always)
  fi
  echo "An older agent-vhid-helper is running. Press Ctrl-C in its window; this carries on once it stops."
  while build/hive-vhid status >/dev/null 2>&1; do sleep 1; done
  sleep 2  # its run.sh stops the daemon it started; let that finish first
fi

sudo -v  # ask for the password before anything starts printing
"${agent[@]}" ${args[@]+"${args[@]}"} &
agent_pid=$!
# A second Ctrl-C shouldn't cut the agent's goodbye short (it stops the task and hands back control).
trap 'trap "" INT; kill $agent_pid 2>/dev/null || true; wait $agent_pid 2>/dev/null || true' EXIT
./run.sh >>/tmp/agent-vhid-helper.log 2>&1  # helper log: /tmp/agent-vhid-helper.log
