import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-217. The menu bar dot and badge are computed, not observed, so their rules are pinned.
final class ViewerStatusAggregateTests: XCTestCase {

    private func session(
        id: String,
        inputPaused: Bool? = nil,
        abandoned: Bool? = nil,
        teardownPending: Bool = false,
        lifecycleReason: String? = nil,
        attached: Bool = true
    ) throws -> SessionInfo {
        var extras: [String] = []
        if let inputPaused { extras.append("\"inputPaused\":\(inputPaused)") }
        if let abandoned { extras.append("\"abandoned\":\(abandoned)") }
        if let lifecycleReason { extras.append("\"lifecycleReason\":\"\(lifecycleReason)\"") }
        let extraJSON = extras.isEmpty ? "" : extras.joined(separator: ",") + ","
        let json = """
        {
          "id":"\(id)","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          \(extraJSON)
          "createdAt":"2026-07-30T00:00:00Z","teardownPending":\(teardownPending),
          "runtimeAttached":\(attached)
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    func testDotsFollowBreachThenAttentionThenLive() throws {
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try session(id: "a"), breached: false), .green)
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try session(id: "a", inputPaused: true), breached: false), .amber)
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try session(id: "a", abandoned: true), breached: false), .amber)
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try session(id: "a", teardownPending: true), breached: false), .amber)
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try session(id: "a"), breached: true), .red)
        XCTAssertEqual(
            ViewerSessionStatusDot.dot(
                for: try session(id: "a", inputPaused: true, lifecycleReason: "paused after isolation breach"),
                breached: false),
            .red, "a pause the daemon attributes to a breach is a breach")
        XCTAssertEqual(
            ViewerSessionStatusDot.dot(for: try session(id: "a", inputPaused: true, abandoned: true), breached: true),
            .red, "breach outranks everything")
    }

    func testAggregateCountsAttachedSessionsAndReportsTheWorst() throws {
        let aggregate = ViewerStatusAggregate.aggregate(
            sessions: [
                try session(id: "live"),
                try session(id: "paused", inputPaused: true),
                try session(id: "gone", abandoned: true),
                try session(id: "breached"),
                try session(id: "detached", abandoned: true, attached: false),
            ],
            breaches: ["breached", "detached"])
        XCTAssertEqual(aggregate, ViewerStatusAggregate(red: 1, amber: 2, green: 1))
        XCTAssertEqual(aggregate.total, 4, "detached records are not agents at work")
        XCTAssertEqual(aggregate.worst, .red)
        XCTAssertEqual(aggregate.badgeText, "4")
        XCTAssertEqual(aggregate.accessibilityDescription,
                       "SpaceO: 4 sessions, 1 breach, 2 paused or needing attention, 1 live")
    }

    func testEmptyAggregateHasNoWorstDot() {
        let aggregate = ViewerStatusAggregate.aggregate(sessions: [], breaches: ["stale"])
        XCTAssertEqual(aggregate.total, 0)
        XCTAssertNil(aggregate.worst)
        XCTAssertEqual(aggregate.accessibilityDescription, "SpaceO: no sessions")
    }

    func testWorstPrefersAmberOverGreen() throws {
        let aggregate = ViewerStatusAggregate.aggregate(
            sessions: [try session(id: "a"), try session(id: "b", inputPaused: true)], breaches: [])
        XCTAssertEqual(aggregate.worst, .amber)
    }

    // MARK: - Agent needs you

    private func asking(_ id: String, reason: String = "needs 2FA code") throws -> SessionInfo {
        var value = try session(id: id, inputPaused: true)
        value.agentPauseReason = reason
        return value
    }

    func testAHelpRequestRanksAboveAmberAndBelowABreach() throws {
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try asking("a"), breached: false), .needsHuman)
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: try asking("a"), breached: true), .red)
        XCTAssertLessThan(ViewerSessionStatusDot.amber, .needsHuman)
        XCTAssertLessThan(ViewerSessionStatusDot.needsHuman, .red)

        var blank = try asking("b", reason: "   ")
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: blank, breached: false), .amber,
                       "an empty reason is not a request")
        blank.agentPauseReason = "needs approval"
        blank.teardownPending = true
        XCTAssertEqual(ViewerSessionStatusDot.dot(for: blank, breached: false), .amber,
                       "a session being torn down cannot be helped")
    }

    func testAggregateCountsHelpRequestsAndLeadsTheLabelWithThem() throws {
        let aggregate = ViewerStatusAggregate.aggregate(
            sessions: [try session(id: "live"), try session(id: "paused", inputPaused: true),
                       try asking("waiting")],
            breaches: [])
        XCTAssertEqual(aggregate, ViewerStatusAggregate(red: 0, amber: 1, green: 1, needsHuman: 1))
        XCTAssertEqual(aggregate.worst, .needsHuman)
        XCTAssertEqual(aggregate.total, 3)
        XCTAssertEqual(aggregate.labelText, "1/3")
        XCTAssertEqual(aggregate.accessibilityDescription,
                       "SpaceO: 3 sessions, 1 waiting for you, 1 paused or needing attention, 1 live")
        XCTAssertEqual(ViewerStatusAggregate.aggregate(sessions: [try session(id: "a")],
                                                       breaches: []).labelText, "1")
    }

    func testNavigatorSortsWaitingSessionsFirst() throws {
        var older = try session(id: "older")
        older.createdAt = Date(timeIntervalSinceReferenceDate: 0)
        var waiting = try asking("waiting")
        waiting.createdAt = Date(timeIntervalSinceReferenceDate: 100)
        let groups = ViewerSessionGrouping.groups([older, waiting])
        XCTAssertEqual(groups.flatMap { $0.sessions.map(\.id) }, ["waiting", "older"])
    }

    // MARK: - Session navigation

    func testNavigationStepsWrapAndSkipDetachedRecords() throws {
        let order = ViewerSessionNavigation.order([
            try session(id: "a"), try session(id: "b"),
            try session(id: "gone", attached: false),
        ])
        XCTAssertEqual(order, ["a", "b"])
        XCTAssertEqual(ViewerSessionNavigation.step(from: "a", by: 1, in: order), "b")
        XCTAssertEqual(ViewerSessionNavigation.step(from: "b", by: 1, in: order), "a")
        XCTAssertEqual(ViewerSessionNavigation.step(from: "a", by: -1, in: order), "b")
        XCTAssertEqual(ViewerSessionNavigation.step(from: nil, by: 1, in: order), "a")
        XCTAssertEqual(ViewerSessionNavigation.step(from: nil, by: -1, in: order), "b")
        XCTAssertEqual(ViewerSessionNavigation.step(from: "unknown", by: 1, in: order), "a")
        XCTAssertNil(ViewerSessionNavigation.step(from: "a", by: 1, in: []))
        XCTAssertEqual(ViewerSessionNavigation.session(atShortcut: 2, in: order), "b")
        XCTAssertNil(ViewerSessionNavigation.session(atShortcut: 3, in: order))
        XCTAssertNil(ViewerSessionNavigation.session(atShortcut: 0, in: order))
    }

    func testAttentionPickPrefersHelpRequestsAndCyclesWithinThem() throws {
        let sessions = [
            try session(id: "a"),
            try session(id: "b", abandoned: true),
            try asking("c"),
            try asking("d"),
        ]
        // c and d sort first (waiting), so the order is c, d, a, b.
        XCTAssertEqual(ViewerSessionNavigation.attentionTarget(sessions, breaches: ["a"], current: nil), "c")
        XCTAssertEqual(ViewerSessionNavigation.attentionTarget(sessions, breaches: [], current: "c"), "d")
        XCTAssertEqual(ViewerSessionNavigation.attentionTarget(sessions, breaches: [], current: "d"), "c")

        let noHelp = [try session(id: "a"), try session(id: "b", abandoned: true), try session(id: "e")]
        XCTAssertEqual(ViewerSessionNavigation.attentionTarget(noHelp, breaches: ["e"], current: nil), "e",
                       "a breach outranks an abandoned session")
        XCTAssertNil(ViewerSessionNavigation.attentionTarget([try session(id: "a")], breaches: [], current: nil))
    }

    // MARK: - Daemon banner

    private func daemon(version: String = SpaceOVersion.current, draining: Bool? = nil) -> DaemonRuntimeInfo {
        DaemonRuntimeInfo(version: version, executableSHA256: nil, pid: 1, instanceID: UUID(),
                          startedAt: Date(), draining: draining)
    }

    func testWorkspaceBannerFollowsConnectivityDrainingVersionAndRestart() {
        XCTAssertEqual(ViewerWorkspaceBanner.banners(connectivity: .disconnected, daemon: nil,
                                                     daemonRestarted: true).map(\.kind), [.offline])
        XCTAssertEqual(ViewerWorkspaceBanner.banners(connectivity: .degraded, daemon: daemon(),
                                                     daemonRestarted: false).map(\.kind), [.reconnecting])
        XCTAssertTrue(ViewerWorkspaceBanner.banners(connectivity: .connecting, daemon: nil,
                                                    daemonRestarted: false).isEmpty)
        XCTAssertTrue(ViewerWorkspaceBanner.banners(connectivity: .connected, daemon: daemon(),
                                                    daemonRestarted: false).isEmpty)

        let outdated = ViewerWorkspaceBanner.banners(
            connectivity: .connected, daemon: daemon(version: "1.0.0"), daemonRestarted: false,
            viewerVersion: "1.1.1")
        XCTAssertEqual(outdated.map(\.text), [
            "The running SpaceO daemon is 1.0.0; this Viewer is 1.1.1 — restart it with "
                + "`spaceo daemon restart --operator`",
        ])

        let all = ViewerWorkspaceBanner.banners(
            connectivity: .connected, daemon: daemon(version: "1.0.0", draining: true),
            daemonRestarted: true, viewerVersion: "1.1.1")
        XCTAssertEqual(all.map(\.kind), [.restarted, .draining, .outdated])
        XCTAssertEqual(all.first?.text, "The daemon restarted; earlier sessions ended.")
        XCTAssertEqual(all.filter(\.dismissible).map(\.kind), [.restarted])
    }

    @MainActor
    func testModelAggregateUsesRecordedBreachesAndAttachedSessions() throws {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        model.applyControlPlane(
            sessions: [try session(id: "a"), try session(id: "b", inputPaused: true)],
            poolResponse: Response(ok: true))
        XCTAssertEqual(model.statusAggregate, ViewerStatusAggregate(red: 0, amber: 1, green: 1))
        model.recordIsolationVerdict(sessionID: "a", breached: true)
        XCTAssertEqual(model.statusAggregate.worst, .red)
        XCTAssertEqual(model.statusDot(for: try session(id: "a")), .red)
        model.recordIsolationVerdict(sessionID: "a", breached: false)
        XCTAssertEqual(model.statusAggregate.worst, .amber)
    }
}
