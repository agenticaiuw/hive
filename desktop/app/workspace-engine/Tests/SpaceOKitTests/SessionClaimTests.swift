import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Sessions survive the ordinary accidents of agent life.
///
/// The accident this was built for, observed in an audit: an MCP client (Claude Code) restarts,
/// its stdio server exits at EOF, the janitor marks the session abandoned within ~3 s and quits
/// its apps ~30 s later — and the new conversation had no way to take the session back.
/// `session.claim` is that way. Idle time and `lease.expiring` are the matching observability:
/// a heartbeat keeps a lease alive but must not make a forgotten session look busy.
final class SessionClaimTests: XCTestCase {

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 5_000)
        func now() -> Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) {
            lock.withLock { value = value.addingTimeInterval(seconds) }
        }
    }

    /// Liveness per controller id, so the dead original and the live claimant can coexist.
    private final class Liveness: @unchecked Sendable {
        private let lock = NSLock()
        private var dead: Set<String> = []
        func kill(_ id: String) { lock.withLock { _ = dead.insert(id) } }
        func isAlive(_ owner: DurableSessionOwner) -> Bool { lock.withLock { !dead.contains(owner.id) } }
    }

    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        init(displayID: CGDirectDisplayID) { self.displayID = displayID }
        var valid: Bool { true }
        func invalidate() {}
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
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [displayID] })
        return DisplayPool(
            sessionsPerDisplay: 2,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    /// This test process: alive for the whole test, so the janitor's reaper keeps it.
    private func liveApp() throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.claim",
            name: "Claimed Editor", url: URL(fileURLWithPath: "/Applications/Claimed.app"),
            startedByUs: true, devToolsPort: nil, temporaryProfile: nil)
    }

    private func makeManager(
        displayID: CGDirectDisplayID,
        clock: Clock,
        liveness: Liveness,
        ttl: TimeInterval = 300,
        withApp: Bool = true
    ) throws -> SessionManager {
        let apps = withApp ? [try liveApp()] : []
        return SessionManager(
            pool: makePool(displayID: displayID),
            runJanitor: false,
            reclamationPolicy: SessionReclamationPolicy(
                defaultTTL: ttl, gracePeriod: 30,
                now: { clock.now() }, ownerIsAlive: { liveness.isAlive($0) }),
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(
                        isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: apps)
            })
    }

    private func owner(_ id: String, label: String) -> DurableSessionOwner {
        DurableSessionOwner(id: id, kind: .mcp, label: label)
    }

    private func create(
        _ manager: SessionManager, id: String, owner: DurableSessionOwner,
        grace: Double? = 120
    ) async throws -> UUID {
        var create = Request(cmd: "session.create")
        create.session = id
        create.controllerOwner = owner
        create.orphanGraceSeconds = grace
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")
        return try XCTUnwrap(created.controllerLeaseID)
    }

    private func claim(_ manager: SessionManager, id: String?, owner: DurableSessionOwner) async -> Response {
        var claim = Request(cmd: "session.claim")
        claim.session = id
        claim.controllerOwner = owner
        return await manager.handle(claim)
    }

    private func events(_ kind: String, session: String, since: UInt64) -> [DaemonEvent] {
        EventBus.shared.replay(since: since, limit: 4_096).events
            .filter { $0.kind == kind && $0.session == session }
    }

    // MARK: - Claim

    func testRestartedControllerClaimsAbandonedSessionAndKeepsItsApps() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let manager = try makeManager(displayID: 95_001, clock: clock, liveness: liveness)
        let original = owner("mcp-111", label: "Claude Code (before restart)")
        let oldLease = try await create(manager, id: "claim-kept", owner: original)
        let bus = EventBus.shared.latestSeq

        // The MCP process exits at EOF; the janitor observes it on its next pass.
        liveness.kill(original.id)
        clock.advance(3)
        _ = try await manager.runJanitorPass()
        clock.advance(3)
        let listed = await manager.handle(Request(cmd: "session.list"))
        let abandoned = try XCTUnwrap(listed.sessions?.first { $0.id == "claim-kept" })
        XCTAssertEqual(abandoned.abandoned, true)
        XCTAssertEqual(abandoned.orphanGraceSeconds, 120)
        XCTAssertEqual(abandoned.graceRemainingSeconds ?? -1, 117, accuracy: 0.001,
                       "session.list must say how long the session can still be claimed")

        let restarted = owner("mcp-222", label: "Claude Code (after restart)")
        let claimed = await claim(manager, id: "claim-kept", owner: restarted)

        XCTAssertTrue(claimed.ok, claimed.error ?? "")
        let newLease = try XCTUnwrap(claimed.controllerLeaseID)
        XCTAssertNotEqual(newLease, oldLease)
        XCTAssertEqual(claimed.session?.abandoned, false)
        XCTAssertEqual(claimed.session?.controllerOwner?.id, restarted.id)
        XCTAssertEqual(claimed.session?.apps.map(\.name), ["Claimed Editor"],
                       "a claim takes the session over; it must not cost the agent its apps")
        XCTAssertTrue(claimed.ambient?.contains {
            $0.contains("Claude Code (before restart)")
        } == true, "a different claimant must be told whose session it took: \(claimed.ambient ?? [])")
        XCTAssertEqual(events("session.claimed", session: "claim-kept", since: bus).count, 1)

        // The new lease works; the dead controller's lease never does again.
        var heartbeat = TestController.request("session.heartbeat", session: "claim-kept", leaseID: newLease)
        let renewed = await manager.handle(heartbeat)
        XCTAssertTrue(renewed.ok, renewed.error ?? "")
        heartbeat.controllerLeaseID = oldLease
        let stale = await manager.handle(heartbeat)
        XCTAssertFalse(stale.ok)

        // Past the original grace (but within the new lease), the janitor must leave a claimed
        // session alone.
        clock.advance(200)
        _ = try await manager.runJanitorPass()
        let after = await manager.handle(Request(cmd: "session.list"))
        XCTAssertNotNil(after.sessions?.first { $0.id == "claim-kept" })
    }

    func testSameControllerReclaimingItsOwnSessionGetsNoWarning() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let manager = try makeManager(displayID: 95_002, clock: clock, liveness: liveness, ttl: 30)
        let controller = owner("cli-stable", label: "Scripted agent")
        _ = try await create(manager, id: "claim-self", owner: controller)
        clock.advance(31)  // lease expiry abandons it just as process exit would

        let claimed = await claim(manager, id: "claim-self", owner: controller)

        XCTAssertTrue(claimed.ok, claimed.error ?? "")
        XCTAssertNil(claimed.warnings)
        XCTAssertNil(claimed.ambient)
    }

    func testClaimRefusesALiveOwnedSessionNamingItsOwner() async throws {
        let clock = Clock()
        let manager = try makeManager(displayID: 95_003, clock: clock, liveness: Liveness())
        _ = try await create(manager, id: "claim-live", owner: owner("mcp-live", label: "Busy agent"))
        clock.advance(4)

        let refused = await claim(manager, id: "claim-live", owner: owner("mcp-other", label: "Other"))

        XCTAssertFalse(refused.ok)
        XCTAssertTrue(refused.error?.contains("owned by Busy agent, active 4s ago") == true,
                      refused.error ?? "")
    }

    func testClaimRefusesAnAlreadyReclaimedSessionAndSaysWhatHappened() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let manager = try makeManager(displayID: 95_004, clock: clock, liveness: liveness)
        let original = owner("mcp-gone", label: "Gone agent")
        _ = try await create(manager, id: "claim-late", owner: original, grace: 30)
        liveness.kill(original.id)
        clock.advance(1)
        _ = try await manager.runJanitorPass()   // observes abandonment
        clock.advance(31)
        _ = try await manager.runJanitorPass()   // reclaims

        let refused = await claim(manager, id: "claim-late", owner: owner("mcp-new", label: "New"))

        XCTAssertFalse(refused.ok)
        let message = refused.error ?? ""
        XCTAssertTrue(message.contains("already ended"), message)
        XCTAssertTrue(message.contains("janitor_abandoned"), message)
    }

    func testClaimNeedsAnExplicitKnownSession() async throws {
        let manager = try makeManager(displayID: 95_005, clock: Clock(), liveness: Liveness())
        let unnamed = await claim(manager, id: nil, owner: owner("mcp-x", label: "X"))
        XCTAssertFalse(unnamed.ok)
        XCTAssertTrue(unnamed.error?.contains("explicit session id") == true, unnamed.error ?? "")

        let unknown = await claim(manager, id: "never-existed", owner: owner("mcp-x", label: "X"))
        XCTAssertEqual(unknown.errorCode, "unknown_session")
    }

    func testClaimIsNotLeaseScoped() {
        XCTAssertFalse(DaemonCommand.ownerScopedMutations.contains("session.claim"),
                       "a claim exists for the controller that lost its lease; demanding one defeats it")
        XCTAssertFalse(DaemonCommand.ownerScopedReads.contains("session.claim"))
        XCTAssertTrue(DaemonCommand.leaseIssuing.contains("session.claim"))
    }

    func testOrphanGraceIsBoundedAndDefaultsToTheDaemonGrace() async throws {
        let clock = Clock()
        let manager = try makeManager(displayID: 95_006, clock: clock, liveness: Liveness(), withApp: false)
        for invalid in [29.0, 1_801, .infinity] {
            var create = Request(cmd: "session.create")
            create.controllerOwner = owner("mcp-bounds", label: "Bounds")
            create.orphanGraceSeconds = invalid
            let refused = await manager.handle(create)
            XCTAssertFalse(refused.ok, "orphan grace \(invalid) must be refused")
        }
        _ = try await create(manager, id: "grace-default", owner: owner("mcp-d", label: "D"), grace: nil)
        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(listed.sessions?.first { $0.id == "grace-default" }?.orphanGraceSeconds, 30)
    }

    // MARK: - Idle time

    func testHeartbeatsRenewTheLeaseButDoNotHideIdleTime() async throws {
        let clock = Clock()
        let manager = try makeManager(displayID: 95_007, clock: clock, liveness: Liveness(), withApp: false)
        let lease = try await create(manager, id: "idle", owner: owner("mcp-idle", label: "Idle"))

        clock.advance(50)
        let beat = await manager.handle(TestController.request("session.heartbeat", session: "idle", leaseID: lease))
        XCTAssertTrue(beat.ok, beat.error ?? "")
        XCTAssertEqual(beat.session?.lastActivityAt, clock.now(),
                       "lastActivityAt keeps its compatible meaning and includes heartbeats")
        XCTAssertEqual(beat.session?.idleSeconds ?? -1, 50, accuracy: 0.001,
                       "a heartbeat is not the controller using its session")

        // An owner-scoped read is use.
        clock.advance(10)
        let read = await manager.handle(TestController.request("clipboard.get", session: "idle", leaseID: lease))
        XCTAssertTrue(read.ok, read.error ?? "")
        clock.advance(5)
        let listed = await manager.handle(Request(cmd: "session.list"))
        let info = try XCTUnwrap(listed.sessions?.first { $0.id == "idle" })
        XCTAssertEqual(info.idleSeconds ?? -1, 5, accuracy: 0.001)
        XCTAssertEqual(info.lastOwnerActionAt, clock.now().addingTimeInterval(-5))

        // So is an owner-scoped mutation; an operator action on the owner's behalf is not.
        var set = TestController.request("clipboard.set", session: "idle", leaseID: lease)
        set.text = "x"
        _ = await manager.handle(set)
        clock.advance(7)
        var annotate = Request(cmd: "session.annotate")
        annotate.session = "idle"
        annotate.operatorScope = true
        annotate.title = "renamed by the human"
        _ = await manager.handle(annotate)
        let later = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(later.sessions?.first { $0.id == "idle" }?.idleSeconds ?? -1, 7, accuracy: 0.001)
    }

    // MARK: - lease.expiring

    func testLeaseExpiringIsPublishedOnceAtEightyPercentOfTheTTL() async throws {
        let clock = Clock()
        let manager = try makeManager(displayID: 95_008, clock: clock, liveness: Liveness(),
                                      ttl: 100, withApp: false)
        let lease = try await create(manager, id: "expiring", owner: owner("mcp-e", label: "E"))
        let bus = EventBus.shared.latestSeq

        clock.advance(79)
        _ = try await manager.runJanitorPass()
        XCTAssertTrue(events("lease.expiring", session: "expiring", since: bus).isEmpty)

        clock.advance(2)
        _ = try await manager.runJanitorPass()
        _ = try await manager.runJanitorPass()
        let first = events("lease.expiring", session: "expiring", since: bus)
        XCTAssertEqual(first.count, 1, "one event per unrenewed lease, not one per janitor tick")
        XCTAssertEqual(first.first?.detail["secondsRemaining"], "19")
        XCTAssertEqual(first.first?.detail["ttlSeconds"], "100")

        // Renewal re-arms it for the next expiry.
        _ = await manager.handle(TestController.request("session.heartbeat", session: "expiring", leaseID: lease))
        clock.advance(85)
        _ = try await manager.runJanitorPass()
        XCTAssertEqual(events("lease.expiring", session: "expiring", since: bus).count, 2)
    }
}
