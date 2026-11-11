import XCTest
import CoreGraphics
@testable import SpaceOKit

/// A leaked virtual display has to keep naming itself.
///
/// Teardown verification is the load-bearing claim of `ARCHITECTURE.md` §3.1, and it is only
/// worth anything if a failure reports *which* display stayed attached. The shim zeroes its
/// display id the moment `invalidate()` is called — before the WindowServer has detached
/// anything — so every id read after a failed retirement used to come back as `0`: nothing an
/// operator can act on, and nothing that survives being intersected with the online display
/// list. The leak was reported and then silently discarded on the next read.
final class DisplayIdentityAfterTeardownTests: XCTestCase {

    /// Reproduces `SPOVirtualDisplay.invalidate`: the id is dropped unconditionally, whether or
    /// not the display actually left the display graph.
    private final class StuckDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        private let lock = NSLock()
        private var currentDisplayID: CGDirectDisplayID
        private var attempts = 0
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)

        init(id: CGDirectDisplayID) {
            currentDisplayID = id
        }

        var displayID: CGDirectDisplayID { lock.withLock { currentDisplayID } }
        var valid: Bool { lock.withLock { currentDisplayID != 0 } }
        var attemptCount: Int { lock.withLock { attempts } }

        func invalidate() {
            lock.withLock {
                attempts += 1
                currentDisplayID = 0
            }
        }
    }

    /// A display the WindowServer keeps attached forever, as observed on the macOS 27 host.
    private func makeStuckStage(
        id: CGDirectDisplayID
    ) -> (stage: Stage, backing: StuckDisplayBacking) {
        let backing = StuckDisplayBacking(id: id)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [id] })
        return (stage, backing)
    }

    private func makeStuckPool(
        id: CGDirectDisplayID
    ) -> (pool: DisplayPool, backing: StuckDisplayBacking) {
        let stuck = makeStuckStage(id: id)
        let pool = DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: stuck.backing.bounds.size,
            stageFactory: { _, _, _, _ in stuck.stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return (pool, stuck.backing)
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

    func testStageKeepsNamingItsDisplayAfterAFailedInvalidation() {
        let stuck = makeStuckStage(id: 91_001)
        XCTAssertEqual(stuck.stage.displayID, 91_001)

        XCTAssertFalse(
            stuck.stage.invalidate(waitingForRemoval: 0),
            "the display never leaves the online list, so retirement must fail")

        XCTAssertEqual(
            stuck.stage.displayID, 91_001,
            "a failed retirement must still name the display it leaked")
        XCTAssertFalse(stuck.stage.isValid, "the stage no longer owns a usable display")

        // A retained failure is retried by a later cleanup pass; the id has to survive that too.
        XCTAssertFalse(stuck.stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(stuck.stage.displayID, 91_001)
        XCTAssertGreaterThanOrEqual(stuck.backing.attemptCount, 2)
    }

    func testRetireEmptyDisplaysReportsTheLeakedDisplayIDAcrossRepeatedPasses() throws {
        let stuck = makeStuckPool(id: 91_002)
        let slot = try stuck.pool.allocate()
        XCTAssertTrue(stuck.pool.release(slot, retainEmpty: true))

        XCTAssertEqual(
            stuck.pool.retireEmptyDisplays(), [91_002],
            "a display that refused to retire must be named, not reported as 0")
        XCTAssertEqual(stuck.pool.displayCount, 1, "the failed display stays owned for retry")

        // The second pass is where reading the id back through the backing is doubly wrong:
        // the previous attempt already zeroed it, so even capturing before `retire()` would
        // report 0 here.
        XCTAssertEqual(stuck.pool.retireEmptyDisplays(), [91_002])
        XCTAssertGreaterThanOrEqual(stuck.backing.attemptCount, 2)
    }

    func testReleaseAllReportsTheLeakedDisplayIDAcrossRepeatedPasses() throws {
        let stuck = makeStuckPool(id: 91_003)
        _ = try stuck.pool.allocate()

        XCTAssertEqual(stuck.pool.releaseAll(), [91_003])
        XCTAssertEqual(stuck.pool.displayCount, 1)
        XCTAssertEqual(stuck.pool.releaseAll(), [91_003])
    }

    func testFailedRetirementIsRetainedForCleanupButNeverReallocated() throws {
        let first = makeStuckStage(id: 91_006)
        let second = makeStuckStage(id: 91_007)
        var creations = 0
        let pool = DisplayPool(
            sessionsPerDisplay: 1,
            stageFactory: { _, _, _, _ in
                creations += 1
                return creations == 1 ? first.stage : second.stage
            },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        defer { pool.releaseAll() }
        let original = try pool.allocate()
        XCTAssertFalse(pool.release(original))
        XCTAssertFalse(original.stage.isValid)

        let next = try pool.allocate()
        XCTAssertTrue(next.stage.isValid)
        XCTAssertEqual(next.stage.displayID, 91_007)
        XCTAssertEqual(creations, 2)
        XCTAssertEqual(pool.displayCount, 2, "the failed display still needs cleanup")
        XCTAssertEqual(pool.report().first { $0.displayID == 91_006 }?.used, 0)
    }

    /// The end of the chain the bug broke: `destroy --all` records the failure, and the very
    /// next read prunes recorded failures against the online display list. An id of `0` is
    /// never online, so the leak used to be dropped before anyone could see it.
    func testRecordedTeardownFailureSurvivesPruningAndIsReportedByPing() async throws {
        let stuck = makeStuckPool(id: 91_004)
        let manager = SessionManager(
            pool: stuck.pool,
            runJanitor: false,
            onlineDisplayIDs: { [91_004] },
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        var destroyAll = TestController.request("session.destroy")
        destroyAll.full = true
        let teardown = await manager.handle(destroyAll)
        XCTAssertFalse(teardown.ok)
        XCTAssertEqual(
            teardown.teardown?.stillAttachedDisplayIDs, [91_004],
            "the CLI has to print a display id the user can act on")

        let ping = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(ping.ok, ping.error ?? "")
        let message = try XCTUnwrap(ping.message)
        XCTAssertTrue(
            message.contains("failed display teardown: [91004]"),
            "the leak must still be reported on the next read, got: \(message)")
    }

    /// Guard the pruning itself: once the display really is gone, the failure must clear.
    func testRecordedTeardownFailureClearsOnceTheDisplayLeavesTheOnlineList() async throws {
        let stuck = makeStuckPool(id: 91_005)
        let manager = SessionManager(
            pool: stuck.pool,
            runJanitor: false,
            onlineDisplayIDs: { [] },
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")
        var destroyAll = TestController.request("session.destroy")
        destroyAll.full = true
        let teardown = await manager.handle(destroyAll)
        XCTAssertEqual(teardown.teardown?.stillAttachedDisplayIDs, [91_005])

        let ping = await manager.handle(Request(cmd: "ping"))
        let message = try XCTUnwrap(ping.message)
        XCTAssertFalse(
            message.contains("failed display teardown"),
            "a display that is no longer online is not a live failure, got: \(message)")
    }
}
