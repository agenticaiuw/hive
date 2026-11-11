import XCTest
import CoreGraphics
@testable import SpaceOKit

/// A named `session.destroy --operator` is cross-controller resource reclamation, exactly like
/// the janitor's grace-period pass and strictly smaller than `session.destroy --all --operator`.
/// It must therefore work without the (possibly dead) owner's lease — otherwise an abandoned
/// session is immortal for precisely the person the flag exists for.
final class OperatorDestroyTests: XCTestCase {

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

    private func policy(clock: Clock, liveness: Liveness) -> SessionReclamationPolicy {
        SessionReclamationPolicy(
            defaultTTL: 10,
            gracePeriod: 5,
            now: { clock.now() },
            ownerIsAlive: { _ in liveness.get() })
    }

    private func owner() -> DurableSessionOwner {
        DurableSessionOwner(id: "controller", kind: .mcp, label: "Test Controller")
    }

    private func makeAbandonedSession(
        displayID: CGDirectDisplayID,
        clock: Clock,
        liveness: Liveness
    ) async throws -> (SessionManager, String, UUID) {
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: displayID),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock, liveness: liveness),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.session = "abandoned-repro"
        create.controllerOwner = owner()
        create.controllerLeaseID = leaseID
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")
        liveness.set(false)
        clock.advance(1)
        return (manager, try XCTUnwrap(created.session?.id), leaseID)
    }

    func testAbandonedDestroyNamesReclamationBoundaryAndOperatorEscape() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let (manager, id, leaseID) = try await makeAbandonedSession(
            displayID: 93_001, clock: clock, liveness: liveness)

        var destroy = Request(cmd: "session.destroy")
        destroy.session = id
        destroy.controllerLeaseID = leaseID
        let refused = await manager.handle(destroy)

        XCTAssertFalse(refused.ok)
        let message = refused.error ?? ""
        XCTAssertTrue(message.contains("abandoned"), message)
        XCTAssertTrue(
            message.contains("automatic reclamation in 5 s"),
            "the refusal must say when the janitor will act: \(message)")
        XCTAssertTrue(
            message.contains("--operator"),
            "the refusal must name the escape hatch: \(message)")
    }

    func testOperatorDestroysAbandonedSessionWithoutLease() async throws {
        let clock = Clock()
        let liveness = Liveness()
        let (manager, id, _) = try await makeAbandonedSession(
            displayID: 93_002, clock: clock, liveness: liveness)

        var destroy = Request(cmd: "session.destroy")
        destroy.session = id
        destroy.operatorScope = true
        let response = await manager.handle(destroy)

        XCTAssertTrue(response.ok, response.error ?? "")
        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertTrue((listed.sessions ?? []).isEmpty)
    }

    func testOperatorDestroyStillWorksBeforeAbandonment() async throws {
        // Consistency with `--all`: operator scope covers another controller's *live* session
        // too, so a stuck-but-not-yet-abandoned session is recoverable without guessing state.
        let clock = Clock()
        let liveness = Liveness()
        let leaseID = UUID()
        let manager = SessionManager(
            pool: makePool(displayID: 93_003),
            runJanitor: false,
            reclamationPolicy: policy(clock: clock, liveness: liveness),
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        var create = Request(cmd: "session.create")
        create.session = "live-foreign"
        create.controllerOwner = owner()
        create.controllerLeaseID = leaseID
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")

        var destroy = Request(cmd: "session.destroy")
        destroy.session = "live-foreign"
        destroy.operatorScope = true
        let response = await manager.handle(destroy)

        XCTAssertTrue(response.ok, response.error ?? "")
        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertTrue((listed.sessions ?? []).isEmpty)
    }
}
