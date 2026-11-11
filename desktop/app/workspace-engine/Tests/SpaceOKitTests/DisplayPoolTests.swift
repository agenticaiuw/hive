import XCTest
import CoreGraphics
@testable import SpaceOKit

final class DisplayPoolTests: XCTestCase {
    private final class Backing: StageDisplayBacking, @unchecked Sendable {
        let originalID: CGDirectDisplayID
        let bounds: CGRect
        let detachesOnInvalidation: Bool
        private let lock = NSLock()
        private var currentID: CGDirectDisplayID
        private var attached = true
        private var invalidations = 0

        init(id: CGDirectDisplayID, size: CGSize, detachesOnInvalidation: Bool = true) {
            originalID = id
            currentID = id
            bounds = CGRect(origin: .zero, size: size)
            self.detachesOnInvalidation = detachesOnInvalidation
        }

        var displayID: CGDirectDisplayID { lock.withLock { currentID } }
        var valid: Bool { lock.withLock { currentID != 0 } }
        var onlineIDs: [CGDirectDisplayID] { lock.withLock { attached ? [originalID] : [] } }
        var invalidationCount: Int { lock.withLock { invalidations } }

        func invalidate() {
            lock.withLock {
                currentID = 0
                invalidations += 1
                if detachesOnInvalidation { attached = false }
            }
        }
    }

    private final class Fixture {
        var backings: [Backing] = []
        var nextDisplayDetaches = true

        lazy var pool = DisplayPool(
            sessionsPerDisplay: 2,
            stageFactory: { [unowned self] name, width, height, _ in
                let backing = Backing(
                    id: 95_000 + UInt32(self.backings.count),
                    size: CGSize(width: Int(width), height: Int(height)),
                    detachesOnInvalidation: self.nextDisplayDetaches)
                self.backings.append(backing)
                self.nextDisplayDetaches = true
                return Stage(testingBacking: backing, name: name, onlineDisplayIDs: { backing.onlineIDs })
            },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    private final class RetirementPass: @unchecked Sendable {
        private let lock = NSLock()
        private var value = DispatchTime.now()
        private var attempted: [CGDirectDisplayID] = []
        var advanceAfterFirst: TimeInterval = 0
        var refuseFirst = false
        var attempts: [CGDirectDisplayID] { lock.withLock { attempted } }
        func now() -> DispatchTime { lock.withLock { value } }
        func retire(_ stage: Stage) -> Bool {
            let allowed = lock.withLock { () -> Bool in
                attempted.append(stage.displayID)
                if attempted.count == 1 {
                    value = value + advanceAfterFirst
                    return !refuseFirst
                }
                return true
            }
            return allowed && stage.invalidate(waitingForRemoval: 0)
        }
    }

    private func retirementPool(_ pass: RetirementPass) -> DisplayPool {
        var nextID: CGDirectDisplayID = 96_000
        return DisplayPool(stageFactory: { name, width, height, _ in
            defer { nextID += 1 }
            let backing = Backing(id: nextID, size: CGSize(width: Int(width), height: Int(height)))
            return Stage(testingBacking: backing, name: name, onlineDisplayIDs: { backing.onlineIDs })
        }, stageRetirer: { pass.retire($0) }, retirementNow: { pass.now() })
    }

    private let small = CGSize(width: 1_920, height: 1_080)
    private let large = CGSize(width: 2_560, height: 1_440)

    func testRepeatedTasksAtNewSizeReuseMostRecentlyEmptiedDisplay() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let older = try fixture.pool.allocateExclusive(size: small)
        XCTAssertTrue(fixture.pool.release(older, retainEmpty: true))
        let recent = try fixture.pool.allocateExclusive(size: large)
        XCTAssertTrue(fixture.pool.release(recent, retainEmpty: true))

        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [])
        XCTAssertFalse(older.stage.isValid)
        XCTAssertTrue(recent.stage.isValid)
        for _ in 0..<4 {
            let next = try fixture.pool.allocateExclusive(size: large)
            XCTAssertTrue(next.stage === recent.stage)
            XCTAssertTrue(fixture.pool.release(next, retainEmpty: true))
            XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [])
        }
        XCTAssertEqual(fixture.backings.count, 2, "the new geometry must remain warm instead of being rebuilt")
    }

    func testReusingOlderDisplayUpdatesRecencyAndDuplicateReleaseDoesNot() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let older = try fixture.pool.allocateExclusive(size: small)
        XCTAssertTrue(fixture.pool.release(older, retainEmpty: true))
        let newer = try fixture.pool.allocateExclusive(size: large)
        XCTAssertTrue(fixture.pool.release(newer, retainEmpty: true))

        let reused = try fixture.pool.allocateExclusive(size: small)
        XCTAssertTrue(reused.stage === older.stage)
        XCTAssertTrue(fixture.pool.release(reused, retainEmpty: true))
        XCTAssertTrue(fixture.pool.release(newer, retainEmpty: true), "a duplicate release is harmless")

        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [])
        XCTAssertTrue(older.stage.isValid, "actual reuse outranks construction order")
        XCTAssertFalse(newer.stage.isValid, "a duplicate release must not promote an already idle display")
    }

    func testOnlyFinalSharedReservationReleaseUpdatesRecencyAndActiveDisplaysSurvive() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let first = try fixture.pool.allocate()
        let second = try fixture.pool.allocate()
        XCTAssertTrue(first.stage === second.stage)
        let exclusive = try fixture.pool.allocateExclusive(size: large)
        XCTAssertTrue(fixture.pool.release(exclusive, retainEmpty: true))

        XCTAssertTrue(fixture.pool.release(first, retainEmpty: true))
        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [])
        XCTAssertEqual(fixture.pool.sessionCount, 1)
        XCTAssertTrue(second.stage.isValid)
        XCTAssertTrue(exclusive.stage.isValid)

        XCTAssertTrue(fixture.pool.release(second, retainEmpty: true))
        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [])
        XCTAssertTrue(second.stage.isValid, "the final shared release makes this the newest idle display")
        XCTAssertFalse(exclusive.stage.isValid)
    }

    func testFailedRetirementRemainsOwnedWithoutDisplacingValidStandby() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let healthy = try fixture.pool.allocateExclusive(size: small)
        XCTAssertTrue(fixture.pool.release(healthy, retainEmpty: true))
        fixture.nextDisplayDetaches = false
        let stuck = try fixture.pool.allocateExclusive(size: large)
        let stuckID = stuck.stage.displayID
        XCTAssertTrue(fixture.pool.release(stuck, retainEmpty: true))
        XCTAssertEqual(fixture.pool.retireDisplay(stuckID), false)
        XCTAssertFalse(stuck.stage.isValid)

        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 1), [stuckID])
        XCTAssertEqual(fixture.pool.displayCount, 2, "failed retirement keeps its owner for cleanup")
        XCTAssertTrue(healthy.stage.isValid, "an invalid newer display must not consume the warm standby slot")
        XCTAssertTrue(fixture.pool.stages.contains { $0 === stuck.stage })
        let reused = try fixture.pool.allocateExclusive(size: small)
        XCTAssertTrue(reused.stage === healthy.stage)
        XCTAssertEqual(fixture.backings.count, 2)
        XCTAssertGreaterThanOrEqual(fixture.backings[1].invalidationCount, 2)
    }

    func testExplicitTrimKeepsNoStandbysAndNeverRetiresActiveDisplay() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let active = try fixture.pool.allocateExclusive(size: small)
        let idle = try fixture.pool.allocateExclusive(size: large)
        XCTAssertTrue(fixture.pool.release(idle, retainEmpty: true))

        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: 0), [])
        XCTAssertTrue(active.stage.isValid)
        XCTAssertFalse(idle.stage.isValid)
        XCTAssertEqual(fixture.pool.displayCount, 1)
        XCTAssertEqual(fixture.pool.sessionCount, 1)
        XCTAssertTrue(fixture.pool.release(active, retainEmpty: true))
        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: -1), [])
        XCTAssertEqual(fixture.pool.displayCount, 0)
    }

    func testRetentionCountLargerThanIdleCountPreservesAllValidStandbys() throws {
        let fixture = Fixture()
        defer { fixture.pool.releaseAll() }
        let first = try fixture.pool.allocateExclusive(size: small)
        let second = try fixture.pool.allocateExclusive(size: large)
        XCTAssertTrue(fixture.pool.release(first, retainEmpty: true))
        XCTAssertTrue(fixture.pool.release(second, retainEmpty: true))

        XCTAssertEqual(fixture.pool.retireEmptyDisplays(keeping: Int.max), [])
        XCTAssertEqual(fixture.pool.displayCount, 2)
        XCTAssertTrue(first.stage.isValid)
        XCTAssertTrue(second.stage.isValid)
        XCTAssertEqual(fixture.backings.map(\.invalidationCount), [0, 0])
    }

    func testCleanupPassStopsAfterFirstDeferralAndReportsUnattemptedOwners() throws {
        let pass = RetirementPass()
        pass.refuseFirst = true
        let pool = retirementPool(pass)
        let slots = try (0..<3).map { _ in try pool.allocateExclusive() }
        let ids = slots.map { $0.stage.displayID }
        for slot in slots { XCTAssertTrue(pool.release(slot, retainEmpty: true)) }

        XCTAssertEqual(pool.retireEmptyDisplays(), ids)
        XCTAssertEqual(pass.attempts, [ids[0]])
        XCTAssertEqual(pool.displayCount, 3)
        XCTAssertTrue(pool.stages.allSatisfy(\.isValid))
    }

    func testReleaseAllUsesOneTwentyFiveSecondBudgetAndReportsRemainingOwners() throws {
        let pass = RetirementPass()
        // Sixteen seconds spent on the first owner leaves nine of the total 25 seconds;
        // another removal must defer before mutation rather than getting its own full budget.
        pass.advanceAfterFirst = 16
        let pool = retirementPool(pass)
        let slots = try (0..<3).map { _ in try pool.allocateExclusive() }
        let ids = slots.map { $0.stage.displayID }

        XCTAssertEqual(pool.releaseAll(), Array(ids.dropFirst()))
        XCTAssertEqual(pass.attempts, [ids[0]])
        XCTAssertEqual(pool.displayCount, 2)
        XCTAssertEqual(pool.sessionCount, 0)
        XCTAssertTrue(slots[1].stage.isValid)
        XCTAssertTrue(slots[2].stage.isValid)
    }

}
