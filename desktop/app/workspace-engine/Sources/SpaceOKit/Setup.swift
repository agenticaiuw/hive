import CoreGraphics
import Foundation
import ImageIO

/// One checked prerequisite, and what to do when it is not met.
public struct SetupStep: Sendable, Equatable {
    public enum Status: String, Sendable, Equatable {
        case pass
        case fail
        case skipped
    }

    public let name: String
    public let status: Status
    public let detail: String
    /// Exactly what the reader should do next. `doctor` already sets this bar; a setup command
    /// that says "accessibility: missing" and stops is the dead end this replaces.
    public let remedy: String?

    public init(name: String, status: Status, detail: String, remedy: String? = nil) {
        self.name = name
        self.status = status
        self.detail = detail
        self.remedy = remedy
    }
}

/// Guided first-run setup for the CLI/MCP path.
///
/// `doctor` reports state and `session.create` fails fast, but neither walks a new user from a
/// fresh machine to a working agent. The checks below run in dependency order, because a missing
/// runtime API makes a permission prompt pointless and a denied permission makes the self-test
/// meaningless — reporting all three as equal failures sends people to fix the wrong one.
public enum Setup {
    public static let selfTestSessionName = "spaceo-setup-selftest"

    public struct Environment: Sendable, Equatable {
        public var executablePath: String
        public var accessibility: Bool
        public var screenRecording: Bool
        public var runtimeCapabilities: [Capabilities.Item]
        public var daemonRunning: Bool
        public var socketPath: String
        public var builtWithARC: Bool

        public init(
            executablePath: String,
            accessibility: Bool,
            screenRecording: Bool,
            runtimeCapabilities: [Capabilities.Item],
            daemonRunning: Bool,
            socketPath: String,
            builtWithARC: Bool = true
        ) {
            self.executablePath = executablePath
            self.accessibility = accessibility
            self.screenRecording = screenRecording
            self.runtimeCapabilities = runtimeCapabilities
            self.daemonRunning = daemonRunning
            self.socketPath = socketPath
            self.builtWithARC = builtWithARC
        }
    }

    /// Runtime APIs SpaceO cannot work without. Mirrors `Capabilities.canDrive`, minus the TCC
    /// grants, which are reported separately because their remedy is completely different.
    public static let requiredRuntimeCapabilities = [
        "virtual-display", "space-query", "per-pid-events", "ax-window-id",
    ]

    public static func prerequisites(_ environment: Environment) -> [SetupStep] {
        var steps: [SetupStep] = []

        var missing = requiredRuntimeCapabilities.filter { name in
            environment.runtimeCapabilities.first { $0.name == name }?.available != true
        }
        if !environment.builtWithARC { missing.append("Objective-C ARC (required for display teardown)") }
        steps.append(SetupStep(
            name: "runtime apis",
            status: missing.isEmpty ? .pass : .fail,
            detail: missing.isEmpty
                ? "every private display, Space, and input symbol SpaceO needs is present"
                : "unavailable: \(missing.joined(separator: ", "))",
            remedy: missing.isEmpty ? nil
                : "This macOS build does not expose a runtime API SpaceO requires. Run "
                    + "`spaceo doctor` for the per-symbol detail. There is no workaround on this "
                    + "host; see docs/PRIVATE_API_SUPPORT.md."))

        steps.append(SetupStep(
            name: "accessibility",
            status: environment.accessibility ? .pass : .fail,
            detail: environment.accessibility
                ? "granted for this process; required for window placement and AX input"
                : "not granted; window placement and every input command will fail",
            remedy: environment.accessibility ? nil
                : "Open System Settings → Privacy & Security → Accessibility and enable the "
                    + "program that runs spaceo — for a terminal session that is the terminal "
                    + "app itself, not the spaceo binary. Then run `spaceo setup` again."))

        steps.append(SetupStep(
            name: "screen recording",
            status: environment.screenRecording ? .pass : .fail,
            detail: environment.screenRecording
                ? "granted for this process; required for screenshots"
                : "not granted; screenshots will fail, but input still works",
            remedy: environment.screenRecording ? nil
                : "Open System Settings → Privacy & Security → Screen & System Audio Recording "
                    + "and enable the program that runs spaceo. Then run `spaceo setup` again."))

        steps.append(SetupStep(
            name: "daemon",
            status: environment.daemonRunning ? .pass : .skipped,
            detail: environment.daemonRunning
                ? "reachable at \(environment.socketPath)"
                : "not running at \(environment.socketPath)",
            remedy: environment.daemonRunning ? nil
                : "Sessions outlive one command, so they live in a daemon. Start it with "
                    + "`spaceo daemon &`, or let an MCP client start it on demand."))

        return steps
    }

    /// The self-test only means something once every hard prerequisite holds. Running it anyway
    /// would replace one clear message with a second, less specific failure.
    public static func canSelfTest(_ steps: [SetupStep]) -> Bool {
        !steps.contains { $0.status == .fail }
    }

    /// Per-client MCP registration, with the resolved path substituted in.
    ///
    /// These clients do not all expand `~`, which is why the absolute path matters enough to
    /// print rather than describe.
    public static func clientConfiguration(executablePath: String) -> String {
        // The same path crosses three different grammars. Shell double quotes still expand
        // dollars/backticks; JSON/TOML also need escaping for quotes, slashes and controls.
        let shellPath = "'" + executablePath.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        let literal = configurationString(executablePath)
        return """
        Claude Code:
          claude mcp add -s user spaceo -- \(shellPath) mcp

        Codex — add to ~/.codex/config.toml:
          [mcp_servers.spaceo]
          command = \(literal)
          args = ["mcp"]

        Cursor / Claude Desktop — add to mcp.json / claude_desktop_config.json:
          { "mcpServers": { "spaceo": {
            "command": \(literal), "args": ["mcp"]
          } } }
        """
    }

    /// JSON string escapes are also valid in TOML basic strings (unlike JSON's optional \/).
    static func configurationString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5C: result += "\\\\"
            case 0...0x1F, 0x7F: result += String(format: "\\u%04X", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    /// Diagnose the process that will actually perform the self-test. Caller TCC grants do not
    /// imply daemon grants, and a reachable old daemon must not qualify a newly installed CLI.
    public static func daemonChecks(
        response: Response?,
        executableBuildUUID: String?,
        executableSHA256: String?,
        socketPath: String
    ) -> [SetupStep] {
        guard let response, response.ok else {
            return [SetupStep(name: "daemon", status: .fail,
                detail: "no daemon answered at \(socketPath)",
                remedy: "Run `spaceo doctor`; start the daemon from the app with the required grants.")]
        }
        let runtime = response.daemon
        let matches = RuntimeIdentity.matches(
            runtime, executableBuildUUID: executableBuildUUID,
            executableSHA256: executableSHA256)
        let restart = "From the app with the required grants, run `spaceo daemon restart --operator`: "
            + "it waits for live sessions to finish, then starts this build. Then run `spaceo setup` "
            + "again. If another controller owns a session, coordinate with its owner first."
        return [
            SetupStep(name: "daemon", status: .pass, detail: "reachable at \(socketPath)"),
            SetupStep(name: "daemon build", status: matches == true ? .pass : .fail,
                detail: matches == true ? "matches this CLI"
                    : (matches == false ? "does not match this CLI" : "cannot verify the running build"),
                remedy: matches == true ? nil : restart),
            SetupStep(name: "daemon input", status: runtime?.canDrive == true ? .pass : .fail,
                detail: runtime?.canDrive == true ? "driving prerequisites available in the daemon"
                    : "daemon driving prerequisites are missing or unknown",
                remedy: runtime?.canDrive == true ? nil
                    : "Run `spaceo doctor` and check daemon Accessibility and runtime support. " + restart),
            SetupStep(name: "daemon capture", status: runtime?.canCapture == true ? .pass : .fail,
                detail: runtime?.canCapture == true ? "capture prerequisites available in the daemon"
                    : "daemon capture prerequisites are missing or unknown",
                remedy: runtime?.canCapture == true ? nil
                    : "Grant Screen Recording to the app hosting the daemon. " + restart),
        ]
    }

    public static func report(steps: [SetupStep]) -> String {
        var lines = ["SpaceO setup"]
        for step in steps {
            let mark: String
            switch step.status {
            case .pass: mark = "ok  "
            case .fail: mark = "MISS"
            case .skipped: mark = "--  "
            }
            lines.append("  \(mark) \(step.name.padding(toLength: max(step.name.count, 18), withPad: " ", startingAt: 0))  \(step.detail)")
            if let remedy = step.remedy {
                for line in remedy.split(separator: "\n", omittingEmptySubsequences: false) {
                    lines.append("         \(line)")
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Live steps

    /// Start a daemon the way an MCP client would, and wait for it to answer.
    public static func startDaemon(
        executablePath: String,
        socketPath: String,
        timeout: TimeInterval = 10
    ) -> Bool {
        if Transport.ping(socketPath) { return true }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = ["daemon", "--socket", socketPath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return false
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Transport.ping(socketPath) { return true }
            if !process.isRunning { return false }
            usleep(200_000)
        }
        return false
    }

    /// Exercise the socket contract without launching apps or sending input. This proves session
    /// creation and capture only; app compatibility and isolation need the live qualification suite.
    public static func selfTest(socketPath: String) -> SetupStep {
        selfTest { request in
            try Transport.send(request, to: socketPath, timeout: 60)
        }
    }

    /// Inject transport so safe tests can exercise ownership, capture, and cleanup failures
    /// without creating displays or requesting TCC grants.
    static func selfTest(send: (Request) throws -> Response) -> SetupStep {
        let sessionName = selfTestSessionName + "-" + UUID().uuidString.lowercased()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(sessionName, isDirectory: true)
        let output = directory.appendingPathComponent("capture.png")
        let recovery = "Run `spaceo session list` to inspect '\(sessionName)'. If cleanup is pending, "
            + "retry `spaceo session destroy --session \(sessionName) --operator`. "
            + "Do not stop a shared daemon while other sessions are active."
        do {
            try FileManager.default.createDirectory(at: directory,
                withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        } catch {
            return SetupStep(name: "self-test", status: .fail,
                detail: "could not prepare private capture storage: \(error.localizedDescription)",
                remedy: "Check free disk space and access to the temporary directory.")
        }
        defer { try? FileManager.default.removeItem(at: directory) }

        var create = Request(cmd: "session.create")
        create.session = sessionName
        create.controllerOwner = DurableSessionOwner(
            id: sessionName, kind: .cli, label: "SpaceO setup self-test")
        let created: Response
        do {
            created = try send(create)
        } catch {
            return SetupStep(name: "self-test", status: .fail,
                detail: "session creation outcome unknown: \(error.localizedDescription)",
                remedy: recovery)
        }
        guard created.ok else {
            return SetupStep(name: "self-test", status: .fail,
                detail: "could not create a session: \(created.error ?? "unknown failure")",
                remedy: "Run `spaceo doctor` and inspect the daemon log. " + recovery)
        }
        guard let lease = created.controllerLeaseID else {
            return SetupStep(name: "self-test", status: .fail,
                detail: "session created but the daemon returned no controller lease; cleanup is unconfirmed",
                remedy: recovery)
        }

        var captureFailure: String?
        do {
            var shot = Request(cmd: "screenshot")
            shot.session = sessionName
            shot.controllerLeaseID = lease
            shot.full = true
            shot.output = output.path
            let captured = try send(shot)
            if !captured.ok {
                captureFailure = captured.error ?? "capture refused"
            } else if !validSelfTestCapture(at: output) {
                captureFailure = "the daemon did not write a valid PNG capture"
            }
        } catch {
            captureFailure = error.localizedDescription
        }

        var cleanupFailure: String?
        do {
            var destroy = Request(cmd: "session.destroy")
            destroy.session = sessionName
            destroy.controllerLeaseID = lease
            destroy.quitApps = true
            let destroyed = try send(destroy)
            if !destroyed.ok || destroyed.teardown?.isComplete == false {
                cleanupFailure = destroyed.error ?? "session teardown is incomplete"
            }
        } catch {
            cleanupFailure = error.localizedDescription
        }
        if let cleanupFailure {
            return SetupStep(name: "self-test", status: .fail,
                detail: (captureFailure.map { "capture failed: \($0); " } ?? "capture completed; ")
                    + "cleanup unconfirmed: \(cleanupFailure)",
                remedy: recovery)
        }
        if let captureFailure {
            return SetupStep(name: "self-test", status: .fail,
                detail: "session teardown confirmed, but capture failed: \(captureFailure)",
                remedy: "Run `spaceo doctor` and check the daemon's Screen Recording grant before retrying.")
        }
        return SetupStep(name: "self-test", status: .pass,
            detail: "created and captured a session; session teardown confirmed. "
                + "Empty displays retire after the daemon's reuse grace.")
    }

    private static func validSelfTestCapture(at url: URL) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let bytes = attributes[.size] as? NSNumber,
              bytes.intValue > 0, bytes.intValue <= 64 * 1_048_576,
              let source = CGImageSourceCreateWithURL(url as CFURL,
                  [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetType(source) as String? == "public.png",
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetCount(source) == 1 else { return false }
        // Decode a bounded thumbnail to reject corrupt payloads without allocating a full frame.
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 32,
            kCGImageSourceShouldCache: false,
        ] as CFDictionary) != nil
    }
}
