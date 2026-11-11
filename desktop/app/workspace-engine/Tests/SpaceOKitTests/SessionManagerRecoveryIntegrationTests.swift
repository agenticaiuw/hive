import CoreGraphics
import XCTest
@testable import SpaceOKit

final class SessionManagerRecoveryIntegrationTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Date

        init(_ value: Date) {
            self.value = value
        }

        func now() -> Date {
            lock.withLock { value }
        }

        func advance(_ seconds: TimeInterval) {
            lock.withLock { value = value.addingTimeInterval(seconds) }
        }
    }

    private final class ProcessWorld: @unchecked Sendable {
        private let lock = NSLock()
        private var identities: [pid_t: ProcessIdentity] = [:]
        private var quitCount = 0

        func add(_ identity: ProcessIdentity) {
            lock.withLock { identities[identity.pid] = identity }
        }

        func identity(for pid: pid_t) -> ProcessIdentity? {
            lock.withLock { identities[pid] }
        }

        func quit(_ app: DurableSessionApp) {
            lock.withLock {
                quitCount += 1
                identities[app.identity.pid] = nil
            }
        }

        func wait(_ apps: [DurableSessionApp]) -> [ProcessIdentity] {
            lock.withLock {
                apps.compactMap {
                    identities[$0.identity.pid] == $0.identity ? $0.identity : nil
                }
            }
        }

        var quits: Int {
            lock.withLock { quitCount }
        }
    }

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

    private let timestamp = Date(timeIntervalSince1970: 1_700_200_000)
    private let oldDaemon = UUID(
        uuidString: "81000000-0000-0000-0000-000000000001")!
    private let newDaemon = UUID(
        uuidString: "82000000-0000-0000-0000-000000000002")!

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

    private func paths() throws -> (container: URL, root: URL) {
        let container = FileManager.default.temporaryDirectory.appendingPathComponent(
            "spaceo-manager-recovery-\(UUID())",
            isDirectory: true)
        try FileManager.default.createDirectory(
            at: container,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        return (
            container,
            container.appendingPathComponent("state", isDirectory: true))
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

    private func durableApp(
        identity: ProcessIdentity = ProcessIdentity(
            pid: 62_001,
            startedAtMicroseconds: 620_001)
    ) -> DurableSessionApp {
        DurableSessionApp(
            identity: identity,
            provenance: .launched,
            bundleIdentifier: "dev.spaceo.manager-recovery",
            name: "Recovery App",
            url: URL(fileURLWithPath: "/Applications/Recovery.app"))
    }

    private func priorLedger(app: DurableSessionApp) -> SessionLedger {
        let owner = DurableSessionOwner(
            id: "prior-controller",
            kind: .mcp,
            label: "Prior MCP")
        let record = DurableSessionRecord(
            id: "orphan",
            revision: 1,
            createdAt: timestamp.addingTimeInterval(-120),
            updatedAt: timestamp.addingTimeInterval(-10),
            ownershipState: .owned,
            runtimeState: .attached,
            operationState: .ready,
            recoveryState: .notNeeded,
            lastActivityAt: timestamp.addingTimeInterval(-20),
            owner: owner,
            lease: DurableSessionLease(
                daemonInstanceID: oldDaemon,
                leaseID: UUID(
                    uuidString: "83000000-0000-0000-0000-000000000003")!,
                generation: 1,
                acquiredAt: timestamp.addingTimeInterval(-100),
                lastHeartbeatAt: timestamp.addingTimeInterval(-20),
                expiresAt: timestamp.addingTimeInterval(280)),
            lastKnownPlacement: DurableSessionPlacement(
                displayID: 77,
                x: 100,
                y: 50,
                width: 1_280,
                height: 800,
                tileIndex: 0,
                tileCapacity: 1,
                exclusiveDisplay: true),
            apps: [app])
        return SessionLedger(
            storeRevision: 1,
            writerDaemonInstanceID: oldDaemon,
            updatedAt: timestamp,
            nextAutomaticSessionNumber: 2,
            sessions: [record])
    }

    private func coordinator(
        store: SessionStore,
        clock: Clock,
        world: ProcessWorld
    ) throws -> SessionRecoveryCoordinator {
        let recovery = DetachedSessionRecovery(
            daemonInstanceID: newDaemon,
            policy: try DetachedSessionRecoveryPolicy(
                gracePeriod: 30,
                gracefulQuitTimeout: 0,
                forceQuitTimeout: 0),
            now: { clock.now() },
            currentIdentity: { world.identity(for: $0) },
            quit: { app, _ in world.quit(app) },
            waitForExit: { apps, _ in world.wait(apps) })
        return SessionRecoveryCoordinator(
            store: store,
            recovery: recovery,
            now: { clock.now() })
    }

    func testRestartedManagerListsDetachedAndStopsOnlyAfterRecovery() async throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "shutdown")
        let app = durableApp()
        try store.save(priorLedger(app: app))
        let clock = Clock(timestamp)
        let world = ProcessWorld()
        world.add(app.identity)
        let recovery = try coordinator(store: store, clock: clock, world: world)
        _ = try recovery.startup()
        let manager = try SessionManager(
            pool: makePool(displayID: 93_001),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon)

        let listed = await manager.handle(Request(cmd: "session.list"))
        let detached = try XCTUnwrap(listed.sessions?.first)
        XCTAssertEqual(detached.id, "orphan")
        XCTAssertEqual(detached.runtimeAttached, false)
        XCTAssertEqual(detached.controllerOwner?.id, "prior-controller")
        XCTAssertEqual(detached.lastActivityAt, timestamp.addingTimeInterval(-20))
        XCTAssertEqual(detached.reclaimable, false)

        var claim = Request(cmd: "session.claim")
        claim.session = "orphan"
        claim.controllerOwner = DurableSessionOwner(id: "new-controller", kind: .mcp, label: "New MCP")
        let refusedClaim = await manager.handle(claim)
        XCTAssertFalse(refusedClaim.ok)
        XCTAssertEqual(refusedClaim.errorCode, "session_detached")
        XCTAssertEqual(world.quits, 0)

        var paddedDestroy = Request(cmd: "session.destroy")
        paddedDestroy.session = " orphan "
        let paddedResponse = await manager.handle(paddedDestroy)
        XCTAssertFalse(paddedResponse.ok)
        XCTAssertTrue(paddedResponse.error?.contains("grace") == true)
        XCTAssertFalse(
            paddedResponse.error?.contains("no detached session") == true)

        let earlyStop = await manager.handle(Request(cmd: "daemon.stop"))
        XCTAssertFalse(earlyStop.ok)
        XCTAssertTrue(earlyStop.error?.contains("grace") == true)
        XCTAssertEqual(world.quits, 0)
        let stillServing = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(stillServing.ok, stillServing.error ?? "")

        clock.advance(31)
        let completedStop = await manager.handle(Request(cmd: "daemon.stop"))
        XCTAssertTrue(completedStop.ok, completedStop.error ?? "")
        XCTAssertEqual(world.quits, 1)
        XCTAssertTrue(try recovery.detachedRecords().isEmpty)
        let terminal = await manager.handle(Request(cmd: "ping"))
        XCTAssertFalse(terminal.ok)
        XCTAssertTrue(terminal.error?.contains("shutting down") == true)
    }

    /// A process signal cannot wait for a recovery grace boundary the way an interactive
    /// `daemon stop` can. The signal path asks to leave the records behind; they must survive
    /// on disk untouched, and nothing may be quit on their behalf.
    func testSignalStopLeavesDetachedRecordsForTheNextDaemon() async throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "signal-stop")
        let app = durableApp()
        try store.save(priorLedger(app: app))
        let clock = Clock(timestamp)
        let world = ProcessWorld()
        world.add(app.identity)
        let recovery = try coordinator(store: store, clock: clock, world: world)
        _ = try recovery.startup()
        let manager = try SessionManager(
            pool: makePool(displayID: 93_004),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon)

        var signalStop = Request(cmd: "daemon.stop")
        signalStop.operatorScope = true
        signalStop.leaveDetachedRecords = true
        let stopped = await manager.handle(signalStop)
        XCTAssertTrue(stopped.ok, stopped.error ?? "")
        XCTAssertTrue(stopped.message?.contains("orphan") == true, stopped.message ?? "")
        XCTAssertEqual(world.quits, 0, "a record inside its grace must not be acted on")
        XCTAssertEqual(try recovery.detachedRecords().map(\.id), ["orphan"])
        let terminal = await manager.handle(Request(cmd: "ping"))
        XCTAssertFalse(terminal.ok)
        XCTAssertTrue(terminal.error?.contains("shutting down") == true)
    }

    func testPersistentManagerRequiresCompletedMatchingRecoveryStartup() throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "startup-contract")
        let app = durableApp()
        try store.save(priorLedger(app: app))
        let clock = Clock(timestamp)
        let world = ProcessWorld()
        world.add(app.identity)
        let recovery = try coordinator(store: store, clock: clock, world: world)

        XCTAssertThrowsError(try SessionManager(
            pool: makePool(displayID: 93_004),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon
        )) { error in
            XCTAssertEqual(
                error as? SessionRecoveryCoordinatorError,
                .startupRequired)
        }

        _ = try recovery.startup()
        XCTAssertThrowsError(try SessionManager(
            pool: makePool(displayID: 93_005),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: UUID()
        )) { error in
            XCTAssertEqual(
                error as? SessionRecoveryCoordinatorError,
                .daemonInstanceMismatch)
        }

        let otherStore = try SessionStore(
            rootDirectory: path.root,
            namespace: "different-ledger")
        XCTAssertThrowsError(try SessionManager(
            pool: makePool(displayID: 93_006),
            runJanitor: false,
            sessionStore: otherStore,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon
        )) { error in
            XCTAssertEqual(
                error as? SessionRecoveryCoordinatorError,
                .ledgerMismatch)
        }
    }

    func testDetachedKeepAppsIsRejectedBeforeAnySignal() async throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "keep")
        let app = durableApp()
        try store.save(priorLedger(app: app))
        let clock = Clock(timestamp)
        let world = ProcessWorld()
        world.add(app.identity)
        let recovery = try coordinator(store: store, clock: clock, world: world)
        _ = try recovery.startup()
        clock.advance(31)
        let manager = try SessionManager(
            pool: makePool(displayID: 93_002),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon)

        var named = Request(cmd: "session.destroy")
        named.session = "orphan"
        named.quitApps = false
        let namedResponse = await manager.handle(named)
        XCTAssertFalse(namedResponse.ok)
        XCTAssertTrue(namedResponse.error?.contains("cannot be applied") == true)
        XCTAssertEqual(world.quits, 0)

        var all = Request(cmd: "session.destroy")
        all.full = true
        all.quitApps = false
        let allResponse = await manager.handle(all)
        XCTAssertFalse(allResponse.ok)
        XCTAssertTrue(allResponse.error?.contains("cannot be applied") == true)
        XCTAssertEqual(world.quits, 0)
        XCTAssertEqual(try recovery.detachedRecords().map(\.id), ["orphan"])
    }

    func testDetachedProcessIdentityCannotBeAdoptedByNewLiveSession() async throws {
        let path = try paths()
        defer { try? FileManager.default.removeItem(at: path.container) }
        let store = try SessionStore(rootDirectory: path.root, namespace: "reservation")
        let current = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = durableApp(identity: current)
        try store.save(priorLedger(app: app))
        let clock = Clock(timestamp)
        let world = ProcessWorld()
        world.add(current)
        let recovery = try coordinator(store: store, clock: clock, world: world)
        _ = try recovery.startup()
        let manager = try SessionManager(
            pool: makePool(displayID: 93_003),
            runJanitor: false,
            sessionStore: store,
            recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon)
        let created = await manager.handle(TestController.createRequest(session: "live"))
        XCTAssertTrue(created.ok, created.error ?? "")

        var adopt = TestController.request("adopt", session: "live")
        adopt.pid = current.pid
        let refused = await manager.handle(adopt)

        XCTAssertFalse(refused.ok)
        XCTAssertTrue(refused.error?.contains("reserved by detached session") == true)
        let cleanup = TestController.request("session.destroy", session: "live")
        let destroyed = await manager.handle(cleanup)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }
}
