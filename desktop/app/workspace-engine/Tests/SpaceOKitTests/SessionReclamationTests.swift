import XCTest
import CoreGraphics
@testable import SpaceOKit

final class SessionReclamationTests: XCTestCase {

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Date

        init(_ value: Date = Date(timeIntervalSince1970: 1_000)) {
            self.value = value
        }

        func now() -> Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) {
            lock.withLock { value = value.addingTimeInterval(seconds) }
        }
    }

    private final class Liveness: @unchecked Sendable {
        private let lock = NSLock()
        private var value = true

        func set(_ value: Bool) { lock.withLock { self.value = value } }
        func get() -> Bool { lock.withLock { value } }
    }

    private final class OneShot: @unchecked Sendable {
        private let lock = NSLock()
        private var available = true

        func take() -> Bool {
            lock.withLock {
                defer { available = false }
                return available
            }
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

    private final class QuitLog: @unchecked Sendable {
        private let lock = NSLock()
        private var alive = Set<ProcessIdentity>()
        private var quitValues: [ProcessIdentity] = []

        init(apps: [LaunchedApp]) {
            alive = Set(apps.map(\.identity))
        }

        func isAlive(_ identity: ProcessIdentity) -> Bool {
            lock.withLock { alive.contains(identity) }
        }

        func quit(_ app: LaunchedApp) {
            lock.withLock {
                quitValues.append(app.identity)
                alive.remove(app.identity)
            }
        }

        var quitIdentities: [ProcessIdentity] {
            lock.withLock { quitValues }
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
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    private func policy(
        clock: Clock,
        liveness: Liveness = Liveness(),
        ttl: TimeInterval = 10,
        grace: TimeInterval = 5
    ) -> SessionReclamationPolicy {
        SessionReclamationPolicy(
            defaultTTL: ttl,
            gracePeriod: grace,
            now: { clock.now() },
            ownerIsAlive: { _ in liveness.get() })
    }

    private func owner(_ id: String = "controller") -> DurableSessionOwner {
        DurableSessionOwner(
            id: id,
            kind: .mcp,
            label: "Test Controller")
    }

    func testCreateExposesMetadataButSessionInfoRedactsLeaseCredential() async throws {
        let clock = Clock()
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: 91_001),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.controllerOwner = owner()
        create.controllerLeaseID = leaseID

        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")
        XCTAssertEqual(created.controllerLeaseID, leaseID)
        XCTAssertEqual(created.session?.controllerOwner, owner())
        XCTAssertEqual(created.session?.ageSeconds, 0)
        XCTAssertEqual(
            created.session?.leaseExpiresAt,
            clock.now().addingTimeInterval(10))
        XCTAssertEqual(created.session?.abandoned, false)
        XCTAssertEqual(created.session?.reclaimable, false)

        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertNil(listed.controllerLeaseID)
        let encoded = try Wire.encoder.encode(listed)
        XCTAssertFalse(
            String(decoding: encoded, as: UTF8.self).contains(leaseID.uuidString),
            "observer-facing session metadata must not disclose the lease credential")

        let legacy = try Wire.decoder.decode(
            Request.self,
            from: Data(#"{"cmd":"ping"}"#.utf8))
        XCTAssertNil(legacy.controllerOwner)
        XCTAssertNil(legacy.controllerLeaseID)
        XCTAssertNil(legacy.controllerTTLSeconds)
    }

    func testClientRequestedTTLIsBoundedBeforeAllocatingResources() async {
        let clock = Clock()
        let manager = SessionManager(
            pool: makePool(displayID: 91_002),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var request = Request(cmd: "session.create")
        request.controllerOwner = owner()
        request.controllerTTLSeconds = 29

        let response = await manager.handle(request)

        XCTAssertFalse(response.ok)
        XCTAssertTrue(response.error?.contains("30 through 3600") == true)
        let displayCount = await manager.displayCount
        XCTAssertEqual(displayCount, 0)
    }

    func testDestroyAllKeepsJanitorRunningForFutureSessions() async {
        let clock = Clock()
        let manager = SessionManager(
            pool: makePool(displayID: 91_020),
            runJanitor: true,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        for _ in 0..<20 {
            if await manager.janitorIsRunning { break }
            await Task.yield()
        }
        let started = await manager.janitorIsRunning
        XCTAssertTrue(started)

        var destroyAll = Request(cmd: "session.destroy")
        destroyAll.full = true
        let response = await manager.handle(destroyAll)

        XCTAssertTrue(response.ok, response.error ?? "")
        let remainedRunning = await manager.janitorIsRunning
        XCTAssertTrue(
            remainedRunning,
            "destroying all current sessions must not disable future reclamation")
        await manager.stopJanitor()
    }

    func testReadOnlyCommandsDoNotRenewButHeartbeatDoes() async throws {
        let clock = Clock()
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: 91_003),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.controllerOwner = owner()
        create.controllerLeaseID = leaseID
        let created = await manager.handle(create)
        let originalExpiry = try XCTUnwrap(created.session?.leaseExpiresAt)
        let originalActivity = try XCTUnwrap(created.session?.lastActivityAt)

        clock.advance(4)
        var windows = Request(cmd: "windows")
        windows.controllerLeaseID = leaseID
        _ = await manager.handle(windows)
        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(listed.sessions?.first?.leaseExpiresAt, originalExpiry)
        XCTAssertEqual(listed.sessions?.first?.lastActivityAt, originalActivity)

        var heartbeat = Request(cmd: "session.heartbeat")
        heartbeat.controllerLeaseID = leaseID
        let renewed = await manager.handle(heartbeat)
        XCTAssertTrue(renewed.ok, renewed.error ?? "")
        XCTAssertEqual(
            renewed.session?.leaseExpiresAt,
            clock.now().addingTimeInterval(10))
        XCTAssertEqual(renewed.session?.lastActivityAt, clock.now())
    }

    func testExplicitControllerRequiresItsLeaseForEveryMutation() async throws {
        let clock = Clock()
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: 91_021),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.controllerOwner = owner("explicit-controller")
        create.controllerLeaseID = leaseID
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")

        var missing = Request(cmd: "repark")
        missing.session = try XCTUnwrap(created.session?.id)
        let refusedMissing = await manager.handle(missing)
        XCTAssertFalse(refusedMissing.ok)
        XCTAssertTrue(refusedMissing.error?.contains("lease is required") == true)

        var incorrect = missing
        incorrect.controllerLeaseID = UUID()
        let refusedIncorrect = await manager.handle(incorrect)
        XCTAssertFalse(refusedIncorrect.ok)
        XCTAssertTrue(refusedIncorrect.error?.contains("does not match") == true)

        var authorized = missing
        authorized.controllerLeaseID = leaseID
        let accepted = await manager.handle(authorized)
        XCTAssertTrue(accepted.ok, accepted.error ?? "")

        var missingDestroy = Request(cmd: "session.destroy")
        missingDestroy.session = try XCTUnwrap(created.session?.id)
        let refusedDestroy = await manager.handle(missingDestroy)
        XCTAssertFalse(refusedDestroy.ok)
        XCTAssertTrue(refusedDestroy.error?.contains("lease is required") == true)

        var authorizedDestroy = missingDestroy
        authorizedDestroy.controllerLeaseID = leaseID
        let destroyed = await manager.handle(authorizedDestroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    func testClockRollbackCannotRegressLeaseOrLastActivity() async throws {
        let clock = Clock()
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: 91_022),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.controllerOwner = owner("clock-controller")
        create.controllerLeaseID = leaseID
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")

        clock.advance(5)
        var heartbeat = Request(cmd: "session.heartbeat")
        heartbeat.session = created.session?.id
        heartbeat.controllerLeaseID = leaseID
        let forward = await manager.handle(heartbeat)
        let forwardActivity = try XCTUnwrap(forward.session?.lastActivityAt)
        let forwardExpiry = try XCTUnwrap(forward.session?.leaseExpiresAt)

        clock.advance(-20)
        let rolledBack = await manager.handle(heartbeat)

        XCTAssertTrue(rolledBack.ok, rolledBack.error ?? "")
        XCTAssertEqual(rolledBack.session?.lastActivityAt, forwardActivity)
        XCTAssertEqual(rolledBack.session?.leaseExpiresAt, forwardExpiry)

        var mutation = Request(cmd: "repark")
        mutation.session = created.session?.id
        mutation.controllerLeaseID = leaseID
        let mutationResponse = await manager.handle(mutation)
        XCTAssertTrue(mutationResponse.ok, mutationResponse.error ?? "")
        let afterMutation = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(afterMutation.sessions?.first?.lastActivityAt, forwardActivity)
        XCTAssertEqual(afterMutation.sessions?.first?.leaseExpiresAt, forwardExpiry)
    }

    func testExpiryBecomesAbandonedThenJanitorReclaimsAfterGrace() async throws {
        let clock = Clock()
        let manager = SessionManager(
            pool: makePool(displayID: 91_004),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok)

        clock.advance(10)
        let abandoned = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(abandoned.sessions?.first?.abandoned, true)
        XCTAssertEqual(abandoned.sessions?.first?.reclaimable, false)

        var mutation = Request(cmd: "repark")
        mutation.session = created.session?.id
        let refused = await manager.handle(mutation)
        XCTAssertFalse(refused.ok)
        XCTAssertTrue(refused.error?.contains("abandoned") == true)

        clock.advance(4)
        _ = try await manager.runJanitorPass()
        let beforeGraceCount = await manager.count
        XCTAssertEqual(beforeGraceCount, 1)

        clock.advance(1)
        _ = try await manager.runJanitorPass()
        let afterGraceCount = await manager.count
        XCTAssertEqual(afterGraceCount, 0)
    }

    func testDeadOwnerStartsGraceAtFirstObservation() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let manager = SessionManager(
            pool: makePool(displayID: 91_005),
            runJanitor: false,
            reclamationPolicy: policy(
                clock: clock,
                liveness: liveness,
                ttl: 100,
                grace: 5),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        _ = await manager.handle(TestController.createRequest())

        clock.advance(2)
        liveness.set(false)
        _ = try await manager.runJanitorPass()
        let abandoned = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(abandoned.sessions?.first?.abandoned, true)
        XCTAssertEqual(abandoned.sessions?.first?.reclaimable, false)

        clock.advance(5)
        _ = try await manager.runJanitorPass()
        let count = await manager.count
        XCTAssertEqual(count, 0)
    }

    func testAuthorizedMutationCrossingExpiryReportsSuccessAndRenews() async {
        let clock = Clock()
        let advanceOnce = OneShot()
        let manager = SessionManager(
            pool: makePool(displayID: 91_006),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock),
            successfulMutationHook: {
                if advanceOnce.take() { clock.advance(11) }
            },
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        var mutation = TestController.request("repark")
        mutation.session = created.session?.id

        let completed = await manager.handle(mutation)
        XCTAssertTrue(completed.ok, completed.error ?? "")
        let after = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(after.sessions?.first?.abandoned, false)
        XCTAssertEqual(
            after.sessions?.first?.leaseExpiresAt,
            clock.now().addingTimeInterval(10))

        clock.advance(11)
        let tooLate = await manager.handle(mutation)
        XCTAssertFalse(tooLate.ok)
        XCTAssertTrue(tooLate.error?.contains("abandoned") == true)
    }

    func testReclamationQuitsLaunchedAppButNeverAdoptedApp() async throws {
        let clock = Clock()
        let launchedIdentity = ProcessIdentity(
            pid: 61_001,
            startedAtMicroseconds: 1)
        let adoptedIdentity = ProcessIdentity(
            pid: 61_002,
            startedAtMicroseconds: 2)
        let launched = LaunchedApp(
            pid: launchedIdentity.pid,
            identity: launchedIdentity,
            bundleIdentifier: nil,
            name: "Launched",
            url: URL(fileURLWithPath: "/Applications/Launched.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
        let adopted = LaunchedApp(
            pid: adoptedIdentity.pid,
            identity: adoptedIdentity,
            bundleIdentifier: nil,
            name: "Adopted",
            url: URL(fileURLWithPath: "/Applications/Adopted.app"),
            startedByUs: false,
            devToolsPort: nil,
            temporaryProfile: nil)
        let apps = [launched, adopted]
        let quitLog = QuitLog(apps: apps)
        let driver = SessionAppTeardownDriver(
            isAlive: { quitLog.isAlive($0) },
            quit: { app, _ in quitLog.quit(app) },
            waitForExit: { waiting, _ in
                waiting.filter { quitLog.isAlive($0.identity) }
            },
            cleanupTemporaryProfile: { _ in })
        let manager = SessionManager(
            pool: makePool(displayID: 91_007),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock, ttl: 1, grace: 0),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: driver,
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: apps)
            })
        _ = await manager.handle(TestController.createRequest())

        clock.advance(1)
        _ = try await manager.runJanitorPass()

        XCTAssertEqual(quitLog.quitIdentities, [launchedIdentity])
        XCTAssertNil(ProcessOwnership.owner(of: launchedIdentity))
        XCTAssertNil(ProcessOwnership.owner(of: adoptedIdentity))
        let count = await manager.count
        XCTAssertEqual(count, 0)
    }
}
