import XCTest
@testable import SpaceOKit

/// The activation guard against a scripted workspace: no real application is activated.
final class AgentFocusGuardTests: XCTestCase {
    private typealias App = AgentFocusGuard.Application

    private final class Workspace: @unchecked Sendable {
        private let lock = NSLock()
        private var front: App?
        private var apps: [pid_t: App] = [:]
        /// Exact identities owned by a session; a recycled PID has a different identity.
        private var owned: [ProcessIdentity: String] = [:]
        private var activationTakes = true
        private var isolationLags = 0
        private var frontLag: (reads: Int, stale: App?) = (0, nil)
        private var redirect: pid_t?
        private var frontGate: DispatchSemaphore?
        private var time: TimeInterval = 1_000
        private(set) var activations: [pid_t] = []

        private static func identity(_ pid: pid_t, generation: UInt64) -> ProcessIdentity {
            ProcessIdentity(pid: pid, startedAtMicroseconds: generation)
        }

        func add(_ pid: pid_t, _ name: String, agent: Bool = false, generation: UInt64 = 1) {
            lock.withLock {
                let app = App(pid: pid, name: name, identity: Self.identity(pid, generation: generation))
                apps[pid] = app
                if agent { owned[app.identity!] = "session-\(pid)" }
            }
        }
        func adopt(_ pid: pid_t) {
            lock.withLock { if let identity = apps[pid]?.identity { owned[identity] = "session-\(pid)" } }
        }
        func quit(_ pid: pid_t) { lock.withLock { _ = apps.removeValue(forKey: pid) } }
        func bringToFront(_ pid: pid_t) { lock.withLock { front = apps[pid] } }
        func ignoreActivation() { lock.withLock { activationTakes = false } }
        /// The person picks this application right after SpaceO's activation request.
        func personSwitchesTo(_ pid: pid_t) { lock.withLock { redirect = pid } }
        /// The Space or input route stays with the agent for this many isolation checks.
        func lagIsolation(_ checks: Int) { lock.withLock { isolationLags = checks } }
        /// The next `reads` frontmost queries still report the application that was in front.
        func bringToFrontLagging(_ pid: pid_t, reads: Int) {
            lock.withLock {
                frontLag = (reads, front)
                front = apps[pid]
            }
        }
        func advance(_ seconds: TimeInterval) { lock.withLock { time += seconds } }
        /// Frontmost queries block until `gate` is signalled (one wait per query).
        func gateFrontmost(_ gate: DispatchSemaphore?) { lock.withLock { frontGate = gate } }
        var frontPID: pid_t? { lock.withLock { front?.pid } }
        var activationCount: Int { lock.withLock { activations.count } }

        var environment: AgentFocusGuard.Environment {
            .init(
                frontmost: {
                    if let gate = self.lock.withLock({ self.frontGate }) { gate.wait() }
                    return self.lock.withLock {
                        guard self.frontLag.reads > 0 else { return self.front }
                        self.frontLag.reads -= 1
                        return self.frontLag.stale
                    }
                },
                application: { pid in self.lock.withLock { self.apps[pid] } },
                activate: { pid in
                    self.lock.withLock {
                        self.activations.append(pid)
                        guard let app = self.apps[pid] else { return false }
                        if let redirect = self.redirect { self.front = self.apps[redirect] }
                        else if self.activationTakes { self.front = app }
                        return true
                    }
                },
                owner: { app in self.lock.withLock { app.identity.flatMap { self.owned[$0] } } },
                isolationIntact: {
                    self.lock.withLock {
                        guard self.isolationLags > 0 else { return true }
                        self.isolationLags -= 1
                        return false
                    }
                },
                uptime: { self.lock.withLock { self.time } },
                sleep: { seconds in self.lock.withLock { self.time += seconds } })
        }

        func app(_ pid: pid_t) -> App { lock.withLock { apps[pid]! } }
    }

    private func workspace() -> Workspace {
        let workspace = Workspace()
        workspace.add(10, "Editor")
        workspace.add(11, "Notes")
        workspace.add(20, "Google Chrome", agent: true)
        return workspace
    }

    private let restoredToEditor = AgentFocusGuard.Outcome.restored(
        app: "Editor", agentPID: 20, agentName: "Google Chrome", session: "session-20")

    func testNothingHappensWhileThePersonsApplicationIsInFront() {
        let workspace = workspace()
        workspace.bringToFront(10)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(10).identity), .notNeeded)
        XCTAssertEqual(workspace.activationCount, 0)
    }

    func testWithNothingNewerTheActionBaselineIsTheDestination() {
        let workspace = workspace()
        workspace.bringToFront(20)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(11).identity),
                       .restored(app: "Notes", agentPID: 20, agentName: "Google Chrome", session: "session-20"))
        XCTAssertEqual(workspace.frontPID, 11)
    }

    func testThePersonsNewestChoiceWinsOverTheActionBaseline() {
        let workspace = workspace()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guardian.noteActivation(workspace.app(10))
        workspace.bringToFront(20)
        // The action started with Notes in front; the person has since chosen Editor.
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(11).identity), restoredToEditor)
    }

    func testOwnershipFollowsExactIdentityNotARecycledPID() {
        let workspace = workspace()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guardian.noteActivation(workspace.app(10))
        // An unrelated application that inherited an agent's PID is the person's, not the agent's.
        workspace.add(20, "Mail", agent: false, generation: 2)
        workspace.bringToFront(20)
        guardian.noteActivation(workspace.app(20))
        XCTAssertEqual(guardian.restoreIfAgentFront(), .notNeeded)
        XCTAssertEqual(workspace.activationCount, 0)
    }

    func testARememberedApplicationReplacedByARecycledPIDIsNotADestination() {
        let workspace = workspace()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guardian.noteActivation(workspace.app(11))
        workspace.add(11, "Unrelated", generation: 2)
        workspace.bringToFront(20)
        guard case .unavailable = guardian.restoreIfAgentFront() else {
            return XCTFail("a different process reusing the PID must never be activated")
        }
        XCTAssertEqual(workspace.activationCount, 0)
    }

    func testARememberedApplicationLaterAdoptedOrQuitIsNotADestination() {
        let workspace = workspace()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guardian.noteActivation(workspace.app(11))
        workspace.adopt(11)
        workspace.bringToFront(11)
        guard case .unavailable(_, 11, "session-11") = guardian.restoreIfAgentFront() else {
            return XCTFail("an adopted process must never be reported as restored to itself")
        }
        XCTAssertEqual(workspace.activationCount, 0)

        let other = self.workspace()
        let second = AgentFocusGuard(environment: other.environment)
        second.noteActivation(other.app(11))
        other.quit(11)
        other.bringToFront(20)
        guard case .unavailable = second.restoreIfAgentFront() else {
            return XCTFail("an application that exited is not a destination")
        }
        XCTAssertEqual(other.activationCount, 0)
    }

    func testThePersonSwitchingElsewhereMeansNothingIsLeftToRestore() {
        let workspace = workspace()
        workspace.bringToFront(20)
        workspace.personSwitchesTo(11)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(10).identity), .notNeeded)
        XCTAssertEqual(workspace.frontPID, 11, "the person's own choice stands")
    }

    func testUnconfirmedRestorationIsReportedAsUnavailable() {
        let workspace = workspace()
        workspace.bringToFront(20)
        workspace.ignoreActivation()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guard case let .unavailable(reason, _, _) = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity, timeout: 0.2) else {
            return XCTFail("an activation that did not take is not a restoration")
        }
        XCTAssertTrue(reason.contains("Editor"), reason)
    }

    func testRestorationWaitsForTheWholeRouteAndReportsALaggingOne() {
        let workspace = workspace()
        workspace.bringToFront(20)
        workspace.lagIsolation(3)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(10).identity), restoredToEditor, "a short lag is waited out")

        let stuck = self.workspace()
        stuck.bringToFront(20)
        stuck.lagIsolation(Int.max)
        let second = AgentFocusGuard(environment: stuck.environment)
        guard case let .unavailable(reason, 20, "session-20") = second.restoreIfAgentFront(preferring: stuck.app(10).identity, timeout: 0.3),
              reason.contains("isolation was not confirmed") else {
            return XCTFail("the front application alone is not a restoration")
        }
    }

    func testAProcessThatKeepsTakingActivationStopsBeingRestored() {
        let workspace = workspace()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        for _ in 0..<AgentFocusGuard.maximumRestores {
            workspace.bringToFront(20)
            guard case .restored = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity) else {
                return XCTFail("restorations within the budget succeed")
            }
        }
        workspace.bringToFront(20)
        guard case .unavailable = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity) else {
            return XCTFail("the guard must not trade the front with the agent indefinitely")
        }
        XCTAssertEqual(workspace.activationCount, AgentFocusGuard.maximumRestores)
        workspace.advance(AgentFocusGuard.restoreWindow + 1)
        XCTAssertEqual(guardian.restoreIfAgentFront(preferring: workspace.app(10).identity), restoredToEditor)
    }

    func testRestoreHistoryForEveryProcessExpires() {
        let workspace = workspace()
        workspace.add(21, "Agent Two", agent: true)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        for pid in [pid_t(20), 21] {
            workspace.bringToFront(pid)
            guard case .restored = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity) else {
                return XCTFail("restoration succeeds")
            }
        }
        XCTAssertEqual(guardian.restoreHistoryCount, 2)
        workspace.advance(AgentFocusGuard.restoreWindow + 1)
        workspace.bringToFront(20)
        _ = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity)
        XCTAssertEqual(guardian.restoreHistoryCount, 1, "expired histories of other processes are dropped")
    }

    func testANonFiniteTimeoutIsBoundedInsteadOfTrapping() {
        let workspace = workspace()
        workspace.bringToFront(20)
        workspace.ignoreActivation()
        let guardian = AgentFocusGuard(environment: workspace.environment)
        for timeout in [TimeInterval.infinity, .nan, -1] {
            workspace.advance(AgentFocusGuard.restoreWindow + 1)
            guard case .unavailable = guardian.restoreIfAgentFront(preferring: workspace.app(10).identity, timeout: timeout) else {
                return XCTFail("timeout \(timeout) must report unavailable")
            }
        }
    }

    func testBackgroundActivationIsReturnedAndReported() {
        let workspace = workspace()
        workspace.bringToFront(10)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        let restored = restoredToEditor
        let reported = expectation(description: "background restoration reported")
        guardian.start(observingWorkspace: false) { outcome in
            XCTAssertEqual(outcome, restored)
            reported.fulfill()
        }
        workspace.bringToFront(20)
        guardian.noteActivation(workspace.app(20))
        wait(for: [reported], timeout: 2)
        XCTAssertEqual(workspace.frontPID, 10)
        guardian.stop()
    }

    func testANotificationAheadOfTheFrontmostViewIsStillRestored() {
        let workspace = workspace()
        workspace.bringToFront(10)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guardian.noteActivation(workspace.app(10))
        workspace.bringToFrontLagging(20, reads: 5)
        XCTAssertEqual(guardian.restoreAfterActivation(of: workspace.app(20)), restoredToEditor)
    }

    func testABaselineWhosePIDWasReusedIsNotADestination() {
        let workspace = workspace()
        let original = workspace.app(11).identity
        workspace.add(11, "Unrelated", generation: 2)
        workspace.bringToFront(20)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guard case .unavailable = guardian.restoreIfAgentFront(preferring: original) else {
            return XCTFail("the replacement process must never be activated")
        }
        XCTAssertEqual(workspace.activationCount, 0)
    }

    func testRepeatedActivationQueuesAtMostOneCheckPerProcess() {
        let workspace = workspace()
        workspace.bringToFront(10)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        let reported = expectation(description: "restoration reported")
        reported.assertForOverFulfill = false
        guardian.start(observingWorkspace: false) { _ in reported.fulfill() }
        workspace.bringToFront(20)
        let gate = DispatchSemaphore(value: 0)
        workspace.gateFrontmost(gate)
        for _ in 0..<50 { guardian.noteActivation(workspace.app(20)) }
        XCTAssertLessThanOrEqual(guardian.pendingCheckCount, 1)
        workspace.gateFrontmost(nil)
        for _ in 0..<4 { gate.signal() }
        wait(for: [reported], timeout: 2)
        XCTAssertLessThanOrEqual(workspace.activationCount, 2, "fifty notifications are not fifty restorations")
        guardian.stop()
    }

    func testNoKnownPersonalApplicationMeansNoActivation() {
        let workspace = workspace()
        workspace.bringToFront(20)
        let guardian = AgentFocusGuard(environment: workspace.environment)
        guard case .unavailable = guardian.restoreIfAgentFront() else {
            return XCTFail("with nothing to return to, report rather than guess")
        }
        XCTAssertEqual(workspace.activationCount, 0)
    }

    private func report(failing dimensions: [IsolationDimension]) -> IsolationReport {
        IsolationReport(checks: IsolationDimension.allCases.map { dimension in
            let failed = dimensions.contains(dimension)
            return IsolationCheckReport(dimension: dimension, coverage: .observed,
                status: failed ? .failed : .passed, evidence: "fixture",
                failures: failed ? ["\(dimension.rawValue) changed"] : [])
        })
    }

    private func report(failing failed: [IsolationDimension] = [], unknown: [IsolationDimension]) -> IsolationReport {
        IsolationReport(checks: IsolationDimension.allCases.map { dimension in
            if unknown.contains(dimension) {
                return IsolationCheckReport(dimension: dimension, coverage: .unknown, status: .unknown,
                                            evidence: "fixture", failures: [])
            }
            let failing = failed.contains(dimension)
            return IsolationCheckReport(dimension: dimension, coverage: .observed,
                status: failing ? .failed : .passed, evidence: "fixture",
                failures: failing ? ["\(dimension.rawValue) changed"] : [])
        })
    }

    func testARecoveredRouteNeedsObservedActivationChecksButNotKnowableKeyRoutes() {
        XCTAssertTrue(AgentFocusGuard.routeRecovered(report(failing: [])))
        XCTAssertTrue(AgentFocusGuard.routeRecovered(report(unknown: [.keyInputRoute, .textInputRoute])),
                      "an app without Accessibility focus leaves the key routes unknown, as in every receipt")
        XCTAssertFalse(AgentFocusGuard.routeRecovered(report(unknown: [.activeSpace])),
                       "an unobserved Space is not a recovered one")
        XCTAssertFalse(AgentFocusGuard.routeRecovered(report(unknown: [.menuBarOwner])))
        XCTAssertFalse(AgentFocusGuard.routeRecovered(report(failing: [.keyInputRoute], unknown: [])))
        XCTAssertFalse(AgentFocusGuard.routeRecovered(report(failing: [.cursorLocation], unknown: [])))
    }

    func testOnlyAnActivationBreachIsRepairedByReturningActivation() {
        XCTAssertTrue(SessionManager.isActivationOnlyBreach(report(failing: [.menuBarOwner, .windowServerFrontProcess, .activeSpace])))
        XCTAssertTrue(SessionManager.isActivationOnlyBreach(report(failing: [.keyInputRoute, .textInputRoute])))
        XCTAssertFalse(SessionManager.isActivationOnlyBreach(report(failing: [])), "nothing to repair")
        XCTAssertFalse(SessionManager.isActivationOnlyBreach(report(failing: [.cursorLocation])),
                       "a moved pointer is never explained by activation")
        XCTAssertFalse(SessionManager.isActivationOnlyBreach(report(failing: [.menuBarOwner, .cursorLocation])))
    }
}

/// With no action in flight, an activation SpaceO could not return is a breach to report now.
final class UnrestoredActivationTests: XCTestCase {
    private final class Backing: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 92_053
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        let pixelWidth: Int? = 1280
        let valid = true
        func invalidate() {}
    }

    func testAnUnrestoredBackgroundActivationPausesItsSession() async throws {
        let backing = Backing()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [backing.displayID] })
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.unrestored",
            name: "Agent", url: URL(fileURLWithPath: "/Applications/Agent.app"), startedByUs: false,
            devToolsPort: nil, temporaryProfile: nil)
        let manager = SessionManager(
            pool: DisplayPool(stageFactory: { _, _, _, _ in stage }), runJanitor: false,
            sessionFactory: { id, slot in
                try AgentSession(id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: .windowlessForTesting, watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: [app])
            })
        let created = await manager.handle(TestController.createRequest(session: "unrestored"))
        XCTAssertTrue(created.ok, created.error ?? "")

        // A session that does not own the process (a reused name) is never paused for it.
        await manager.pauseAfterUnrestoredActivation(session: "unrestored", agentPID: 4_242_424, reason: "fixture")
        var listing = await manager.handle(TestController.request("session.list"))
        var row = try XCTUnwrap(listing.sessions?.first { $0.id == "unrestored" })
        XCTAssertNotEqual(row.inputPaused, true)

        await manager.pauseAfterUnrestoredActivation(session: "unrestored", agentPID: getpid(), reason: "fixture")
        listing = await manager.handle(TestController.request("session.list"))
        row = try XCTUnwrap(listing.sessions?.first { $0.id == "unrestored" })
        XCTAssertEqual(row.inputPaused, true)
        XCTAssertNil(row.agentPauseReason, "an isolation pause, not one the agent asked for")

        var destroy = TestController.request("session.destroy", session: "unrestored")
        destroy.quitApps = false
        let cleaned = await manager.handle(destroy)
        XCTAssertTrue(cleaned.ok, cleaned.error ?? "")
    }
}
