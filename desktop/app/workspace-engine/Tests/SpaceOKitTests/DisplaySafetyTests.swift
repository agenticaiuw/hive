import XCTest
import CoreGraphics
@testable import SpaceOKit

final class DisplaySafetyTests: XCTestCase {
    func testTransientHealthReceiptRequiresPreDispatchBoundary() {
        for reason in ["memory_pressure", "swap_activity"] {
            let original = SpaceOError.stageCreationFailed("host health refused: \(reason); inspect")
            let before = SessionManager.preDispatchHealthFailure(original, isPreflight: true)
            let after = SessionManager.preDispatchHealthFailure(original, isPreflight: false)
            XCTAssertTrue(before.localizedDescription.contains("pre_dispatch_transient_host_health"))
            XCTAssertFalse(after.localizedDescription.contains("pre_dispatch_transient_host_health"))
        }
        let unknown = SpaceOError.stageCreationFailed("host health refused: host_health_unknown; inspect")
        XCTAssertFalse(SessionManager.preDispatchHealthFailure(unknown, isPreflight: true)
            .localizedDescription.contains("pre_dispatch_transient_host_health"))
    }
    private final class HealthCheckCount: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.withLock { value } }
        func refuse() throws {
            lock.withLock { value += 1 }
            throw SpaceOError.stageCreationFailed("injected sticky health failure")
        }
    }

    func testRuntimeJanitorStopsAfterHealthRefusalAndRetainsIdleDisplay() async throws {
        let health = HealthCheckCount()
        let backing = DisplayBacking(displayID: 90_081)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [backing.displayID] })
        let pool = DisplayPool(stageFactory: { _, _, _, _ in stage })
        let slot = try pool.allocate()
        XCTAssertTrue(pool.release(slot, retainEmpty: true))
        let manager = SessionManager(pool: pool, runJanitor: true,
            hostHealthCheck: { try health.refuse() },
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        // Exercise the actual runtime timer; allow scheduling slack on a loaded test runner.
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while health.count == 0 && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        let running = await manager.janitorIsRunning
        XCTAssertFalse(running, "a sticky refusal must stop timed admission retries")
        XCTAssertEqual(health.count, 2, "one immediate recheck resolves a pressure-clear race")
        try await Task.sleep(for: .milliseconds(3_500))
        XCTAssertEqual(health.count, 2, "no timed retry after a sticky refusal")
        XCTAssertEqual(pool.displayCount, 1)
        XCTAssertEqual(backing.invalidationCount, 0, "retain the display owner on failure")
        await manager.stopJanitor()
    }

    func testJanitorAdmissionWithoutDisplaysSkipsHealthLikeTheScan() async {
        let health = HealthCheckCount()
        let manager = SessionManager(pool: DisplayPool(stageFactory: { _, _, _, _ in
            XCTFail("admission must not create a display")
            throw SpaceOError.stageCreationFailed("inert")
        }), runJanitor: false,
            hostHealthCheck: { try health.refuse() },
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        let admitted = await manager.admitJanitorPass()
        XCTAssertTrue(admitted, "detached recovery needs no display health admission")
        XCTAssertEqual(health.count, 0)
    }

    private final class HealthSwitch: @unchecked Sendable {
        private let lock = NSLock()
        private var failed = false
        func trip() { lock.withLock { failed = true } }
        func recover() { lock.withLock { failed = false } }
        var isFailed: Bool { lock.withLock { failed } }
        func check() throws {
            if lock.withLock({ failed }) { throw SpaceOError.stageCreationFailed("injected health failure") }
        }
    }

    func testJanitorKeepsOwnerAndResumesAfterTransientPressure() async throws {
        let health = HealthSwitch()
        health.trip()
        let backing = DisplayBacking(displayID: 90_082)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [backing.displayID] })
        let pool = DisplayPool(stageFactory: { _, _, _, _ in stage })
        let slot = try pool.allocate()
        XCTAssertTrue(pool.release(slot, retainEmpty: true))
        let manager = SessionManager(pool: pool, runJanitor: true,
            hostHealthCheck: { try health.check() }, transientHealthCheck: { health.isFailed },
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        try await Task.sleep(for: .milliseconds(3_500))
        let runningDuringPressure = await manager.janitorIsRunning
        XCTAssertTrue(runningDuringPressure)
        XCTAssertEqual(backing.invalidationCount, 0)
        health.recover()
        let admittedAfterRecovery = await manager.admitJanitorPass()
        let runningAfterRecovery = await manager.janitorIsRunning
        XCTAssertTrue(admittedAfterRecovery)
        XCTAssertTrue(runningAfterRecovery)
        await manager.stopJanitor()
    }

    func testBlockedSessionInventoryRemainsAvailableWithoutRefreshingGeometry() async throws {
        let health = HealthSwitch()
        let backing = DisplayBacking(displayID: 90_080)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [backing.displayID] })
        let pool = DisplayPool(stageFactory: { _, _, _, _ in stage })
        let manager = SessionManager(pool: pool, runJanitor: false,
            hostHealthCheck: { try health.check() }, sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")
        health.trip()
        let inventory = await manager.handle(TestController.request("session.list"))
        XCTAssertTrue(inventory.ok, inventory.error ?? "")
        XCTAssertEqual(inventory.sessions?.count, 1)
        XCTAssertEqual(inventory.sessions?.first?.lifecycleReason, "host_health_blocked")
        XCTAssertEqual(inventory.sessions?.first?.width, 0)
        XCTAssertEqual(inventory.sessions?.first?.spaces, [])
        let destroyed = await manager.handle(TestController.request("session.destroy"))
        XCTAssertFalse(destroyed.ok)
        XCTAssertEqual(pool.sessionCount, 1)
        XCTAssertEqual(backing.invalidationCount, 0)
    }

    func testDefaultManagerKeepsOneIdleDisplayAndOperatorCanTrimIt() async throws {
        let backing = DisplayBacking(displayID: 90_050)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        var creations = 0
        let pool = DisplayPool(stageFactory: { _, _, _, _ in creations += 1; return stage })
        let manager = SessionManager(pool: pool, runJanitor: false,
            idleDisplayGraceNanoseconds: 1_000_000,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        for _ in 0..<3 {
            let created = await manager.handle(TestController.createRequest())
            XCTAssertTrue(created.ok, created.error ?? "")
            let destroyed = await manager.handle(TestController.request("session.destroy"))
            XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
            try await Task.sleep(for: .milliseconds(20))
            XCTAssertEqual(pool.displayCount, 1)
            XCTAssertEqual(backing.invalidationCount, 0)
        }
        XCTAssertEqual(creations, 1)
        let refused = await manager.handle(Request(cmd: "pool.trim"))
        XCTAssertFalse(refused.ok)
        var trim = Request(cmd: "pool.trim")
        trim.operatorScope = true
        let trimmed = await manager.handle(trim)
        XCTAssertTrue(trimmed.ok, trimmed.error ?? "")
        XCTAssertEqual(pool.displayCount, 0)
        XCTAssertEqual(backing.invalidationCount, 1)
    }

    func testTrimPreservesActiveReservationsAndHealthFailurePreservesAllOwners() async throws {
        var nextID: UInt32 = 90_060
        let pool = DisplayPool(stageFactory: { _, _, _, _ in
            nextID += 1
            let backing = DisplayBacking(displayID: nextID)
            return Stage(testingBacking: backing, onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        })
        let active = try pool.allocate()
        let idle = try pool.allocate()
        XCTAssertTrue(pool.release(idle, retainEmpty: true))
        let manager = SessionManager(pool: pool, runJanitor: false,
            hostHealthCheck: { throw SpaceOError.stageCreationFailed("injected unhealthy host") },
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        for cmd in ["session.create", "session.destroy", "pool.trim", "pool.remove", "daemon.stop", "screenshot", "click"] {
            var request = Request(cmd: cmd)
            request.operatorScope = true
            let result = await manager.handle(request)
            XCTAssertFalse(result.ok, cmd)
            XCTAssertTrue(result.error?.contains("injected unhealthy host") == true, cmd)
        }
        for cmd in ["ping", "pool", "session.list"] {
            let result = await manager.handle(Request(cmd: cmd))
            XCTAssertTrue(result.ok, result.error ?? cmd)
        }
        XCTAssertEqual(pool.displayCount, 2)
        XCTAssertTrue(active.stage.isValid)
        XCTAssertTrue(idle.stage.isValid)
        XCTAssertTrue(pool.retireEmptyDisplays().isEmpty)
        XCTAssertEqual(pool.displayCount, 1)
        XCTAssertEqual(pool.sessionCount, 1)
        XCTAssertTrue(active.stage.isValid)
        XCTAssertFalse(idle.stage.isValid)
    }

    func testExclusiveReuseRequiresDimensionsNotJustArea() throws {
        var creations = 0
        let pool = DisplayPool(stageFactory: { _, _, _, _ in
            creations += 1
            return Stage(testingBacking: DisplayBacking(displayID: 90_070 + UInt32(creations)), onlineDisplayIDs: { [] })
        })
        let first = try pool.allocateExclusive(size: CGSize(width: 1920, height: 1080))
        XCTAssertTrue(pool.release(first, retainEmpty: true))
        let second = try pool.allocateExclusive(size: CGSize(width: 1080, height: 1920))
        XCTAssertEqual(creations, 2)
        XCTAssertNotEqual(first.stage.displayID, second.stage.displayID)
    }

    private final class DisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 2_000, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true
        private var invalidations = 0

        init(displayID: CGDirectDisplayID) { self.displayID = displayID }

        var valid: Bool { lock.withLock { attached } }
        var isAttached: Bool { lock.withLock { attached } }
        var invalidationCount: Int { lock.withLock { invalidations } }

        func invalidate() {
            lock.withLock {
                invalidations += 1
                attached = false
            }
        }
    }

    private func userDisplay(
        id: CGDirectDisplayID = 1,
        active: Bool = true,
        main: Bool = true,
        bounds: CGRect = CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
        modeWidth: Int? = nil,
        mirroredTo: CGDirectDisplayID = 0,
        refreshRate: Double = 60
    ) -> Stage.UserDisplayConfiguration.Display {
        Stage.UserDisplayConfiguration.Display(
            id: id,
            active: active,
            main: main,
            bounds: bounds,
            pixelWidth: Int(bounds.width),
            pixelHeight: Int(bounds.height),
            rotation: 0,
            mirroredTo: mirroredTo,
            modeWidth: modeWidth ?? Int(bounds.width),
            modeHeight: Int(bounds.height),
            modePixelWidth: Int(bounds.width),
            modePixelHeight: Int(bounds.height),
            refreshRate: refreshRate)
    }

    private func configuration(
        _ displays: [Stage.UserDisplayConfiguration.Display]
    ) -> Stage.UserDisplayConfiguration {
        Stage.UserDisplayConfiguration(displays: displays.sorted { $0.id < $1.id })
    }

    private func publicationFailure(
        active: Bool = true,
        spaces: [UInt64] = [200],
        activeSpace: UInt64 = 100,
        bounds: CGRect = CGRect(x: 1_920, y: 0, width: 1_280, height: 800),
        otherBounds: [(CGDirectDisplayID, CGRect)] = [
            (1, CGRect(x: 0, y: 0, width: 1_920, height: 1_080)),
        ],
        before: Stage.UserDisplayConfiguration? = nil,
        after: Stage.UserDisplayConfiguration? = nil
    ) -> String? {
        let baseline = before ?? configuration([userDisplay()])
        return Stage.publicationFailure(
            displayID: 90_001,
            bounds: bounds,
            activeDisplayIDs: active ? [90_001] : [],
            spaces: spaces,
            activeSpace: activeSpace,
            otherDisplayBounds: otherBounds,
            userConfigurationBefore: baseline,
            userConfigurationAfter: after ?? baseline)
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

    func testHealthyPublishedDisplayIsAccepted() {
        XCTAssertNil(publicationFailure())
        // Touching an edge is not overlap and is the normal side-by-side arrangement.
        XCTAssertNil(publicationFailure(
            bounds: CGRect(x: 1_920, y: 0, width: 1_280, height: 800)))
    }

    func testCreationAdmissionRejectsUnsafeOrUnknownUserDisplays() {
        func failure(_ displays: [Stage.UserDisplayConfiguration.Display], foreign: [UInt32] = []) -> String? {
            Stage.admissionFailure(configuration: configuration(displays), foreignDisplayIDs: foreign)
        }
        XCTAssertNil(failure([userDisplay()]))
        XCTAssertNotNil(failure([]))
        XCTAssertNotNil(failure([userDisplay(active: false)]))
        XCTAssertNotNil(failure([userDisplay()], foreign: [99_222]))
    }

    func testCheckedInventoryDistinguishesReadableEmptyFromFailure() throws {
        XCTAssertEqual(try Stage.validatedDisplayIDs(result: .success, buffer: [0, 0], count: 0), [])
        XCTAssertEqual(try Stage.validatedDisplayIDs(result: .success, buffer: [1, 0], count: 1), [1])
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .failure, buffer: [0, 0], count: 0))
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .success, buffer: [], count: 0))
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .success, buffer: [1], count: 1))
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .success, buffer: [1], count: 2))
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .success, buffer: [0, 0], count: 1))
        XCTAssertThrowsError(try Stage.validatedDisplayIDs(result: .success, buffer: [1, 1, 0], count: 2))
    }

    func testMirroredAndHighRefreshDisplaysAreAdmitted() {
        let mirrored = configuration([
            userDisplay(id: 1, active: false, mirroredTo: 2, refreshRate: 0),
            userDisplay(id: 2, mirroredTo: 1, refreshRate: 240),
        ])
        XCTAssertNil(Stage.admissionFailure(configuration: mirrored, foreignDisplayIDs: []))
        XCTAssertNil(Stage.admissionFailure(
            configuration: configuration([userDisplay(refreshRate: 240)]), foreignDisplayIDs: []))
        XCTAssertNotNil(Stage.admissionFailure(configuration: mirrored, foreignDisplayIDs: [99_222]))
        XCTAssertNotNil(Stage.admissionFailure(
            configuration: configuration([userDisplay(active: false, mirroredTo: 2)]),
            foreignDisplayIDs: []))
    }

    func testInactiveOverlappingOrSpacelessDisplayIsRefused() {
        XCTAssertTrue(publicationFailure(active: false)?.contains("inactive") == true)
        XCTAssertTrue(publicationFailure(spaces: [])?.contains("no managed Space") == true)
        XCTAssertTrue(publicationFailure(spaces: [100])?.contains("active Space") == true)
        XCTAssertTrue(publicationFailure(
            bounds: CGRect(x: 1_800, y: 0, width: 1_280, height: 800))?
            .contains("overlaps display 1") == true)
    }

    func testUserDisplayTopologyOrModeChangeIsRefused() {
        let before = configuration([userDisplay()])
        let moved = configuration([userDisplay(
            bounds: CGRect(x: 50, y: 0, width: 1_920, height: 1_080))])
        XCTAssertTrue(publicationFailure(before: before, after: moved)?
            .contains("changed bounds") == true)

        let missing = configuration([])
        XCTAssertTrue(publicationFailure(before: before, after: missing)?
            .contains("went offline") == true)
    }

    func testInactiveMirrorFollowerSyntheticModeDoesNotRejectAHealthyStage() {
        let before = configuration([
            userDisplay(
                id: 1, active: false, main: false, modeWidth: 1_920, mirroredTo: 2),
            userDisplay(id: 2),
        ])
        let after = configuration([
            userDisplay(
                id: 1, active: false, main: false, modeWidth: 3_840, mirroredTo: 2),
            userDisplay(id: 2),
        ])
        XCTAssertNil(publicationFailure(before: before, after: after))

        let activeModeChange = configuration([userDisplay(id: 2, modeWidth: 3_840)])
        XCTAssertTrue(publicationFailure(
            before: configuration([userDisplay(id: 2)]),
            after: activeModeChange)?.contains("display mode") == true)
    }

    func testLastSessionRetiresEveryDisplayAfterIdleGrace() async throws {
        let backing = DisplayBacking(displayID: 90_010)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        let pool = DisplayPool(
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            idleDisplayGraceNanoseconds: 5_000_000,
            retainedIdleDisplayCount: 0,
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")
        let destroyed = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")

        let deadline = ContinuousClock.now + .seconds(1)
        while await manager.displayCount != 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        let finalDisplayCount = await manager.displayCount
        XCTAssertEqual(finalDisplayCount, 0)
        XCTAssertFalse(backing.isAttached)
        XCTAssertEqual(backing.invalidationCount, 1)
    }

    func testExclusiveAllocationReusesAnIdleDisplayOfTheSameSize() throws {
        let backing = DisplayBacking(displayID: 90_020)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        var built = 0
        let pool = DisplayPool(
            stageFactory: { _, _, _, _ in built += 1; return stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let size = CGSize(width: 1_920, height: 1_080)

        let first = try pool.allocateExclusive(size: size)
        XCTAssertTrue(pool.release(first, retainEmpty: true))
        _ = try pool.allocateExclusive(size: size)
        XCTAssertEqual(built, 1, "the idle display is handed out again, not rebuilt")
        XCTAssertEqual(pool.displayCount, 1)

        _ = try pool.allocateExclusive(size: CGSize(width: 2_560, height: 1_440))
        XCTAssertEqual(built, 2, "a different size is a different display")
    }

    func testPoolRemoveEndsTheDisplaysSessionsAndRetiresIt() async throws {
        let backing = DisplayBacking(displayID: 90_021)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        let pool = DisplayPool(
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            idleDisplayGraceNanoseconds: 60_000_000_000,
            retainedIdleDisplayCount: 0,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")

        var remove = Request(cmd: "pool.remove")
        remove.display = 90_021
        let refused = await manager.handle(remove)
        XCTAssertFalse(refused.ok, "removing a display ends other controllers' sessions")
        XCTAssertTrue(refused.error?.contains("--operator") == true, refused.error ?? "")

        remove.operatorScope = true
        let removed = await manager.handle(remove)
        XCTAssertTrue(removed.ok, removed.error ?? "")
        let displayCount = await manager.displayCount
        XCTAssertEqual(displayCount, 0, "retired now, not after the idle grace")
        XCTAssertFalse(backing.isAttached)
        let listed = await manager.handle(Request(cmd: "session.list"))
        XCTAssertEqual(listed.sessions?.count ?? 0, 0)

        var unknown = Request(cmd: "pool.remove")
        unknown.display = 12_345
        unknown.operatorScope = true
        let missing = await manager.handle(unknown)
        XCTAssertFalse(missing.ok)
        XCTAssertTrue(missing.error?.contains("not a SpaceO virtual display") == true,
                      missing.error ?? "")
    }

    func testIdleTimerNeverRetiresAReusedActiveDisplay() async throws {
        let backing = DisplayBacking(displayID: 90_011)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        let pool = DisplayPool(
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            idleDisplayGraceNanoseconds: 50_000_000,
            retainedIdleDisplayCount: 0,
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let firstCreate = await manager.handle(TestController.createRequest())
        let firstDestroy = await manager.handle(TestController.request("session.destroy"))
        let secondCreate = await manager.handle(TestController.createRequest())
        XCTAssertTrue(firstCreate.ok, firstCreate.error ?? "")
        XCTAssertTrue(firstDestroy.ok, firstDestroy.error ?? "")
        XCTAssertTrue(secondCreate.ok, secondCreate.error ?? "")
        try await Task.sleep(for: .milliseconds(100))

        let activeDisplayCount = await manager.displayCount
        XCTAssertEqual(activeDisplayCount, 1)
        XCTAssertTrue(backing.isAttached)
        XCTAssertEqual(backing.invalidationCount, 0)

        let secondDestroy = await manager.handle(TestController.request("session.destroy"))
        XCTAssertTrue(secondDestroy.ok, secondDestroy.error ?? "")
        let deadline = ContinuousClock.now + .seconds(1)
        while await manager.displayCount != 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        let finalDisplayCount = await manager.displayCount
        XCTAssertEqual(finalDisplayCount, 0)
        XCTAssertFalse(backing.isAttached)
    }
}
