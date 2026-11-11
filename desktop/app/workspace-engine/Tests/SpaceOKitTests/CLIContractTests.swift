import XCTest
@testable import SpaceOKit

/// The CLI's machine contract, pinned without spawning the binary: exit classes, the JSON
/// envelope, version-drift detection, leading global flags, and environment defaults.
final class CLIContractTests: XCTestCase {

    private func failure(_ code: String?, _ error: String = "failed") -> Response {
        var response = Response(ok: false)
        response.errorCode = code
        response.error = error
        return response
    }

    private func runtime(version: String, pid: Int32 = 4242) -> DaemonRuntimeInfo {
        DaemonRuntimeInfo(version: version, executableSHA256: nil, pid: pid,
                          instanceID: UUID(), startedAt: Date(timeIntervalSince1970: 0))
    }

    // MARK: - Exit codes

    func testExitCodeTableByFailureClass() {
        let cases: [(Response, String, CLIExitCode)] = [
            (.success(), "click", .success),
            (failure("usage_error"), "click", .usage),
            (failure("daemon_not_running"), "click", .daemonUnavailable),
            (failure("daemon_busy"), "click", .daemonUnavailable),
            (failure("daemon_outdated"), "find", .daemonUnavailable),
            (failure("daemon_draining"), "session.create", .daemonUnavailable),
            (failure("daemon_unresponsive"), "click", .daemonUnavailable),
            (failure("lease_required"), "click", .leaseOrOwnership),
            (failure("session_detached"), "click", .leaseOrOwnership),
            (failure("bad_request", "controller lease does not match session 'a'"), "click", .leaseOrOwnership),
            (failure("bad_request", "session 'a' is abandoned and awaiting reclamation (due)"), "type", .leaseOrOwnership),
            (failure("isolation_breached"), "verify", .isolation),
            (failure("isolation_requirements_unmet"), "click", .isolation),
            (failure("wait_timeout"), "steps", .waitNotMet),
            (failure("wait_queue_timeout"), "wait", .failure),
            (failure("bad_request", "no such app"), "run", .failure),
            (failure(nil, "no code"), "run", .failure),
        ]
        for (response, command, expected) in cases {
            XCTAssertEqual(CLIExitCode.classify(response, command: command), expected,
                           "\(response.errorCode ?? "nil") / \(command)")
        }
    }

    /// The regression: `wait … && click` clicked anyway because a timed-out wait exited 0.
    func testWaitExitsSixUnlessTheConditionWasMet() {
        func waitResponse(_ outcome: String) -> Response {
            var response = Response.success()
            response.wait = WaitReceipt(condition: "element_label", value: "Save", outcome: outcome,
                                        elapsedSeconds: 1, probes: 3)
            return response
        }
        XCTAssertEqual(CLIExitCode.classify(waitResponse("met"), command: "wait"), .success)
        XCTAssertEqual(CLIExitCode.classify(waitResponse("timeout"), command: "wait"), .waitNotMet)
        XCTAssertEqual(CLIExitCode.classify(waitResponse("cancelled"), command: "wait"), .waitNotMet)
        XCTAssertEqual(CLIExitCode.classify(waitResponse("timeout"), command: "steps"), .success,
                       "only `wait` turns an ok receipt into a failure status")
    }

    func testExitCodesAreDistinctAndDocumented() {
        XCTAssertEqual(CLIExitCode.allCases.map(\.rawValue), [0, 1, 2, 3, 4, 5, 6])
        for code in CLIExitCode.allCases {
            XCTAssertTrue(CLIExitCode.summary.contains("\(code.rawValue) \(code.meaning)"))
            XCTAssertTrue(CLIExitCode.compactSummary.contains("\(code.rawValue) "))
        }
    }

    // MARK: - JSON envelope

    func testEnvelopeIsOneSortedObject() throws {
        var response = Response.success("done")
        response.warnings = ["w"]
        response.nextSeq = 3
        let text = CLIJSON.encode(response)
        XCTAssertFalse(text.contains("\n"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, true)
        let keys = ["message", "nextSeq", "ok", "warnings"]
        let positions = keys.compactMap { text.range(of: "\"\($0)\"")?.lowerBound }
        XCTAssertEqual(positions, positions.sorted(), "keys are sorted: \(text)")
    }

    func testErrorEnvelopeNeverCarriesUsage() throws {
        let text = CLIJSON.error(message: "unknown command 'x'", code: "usage_error", nextAction: "spaceo help")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, false)
        XCTAssertEqual(object["errorCode"] as? String, "usage_error")
        XCTAssertEqual(object["nextAction"] as? String, "spaceo help")
        XCTAssertEqual(Set(object.keys), ["ok", "error", "errorCode", "nextAction"])
    }

    func testObjectEnvelopeRejectsNonJSONValuesWithoutTrapping() throws {
        let text = CLIJSON.object(["ok": true, "bad": Date()])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, false)
        XCTAssertEqual(object["errorCode"] as? String, "operation_failed")
    }

    // MARK: - Version drift

    func testDriftWarningNamesBothVersionsAndTheRestart() {
        XCTAssertNil(DaemonVersionDrift.warning(daemon: runtime(version: "1.1.1"), cliVersion: "1.1.1"))
        XCTAssertNil(DaemonVersionDrift.warning(daemon: nil, cliVersion: "1.1.1"))
        XCTAssertEqual(
            DaemonVersionDrift.warning(daemon: runtime(version: "1.0.0", pid: 77), cliVersion: "1.1.1"),
            "the running daemon is 1.0.0 (pid 77); this CLI is 1.1.1 — run `spaceo daemon restart --operator`")
    }

    func testUnknownCommandParsing() {
        XCTAssertEqual(DaemonVersionDrift.unknownCommand(in: "unknown command 'find'"), "find")
        XCTAssertEqual(DaemonVersionDrift.unknownCommand(in: "unknown command 'daemon.drain'"), "daemon.drain")
        XCTAssertNil(DaemonVersionDrift.unknownCommand(in: "no such app"))
        XCTAssertNil(DaemonVersionDrift.unknownCommand(in: "unknown command ''"))
        XCTAssertNil(DaemonVersionDrift.unknownCommand(in: "unknown command '" + String(repeating: "x", count: 65) + "'"),
                     "bounded so a corrupt response cannot inflate the rewrite")
        XCTAssertNil(DaemonVersionDrift.unknownCommand(in: nil))
    }

    func testUnknownCommandFromAnOlderDaemonBecomesDaemonOutdated() {
        var response = failure("bad_request", "unknown command 'ax.find'")
        response.daemon = runtime(version: "1.0.0")
        let rewritten = DaemonVersionDrift.rewritingOutdated(response, cliCommand: "find", cliVersion: "1.1.1")
        XCTAssertEqual(rewritten.errorCode, "daemon_outdated")
        XCTAssertEqual(rewritten.nextAction, "spaceo daemon restart --operator")
        XCTAssertEqual(rewritten.error,
                       "the running daemon (1.0.0) predates `spaceo find` (daemon command `ax.find`); "
                       + "this CLI is 1.1.1. Restart the daemon to use it: `spaceo daemon restart --operator`")
        XCTAssertEqual(CLIExitCode.classify(rewritten, command: "find"), .daemonUnavailable)
    }

    func testSameVersionUnknownCommandIsLeftAlone() {
        var response = failure("bad_request", "unknown command 'frob'")
        response.daemon = runtime(version: "1.1.1")
        let untouched = DaemonVersionDrift.rewritingOutdated(response, cliVersion: "1.1.1")
        XCTAssertEqual(untouched.errorCode, "bad_request")
        XCTAssertEqual(untouched.error, "unknown command 'frob'")
    }

    func testDaemonWithoutProvenanceIsTreatedAsOlder() {
        let response = failure("bad_request", "unknown command 'menu'")
        let rewritten = DaemonVersionDrift.rewritingOutdated(response, cliCommand: "menu", cliVersion: "1.1.1")
        XCTAssertEqual(rewritten.errorCode, "daemon_outdated")
        XCTAssertTrue(rewritten.error?.contains("(an unknown older version) predates `spaceo menu`") == true)
    }

    func testSuccessAndOtherFailuresAreNeverRewritten() {
        var ok = Response.success("fine")
        ok.daemon = runtime(version: "1.0.0")
        XCTAssertTrue(DaemonVersionDrift.rewritingOutdated(ok, cliVersion: "1.1.1").ok)
        var other = failure("launch_failed", "launch failed: nope")
        other.daemon = runtime(version: "1.0.0")
        XCTAssertEqual(DaemonVersionDrift.rewritingOutdated(other, cliVersion: "1.1.1").errorCode, "launch_failed")
    }

    // MARK: - Leading global flags

    func testGlobalFlagsBeforeTheCommandMoveAfterIt() {
        XCTAssertEqual(CLIGlobalFlags.normalize(["--json", "session", "list"]), ["session", "--json", "list"])
        XCTAssertEqual(CLIGlobalFlags.normalize(["--socket", "/tmp/s", "--session", "a", "click", "--element", "3"]),
                       ["click", "--socket", "/tmp/s", "--session", "a", "--element", "3"])
        XCTAssertEqual(CLIGlobalFlags.normalize(["--socket=/tmp/s", "pool"]), ["pool", "--socket=/tmp/s"])
        XCTAssertEqual(CLIGlobalFlags.normalize(["click", "--json"]), ["click", "--json"], "already canonical")
        XCTAssertEqual(CLIGlobalFlags.normalize(["--json"]), ["--json"], "globals alone stay put and fail as unknown")
        XCTAssertEqual(CLIGlobalFlags.normalize(["--web", "click"]), ["--web", "click"],
                       "only global flags may lead")
        let parsed = CLIArguments(Array(CLIGlobalFlags.normalize(["--json", "pool", "set", "4"]).dropFirst()))
        XCTAssertTrue(parsed.hasJSON)
        XCTAssertEqual(parsed.positional, ["set", "4"])
    }

    // MARK: - Environment defaults

    func testEnvironmentDefaultsApplyOnlyWhereTheFlagIsAccepted() {
        let env = ["SPACEO_SESSION": "research", "SPACEO_LEASE": "  1E2A3B4C-0000-4000-8000-000000000001 "]
        XCTAssertEqual(CLIEnvironment.defaultValue(flag: "session", command: "click", environment: env), "research")
        XCTAssertEqual(CLIEnvironment.defaultValue(flag: "lease", command: "click", environment: env),
                       "1E2A3B4C-0000-4000-8000-000000000001")
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "session", command: "session.create", environment: env),
                     "create names a new session; the environment names an existing one")
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "lease", command: "session.create", environment: env))
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "lease", command: "daemon.stop", environment: env),
                     "host-wide commands never inherit a session's lease")
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "lease", command: "clean", environment: env))
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "session", command: "doctor", environment: env),
                     "doctor takes no --session")
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "socket", command: "click", environment: env))
        XCTAssertNil(CLIEnvironment.defaultValue(flag: "session", command: "click", environment: [:]))
    }

    func testEnvironmentValuesAreBounded() {
        for bad in ["", "   ", "a\nb", String(repeating: "x", count: 257)] {
            XCTAssertNil(CLIEnvironment.defaultValue(flag: "session", command: "click",
                                                     environment: ["SPACEO_SESSION": bad]), bad)
        }
    }

    // MARK: - Export

    func testExportLineRoundTripsThroughAShell() throws {
        let session = "it's $(a) `b` \"c\""
        let lease = UUID()
        let line = SessionExport.line(session: session, lease: lease)
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", line + "; printf '%s\\n%s' \"$SPACEO_SESSION\" \"$SPACEO_LEASE\""]
        process.environment = [:]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), session + "\n" + lease.uuidString.lowercased())
    }

    func testExpiryCommentIsAShellComment() {
        let now = Date(timeIntervalSince1970: 1_000)
        let comment = SessionExport.expiryComment(expiresAt: now.addingTimeInterval(300), now: now)
        XCTAssertTrue(comment.hasPrefix("# lease expires at "))
        XCTAssertTrue(comment.contains("(in 300s)"))
        XCTAssertFalse(comment.contains("\n"))
        XCTAssertTrue(SessionExport.expiryComment(expiresAt: nil).hasPrefix("# "))
    }
}
