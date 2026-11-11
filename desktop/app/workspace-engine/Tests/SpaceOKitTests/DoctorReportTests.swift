import XCTest
@testable import SpaceOKit

/// `spaceo doctor`'s text is rendered from values, so it is golden-tested here without a daemon,
/// a display, or a TCC grant.
final class DoctorReportTests: XCTestCase {

    static func item(_ name: String, _ available: Bool, _ detail: String, reason: String? = nil) -> Capabilities.Item {
        Capabilities.Item(name: name, available: available, detail: detail, unavailableReason: reason)
    }

    static let capabilities = [
        item("virtual-display", true, "CGVirtualDisplay classes"),
        item("focus-without-raise", false, "removed incompatible private focus-record path",
             reason: "the incompatible private focus-record path is not used"),
        item("space-query", true, "SkyLight space graph and window geometry calls"),
        item("accessibility", true, "required for window placement and AX-driven input"),
        item("screen-recording", false, "required for capture only"),
    ]

    static func runtime(version: String = "1.1.1") -> DaemonRuntimeInfo {
        DaemonRuntimeInfo(version: version, executableSHA256: nil, pid: 4242,
                          instanceID: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
                          startedAt: Date(timeIntervalSince1970: 0),
                          accessibilityGranted: true, screenRecordingGranted: true,
                          canDrive: true, canCapture: true,
                          responsibleProcess: "Terminal (/System/Applications/Utilities/Terminal.app)")
    }

    static func report(daemon: DoctorReport.DaemonState,
                       matches: Bool? = nil,
                       clients: [MCPClientStatus] = [],
                       viewer: DoctorReport.ViewerInstallation? = nil,
                       spaceO: [UInt32] = [],
                       orphaned: [UInt32] = []) -> DoctorReport {
        let runtime: DaemonRuntimeInfo? = { if case .running(let r) = daemon { return r } else { return nil } }()
        return DoctorReport(
            macOS: "Version 27.2", cliVersion: "1.1.1", cliPath: "/Users/me/.local/bin/spaceo",
            capabilities: capabilities, missingSymbols: [],
            clientCanDrive: true, clientCanCapture: false, builtWithARC: true,
            callerAttribution: "Terminal (/System/Applications/Utilities/Terminal.app)",
            socketPath: "/tmp/spaceo-501.sock", daemon: daemon, daemonMatchesCLI: matches,
            launchAgentInstalled: false, launchAgentRunning: false,
            logPath: "/Users/me/Library/Logs/SpaceO/daemon.log", logBytes: 1_024,
            spaceODisplayIDs: spaceO, orphanedDisplayIDs: orphaned,
            userOnlineDisplayIDs: [1], userActiveDisplayIDs: [1], mirroredDisplayIDs: [],
            mcpClients: clients, viewer: viewer,
            viewerSearchPaths: ["/Applications/SpaceO Viewer.app", "/Users/me/Applications/SpaceO Viewer.app"],
            diskBytes: 3 * 1_048_576, diskRoot: "/Users/me/Library/Application Support/SpaceO",
            orphanProfileDirectories: [],
            readiness: PermissionReadinessReport(clientAX: true, clientCapture: false, daemon: runtime),
            focusLine: AttentionMitigation.focusStatusLine(focusActive: nil))
    }

    func testOnlyEligibleHealthLatchesOfferOperatorRecovery() {
        for reason in ["host health: host_health_unknown", "host health: swap_activity",
                       "host health: memory_pressure,swap_activity", "host health: recent_windowserver_diagnostic",
                       "host health: swap_activity,recent_windowserver_diagnostic"] {
            var report = Self.report(daemon: .notRunning)
            report.displaySafety = .init(state: .blocked, reason: reason)
            XCTAssertTrue(report.blockers.contains { $0.next.contains("safety clear-host-health") }, reason)
        }
        for reason in ["host health: recent_windowserver_diagnostic,colorsync_busy", "host health: colorsync_busy",
                       "a display operation exceeded its deadline"] {
            var report = Self.report(daemon: .notRunning)
            report.displaySafety = .init(state: .blocked, reason: reason)
            XCTAssertFalse(report.blockers.contains { $0.next.contains("safety clear-host-health") }, reason)
        }
    }

    func testGoldenRenderForAHealthyHostWithAStaleClient() {
        let stale = MCPClientStatus(
            client: .claudeCode,
            registration: MCPClientRegistration(client: .claudeCode, scope: "user", source: "/Users/me/.claude.json",
                                                command: "/Users/me/.local/bin/spaceo", arguments: ["mcp"]),
            resolvedPath: "/Users/me/.local/bin/spaceo", version: "1.0.0", matchesCLI: false,
            remedy: "update it")
        let report = Self.report(
            daemon: .running(Self.runtime()), matches: true,
            clients: [stale, MCPClientStatus(client: .codex)],
            viewer: .init(path: "/Applications/SpaceO Viewer.app", version: "1.1.1"))
        XCTAssertEqual(report.render(), """
            SpaceO doctor

            Host
              macOS               : Version 27.2
              cli version         : 1.1.1 (/Users/me/.local/bin/spaceo)
              runtime APIs:
                ok   virtual-display        CGVirtualDisplay classes
                n/a  focus-without-raise    intentionally disabled; removed incompatible private focus-record path
                ok   space-query            SkyLight space graph and window geometry calls
              can drive sessions  : yes
              can capture         : no
              shim built with ARC : yes
              user displays       : online 1; active 1
              display mirroring   : off
              SpaceO display ids  : none

            Permissions
                ok   accessibility          required for window placement and AX-driven input
                MISS screen-recording       required for capture only
              caller attributed to: Terminal (/System/Applications/Utilities/Terminal.app)
              daemon attributed to: Terminal (/System/Applications/Utilities/Terminal.app)
              daemon can drive    : yes
              daemon can capture  : yes
              Focus state unknown (SpaceO cannot read it without Focus access)

            Daemon
              daemon socket       : /tmp/spaceo-501.sock
              daemon running      : yes
              daemon version      : 1.1.1 (pid 4242)
              daemon matches CLI  : yes
              supervised by launchd: no
              daemon log          : /Users/me/Library/Logs/SpaceO/daemon.log (1024 bytes)

            MCP clients
              claude-code (user)  : /Users/me/.local/bin/spaceo 1.0.0 — STALE (this CLI is 1.1.1)
                  next: update it
              codex               : not configured

            Viewer
              installed           : /Applications/SpaceO Viewer.app (1.1.1)

            Disk
              SpaceO disk use     : 3 MB at /Users/me/Library/Application Support/SpaceO
              resource policy     : no product limits; runtime geometry checks only

            Readiness: blocked
              - The daemon's permissions differ from this terminal's: it was started by Terminal (/System/Applications/Utilities/Terminal.app), and macOS grants follow the app that starts it.
                Next: Restart it from this app once sessions are idle: `spaceo daemon restart --operator`
            """)
    }

    func testFocusWithoutRaiseIsNeverReportedAsMissing() {
        let text = Self.report(daemon: .notRunning).render()
        XCTAssertFalse(text.contains("MISS focus-without-raise"))
        XCTAssertTrue(text.contains("n/a  focus-without-raise"))
        XCTAssertTrue(text.contains("SpaceO display ids"), "the line lists ids, not a count")
    }

    func testSectionsAppearInOrder() {
        let text = Self.report(daemon: .notRunning).render()
        let headers = ["\nHost\n", "\nPermissions\n", "\nDaemon\n", "\nMCP clients\n", "\nViewer\n", "\nDisk\n", "\nReadiness: "]
        let positions = headers.compactMap { text.range(of: $0)?.lowerBound }
        XCTAssertEqual(positions.count, headers.count)
        XCTAssertEqual(positions, positions.sorted())
    }

    /// A daemon that accepted the connection but did not answer used to read as "not running",
    /// and its displays as orphaned — an invitation to a sleep/wake on a working session.
    func testUnresponsiveDaemonIsRunningAndOwnsItsDisplays() {
        let state = DoctorReport.DaemonState.unresponsive(timeoutSeconds: 2)
        XCTAssertEqual(DoctorReport.orphanedDisplays(attached: [7, 9], daemon: state, daemonDisplayIDs: []), [])
        XCTAssertEqual(DoctorReport.orphanedDisplays(attached: [7, 9], daemon: .notRunning, daemonDisplayIDs: []), [7, 9])
        XCTAssertEqual(DoctorReport.orphanedDisplays(attached: [7, 9], daemon: .running(nil), daemonDisplayIDs: [7]), [9])

        let text = Self.report(daemon: state, spaceO: [7, 9]).render()
        XCTAssertTrue(text.contains("daemon running      : yes (did not answer within 2s — busy?)"))
        XCTAssertTrue(text.contains("daemon matches CLI  : unknown (the daemon did not answer)"))
        XCTAssertTrue(text.contains("orphaned displays   : unknown while the daemon is not answering"))
        XCTAssertFalse(text.contains("daemon_not_running"))
        let blockers = Self.report(daemon: state).blockers
        XCTAssertEqual(blockers.map(\.code), ["daemon_unresponsive"])
        XCTAssertTrue(blockers[0].next.contains("Retry `spaceo doctor`"))
    }

    func testDeferredDaemonOwnersAreNotOrphansAndRemainExplicit() {
        var runtime = Self.runtime()
        var safety = DisplaySafetyStatus(state: .blocked, reason: "retirement deferred")
        safety.deferredRetirementDisplayIDs = [9, 7, 9]
        runtime.displaySafety = safety
        let state = DoctorReport.DaemonState.running(runtime)
        let orphans = DoctorReport.orphanedDisplays(
            attached: [7, 9, 11, 13], daemon: state, daemonDisplayIDs: [11])
        XCTAssertEqual(orphans, [13], "both retained fallback owners and pooled owners belong to the daemon")
        let report = Self.report(daemon: state, spaceO: [7, 9], orphaned: [])
        XCTAssertEqual(report.deferredRetirementDisplayIDs, [7, 9])
        XCTAssertTrue(report.render().contains("deferred retirement : 7, 9 — retained by the daemon; cleanup is incomplete"))
        XCTAssertFalse(report.render().contains("no running daemon owns them"))
        XCTAssertTrue(DoctorRemedy.remedies(for: DoctorFindings(orphanedDisplayIDs:
            DoctorReport.orphanedDisplays(attached: [7, 9], daemon: state, daemonDisplayIDs: []))).isEmpty)

        XCTAssertEqual(DoctorReport.orphanedDisplays(attached: [7, 9], daemon: .notRunning,
                                                   daemonDisplayIDs: []), [7, 9])
        XCTAssertEqual(DoctorReport.orphanedDisplays(attached: [7, 9], daemon: .running(Self.runtime()),
                                                   daemonDisplayIDs: [7]), [9], "older runtime metadata remains compatible")
    }

    func testBlockersAreSentencesWithANextLine() {
        let text = Self.report(daemon: .notRunning).render()
        XCTAssertTrue(text.contains("Readiness: blocked\n  - No daemon is running at /tmp/spaceo-501.sock."))
        XCTAssertTrue(text.contains("\n    Next: `spaceo daemon` in a terminal you keep open"))
        XCTAssertFalse(text.contains("daemon_not_running"), "codes stay in JSON; people read sentences")

        var legacy = Self.report(daemon: .running(Self.runtime(version: "1.0.0")))
        legacy.readiness = PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: DaemonRuntimeInfo(
            version: "1.0.0", executableSHA256: nil, pid: 1, instanceID: UUID(), startedAt: Date()))
        let codes = legacy.blockers.map(\.code)
        XCTAssertEqual(codes, ["permission_state_unknown", "daemon_driving_unavailable", "daemon_capture_unavailable"])
        for blocker in legacy.blockers {
            XCTAssertTrue(blocker.sentence.hasSuffix("."), blocker.sentence)
            XCTAssertFalse(blocker.next.isEmpty)
        }
    }

    func testReadyHostSaysReady() {
        var report = Self.report(daemon: .running(Self.runtime()), matches: true)
        report.readiness = PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: Self.runtime())
        XCTAssertTrue(report.render().hasSuffix("Readiness: ready"))
    }

    func testMismatchedDaemonNamesTheRestart() {
        let text = Self.report(daemon: .running(Self.runtime(version: "1.0.0")), matches: false).render()
        XCTAssertTrue(text.contains("daemon matches CLI  : NO — run `spaceo daemon restart --operator`"))
        XCTAssertTrue(text.contains("daemon version      : 1.0.0 (pid 4242)"))
    }

    func testViewerLineCoversMissingAndMismatched() {
        XCTAssertTrue(Self.report(daemon: .notRunning).render().contains(
            "installed           : no (searched /Applications/SpaceO Viewer.app, /Users/me/Applications/SpaceO Viewer.app)"))
        XCTAssertTrue(Self.report(daemon: .notRunning, viewer: .init(path: "/Applications/SpaceO Viewer.app", version: "1.0.0"))
            .render().contains("(1.0.0) — differs from this CLI"))
    }

    func testOrphanedDisplaysPointAtTheFix() {
        let text = Self.report(daemon: .notRunning, spaceO: [5], orphaned: [5]).render()
        XCTAssertTrue(text.contains("orphaned displays   : 5 — no running daemon owns them; see `spaceo doctor --fix`"))
    }

    func testLaunchAgentHostsAreToldToKickstartLaunchd() {
        var report = Self.report(daemon: .notRunning)
        report.launchAgentInstalled = true
        XCTAssertTrue(report.blockers[0].next.contains("launchctl kickstart -k gui/"))
        XCTAssertTrue(report.blockers[0].next.contains("`spaceo daemon status`"))
    }

    func testPermissionRemediesUseDaemonAttributionAndNeverGuessTheCallerForAnUnknownDaemon() {
        var runtime = Self.runtime()
        runtime.responsibleProcess = "spaceo (/Users/me/.local/bin/spaceo)"
        runtime.screenRecordingGranted = false
        runtime.canCapture = false
        var report = Self.report(daemon: .running(runtime), matches: true)
        XCTAssertEqual(report.permissionGrantTarget, runtime.responsibleProcess)
        let capture = report.blockers.first { $0.code == "daemon_capture_unavailable" }
        XCTAssertTrue(capture?.next.contains("spaceo (/Users/me/.local/bin/spaceo)") == true)
        XCTAssertFalse(capture?.next.contains("Terminal") == true)

        runtime.responsibleProcess = nil
        for state in [DoctorReport.DaemonState.running(runtime), .running(nil), .unresponsive(timeoutSeconds: 1)] {
            report.daemon = state
            XCTAssertEqual(report.permissionGrantTarget, "the app or executable hosting the daemon")
        }
        report.daemon = .notRunning
        XCTAssertEqual(report.permissionGrantTarget, report.callerAttribution)
        report.callerAttribution = nil
        XCTAssertEqual(report.permissionGrantTarget, "the terminal or app running spaceo")
    }
    func testLifecycleLatchBlocksReadinessEvenWhenDaemonPermissionsAreHealthy() throws {
        var runtime = Self.runtime()
        runtime.displaySafety = DisplaySafetyStatus(state: .blocked, reason: "injected timeout")
        var report = Self.report(daemon: .running(runtime), matches: true)
        report.readiness = PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: runtime)
        report.displaySafety = DisplaySafetyStatus(state: .ready)
        XCTAssertFalse(try XCTUnwrap(report.effectiveDisplaySafety).allowsCreation)
        XCTAssertEqual(report.blockers.map(\.code), ["display_safety_blocked"])
        XCTAssertTrue(report.render().contains("Readiness: blocked"))
        XCTAssertTrue(report.render().contains("injected timeout"))

        runtime.displaySafety = nil // Older daemon: still use the local persistent journal.
        report.daemon = .running(runtime)
        report.displaySafety = DisplaySafetyStatus(state: .unknown, reason: "unreadable journal")
        XCTAssertEqual(report.blockers.map(\.code), ["display_safety_unknown"])
        report.daemon = .notRunning
        XCTAssertTrue(report.blockers.contains { $0.code == "display_safety_unknown" })
    }

}
