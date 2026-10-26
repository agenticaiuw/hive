#!/bin/bash
# Talk to your Mac. Starts the helper (one password prompt) and the voice agent.
# Then, in any window: hold Right Option, say what you want, let go. Ctrl-C stops everything.
#
# Superwhisper listens, the computer agent does it, and Kokoro (an open-source voice that runs
# on this Mac) tells you what happened (python/voice_agent.py). With --live, GPT-Live holds a
# spoken conversation instead (python/live_agent.py; needs OPENAI_API_KEY in .env).
#
#   ./voice.sh [--live] [--no-speak]
set -euo pipefail
cd "$(dirname "$0")"

make -s

# First run only: the Python packages and the voice model.
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

agent=(.venv/bin/python python/voice_agent.py)
args=()
for a in "$@"; do
  case "$a" in
    --live) agent=(.venv/bin/python python/live_agent.py) ;;
    --superwhisper) ;;  # the default now
    *) args+=("$a") ;;
  esac
done

status=$(python3 python/agent_vhid.py status 2>/dev/null || true)
if [ -n "$status" ]; then
  if grep -q '^talk=1' <<<"$status"; then
    exec "${agent[@]}" ${args[@]+"${args[@]}"}  # the helper is already running
  fi
  echo "An older agent-vhid-helper is running. Press Ctrl-C in its window; this carries on once it stops."
  while python3 python/agent_vhid.py status >/dev/null 2>&1; do sleep 1; done
  sleep 2  # its run.sh stops the daemon it started; let that finish first
fi

sudo -v  # ask for the password before anything starts printing
"${agent[@]}" ${args[@]+"${args[@]}"} &
agent_pid=$!
# A second Ctrl-C shouldn't cut the agent's goodbye short (it stops the task and hands back control).
trap 'trap "" INT; kill $agent_pid 2>/dev/null || true; wait $agent_pid 2>/dev/null || true' EXIT
./run.sh >>/tmp/agent-vhid-helper.log 2>&1  # helper log: /tmp/agent-vhid-helper.log
