#!/bin/bash
# Talk to your Mac. Starts the helper (one password prompt) and the voice agent.
# Then, in any window: hold Right Option, say what you want, let go. Ctrl-C stops everything.
#
# With OPENAI_API_KEY in .env it talks back: GPT-Live holds the conversation and hands the work to
# the computer agent (python/live_agent.py). Without a key, or with --superwhisper, Superwhisper
# listens and the Mac's voice reads out the result (python/voice_agent.py).
#
#   ./voice.sh [--superwhisper] [--no-speak]
set -euo pipefail
cd "$(dirname "$0")"

make -s

agent=(python3 python/voice_agent.py)
args=()
for a in "$@"; do [ "$a" = --superwhisper ] || args+=("$a"); done
if [ ${#args[@]} -eq $# ] && python3 python/settings.py has OPENAI_API_KEY; then
  if [ ! -x .venv/bin/python ] || [ requirements.txt -nt .venv/.installed ]; then
    echo "Setting up .venv (first run only)..."
    [ -x .venv/bin/python ] || python3 -m venv .venv
    .venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
    touch .venv/.installed
  fi
  agent=(.venv/bin/python python/live_agent.py)
fi

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
trap 'kill $agent_pid 2>/dev/null || true; wait $agent_pid 2>/dev/null || true' EXIT
./run.sh >>/tmp/agent-vhid-helper.log 2>&1  # helper log: /tmp/agent-vhid-helper.log
