import XCTest
import CoreGraphics
@testable import SpaceOKit

/// SPAO-147: leases fence *coordination* between cooperating clients of one daemon. A second
/// client must not be able to read, screenshot, or destroy the first client's session, and
/// commands whose blast radius crosses controller boundaries need explicit operator scope.
final class LeaseAuthorizationTests: XCTestCase {

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

    private func makeManager(
        displayID: CGDirectDisplayID,
        sessionsPerDisplay: Int = 2
    ) -> SessionManager {
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: sessionsPerDisplay,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return SessionManager(
            pool: pool,
            runJanitor: false,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
    }

    private func createSession(
        _ manager: SessionManager,
        name: String,
        ownerID: String,
        leaseID: UUID
    ) async throws {
        let response = await manager.handle(
            TestController.createRequest(
                session: name, ownerID: ownerID, leaseID: leaseID))
        XCTAssertTrue(response.ok, response.error ?? "")
    }

    func testSocketCreateWithoutControllerOwnerIsRefused() async {
        let manager = makeManager(displayID: 95_001)
        let response = await manager.handle(Request(cmd: "session.create"))
        XCTAssertFalse(
            response.ok,
            "the lease-omitting legacy path must be unreachable over the request surface")
        XCTAssertTrue(
            response.error?.contains("controllerOwner") == true,
            response.error ?? "")
        let count = await manager.count
        XCTAssertEqual(count, 0)
    }

    func testSecondClientCannotReadFirstClientsSession() async throws {
        let manager = makeManager(displayID: 95_002)
        let leaseA = UUID()
        try await createSession(
            manager, name: "first", ownerID: "client-a", leaseID: leaseA)

        for cmd in DaemonCommand.ownerScopedReads {
            var foreign = Request(cmd: cmd)
            foreign.session = "first"
            foreign.controllerLeaseID = UUID()
            let refused = await manager.handle(foreign)
            XCTAssertFalse(refused.ok, "\(cmd) must refuse a mismatched lease")
            XCTAssertTrue(
                refused.error?.contains("lease") == true,
                "\(cmd): \(refused.error ?? "")")

            var leaseless = Request(cmd: cmd)
            leaseless.session = "first"
            let alsoRefused = await manager.handle(leaseless)
            XCTAssertFalse(alsoRefused.ok, "\(cmd) must refuse a missing lease")
        }

        // The holder of the session's lease still reads it.
        var owned = Request(cmd: "windows")
        owned.session = "first"
        owned.controllerLeaseID = leaseA
        let allowed = await manager.handle(owned)
        XCTAssertTrue(allowed.ok, allowed.error ?? "")
    }

    func testSecondClientCannotDestroyFirstClientsSession() async throws {
        let manager = makeManager(displayID: 95_003)
        try await createSession(
            manager, name: "first", ownerID: "client-a", leaseID: UUID())

        var foreign = Request(cmd: "session.destroy")
        foreign.session = "first"
        foreign.controllerLeaseID = UUID()
        let refused = await manager.handle(foreign)
        XCTAssertFalse(refused.ok)
        let count = await manager.count
        XCTAssertEqual(count, 1, "the session must survive a foreign destroy")
    }

    func testDestroyAllAcrossControllersRequiresOperatorScope() async throws {
        let manager = makeManager(displayID: 95_004)
        let leaseA = UUID()
        try await createSession(
            manager, name: "first", ownerID: "client-a", leaseID: leaseA)
        try await createSession(
            manager, name: "second", ownerID: "client-b", leaseID: UUID())

        var destroyAll = Request(cmd: "session.destroy")
        destroyAll.full = true
        destroyAll.controllerLeaseID = leaseA
        let refused = await manager.handle(destroyAll)
        XCTAssertFalse(
            refused.ok,
            "one client's lease must not take down another client's session")
        XCTAssertTrue(
            refused.error?.contains("--operator") == true,
            refused.error ?? "")
        let survivors = await manager.count
        XCTAssertEqual(survivors, 2)

        destroyAll.operatorScope = true
        let allowed = await manager.handle(destroyAll)
        XCTAssertTrue(allowed.ok, allowed.error ?? "")
        let remaining = await manager.count
        XCTAssertEqual(remaining, 0)
    }

    func testDestroyAllCoveredByOneLeaseNeedsNoOperatorFlag() async throws {
        let manager = makeManager(displayID: 95_005)
        let lease = UUID()
        try await createSession(
            manager, name: "first", ownerID: "client-a", leaseID: lease)
        try await createSession(
            manager, name: "second", ownerID: "client-a", leaseID: lease)

        var destroyAll = Request(cmd: "session.destroy")
        destroyAll.full = true
        destroyAll.controllerLeaseID = lease
        let allowed = await manager.handle(destroyAll)
        XCTAssertTrue(allowed.ok, allowed.error ?? "")
        let remaining = await manager.count
        XCTAssertEqual(remaining, 0)
    }

    func testDaemonStopAcrossControllersRequiresOperatorScope() async throws {
        let manager = makeManager(displayID: 95_006)
        try await createSession(
            manager, name: "first", ownerID: "client-a", leaseID: UUID())

        var stop = Request(cmd: "daemon.stop")
        stop.controllerLeaseID = UUID()
        let refused = await manager.handle(stop)
        XCTAssertFalse(refused.ok)
        let alive = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(
            alive.ok,
            "a refused stop must leave the daemon serving requests")

        stop.operatorScope = true
        let allowed = await manager.handle(stop)
        XCTAssertTrue(allowed.ok, allowed.error ?? "")
    }

    func testPoolConfigureRequiresOperatorScope() async {
        let manager = makeManager(displayID: 95_007)
        var configure = Request(cmd: "pool.configure")
        configure.count = 4
        let refused = await manager.handle(configure)
        XCTAssertFalse(refused.ok)
        XCTAssertTrue(
            refused.error?.contains("--operator") == true,
            refused.error ?? "")

        configure.operatorScope = true
        let allowed = await manager.handle(configure)
        XCTAssertTrue(allowed.ok, allowed.error ?? "")
        XCTAssertEqual(allowed.sessionsPerDisplay, 4)

        let pool = await manager.handle(Request(cmd: "pool"))
        XCTAssertEqual(pool.sessionsPerDisplay, 4,
                       "pool reports the density for future displays, not an old display's capacity")
    }

    func testSessionListRedactsOtherControllersDetail() async throws {
        let manager = makeManager(displayID: 95_008)
        let leaseA = UUID()
        try await createSession(
            manager, name: "mine", ownerID: "client-a", leaseID: leaseA)
        try await createSession(
            manager, name: "theirs", ownerID: "client-b", leaseID: UUID())

        var list = Request(cmd: "session.list")
        list.controllerLeaseID = leaseA
        let response = await manager.handle(list)
        XCTAssertTrue(response.ok, response.error ?? "")
        let mine = response.sessions?.first(where: { $0.id == "mine" })
        let theirs = response.sessions?.first(where: { $0.id == "theirs" })
        XCTAssertNil(mine?.redacted)
        XCTAssertEqual(theirs?.redacted, true)
        XCTAssertEqual(theirs?.apps.isEmpty, true)
        XCTAssertEqual(theirs?.windows.isEmpty, true)

        // Matching owner identity covers sessions the wire's single lease cannot.
        var byOwner = Request(cmd: "session.list")
        byOwner.controllerOwner = TestController.owner(id: "client-b")
        let ownerResponse = await manager.handle(byOwner)
        let theirsByOwner = ownerResponse.sessions?.first(where: { $0.id == "theirs" })
        XCTAssertNil(theirsByOwner?.redacted)

        var operatorList = Request(cmd: "session.list")
        operatorList.operatorScope = true
        let unredacted = await manager.handle(operatorList)
        XCTAssertEqual(
            unredacted.sessions?.compactMap(\.redacted), [],
            "operator scope lifts redaction for every session")
    }
}
