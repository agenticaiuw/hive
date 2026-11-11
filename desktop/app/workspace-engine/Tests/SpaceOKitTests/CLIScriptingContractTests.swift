import XCTest
import SpaceOKit

/// The CLI as scripts see it, end to end: the built `spaceo` binary against an in-process fake
/// daemon (`Transport.Server` on a temporary socket). No real daemon, display, or app is involved.
final class CLIScriptingContractTests: XCTestCase {

    // MARK: - Harness

    private struct Result {
        let stdout: String
        let stderr: String
        let status: Int32
    }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var requests: [Request] = []
        func append(_ request: Request) { lock.withLock { requests.append(request) } }
        var all: [Request] { lock.withLock { requests } }
    }

    private var fixtureHome: URL!

    override func setUpWithError() throws {
        fixtureHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-cli-home-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixtureHome, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: fixtureHome)
    }

    private func executable() throws -> URL {
        let url = Bundle(for: CLIScriptingContractTests.self).bundleURL
            .deletingLastPathComponent().appendingPathComponent("spaceo")
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            throw XCTSkip("spaceo executable was not built next to the test bundle")
        }
        return url
    }

    private func run(_ arguments: [String], environment: [String: String] = [:]) throws -> Result {
        let process = Process()
        process.executableURL = try executable()
        process.arguments = arguments
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "SPACEO_SESSION")
        env.removeValue(forKey: "SPACEO_LEASE")
        env.removeValue(forKey: "SPACEO_SOCKET")
        // A fixture home: doctor and setup read MCP client configs from $HOME, and these tests
        // must never read (let alone change) the developer's real ones.
        env["HOME"] = fixtureHome.path
        // Foundation resolves the account home independently of HOME on macOS. Keep its
        // lifecycle-journal and other Application Support reads inside the same fixture.
        env["CFFIXED_USER_HOME"] = fixtureHome.path
        env.merge(environment) { $1 }
        process.environment = env
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let watchdog = DispatchWorkItem { [weak process] in
            if process?.isRunning == true { process?.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: watchdog)
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        watchdog.cancel()
        return Result(stdout: String(decoding: stdout, as: UTF8.self),
                      stderr: String(decoding: stderr, as: UTF8.self),
                      status: process.terminationStatus)
    }

    /// Serves `respond` on a fresh socket for the duration of `body`.
    private func withDaemon<T>(_ respond: @escaping @Sendable (Request) -> Response,
                               _ body: (String, Recorder) throws -> T) throws -> T {
        let path = "/tmp/so-cli-\(UUID().uuidString.prefix(12)).sock"
        let recorder = Recorder()
        let server = Transport.Server(path: path) { request in
            recorder.append(request)
            return respond(request)
        }
        try server.start()
        defer { server.stop() }
        return try body(path, recorder)
    }

    private func missingSocket() -> String { "/tmp/so-none-\(UUID().uuidString.prefix(12)).sock" }

    private func json(_ text: String) throws -> [String: Any] {
        let lines = text.split(separator: "\n")
        XCTAssertEqual(lines.count, 1, "exactly one JSON object on stdout: \(text)")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], text)
    }

    private static func runtime(_ version: String) -> DaemonRuntimeInfo {
        DaemonRuntimeInfo(version: version, executableSHA256: nil, pid: 4321,
                          instanceID: UUID(), startedAt: Date())
    }

    // MARK: - Exit codes

    func testTimedOutWaitExitsSixSoAndChainsStop() throws {
        for (outcome, expected) in [("timeout", Int32(6)), ("met", Int32(0))] {
            let result = try withDaemon({ _ in
                var response = Response.success()
                response.wait = WaitReceipt(condition: "element_label", value: "Save", outcome: outcome,
                                            elapsedSeconds: 0.5, probes: 2)
                return response
            }) { socket, _ in
                try run(["wait", "element_label", "Save", "--timeout", "1", "--socket", socket])
            }
            XCTAssertEqual(result.status, expected, "outcome \(outcome): \(result.stderr)")
            if outcome == "timeout" { XCTAssertTrue(result.stderr.contains("wait condition not met")) }
        }
    }

    func testDaemonNotRunningExitsThreeWithANextLine() throws {
        let result = try run(["session", "list", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 3)
        XCTAssertTrue(result.stderr.contains("no SpaceO daemon listening"))
        XCTAssertTrue(result.stderr.contains("\nnext: "), result.stderr)

        let jsonResult = try run(["session", "list", "--json", "--socket", missingSocket()])
        XCTAssertEqual(jsonResult.status, 3)
        let object = try json(jsonResult.stdout)
        XCTAssertEqual(object["errorCode"] as? String, "daemon_not_running")
        XCTAssertNotNil(object["nextAction"] as? String)
    }

    func testLeaseRefusalExitsFour() throws {
        let result = try withDaemon({ _ in .failure(SpaceOError.badRequest("controller lease does not match session 'a'")) }) { socket, _ in
            try run(["click", "--element", "3", "--socket", socket])
        }
        XCTAssertEqual(result.status, 4, result.stderr)
    }

    func testIsolationBreachExitsFive() throws {
        let result = try withDaemon({ _ in .failure(SpaceOError.isolationBreached("menu bar moved")) }) { socket, _ in
            try run(["verify", "--socket", socket])
        }
        XCTAssertEqual(result.status, 5, result.stderr)
    }

    func testUsageErrorsExitTwoAndNeverEmbedUsage() throws {
        let unknown = try run(["--json", "frobnicate"])
        XCTAssertEqual(unknown.status, 2)
        let object = try json(unknown.stdout)
        XCTAssertEqual(object["errorCode"] as? String, "usage_error")
        XCTAssertFalse((object["error"] as? String ?? "").contains("give each agent"), "no usage text in JSON")

        let text = try run(["frobnicate"])
        XCTAssertEqual(text.status, 2)
        XCTAssertLessThan(text.stderr.split(separator: "\n").count, 4, "a sentence and a next line, not the usage")

        let option = try run(["version", "--sesion", "typo"])
        XCTAssertEqual(option.status, 2)
        XCTAssertTrue(option.stderr.contains("unknown option"))
        XCTAssertTrue(option.stderr.contains("next: spaceo version --help"))
    }

    func testConflictingAliasesAreRejected() throws {
        let result = try run(["session", "create", "--name", "a", "--session", "b", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 2)
        XCTAssertTrue(result.stderr.contains("--session and --name are the same option"), result.stderr)
    }

    // MARK: - JSON contract

    func testGlobalFlagsMayPrecedeTheCommand() throws {
        let result = try withDaemon({ _ in
            var response = Response.success()
            response.sessions = []
            return response
        }) { socket, recorder in
            let result = try run(["--json", "--socket", socket, "session", "list"])
            XCTAssertEqual(recorder.all.last?.cmd, "session.list")
            return result
        }
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertEqual(try json(result.stdout)["ok"] as? Bool, true)
    }

    func testJSONOutputIsOneSortedObjectForHostCommands() throws {
        for arguments in [["version", "--json"], ["daemon", "status", "--json"],
                          ["skill", "--json"], ["schema", "--json"],
                          ["daemon", "stop", "--json", "--socket", missingSocket()],
                          ["clean", "--dry-run", "--json", "--socket", missingSocket()]] {
            let result = try run(arguments)
            XCTAssertEqual(result.status, 0, "\(arguments): \(result.stderr)")
            let object = try json(result.stdout)
            XCTAssertEqual(object["ok"] as? Bool, true, "\(arguments)")
        }
    }

    // MARK: - Version drift

    func testOlderDaemonWarnsOnceAndOutdatedCommandsSayRestart() throws {
        let respond: @Sendable (Request) -> Response = { request in
            var response: Response
            if request.cmd == "ax.find" {
                response = Response(ok: false)
                response.error = "unknown command 'ax.find'"
                response.errorCode = "bad_request"
            } else {
                response = .success()
                response.sessions = []
            }
            response.daemon = Self.runtime("0.9.0")
            return response
        }
        try withDaemon(respond) { socket, _ in
            let listed = try run(["session", "list", "--socket", socket])
            XCTAssertEqual(listed.status, 0)
            XCTAssertEqual(listed.stderr.components(separatedBy: "warning: the running daemon is 0.9.0 (pid 4321)").count, 2,
                           "exactly one drift warning: \(listed.stderr)")
            XCTAssertTrue(listed.stderr.contains("spaceo daemon restart --operator"))

            let found = try run(["find", "Save", "--socket", socket])
            XCTAssertEqual(found.status, 3)
            XCTAssertTrue(found.stderr.contains("the running daemon (0.9.0) predates `spaceo find`"), found.stderr)
            XCTAssertFalse(found.stderr.contains("error: unknown command"))

            let jsonFound = try run(["find", "Save", "--json", "--socket", socket])
            let object = try json(jsonFound.stdout)
            XCTAssertEqual(object["errorCode"] as? String, "daemon_outdated")
            XCTAssertEqual(object["nextAction"] as? String, "spaceo daemon restart --operator")
            XCTAssertTrue((object["warnings"] as? [String])?.first?.contains("0.9.0") == true)
        }
    }

    func testMatchingDaemonPrintsNoWarning() throws {
        try withDaemon({ _ in
            var response = Response.success()
            response.sessions = []
            response.daemon = Self.runtime(SpaceOVersion.current)
            return response
        }) { socket, _ in
            let result = try run(["session", "list", "--socket", socket])
            XCTAssertFalse(result.stderr.contains("warning:"), result.stderr)
        }
    }

    // MARK: - Environment defaults and export

    func testSessionAndLeaseComeFromTheEnvironmentAndFlagsWin() throws {
        let lease = UUID()
        let other = UUID()
        try withDaemon({ _ in .success() }) { socket, recorder in
            _ = try run(["click", "--element", "3", "--socket", socket],
                        environment: ["SPACEO_SESSION": "from-env", "SPACEO_LEASE": lease.uuidString])
            XCTAssertEqual(recorder.all.last?.session, "from-env")
            XCTAssertEqual(recorder.all.last?.controllerLeaseID, lease)

            _ = try run(["click", "--element", "3", "--session", "flag", "--lease", other.uuidString, "--socket", socket],
                        environment: ["SPACEO_SESSION": "from-env", "SPACEO_LEASE": lease.uuidString])
            XCTAssertEqual(recorder.all.last?.session, "flag")
            XCTAssertEqual(recorder.all.last?.controllerLeaseID, other)

            _ = try run(["session", "create", "--socket", socket],
                        environment: ["SPACEO_SESSION": "from-env", "SPACEO_LEASE": lease.uuidString])
            XCTAssertEqual(recorder.all.last?.cmd, "session.create")
            XCTAssertNil(recorder.all.last?.session, "create never reuses the exported session name")
            XCTAssertNil(recorder.all.last?.controllerLeaseID)
        }
        let bad = try run(["click", "--element", "3", "--socket", missingSocket()],
                          environment: ["SPACEO_LEASE": "not-a-uuid"])
        XCTAssertEqual(bad.status, 2)
        XCTAssertTrue(bad.stderr.contains("SPACEO_LEASE must be a UUID"), bad.stderr)
    }

    func testSessionCreateExportIsEvalable() throws {
        let lease = UUID()
        let expires = Date().addingTimeInterval(300)
        let result = try withDaemon({ _ in
            var response = Response.success("created")
            response.controllerLeaseID = lease
            let json = """
            {"id":"it's","displayID":1,"x":0,"y":0,"width":10,"height":10,"tileIndex":0,
             "tileCapacity":1,"exclusiveDisplay":false,"spaces":[],"hasOwnSpace":false,"apps":[],
             "windows":[],"createdAt":"2026-01-01T00:00:00Z","teardownPending":false,
             "leaseExpiresAt":"\(expires.ISO8601Format())"}
            """
            response.session = try? Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
            return response
        }) { socket, _ in
            try run(["session", "create", "--export", "--socket", socket])
        }
        XCTAssertEqual(result.status, 0, result.stderr)
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "eval \"$1\"; printf '%s|%s' \"$SPACEO_SESSION\" \"$SPACEO_LEASE\"", "sh", result.stdout]
        process.environment = [:]
        process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "it's|" + lease.uuidString.lowercased())
        XCTAssertTrue(result.stdout.contains("# lease expires at"))
        XCTAssertFalse(result.stdout.contains("controller lease:"), "stdout is only eval-safe text")

        let conflict = try run(["session", "create", "--export", "--json", "--socket", missingSocket()])
        XCTAssertEqual(conflict.status, 2)
    }

    // MARK: - Help

    func testHelpCommandEqualsCommandHelpAndIsShort() throws {
        for words in [["click"], ["session", "create"], ["daemon", "restart"], ["wait"]] {
            let viaHelp = try run(["help"] + words)
            let viaFlag = try run(words + ["--help"])
            XCTAssertEqual(viaHelp.status, 0)
            XCTAssertEqual(viaHelp.stdout, viaFlag.stdout, words.joined(separator: " "))
            XCTAssertFalse(viaHelp.stdout.contains("give each agent its own screen"), "not the global usage")
            XCTAssertFalse(viaHelp.stdout.contains("Options for spaceo help"))
            XCTAssertLessThan(viaHelp.stdout.split(separator: "\n").count, 60)
            XCTAssertTrue(viaHelp.stdout.contains("Examples:"))
        }
        let rejected = try run(["help", "--web"])
        XCTAssertEqual(rejected.status, 2)
        XCTAssertTrue(rejected.stderr.contains("unknown option") && rejected.stderr.contains("--web"))
    }

    /// Every CLISpec command appears in the printed usage, or is deliberately hidden, and every
    /// one has per-command help.
    func testEveryCommandIsDocumentedInUsage() throws {
        let usage = try run([]).stdout
        for key in CLISpec.allowedFlags.keys.sorted() {
            XCTAssertTrue(CLIHelp.usageBlock(for: key, in: usage) != nil || CLIHelp.hiddenCommands.contains(key),
                          "`spaceo \(key.replacingOccurrences(of: ".", with: " "))` is in CLISpec but not in usage; "
                          + "add a usage line or list it in CLIHelp.hiddenCommands")
            XCTAssertNotNil(CLIHelp.render(key: key, usage: usage), key)
        }
        XCTAssertTrue(usage.contains("Exit:"), "usage documents exit codes")
        XCTAssertTrue(usage.contains("SPACEO_SESSION"), "usage documents environment defaults")
    }

    /// Mirrors `scripts/mcp-smoke.mjs`: every command's `--help` works offline, even with other
    /// flags present, and exits 0.
    func testEveryCommandHelpWorksOffline() throws {
        let socket = missingSocket()
        for key in CLISpec.allowedFlags.keys.sorted() + ["pool.set", "session", "daemon"] {
            let result = try run(key.split(separator: ".").map(String.init) + ["--help", "--socket", socket])
            XCTAssertEqual(result.status, 0, "\(key): \(result.stderr)")
            XCTAssertTrue(result.stdout.contains("spaceo"), key)
        }
    }

    func testCompletionsCommand() throws {
        let zsh = try run(["completions", "zsh"])
        XCTAssertEqual(zsh.status, 0)
        XCTAssertTrue(zsh.stdout.hasPrefix("#compdef spaceo"))
        XCTAssertEqual(try run(["completions", "tcsh"]).status, 2)
    }

    // MARK: - Daemon lifecycle messages

    func testStoppingNothingIsAlreadyStopped() throws {
        let result = try run(["daemon", "stop", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertTrue(result.stdout.contains("already stopped"))
    }

    func testCleanDryRunWorksOffline() throws {
        let result = try run(["clean", "--dry-run", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertTrue(result.stdout.contains("dry run: would reclaim"))
        XCTAssertTrue(result.stdout.contains("scanned offline"))
    }

    func testRestartRefusedWithoutOperator() throws {
        let result = try run(["daemon", "restart", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 2)
        XCTAssertTrue(result.stderr.contains("--operator"))
    }

    func testUnknownDaemonSubcommandDoesNotStartADaemon() throws {
        let result = try run(["daemon", "frob", "--socket", missingSocket()])
        XCTAssertEqual(result.status, 2)
        XCTAssertTrue(result.stderr.contains("unknown daemon subcommand"))
    }

    func testSetupClientPrintNeverRunsClaude() throws {
        let result = try run(["setup", "--client", "claude-code", "--print"],
                             environment: ["PATH": "/nonexistent"])
        XCTAssertEqual(result.status, 0, result.stderr)
        XCTAssertEqual(result.stdout.split(separator: "\n").count, 1, "no existing entry: only the add")
        XCTAssertTrue(result.stdout.hasPrefix("claude mcp add -s user spaceo -- "), result.stdout)
    }

    func testSetupClientReplacesAnExistingUserEntry() throws {
        try #"{"mcpServers":{"spaceo":{"command":"/old/spaceo","args":["mcp"]}}}"#
            .write(to: fixtureHome.appendingPathComponent(".claude.json"), atomically: true, encoding: .utf8)
        let result = try run(["setup", "--client", "claude-code", "--print", "--json"])
        XCTAssertEqual(result.status, 0, result.stderr)
        let object = try json(result.stdout)
        let commands = try XCTUnwrap(object["commands"] as? [String])
        XCTAssertEqual(commands.first, "claude mcp remove -s user spaceo")
        XCTAssertTrue(commands.last?.hasPrefix("claude mcp add -s user spaceo -- ") == true)
    }

    func testDoctorRequiresExplicitClientProbeAndPreservesStaleReporting() throws {
        let stale = fixtureHome.appendingPathComponent("old-spaceo")
        let marker = URL(fileURLWithPath: stale.path + ".invoked")
        try "#!/bin/sh\nprintf invoked > \"$0.invoked\"\necho 'spaceo 0.0.1'\n"
            .write(to: stale, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stale.path)
        try "{\"mcpServers\":{\"spaceo\":{\"command\":\"\(stale.path)\",\"args\":[\"mcp\"]}}}"
            .write(to: fixtureHome.appendingPathComponent(".claude.json"), atomically: true, encoding: .utf8)
        let result = try run(["doctor", "--json", "--socket", missingSocket()])
        let object = try json(result.stdout)
        let clients = try XCTUnwrap(object["mcpClients"] as? [[String: Any]])
        let claude = try XCTUnwrap(clients.first { $0["client"] as? String == "claude-code" })
        XCTAssertTrue(claude["version"] is NSNull)
        XCTAssertTrue(claude["matchesCLI"] is NSNull)
        XCTAssertTrue((claude["problem"] as? String)?.contains("not executed") == true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertNotNil(claude["remedy"] as? String)
        XCTAssertEqual(clients.filter { $0["configured"] as? Bool == false }.count, 3)
        let daemon = try XCTUnwrap(object["daemon"] as? [String: Any])
        XCTAssertEqual(daemon["state"] as? String, "not_running")

        let text = try run(["doctor", "--probe-client-versions", "--socket", missingSocket()])
        XCTAssertTrue(text.stdout.contains("\nMCP clients\n"))
        XCTAssertTrue(text.stdout.contains("STALE (this CLI is \(SpaceOVersion.current))"))
        XCTAssertTrue(text.stdout.contains("cli version         : \(SpaceOVersion.current) ("))
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }

    /// A socket that accepts but never answers: doctor must say "busy", not "not running", and
    /// must not call its displays orphans or offer fixes.
    func testDoctorDistinguishesABusyDaemon() throws {
        let path = "/tmp/so-busy-\(UUID().uuidString.prefix(12)).sock"
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        defer { close(listener); unlink(path) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutablePointer(to: &address.sun_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: 104) { strcpy($0, path) }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(listener, 16), 0)

        let result = try run(["doctor", "--fix", "--json", "--socket", path])
        let object = try json(result.stdout)
        let daemon = try XCTUnwrap(object["daemon"] as? [String: Any])
        XCTAssertEqual(daemon["state"] as? String, "unresponsive")
        XCTAssertEqual((object["displays"] as? [String: Any])?["orphanedSpaceO"] as? [UInt32], [])
        XCTAssertEqual((object["fixes"] as? [Any])?.count, 0, "no remedy is offered for a busy daemon")
        XCTAssertEqual((object["readinessBlockers"] as? [[String: Any]])?.first?["code"] as? String,
                       "daemon_unresponsive")
        XCTAssertTrue(result.stderr.contains("nothing to fix"), "fix prose goes to stderr in --json mode")
    }

    func testDoctorJSONIncludesDeferredDaemonOwnersOutsideThePool() throws {
        try withDaemon({ _ in
            var response = Response.success()
            response.displays = []
            var runtime = Self.runtime(SpaceOVersion.current)
            var safety = DisplaySafetyStatus(state: .blocked, reason: "retirement deferred")
            safety.deferredRetirementDisplayIDs = [9002, 9001, 9002]
            runtime.displaySafety = safety
            response.daemon = runtime
            return response
        }) { socket, recorder in
            let result = try run(["doctor", "--json", "--socket", socket])
            let object = try json(result.stdout)
            let displays = try XCTUnwrap(object["displays"] as? [String: Any])
            XCTAssertEqual(displays["daemonDeferredRetirement"] as? [UInt32], [9001, 9002])
            let daemon = try XCTUnwrap(object["daemon"] as? [String: Any])
            let safety = try XCTUnwrap(daemon["displaySafety"] as? [String: Any])
            XCTAssertEqual(safety["deferredRetirementDisplayIDs"] as? [UInt32], [9002, 9001, 9002])
            XCTAssertEqual(recorder.all.map(\.cmd), ["pool", "clean"])
            let hygieneProbe = try XCTUnwrap(recorder.all.last)
            XCTAssertEqual(hygieneProbe.dryRun, true, "doctor's existing hygiene probe remains read-only")
            XCTAssertEqual(hygieneProbe.operatorScope, true)
        }
    }

    func testDoctorReadsSafetyJournalFromFixtureHome() throws {
        let directory = fixtureHome.appendingPathComponent("Library/Application Support/SpaceO")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("display-safety.json")
        try Data("{\"attempts\":[],\"pending\":false,\"failure\":\"fixture-only safety failure\"}".utf8)
            .write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let result = try run(["doctor", "--json", "--socket", missingSocket()])
        let object = try json(result.stdout)
        let safety = try XCTUnwrap(object["displaySafety"] as? [String: Any])
        XCTAssertEqual(safety["state"] as? String, "blocked")
        XCTAssertEqual(safety["reason"] as? String, "fixture-only safety failure")
        XCTAssertEqual(result.status, 1)
    }

    func testSafetyRecoveryRefusalIsRuntimeFailureAndMalformedInvocationRemainsUsage() throws {
        let directory = fixtureHome.appendingPathComponent("Library/Application Support/SpaceO")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("display-safety.json")
        let original = Data("{\"attempts\":[],\"pending\":false,\"failure\":\"fixture-only safety failure\"}".utf8)
        try original.write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let refused = try run(["safety", "clear-host-health", "--operator", "--json"])
        XCTAssertEqual(refused.status, CLIExitCode.failure.rawValue)
        XCTAssertEqual(try json(refused.stdout)["errorCode"] as? String, "display_creation_failed")
        XCTAssertEqual(try Data(contentsOf: path), original, "refusal retains the unrelated latch")

        let malformed = try run(["safety", "clear-host-health", "--json"])
        XCTAssertEqual(malformed.status, CLIExitCode.usage.rawValue)
        XCTAssertEqual(try json(malformed.stdout)["errorCode"] as? String, "usage_error")
    }

}
