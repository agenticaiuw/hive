import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

final class TeardownFailureTests: XCTestCase {
    private final class DisplayState: @unchecked Sendable {
        private let lock = NSLock()
        private var attached = true
        private var failuresRemaining: Int
        private var attempts = 0

        init(failures: Int) {
            failuresRemaining = failures
        }

        func invalidate() {
            lock.withLock {
                attempts += 1
                if failuresRemaining > 0 {
                    failuresRemaining -= 1
                } else {
                    attached = false
                }
            }
        }

        var isAttached: Bool { lock.withLock { attached } }
        var attemptCount: Int { lock.withLock { attempts } }
    }

    /// Mirrors `SPOVirtualDisplay`: `invalidate` drops the display id immediately, whether or
    /// not the WindowServer actually detached the framebuffer. A fake that kept reporting its
    /// id would make every teardown-verification assertion below vacuous.
    private final class FakeDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        private let lock = NSLock()
        private var currentDisplayID: CGDirectDisplayID
        let bounds: CGRect
        private let state: DisplayState

        init(id: CGDirectDisplayID, state: DisplayState) {
            currentDisplayID = id
            bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
            self.state = state
        }

        var displayID: CGDirectDisplayID { lock.withLock { currentDisplayID } }
        var valid: Bool { lock.withLock { currentDisplayID != 0 } && state.isAttached }
        func invalidate() {
            lock.withLock { currentDisplayID = 0 }
            state.invalidate()
        }
    }

    private final class AppState: @unchecked Sendable {
        private let lock = NSLock()
        private var alive = true
        private var quitSucceeds = false
        private var attempts = 0
        private var monotonicTime: UInt64 = 0
        private var sleeps: [UInt64] = []

        func allowQuit() {
            lock.withLock { quitSucceeds = true }
        }

        func quit() {
            lock.withLock {
                attempts += 1
                if quitSucceeds { alive = false }
            }
        }

        var isAlive: Bool { lock.withLock { alive } }
        var attemptCount: Int { lock.withLock { attempts } }
        var sleepRequests: [UInt64] { lock.withLock { sleeps } }

        func wait(_ apps: [LaunchedApp], timeout: TimeInterval) -> [LaunchedApp] {
            ProcessExitWait.wait(apps, timeout: timeout, runtime: .init(
                now: { self.lock.withLock { self.monotonicTime } },
                sleep: { duration in
                    self.lock.withLock {
                        self.sleeps.append(duration)
                        self.monotonicTime += duration
                    }
                })) { _ in self.isAlive }
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

    private func makePool(
        displayID: CGDirectDisplayID,
        failures: Int
    ) -> (pool: DisplayPool, state: DisplayState) {
        let state = DisplayState(failures: failures)
        let backing = FakeDisplayBacking(id: displayID, state: state)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { state.isAttached ? [displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return (pool, state)
    }

    private func makeAppDriver(_ state: AppState) -> SessionAppTeardownDriver {
        SessionAppTeardownDriver(
            isAlive: { _ in state.isAlive },
            quit: { _, _ in state.quit() },
            waitForExit: { state.wait($0, timeout: $1) },
            cleanupTemporaryProfile: { _ in })
    }

    private func makeOwnedTestApp() throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.teardown-test",
            name: "Injected survivor",
            url: URL(fileURLWithPath: "/Applications/Injected.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
    }

    func testFailedAppQuitRetainsSessionAndProcessClaimUntilRetrySucceeds() async throws {
        let display = makePool(displayID: 90_001, failures: 0)
        let appState = AppState()
        let app = try makeOwnedTestApp()
        let driver = makeAppDriver(appState)
        let manager = SessionManager(
            pool: display.pool,
            runJanitor: false,
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    initialApps: [app])
            })

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok)

        let first = await manager.handle(TestController.request("session.destroy"))
        XCTAssertFalse(first.ok)
        XCTAssertEqual(first.teardown?.survivingProcesses.map(\.identity), [app.identity])
        XCTAssertEqual(first.teardown?.stillAttachedDisplayIDs, [90_001])
        XCTAssertEqual(first.teardown?.pendingSessionIDs, ["agent-1"])
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "agent-1")
        let countAfterFailure = await manager.count
        XCTAssertEqual(countAfterFailure, 1)

        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(listed.sessions?.first?.teardownPending, true)

        appState.allowQuit()
        let retry = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(retry.ok, retry.error ?? "")
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
        let countAfterRetry = await manager.count
        XCTAssertEqual(countAfterRetry, 0)
        XCTAssertGreaterThanOrEqual(appState.attemptCount, 2)

        var cleanup = TestController.request("session.destroy")
        cleanup.full = true
        let cleaned = await manager.handle(cleanup)
        let finalDisplayCount = await manager.displayCount
        XCTAssertTrue(cleaned.ok)
        XCTAssertEqual(finalDisplayCount, 0)
    }

    func testDirectSessionFailureIdentifiesItsStillAttachedDisplay() throws {
        let display = makePool(displayID: 90_004, failures: 0)
        let appState = AppState()
        let app = try makeOwnedTestApp()
        let slot = try display.pool.allocate()
        let session = try AgentSession(
            id: "direct",
            slot: slot,
            teardownDriver: makeAppDriver(appState),
            windowDriver: .windowlessForTesting,
            initialApps: [app])

        let first = session.destroy(timeout: 0.55)
        XCTAssertEqual(first.survivingProcesses.map(\.identity), [app.identity])
        XCTAssertEqual(first.stillAttachedDisplayIDs, [90_004])
        XCTAssertEqual(first.pendingSessionIDs, ["direct"])
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "direct")
        // The existing force phase has its own three-second wait after the graceful budget.
        let expectedSleeps: [UInt64] = [120_000_000, 120_000_000, 120_000_000, 120_000_000, 70_000_000]
            + Array(repeating: 120_000_000, count: 25)
        XCTAssertEqual(appState.sleepRequests, expectedSleeps)

        appState.allowQuit()
        XCTAssertTrue(session.destroy(timeout: 0).isComplete)
        XCTAssertEqual(appState.sleepRequests, expectedSleeps, "confirmed exit needs no further wait")
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
        XCTAssertTrue(display.pool.release(slot, retainEmpty: false))
    }

    func testFailedDisplayInvalidationRemainsOwnedAndDestroyAllRetriesIt() async {
        let display = makePool(displayID: 90_002, failures: 1)
        let manager = SessionManager(pool: display.pool, runJanitor: false)

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok)
        var destroyAll = TestController.request("session.destroy")
        destroyAll.full = true

        let first = await manager.handle(destroyAll)
        XCTAssertFalse(first.ok)
        XCTAssertEqual(first.teardown?.survivingProcesses, [])
        XCTAssertEqual(first.teardown?.stillAttachedDisplayIDs, [90_002])
        let countAfterFailure = await manager.count
        let displaysAfterFailure = await manager.displayCount
        XCTAssertEqual(countAfterFailure, 0)
        XCTAssertEqual(displaysAfterFailure, 1)
        XCTAssertEqual(display.state.attemptCount, 1)

        let retry = await manager.handle(destroyAll)
        XCTAssertTrue(retry.ok, retry.error ?? "")
        let displaysAfterRetry = await manager.displayCount
        XCTAssertEqual(displaysAfterRetry, 0)
        XCTAssertEqual(display.state.attemptCount, 2)
    }

    func testDaemonStopFailureDoesNotReportSuccessAndCanBeRetried() async {
        let display = makePool(displayID: 90_003, failures: 1)
        let manager = SessionManager(pool: display.pool, runJanitor: true)
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok)

        let first = await manager.handle(TestController.request("daemon.stop"))
        XCTAssertFalse(first.ok)
        XCTAssertEqual(first.teardown?.stillAttachedDisplayIDs, [90_003])
        XCTAssertTrue(first.error?.contains("Retry") == true)

        let stillServing = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(
            stillServing.ok,
            "a failed stop still owns apps and displays, so it must keep serving")
        let janitorAfterFailure = await manager.janitorIsRunning
        XCTAssertTrue(janitorAfterFailure, "containment must resume after a failed stop")

        let retry = await manager.handle(TestController.request("daemon.stop"))
        XCTAssertTrue(retry.ok, retry.error ?? "")
        let displaysAfterRetry = await manager.displayCount
        XCTAssertEqual(displaysAfterRetry, 0)

        let rejected = await manager.handle(Request(cmd: "ping"))
        XCTAssertFalse(rejected.ok, "a completed shutdown remains terminal for new work")
        let janitorAfterSuccess = await manager.janitorIsRunning
        XCTAssertFalse(janitorAfterSuccess)
    }

    /// A failed stop must preserve diagnostic/cleanup access. RA-055 containment supersedes
    /// the old expectation that an invalid display could still be published as a new session.
    func testStuckDisplayKeepsDiagnosticsAvailableButCannotPublishInvalidStage() async {
        let display = makePool(displayID: 90_005, failures: Int.max)
        let manager = SessionManager(pool: display.pool, runJanitor: true)
        let seeded = await manager.handle(TestController.createRequest())
        XCTAssertTrue(seeded.ok, seeded.error ?? "")

        for attempt in 1...3 {
            let stop = await manager.handle(TestController.request("daemon.stop"))
            XCTAssertFalse(stop.ok, "attempt \(attempt)")
            XCTAssertFalse(
                stop.teardown?.stillAttachedDisplayIDs.isEmpty ?? true,
                "attempt \(attempt) must report the stuck display")

            let ping = await manager.handle(Request(cmd: "ping"))
            XCTAssertTrue(ping.ok, "attempt \(attempt): \(ping.error ?? "")")
            let listed = await manager.handle(Request(cmd: "session.list"))
            XCTAssertTrue(listed.ok, "attempt \(attempt): \(listed.error ?? "")")
            let janitorRunning = await manager.janitorIsRunning
            XCTAssertTrue(janitorRunning, "attempt \(attempt)")
        }

        let created = await manager.handle(TestController.createRequest(session: "after-stuck"))
        XCTAssertFalse(created.ok, "an invalid stage must not be published as a new session")
        XCTAssertEqual(created.errorCode, "display_creation_failed")
        let count = await manager.count
        XCTAssertEqual(count, 0)
        await manager.stopJanitor()
    }

    func testWireAndMCPPreserveStructuredIncompleteTeardown() throws {
        let identity = ProcessIdentity(pid: 4242, startedAtMicroseconds: 99)
        let report = TeardownReport(
            survivingProcesses: [
                SurvivingProcessInfo(
                    LaunchedApp(
                        pid: identity.pid,
                        identity: identity,
                        bundleIdentifier: nil,
                        name: "Blocked App",
                        url: URL(fileURLWithPath: "/Applications/Blocked.app"),
                        startedByUs: true,
                        devToolsPort: nil,
                        temporaryProfile: nil)),
            ],
            stillAttachedDisplayIDs: [77],
            pendingSessionIDs: ["blocked"])
        let response = Response.failure(SpaceOError.teardownIncomplete(report))
        let decoded = try Wire.decoder.decode(
            Response.self,
            from: Wire.encoder.encode(response))

        XCTAssertFalse(decoded.ok)
        XCTAssertEqual(decoded.teardown, report)
        let rendered = MCPServer.renderFailure(decoded)
        XCTAssertTrue(rendered.contains("pid 4242"), rendered)
        XCTAssertTrue(rendered.contains("77"), rendered)
        XCTAssertTrue(rendered.contains("Retry"), rendered)
    }
}
