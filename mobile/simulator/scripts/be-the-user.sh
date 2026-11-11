#!/bin/bash
# Drive the pendant as an actual user would, end to end, with no human present.
#
# The mic is a physical I2S microphone, so there is no way to inject audio
# electrically. Instead this speaks the utterance out of the Mac's speakers and
# lets the pendant hear it — which is the real acoustic path, ambient noise and
# all, rather than a clean signal a real user would never produce.
#
#   ./be-the-user.sh "what is the weather in taipei"
#
# Requires the VCOM listener to be running (it reads diagnostics/nrf-uart-latest.log).
set -u
PRESS_ADDR=0x200148b0          # &pendant_remote_press; re-check after a reflash
UTTERANCE="${1:?usage: be-the-user.sh "<what to say>" [seconds]}"
LISTEN_SECONDS="${2:-25}"
LOG=/Users/evanliu/agentic-gadget/diagnostics/nrf-uart-latest.log
JLINK=/usr/local/bin/JLinkExe

press() {
  local script
  script=$(mktemp)
  printf 'device nRF9160_xxAA\nif SWD\nspeed 4000\nconnect\nw4 %s 1\nq\n' "$PRESS_ADDR" > "$script"
  "$JLINK" -nogui 1 -commanderscript "$script" >/dev/null 2>&1
  rm -f "$script"
}

mark=$(wc -l < "$LOG")

echo "── pressing the button"
press
sleep 3

echo "── speaking: \"$UTTERANCE\""
say -r 175 "$UTTERANCE"
sleep 2

echo "── waiting ${LISTEN_SECONDS}s for the agent"
sleep "$LISTEN_SECONDS"

echo "── ending the conversation"
press
sleep 4

echo
echo "── what the pendant did"
tail -n +"$((mark + 1))" "$LOG" | grep -aE "Conversation|Opus live|decoded|stats|Codec|WS |uplink|tx_peak|error|fail" | tail -25
