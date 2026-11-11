import XCTest
@testable import SpaceOKit

final class SessionRecoveryCoordinatorTests: XCTestCase {
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
        private var exitOnQuit: Set<ProcessIdentity> = []
        private var quitCount = 0

        func add(_ identity: ProcessIdentity, exits: Bool = false) {
            lock.withLock {
                current[identity.pid] = identity
                if exits { exitOnQuit.insert(identity) }
            }
        }

        func identity(_ pid: pid_t) -> ProcessIdentity? {
            lock.withLock { current[pid] }
        }

        func quit(_ app: DurableSessionApp, force: Bool) {
            _ = force
            lock.withLock {
                quitCount += 1
                if exitOnQuit.contains(app.identity) {
                    current[app.identity.pid] = nil
                }
            }
        }

        func wait(_ apps: [DurableSessionApp], timeout: TimeInterval) -> [ProcessIdentity] {
            _ = timeout
            return lock.withLock {
                apps.compactMap {
                    current[$0.identity.pid] == $0.identity ? $0.identity : nil
                }
            }
        }

        var quits: Int { lock.withLock { quitCount } }
    }

    private final class ReplaceCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func failOnSecondReplacement() throws {
            try lock.withLock {
                count += 1
                if count == 2 { throw InjectedFailure() }
            }
        }
    }

    private struct InjectedFailure: Error {}

    private let start = Date(timeIntervalSince1970: 1_700_100_000)
    private let oldDaemon = UUID(uuidString: "40000000-0000-0000-0000-000000000004")!
    private let newDaemon = UUID(uuidString: "50000000-0000-0000-0000-000000000005")!

    private func paths() throws -> (container: URL, root: URL) {
        let container = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-recovery-coordinator-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(
            at: container,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        return (container, container.appendingPathComponent("state", isDirectory: true))
    }

    private func app(
        pid: pid_t = 601,
        startedAt: UInt64 = 60_001
    ) -> DurableSessionApp {
        DurableSessionApp(
            identity: ProcessIdentity(pid: pid, startedAtMicroseconds: startedAt),
            provenance: .launched,
            bundleIdentifier: "dev.spaceo.recovery",
            name: "Recovery App",
            url: URL(fileURLWithPath: "/Applications/Recovery.app"),
            devToolsPort: 49_001,
            temporaryProfile: URL(
                fileURLWithPath: "/private/tmp/spaceo-browser-recovery",
                isDirectory: true))
    }

    private func record(
        app: DurableSessionApp,
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
            owner: DurableSessionOwner(
                id: "prior-mcp",
                kind: .mcp,
                label: "Prior MCP"),
            lease: DurableSessionLease(
                daemonInstanceID: oldDaemon,
                leaseID: UUID(uuidString: "60000000-0000-0000-0000-000000000006")!,
                generation: 2,
                acquiredAt: start.addingTimeInterval(-90),
                lastHeartbeatAt: start.addingTimeInterval(-20),
                expiresAt: start.addingTimeInterval(280)),
            lastKnownPlacement: DurableSessionPlacement(
                displayID: 92_001,
                x: 100,
                y: 100,
                width: 1_280,
                height: 800,
                tileIndex: 0,
                tileCapacity: 1,
                exclusiveDisplay: true),
            apps: [app])
    }

    private func ledger(_ record: DurableSessionRecord) -> SessionLedger {
        SessionLedger(
            storeRevision: 1,
            writerDaemonInstanceID: oldDaemon,
            updatedAt: start,
            nextAutomaticSessionNumber: 2,
            sessions: [record])
    }

    private func recovery(
        daemonID: UUID? = nil,
        clock: TestClock,
        world: ProcessWorld
    ) throws -> DetachedSessionRecovery {
        DetachedSessionRecovery(
            daemonInstanceID: daemonID ?? newDaemon,
            policy: try DetachedSessionRecoveryPolicy(
                gracePeriod: 30,
                gracefulQuitTimeout: 0,
                forceQuitTimeout: 0),
            now: { clock.now() },
            currentIdentity: { world.identity($0) },
            quit: { world.quit($0, force: $1) },
            waitForExit: { world.wait($0, timeout: $1) })
    }

    func testStartupCreatesAndExposesAnEmptyLedger() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "empty")
        let clock = TestClock(start)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: ProcessWorld()),
            now: { clock.now() })

        let startup = try coordinator.startup()

        XCTAssertTrue(startup.ledger.sessions.isEmpty)
        XCTAssertEqual(startup.ledger.writerDaemonInstanceID, newDaemon)
        XCTAssertEqual(try coordinator.currentLedger(), startup.ledger)
        XCTAssertTrue(try coordinator.detachedRecords().isEmpty)
    }

    func testStartupFencesAndPersistsWhileRepeatedStartupPreservesGrace() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "startup")
        let durableApp = app()
        try store.save(ledger(record(app: durableApp)))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(durableApp.identity)
        let first = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })

        let initial = try first.startup()
        let fenced = try XCTUnwrap(initial.ledger.sessions.first)
        XCTAssertEqual(fenced.ownershipState, .abandoned)
        XCTAssertEqual(fenced.runtimeState, .detached)
        XCTAssertNil(fenced.lease)
        XCTAssertEqual(fenced.reclaimableAfter, start.addingTimeInterval(30))
        XCTAssertEqual(fenced.lastKnownPlacement?.displayID, 92_001)
        XCTAssertEqual(fenced.apps.first?.devToolsPort, 49_001)
        XCTAssertEqual(world.quits, 0)

        clock.advance(10)
        let laterDaemon = UUID(uuidString: "70000000-0000-0000-0000-000000000007")!
        let second = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(
                daemonID: laterDaemon,
                clock: clock,
                world: world),
            now: { clock.now() })
        let restarted = try second.startup()
        XCTAssertEqual(restarted.ledger.sessions.first?.reclaimableAfter,
                       start.addingTimeInterval(30),
                       "another restart must not extend the grace boundary")
        XCTAssertEqual(restarted.ledger.writerDaemonInstanceID, laterDaemon)
    }

    func testCorruptLedgerFailsClosedWithoutReplacement() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "corrupt")
        try store.save(ledger(record(app: app())))
        let corrupt = Data(#"{"schemaVersion":1,"sessions":"not-an-array"}"#.utf8)
        let handle = try FileHandle(forWritingTo: store.ledgerURL)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: corrupt)
        try handle.close()
        let clock = TestClock(start)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: ProcessWorld()),
            now: { clock.now() })

        XCTAssertThrowsError(try coordinator.startup()) { error in
            guard case SessionStoreError.corruptLedger = error else {
                return XCTFail("expected corruptLedger, got \(error)")
            }
        }
        XCTAssertEqual(try Data(contentsOf: store.ledgerURL), corrupt)
    }

    func testRecoveryPassDoesNotQuitBeforeGraceThenCleansAndPrunes() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "pass")
        let launched = app()
        try store.save(ledger(record(app: launched)))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(launched.identity, exits: true)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        _ = try coordinator.startup()

        let early = try coordinator.runRecoveryPass()
        XCTAssertEqual(early.transitions.first?.outcome.status, .gracePending)
        XCTAssertEqual(world.quits, 0)
        XCTAssertEqual(early.ledger.sessions.count, 1)

        clock.advance(31)
        let completed = try coordinator.runRecoveryPass()
        XCTAssertEqual(completed.transitions.first?.outcome.status, .cleanupComplete)
        XCTAssertEqual(completed.transitions.first?.pruned, true)
        XCTAssertEqual(world.quits, 1)
        XCTAssertTrue(completed.ledger.sessions.isEmpty)
        XCTAssertTrue(try coordinator.detachedRecords().isEmpty)
    }

    /// Detached recovery quits apps with nobody on the other end of a socket. It used to leave no
    /// trace at all: the janitor discarded the pass result and the recovery engine never logged.
    func testDetachedCleanupIsLoggedAnnouncedAndSummarizedByName() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "observable")
        let launched = app()
        try store.save(ledger(record(app: launched)))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(launched.identity, exits: true)
        let logURL = path.container.appendingPathComponent("daemon.log")
        let log = DaemonLog()
        try log.configure(fileURL: logURL)
        let bus = EventBus(capacity: 64)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() },
            log: log,
            events: bus)
        _ = try coordinator.startup()

        _ = try coordinator.runRecoveryPass()
        XCTAssertTrue(bus.replay(since: 0).events.isEmpty,
                      "a record still inside its grace is not an ending")
        let quietLog = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        _ = try coordinator.runRecoveryPass()
        XCTAssertEqual((try? String(contentsOf: logURL, encoding: .utf8)) ?? "", quietLog,
                       "an unchanged record must not log on every janitor tick")

        clock.advance(31)
        let cleaned = try coordinator.retryCleanup(sessionID: "agent-1")

        let summary = try XCTUnwrap(cleaned.summary)
        XCTAssertEqual(summary.reason, "detached_recovery")
        XCTAssertEqual(summary.quitApps, ["Recovery App"])
        XCTAssertEqual(summary.forcedApps, [])
        XCTAssertEqual(summary.profilesRemoved, 1)
        let destroyed = try XCTUnwrap(bus.replay(since: 0).events.last)
        XCTAssertEqual(destroyed.kind, "session.destroyed")
        XCTAssertEqual(destroyed.session, "agent-1")
        XCTAssertEqual(destroyed.detail["reason"], "detached_recovery")
        XCTAssertEqual(destroyed.detail["quit"], "Recovery App")
        let lines = try String(contentsOf: logURL, encoding: .utf8)
            .split(separator: "\n")
            .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String] }
        let entry = try XCTUnwrap(lines.last { $0["kind"] == "recovery.cleaned" })
        XCTAssertEqual(entry["session"], "agent-1")
        XCTAssertEqual(entry["terminated"], "Recovery App")
        XCTAssertEqual(entry["outcome"], "cleanupComplete")
        XCTAssertEqual(entry["pruned"], "true")
    }

    func testReleaseDispositionNeverTerminatesLiveLaunchedApp() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "release")
        let launched = app()
        var releasedRecord = record(app: launched, operation: .cleanupPending)
        releasedRecord.cleanupDisposition = .releaseApps
        try store.save(ledger(releasedRecord))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(launched.identity, exits: true)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        _ = try coordinator.startup()
        clock.advance(31)

        let completed = try coordinator.runRecoveryPass()

        XCTAssertEqual(completed.transitions.first?.outcome.status, .cleanupComplete)
        XCTAssertEqual(completed.transitions.first?.outcome.preservedAdopted,
                       [launched.identity])
        XCTAssertEqual(world.quits, 0)
        XCTAssertTrue(completed.ledger.sessions.isEmpty)
        XCTAssertEqual(world.identity(launched.identity.pid), launched.identity)
    }

    func testFailedPruneLeavesDurableCleanupCompleteForStartupRetry() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let normalStore = try SessionStore(rootDirectory: path.root, namespace: "prune")
        let launched = app()
        try normalStore.save(ledger(record(app: launched)))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(launched.identity, exits: true)
        let startupCoordinator = SessionRecoveryCoordinator(
            store: normalStore,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        _ = try startupCoordinator.startup()
        clock.advance(31)

        let counter = ReplaceCounter()
        let failingStore = try SessionStore(
            rootDirectory: path.root,
            namespace: "prune",
            beforeReplace: { _, _ in try counter.failOnSecondReplacement() })
        let failingCoordinator = SessionRecoveryCoordinator(
            store: failingStore,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        XCTAssertThrowsError(try failingCoordinator.retryCleanup(sessionID: "agent-1"))

        let durable = try XCTUnwrap(normalStore.load()?.sessions.first)
        XCTAssertEqual(durable.operationState, .cleanupComplete)
        XCTAssertTrue(durable.apps.isEmpty)

        let retry = SessionRecoveryCoordinator(
            store: normalStore,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        let recovered = try retry.startup()
        XCTAssertTrue(recovered.ledger.sessions.isEmpty)
        XCTAssertEqual(recovered.transitions.first?.pruned, true)
    }

    func testLaterPassPrunesCleanupCompleteWithoutWaitingForGrace() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "same-daemon-prune")
        let clock = TestClock(start)
        let world = ProcessWorld()
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        let empty = try coordinator.startup().ledger
        var complete = record(app: app(), operation: .cleanupComplete)
        complete.runtimeState = .detached
        complete.ownershipState = .abandoned
        complete.lease = nil
        complete.apps = []
        complete.abandonedAt = start
        complete.reclaimableAfter = start.addingTimeInterval(30)
        try store.save(SessionLedger(
            storeRevision: empty.storeRevision + 1,
            writerDaemonInstanceID: newDaemon,
            updatedAt: start,
            nextAutomaticSessionNumber: 2,
            sessions: [complete]))

        let pass = try coordinator.runRecoveryPass()

        XCTAssertTrue(pass.ledger.sessions.isEmpty)
        XCTAssertEqual(pass.transitions.first?.outcome.status, .cleanupComplete)
        XCTAssertEqual(pass.transitions.first?.pruned, true)
        XCTAssertEqual(world.quits, 0)
    }

    func testRecoveryPassSurfacesImpreciseIdentityBlocker() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "blocked")
        let imprecise = app(pid: 602, startedAt: 0)
        try store.save(ledger(record(app: imprecise)))
        let clock = TestClock(start)
        let world = ProcessWorld()
        world.add(imprecise.identity)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        _ = try coordinator.startup()
        clock.advance(31)

        let result = try coordinator.runRecoveryPass()

        XCTAssertEqual(result.transitions.first?.outcome.status, .cleanupPending)
        XCTAssertEqual(result.blockedRecords.first?.sessionID, "agent-1")
        XCTAssertEqual(
            result.blockedRecords.first?.blockers.first?.code,
            "imprecise_process_identity")
        XCTAssertEqual(result.ledger.sessions.first?.apps.first?.identity, imprecise.identity)
        XCTAssertEqual(world.quits, 0)
    }

    func testRecoveryPassNeverAssessesOrCleansAnAttachedLiveRecord() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "live-record")
        let clock = TestClock(start)
        let world = ProcessWorld()
        let launched = app()
        world.add(launched.identity, exits: true)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: try recovery(clock: clock, world: world),
            now: { clock.now() })
        let empty = try coordinator.startup().ledger
        let live = record(app: launched)
        try store.save(SessionLedger(
            storeRevision: empty.storeRevision + 1,
            writerDaemonInstanceID: newDaemon,
            updatedAt: start,
            nextAutomaticSessionNumber: 2,
            sessions: [live]))

        clock.advance(120)
        let pass = try coordinator.runRecoveryPass()

        XCTAssertTrue(pass.transitions.isEmpty)
        XCTAssertEqual(pass.ledger.sessions, [live])
        XCTAssertEqual(world.quits, 0)
        XCTAssertThrowsError(
            try coordinator.retryCleanup(sessionID: live.id)
        ) { error in
            XCTAssertEqual(
                error as? SessionRecoveryCoordinatorError,
                .sessionIsAttached(live.id))
        }
    }
}
