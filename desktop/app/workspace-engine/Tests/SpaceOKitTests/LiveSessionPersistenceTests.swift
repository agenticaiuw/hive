import XCTest
import CoreGraphics
@testable import SpaceOKit

final class LiveSessionPersistenceTests: XCTestCase {
    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true

        init(displayID: CGDirectDisplayID) {
            self.displayID = displayID
        }

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        var isAttached: Bool { lock.withLock { attached } }
    }

    private final class LedgerMemory: @unchecked Sendable {
        struct InjectedFailure: Error {}

        private let lock = NSLock()
        private var ledger: SessionLedger?
        private var saveCount = 0
        private var failingSaveNumbers: Set<Int>
        /// Models a permanently unwritable ledger — a full disk or a mode-drifted directory —
        /// rather than a transient failure that a retry can clear.
        private let permanentlyFailingFromSaveNumber: Int?

        init(
            ledger: SessionLedger? = nil,
            failingSaveNumbers: Set<Int> = [],
            permanentlyFailingFromSaveNumber: Int? = nil
        ) {
            self.ledger = ledger
            self.failingSaveNumbers = failingSaveNumbers
            self.permanentlyFailingFromSaveNumber = permanentlyFailingFromSaveNumber
        }

        func load() -> SessionLedger? {
            lock.withLock { ledger }
        }

        func save(_ ledger: SessionLedger) throws {
            try lock.withLock {
                saveCount += 1
                if let boundary = permanentlyFailingFromSaveNumber, saveCount >= boundary {
                    throw InjectedFailure()
                }
                if failingSaveNumbers.remove(saveCount) != nil {
                    throw InjectedFailure()
                }
                self.ledger = ledger
            }
        }
    }

    /// Cross-task result slot for asserting that an operation finishes at all.
    private final class ResultBox<Value: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Value?

        func set(_ value: Value) { lock.withLock { stored = value } }
        var value: Value? { lock.withLock { stored } }
    }

    private final class AppState: @unchecked Sendable {
        private let lock = NSLock()
        private var alive = true
        private var quits = 0

        func isAlive() -> Bool { lock.withLock { alive } }
        func quit() {
            lock.withLock {
                quits += 1
                alive = false
            }
        }
        var quitCount: Int { lock.withLock { quits } }
    }

    private final class OneShotFailure: @unchecked Sendable {
        private let lock = NSLock()
        private var armed = true

        func throwOnce() throws {
            try lock.withLock {
                guard armed else { return }
                armed = false
                throw LedgerMemory.InjectedFailure()
            }
        }
    }

    private final class Observation: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false

        func set(_ value: Bool) {
            lock.withLock { self.value = value }
        }

        var observed: Bool {
            lock.withLock { value }
        }
    }

    private final class MaterializingFailureLauncher: SessionManager.SessionLaunching {
        private let materialized: LaunchedApp
        private let memory: LedgerMemory
        private let boundary: Observation

        init(
            materialized: LaunchedApp,
            memory: LedgerMemory,
            boundary: Observation
        ) {
            self.materialized = materialized
            self.memory = memory
            self.boundary = boundary
        }

        nonisolated(nonsending) func launch(
            session: AgentSession,
            appURL: URL,
            files: [URL],
            timeout: Double,
            allowNoWindows: Bool,
            arguments: [String],
            muteAudio: Bool,
            onMaterialized: SessionManager.MaterializedAppHandler
        ) async throws -> LaunchedApp {
            try session.registerMaterializedApp(materialized)
            try await onMaterialized(materialized)
            boundary.set(
                memory.load()?.sessions.first?.apps.map(\.identity)
                    == [materialized.identity])
            throw LedgerMemory.InjectedFailure()
        }
    }

    /// Materializes a process that survives the callback, so the post-effect reconciliation runs
    /// against a real surviving effect instead of a launch that already failed.
    private final class SurvivingMaterializationLauncher: SessionManager.SessionLaunching {
        private let materialized: LaunchedApp

        init(materialized: LaunchedApp) {
            self.materialized = materialized
        }

        nonisolated(nonsending) func launch(
            session: AgentSession,
            appURL: URL,
            files: [URL],
            timeout: Double,
            allowNoWindows: Bool,
            arguments: [String],
            muteAudio: Bool,
            onMaterialized: SessionManager.MaterializedAppHandler
        ) async throws -> LaunchedApp {
            try session.registerMaterializedApp(materialized)
            try await onMaterialized(materialized)
            return materialized
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
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        return DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate() })
    }

    private func persistence(_ memory: LedgerMemory) -> LiveSessionPersistence {
        LiveSessionPersistence(
            load: { memory.load() },
            save: { try memory.save($0) })
    }

    private func statePaths() throws -> (container: URL, root: URL) {
        let container = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "spaceo-live-persistence-\(UUID())",
                isDirectory: true)
        try FileManager.default.createDirectory(
            at: container,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        return (
            container,
            container.appendingPathComponent("state", isDirectory: true))
    }

    private func detachedRecord(
        id: String,
        at timestamp: Date
    ) -> DurableSessionRecord {
        DurableSessionRecord(
            id: id,
            revision: 4,
            createdAt: timestamp.addingTimeInterval(-20),
            updatedAt: timestamp,
            ownershipState: .abandoned,
            runtimeState: .detached,
            operationState: .cleanupPending,
            recoveryState: .notNeeded,
            abandonedAt: timestamp.addingTimeInterval(-10),
            reclaimableAfter: timestamp,
            lastActivityAt: timestamp.addingTimeInterval(-15))
    }

    private func makeApp(
        state: AppState
    ) throws -> (LaunchedApp, SessionAppTeardownDriver) {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.persistence-test",
            name: "Persistence Test",
            url: URL(fileURLWithPath: "/Applications/PersistenceTest.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let driver = SessionAppTeardownDriver(
            isAlive: { _ in state.isAlive() },
            quit: { _, _ in state.quit() },
            waitForExit: { apps, _ in state.isAlive() ? apps : [] },
            cleanupTemporaryProfile: { _ in })
        return (app, driver)
    }

    /// A launched app whose process never exits, so `rollbackUndurableApp` fails permanently —
    /// the launched-app analogue of an adopted window that refuses to move.
    private func makeSurvivingApp() throws -> (LaunchedApp, SessionAppTeardownDriver) {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.unreconciled-test",
            name: "Unreconciled Test",
            url: URL(fileURLWithPath: "/Applications/UnreconciledTest.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let driver = SessionAppTeardownDriver(
            isAlive: { _ in true },
            quit: { _, _ in },
            waitForExit: { apps, _ in apps },
            cleanupTemporaryProfile: { _ in })
        return (app, driver)
    }

    /// Await `operation`, reporting a failure rather than hanging the suite if it never finishes.
    /// A wedged daemon is exactly the regression these tests exist to catch, so it must surface
    /// as a failed assertion instead of a stalled test run.
    private func completed<Value: Sendable>(
        within seconds: TimeInterval,
        _ operation: @escaping @Sendable () async -> Value
    ) async -> Value? {
        let box = ResultBox<Value>()
        let task = Task { box.set(await operation()) }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let value = box.value { return value }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        task.cancel()
        return box.value
    }

    private func unreconciledReason(_ error: Error?) -> String? {
        guard let persistence = error as? LiveSessionPersistenceError,
              case .postEffectUnreconciled(let reason, _) = persistence else {
            return nil
        }
        return reason
    }

    func testCreateMergesLatestLedgerAndCleanupPrunesOnlyLiveRecord() async throws {
        let timestamp = Date()
        let detached = detachedRecord(id: "detached-existing", at: timestamp)
        let initial = SessionLedger(
            storeRevision: 9,
            writerDaemonInstanceID: UUID(),
            updatedAt: timestamp,
            nextAutomaticSessionNumber: 7,
            sessions: [detached])
        let memory = LedgerMemory(ledger: initial)
        let daemonID = UUID()
        let manager = try SessionManager(
            pool: makePool(displayID: 92_001),
            runJanitor: false,
            daemonInstanceID: daemonID,
            livePersistence: persistence(memory),
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let created = await manager.handle(TestController.createRequest())

        XCTAssertTrue(created.ok, created.error ?? "")
        XCTAssertEqual(created.session?.id, "agent-7")
        let afterCreate = try XCTUnwrap(memory.load())
        XCTAssertEqual(afterCreate.nextAutomaticSessionNumber, 8)
        XCTAssertEqual(
            afterCreate.sessions.first(where: { $0.id == detached.id }),
            detached)
        let live = try XCTUnwrap(
            afterCreate.sessions.first(where: { $0.id == "agent-7" }))
        XCTAssertEqual(live.runtimeState, .attached)
        XCTAssertEqual(live.operationState, .ready)
        XCTAssertEqual(live.lease?.daemonInstanceID, daemonID)
        XCTAssertEqual(live.lastActivityAt, live.lease?.lastHeartbeatAt)

        let destroyed = await manager.handle(TestController.request("session.destroy"))

        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        let afterDestroy = try XCTUnwrap(memory.load())
        XCTAssertEqual(afterDestroy.sessions, [detached])
        XCTAssertEqual(afterDestroy.nextAutomaticSessionNumber, 8)
        XCTAssertGreaterThan(afterDestroy.storeRevision, afterCreate.storeRevision)
    }

    func testCleanupPrepareFailureDoesNotSignalOwnedApp() async throws {
        let memory = LedgerMemory(failingSaveNumbers: [2])
        let state = AppState()
        let (app, driver) = try makeApp(state: state)
        let manager = try SessionManager(
            pool: makePool(displayID: 92_002),
            runJanitor: false,
            livePersistence: persistence(memory),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: [app])
            })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        let failed = await manager.handle(TestController.request("session.destroy"))

        XCTAssertFalse(failed.ok)
        XCTAssertEqual(state.quitCount, 0)
        let countAfterFailure = await manager.count
        XCTAssertEqual(countAfterFailure, 1)
        XCTAssertEqual(memory.load()?.sessions.first?.operationState, .ready)

        let retried = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(retried.ok, retried.error ?? "")
    }

    func testCleanupCommitFailureRetainsPendingMarkerAndLiveRetryOwnership() async throws {
        let memory = LedgerMemory(failingSaveNumbers: [3])
        let state = AppState()
        let (app, driver) = try makeApp(state: state)
        let manager = try SessionManager(
            pool: makePool(displayID: 92_003),
            runJanitor: false,
            livePersistence: persistence(memory),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: [app])
            })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        let failed = await manager.handle(TestController.request("session.destroy"))

        XCTAssertFalse(failed.ok)
        XCTAssertEqual(state.quitCount, 1)
        let countAfterFailure = await manager.count
        XCTAssertEqual(countAfterFailure, 1)
        let pending = try XCTUnwrap(memory.load()?.sessions.first)
        XCTAssertEqual(pending.operationState, .cleanupPending)
        XCTAssertEqual(pending.apps.map(\.identity), [app.identity])
        let retainedSession = try await manager.session("agent-1")
        XCTAssertTrue(retainedSession.apps.isEmpty)

        let retried = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(retried.ok, retried.error ?? "")
        XCTAssertTrue(memory.load()?.sessions.isEmpty == true)
    }

    func testPostEffectReconciliationDoesNotReturnUntilSurvivorIsDurable() async {
        var commitAttempts = 0
        var rollbackAttempts = 0
        var thrown: Error?

        do {
            try await DurablePostEffectReconciliation.run(
                commitPendingIdentity: {
                    commitAttempts += 1
                    if commitAttempts < 3 {
                        throw LedgerMemory.InjectedFailure()
                    }
                },
                rollbackEffect: {
                    rollbackAttempts += 1
                    return false
                },
                clearPreparedMarker: {
                    XCTFail("a surviving effect must not clear the prepared marker")
                },
                pauseBeforeRetry: {})
            XCTFail("the original persistence failure must still reach the caller")
        } catch {
            thrown = error
        }

        XCTAssertTrue(thrown is LedgerMemory.InjectedFailure)
        XCTAssertEqual(commitAttempts, 3)
        XCTAssertEqual(rollbackAttempts, 2)
    }

    func testPostEffectReconciliationMayReturnAfterRollbackRemovesEffect() async {
        var commitAttempts = 0
        var rollbackAttempts = 0
        var clearAttempts = 0
        var thrown: Error?

        do {
            try await DurablePostEffectReconciliation.run(
                commitPendingIdentity: {
                    commitAttempts += 1
                    throw LedgerMemory.InjectedFailure()
                },
                rollbackEffect: {
                    rollbackAttempts += 1
                    return true
                },
                clearPreparedMarker: {
                    clearAttempts += 1
                    throw LedgerMemory.InjectedFailure()
                },
                pauseBeforeRetry: {
                    XCTFail("a completed rollback must not retry")
                })
            XCTFail("the original persistence failure must still reach the caller")
        } catch {
            thrown = error
        }

        XCTAssertTrue(thrown is LedgerMemory.InjectedFailure)
        XCTAssertEqual(commitAttempts, 1)
        XCTAssertEqual(rollbackAttempts, 1)
        XCTAssertEqual(clearAttempts, 1)
    }

    func testPostEffectReconciliationStopsWhenTheRetryBudgetRunsOut() async {
        var commitAttempts = 0
        var rollbackAttempts = 0
        var pauses = 0
        var thrown: Error?

        do {
            try await DurablePostEffectReconciliation.run(
                limits: .init(commitRetries: 3, timeout: 3_600),
                commitPendingIdentity: {
                    commitAttempts += 1
                    throw LedgerMemory.InjectedFailure()
                },
                rollbackEffect: {
                    rollbackAttempts += 1
                    return false
                },
                clearPreparedMarker: {
                    XCTFail("a surviving effect must not clear the prepared marker")
                },
                pauseBeforeRetry: { pauses += 1 })
            XCTFail("exhausted reconciliation must not report success")
        } catch {
            thrown = error
        }

        // The first commit already failed before the loop, so the budget covers the retries only.
        XCTAssertEqual(commitAttempts, 4)
        XCTAssertEqual(rollbackAttempts, 3)
        XCTAssertEqual(pauses, 2)
        XCTAssertEqual(
            unreconciledReason(thrown),
            "the 3-attempt retry budget ran out")
    }

    func testPostEffectReconciliationStopsAtTheMonotonicDeadline() async {
        var readings: [UInt64] = [0, 5_000_000_000]
        var commitAttempts = 0
        var thrown: Error?

        do {
            try await DurablePostEffectReconciliation.run(
                limits: .init(commitRetries: 1_000, timeout: 2),
                now: { readings.isEmpty ? 5_000_000_000 : readings.removeFirst() },
                commitPendingIdentity: {
                    commitAttempts += 1
                    throw LedgerMemory.InjectedFailure()
                },
                rollbackEffect: { false },
                clearPreparedMarker: {
                    XCTFail("a surviving effect must not clear the prepared marker")
                },
                pauseBeforeRetry: {
                    XCTFail("an expired deadline must not pause for another retry")
                })
            XCTFail("exhausted reconciliation must not report success")
        } catch {
            thrown = error
        }

        XCTAssertEqual(commitAttempts, 2)
        XCTAssertEqual(
            unreconciledReason(thrown),
            "the 2.0-second monotonic deadline expired")
    }

    func testPostEffectReconciliationStopsWhenTheEnclosingTaskIsCancelled() async {
        let started = Observation()
        let box = ResultBox<String>()
        let task = Task {
            do {
                try await DurablePostEffectReconciliation.run(
                    limits: .init(commitRetries: .max, timeout: 3_600),
                    commitPendingIdentity: {
                        started.set(true)
                        throw LedgerMemory.InjectedFailure()
                    },
                    rollbackEffect: { false },
                    clearPreparedMarker: {},
                    pauseBeforeRetry: {
                        try await Task.sleep(nanoseconds: 5_000_000)
                    })
                box.set("returned without an error")
            } catch {
                box.set(self.unreconciledReason(error) ?? "\(error)")
            }
        }

        while !started.observed {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        task.cancel()
        await task.value

        XCTAssertEqual(box.value, "the operation was cancelled")
    }

    /// The P0 this bound exists for: a permanently unwritable ledger plus an effect that refuses
    /// to roll back used to spin forever on the actor while holding the process-wide operation
    /// gate, so every later request — including daemon shutdown — hung behind it.
    func testUnreconcilablePostEffectReleasesTheOperationGate() async throws {
        let memory = LedgerMemory(permanentlyFailingFromSaveNumber: 3)
        let (app, driver) = try makeSurvivingApp()
        let manager = try SessionManager(
            pool: makePool(displayID: 92_009),
            runJanitor: false,
            livePersistence: persistence(memory),
            sessionLauncher: SurvivingMaterializationLauncher(materialized: app),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: [])
            })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        let launch: Request = {
            var request = TestController.request("run")
            request.app = "TextEdit"
            return request
        }()
        let launched = await completed(within: 30) { await manager.handle(launch) }
        let failed = try XCTUnwrap(
            launched,
            "the launch must fail instead of wedging the daemon")
        XCTAssertFalse(failed.ok)

        let pinged = await completed(within: 10) {
            await manager.handle(Request(cmd: "ping"))
        }
        let ping = try XCTUnwrap(
            pinged,
            "the operation gate must be free once reconciliation gives up")
        XCTAssertTrue(ping.ok, ping.error ?? "")

        // Giving up keeps in-memory ownership and leaves the durable record cleanup-only, so
        // restart recovery still knows the session has an interrupted mutation to clean up.
        let retained = try await manager.session("agent-1")
        XCTAssertEqual(retained.apps.map(\.identity), [app.identity])
        XCTAssertEqual(
            memory.load()?.sessions.first?.operationState,
            .mutationPending)
    }

    func testMaterializedIdentityIsDurableBeforeLaterLaunchWorkFails() async throws {
        let memory = LedgerMemory()
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let materialized = LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.materialization-test",
            name: "Materialized Test",
            url: URL(fileURLWithPath: "/Applications/TextEdit.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let boundary = Observation()
        let manager = try SessionManager(
            pool: makePool(displayID: 92_005),
            runJanitor: false,
            livePersistence: persistence(memory),
            sessionLauncher: MaterializingFailureLauncher(
                materialized: materialized,
                memory: memory,
                boundary: boundary),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        var launch = TestController.request("run")
        launch.app = "TextEdit"
        let failed = await manager.handle(launch)

        XCTAssertFalse(failed.ok)
        XCTAssertTrue(
            boundary.observed,
            "the exact identity must be durable before later launch work resumes")
        let durable = try XCTUnwrap(memory.load()?.sessions.first)
        XCTAssertEqual(durable.operationState, .mutationPending)
        XCTAssertEqual(durable.apps.map(\.identity), [identity])
        XCTAssertEqual(durable.apps.first?.provenance, .launched)
        let retained = try await manager.session(durable.id)
        XCTAssertEqual(retained.apps.map(\.identity), [identity])
    }

    func testCreateReconcilesAnErrorThrownAfterAtomicReplacement() async throws {
        let path = try statePaths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let daemonID = UUID()
        let normalStore = try SessionStore(
            rootDirectory: path.root,
            namespace: "ambiguous-create")
        let recovery = try DetachedSessionRecovery.live(
            daemonInstanceID: daemonID)
        let coordinator = SessionRecoveryCoordinator(
            store: normalStore,
            recovery: recovery)
        _ = try coordinator.startup()
        let oneShot = OneShotFailure()
        let ambiguousStore = try SessionStore(
            rootDirectory: path.root,
            namespace: "ambiguous-create",
            beforeReplace: { _, _ in },
            afterReplace: { _ in try oneShot.throwOnce() })
        let manager = try SessionManager(
            pool: makePool(displayID: 92_006),
            runJanitor: false,
            sessionStore: ambiguousStore,
            recoveryCoordinator: coordinator,
            daemonInstanceID: daemonID)

        let created = await manager.handle(TestController.createRequest())

        XCTAssertTrue(created.ok, created.error ?? "")
        let liveCount = await manager.count
        XCTAssertEqual(liveCount, 1)
        let durable = try XCTUnwrap(normalStore.load()?.sessions.first)
        XCTAssertEqual(durable.id, created.session?.id)
        XCTAssertEqual(durable.runtimeState, .attached)
        XCTAssertEqual(durable.lease?.daemonInstanceID, daemonID)

        let destroyed = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    func testKeepAppsCommitFailureLeavesDurableReleaseIntent() async throws {
        let memory = LedgerMemory(failingSaveNumbers: [3])
        let state = AppState()
        let (app, driver) = try makeApp(state: state)
        let manager = try SessionManager(
            pool: makePool(displayID: 92_004),
            runJanitor: false,
            livePersistence: persistence(memory),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: [app])
            })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        var destroy = TestController.request("session.destroy")
        destroy.quitApps = false
        let failed = await manager.handle(destroy)

        XCTAssertFalse(failed.ok)
        XCTAssertTrue(state.isAlive())
        XCTAssertEqual(state.quitCount, 0)
        let pending = try XCTUnwrap(memory.load()?.sessions.first)
        XCTAssertEqual(pending.operationState, .cleanupPending)
        XCTAssertEqual(pending.cleanupDisposition, .releaseApps)
        XCTAssertEqual(pending.apps.first?.provenance, .launched)
    }
}
