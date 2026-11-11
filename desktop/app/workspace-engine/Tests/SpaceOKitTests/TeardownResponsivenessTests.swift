import XCTest
import CoreGraphics
@testable import SpaceOKit

final class TeardownResponsivenessTests: XCTestCase {
    private final class DisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 92_001
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        var isAttached: Bool { lock.withLock { attached } }
    }

    private final class BlockingExit: @unchecked Sendable {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var alive = true

        func isAlive() -> Bool { lock.withLock { alive } }

        func wait(_ apps: [LaunchedApp]) -> [LaunchedApp] {
            entered.signal()
            _ = release.wait(timeout: .now() + 5)
            lock.withLock { alive = false }
            return []
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

    /// A manager with a "slow" session whose only app blocks in its process-exit wait until
    /// `blockedExit.release` is signalled, plus a "ready" session with nothing to wait for.
    private func makeHarness() async throws -> (manager: SessionManager, blockedExit: BlockingExit) {
        let backing = DisplayBacking()
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 3,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let blockedExit = BlockingExit()
        let identity = ProcessIdentity(pid: 45_001, startedAtMicroseconds: 1)
        let app = LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.teardown-responsiveness",
            name: "Slow exit",
            url: URL(fileURLWithPath: "/Applications/Slow.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let driver = SessionAppTeardownDriver(
            isAlive: { _ in blockedExit.isAlive() },
            quit: { _, _ in },
            waitForExit: { apps, _ in
                apps.isEmpty ? [] : blockedExit.wait(apps)
            },
            cleanupTemporaryProfile: { _ in })
        let windows = SessionWindowDriver(
            windows: { _ in [] },
            userDisplayBounds: { nil },
            move: { _, _ in },
            liveBounds: { _ in nil })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            idleDisplayGraceNanoseconds: 0,
            retainedIdleDisplayCount: 0,
            sessionFactory: { id, slot in
                if id == "slow" {
                    return try AgentSession(
                        id: id,
                        slot: slot,
                        teardownDriver: driver,
                        windowDriver: windows,
                        initialApps: [app])
                }
                return try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: windows,
                    initialApps: [])
            })

        let slowCreated = await manager.handle(
            TestController.createRequest(session: "slow"))
        let readyCreated = await manager.handle(
            TestController.createRequest(session: "ready"))
        XCTAssertTrue(slowCreated.ok, slowCreated.error ?? "")
        XCTAssertTrue(readyCreated.ok, readyCreated.error ?? "")
        return (manager, blockedExit)
    }

    func testAnotherSessionRemainsResponsiveWhileTeardownWaitsForProcessExit() async throws {
        let (manager, blockedExit) = try await makeHarness()

        let destroyTask = Task {
            await manager.handle(TestController.request("session.destroy", session: "slow"))
        }
        XCTAssertEqual(blockedExit.entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1) {
            blockedExit.release.signal()
        }

        var listRequest = Request(cmd: "session.list")
        listRequest.operatorScope = true
        let duringTeardown = await manager.handle(listRequest)
        XCTAssertTrue(duringTeardown.ok, duringTeardown.error ?? "")
        XCTAssertEqual(
            duringTeardown.sessions?.first { $0.id == "slow" }?.teardownPending,
            true,
            "session.list must retain a stable cleanup-pending row while the worker runs")

        // The name being torn down is still taken; every other name is free. One agent's
        // slow app must not stop every other agent on the machine from getting a tile.
        let sameName = await manager.handle(TestController.createRequest(session: "slow"))
        XCTAssertFalse(sameName.ok)
        XCTAssertTrue(sameName.error?.contains("already exists") == true, sameName.error ?? "")
        let otherName = await manager.handle(
            TestController.createRequest(session: "during-teardown"))
        XCTAssertTrue(otherName.ok, otherName.error ?? "")

        // Reaping and detached recovery keep running for the sessions that are not fenced.
        let janitorPass = try await manager.runJanitorPass()
        XCTAssertEqual(janitorPass, 0)

        var latencies: [Duration] = []
        for _ in 0..<40 {
            let started = ContinuousClock.now
            let windows = await manager.handle(
                TestController.request("windows", session: "ready"))
            latencies.append(ContinuousClock.now - started)
            XCTAssertTrue(windows.ok, windows.error ?? "")
        }
        latencies.sort()
        let p99 = latencies[latencies.count - 1]
        XCTAssertLessThan(
            p99,
            .milliseconds(500),
            "p99 command latency on another session must not wait for the teardown worker")
        let destroyed = await destroyTask.value
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")

        for id in ["ready", "during-teardown"] {
            let cleanup = await manager.handle(
                TestController.request("session.destroy", session: id))
            XCTAssertTrue(cleanup.ok, cleanup.error ?? "")
        }
    }

    /// An operator's `daemon stop` (and the SIGTERM handler behind it) must wait for a
    /// teardown already in flight, not refuse. A refused stop is what turns a supervisor's
    /// SIGTERM into a SIGKILL, orphaning every other session's apps.
    func testDaemonStopWaitsForAnInFlightTeardown() async throws {
        let (manager, blockedExit) = try await makeHarness()

        let destroyTask = Task {
            await manager.handle(TestController.request("session.destroy", session: "slow"))
        }
        XCTAssertEqual(blockedExit.entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1) {
            blockedExit.release.signal()
        }

        var stop = Request(cmd: "daemon.stop")
        stop.operatorScope = true
        let started = ContinuousClock.now
        let stopped = await manager.handle(stop)
        let waited = ContinuousClock.now - started
        XCTAssertTrue(stopped.ok, stopped.error ?? "")
        XCTAssertGreaterThan(waited, .milliseconds(500), "stop must have waited for the worker")
        let destroyed = await destroyTask.value
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        let remaining = await manager.count
        XCTAssertEqual(remaining, 0)
        let afterStop = await manager.handle(Request(cmd: "ping"))
        XCTAssertFalse(afterStop.ok)
        XCTAssertTrue(afterStop.error?.contains("shutting down") == true)
    }
}
