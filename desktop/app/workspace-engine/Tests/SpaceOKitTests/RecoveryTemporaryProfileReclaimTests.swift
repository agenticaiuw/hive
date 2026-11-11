import XCTest
@testable import SpaceOKit

/// A crashed daemon's private browser profile and Electron control root are only ever removed by
/// the recovery path that drops their app from the ledger. These tests hold that path shut.
final class RecoveryTemporaryProfileReclaimTests: XCTestCase {
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
        private let lock = NSLock()
        private var current: [pid_t: ProcessIdentity] = [:]

        func add(_ identity: ProcessIdentity) {
            lock.withLock { current[identity.pid] = identity }
        }

        func remove(_ pid: pid_t) {
            lock.withLock { current[pid] = nil }
        }

        func identity(_ pid: pid_t) -> ProcessIdentity? {
            lock.withLock { current[pid] }
        }

        func wait(_ apps: [DurableSessionApp]) -> [ProcessIdentity] {
            lock.withLock {
                apps.compactMap {
                    current[$0.identity.pid] == $0.identity ? $0.identity : nil
                }
            }
        }
    }

    /// Stands in for `AppLauncher.cleanupTemporaryProfileEventually`, which every other recovery
    /// test injects as a no-op.
    private final class CleanupSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var cleaned: [DurableSessionApp] = []

        func record(_ app: DurableSessionApp) {
            lock.withLock { cleaned.append(app) }
        }

        var apps: [DurableSessionApp] { lock.withLock { cleaned } }
        var identities: [ProcessIdentity] { apps.map(\.identity) }
    }

    private let start = Date(timeIntervalSince1970: 1_700_200_000)
    private let oldDaemon = UUID(uuidString: "70000000-0000-0000-0000-000000000007")!
    private let newDaemon = UUID(uuidString: "80000000-0000-0000-0000-000000000008")!

    private func paths() throws -> (container: URL, root: URL) {
        let container = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-profile-reclaim-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(
            at: container,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        return (container, container.appendingPathComponent("state", isDirectory: true))
    }

    private func browser(
        pid: pid_t = 900,
        startedAt: UInt64 = 90_001,
        provenance: DurableAppProvenance = .launched
    ) -> DurableSessionApp {
        DurableSessionApp(
            identity: ProcessIdentity(pid: pid, startedAtMicroseconds: startedAt),
            provenance: provenance,
            bundleIdentifier: "com.google.Chrome",
            name: "Google Chrome",
            url: URL(fileURLWithPath: "/Applications/Google Chrome.app"),
            devToolsPort: 49_100,
            temporaryProfile: URL(
                fileURLWithPath: "/private/tmp/spaceo-browser-\(pid)-profile",
                isDirectory: true),
            temporaryControlRoot: URL(
                fileURLWithPath: "/tmp/spaceo-e-\(pid)-control",
                isDirectory: true))
    }

    private func record(
        apps: [DurableSessionApp],
        operation: DurableSessionOperationState = .ready
    ) -> DurableSessionRecord {
        DurableSessionRecord(
            id: "agent-1",
            revision: 1,
            createdAt: start.addingTimeInterval(-100),
            updatedAt: start.addingTimeInterval(-10),
            ownershipState: .owned,
            runtimeState: .attached,
            operationState: operation,
            recoveryState: .notNeeded,
            owner: DurableSessionOwner(id: "prior-mcp", kind: .mcp, label: "Prior MCP"),
            lease: DurableSessionLease(
                daemonInstanceID: oldDaemon,
                leaseID: UUID(uuidString: "90000000-0000-0000-0000-000000000009")!,
                generation: 2,
                acquiredAt: start.addingTimeInterval(-90),
                lastHeartbeatAt: start.addingTimeInterval(-20),
                expiresAt: start.addingTimeInterval(280)),
            apps: apps)
    }

    private func recovery(
        clock: TestClock,
        world: ProcessWorld,
        spy: CleanupSpy
    ) throws -> DetachedSessionRecovery {
        DetachedSessionRecovery(
            daemonInstanceID: newDaemon,
            policy: try DetachedSessionRecoveryPolicy(
                gracePeriod: 30,
                gracefulQuitTimeout: 0,
                forceQuitTimeout: 0),
            now: { clock.now() },
            currentIdentity: { world.identity($0) },
            quit: { _, _ in },
            waitForExit: { apps, _ in world.wait(apps) },
            cleanupTemporaryProfile: { spy.record($0) })
    }

    /// The reported failure: the janitor assesses first, which drops the dead app and rewrites the
    /// ledger, so the cleanup that follows reads a record with no apps left to reclaim.
    func testJanitorPassReclaimsTheProfileOfAnAppThatDiedDuringGrace() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "janitor-leak")
        let chrome = browser()
        try store.save(SessionLedger(
            storeRevision: 1,
            writerDaemonInstanceID: oldDaemon,
            updatedAt: start,
            nextAutomaticSessionNumber: 2,
            sessions: [record(apps: [chrome])]))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(chrome.identity)
        let spy = CleanupSpy()
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world, spy: spy),
            now: { clock.now() })

        // A new daemon fences the crashed daemon's record, then the user quits the orphan.
        _ = try coordinator.startup()
        clock.advance(5)
        world.remove(chrome.identity.pid)
        clock.advance(30)

        let pass = try coordinator.runRecoveryPass()

        XCTAssertEqual(spy.identities, [chrome.identity])
        XCTAssertEqual(spy.apps.first?.temporaryProfile, chrome.temporaryProfile)
        XCTAssertEqual(spy.apps.first?.temporaryControlRoot, chrome.temporaryControlRoot)
        XCTAssertEqual(pass.transitions.first?.outcome.status, .cleanupComplete)
        XCTAssertEqual(pass.transitions.first?.pruned, true)
        XCTAssertTrue(pass.ledger.sessions.isEmpty)
    }

    func testAssessForReclaimReclaimsOnlyDroppedLaunchedApps() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let spy = CleanupSpy()
        let dead = browser(pid: 901, startedAt: 90_101)
        let recycled = browser(pid: 902, startedAt: 90_201)
        let live = browser(pid: 903, startedAt: 90_301)
        let adopted = browser(pid: 904, startedAt: 90_401, provenance: .adopted)
        world.add(ProcessIdentity(pid: 902, startedAtMicroseconds: 90_299))
        world.add(live.identity)
        var detached = record(apps: [dead, recycled, live, adopted])
        detached.runtimeState = .detached
        detached.ownershipState = .abandoned
        detached.lease = nil
        detached.abandonedAt = start
        detached.reclaimableAfter = start.addingTimeInterval(30)
        clock.advance(31)

        let result = try recovery(clock: clock, world: world, spy: spy)
            .assessForReclaim(detached)

        XCTAssertEqual(spy.identities, [dead.identity, recycled.identity])
        XCTAssertEqual(result.outcome.droppedDead, [dead.identity, adopted.identity])
        XCTAssertEqual(result.outcome.droppedRecycled, [recycled.identity])
        XCTAssertEqual(result.record.apps.map(\.identity), [live.identity])
    }

    /// A cleanup-pending record is assessed even before its grace boundary, so it drops dead apps
    /// on that earlier path too. Its private directories must be reclaimed there as well.
    func testAssessForReclaimReclaimsDuringGraceForACleanupPendingRecord() throws {
        let clock = TestClock(start)
        let world = ProcessWorld()
        let spy = CleanupSpy()
        let chrome = browser()
        var detached = record(apps: [chrome], operation: .cleanupPending)
        detached.runtimeState = .detached
        detached.ownershipState = .abandoned
        detached.lease = nil
        detached.abandonedAt = start
        detached.reclaimableAfter = start.addingTimeInterval(30)
        clock.advance(5)

        let result = try recovery(clock: clock, world: world, spy: spy)
            .assessForReclaim(detached)

        XCTAssertEqual(result.outcome.status, .cleanupOnly)
        XCTAssertEqual(spy.identities, [chrome.identity])
        XCTAssertTrue(result.record.apps.isEmpty)
    }
}
