import XCTest
import CoreGraphics
@testable import SpaceOKit

/// An accessibility enumeration that comes back empty for a *live* app must not be read as
/// "this app has no windows".
///
/// `AgentSession.refreshWindows()` used to assign the enumeration straight over `windows`, and
/// every consumer is derived from that list: `audit()` iterates it to find escapes,
/// `reparkEscapedWindows()` iterates it to fix them, the `windows`/`ax` commands answer from it,
/// and teardown reads it to evacuate surviving windows before the agent display is destroyed. So
/// a single blank answer from `kAXWindowsAttribute` — which has a two-second timeout, and whose
/// per-element window-id lookup can fail on its own — turned into a session that reported itself
/// clean, empty and healthy while its app's windows were still on screen and outside the tile.
///
/// Observed on 2026-08-29: a live TextEdit owned by a session reported `no windows yet` from
/// `spaceo_list_windows`, `no covered audit failures` from `verify`, and `re-parked 0 window(s)`
/// from `repark`, while `CGWindowListCopyWindowInfo` showed both of its document windows alive on
/// the user's physical display. `captureWindowIdentities()` already refuses to forget on this
/// answer, for exactly this reason; the rest of the session believed it.
final class AccessibilityBlackoutWindowTests: XCTestCase {

    // MARK: - Fakes

    private final class FakeDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        private let lock = NSLock()
        private var id: CGDirectDisplayID

        init(id: CGDirectDisplayID) { self.id = id }

        var displayID: CGDirectDisplayID { lock.withLock { id } }
        var valid: Bool { lock.withLock { id != 0 } }
        func invalidate() { lock.withLock { id = 0 } }
    }

    /// A WindowServer the test owns, plus a switch for the one thing this suite is about: the
    /// accessibility enumeration going blank while the WindowServer still has the window.
    private final class FakeWindowServer: @unchecked Sendable {
        private final class Handle {
            let id: CGWindowID
            init(_ id: CGWindowID) { self.id = id }
        }
        private final class WeakHandle {
            weak var value: Handle?
            init(_ value: Handle) { self.value = value }
        }
        private let lock = NSLock()
        private var handles: [WeakHandle] = []
        private var movementDiscoveries = 0
        private var retainedMoves = 0
        private var fallbackMoves = 0
        var movementDiscoveryCount: Int { lock.withLock { movementDiscoveries } }
        var retainedMoveCount: Int { lock.withLock { retainedMoves } }
        var fallbackMoveCount: Int { lock.withLock { fallbackMoves } }
        var liveHandleCount: Int { lock.withLock { handles.filter { $0.value != nil }.count } }
        private var frames: [CGWindowID: CGRect] = [:]
        private var owner: [CGWindowID: pid_t] = [:]
        private var accessibilityBlackout = false
        private var discoveryError: Error?
        private var discoveryCalls = 0
        private var discoveryBudgets: [TimeInterval] = []
        private var discoveryHook: (@Sendable (Int) throws -> Void)?
        var discoveryCount: Int { lock.withLock { discoveryCalls } }
        var discoveryTimeouts: [TimeInterval] { lock.withLock { discoveryBudgets } }
        func setDiscoveryHook(_ hook: (@Sendable (Int) throws -> Void)?) {
            lock.withLock { discoveryHook = hook }
        }
        func resetDiscoveryCounts() {
            lock.withLock { discoveryCalls = 0; discoveryBudgets = [] }
        }
        private var legacyReads = 0
        private var moveCalls = 0
        private var unavailableBounds = Set<CGWindowID>()
        func setBoundsUnavailable(_ id: CGWindowID, _ unavailable: Bool) {
            lock.withLock {
                if unavailable { unavailableBounds.insert(id) }
                else { unavailableBounds.remove(id) }
            }
        }
        private var movesSucceed = true
        private var moveHook: (@Sendable (CGWindowID, CGRect) -> Void)?
        private var userBounds: CGRect? = CGRect(x: 2_000, y: 0, width: 1440, height: 900)
        func setMovesSucceed(_ value: Bool) { lock.withLock { movesSucceed = value } }
        func setMoveHook(_ hook: (@Sendable (CGWindowID, CGRect) -> Void)?) {
            lock.withLock { moveHook = hook }
        }
        func setUserBounds(_ bounds: CGRect?) { lock.withLock { userBounds = bounds } }
        private var quitCalls = 0
        var legacyReadCount: Int { lock.withLock { legacyReads } }
        var moveCount: Int { lock.withLock { moveCalls } }
        var quitCount: Int { lock.withLock { quitCalls } }
        func failDiscovery(_ error: Error?) { lock.withLock { discoveryError = error } }
        func recordQuit() { lock.withLock { quitCalls += 1 } }
        private var hiddenFromAccessibility: Set<CGWindowID> = []

        func add(window: CGWindowID, pid: pid_t, at frame: CGRect) {
            lock.withLock {
                frames[window] = frame
                owner[window] = pid
            }
        }

        /// The window really closes: both the accessibility tree and the WindowServer lose it.
        func close(window: CGWindowID) {
            lock.withLock {
                frames.removeValue(forKey: window)
                owner.removeValue(forKey: window)
            }
        }

        /// The WindowServer moves the window without telling accessibility, the way a display
        /// reconfiguration relocates a window under a still-live app.
        func relocate(window: CGWindowID, to frame: CGRect) {
            lock.withLock { frames[window] = frame }
        }

        /// Our window closes and the WindowServer hands its number to somebody else's window,
        /// which is what makes a window id unusable as an identity on its own.
        func recycle(window: CGWindowID, to newOwner: pid_t?) {
            lock.withLock { owner[window] = newOwner }
        }

        func frame(of window: CGWindowID) -> CGRect? { lock.withLock { frames[window] } }

        func setAccessibilityBlackout(_ blackout: Bool) {
            lock.withLock { accessibilityBlackout = blackout }
        }

        /// One window drops out of `kAXWindowsAttribute` while its siblings still resolve —
        /// the per-element window-id lookup failing for one element and not the others.
        func hideFromAccessibility(window: CGWindowID) {
            lock.withLock { _ = hiddenFromAccessibility.insert(window) }
        }

        private func accessibleWindows(_ pid: pid_t) -> [SpaceOKit.WindowRef] {
            lock.withLock {
                if accessibilityBlackout { return [] }
                return owner.filter {
                    $0.value == pid && !hiddenFromAccessibility.contains($0.key)
                }.map { WindowRef(windowID: $0.key, pid: pid,
                    title: "window \($0.key)", frame: frames[$0.key] ?? .zero) }
                    .sorted { $0.windowID < $1.windowID }
            }
        }

        var driver: SessionWindowDriver {
            let checked: @Sendable (pid_t, AXTraversalBudget, Bool) throws -> [SpaceOKit.WindowRef] = { [self] pid, budget, _ in
                try budget.check()
                let (call, hook) = lock.withLock {
                    discoveryCalls += 1
                    discoveryBudgets.append(budget.limits.timeout)
                    return (discoveryCalls, discoveryHook)
                }
                try hook?(call)
                if let error = lock.withLock({ discoveryError }) { throw error }
                let found = accessibleWindows(pid)
                for window in found {
                    try budget.consumeNode()
                    try budget.consumeAllocation(window.title.utf8.count + 256)
                }
                return found
            }
            let move: @Sendable (SpaceOKit.WindowRef, CGRect) -> Void = { [self] window, frame in
                let hook = lock.withLock {
                    moveCalls += 1
                    if movesSucceed { frames[window.windowID] = frame }
                    return moveHook
                }
                hook?(window.windowID, frame)
            }
            return SessionWindowDriver(
                windows: { [self] pid in
                    lock.withLock { legacyReads += 1 }
                    return accessibleWindows(pid)
                },
                userDisplayBounds: { [self] in lock.withLock { userBounds } },
                move: move,
                liveBounds: { [self] id in lock.withLock { unavailableBounds.contains(id) ? nil : frames[id] } },
                liveOwnerPID: { [self] id in lock.withLock { owner[id] } },
                checkedWindows: checked,
                movement: { [self] identity, budget in
                    lock.withLock { movementDiscoveries += 1 }
                    let found = try checked(identity.pid, budget, true)
                    var elements: [CGWindowID: Handle] = [:]
                    for window in found {
                        try budget.consumeAllocation(64)
                        let handle = Handle(window.windowID)
                        elements[window.windowID] = handle
                        lock.withLock { handles.append(WeakHandle(handle)) }
                    }
                    return try SessionWindowMovement(pid: identity.pid,
                        result: AXWindowDiscovery.Result(windows: found, elements: elements),
                        validate: {
                            guard identity.isAlive else { throw SpaceOError.applicationExited("fixture process changed") }
                        }, move: { window, handle, frame in
                            XCTAssertEqual(handle.id, window.windowID)
                            self.lock.withLock { self.retainedMoves += 1 }
                            move(window, frame)
                        }, fallback: { window, frame in
                            self.lock.withLock { self.fallbackMoves += 1 }
                            move(window, frame)
                        })
                })
        }
    }

    override func setUp() {
        super.setUp()
        ProcessOwnership.reset()
        AgentActivity.reset()
    }

    override func tearDown() {
        ProcessOwnership.reset()
        AgentActivity.reset()
        super.tearDown()
    }

    private func makePool(displayID: CGDirectDisplayID) -> DisplayPool {
        let backing = FakeDisplayBacking(id: displayID)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [displayID] })
        return DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    /// The test process itself, so `identity.isAlive` stays true without launching anything.
    private func makeLiveApp(startedByUs: Bool = true) throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.ax-blackout-test",
            name: "Editor",
            url: URL(fileURLWithPath: "/Applications/Editor.app"),
            startedByUs: startedByUs,
            devToolsPort: nil,
            temporaryProfile: nil)
    }

    private func makeSession(
        id: String,
        pool: DisplayPool,
        server: FakeWindowServer,
        teardownDriver: SessionAppTeardownDriver? = nil,
        watcherFactory: @escaping WindowWatcherFactory = { _, _ in throw CancellationError() }
    ) throws -> AgentSession {
        try AgentSession(
            id: id,
            slot: try pool.allocate(),
            teardownDriver: teardownDriver ?? SessionAppTeardownDriver(
                isAlive: { _ in false },
                quit: { _, _ in },
                waitForExit: { _, _ in [] },
                cleanupTemporaryProfile: { _ in }),
            windowDriver: server.driver,
            watcherFactory: watcherFactory,
            initialApps: [])
    }

    private final class PollClock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = Date(timeIntervalSinceReferenceDate: 0)
        private var delays: [TimeInterval] = []
        var sleeps: [TimeInterval] { lock.withLock { delays } }
        func advance(_ seconds: TimeInterval) { lock.withLock { time += seconds } }
        var runtime: WaitRuntime {
            WaitRuntime(now: { self.lock.withLock { self.time } }, sleep: { seconds in
                self.lock.withLock { self.delays.append(seconds); self.time += seconds }
            })
        }
    }

    private func makeCommandManager(pool: DisplayPool, server: FakeWindowServer,
                                    app: LaunchedApp?, runtime: WaitRuntime = .live) -> SessionManager {
        SessionManager(pool: pool, runJanitor: false, waitRuntime: runtime, sessionFactory: { id, slot in
            try AgentSession(id: id, slot: slot,
                teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                    waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                windowDriver: server.driver, watcherFactory: { _, _ in throw CancellationError() },
                initialApps: app.map { [$0] } ?? [])
        })
    }

    // MARK: - The list survives a blank accessibility answer

    func testTimedWindowReadsShareBudgetAndAvoidExtraDiscovery() async throws {
        for mode in ["ready", "delayed", "late", "empty", "failure", "probe-deadline"] {
            let pool = makePool(displayID: 92_030)
            defer { _ = pool.releaseAll() }
            let server = FakeWindowServer()
            let clock = PollClock()
            let app = try makeLiveApp()
            let manager = makeCommandManager(pool: pool, server: server, app: app, runtime: clock.runtime)
            let created = await manager.handle(TestController.createRequest(session: "timed-read"))
            XCTAssertTrue(created.ok, created.error ?? mode)
            server.resetDiscoveryCounts()
            server.setDiscoveryHook { call in
                if mode == "failure" { throw SpaceOError.badRequest("fixture provider failure") }
                if mode == "empty" || (mode == "delayed" && call == 1) { return }
                if mode == "probe-deadline" && call == 1 {
                    clock.advance(0.2)
                    throw AXTraversalStopped(reason: .deadline, detail: "fixture probe deadline")
                }
                if mode == "late" { clock.advance(0.6) }
                server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
            }
            var request = TestController.request("windows", session: "timed-read")
            request.pid = app.pid
            request.timeout = 0.55
            let response = await manager.handle(request)
            let success = ["ready", "delayed", "probe-deadline"].contains(mode)
            XCTAssertEqual(response.ok, success, response.error ?? mode)
            if success { XCTAssertEqual(response.windows?.map(\.windowID), [4242], mode) }
            else {
                XCTAssertNil(response.windows, mode)
                XCTAssertEqual(response.errorCode, mode == "failure" ? "bad_request" : "window_not_ready", mode)
            }
            let expectedBudgets: [TimeInterval]
            let expectedSleeps: [TimeInterval]
            switch mode {
            case "delayed": expectedBudgets = [0.55, 0.45]; expectedSleeps = [0.1]
            case "probe-deadline": expectedBudgets = [0.55, 0.25]; expectedSleeps = [0.1]
            case "empty":
                expectedBudgets = [0.55, 0.45, 0.35, 0.25, 0.15, 0.05]
                expectedSleeps = [0.1, 0.1, 0.1, 0.1, 0.1, 0.05]
            default: expectedBudgets = [0.55]; expectedSleeps = []
            }
            XCTAssertEqual(server.discoveryCount, expectedBudgets.count, mode)
            XCTAssertEqual(server.discoveryTimeouts.count, expectedBudgets.count, mode)
            for (actual, expected) in zip(server.discoveryTimeouts, expectedBudgets) {
                XCTAssertEqual(actual, expected, accuracy: 0.00001, mode)
            }
            XCTAssertEqual(clock.sleeps.count, expectedSleeps.count, mode)
            for (actual, expected) in zip(clock.sleeps, expectedSleeps) {
                XCTAssertEqual(actual, expected, accuracy: 0.00001, mode)
            }
            server.setDiscoveryHook(nil)
            var destroy = TestController.request("session.destroy", session: "timed-read")
            destroy.quitApps = false
            let cleaned = await manager.handle(destroy)
            XCTAssertTrue(cleaned.ok, cleaned.error ?? mode)
        }
    }

    func testWindowWaitWithoutAMatchingLiveAppDoesNotStartDiscovery() async throws {
        let pool = makePool(displayID: 92_031)
        defer { _ = pool.releaseAll() }
        let server = FakeWindowServer()
        let clock = PollClock()
        let manager = makeCommandManager(pool: pool, server: server, app: nil, runtime: clock.runtime)
        let created = await manager.handle(TestController.createRequest(session: "empty-read"))
        XCTAssertTrue(created.ok, created.error ?? "")
        var request = TestController.request("windows", session: "empty-read")
        request.timeout = 0.55
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        // Nothing was ever attached: the way out is opening an app, not waiting on windows.
        XCTAssertEqual(response.errorCode, "window_not_ready")
        XCTAssertEqual(response.recovery?.tool, "spaceo_open_app")
        request.pid = getpid()
        let unowned = await manager.handle(request)
        XCTAssertFalse(unowned.ok)
        XCTAssertEqual(unowned.errorCode, "bad_request")
        XCTAssertEqual(server.discoveryCount, 0)
        XCTAssertTrue(clock.sleeps.isEmpty)
        _ = await manager.handle(TestController.request("session.destroy", session: "empty-read"))
    }

    func testWindowCommandsReportDiscoveryFailureAndRecoverWithoutLegacyReads() async throws {
        let pool = makePool(displayID: 92_029)
        defer { _ = pool.releaseAll() }
        let server = FakeWindowServer()
        let app = try makeLiveApp()
        server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        let manager = makeCommandManager(pool: pool, server: server, app: app)
        let created = await manager.handle(TestController.createRequest(session: "checked-read"))
        XCTAssertTrue(created.ok, created.error ?? "")
        let request = TestController.request("windows", session: "checked-read")
        let initial = await manager.handle(request)
        XCTAssertTrue(initial.ok, initial.error ?? "")
        XCTAssertEqual(initial.windows?.map(\.windowID), [4242])
        server.failDiscovery(SpaceOError.badRequest("fixture discovery failed"))
        let failed = await manager.handle(request)
        XCTAssertFalse(failed.ok)
        XCTAssertEqual(failed.errorCode, "bad_request")
        XCTAssertTrue(failed.error?.contains("fixture discovery failed") == true)
        XCTAssertNil(failed.windows, "the command must not publish cached windows as a fresh read")
        // One session's incomplete discovery must not fail every client's listing (#47): the
        // row keeps the retained ledger and says it is not a fresh observation.
        let listing = await manager.handle(TestController.request("session.list"))
        XCTAssertTrue(listing.ok, listing.error ?? "")
        let row = try XCTUnwrap(listing.sessions?.first { $0.id == "checked-read" })
        XCTAssertEqual(row.windows.map(\.windowID), [4242])
        XCTAssertTrue(row.windowDiscoveryFailure?.contains("fixture discovery failed") == true)
        // An unconfirmed ID may be recycled: no live WindowServer lookup enriches the row.
        XCTAssertEqual(row.windows.first?.onStage, true, "judged from the last-known frame")
        XCTAssertEqual(row.windows.first?.spaces, [], "Spaces are unknown, not another window's")
        XCTAssertNil(row.windows.first?.defaultTarget, "choosing it would read live geometry")
        let otherController = await manager.handle(TestController.request("session.list", leaseID: UUID()))
        let redacted = try XCTUnwrap(otherController.sessions?.first { $0.id == "checked-read" })
        XCTAssertEqual(redacted.redacted, true)
        XCTAssertNil(redacted.windowDiscoveryFailure, "failure detail is session content")
        server.failDiscovery(nil)
        let recovered = await manager.handle(request)
        XCTAssertTrue(recovered.ok, recovered.error ?? "")
        XCTAssertEqual(recovered.windows?.map(\.windowID), [4242])
        let refreshed = await manager.handle(TestController.request("session.list"))
        XCTAssertNil(try XCTUnwrap(refreshed.sessions?.first { $0.id == "checked-read" }).windowDiscoveryFailure)
        XCTAssertEqual(server.legacyReadCount, 0)
        var destroy = TestController.request("session.destroy", session: "checked-read")
        destroy.quitApps = false
        let cleaned = await manager.handle(destroy)
        XCTAssertTrue(cleaned.ok, cleaned.error ?? "")
    }

    /// Lets a discovery hook cancel the listing task that is running it.
    private final class PendingListing: @unchecked Sendable {
        private let lock = NSLock()
        private var task: Task<Response, Never>?
        func set(_ task: Task<Response, Never>) { lock.withLock { self.task = task } }
        func cancel() {
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline {
                if let task = lock.withLock({ self.task }) { task.cancel(); return }
                usleep(1_000)
            }
        }
    }

    func testSessionListSharesOneDiscoveryBudgetAcrossSessions() async throws {
        let backing = FakeDisplayBacking(id: 92_031)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [92_031] })
        let pool = DisplayPool(sessionsPerDisplay: 3, displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage }, stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        defer { _ = pool.releaseAll() }
        let server = FakeWindowServer()
        let clock = PollClock()
        // Each session owns a distinct live process: this test, its runner, and an idle child.
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { child.terminate(); child.waitUntilExit() }
        let ids = ["budget-a", "budget-b", "budget-c"]
        var owned: [String: LaunchedApp] = [:]
        for (id, pid) in zip(ids, [getpid(), getppid(), child.processIdentifier]) {
            let identity = try XCTUnwrap(ProcessIdentity.current(of: pid))
            owned[id] = LaunchedApp(pid: pid, identity: identity, bundleIdentifier: "dev.spaceo.\(id)",
                name: id, url: URL(fileURLWithPath: "/Applications/\(id).app"), startedByUs: false,
                devToolsPort: nil, temporaryProfile: nil)
            server.add(window: CGWindowID(1_000 + pid), pid: pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        }
        let apps = owned
        let manager = SessionManager(pool: pool, runJanitor: false, waitRuntime: clock.runtime,
            sessionFactory: { id, slot in
                try AgentSession(id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: server.driver, watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: apps[id].map { [$0] } ?? [])
            })
        for id in ids {
            let created = await manager.handle(TestController.createRequest(
                session: id, ownerID: id, leaseID: UUID()))
            XCTAssertTrue(created.ok, created.error ?? id)
        }
        var operatorList = Request(cmd: "session.list")
        operatorList.operatorScope = true

        // Every session gets a fair share of what remains, capped by its own discovery limit.
        server.resetDiscoveryCounts()
        let fresh = await manager.handle(operatorList)
        XCTAssertEqual(fresh.sessions?.compactMap(\.windowDiscoveryFailure), [])
        let budget = SessionManager.sessionListRefreshBudget
        let shares = server.discoveryTimeouts
        XCTAssertEqual(shares.count, 3)
        XCTAssertEqual(shares.first ?? 0, budget / 3, accuracy: 0.001, "the first session cannot take it all")

        // An overrun that consumes the whole budget starts no further discovery.
        server.resetDiscoveryCounts()
        server.setDiscoveryHook { _ in clock.advance(budget + 1) }
        let listing = await manager.handle(operatorList)
        server.setDiscoveryHook(nil)
        XCTAssertTrue(listing.ok, listing.error ?? "")
        XCTAssertEqual(server.discoveryCount, 1, "the exhausted budget must not start more discovery")
        let rows = Dictionary(uniqueKeysWithValues: (listing.sessions ?? []).map { ($0.id, $0) })
        XCTAssertNil(rows["budget-a"]?.windowDiscoveryFailure)
        for id in ["budget-b", "budget-c"] {
            XCTAssertEqual(rows[id]?.windows.count, 1, "\(id) keeps its cached row")
            XCTAssertEqual(rows[id]?.windows.first?.spaces, [], "an unrefreshed row asks nothing live")
            XCTAssertTrue(rows[id]?.windowDiscoveryFailure?.contains("budget") == true)
        }

        // Cancellation is not a stale observation: the listing stops.
        server.setDiscoveryHook { _ in throw AXTraversalStopped(reason: .cancelled, detail: "fixture") }
        let cancelled = await manager.handle(operatorList)
        server.setDiscoveryHook(nil)
        XCTAssertFalse(cancelled.ok)

        // Including when the caller is cancelled after the budget is spent, where later
        // sessions would otherwise be skipped without reaching discovery's own checks.
        let pending = PendingListing()
        server.setDiscoveryHook { _ in
            clock.advance(budget + 1)
            pending.cancel()
            throw SpaceOError.badRequest("fixture discovery failed")
        }
        let task = Task { await manager.handle(operatorList) }
        pending.set(task)
        let cancelledLater = await task.value
        server.setDiscoveryHook(nil)
        XCTAssertFalse(cancelledLater.ok)

        for id in ids {
            var destroy = Request(cmd: "session.destroy")
            destroy.session = id
            destroy.operatorScope = true
            destroy.quitApps = false
            let cleaned = await manager.handle(destroy)
            XCTAssertTrue(cleaned.ok, cleaned.error ?? id)
        }
    }

    func testGeneralRefreshFailurePreservesHistoryAndRefusesTargetsAndRepark() throws {
        let pool = makePool(displayID: 92_025)
        let server = FakeWindowServer()
        let session = try makeSession(id: "refresh-failure", pool: pool, server: server)
        defer { server.failDiscovery(nil); session.destroy(quitApps: false); _ = pool.releaseAll() }
        let app = try makeLiveApp()
        server.add(window: 4242, pid: app.pid, at: CGRect(x: 2040, y: 20, width: 200, height: 100))
        session.register(app: app, windows: [])
        let original = session.windows
        session.axHistory.remember(snapshotID: "original", windowID: 4242, nodes: [])
        server.failDiscovery(SpaceOError.badRequest(String(repeating: "x", count: 10_000)))
        XCTAssertEqual(session.refreshWindows(), original)
        XCTAssertLessThanOrEqual(try XCTUnwrap(session.windowRefreshFailure).utf8.count, 512)
        XCTAssertThrowsError(try session.resolveWindow(4242))
        XCTAssertEqual(session.reparkEscapedWindows(), 0)
        XCTAssertEqual(server.moveCount, 0)
        XCTAssertEqual(session.windows, original)
        XCTAssertNotNil(session.axHistory.nodes(for: "original"))
        server.failDiscovery(nil)
        XCTAssertEqual(try session.resolveWindow(4242).windowID, 4242)
        XCTAssertNil(session.windowRefreshFailure)
        XCTAssertEqual(server.legacyReadCount, 0)
    }

    func testGeneralRefreshResourceLimitDoesNotPublishPartialWindows() throws {
        let pool = makePool(displayID: 92_026)
        let server = FakeWindowServer()
        let session = try makeSession(id: "refresh-limit", pool: pool, server: server)
        let app = try makeLiveApp()
        defer {
            for id in 1...257 { server.close(window: CGWindowID(id)) }
            session.destroy(quitApps: false)
            _ = pool.releaseAll()
        }
        server.add(window: 1, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        session.register(app: app, windows: [])
        let original = session.windows
        for id in 2...257 {
            server.add(window: CGWindowID(id), pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        }
        XCTAssertThrowsError(try session.refreshWindowsChecked()) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .nodes)
        }
        XCTAssertEqual(session.windows, original)
        XCTAssertNotNil(session.windowRefreshFailure)
        XCTAssertEqual(server.legacyReadCount, 0)
    }

    func testRetainedWindowStorageConsumesDiscoveryBudget() throws {
        let pool = makePool(displayID: 92_027)
        let server = FakeWindowServer()
        let session = try makeSession(id: "retained-budget", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
        let app = try makeLiveApp()
        server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        session.register(app: app, windows: [])
        let original = session.windows
        server.setAccessibilityBlackout(true)
        var limits = try AXWindowDiscovery.limits(remaining: 1)
        limits.maxAllocatedBytes = 256
        let budget = try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
        XCTAssertThrowsError(try session.refreshWindows(forWait: budget)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .allocation)
        }
        XCTAssertEqual(session.windows, original)
    }

    func testTeardownDiscoveryFailureRetainsOwnershipAndStillAllowsExplicitQuit() throws {
        for quit in [false, true] {
            let pool = makePool(displayID: 92_028)
            let server = FakeWindowServer()
            let app = try makeLiveApp()
            let driver = SessionAppTeardownDriver(isAlive: { _ in true },
                quit: { _, _ in server.recordQuit() }, waitForExit: { apps, _ in apps },
                cleanupTemporaryProfile: { _ in })
            let session = try makeSession(id: "teardown-discovery-\(quit)", pool: pool, server: server,
                                          teardownDriver: driver)
            defer { server.failDiscovery(nil); session.destroy(quitApps: false); _ = pool.releaseAll() }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
            session.register(app: app, windows: [])
            let original = session.windows
            server.failDiscovery(AXWindowDiscovery.incomplete("fixture provider unavailable"))
            let pending = session.destroy(quitApps: quit, force: false, timeout: 0)
            XCTAssertFalse(pending.isComplete)
            XCTAssertEqual(pending.pendingSessionIDs, [session.id])
            XCTAssertEqual(pending.stillAttachedDisplayIDs, [session.stage.displayID])
            XCTAssertTrue(pending.windowDiscoveryFailures?.first?.contains("fixture provider unavailable") == true)
            XCTAssertTrue(pending.recoveryDescription.contains("Window discovery incomplete"))
            XCTAssertEqual(server.quitCount, quit ? 1 : 0)
            XCTAssertEqual(server.moveCount, 0)
            XCTAssertEqual(session.windows, original)
            XCTAssertEqual(session.apps.map(\.identity), [app.identity])
            XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id)
            server.failDiscovery(nil)
            XCTAssertTrue(session.destroy(quitApps: false, timeout: 0).isComplete)
            XCTAssertEqual(server.moveCount, 1)
            XCTAssertNil(ProcessOwnership.owner(of: app.identity))
            XCTAssertEqual(server.legacyReadCount, 0)
        }
    }

    func testSessionReportsBoundedWatcherSweepFailureWithTheOwnedApp() throws {
        let pool = makePool(displayID: 92_023)
        let server = FakeWindowServer()
        let app = try makeLiveApp()
        let watcher = WindowWatcher(testingPID: app.pid,
            region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
            driver: WindowWatcherDriver(pid: app.pid, validate: {}, discover: { _ -> AXWindowDiscovery.Result<Int> in
                throw AXWindowDiscovery.incomplete("fixture page failed")
            }, isContained: { _, _ in true }, move: { _, _, rect in rect }))
        let session = try makeSession(id: "watcher-failure", pool: pool, server: server,
                                      watcherFactory: { _, _ in watcher })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
        session.register(app: app, windows: [])
        watcher.sweep()
        XCTAssertEqual(session.watcherSweepFailures.count, 1)
        XCTAssertTrue(session.watcherSweepFailures[0].contains("Editor"))
        XCTAssertTrue(session.watcherSweepFailures[0].contains("fixture page failed"))
        XCTAssertTrue(session.watcherRegistrationFailures.isEmpty,
                      "sweep failures are distinct from observer registration failures")
    }

    func testWaitDiscoveryRetainsKnownWindowsWithoutReusingTheirTitlesAsObservations() throws {
        let pool = makePool(displayID: 92_020)
        let server = FakeWindowServer()
        let session = try makeSession(id: "wait-known", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        _ = session.refreshWindows()
        server.setAccessibilityBlackout(true)
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { false })
        let observed = try session.refreshWindows(forWait: budget)
        XCTAssertTrue(observed.isEmpty, "cached titles are not fresh observations")
        XCTAssertEqual(session.windows.map(\.windowID), [4242], "containment retains live owned windows")
    }

    func testFailedWaitDiscoveryLeavesKnownWindowsAndHistoryUnchanged() throws {
        let pool = makePool(displayID: 92_021)
        let server = FakeWindowServer()
        let session = try makeSession(id: "wait-partial", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        server.add(window: 4242, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        let original = session.refreshWindows()
        session.axHistory.remember(snapshotID: "original", windowID: 4242, nodes: [])
        server.add(window: 4243, pid: app.pid, at: CGRect(x: 30, y: 10, width: 20, height: 20))
        var limits = try AXWindowDiscovery.limits(remaining: 1)
        limits.maxNodes = 1
        let budget = try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
        XCTAssertThrowsError(try session.refreshWindows(forWait: budget)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .nodes)
        }
        XCTAssertEqual(session.windows, original)
        XCTAssertNotNil(session.axHistory.nodes(for: "original"))
    }

    func testCaptureIdentityRetentionIsBoundedAndNeverDropsKnownWindowsToFit() throws {
        let pool = makePool(displayID: 92_022)
        let server = FakeWindowServer()
        let session = try makeSession(id: "capture-known", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        for id: CGWindowID in [4242, 4243] {
            server.add(window: id, pid: app.pid, at: CGRect(x: 10, y: 10, width: 20, height: 20))
        }
        let original = session.refreshWindows()
        server.setAccessibilityBlackout(true)
        var limits = try AXWindowDiscovery.limits(remaining: 1)
        limits.maxNodes = 1
        let small = try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
        XCTAssertThrowsError(try session.captureWindowIdentities(budget: small)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .nodes)
        }
        XCTAssertEqual(session.windows, original)
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { false })
        let identities = try session.captureWindowIdentities(budget: budget)
        XCTAssertEqual(identities.map(\.windowID), [4242, 4243])
        XCTAssertTrue(identities.allSatisfy { $0.title.isEmpty })
        XCTAssertEqual(session.windows, original, "capture discovery never mutates the session's window list")
    }

    func testABlankAccessibilityEnumerationDoesNotEraseALiveAppsWindows() throws {
        let pool = makePool(displayID: 92_001)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-list", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_242
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        XCTAssertEqual(session.refreshWindows().map(\.windowID), [document])

        session.axHistory.remember(snapshotID: "retained", windowID: document, nodes: [])
        server.setAccessibilityBlackout(true)

        XCTAssertEqual(
            session.refreshWindows().map(\.windowID), [document],
            "the WindowServer still has this window and the app is alive, so an empty "
            + "accessibility enumeration is a failed read, not a closed window")
        XCTAssertNotNil(session.axHistory.nodes(for: "retained"),
                        "a transient AX blackout must preserve incremental read history")
    }

    /// The complement, so the fix cannot be "never forget anything": a window the WindowServer
    /// has also lost really is closed and must leave the list.
    func testAWindowTheWindowServerHasForgottenIsStillDropped() throws {
        let pool = makePool(displayID: 92_002)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-close", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_243
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        XCTAssertEqual(session.refreshWindows().map(\.windowID), [document])

        session.axHistory.remember(snapshotID: "closed", windowID: document, nodes: [])
        XCTAssertGreaterThan(session.axHistory.byteCount, 0)
        server.setAccessibilityBlackout(true)
        server.close(window: document)

        XCTAssertEqual(session.refreshWindows(), [],
                       "a window neither accessibility nor the WindowServer knows about is "
                       + "closed; retaining it would make every audit chase a ghost")
        XCTAssertNil(session.axHistory.nodes(for: "closed"))
        XCTAssertEqual(session.axHistory.byteCount, 0)
    }

    // MARK: - What the erased list was hiding

    func testTeardownVerifiesNewWindowsAndDiscoveryAfterEvacuation() throws {
        for mode in ["new-window", "discovery-failure", "unknown-bounds"] {
            let pool = makePool(displayID: 92_036)
            let server = FakeWindowServer()
            let app = try makeLiveApp(startedByUs: false)
            let session = try makeSession(id: "teardown-post-move-\(mode)", pool: pool, server: server)
            defer {
                server.setMoveHook(nil)
                server.failDiscovery(nil)
                server.setBoundsUnavailable(1, false)
                session.destroy(quitApps: false)
                _ = pool.releaseAll()
            }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            server.add(window: 1, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
            session.register(app: app, windows: [])
            server.setMoveHook { _, _ in
                switch mode {
                case "new-window":
                    server.add(window: 2, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
                case "discovery-failure": server.failDiscovery(AXWindowDiscovery.incomplete("post-move fixture"))
                default: server.setBoundsUnavailable(1, true)
                }
            }
            let pending = session.destroy(quitApps: false)
            XCTAssertFalse(pending.isComplete, mode)
            XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id, mode)
            if mode == "new-window" { XCTAssertEqual(pending.strandedWindows.map(\.windowID), [2]) }
            else { XCTAssertFalse(pending.windowDiscoveryFailures?.isEmpty ?? true, mode) }
            server.setMoveHook(nil)
            server.failDiscovery(nil)
            server.setBoundsUnavailable(1, false)
            XCTAssertTrue(session.destroy(quitApps: false).isComplete, mode)
            XCTAssertNil(ProcessOwnership.owner(of: app.identity), mode)
        }
    }

    func testManyWindowEvacuationKeepsEveryRequestedFrameOnTheUserDisplay() throws {
        for rollback in [false, true] {
            let pool = makePool(displayID: 92_035)
            let server = FakeWindowServer()
            let app = try makeLiveApp(startedByUs: false)
            let session = try makeSession(id: "evacuation-cascade-\(rollback)", pool: pool, server: server)
            defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            for id in 1...70 {
                server.add(window: CGWindowID(id), pid: app.pid,
                           at: CGRect(x: 10, y: 10, width: 200, height: 100))
            }
            session.register(app: app, windows: [])
            server.resetDiscoveryCounts()
            server.setMoveHook { _, _ in XCTAssertEqual(server.liveHandleCount, 70) }
            server.setDiscoveryHook { call in
                if call > 1 { XCTAssertEqual(server.liveHandleCount, 0, "release handles before verification") }
            }
            if rollback { XCTAssertTrue(session.rollbackUndurableApp(app)) }
            else { XCTAssertTrue(session.destroy(quitApps: false).isComplete) }
            XCTAssertEqual(server.moveCount, 70)
            XCTAssertEqual(server.movementDiscoveryCount, 1)
            XCTAssertEqual(server.discoveryCount, 2, "one movement discovery and one required verification")
            XCTAssertEqual(server.retainedMoveCount, 70)
            XCTAssertEqual(server.fallbackMoveCount, 0)
            XCTAssertEqual(server.liveHandleCount, 0)
            let userDisplay = CGRect(x: 2000, y: 0, width: 1440, height: 900)
            for id in 1...70 {
                XCTAssertTrue(userDisplay.contains(try XCTUnwrap(server.frame(of: CGWindowID(id)))), "window \(id)")
            }
        }
    }

    func testAdoptedRollbackRequiresEveryWindowToLeaveTheDisplay() throws {
        for mode in ["land", "refuse", "later-move", "partial-overlap", "unknown-bounds", "new-window", "closed"] {
            let pool = makePool(displayID: 92_032)
            let server = FakeWindowServer()
            let app = try makeLiveApp(startedByUs: false)
            let session = try makeSession(id: "rollback-\(mode)", pool: pool, server: server)
            defer {
                server.setMoveHook(nil)
                server.setMovesSucceed(true)
                server.setBoundsUnavailable(1, false)
                session.destroy(quitApps: false)
                _ = pool.releaseAll()
            }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            for id: CGWindowID in [1, 2] {
                server.add(window: id, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
            }
            session.register(app: app, windows: [])
            server.setMovesSucceed(mode != "refuse")
            server.setMoveHook { id, _ in
                if mode == "closed" { server.close(window: id) }
                if mode == "unknown-bounds" && id == 1 { server.setBoundsUnavailable(id, true) }
                if mode == "later-move" && id == 2 {
                    server.relocate(window: 1, to: CGRect(x: 10, y: 10, width: 200, height: 100))
                }
                if mode == "new-window" && id == 2 {
                    server.add(window: 3, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
                }
                if mode == "partial-overlap" && id == 1 {
                    server.relocate(window: id, to: CGRect(x: 1270, y: 10, width: 200, height: 100))
                }
            }
            let complete = session.rollbackUndurableApp(app)
            XCTAssertEqual(server.liveHandleCount, 0, mode)
            let expected = mode == "land" || mode == "closed"
            XCTAssertEqual(complete, expected, mode)
            XCTAssertEqual(server.moveCount, 2, mode)
            XCTAssertEqual(server.quitCount, 0, "adopted apps must never be quit")
            XCTAssertEqual(session.apps.isEmpty, expected, mode)
            if !expected {
                XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id, mode)
                XCTAssertTrue(AgentActivity.ownedPIDs.contains(app.pid), mode)
                server.setMoveHook(nil)
                server.setMovesSucceed(true)
                if mode == "unknown-bounds" {
                    server.setAccessibilityBlackout(true)
                    XCTAssertFalse(session.rollbackUndurableApp(app), "unknown geometry cannot become closure on retry")
                    XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id)
                    server.setAccessibilityBlackout(false)
                }
                server.setBoundsUnavailable(1, false)
                XCTAssertTrue(session.rollbackUndurableApp(app), "a verified retry must release \(mode)")
            }
            XCTAssertNil(ProcessOwnership.owner(of: app.identity), mode)
            XCTAssertFalse(AgentActivity.ownedPIDs.contains(app.pid), mode)
        }
    }

    func testAdoptedRollbackUnavailableDiscoveryOrDisplayKeepsOwnership() throws {
        for mode in ["discovery", "no-display", "invalid-display"] {
            let pool = makePool(displayID: 92_033)
            let server = FakeWindowServer()
            let app = try makeLiveApp(startedByUs: false)
            let session = try makeSession(id: "rollback-unavailable-\(mode)", pool: pool, server: server)
            defer { session.destroy(quitApps: false); _ = pool.releaseAll() }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            server.add(window: 1, pid: app.pid, at: CGRect(x: 10, y: 10, width: 200, height: 100))
            session.register(app: app, windows: [])
            if mode == "discovery" { server.failDiscovery(AXWindowDiscovery.incomplete("fixture")) }
            if mode == "no-display" { server.setUserBounds(nil) }
            if mode == "invalid-display" { server.setUserBounds(.zero) }
            XCTAssertFalse(session.rollbackUndurableApp(app), mode)
            XCTAssertEqual(server.liveHandleCount, 0, mode)
            XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id, mode)
            XCTAssertEqual(server.moveCount, 0, mode)
            XCTAssertEqual(server.quitCount, 0, mode)
            server.failDiscovery(nil)
            server.setUserBounds(CGRect(x: 2000, y: 0, width: 1440, height: 900))
            XCTAssertTrue(session.rollbackUndurableApp(app), mode)
        }
    }

    func testRollbackDefersActiveWatchersAndRestoresContainmentAfterFailure() throws {
        for phase in ["discovery", "move", "placed"] {
            let pool = makePool(displayID: 92_034)
            let server = FakeWindowServer()
            let app = try makeLiveApp(startedByUs: false)
            let window = WindowRef(windowID: 1, pid: app.pid, title: "Document",
                frame: CGRect(x: 2040, y: 10, width: 200, height: 100))
            server.add(window: 1, pid: app.pid, at: window.frame)
            var duringSweep: (() -> Void)?
            var discoveries = 0
            let watcher = WindowWatcher(testingPID: app.pid,
                region: { CGRect(x: 0, y: 0, width: 1280, height: 800) },
                onPlaced: { _ in if phase == "placed" { duringSweep?() } },
                driver: WindowWatcherDriver(pid: app.pid, validate: {}, discover: { _ in
                    discoveries += 1
                    if phase == "discovery" { duringSweep?() }
                    return AXWindowDiscovery.Result(windows: [window], elements: [1: 101])
                }, isContained: { id, region in
                    server.frame(of: id).map { WindowPlacement.isFullyInside($0, region) }
                }, move: { window, _, target in
                    if phase == "move" { duringSweep?() }
                    server.relocate(window: window.windowID, to: target)
                    return target
                }))
            var watcherCreations = 0
            let session = try makeSession(id: "rollback-watcher-\(phase)", pool: pool, server: server,
                watcherFactory: { _, _ in watcherCreations += 1; return watcher })
            defer {
                duringSweep = nil
                server.setMoveHook(nil)
                server.setMovesSucceed(true)
                session.destroy(quitApps: false)
                _ = pool.releaseAll()
            }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            session.register(app: app, windows: [window])
            var attempts = 0
            duringSweep = { [weak session] in
                guard let session else { return XCTFail("session disappeared") }
                attempts += 1
                XCTAssertFalse(session.rollbackUndurableApp(app), phase)
                XCTAssertEqual(server.moveCount, 0, phase)
                XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id, phase)
            }
            watcher.sweep()
            duringSweep = nil
            XCTAssertEqual(attempts, 1, phase)
            XCTAssertEqual(discoveries, 1, phase)

            server.setMoveHook { [weak session] _, _ in session?.sweepStrayWindows() }
            server.setMovesSucceed(false)
            XCTAssertFalse(session.rollbackUndurableApp(app), phase)
            XCTAssertEqual(discoveries, 2, "deferred containment runs once after failed evacuation finishes")
            XCTAssertFalse(watcher.isQuiescent, "failed rollback must not permanently stop the watcher")
            watcher.sweep()
            XCTAssertEqual(discoveries, 3, "containment resumes without creating another observer")
            XCTAssertEqual(watcherCreations, 1, phase)

            server.setMovesSucceed(true)
            XCTAssertTrue(session.rollbackUndurableApp(app), phase)
            XCTAssertTrue(watcher.isQuiescent, phase)
            watcher.sweep()
            XCTAssertEqual(discoveries, 3, "successful rollback permanently stops late notifications")
            XCTAssertEqual(watcherCreations, 1, phase)
            XCTAssertNil(ProcessOwnership.owner(of: app.identity), phase)
        }
    }

    func testTeardownRetainsResourcesUntilWatcherWorkAndCallbacksFinish() throws {
        for phase in ["discovery", "move", "placed"] {
            let pool = makePool(displayID: 92_024)
            let server = FakeWindowServer()
            let app = try makeLiveApp()
            let document: CGWindowID = 4_246
            let original = CGRect(x: 2_040, y: 60, width: 600, height: 400)
            let window = WindowRef(windowID: document, pid: app.pid, title: "Document", frame: original)
            server.add(window: document, pid: app.pid, at: original)
            var duringSweep: (() -> Void)?
            var moves = 0
            let watcher = WindowWatcher(testingPID: app.pid,
                region: { CGRect(x: 0, y: 0, width: 1280, height: 800) },
                onPlaced: { _ in if phase == "placed" { duringSweep?() } },
                driver: WindowWatcherDriver(pid: app.pid, validate: {}, discover: { _ in
                    if phase == "discovery" { duringSweep?() }
                    return AXWindowDiscovery.Result(windows: [window], elements: [document: Int(document)])
                }, isContained: { id, region in
                    server.frame(of: id).map { WindowPlacement.isFullyInside($0, region) }
                }, move: { window, _, target in
                    moves += 1
                    if phase == "move" { duringSweep?() }
                    // A native move may finish after stop returns. Teardown must retain the tile.
                    server.relocate(window: window.windowID, to: target)
                    return target
                }))
            let session = try makeSession(id: "watcher-drain-\(phase)", pool: pool, server: server,
                                          watcherFactory: { _, _ in watcher })
            defer {
                duringSweep = nil
                session.destroy(quitApps: false)
                _ = pool.releaseAll()
            }
            try ProcessOwnership.claim(app.identity, owner: session.id)
            session.register(app: app, windows: [window])
            var pending: TeardownReport?
            duringSweep = { [weak session] in
                guard let session else { return XCTFail("session disappeared") }
                let before = server.frame(of: document)
                pending = session.destroy(quitApps: false, timeout: 0)
                XCTAssertFalse(watcher.isQuiescent, phase)
                XCTAssertEqual(server.frame(of: document), before, "no evacuation during \(phase)")
                XCTAssertEqual(session.apps.map(\.identity), [app.identity], phase)
                XCTAssertEqual(session.windows.map(\.windowID), [document], phase)
                XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id, phase)
                XCTAssertTrue(AgentActivity.ownedPIDs.contains(app.pid), phase)
            }
            watcher.sweep()
            duringSweep = nil
            let report = try XCTUnwrap(pending, phase)
            XCTAssertFalse(report.isComplete, phase)
            XCTAssertEqual(report.pendingSessionIDs, [session.id], phase)
            XCTAssertEqual(report.stillAttachedDisplayIDs, [session.stage.displayID], phase)
            XCTAssertTrue(watcher.isQuiescent, phase)

            XCTAssertTrue(session.destroy(quitApps: false, timeout: 0).isComplete, phase)
            XCTAssertTrue(session.apps.isEmpty, phase)
            XCTAssertNil(ProcessOwnership.owner(of: app.identity), phase)
            let landed = try XCTUnwrap(server.frame(of: document))
            XCTAssertFalse(landed.intersects(session.stage.bounds), phase)
            watcher.sweep()
            XCTAssertEqual(moves, phase == "discovery" ? 0 : 1, phase)
            XCTAssertEqual(server.frame(of: document), landed, "a late sweep cannot undo evacuation")
        }
    }

    /// Teardown evacuates the windows that outlive the session onto the user's display before the
    /// agent display is destroyed. It reads the same list, so the blackout used to strand a kept
    /// app's window on a framebuffer that was about to disappear.
    ///
    /// (`audit()`'s escape check asks the real WindowServer through `WindowPlacement.hasEscaped`
    /// rather than the injected driver, so it cannot be driven from here; the list this test and
    /// `testABlankAccessibilityEnumerationDoesNotEraseALiveAppsWindows` pin is the input the
    /// audit iterates.)
    func testTeardownStillEvacuatesAKeptWindowDuringAnAccessibilityBlackout() throws {
        let pool = makePool(displayID: 92_003)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-teardown", pool: pool, server: server)
        defer { _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_244
        server.add(window: document, pid: app.pid,
                   at: WindowPlacement.defaultFrame(in: session.frame))
        _ = session.refreshWindows()

        server.setAccessibilityBlackout(true)
        _ = session.destroy(quitApps: false, timeout: 0)

        let landed = try XCTUnwrap(server.frame(of: document))
        XCTAssertTrue(
            CGRect(x: 2_000, y: 0, width: 1_440, height: 900)
                .contains(CGPoint(x: landed.midX, y: landed.midY)),
            "a window that outlives the session must be moved to the user's display before the "
            + "agent display is destroyed; it was left at \(landed)")
    }

    func testReparkStillRecoversAnEscapedWindowDuringAnAccessibilityBlackout() throws {
        let pool = makePool(displayID: 92_004)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-repark", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_245
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        _ = session.refreshWindows()

        server.relocate(window: document, to: CGRect(x: 2_040, y: 60, width: 600, height: 400))
        server.setAccessibilityBlackout(true)

        XCTAssertEqual(session.reparkEscapedWindows(), 1,
                       "repark exists to pull escaped windows back; with the list erased it "
                       + "reported `re-parked 0 window(s)` and left them on the user's display")
        XCTAssertEqual(server.fallbackMoveCount, 1)
        XCTAssertEqual(server.retainedMoveCount, 0)
        XCTAssertEqual(server.liveHandleCount, 0)
        let landed = try XCTUnwrap(server.frame(of: document))
        XCTAssertTrue(WindowPlacement.isFullyInside(landed, session.frame),
                      "window landed at \(landed) for tile \(session.frame)")
    }

    func testReparkReusesHandlesAndReleasesThemAfterSuccessAndRefusal() throws {
        for succeeds in [true, false] {
            let pool = makePool(displayID: 92_040)
            let server = FakeWindowServer()
            let app = try makeLiveApp()
            let session = try makeSession(id: "retained-repark-\(succeeds)", pool: pool, server: server)
            defer {
                server.setMoveHook(nil)
                server.setDiscoveryHook(nil)
                server.setMovesSucceed(true)
                session.destroy(quitApps: false)
                _ = pool.releaseAll()
            }
            for id in 1...70 {
                server.add(window: CGWindowID(id), pid: app.pid,
                           at: CGRect(x: 2_000, y: 0, width: 200, height: 100))
            }
            session.register(app: app, windows: [])
            _ = try session.refreshWindowsChecked()
            XCTAssertEqual(server.movementDiscoveryCount, 0, "ordinary reads retain no movement handles")
            server.resetDiscoveryCounts()
            server.setMovesSucceed(succeeds)
            server.setMoveHook { _, _ in XCTAssertEqual(server.liveHandleCount, 70) }
            server.setDiscoveryHook { call in
                if call > 1 { XCTAssertEqual(server.liveHandleCount, 0) }
            }
            XCTAssertEqual(session.reparkEscapedWindows(), succeeds ? 70 : 0)
            XCTAssertEqual(server.movementDiscoveryCount, 1)
            XCTAssertEqual(server.discoveryCount, succeeds ? 2 : 1)
            XCTAssertEqual(server.retainedMoveCount, 70)
            XCTAssertEqual(server.fallbackMoveCount, 0)
            XCTAssertEqual(server.liveHandleCount, 0)
        }
    }

    func testIncompleteRetainedWindowDiscoveryReleasesHandlesBeforeAnyMove() throws {
        let pool = makePool(displayID: 92_041)
        let server = FakeWindowServer()
        let app = try makeLiveApp()
        let session = try makeSession(id: "retained-discovery-failure", pool: pool, server: server)
        defer {
            server.recycle(window: 2, to: app.pid)
            session.destroy(quitApps: false)
            _ = pool.releaseAll()
        }
        for id in 1...2 {
            server.add(window: CGWindowID(id), pid: app.pid,
                       at: CGRect(x: 2_000, y: 0, width: 200, height: 100))
        }
        session.register(app: app, windows: [])
        _ = try session.refreshWindowsChecked()
        server.hideFromAccessibility(window: 2)
        server.recycle(window: 2, to: nil)
        XCTAssertEqual(session.reparkEscapedWindows(), 0)
        XCTAssertNotNil(session.windowRefreshFailure)
        XCTAssertEqual(session.windows.count, 2, "failed refresh preserves the prior cache")
        XCTAssertEqual(server.moveCount, 0)
        XCTAssertEqual(server.liveHandleCount, 0)
    }
}

extension AccessibilityBlackoutWindowTests {

    /// Retention has to survive a blank accessibility read *without* becoming a way to hold a
    /// window that is no longer ours. `CGWindowID`s are recycled, so bounds are not identity:
    /// keeping one on geometry alone would let the containment sweep re-park a window belonging
    /// to an application SpaceO never launched.
    func testARecycledWindowIDOwnedBySomebodyElseIsNotRetained() throws {
        let pool = makePool(displayID: 92_005)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-recycled", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_246
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        XCTAssertEqual(session.refreshWindows().map(\.windowID), [document])

        // Ours closed; the number now belongs to a stranger, and the WindowServer still answers
        // for it with perfectly good bounds.
        server.setAccessibilityBlackout(true)
        server.recycle(window: document, to: app.pid + 1)

        XCTAssertEqual(session.refreshWindows(), [],
                       "the WindowServer has bounds for this id, but it is not our window any "
                       + "more; retaining it would hand the sweep a stranger's window to move")
    }

    /// An owner the WindowServer will not name is unknown, and unknown must not read as a match.
    func testAWindowWithNoNameableOwnerCannotBeTargetedOrForgottenByCleanup() throws {
        let pool = makePool(displayID: 92_006)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-blackout-unknown-owner", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp(startedByUs: false)
        try ProcessOwnership.claim(app.identity, owner: session.id)
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_247
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        XCTAssertEqual(session.refreshWindows().map(\.windowID), [document])

        server.setAccessibilityBlackout(true)
        server.recycle(window: document, to: nil)

        XCTAssertThrowsError(try session.refreshWindowsChecked())
        XCTAssertEqual(session.windows.map(\.windowID), [document], "unknown is not proof of closure")
        XCTAssertThrowsError(try session.resolveWindow(document))
        XCTAssertEqual(session.reparkEscapedWindows(), 0)
        for _ in 0..<2 { XCTAssertFalse(session.rollbackUndurableApp(app)) }
        XCTAssertFalse(session.destroy(quitApps: false).isComplete)
        XCTAssertEqual(server.moveCount, 0, "ambiguous identity must never become movement authority")
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), session.id)
        server.recycle(window: document, to: app.pid)
        server.setAccessibilityBlackout(false)
        XCTAssertTrue(session.destroy(quitApps: false).isComplete)
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
    }
}

extension AccessibilityBlackoutWindowTests {

    /// The blank-answer case is not the only one. `kAXWindowsAttribute` returns a list of
    /// elements and SpaceO resolves each element's window id separately, so that second lookup
    /// can fail for *one* window while its siblings resolve perfectly. A retention that only
    /// engaged when the whole enumeration came back empty still silently dropped that window —
    /// and a two-document app losing one document is the shape of the original incident.
    func testAPartialEnumerationKeepsTheWindowAccessibilityLeftOut() throws {
        let pool = makePool(displayID: 92_007)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-partial", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let alpha: CGWindowID = 4_248
        let beta: CGWindowID = 4_249
        server.add(window: alpha, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        server.add(window: beta, pid: app.pid,
                   at: CGRect(x: 80, y: 80, width: 600, height: 400))
        XCTAssertEqual(session.refreshWindows().map(\.windowID).sorted(), [alpha, beta])

        // Accessibility keeps answering — it just stops mentioning one of the two.
        server.hideFromAccessibility(window: beta)
        server.relocate(window: beta, to: CGRect(x: 2_040, y: 60, width: 600, height: 400))

        XCTAssertEqual(
            session.refreshWindows().map(\.windowID).sorted(), [alpha, beta],
            "a partial enumeration is a partial failure; the window it omitted is still open, "
            + "still owned by this app, and now outside the tile")

        // And the consequence the list exists for: it is still recoverable.
        XCTAssertEqual(session.reparkEscapedWindows(), 1)
        let landed = try XCTUnwrap(server.frame(of: beta))
        XCTAssertTrue(WindowPlacement.isFullyInside(landed, session.frame),
                      "window landed at \(landed) for tile \(session.frame)")
    }

    /// Enumerated data is authoritative for what it returns: a window present in both the
    /// enumeration and the cache must appear once, with accessibility's geometry.
    func testAnEnumeratedWindowIsNotDuplicatedByTheRetainedList() throws {
        let pool = makePool(displayID: 92_008)
        let server = FakeWindowServer()
        let session = try makeSession(id: "ax-no-dupes", pool: pool, server: server)
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])
        let document: CGWindowID = 4_250
        server.add(window: document, pid: app.pid,
                   at: CGRect(x: 40, y: 40, width: 600, height: 400))
        _ = session.refreshWindows()

        let refreshed = session.refreshWindows()
        XCTAssertEqual(refreshed.map(\.windowID), [document],
                       "the merge must key on window id, not concatenate two sources")
    }
}
