#!/usr/bin/env bash
# End-to-end check of the Rust client against the real worker.js, with synthetic data only.
# Three fake devices (A, B, C), each with its own HOME, state folder, sync folder and secrets.
#   cloud/hive-cloud/test/e2e.sh [r2]        (build first: cargo build -p hive-cloud)
# With a URL in HIVE_CLOUD_E2E_URL and HIVE_CLOUD_E2E_CLAIM, it runs against a deployed cloud.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bin="${HIVE_CLOUD_BIN:-$here/../../desktop/app/crates/hive/target/debug/hive-cloud}"
T="$(mktemp -d "${TMPDIR:-/tmp}/hive-cloud-e2e.XXXXXX")"
trap 'if [ -n "${server:-}" ]; then kill "$server" 2>/dev/null; wait "$server" 2>/dev/null; fi; rm -rf "$T"' EXIT
pass() { printf '  ok  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; exit 1; }

if [ -n "${HIVE_CLOUD_E2E_URL:-}" ]; then
  url="$HIVE_CLOUD_E2E_URL"; claim="$HIVE_CLOUD_E2E_CLAIM"
else
  claim="claim-$(openssl rand -hex 16)"
  CLAIM_SECRET="$claim" R2=$([ "${1:-}" = r2 ] && echo 1 || echo 0) node "$here/test/serve.mjs" > "$T/server.log" 2>&1 &
  server=$!
  for _ in $(seq 50); do grep -q listening "$T/server.log" 2>/dev/null && break; sleep 0.1; done
  url="http://127.0.0.1:$(awk '/listening/{print $2}' "$T/server.log")"
fi
echo "cloud: $url (${1:-durable objects})"

dev() { # dev <name> <command...>
  local d="$T/$1"; shift
  mkdir -p "$d/home" "$d/repo"
  # Only A keeps recordings outside its state folder (like ~/Movies/Hive); the others are clean
  # installs, where Hive keeps them in <state>/recordings.
  HOME="$d/home" HIVE_REPO="$d/repo" AGENT_STATE_DIR="$d/state" HIVE_RECORDINGS="$([ -d "$d/recordings" ] && echo "$d/recordings")" \
    HIVE_CLOUD_DIR="$d/cloud" HIVE_CLOUD_SECRETS_DIR="$d/secrets" "$bin" "$@"
}

# ---- device A: synthetic Hive data -----------------------------------------------------------
A="$T/A/state"
mkdir -p "$A/sessions/1" "$A/memory" "$A/context" "$A/authentication" "$A/lipread" "$A/notes" "$T/A/recordings/task-1"
printf '{"turn":1}\n' > "$A/sessions/1/journal.jsonl"
ln -s 1 "$A/sessions/latest"
echo "secret-token" > "$A/authentication/token"
head -c 200000 /dev/urandom > "$A/lipread/weights.bin"
head -c 3500000 /dev/urandom > "$A/context/page.html"          # 4 chunks
head -c 5000000 /dev/urandom > "$T/A/recordings/task-1/screen.mp4"
for i in $(seq 1 1500); do echo "note $i $RANDOM" > "$A/notes/n$i.txt"; done
sqlite3 "$A/memory/m.sqlite3" "PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES ('remember this');" >/dev/null

out="$(HIVE_CLOUD_CLAIM_SECRET="$claim" dev A claim "$url")"
code="$(echo "$out" | grep -Eo '([0-9A-Z]{4}-){7}[0-9A-Z]{4}' | head -1)"
[ -n "$code" ] && pass "A claimed the cloud and got a recovery code" || fail "no recovery code: $out"
dev A claim "$url" </dev/null >/dev/null 2>&1 && fail "a second claim worked" || pass "a second claim is refused"

dev A inventory > "$T/inventory.txt"
grep -q "credentials (never uploaded)" "$T/inventory.txt" && grep -q "model weights" "$T/inventory.txt" \
  && pass "inventory lists exclusions with reasons" || fail "inventory: $(cat "$T/inventory.txt")"

dev A sync > "$T/a-sync.txt" || fail "A sync: $(cat "$T/a-sync.txt")"
grep -q "State: ok" "$T/a-sync.txt" && grep -q "Read back from the cloud: OK" "$T/a-sync.txt" && pass "A uploaded and read it back: $(grep Upload: "$T/a-sync.txt")"
dev A sync | grep -q "0 sent" && pass "a second sync sends nothing" || fail "second sync re-sent files"
dev A verify --all | tail -1 | grep -q "matched" && pass "verify --all: every file decrypts and matches" || fail "verify"

# ---- device B: a clean install that only has the recovery code -------------------------------
dev B recover "$url" "$code" >/dev/null && pass "B connected with the recovery code" || fail "B connected with the recovery code"
dev B restore "$T/B/restore" > "$T/b-restore.txt" || fail "restore: $(cat "$T/b-restore.txt")"
[ ! -e "$T/B/restore/state/authentication" ] && [ ! -e "$T/B/restore/state/lipread" ] && pass "credentials and model weights were not uploaded" || fail "credentials and model weights were not uploaded"
diff -r -x latest -x authentication -x lipread -x memory "$A" "$T/B/restore/state" && pass "restored state matches A byte for byte" || fail "restored state matches A byte for byte"
diff -r "$T/A/recordings" "$T/B/restore/recordings" && pass "restored recordings match A" || fail "restored recordings match A"
[ "$(readlink "$T/B/restore/state/sessions/latest")" = 1 ] && pass "symlinks come back as symlinks" || fail "symlinks come back as symlinks"
[ "$(sqlite3 "$T/B/restore/state/memory/m.sqlite3" 'select x from t')" = "remember this" ] && pass "a live WAL database comes back with its data" || fail "a live WAL database comes back with its data"

dev B sync > "$T/b-sync.txt" || fail "B first sync: $(cat "$T/b-sync.txt")"
diff -r -x latest -x authentication -x lipread -x memory -x recordings "$A" "$T/B/state" && pass "B's first sync put A's data in B's state folder" || fail "B's first sync put A's data in B's state folder"
[ -f "$T/B/state/recordings/task-1/screen.mp4" ] && pass "recordings from outside A's state folder land inside B's" || fail "recordings from outside A's state folder land inside B's"
dev B sync | grep -q "0 sent" && pass "B doesn't upload A's recordings again under its own folder's name" || fail "B re-uploaded synced files"
dev A sync >/dev/null && [ ! -e "$A/recordings" ] && pass "A gets no second copy of its own recordings" || fail "A got a duplicate: $(ls "$A/recordings" 2>&1)"
cp "$T/A/recordings/task-1/screen.mp4" "$T/screen.keep"
rm "$T/B/state/recordings/task-1/screen.mp4"
dev B sync >/dev/null && dev A sync >/dev/null && [ ! -e "$T/A/recordings/task-1/screen.mp4" ] \
  && pass "deleting that recording on B deletes it on A too" || fail "a relocated recording's deletion didn't reach A"
mv "$T/screen.keep" "$T/A/recordings/task-1/screen.mp4" && dev A sync >/dev/null && dev B sync >/dev/null

# ---- device C joins with an invite ---------------------------------------------------------
link="$(dev A invite --minutes 5 | grep -Eo "http[^']+#join=[0-9A-Z-]+")"
dev C join "$link" >/dev/null && pass "C joined with an invite link" || fail "C joined with an invite link"
dev D join "$link" >/dev/null 2>&1 && fail "an invite worked twice" || pass "the invite cannot be used twice"

# ---- conflicts, deletion, the mass-delete guard, revoke ---------------------------------------
echo '{"edit":"from A"}' >> "$A/sessions/1/journal.jsonl"
echo '{"edit":"from B"}' >> "$T/B/state/sessions/1/journal.jsonl"
dev A sync >/dev/null
dev B sync > "$T/b-conflict.txt" || true
grep -q "conflict:" "$T/b-conflict.txt" && pass "B saw the conflict" || fail "no conflict: $(cat "$T/b-conflict.txt")"
dev A sync >/dev/null
ls "$A/sessions/1/" | grep -q "journal.jsonl.conflict-" && grep -q "from B" "$A/sessions/1/journal.jsonl" \
  && pass "both edits survive: B's at the path, A's as a conflict copy" || fail "conflict lost data: $(ls "$A/sessions/1")"

rm "$A/notes/n1.txt"
dev A sync >/dev/null && dev B sync >/dev/null
[ ! -e "$T/B/state/notes/n1.txt" ] && pass "a deletion on A reaches B" || fail "a deletion on A reaches B"

mkdir -p "$T/held" && mv "$A/notes" "$T/held/notes"
dev A sync > "$T/mass.txt" 2>&1 && fail "mass delete went through" || grep -q "Sync stopped" "$T/mass.txt" && pass "deleting most files at once is refused" || fail "deleting most files at once is refused"
mv "$T/held/notes" "$A/notes"

dev A status --json > "$T/status.json"
node -e 'const s=require(process.argv[1]); if(!s.lastVerifiedSyncAt||s.server.devices.length!==3) process.exit(1)' "$T/status.json" \
  && pass "status shows the last verified sync and all 3 devices" || fail "status shows the last verified sync and all 3 devices"
cid="$(node -e 'const s=require(process.argv[1]); console.log(s.server.devices.find(d=>d.enrolledVia.startsWith("invite")).id)' "$T/status.json")"
dev A revoke "$cid" >/dev/null && ! dev C status >/dev/null 2>&1 && pass "a revoked device is locked out" || fail "a revoked device is locked out"
echo "all checks passed"
