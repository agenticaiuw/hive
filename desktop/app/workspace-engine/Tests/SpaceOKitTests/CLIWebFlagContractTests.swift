import XCTest
import SpaceOKit

/// `--web` on a pointer or text command means "the coordinates I am handing you are already CSS
/// viewport points" — the numbers `read_screen` prints next to every `wN` element. The daemon
/// branches on `request.web` to decide whether to re-project through the window origin, so a
/// command that advertises the flag and then drops it lands roughly a browser-chrome height from
/// where the agent aimed, silently, with `ok: true`.
///
/// `drag` shipped exactly that hole: its allow-list named `web`, its request builder never set it,
/// and `spaceo drag --web` was accepted with no error and no effect. Accepting a flag and
/// forwarding it are two edits in two places, and only review attention connected them.
///
/// So this closes the loop from outside the process. It asks the CLI which commands it documents,
/// asks the binary itself which of those accept `--web`, and asserts on the request bytes that
/// arrive at a capture socket. Nothing here shares a source of truth with the code under test, and
/// a command that starts accepting `--web` is swept in automatically — the only test edit a new
/// command can require is an `invocationArguments` entry, and the failure message says so.
final class CLIWebFlagContractTests: XCTestCase {

    /// Commands that need extra argv before they will build a request at all. Without it the
    /// process exits during argument handling and the probe learns nothing about `--web`.
    private static let invocationArguments: [String: [String]] = [
        "session": ["list"],   // a bare `session` prints its subcommand list and exits
        "type": ["hello"],
        "key": ["cmd+s"],
        "clipboard": ["get"],
        "open-url": ["https://example.com"],
        "wait": ["ms", "1"],
        "find": ["Save"],
        "steps": ["--steps-json", "[]"],
        "report": ["/tmp/spaceo-no-such-recording"],
        "events": [],
        "clean": [],
        "daemon": ["status"],
    ]

    /// The floor. The enumeration below is the real guard; this catches an enumeration that breaks
    /// and lets the sweep pass by finding nothing.
    private static let commandsKnownToAcceptWeb: Set<String> = [
        "click", "scroll", "move", "drag", "type", "key",
    ]

    // MARK: - The contract

    func testEveryCommandAcceptingWebForwardsItToTheDaemon() throws {
        let socket = try CaptureSocket()
        defer { socket.stop() }

        var forwarded: Set<String> = []
        for command in try usageCommands() {
            let argv = [command] + (Self.invocationArguments[command] ?? [])
            let result = try runSpaceO(argv + ["--web", "--socket", socket.path])

            guard let request = socket.drain().last else {
                // Never reached the wire. Acceptable only if it positively rejected `--web`;
                // anything else means the sweep silently lost a command.
                XCTAssertTrue(
                    result.standardError.contains("unknown option")
                        && result.standardError.contains("--web"),
                    """
                    `spaceo \(argv.joined(separator: " ")) --web` neither reached the daemon nor \
                    rejected --web, so this sweep proved nothing about it. Add an \
                    `invocationArguments` entry so the command stays covered. \
                    stderr: \(result.standardError)
                    """)
                continue
            }

            forwarded.insert(command)
            XCTAssertEqual(
                request.web, true,
                """
                `spaceo \(command)` accepts --web but sent web=\(String(describing: request.web)). \
                The daemon will re-project coordinates that are already viewport points, landing a \
                browser-chrome height off with ok: true. Set \
                `request.web = args.bool("web") ? true : nil` in the \(command) case of main.swift.
                """)
        }

        XCTAssertTrue(
            Self.commandsKnownToAcceptWeb.isSubset(of: forwarded),
            """
            the sweep never exercised \
            \(Self.commandsKnownToAcceptWeb.subtracting(forwarded).sorted()) — either usage stopped \
            listing them or they stopped accepting --web. Confirm that is intended.
            """)
    }

    func testJSONEventFollowKeepsGapNoticesMachineReadable() throws {
        let path = "/tmp/spaceo-gap-" + UUID().uuidString + ".sock"
        let server = Transport.Server(path: path) { _ in .success() }
        server.streamHandler = { _, write in
            var gap = Response.success("resync required")
            gap.events = []
            gap.resyncRequired = true
            gap.nextSeq = 12
            _ = write(gap)
            var event = Response(ok: true)
            event.events = [DaemonEvent(seq: 13, at: Date(), kind: "next", session: nil, detail: [:])]
            event.nextSeq = 13
            _ = write(event)
        }
        try server.start()
        defer { server.stop() }
        let result = try runSpaceO(["events", "--follow", "--json", "--socket", path])
        XCTAssertEqual(result.exitStatus, 0)
        let lines = result.standardOutputText.split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        let objects = try lines.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
        XCTAssertEqual(objects.first?["resyncRequired"] as? Bool, true)
        XCTAssertEqual(objects.first?["nextSeq"] as? Int, 12)
        XCTAssertEqual(objects.last?["seq"] as? Int, 13)
    }

    func testEventCursorsRejectInvalidValuesWithoutCrashingOrContactingDaemon() throws {
        let socket = try CaptureSocket()
        defer { socket.stop() }
        for follow in [false, true] {
            for cursor in ["-1", "18446744073709551616", "1.5", "invalid", ""] {
                let result = try runSpaceO(
                    ["events", "--json", "--since-seq", cursor, "--socket", socket.path]
                    + (follow ? ["--follow"] : []))
                XCTAssertEqual(result.exitStatus, 2, "a malformed cursor is a usage error: \(cursor)")
                let payload = try XCTUnwrap(JSONSerialization.jsonObject(
                    with: Data(result.standardOutputText.utf8)) as? [String: Any])
                XCTAssertEqual(payload["ok"] as? Bool, false)
                XCTAssertEqual(payload["errorCode"] as? String, "usage_error")
                XCTAssertTrue((payload["error"] as? String)?.contains("--since-seq") == true)
                XCTAssertTrue(socket.drain().isEmpty)
            }
        }
    }

    func testEventCursorsPreserveFullWireRange() throws {
        let socket = try CaptureSocket()
        defer { socket.stop() }
        for cursor: UInt64 in [0, UInt64(Int.max) + 1, UInt64.max] {
            let result = try runSpaceO([
                "events", "--since-seq", String(cursor), "--socket", socket.path,
            ])
            XCTAssertEqual(result.exitStatus, 0)
            XCTAssertEqual(try XCTUnwrap(socket.drain().last).sinceSeq, cursor)
        }
    }

    func testEventFollowConnectionFailureExitsUnsuccessfully() throws {
        let result = try runSpaceO([
            "events", "--follow", "--socket", "/tmp/so-missing-\(UUID().uuidString).sock",
        ])
        XCTAssertEqual(result.exitStatus, 3, "no daemon to stream from is the daemon-unavailable class")
        XCTAssertTrue(result.standardError.contains("stream closed:"))
    }

    func testFailedCommandKeepsRecordingWarningsVisible() throws {
        let path = "/tmp/so-warning-\(UUID().uuidString).sock"
        let server = Transport.Server(path: path) { _ in
            var response = Response(ok: false)
            response.error = "command fixture failed"
            response.warnings = ["Recording stopped (capacity_exhausted)"]
            return response
        }
        try server.start()
        defer { server.stop() }
        let result = try runSpaceO(["session", "list", "--socket", path])
        XCTAssertEqual(result.exitStatus, 1)
        XCTAssertTrue(result.standardError.contains("command fixture failed"))
        XCTAssertTrue(result.standardOutputText.contains("warning: Recording stopped (capacity_exhausted)"))
    }

    func testEventFollowDaemonRefusalExitsUnsuccessfully() throws {
        let path = "/tmp/so-refused-\(UUID().uuidString).sock"
        let server = Transport.Server(path: path) { _ in .success() }
        server.streamHandler = { _, write in
            var response = Response(ok: false)
            response.error = "subscription refused"
            _ = write(response)
        }
        try server.start()
        defer { server.stop() }
        let result = try runSpaceO(["events", "--follow", "--socket", path])
        XCTAssertEqual(result.exitStatus, 1)
        XCTAssertTrue(result.standardError.contains("subscription refused"))
    }

    /// The mirror image. Without it, hardcoding `request.web = true` would satisfy the test above
    /// while breaking every caller that means window-local coordinates.
    func testWebIsAbsentWhenTheFlagIsNotPassed() throws {
        let socket = try CaptureSocket()
        defer { socket.stop() }

        for command in Self.commandsKnownToAcceptWeb.sorted() {
            let argv = [command] + (Self.invocationArguments[command] ?? [])
            _ = try runSpaceO(argv + ["--socket", socket.path])
            let request = try XCTUnwrap(
                socket.drain().last, "`spaceo \(command)` did not reach the daemon")
            XCTAssertNil(
                request.web,
                "`spaceo \(command)` sent web=\(String(describing: request.web)) without --web")
        }
    }

    /// The specific regression, spelled out: `drag --web` must carry both endpoints *and* the flag
    /// saying those endpoints are viewport points.
    func testDragForwardsWebAlongsideBothEndpoints() throws {
        let socket = try CaptureSocket()
        defer { socket.stop() }

        _ = try runSpaceO([
            "drag", "--web", "--x", "70", "--y", "37", "--to-x", "300", "--to-y", "37",
            "--socket", socket.path,
        ])

        let request = try XCTUnwrap(socket.drain().last, "`spaceo drag` did not reach the daemon")
        XCTAssertEqual(request.cmd, "drag")
        XCTAssertEqual(request.web, true)
        XCTAssertEqual(request.x, 70)
        XCTAssertEqual(request.y, 37)
        XCTAssertEqual(request.toX, 300)
        XCTAssertEqual(request.toY, 37)
    }

    // MARK: - Harness

    /// Every command the CLI documents, read back from the CLI itself so the sweep grows when the
    /// command table does.
    private func usageCommands() throws -> [String] {
        let usage = try runSpaceO([]).standardOutputText
        var commands: [String] = []
        for line in usage.split(separator: "\n", omittingEmptySubsequences: false) {
            // Indented `  spaceo <command> …` entries only: the unindented banner is prose, and
            // continuation lines carry flags rather than command names.
            guard line.hasPrefix(" ") else { continue }
            let fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.first == "spaceo", fields.count > 1 else { continue }
            let command = String(fields[1])
            guard !command.hasPrefix("-"), !commands.contains(command) else { continue }
            commands.append(command)
        }
        XCTAssertFalse(commands.isEmpty, "could not read any commands out of `spaceo` usage")
        return commands
    }

    /// A daemon that answers every request and remembers what it was asked, so assertions land on
    /// the decoded wire payload rather than on the CLI's own view of its arguments.
    private final class CaptureSocket {
        let path: String
        private let directory: URL
        private let server: Transport.Server
        private let log = RequestLog()

        init() throws {
            directory = URL(
                fileURLWithPath: "/tmp/so-web-\(UUID().uuidString.prefix(8))", isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: false)
            path = directory.appendingPathComponent("daemon.sock").path

            let log = self.log
            server = Transport.Server(path: path) { request in
                log.append(request)
                return .success()
            }
            try server.start()
        }

        /// Returns what has arrived since the last call and clears the log, so each probe in a
        /// sweep reads only its own request.
        func drain() -> [Request] { log.drain() }

        func stop() {
            server.stop()
            try? FileManager.default.removeItem(at: directory)
        }

        /// Shared by the accept-thread handler and the test body, so it carries its own lock.
        private final class RequestLog: @unchecked Sendable {
            private let lock = NSLock()
            private var requests: [Request] = []

            func append(_ request: Request) { lock.withLock { requests.append(request) } }

            func drain() -> [Request] {
                lock.withLock {
                    let captured = requests
                    requests = []
                    return captured
                }
            }
        }
    }

    private struct CLIResult {
        let standardOutputText: String
        let standardError: String
        let exitStatus: Int32
    }

    private func runSpaceO(_ arguments: [String]) throws -> CLIResult {
        // SwiftPM places sibling executable products next to the XCTest bundle. Deriving the path
        // from the bundle keeps this independent of architecture-specific `.build` paths.
        let executable = Bundle(for: CLIWebFlagContractTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("spaceo")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw XCTSkip("spaceo executable was not built next to the test bundle")
        }

        let process = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = standardOutput
        process.standardError = standardError
        try process.run()

        // The sweep runs every documented command, `daemon` and `mcp` among them, and those two
        // serve forever once they get past argument validation. They reject `--web` long before
        // that today, but a refactor that reorders those two steps must fail the suite rather than
        // wedge CI.
        let watchdog = DispatchWorkItem { [weak process] in
            guard let process, process.isRunning else { return }
            process.terminate()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: watchdog)

        // Read before waiting: a command whose output overflows the pipe buffer would otherwise
        // block on write while we block on exit.
        let outputData = standardOutput.fileHandleForReading.readDataToEndOfFile()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        watchdog.cancel()

        XCTAssertNotEqual(
            process.terminationReason, .uncaughtSignal,
            "`spaceo \(arguments.joined(separator: " "))` had to be killed by the watchdog")

        return CLIResult(
            standardOutputText: String(data: outputData, encoding: .utf8) ?? "<non-UTF-8 output>",
            standardError: String(data: errorData, encoding: .utf8) ?? "<non-UTF-8 stderr>",
            exitStatus: process.terminationStatus)
    }
}
