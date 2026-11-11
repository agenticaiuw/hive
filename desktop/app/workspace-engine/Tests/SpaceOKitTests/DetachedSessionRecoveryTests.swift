import XCTest
@testable import SpaceOKit

final class DetachedSessionRecoveryTests: XCTestCase {
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Date

        init(_ value: Date) { self.value = value }
        func now() -> Date { lock.withLock { value } }
        func advance(_ interval: TimeInterval) {
            lock.withLock { value = value.addingTimeInterval(interval) }
        }
    }

    private final class ProcessWorld: @unchecked Sendable {
        struct QuitCall: Equatable {
            var identity: ProcessIdentity
            var force: Bool
        }

        private let lock = NSLock()
        private var current: [pid_t: ProcessIdentity] = [:]
        private var gracefulExits: Set<ProcessIdentity> = []
        private var forceExits: Set<ProcessIdentity> = []
        private var calls: [QuitCall] = []
        private var monotonicTime: UInt64 = 0

        func setCurrent(_ identity: ProcessIdentity) {
            lock.withLock { current[identity.pid] = identity }
        }

        func exitGracefully(_ identity: ProcessIdentity) {
            lock.withLock { _ = gracefulExits.insert(identity) }
        }

        func exitWhenForced(_ identity: ProcessIdentity) {
            lock.withLock { _ = forceExits.insert(identity) }
        }

        func identity(for pid: pid_t) -> ProcessIdentity? {
            lock.withLock { current[pid] }
        }

        func quit(_ app: DurableSessionApp, force: Bool) {
            lock.withLock {
                calls.append(QuitCall(identity: app.identity, force: force))
                let exits = force
                    ? forceExits.contains(app.identity)
                    : gracefulExits.contains(app.identity)
                if exits, current[app.identity.pid] == app.identity {
                    current[app.identity.pid] = nil
                }
            }
        }

        func wait(_ apps: [DurableSessionApp], timeout: TimeInterval) -> [ProcessIdentity] {
            ProcessExitWait.wait(apps, timeout: timeout, runtime: .init(
                now: { self.lock.withLock { self.monotonicTime } },
                sleep: { duration in self.lock.withLock { self.monotonicTime += duration } }
            )) { self.identity(for: $0.identity.pid) == $0.identity }.map(\.identity)
        }

        var quitCalls: [QuitCall] { lock.withLock { calls } }
    }

    private let oldDaemonID = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    private let newDaemonID = UUID(uuidString: "20000000-0000-0000-0000-000000000002")!
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    private func app(
        pid: pid_t,
        startedAt: UInt64,
        provenance: DurableAppProvenance
    ) -> DurableSessionApp {
        DurableSessionApp(
            identity: ProcessIdentity(pid: pid, startedAtMicroseconds: startedAt),
            provenance: provenance,
            bundleIdentifier: "dev.spaceo.test.\(pid)",
            name: "App \(pid)",
            url: URL(fileURLWithPath: "/Applications/App-\(pid).app"))
    }

    private func record(
        apps: [DurableSessionApp],
        operationState: DurableSessionOperationState = .ready
    ) -> DurableSessionRecord {
        let owner = DurableSessionOwner(
            id: "old-controller",
            kind: .mcp,
            label: "Old MCP")
        return DurableSessionRecord(
            id: "agent-1",
            revision: 1,
            createdAt: start.addingTimeInterval(-60),
            updatedAt: start.addingTimeInterval(-10),
            ownershipState: .owned,
            runtimeState: .attached,
            operationState: operationState,
            recoveryState: .notNeeded,
            owner: owner,
            lease: DurableSessionLease(
                daemonInstanceID: oldDaemonID,
                leaseID: UUID(uuidString: "30000000-0000-0000-0000-000000000003")!,
                generation: 4,
                acquiredAt: start.addingTimeInterval(-50),
                lastHeartbeatAt: start.addingTimeInterval(-20),
                expiresAt: start.addingTimeInterval(280)),
            lastKnownPlacement: DurableSessionPlacement(
                displayID: 91_001,
                x: 0,
                y: 0,
                width: 1_280,
                height: 800,
                tileIndex: 0,
                tileCapacity: 1,
                exclusiveDisplay: true),
            apps: apps)
    }

    private func harness(
        clock: TestClock,
        world: ProcessWorld
    ) throws -> DetachedSessionRecovery {
        DetachedSessionRecovery(
            daemonInstanceID: newDaemonID,
            policy: try DetachedSessionRecoveryPolicy(
                gracePeriod: 30,
                gracefulQuitTimeout: 2,
                forceQuitTimeout: 1),
            now: { clock.now() },
            currentIdentity: { world.identity(for: $0) },
            quit: { world.quit($0, force: $1) },
            waitForExit: { world.wait($0, timeout: $1) })
    }

    private func fenced(
        _ record: DurableSessionRecord,
        recovery: DetachedSessionRecovery
    ) throws -> DurableSessionRecord {
        try recovery.fenceLoadedRecord(record).record
    }

    func testLoadedRecordIsFencedAndGracePreventsCleanup() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let launched = app(pid: 101, startedAt: 1_001, provenance: .launched)
        world.setCurrent(launched.identity)
        let recovery = try harness(clock: clock, world: world)

        let fencedResult = try recovery.fenceLoadedRecord(record(apps: [launched]))
        XCTAssertEqual(fencedResult.record.ownershipState, .abandoned)
        XCTAssertEqual(fencedResult.record.runtimeState, .detached)
        XCTAssertNil(fencedResult.record.lease)
        XCTAssertEqual(fencedResult.record.abandonedAt, start)
        XCTAssertEqual(fencedResult.record.reclaimableAfter, start.addingTimeInterval(30))
        XCTAssertEqual(fencedResult.outcome.fencedDaemonInstanceID, oldDaemonID)
        XCTAssertEqual(fencedResult.outcome.status, .gracePending)

        let cleanup = try recovery.cleanup(fencedResult.record)
        XCTAssertEqual(cleanup.outcome.status, .gracePending)
        XCTAssertEqual(cleanup.record.apps.map(\.identity), [launched.identity])
        XCTAssertTrue(world.quitCalls.isEmpty)
        XCTAssertEqual(cleanup.record.lastKnownPlacement?.displayID, 91_001)
    }

    func testExactLiveLaunchedAppIsQuitAfterGrace() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let launched = app(pid: 102, startedAt: 1_002, provenance: .launched)
        world.setCurrent(launched.identity)
        world.exitGracefully(launched.identity)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [launched]), recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)

        XCTAssertEqual(result.outcome.status, .cleanupComplete)
        XCTAssertEqual(result.outcome.gracefulQuitRequested, [launched.identity])
        XCTAssertTrue(result.outcome.forceQuitRequested.isEmpty)
        XCTAssertEqual(result.outcome.terminatedLaunched, [launched.identity])
        XCTAssertTrue(result.record.apps.isEmpty)
        XCTAssertTrue(result.outcome.recordMayBeRemoved)
    }

    func testSurvivingLaunchedAppIsRetainedAndCanBeRetried() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let launched = app(pid: 103, startedAt: 1_003, provenance: .launched)
        world.setCurrent(launched.identity)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [launched]), recovery: recovery)
        clock.advance(31)

        let first = try recovery.cleanup(loaded)
        XCTAssertEqual(first.outcome.status, .cleanupPending)
        XCTAssertEqual(first.outcome.forceQuitRequested, [launched.identity])
        XCTAssertEqual(first.record.apps.map(\.identity), [launched.identity])
        XCTAssertEqual(first.record.operationState, .cleanupPending)

        world.exitGracefully(launched.identity)
        let retry = try recovery.cleanup(first.record)
        XCTAssertEqual(retry.outcome.status, .cleanupComplete)
        XCTAssertTrue(retry.record.apps.isEmpty)
    }

    func testPersonalAgentWorkspaceNeverQuitsLaunchedAppsDuringRecovery() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let launched = app(pid: 704, startedAt: 1_704, provenance: .launched)
        world.setCurrent(launched.identity)
        let recovery = try harness(clock: clock, world: world)
        var original = record(apps: [launched])
        original.id = "personal-agent-workspace"
        let loaded = try fenced(original, recovery: recovery)
        clock.advance(31)
        let result = try recovery.cleanup(loaded)
        XCTAssertTrue(world.quitCalls.isEmpty)
        XCTAssertEqual(world.identity(for: launched.identity.pid), launched.identity)
        XCTAssertEqual(result.outcome.preservedAdopted, [launched.identity])
    }

    func testLiveAdoptedAppIsReleasedWithoutTermination() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let adopted = app(pid: 104, startedAt: 1_004, provenance: .adopted)
        world.setCurrent(adopted.identity)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [adopted]), recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)

        XCTAssertEqual(result.outcome.preservedAdopted, [adopted.identity])
        XCTAssertTrue(world.quitCalls.isEmpty)
        XCTAssertEqual(world.identity(for: adopted.identity.pid), adopted.identity)
        XCTAssertTrue(result.record.apps.isEmpty)
    }

    func testDeadAppIsDroppedWithoutTermination() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let dead = app(pid: 105, startedAt: 1_005, provenance: .launched)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [dead]), recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)

        XCTAssertEqual(result.outcome.droppedDead, [dead.identity])
        XCTAssertTrue(world.quitCalls.isEmpty)
        XCTAssertTrue(result.record.apps.isEmpty)
    }

    func testRecycledIdentityIsTreatedAsDeadWithoutTermination() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let stale = app(pid: 106, startedAt: 1_006, provenance: .launched)
        world.setCurrent(ProcessIdentity(pid: 106, startedAtMicroseconds: 9_999))
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [stale]), recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)

        XCTAssertEqual(result.outcome.droppedRecycled, [stale.identity])
        XCTAssertTrue(world.quitCalls.isEmpty)
        XCTAssertTrue(result.record.apps.isEmpty)
    }

    func testImpreciseLaunchedIdentityBlocksDestructiveCleanup() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let imprecise = app(pid: 107, startedAt: 0, provenance: .launched)
        world.setCurrent(imprecise.identity)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(record(apps: [imprecise]), recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)

        XCTAssertEqual(result.outcome.status, .cleanupPending)
        XCTAssertEqual(result.record.apps.map(\.identity), [imprecise.identity])
        XCTAssertEqual(result.outcome.blockers.first?.code, "imprecise_process_identity")
        XCTAssertTrue(world.quitCalls.isEmpty)
    }

    func testMixedRecordReportsEveryDispositionAndCleanupPendingStaysCleanupOnly() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let dead = app(pid: 108, startedAt: 1_008, provenance: .launched)
        let recycled = app(pid: 109, startedAt: 1_009, provenance: .launched)
        let adopted = app(pid: 110, startedAt: 1_010, provenance: .adopted)
        let graceful = app(pid: 111, startedAt: 1_011, provenance: .launched)
        let forced = app(pid: 112, startedAt: 1_012, provenance: .launched)
        world.setCurrent(ProcessIdentity(pid: 109, startedAtMicroseconds: 8_888))
        world.setCurrent(adopted.identity)
        world.setCurrent(graceful.identity)
        world.setCurrent(forced.identity)
        world.exitGracefully(graceful.identity)
        world.exitWhenForced(forced.identity)
        let recovery = try harness(clock: clock, world: world)
        let loaded = try fenced(
            record(apps: [dead, recycled, adopted, graceful, forced]),
            recovery: recovery)
        clock.advance(31)

        let result = try recovery.cleanup(loaded)
        XCTAssertEqual(result.outcome.droppedDead, [dead.identity])
        XCTAssertEqual(result.outcome.droppedRecycled, [recycled.identity])
        XCTAssertEqual(result.outcome.preservedAdopted, [adopted.identity])
        XCTAssertEqual(result.outcome.forceQuitRequested, [forced.identity])
        XCTAssertEqual(result.outcome.status, .cleanupComplete)

        let pending = try fenced(
            record(apps: [adopted], operationState: .cleanupPending),
            recovery: recovery)
        let assessment = try recovery.assessForReclaim(pending)
        XCTAssertEqual(assessment.outcome.status, .cleanupOnly)
        XCTAssertNotEqual(assessment.record.recoveryState, .reclaimable)
        XCTAssertTrue(world.quitCalls.allSatisfy { $0.identity != adopted.identity })
    }
}
