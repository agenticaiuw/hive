import Foundation

/// Everything `spaceo doctor` observed, as values, so the text can be rendered and golden-tested
/// without a daemon, a display, or a TCC grant.
///
/// Collection (probing the socket, the display graph, client configs) stays in `main.swift`; this
/// type only decides what each observation means and how it reads.
public struct DoctorReport: Sendable {
    /// What answered on the socket.
    public enum DaemonState: Sendable, Equatable {
        case notRunning
        /// Something accepts connections but did not answer a request within the probe timeout.
        /// A busy daemon is still a daemon: its displays are not orphaned, and nothing here may
        /// offer to restart or clean up after it.
        case unresponsive(timeoutSeconds: Double)
        /// A daemon answered. `runtime` is nil for daemons that predate provenance reporting.
        case running(DaemonRuntimeInfo?)

        public var isRunning: Bool {
            if case .running = self { return true }
            return false
        }

        public var isUnresponsive: Bool {
            if case .unresponsive = self { return true }
            return false
        }
    }

    public struct ViewerInstallation: Sendable, Equatable {
        public var path: String
        public var version: String?

        public init(path: String, version: String?) {
            self.path = path
            self.version = version
        }
    }

    /// Capabilities doctor reports as intentionally disabled rather than missing: an absent
    /// optional path is not a defect, and `MISS` sent readers hunting for a fix that must not
    /// exist (the audit documents why the private focus-record path was removed).
    public static let intentionallyDisabledCapabilities: Set<String> = ["focus-without-raise"]
    /// TCC grants, reported under Permissions rather than with the runtime APIs.
    public static let permissionCapabilities: Set<String> = ["accessibility", "screen-recording"]

    public var macOS: String
    public var cliVersion: String
    public var cliPath: String
    public var capabilities: [Capabilities.Item]
    public var missingSymbols: [String]
    public var clientCanDrive: Bool
    public var clientCanCapture: Bool
    public var builtWithARC: Bool
    public var callerAttribution: String?
    public var socketPath: String
    public var daemon: DaemonState
    public var daemonMatchesCLI: Bool?
    public var launchAgentInstalled: Bool
    public var launchAgentRunning: Bool
    public var logPath: String
    public var logBytes: Int?
    public var spaceODisplayIDs: [UInt32]
    /// Only meaningful when the daemon answered; empty otherwise.
    public var orphanedDisplayIDs: [UInt32]
    public var userOnlineDisplayIDs: [UInt32]
    public var userActiveDisplayIDs: [UInt32]
    public var mirroredDisplayIDs: [UInt32]
    public var mcpClients: [MCPClientStatus]
    /// nil when no Viewer was found in the searched locations.
    public var viewer: ViewerInstallation?
    public var viewerSearchPaths: [String]
    public var diskBytes: Int
    public var diskRoot: String?
    public var orphanProfileDirectories: [String]
    public var readiness: PermissionReadinessReport
    public var focusLine: String
    /// Local diagnostic logging (`spaceo logging`); nil omits the section.
    public var logging: LoggingSettings? = nil
    /// Local journal status, also collected when no daemon is running.
    public var displaySafety: DisplaySafetyStatus? = nil
    /// ColorSync state left by per-attachment display identities (RA-057); nil when unreadable.
    public var displayIdentityResidue: DisplayIdentityResidue? = nil

    public var effectiveDisplaySafety: DisplaySafetyStatus? {
        if let local = displaySafety, !local.allowsCreation { return local }
        return runtime?.displaySafety ?? displaySafety
    }

    public init(
        macOS: String, cliVersion: String, cliPath: String,
        capabilities: [Capabilities.Item], missingSymbols: [String],
        clientCanDrive: Bool, clientCanCapture: Bool, builtWithARC: Bool,
        callerAttribution: String?, socketPath: String, daemon: DaemonState,
        daemonMatchesCLI: Bool?, launchAgentInstalled: Bool, launchAgentRunning: Bool,
        logPath: String, logBytes: Int?, spaceODisplayIDs: [UInt32],
        orphanedDisplayIDs: [UInt32], userOnlineDisplayIDs: [UInt32],
        userActiveDisplayIDs: [UInt32], mirroredDisplayIDs: [UInt32],
        mcpClients: [MCPClientStatus], viewer: ViewerInstallation?, viewerSearchPaths: [String],
        diskBytes: Int, diskRoot: String?, orphanProfileDirectories: [String],
        readiness: PermissionReadinessReport, focusLine: String
    ) {
        self.macOS = macOS
        self.cliVersion = cliVersion
        self.cliPath = cliPath
        self.capabilities = capabilities
        self.missingSymbols = missingSymbols
        self.clientCanDrive = clientCanDrive
        self.clientCanCapture = clientCanCapture
        self.builtWithARC = builtWithARC
        self.callerAttribution = callerAttribution
        self.socketPath = socketPath
        self.daemon = daemon
        self.daemonMatchesCLI = daemonMatchesCLI
        self.launchAgentInstalled = launchAgentInstalled
        self.launchAgentRunning = launchAgentRunning
        self.logPath = logPath
        self.logBytes = logBytes
        self.spaceODisplayIDs = spaceODisplayIDs
        self.orphanedDisplayIDs = orphanedDisplayIDs
        self.userOnlineDisplayIDs = userOnlineDisplayIDs
        self.userActiveDisplayIDs = userActiveDisplayIDs
        self.mirroredDisplayIDs = mirroredDisplayIDs
        self.mcpClients = mcpClients
        self.viewer = viewer
        self.viewerSearchPaths = viewerSearchPaths
        self.diskBytes = diskBytes
        self.diskRoot = diskRoot
        self.orphanProfileDirectories = orphanProfileDirectories
        self.readiness = readiness
        self.focusLine = focusLine
    }

    /// Displays with no answering daemon to own them. A daemon that is merely slow still owns
    /// its displays, so an unresponsive daemon yields none: calling them orphaned invited a
    /// sleep/wake that blanks the user's screens for nothing.
    public static func orphanedDisplays(attached: [UInt32], daemon: DaemonState,
                                        daemonDisplayIDs: Set<UInt32>) -> [UInt32] {
        switch daemon {
        case .unresponsive: return []
        case .notRunning: return attached
        case .running(let runtime):
            // Fallback and failed-publication owners live outside the display pool. They
            // remain daemon-owned even when the pool's inventory is empty.
            let owned = daemonDisplayIDs.union(runtime?.displaySafety?.deferredRetirementDisplayIDs ?? [])
            return attached.filter { !owned.contains($0) }
        }
    }

    public var deferredRetirementDisplayIDs: [UInt32] {
        Array(Set(runtime?.displaySafety?.deferredRetirementDisplayIDs ?? [])).sorted()
    }

    public var runtime: DaemonRuntimeInfo? {
        if case .running(let runtime) = daemon { return runtime }
        return nil
    }

    /// Permission remedies must name the process doing the work. An old or silent daemon
    /// cannot inherit this terminal's attribution merely because its own is unavailable.
    public var permissionGrantTarget: String {
        switch daemon {
        case .notRunning: return callerAttribution ?? "the terminal or app running spaceo"
        case .running, .unresponsive:
            return runtime?.responsibleProcess ?? "the app or executable hosting the daemon"
        }
    }

    // MARK: - Rendering

    static func ids(_ values: [UInt32]) -> String {
        values.isEmpty ? "none" : values.map(String.init).joined(separator: ", ")
    }

    static func capabilityLine(_ item: Capabilities.Item) -> [String] {
        let name = item.name.padding(toLength: 22, withPad: " ", startingAt: 0)
        if intentionallyDisabledCapabilities.contains(item.name), !item.available {
            return ["    n/a  \(name) intentionally disabled; \(item.detail)"]
        }
        var lines = ["    \(item.available ? "ok  " : "MISS") \(name) \(item.detail)"]
        if let reason = item.unavailableReason { lines.append("         \(reason)") }
        return lines
    }

    /// `label : value`, aligned for scanning.
    static func row(_ label: String, _ value: String) -> String {
        "  " + label.padding(toLength: max(label.count, 20), withPad: " ", startingAt: 0) + ": " + value
    }

    public func render() -> String {
        var lines = ["SpaceO doctor", ""]

        lines.append("Host")
        lines.append(Self.row("macOS", macOS))
        lines.append(Self.row("cli version", "\(cliVersion) (\(cliPath))"))
        lines.append("  runtime APIs:")
        for item in capabilities where !Self.permissionCapabilities.contains(item.name) {
            lines += Self.capabilityLine(item)
        }
        if !missingSymbols.isEmpty {
            lines.append(Self.row("unresolved symbols", missingSymbols.joined(separator: ", ")))
        }
        lines.append(Self.row("can drive sessions", clientCanDrive ? "yes" : "no"))
        lines.append(Self.row("can capture", clientCanCapture ? "yes" : "no"))
        if let safety = effectiveDisplaySafety {
            lines.append(Self.row("display lifecycle", safety.state.rawValue
                + (safety.reason.map { " — " + $0 } ?? "")))
        }
        lines.append(Self.row("shim built with ARC", builtWithARC ? "yes" : "NO — display teardown would leak"))
        lines.append(Self.row("user displays", "online \(Self.ids(userOnlineDisplayIDs)); active \(Self.ids(userActiveDisplayIDs))"))
        lines.append(Self.row("display mirroring", mirroredDisplayIDs.isEmpty ? "off"
            : "on (display ids \(Self.ids(mirroredDisplayIDs)))"))
        lines.append(Self.row("SpaceO display ids", Self.ids(spaceODisplayIDs)))
        if let residue = displayIdentityResidue {
            lines.append(Self.row("display identities", residue.summary))
        }
        if !deferredRetirementDisplayIDs.isEmpty {
            lines.append(Self.row("deferred retirement", Self.ids(deferredRetirementDisplayIDs)
                + " — retained by the daemon; cleanup is incomplete"))
        }
        if !orphanedDisplayIDs.isEmpty {
            lines.append(Self.row("orphaned displays", Self.ids(orphanedDisplayIDs)
                + " — no running daemon owns them; see `spaceo doctor --fix`"))
        } else if daemon.isUnresponsive, !spaceODisplayIDs.isEmpty {
            lines.append(Self.row("orphaned displays", "unknown while the daemon is not answering"))
        }
        lines.append("")

        lines.append("Permissions")
        for item in capabilities where Self.permissionCapabilities.contains(item.name) {
            lines += Self.capabilityLine(item)
        }
        lines.append(Self.row("caller attributed to", callerAttribution ?? "unknown"))
        if let runtime {
            if let attributed = runtime.responsibleProcess {
                lines.append(Self.row("daemon attributed to", attributed))
            }
            if let canDrive = runtime.canDrive, let canCapture = runtime.canCapture {
                lines.append(Self.row("daemon can drive", canDrive ? "yes" : "NO"))
                lines.append(Self.row("daemon can capture", canCapture ? "yes" : "NO"))
            }
        }
        lines.append("  " + focusLine)
        lines.append("")

        lines.append("Daemon")
        lines.append(Self.row("daemon socket", socketPath))
        switch daemon {
        case .notRunning:
            lines.append(Self.row("daemon running", "no"))
        case .unresponsive(let seconds):
            lines.append(Self.row("daemon running", "yes (did not answer within \(Self.seconds(seconds)) — busy?)"))
        case .running(let runtime):
            lines.append(Self.row("daemon running", "yes" + (runtime?.draining == true ? " (draining for restart)" : "")))
            if let runtime {
                lines.append(Self.row("daemon version", "\(runtime.version) (pid \(runtime.pid))"))
            } else {
                lines.append(Self.row("daemon version", "unknown (restart required for provenance reporting)"))
            }
        }
        lines.append(Self.row("daemon matches CLI", matchDescription))
        lines.append(Self.row("supervised by launchd", launchAgentInstalled
            ? (launchAgentRunning ? "yes (running)" : "installed, not running") : "no"))
        lines.append(Self.row("daemon log", logPath + (logBytes.map { " (\($0) bytes)" } ?? " (not created yet)")))
        lines.append("")

        lines.append("MCP clients")
        lines += mcpClientLines
        lines.append("")

        lines.append("Viewer")
        if let viewer {
            lines.append(Self.row("installed", "\(viewer.path) (\(viewer.version ?? "unknown version"))"
                + (viewer.version.map { $0 == cliVersion ? "" : " — differs from this CLI" } ?? "")))
        } else {
            lines.append(Self.row("installed", "no (searched \(viewerSearchPaths.joined(separator: ", ")))"))
        }
        lines.append("")

        lines.append("Disk")
        lines.append(Self.row("SpaceO disk use", "\(diskBytes / 1_048_576) MB at \(diskRoot ?? "?")"))
        if !orphanProfileDirectories.isEmpty {
            lines.append(Self.row("orphaned profiles", "\(orphanProfileDirectories.count) director"
                + (orphanProfileDirectories.count == 1 ? "y" : "ies") + "; run `spaceo clean --operator`"))
        }
        lines.append(Self.row("resource policy", "no product limits; runtime geometry checks only"))
        lines.append("")

        if let logging {
            lines.append("Logging")
            lines.append(Self.row("agent journal", logging.journal.rawValue
                + (logging.journal == .off ? " — `spaceo logging enable` to journal every MCP call" : "")))
            lines.append(Self.row("daemon requests", logging.requestMetrics ? "every request" : "failures only"))
            lines.append("")
        }

        lines += readinessLines
        return lines.joined(separator: "\n")
    }

    static func seconds(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))s" : String(format: "%.1fs", value)
    }

    var matchDescription: String {
        switch daemon {
        case .notRunning: return "not running"
        case .unresponsive: return "unknown (the daemon did not answer)"
        case .running:
            return daemonMatchesCLI.map { $0 ? "yes" : "NO — run `spaceo daemon restart --operator`" }
                ?? "unknown — run `spaceo daemon restart --operator`"
        }
    }

    var mcpClientLines: [String] {
        guard !mcpClients.isEmpty else { return ["  none checked"] }
        var lines: [String] = []
        for status in mcpClients {
            let name = status.client.rawValue
            guard let registration = status.registration else {
                lines.append(Self.row(name, "not configured"))
                continue
            }
            let label = registration.scope == "config" ? name : "\(name) (\(registration.scope))"
            let path = status.resolvedPath ?? registration.command
            let verdict: String
            if let version = status.version {
                verdict = "\(version) — " + (status.matchesCLI == true ? "matches this CLI" : "STALE (this CLI is \(cliVersion))")
            } else {
                verdict = "version unknown" + (status.problem.map { " — \($0)" } ?? "")
            }
            lines.append(Self.row(label, "\(path) \(verdict)"))
            if let remedy = status.remedy { lines.append("      next: \(remedy)") }
        }
        return lines
    }

    // MARK: Readiness

    /// One blocker in sentences: what is wrong, and the command that fixes it.
    public struct Blocker: Sendable, Equatable {
        public var code: String
        public var sentence: String
        public var next: String
    }

    /// Readiness blockers as sentences. The codes stay in the JSON; people read these.
    public var blockers: [Blocker] {
        let safetyBlockers: [Blocker]
        if let safety = effectiveDisplaySafety, !safety.allowsCreation {
            safetyBlockers = [Blocker(
                code: "display_safety_" + safety.state.rawValue,
                sentence: "Display creation is blocked: " + (safety.reason ?? "lifecycle state is unknown") + ".",
                next: (safety.reason.map { DisplayLifecycleLease.isRecoverableHostHealthFailure($0) } == true
                    ? "Stop all SpaceO owners (including Viewer and launchd) and inspect docs/DISPLAY_SAFETY.md, then run `spaceo safety clear-host-health --operator`. Recovery refuses unless no owner or SpaceO display remains and host observations pass."
                    : "Stop display work and inspect docs/DISPLAY_SAFETY.md; restarting does not reset the safety latch."))]
        } else { safetyBlockers = [] }
        if case .unresponsive(let seconds) = daemon {
            return safetyBlockers + [Blocker(
                code: "daemon_unresponsive",
                sentence: "A daemon is listening at \(socketPath) but did not answer within "
                    + "\(Self.seconds(seconds)); it may be busy with a long request.",
                next: "Retry `spaceo doctor` in a few seconds; if it stays silent, read the daemon "
                    + "log at \(logPath).")]
        }
        let grantee = permissionGrantTarget
        return safetyBlockers + readiness.blockers.map { code in
            switch code {
            case "daemon_not_running":
                return Blocker(code: code,
                    sentence: "No daemon is running at \(socketPath). MCP clients start one on demand; "
                        + "CLI commands need one already running.",
                    next: launchAgentInstalled
                        ? "`launchctl kickstart -k gui/\(getuid())/\(LaunchAgentInstaller.label)`, then `spaceo daemon status`"
                        : "`spaceo daemon` in a terminal you keep open, or let your MCP client start it")
            case "permission_state_mismatch":
                return Blocker(code: code,
                    sentence: "The daemon's permissions differ from this terminal's: it was started "
                        + "by \(grantee), and macOS grants follow the app that starts it.",
                    next: "Restart it from this app once sessions are idle: `spaceo daemon restart --operator`")
            case "permission_state_unknown":
                return Blocker(code: code,
                    sentence: "The running daemon does not report its permissions; it predates "
                        + "permission reporting.",
                    next: "`spaceo daemon restart --operator` to run this build")
            case "daemon_driving_unavailable":
                return Blocker(code: code,
                    sentence: "The daemon cannot drive apps: \(grantee) lacks Accessibility, or a "
                        + "required runtime API is missing.",
                    next: "Grant Accessibility to \(grantee) (`spaceo doctor --fix` opens the pane), "
                        + "then `spaceo daemon restart --operator`")
            case "daemon_capture_unavailable":
                return Blocker(code: code,
                    sentence: "The daemon cannot take screenshots: \(grantee) lacks Screen Recording.",
                    next: "Grant Screen Recording to \(grantee) (`spaceo doctor --fix` opens the pane), "
                        + "then `spaceo daemon restart --operator`")
            default:
                return Blocker(code: code, sentence: "Readiness blocker: \(code).",
                               next: readiness.nextAction ?? "`spaceo doctor --json` for detail")
            }
        }
    }

    var readinessLines: [String] {
        let blockers = self.blockers
        guard !blockers.isEmpty else { return ["Readiness: ready"] }
        var lines = ["Readiness: blocked"]
        for blocker in blockers {
            lines.append("  - \(blocker.sentence)")
            lines.append("    Next: \(blocker.next)")
        }
        return lines
    }
}
