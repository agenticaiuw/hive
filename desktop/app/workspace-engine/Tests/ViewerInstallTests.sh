#!/usr/bin/env bash
# Exercises the local Viewer installer without touching the real /Applications directory.
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SCRIPT="$REPOSITORY_ROOT/scripts/install-viewer-app.sh"

fail() {
    echo "viewer install test failed: $*" >&2
    exit 1
}

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/spaceo-viewer-install-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
FIXTURE_ROOT="$TEST_ROOT/repository"
MOCK_BIN="$TEST_ROOT/bin"
APPLICATIONS_DIR="$TEST_ROOT/Applications"
mkdir -p "$FIXTURE_ROOT/scripts" "$MOCK_BIN" "$APPLICATIONS_DIR"
cp "$INSTALL_SCRIPT" "$FIXTURE_ROOT/scripts/install-viewer-app.sh"

cat > "$MOCK_BIN/uname" <<'MOCK'
#!/usr/bin/env bash
printf 'Darwin\n'
MOCK

cat > "$MOCK_BIN/make" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "-C" && "${3:-}" == "viewer" ]]
app="$2/.build/SpaceO Viewer.app"
mkdir -p "$app/Contents"
printf 'replacement\n' > "$app/Contents/build-marker"
MOCK

cat > "$MOCK_BIN/codesign" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK

cat > "$MOCK_BIN/ditto" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
cp -R "$1" "$2"
MOCK

cat > "$MOCK_BIN/open" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK

# The second move is the small but destructive replacement window: the old app already lives in
# staging, while the new app has not reached its final path. Terminate the installer there.
cat > "$MOCK_BIN/mv" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
counter_file="${SPACEO_TEST_MV_COUNTER:?}"
count=0
[[ ! -f "$counter_file" ]] || count="$(<"$counter_file")"
count=$(( count + 1 ))
printf '%s\n' "$count" > "$counter_file"
if [[ "${SPACEO_TEST_INTERRUPT_SECOND_MV:-0}" == "1" && "$count" == "2" ]]; then
    kill -TERM "$PPID"
    exit 143
fi
exec /bin/mv "$@"
MOCK

chmod +x "$MOCK_BIN"/*

installed_app="$APPLICATIONS_DIR/SpaceO Viewer.app"
mkdir -p "$installed_app/Contents"
printf 'previous\n' > "$installed_app/Contents/build-marker"

status=0
PATH="$MOCK_BIN:$PATH" \
SPACEO_APPLICATIONS_DIR="$APPLICATIONS_DIR" \
SPACEO_TEST_MV_COUNTER="$TEST_ROOT/mv-counter" \
SPACEO_TEST_INTERRUPT_SECOND_MV=1 \
    bash "$FIXTURE_ROOT/scripts/install-viewer-app.sh" --no-open >/dev/null 2>&1 \
    || status=$?
(( status != 0 )) || fail "a terminated replacement unexpectedly reported success"
[[ "$(<"$installed_app/Contents/build-marker")" == "previous" ]] \
    || fail "the previous app was lost when replacement was interrupted"

rm -f "$TEST_ROOT/mv-counter"
PATH="$MOCK_BIN:$PATH" \
SPACEO_APPLICATIONS_DIR="$APPLICATIONS_DIR" \
SPACEO_TEST_MV_COUNTER="$TEST_ROOT/mv-counter" \
    bash "$FIXTURE_ROOT/scripts/install-viewer-app.sh" --no-open >/dev/null
[[ "$(<"$installed_app/Contents/build-marker")" == "replacement" ]] \
    || fail "a normal replacement did not install the new app"

echo "viewer install transaction tests passed"
