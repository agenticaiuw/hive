import CoreMedia
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

final class ViewerSessionStatusTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func session(_ fields: String = "", id: String = "s1", apps: String = "[]") throws -> SessionInfo {
        let json = """
        {"id":"\(id)","displayID":7,"x":0,"y":0,"width":800,"height":600,
         "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,"spaces":[],"hasOwnSpace":true,
         "apps":\(apps),"windows":[],"createdAt":"2026-09-24T10:00:00Z",
         "teardownPending":false,"runtimeAttached":true\(fields)}
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    // MARK: - Precedence

    func testIdleSessionWithIncompleteDiscoverySaysItsWindowsMayBeStale() throws {
        let apps = #"[{"pid":42,"name":"Safari","bundleID":"com.apple.Safari","startedByUs":true}]"#
        let fresh = try session(apps: apps)
        XCTAssertEqual(ViewerSessionStatus.of(fresh, now: now).detail, "Safari")
        let stale = try session(#","windowDiscoveryFailure":"known window owner is unavailable""#, apps: apps)
        let status = ViewerSessionStatus.of(stale, now: now)
        XCTAssertEqual(status.kind, .idle)
        XCTAssertEqual(status.detail, ViewerSessionStatus.staleWindowsDetail)
    }

    func testBreachOutranksAHelpRequest() throws {
        let waiting = try session(#","inputPaused":true,"agentPauseReason":"needs 2FA""#)
        XCTAssertEqual(ViewerSessionStatus.of(waiting, now: now).kind, .needsYou)
        XCTAssertEqual(ViewerSessionStatus.of(waiting, breached: true, now: now).kind, .breach)
    }

    func testHelpRequestCarriesTheAgentsReason() throws {
        let waiting = try session(#","inputPaused":true,"agentPauseReason":"Enter the code\nfrom SMS""#)
        let status = ViewerSessionStatus.of(waiting, now: now)
        XCTAssertEqual(status.title, "Needs you")
        XCTAssertEqual(status.detail, "Enter the code from SMS", "one line, as rows and banners need")
    }

    func testHelpRequestOutranksThePersonsOwnControl() throws {
        // Taking Control of a waiting agent keeps it waiting until the hand-back.
        let waiting = try session(#","inputPaused":true,"agentPauseReason":"CAPTCHA""#)
        XCTAssertEqual(ViewerSessionStatus.of(waiting, controlled: true, now: now).kind, .needsYou)
    }

    func testControlOutranksAnOperatorPause() throws {
        let paused = try session(#","inputPaused":true"#)
        XCTAssertEqual(ViewerSessionStatus.of(paused, now: now).kind, .paused)
        XCTAssertEqual(ViewerSessionStatus.of(paused, controlled: true, now: now).kind, .youHaveControl)
    }

    func testLifecycleStatesOutrankAPause() throws {
        XCTAssertEqual(ViewerSessionStatus.of(
            try session(#","inputPaused":true,"abandoned":true"#), now: now).kind, .abandoned)
        XCTAssertEqual(ViewerSessionStatus.of(
            try session(#","reclaimable":true"#), now: now).kind, .abandoned)
        var cleaning = try session(#","inputPaused":true"#)
        cleaning.teardownPending = true
        XCTAssertEqual(ViewerSessionStatus.of(cleaning, now: now).kind, .cleaningUp)
    }

    func testRecentAgentActionReadsAsWorkingThenGoesIdle() throws {
        let fresh = try session(
            ",\"lastAgentAction\":\"left_click\",\"lastAgentActionAt\":\"\(iso(now.addingTimeInterval(-2)))\","
                + "\"lastAgentActionTarget\":\"Button — Save\"",
            apps: #"[{"pid":1,"name":"TextEdit","startedByUs":true}]"#)
        let working = ViewerSessionStatus.of(fresh, now: now)
        XCTAssertEqual(working.kind, .working)
        XCTAssertEqual(working.detail, "Left click · Button — Save")

        let later = ViewerSessionStatus.of(
            fresh, now: now.addingTimeInterval(ViewerSessionStatus.workingWindow + 5))
        XCTAssertEqual(later.kind, .idle)
        XCTAssertEqual(later.detail, "TextEdit", "an idle session is described by its apps")
    }

    func testAPausedAgentsLastActionDoesNotReadAsWorking() throws {
        let paused = try session(
            ",\"inputPaused\":true,\"lastAgentAction\":\"type\",\"lastAgentActionAt\":\"\(iso(now))\"")
        XCTAssertEqual(ViewerSessionStatus.of(paused, now: now).kind, .paused)
    }

    func testAppsSummary() throws {
        XCTAssertEqual(ViewerSessionStatus.appsSummary(try session()), "No apps yet")
        let many = try session(apps: """
            [{"pid":1,"name":"Safari","startedByUs":true},{"pid":2,"name":"Notes","startedByUs":true},
             {"pid":3,"name":"Mail","startedByUs":true},{"pid":4,"name":"Maps","startedByUs":true}]
            """)
        XCTAssertEqual(ViewerSessionStatus.appsSummary(many), "Safari, Notes +2")
    }

    // MARK: - Inspector tabs

    func testEveryInspectorSectionLandsOnATabThatShowsIt() {
        XCTAssertEqual(ViewerInspectorTab(.overview), .session)
        XCTAssertEqual(ViewerInspectorTab(.apps), .session)
        XCTAssertEqual(ViewerInspectorTab(.windows), .session)
        XCTAssertEqual(ViewerInspectorTab(.events), .activity)
        XCTAssertEqual(ViewerInspectorTab(.health), .session,
                       "a session's health is shown with the session; SpaceO's is in Settings")
        XCTAssertEqual(ViewerInspectorTab(.infrastructure), .session)
        for tab in ViewerInspectorTab.allCases {
            XCTAssertEqual(ViewerInspectorTab(tab.section), tab, "selecting \(tab) must stay on it")
        }
    }

    // MARK: - Model presentation

    private final class NoStreamSession: ViewerDisplayStreamSession, @unchecked Sendable {
        func stop() async {}
        func updateCrop(_ sourceRect: CGRect?) async throws {}
    }

    private final class NoStreamEngine: ViewerDisplayStreaming, @unchecked Sendable {
        func start(
            displayID: CGDirectDisplayID, pointSize: CGSize, sourceRect: CGRect?,
            onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
            onStopped: @escaping @Sendable (Error?) -> Void
        ) async throws -> any ViewerDisplayStreamSession {
            NoStreamSession()
        }
    }

    @MainActor
    private func makeModel(sessions: [SessionInfo], screenRecording: Bool = true) -> ViewerModel {
        let display = DisplayEntry(id: 7, bounds: CGRect(x: 0, y: 0, width: 800, height: 600),
                                   isSpaceO: true, isActive: true, name: "Stage")
        return ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display], initialSelectedID: 7,
            initialPermissions: PermissionState(screenRecording: screenRecording, accessibility: true),
            initialSessions: sessions,
            streamEngine: NoStreamEngine(),
            daemonTransport: { _ in Response(ok: true) },
            accessibilityAnnouncement: { _ in })
    }

    @MainActor
    func testALingeringDisplayWithoutSessionsIsNotShownAsTheCanvas() {
        let model = makeModel(sessions: [])
        XCTAssertNotNil(model.selected, "the display is still selected")
        XCTAssertNil(model.canvasTitle,
                     "session scope with no session shows the welcome, not an empty display")
        model.selectDisplay(7)
        XCTAssertEqual(model.canvasTitle, "Virtual Display 1")
    }

    @MainActor
    func testCanvasTitleFollowsTheSessionsOwnTitle() throws {
        let model = makeModel(sessions: [try session(#","title":"Checkout flow""#)])
        model.selectSession("s1")
        XCTAssertEqual(model.canvasTitle, "Checkout flow")
    }

    @MainActor
    func testAStreamFailedForLackOfScreenRecordingIsOneIssueNotTwo() throws {
        let model = makeModel(sessions: [try session()], screenRecording: false)
        model.addFrameSink("fixture") { _ in }
        model.selectSession("s1")
        XCTAssertTrue(model.healthAlerts.contains { $0.id == "stream" })
        XCTAssertTrue(model.issues.contains { $0.id == "screen-recording" })
        XCTAssertFalse(model.issues.contains { $0.id == "stream" })
    }

    // MARK: - Agent connections

    func testAgentConnectionStateFromRegistrations() {
        let mine = "/Applications/SpaceO Viewer.app/Contents/Helpers/spaceo"
        func entry(_ client: MCPClient, _ command: String, scope: String = "user") -> MCPClientRegistration {
            MCPClientRegistration(client: client, scope: scope, source: "test", command: command,
                                  arguments: ["mcp"])
        }
        func state(_ registrations: [MCPClientRegistration], installed: Bool = true,
                   executable: Set<String> = [mine, "/opt/spaceo"]) -> ViewerAgentConnectionState {
            ViewerAgentConnections.state(for: .claudeCode, registrations: registrations,
                                         installed: installed, spaceoPath: mine,
                                         isExecutable: { executable.contains($0) })
        }
        XCTAssertEqual(state([]), .notConnected)
        XCTAssertEqual(state([], installed: false), .notInstalled)
        XCTAssertEqual(state([entry(.claudeCode, mine)]), .connected(path: mine, current: true))
        XCTAssertEqual(state([entry(.claudeCode, "/opt/spaceo")]),
                       .connected(path: "/opt/spaceo", current: false),
                       "another working install still connects the agent")
        XCTAssertEqual(state([entry(.claudeCode, "/gone/spaceo")]), .broken(path: "/gone/spaceo"))
        XCTAssertEqual(state([entry(.codex, mine)]), .notConnected, "other clients do not count")
        XCTAssertEqual(
            state([entry(.claudeCode, "/gone/spaceo", scope: "project"), entry(.claudeCode, mine)]),
            .connected(path: mine, current: true), "a user-scope entry outranks a project one")
    }

    func testTeardownRequestsOutliveTheTwoSecondPollBudget() {
        XCTAssertEqual(ViewerModel.transportTimeout(for: "session.list"), 2)
        XCTAssertEqual(ViewerModel.transportTimeout(for: "pool"), 2)
        XCTAssertGreaterThanOrEqual(ViewerModel.transportTimeout(for: "session.destroy"), 30)
        XCTAssertGreaterThanOrEqual(ViewerModel.transportTimeout(for: "pool.remove"), 30)
    }

    @MainActor
    func testRemovingADisplayAsksFirstAndNamesIt() throws {
        let model = makeModel(sessions: [try session()])
        model.request(.removeDisplay(7))
        XCTAssertEqual(model.pendingConfirmation, .removeDisplay(7))
        XCTAssertEqual(model.confirmationTitle(for: .removeDisplay(7)), "Remove Virtual Display 1?")
        model.cancelPendingAction()
        XCTAssertNil(model.pendingConfirmation)
    }

    @MainActor
    func testSettingsIsARouteThatSessionNavigationLeaves() throws {
        let model = makeModel(sessions: [try session()])
        model.showSettings(.agents)
        XCTAssertEqual(model.settingsPane, .agents)
        model.selectSession(atShortcut: 1)
        XCTAssertNil(model.settingsPane, "choosing a session returns to the console")
    }
}
