#!/bin/bash
#
# Teach the pendant a word, then measure how well it tells that word from
# everything else. Steps 4-7 of the local-command verification.
#
# This needs a HUMAN VOICE and cannot be automated. `say` produces byte-identical
# audio on every run, so enrolling and testing with it would score ~0 every time
# and prove nothing — it would reproduce exactly the synthetic-template problem
# this measurement exists to replace. Your natural repeats vary; that variation
# IS the measurement.
#
#   ./enroll-and-measure.sh enroll 1 "banana"     # teach slot 1
#   ./enroll-and-measure.sh test   "banana"       # one scored press
#   ./enroll-and-measure.sh table  "banana" 10    # repeat and tabulate
#
# Addresses are re-derived from the ELF every run. They MOVE between builds —
# scripts/be-the-user.sh has a hardcoded one that is already stale.
set -u

BUILD="${BUILD:-/Users/you/agentic-gadget/firmware/nrf9160/build-cloud}"
ELF="$BUILD/nrf9160/zephyr/zephyr.elf"
NM=/opt/nordic/ncs/toolchains/ccc010f809/opt/zephyr-sdk/gnu/arm-zephyr-eabi/bin/arm-zephyr-eabi-nm
JLINK=/Applications/SEGGER/JLink/JLinkExe
PORT=/dev/cu.usbmodem0009600365811    # DK console. NEVER /dev/cu.usbserial-* (ESP32).
LOG="${LOG:-/tmp/pendant-enroll.log}"

sym() {  # sym <name> -> 0xADDR
  local a
  a=$("$NM" "$ELF" 2>/dev/null | awk -v n="$1" '$3==n {print $1}')
  [ -n "$a" ] || { echo "symbol $1 not found in $ELF" >&2; exit 1; }
  echo "0x$a"
}

poke() {  # poke <addr> <value>
  printf 'device nRF9160_xxAA\nsi 1\nspeed 4000\nconnect\nw4 %s, %s\nq\n' "$1" "$2" > /tmp/jl-poke.txt
  "$JLINK" -nogui 1 -CommanderScript /tmp/jl-poke.txt -SelectEmuBySN 960036581 >/dev/null 2>&1
}

PRESS=$(sym pendant_remote_press)
ENROLL=$(sym pendant_local_enroll)
ACCEPT=$(sym pendant_local_accept_dist)
MARGIN=$(sym pendant_local_min_margin)

open_console() {
  : > "$LOG"
  exec 3<>"$PORT" || { echo "cannot open $PORT" >&2; exit 1; }
  # stty and read must share ONE open — `stty -f` then `cat` is two opens and
  # the second comes up at the default baud, which yields binary garbage.
  stty -f "$PORT" 115200 raw -echo -ixon 2>/dev/null
  cat <&3 >> "$LOG" 2>/dev/null &
  CATPID=$!
}
close_console() { kill "$CATPID" 2>/dev/null; wait "$CATPID" 2>/dev/null; exec 3<&-; }

# One press: start, let the human speak, stop. main.c swallows button events for
# the first 1000 ms after start, so the end write must come later than that.
one_press() {
  poke "$PRESS" 1
  sleep 1
  printf '\a'
  echo ">>> SPEAK NOW <<<"
  sleep "${SPEAK_SECS:-3}"
  poke "$PRESS" 1
  sleep 4
}

case "${1:-}" in
enroll)
  SLOT="${2:?slot number, 1-4}"; WORD="${3:-your word}"
  echo "Enrolling slot $SLOT with \"$WORD\"."
  echo "Say it ONCE, clearly, at your normal speaking distance from the pendant."
  open_console
  poke "$ENROLL" "$SLOT"
  one_press
  close_console
  LC_ALL=C tr -dc '[:print:]\n' < "$LOG" | grep -aE "LOCAL" || echo "(no LOCAL lines — check the board is running)"
  ;;

test)
  WORD="${2:-}"
  echo "Press coming. Say \"$WORD\" when prompted."
  open_console; one_press; close_console
  LC_ALL=C tr -dc '[:print:]\n' < "$LOG" | grep -aE "LOCAL (verdict|cost|handled|fired)"
  ;;

table)
  WORD="${2:-}"; N="${3:-10}"
  echo "$N scored presses. Say \"$WORD\" each time you are prompted."
  echo "Vary it the way real life does: normal, quick, quiet, slightly different angle."
  printf '%-4s %-9s %-7s %-7s %s\n' run verdict best second slot
  for i in $(seq 1 "$N"); do
    open_console; one_press >/dev/null; close_console
    line=$(LC_ALL=C tr -dc '[:print:]\n' < "$LOG" | grep -aoE "LOCAL verdict=.*" | head -1)
    v=$(echo "$line" | grep -oE "verdict=[a-z]+" | cut -d= -f2)
    b=$(echo "$line" | grep -oE "best=-?[0-9]+" | cut -d= -f2)
    s=$(echo "$line" | grep -oE "second=-?[0-9]+" | cut -d= -f2)
    sl=$(echo "$line" | grep -oE "slot=[0-9]+" | cut -d= -f2)
    printf '%-4s %-9s %-7s %-7s %s\n' "$i" "${v:-?}" "${b:--}" "${s:--}" "${sl:--}"
  done
  echo
  echo "Read it like this: same-word 'best' values are the distances that must fall"
  echo "under accept ($ACCEPT, currently 40). The gap between best and second must"
  echo "exceed margin ($MARGIN, currently 20). If same-word best is routinely above"
  echo "40 the feature never fires -- safe, but useless. Retune live, no reflash:"
  echo "  $JLINK ... w4 $ACCEPT, <n>     # accept distance"
  echo "  $JLINK ... w4 $MARGIN, <n>     # required margin"
  echo "Bias toward the cloud. A miss costs what today costs; a false match runs"
  echo "the wrong recipe silently."
  ;;

*)
  echo "usage: $0 enroll <slot> <word> | test <word> | table <word> [n]"
  echo "symbols: press=$PRESS enroll=$ENROLL accept=$ACCEPT margin=$MARGIN"
  exit 1 ;;
esac
