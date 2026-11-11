#!/usr/bin/env bash
# Exercises scripts/check-live-test-run.sh against fixture logs.
#
# The gate exists because `swift test` exits 0 when nothing ran. A gate that itself silently
# stopped catching that would restore the original defect, so every rejection path is asserted
# here rather than trusted.
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$REPOSITORY_ROOT/scripts/check-live-test-run.sh"

fail() { echo "live test gate test failed: $*" >&2; exit 1; }

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/spaceo-live-gate.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

# A stand-in for IntegrationTests.swift: only the `func test...` count is read from it.
write_source() {
    local path="$1"
    local count="$2"
    {
        echo 'final class IntegrationTests: XCTestCase {'
        # A helper that is not a test must not inflate the expected count.
        echo '    private func testingHelperNotATest(_ value: Int) -> Int { value }'
        for (( index = 1; index <= count; index++ )); do
            echo "    func testLive${index}() throws {}"
        done
        echo '}'
    } >"$path"
}

case_line() { echo "Test Case '-[SpaceOKitTests.IntegrationTests testLive$1]' $2 (0.512 seconds)."; }

# Builds a log with the requested mix of outcomes, wrapped in the surrounding suite chatter that a
# real run emits so the parser is exercised against realistic noise.
write_log() {
    local path="$1" passed="$2" failed="$3" skipped="$4"
    local index=0
    {
        echo "Test Suite 'Selected tests' started at 2026-08-02 10:00:00.000"
        echo "Test Suite 'SpaceOKitPackageTests.xctest' started at 2026-08-02 10:00:00.001"
        echo "Test Suite 'IntegrationTests' started at 2026-08-02 10:00:00.001"
        for (( i = 0; i < passed; i++ )); do
            index=$(( index + 1 ))
            echo "Test Case '-[SpaceOKitTests.IntegrationTests testLive${index}]' started."
            case_line "$index" passed
        done
        for (( i = 0; i < failed; i++ )); do
            index=$(( index + 1 ))
            echo "Test Case '-[SpaceOKitTests.IntegrationTests testLive${index}]' started."
            echo "$REPOSITORY_ROOT/Tests/SpaceOKitTests/IntegrationTests.swift:51: -[SpaceOKitTests.IntegrationTests testLive${index}] : XCTAssertTrue failed - leaked virtual display(s): [280]"
            case_line "$index" failed
        done
        for (( i = 0; i < skipped; i++ )); do
            index=$(( index + 1 ))
            echo "Test Case '-[SpaceOKitTests.IntegrationTests testLive${index}]' started."
            echo "$REPOSITORY_ROOT/Tests/SpaceOKitTests/IntegrationTests.swift:22: -[SpaceOKitTests.IntegrationTests testLive${index}] : Test skipped - SpaceO cannot drive sessions on this host:"
            case_line "$index" skipped
        done
        echo "Test Suite 'IntegrationTests' passed at 2026-08-02 10:00:04.000"
        echo "	 Executed $(( passed + failed + skipped )) tests, with ${skipped} tests skipped and ${failed} failures (0 unexpected) in 4.000 (4.001) seconds"
    } >"$path"
}

run_check() {
    local source="$1" log="$2"
    SPACEO_LIVE_TEST_SOURCE="$source" bash "$CHECK" "$log" 2>&1
}

assert_accepts() {
    local label="$1" source="$2" log="$3"
    local output
    if ! output="$(run_check "$source" "$log")"; then
        fail "$label: expected the gate to accept the run, but it rejected it:
$output"
    fi
}

assert_rejects() {
    local label="$1" source="$2" log="$3" expected_message="$4"
    local output
    if output="$(run_check "$source" "$log")"; then
        fail "$label: expected the gate to reject the run, but it exited 0:
$output"
    fi
    grep -Fq "$expected_message" <<<"$output" \
        || fail "$label: rejection did not explain the cause (wanted \"$expected_message\"):
$output"
}

SOURCE_16="$TEST_ROOT/IntegrationTests.swift"
write_source "$SOURCE_16" 16

# A fully executed run is the only shape that passes.
write_log "$TEST_ROOT/all-passed.log" 16 0 0
assert_accepts "16 of 16 executed" "$SOURCE_16" "$TEST_ROOT/all-passed.log"

# The defect this ticket was filed for: every test skips, `swift test` exits 0.
write_log "$TEST_ROOT/all-skipped.log" 0 0 16
assert_rejects "every test skipped" "$SOURCE_16" "$TEST_ROOT/all-skipped.log" "16 live test(s) skipped"

# A single skip hides one test's worth of coverage and must not be averaged away.
write_log "$TEST_ROOT/one-skipped.log" 15 0 1
assert_rejects "one test skipped" "$SOURCE_16" "$TEST_ROOT/one-skipped.log" "1 live test(s) skipped"

# A filter that matches nothing: no per-case lines at all, exit 0 from swift test.
write_log "$TEST_ROOT/empty.log" 0 0 0
assert_rejects "filter matched nothing" "$SOURCE_16" "$TEST_ROOT/empty.log" "no live test produced a result"

# A filter that quietly selects a subset leaves the rest unverified while looking green.
write_log "$TEST_ROOT/subset.log" 3 0 0
assert_rejects "filter selected a subset" "$SOURCE_16" "$TEST_ROOT/subset.log" "3 live test(s) executed but 16 are defined"

# A real failure still fails, and counts as executed rather than missing.
write_log "$TEST_ROOT/failure.log" 15 1 0
assert_rejects "a live test failed" "$SOURCE_16" "$TEST_ROOT/failure.log" "1 live test(s) failed"

# Adding a live test raises the bar automatically; a stale run no longer satisfies the gate.
SOURCE_17="$TEST_ROOT/IntegrationTests17.swift"
write_source "$SOURCE_17" 17
assert_rejects "suite grew, run did not" "$SOURCE_17" "$TEST_ROOT/all-passed.log" \
    "16 live test(s) executed but 17 are defined"

# A source with no tests must not silently satisfy a run that executed nothing.
SOURCE_0="$TEST_ROOT/IntegrationTests0.swift"
write_source "$SOURCE_0" 0
assert_rejects "no tests defined" "$SOURCE_0" "$TEST_ROOT/empty.log" "found no test methods"

# A missing log is an error, not an absence of evidence to shrug at.
assert_rejects "log missing" "$SOURCE_16" "$TEST_ROOT/does-not-exist.log" "cannot read live test log"

# The real suite source must parse to a plausible count, or the gate is enforcing nothing in CI.
real_count="$(grep -cE '^[[:space:]]*func[[:space:]]+test[A-Za-z0-9_]*[[:space:]]*\(' \
    "$REPOSITORY_ROOT/Tests/SpaceOKitTests/IntegrationTests.swift")"
(( real_count > 0 )) \
    || fail "IntegrationTests.swift parses to 0 test methods; the gate would enforce nothing"
write_log "$TEST_ROOT/real-count.log" "$real_count" 0 0
assert_accepts "real suite count parses" \
    "$REPOSITORY_ROOT/Tests/SpaceOKitTests/IntegrationTests.swift" "$TEST_ROOT/real-count.log"

# The suite must keep its display-leak baseline ahead of the skip, or a skipped run silently stops
# checking for phantom displays -- the second half of the defect this gate was added for.
suite_setup="$(sed -n '/override func setUpWithError/,/^    }/p' \
    "$REPOSITORY_ROOT/Tests/SpaceOKitTests/IntegrationTests.swift")"
# Anchored on the statements, not on prose: the surrounding comments name both by design.
baseline_line="$(grep -nE '^[[:space:]]*hasDisplayBaseline = true' <<<"$suite_setup" | head -1 | cut -d: -f1)"
skip_line="$(grep -nE '^[[:space:]]*try XCTSkipUnless\(' <<<"$suite_setup" | head -1 | cut -d: -f1)"
[[ -n "$baseline_line" && -n "$skip_line" ]] \
    || fail "could not locate the display baseline and the skip in setUpWithError"
(( baseline_line < skip_line )) \
    || fail "setUpWithError takes its display baseline after XCTSkipUnless, so tearDownWithError's leaked-display assertion is disarmed whenever the suite skips"

# --- scripts/test.sh live plumbing -------------------------------------------------------------
#
# The gate is only useful if `live --require-full` actually reaches it. A stub compiler stands in
# for building tests, and a stub XCTest exercises selection, supervision and exit status --
# is exercised without a WindowServer.

STUB_BIN="$TEST_ROOT/bin"
mkdir -p "$STUB_BIN"
export SPACEO_TEST_REAL_PYTHON="$(command -v python3)"
cat >"$STUB_BIN/python3" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == */host-health.py ]]; then
    echo '{"admitted":true,"testFixture":true}'
    if [[ -n "${STUB_HEALTH_COUNT:-}" ]]; then
        count=0
        [[ ! -f "$STUB_HEALTH_COUNT" ]] || read -r count <"$STUB_HEALTH_COUNT"
        count=$((count + 1))
        echo "$count" >"$STUB_HEALTH_COUNT"
        if (( count > 1 )); then exit "${STUB_POST_HEALTH_EXIT:-0}"; fi
    fi
    exit "${STUB_HOST_HEALTH_EXIT:-0}"
fi
exec "$SPACEO_TEST_REAL_PYTHON" "$@"
STUB
chmod +x "$STUB_BIN/python3"
cat >"$STUB_BIN/swift" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == "build" ]] || { echo "stub swift: unexpected invocation: $*" >&2; exit 99; }
if [[ "${2:-}" == "--show-bin-path" ]]; then dirname "$0"; fi
STUB
cat >"$STUB_BIN/xctest" <<'STUB'
#!/usr/bin/env bash
echo "stub xctest invoked with: $*" >"${STUB_INVOCATION:-/dev/null}"
[[ "${SPACEO_LIVE_HEALTH_SCRIPT:-}" == /*/scripts/host-health.py ]] || exit 98
cat "$STUB_LOG"
exit "${STUB_EXIT:-0}"
STUB
cat >"$STUB_BIN/xcrun" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == "--find xctest" ]] || exit 99
echo "$(dirname "$0")/xctest"
STUB
mkdir -p "$STUB_BIN/SpaceOPackageTests.xctest"
chmod +x "$STUB_BIN/swift" "$STUB_BIN/xctest" "$STUB_BIN/xcrun"

# The fixture compiler never touches macOS. Exercise the wrapper on the Ubuntu CI preflight
# too, while leaving its real-host Darwin admission check intact.
cat >"$STUB_BIN/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then echo Darwin; else /usr/bin/uname "$@"; fi
STUB
chmod +x "$STUB_BIN/uname"

run_test_sh_live() {
    local stub_log="$1" stub_exit="$2"
    shift 2
    STUB_LOG="$stub_log" STUB_EXIT="$stub_exit" STUB_INVOCATION="$TEST_ROOT/invocation.txt" \
        PATH="$STUB_BIN:$PATH" SPACEO_LIVE_TESTS=1 SWIFT="$STUB_BIN/swift" SPACEO_LIVE_LOG="$TEST_ROOT/live.log" \
        bash "$REPOSITORY_ROOT/scripts/test.sh" live "$@" 2>&1
}

# A failed health check must not start XCTest or create a display owner.
if STUB_HOST_HEALTH_EXIT=1 run_test_sh_live "$TEST_ROOT/all-skipped.log" 0 >"$TEST_ROOT/health-refusal.log"; then
    fail "live tests accepted a failed host-health check"
fi
[[ ! -e "$TEST_ROOT/invocation.txt" ]] || fail "host-health refusal launched XCTest"
grep -Fq "host is not quiet enough" "$TEST_ROOT/health-refusal.log" || fail "missing host-health refusal"

# A green XCTest transcript cannot hide a failing final OS-health sample.
if output="$(STUB_HEALTH_COUNT="$TEST_ROOT/health-count" STUB_POST_HEALTH_EXIT=1 \
    run_test_sh_live "$TEST_ROOT/real-count.log" 0 --require-full)"; then
    fail "live tests accepted a failed postflight after successful assertions"
fi
grep -Fq "postflight host health refused" <<<"$output" || fail "missing postflight refusal"
[[ "$(cat "$TEST_ROOT/health-count")" == 2 ]] || fail "health checks did not bracket XCTest"

# A run where every test skipped must fail even though the compiler reported success.
if output="$(run_test_sh_live "$TEST_ROOT/all-skipped.log" 0 --require-full)"; then
    fail "test.sh live --require-full accepted a run in which every test skipped:
$output"
fi
grep -Fq "live test(s) skipped" <<<"$output" \
    || fail "test.sh live --require-full did not reach the skip gate:
$output"

# --require-full must be consumed by test.sh, never forwarded to swift.
grep -Fq -- "--require-full" "$TEST_ROOT/invocation.txt" \
    && fail "test.sh forwarded --require-full to swift test"
grep -Fq -- "-XCTest SpaceOKitTests.IntegrationTests" "$TEST_ROOT/invocation.txt" \
    || fail "test.sh did not filter to the live suite: $(cat "$TEST_ROOT/invocation.txt")"

# Parallel workers must be rejected before they reach the compiler.
grep -Fq -- "/SpaceOPackageTests.xctest" "$TEST_ROOT/invocation.txt" \
    || fail "test.sh did not discover the package test product"
mkdir -p "$STUB_BIN/StaleTests.xctest"
if run_test_sh_live "$TEST_ROOT/real-count.log" 0 >/dev/null 2>&1; then
    fail "ambiguous test products must be rejected"
fi
rmdir "$STUB_BIN/StaleTests.xctest"
mv "$STUB_BIN/SpaceOPackageTests.xctest" "$STUB_BIN/SpaceOKitTests.xctest"
echo "Test Case '-[SpaceOKitTests.IntegrationTests testStageCreateAndDestroyLeavesNoDisplay]' passed (0.1 seconds)." >"$TEST_ROOT/focused.log"
run_test_sh_live "$TEST_ROOT/focused.log" 0 --case=testStageCreateAndDestroyLeavesNoDisplay >/dev/null
grep -Fq -- "-XCTest SpaceOKitTests.IntegrationTests/testStageCreateAndDestroyLeavesNoDisplay" "$TEST_ROOT/invocation.txt" \
    || fail "test.sh did not select exactly the requested case"
for fixture in empty all-skipped real-count; do
    if run_test_sh_live "$TEST_ROOT/$fixture.log" 0 --case=testStageCreateAndDestroyLeavesNoDisplay >/dev/null; then
        fail "focused run accepted $fixture instead of its single passing case"
    fi
done
if run_test_sh_live "$TEST_ROOT/focused.log" 0 --case=testDoesNotExist >/dev/null; then
    fail "focused run accepted a nonexistent case"
fi
if run_test_sh_live "$TEST_ROOT/focused.log" 0 --case=testStageCreateAndDestroyLeavesNoDisplay --require-full >/dev/null; then
    fail "focused run was accepted as full qualification"
fi
echo "Test Case 'SpaceOKitTests.IntegrationTests.testStageCreateAndDestroyLeavesNoDisplay' passed (0.1 seconds)." >"$TEST_ROOT/focused-swift.log"
run_test_sh_live "$TEST_ROOT/focused-swift.log" 0 --case=testStageCreateAndDestroyLeavesNoDisplay >/dev/null
if output="$(run_test_sh_live "$TEST_ROOT/real-count.log" 0 --filter SomeOtherTests)"; then
    fail "raw filters can widen the live suite and must be rejected"
fi

if output="$(run_test_sh_live "$TEST_ROOT/real-count.log" 0 --parallel)"; then
    fail "parallel live execution was accepted"
fi
grep -Fq "parallel live tests are unsafe" <<<"$output" || fail "missing parallel refusal"

# Direct live invocation is inert without the reserved-host opt-in.
if output="$(PATH="$STUB_BIN:$PATH" SPACEO_LIVE_TESTS=0 SWIFT="$STUB_BIN/swift" bash "$REPOSITORY_ROOT/scripts/test.sh" live 2>&1)"; then
    fail "live execution was accepted without opt-in"
fi
grep -Fq "SPACEO_LIVE_TESTS=1" <<<"$output" || fail "missing opt-in refusal"

# A fully executed run passes, and SPACEO_LIVE_LOG retains the transcript for the CI artifact.
run_test_sh_live "$TEST_ROOT/real-count.log" 0 --require-full >/dev/null \
    || fail "test.sh live --require-full rejected a fully executed run"
grep -Fq "Test Case " "$TEST_ROOT/live.log" \
    || fail "SPACEO_LIVE_LOG did not retain the run transcript"

# The automatically-created log must use a portable BSD mktemp template. A stale literal path is
# what older test.sh versions generated when they put `.log` after the X placeholder.
mkdir -p "$TEST_ROOT/tmp"
: >"$TEST_ROOT/tmp/spaceo-live-tests.XXXXXX.log"
STUB_LOG="$TEST_ROOT/real-count.log" STUB_EXIT=0 \
    STUB_INVOCATION="$TEST_ROOT/invocation-auto-log.txt" SWIFT="$STUB_BIN/swift" \
    PATH="$STUB_BIN:$PATH" SPACEO_LIVE_TESTS=1 TMPDIR="$TEST_ROOT/tmp" bash "$REPOSITORY_ROOT/scripts/test.sh" live --require-full \
    >/dev/null \
    || fail "test.sh could not create a unique automatic live-test log"

# A genuine test failure must survive the gate rather than being masked by tee.
if run_test_sh_live "$TEST_ROOT/real-count.log" 1 --require-full >/dev/null 2>&1; then
    fail "test.sh live --require-full reported success for a run that swift test failed"
fi

# Without --require-full the developer default is unchanged: skips do not fail the run.
run_test_sh_live "$TEST_ROOT/all-skipped.log" 0 >/dev/null 2>&1 \
    || fail "test.sh live (no flag) must keep skipping benign, on an explicitly reserved host"

echo "live test gate tests passed"
