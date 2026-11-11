import CoreGraphics
import XCTest
@testable import SpaceOKit

final class StageRetirementSettlingTests: XCTestCase {
    private final class Backing: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 94_501
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        private let lock = NSLock()
        private var invalidations = 0
        private let onRelease: (@Sendable () -> Void)?
        init(onRelease: (@Sendable () -> Void)? = nil) { self.onRelease = onRelease }
        deinit { onRelease?() }
        var calls: Int { lock.withLock { invalidations } }
        var valid: Bool { calls == 0 }
        func invalidate() { lock.withLock { invalidations += 1 } }
    }

    private final class WeakBacking {
        weak var value: Backing?
        init(_ value: Backing?) { self.value = value }
    }

    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var ready = false
        private var refusalConsumed = false
        private var checks = 0
        var checkCount: Int { lock.withLock { checks } }
        func allow() { lock.withLock { ready = true } }
        func refuseOnce() {
            lock.withLock {
                guard !refusalConsumed else { return }
                refusalConsumed = true
                ready = false
            }
        }
        func check(_: TimeInterval) throws {
            guard lock.withLock({ checks += 1; return ready }) else {
                throw DisplayHostHealth.ReconfigurationSettlingRefusal(
                    underlyingError: .stageCreationFailed("ColorSync has not settled"))
            }
        }
    }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = DispatchTime.now()
        private var observedBudgets: [TimeInterval] = []
        var budgets: [TimeInterval] { lock.withLock { observedBudgets } }
        func now() -> DispatchTime { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value = value + seconds } }
        func record(_ budget: TimeInterval) { lock.withLock { observedBudgets.append(budget) } }
    }

    private final class LeaseFixture: @unchecked Sendable {
        let directory: URL
        let path: String
        let lease: DisplayLifecycleLease
        init() throws {
            directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("spaceo-marker-race-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            path = directory.appendingPathComponent("journal.json").path
            lease = DisplayLifecycleLease(path: path)
            try lease.acquire()
        }
        deinit { try? FileManager.default.removeItem(at: directory) }
        func pending() throws -> Bool? {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let journal = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return journal?["pending"] as? Bool
        }
        func attemptCount() throws -> Int? {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let journal = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return (journal?["attempts"] as? [Double])?.count
        }
    }

    private final class Owner: @unchecked Sendable {
        private let lock = NSLock()
        private var stage: Stage?
        init(_ stage: Stage) { self.stage = stage }
        func release() { lock.withLock { stage = nil } }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func increment() { lock.withLock { count += 1 } }
    }

    func testSettlingRefusalPreservesValidDisplayAndDoesNotTripCircuit() {
        let backing = Backing(), gate = Gate(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { backing.valid ? [backing.displayID] : [] },
                          coordinator: coordinator,
                          reconfigurationReadiness: { try gate.check($0) })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid)
        XCTAssertEqual(stage.displayID, backing.displayID)
        XCTAssertNil(coordinator.failureReason)

        gate.allow()
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(backing.calls, 1)
    }

    func testPoolRetainsAndReusesDisplayAfterRetirementWasDeferred() throws {
        let backing = Backing(), gate = Gate()
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { backing.valid ? [backing.displayID] : [] },
                          reconfigurationReadiness: { try gate.check($0) })
        let pool = DisplayPool(displaySize: backing.bounds.size,
                               stageFactory: { _, _, _, _ in stage },
                               stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let slot = try pool.allocate()
        XCTAssertFalse(pool.release(slot))
        XCTAssertEqual(pool.displayCount, 1)
        XCTAssertEqual(backing.calls, 0)
        let reused = try pool.allocate()
        XCTAssertTrue(reused.stage === stage)
        gate.allow()
        XCTAssertTrue(pool.release(reused))
        XCTAssertEqual(pool.displayCount, 0)
    }

    func testDefaultBudgetReservesTenSecondsAndDefersWithoutMutationWhenReadinessOverruns() {
        let backing = Backing(), clock = Clock(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { [] }, coordinator: coordinator,
                          reconfigurationReadiness: { budget in
                              clock.record(budget)
                              clock.advance(21)
                          }, retirementNow: { clock.now() })
        XCTAssertFalse(stage.invalidate())
        XCTAssertEqual(clock.budgets, [20])
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid)
        XCTAssertNil(coordinator.failureReason)
    }

    func testShortAndZeroTimeoutsDoNotSpendAnyBudgetWaitingForSettling() {
        for timeout in [0.0, 0.5, 10.0] {
            let backing = Backing(), clock = Clock()
            let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                              reconfigurationReadiness: { clock.record($0) })
            XCTAssertTrue(stage.invalidate(waitingForRemoval: timeout))
            XCTAssertEqual(clock.budgets, [0])
            XCTAssertEqual(backing.calls, 1)
        }
    }

    func testWorkerSettlingRecheckAfterConfigurationRestoresValidityAndAllowsRetry() {
        let backing = Backing(), gate = Gate(), coordinator = DisplayLifecycleCoordinator()
        gate.allow()
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { backing.valid ? [backing.displayID] : [] },
                          coordinator: coordinator,
                          configuration: { gate.refuseOnce(); return nil },
                          reconfigurationCheck: { try gate.check(0) })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid)
        XCTAssertEqual(stage.displayID, backing.displayID)
        XCTAssertNil(coordinator.failureReason)
        // The same owner remains retryable rather than becoming permanently invalid.
        gate.allow()
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(backing.calls, 1)
        XCTAssertNil(coordinator.failureReason)
    }

    func testWorkerBudgetExhaustionBeforeMutationRestoresValidOwnerWithoutTrip() {
        let backing = Backing(), clock = Clock(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          configuration: { clock.advance(21); return nil },
                          retirementNow: { clock.now() })
        XCTAssertFalse(stage.invalidate())
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid)
        XCTAssertNil(coordinator.failureReason)
    }

    func testHardReadinessFaultBeforeMutationRemainsSticky() {
        let backing = Backing(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationReadiness: { _ in
                              throw SpaceOError.stageCreationFailed("host health blocked")
                          })
        XCTAssertFalse(stage.invalidate())
        XCTAssertEqual(backing.calls, 0)
        XCTAssertFalse(stage.isValid)
        XCTAssertNotNil(coordinator.failureReason)
    }

    func testHardWorkerFaultBeforeMutationRemainsSticky() {
        let backing = Backing(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationCheck: {
                              throw SpaceOError.stageCreationFailed("host health unknown")
                          })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertFalse(stage.isValid)
        XCTAssertNotNil(coordinator.failureReason)
    }

    func testFailedPublicationRetainsBackingAndPreservesSpecificFailure() {
        let coordinator = DisplayLifecycleCoordinator()
        var backing: Backing? = Backing()
        let retained = WeakBacking(backing)
        let reason = "published display changed the physical topology"
        XCTAssertThrowsError(try Stage.rejectPublication(backing!, reason: reason, coordinator: coordinator)) {
            guard case SpaceOError.stageCreationFailed(let message) = $0 else {
                return XCTFail("publication must preserve its public error code")
            }
            XCTAssertEqual(message, reason)
        }
        XCTAssertTrue(coordinator.failureReason?.contains(reason) == true)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [94_501])
        let status = coordinator.annotatingDeferredRetirements(
            .init(state: .blocked, reason: coordinator.failureReason))
        XCTAssertEqual(status.deferredRetirementDisplayIDs, [94_501])
        XCTAssertEqual(status.reason, coordinator.failureReason, "retained IDs do not mask hard faults")
        XCTAssertEqual(backing?.calls, 0)
        backing = nil
        XCTAssertNotNil(retained.value, "failed publication retains its backing for explicit recovery")
    }

    func testDeinitSettlingDeferralRetainsBackingWithoutTrippingCircuit() {
        let finished = expectation(description: "fallback retirement completed")
        let coordinator = DisplayLifecycleCoordinator()
        var backing: Backing? = Backing()
        let retained = WeakBacking(backing)
        var stage: Stage? = Stage(testingBacking: backing!, onlineDisplayIDs: { [] },
                                  coordinator: coordinator,
                                  reconfigurationReadiness: { _ in
                                      throw DisplayHostHealth.ReconfigurationSettlingRefusal(
                                          underlyingError: .stageCreationFailed("ColorSync has not settled"))
                                  }, fallbackRetirementCompletion: { finished.fulfill() })
        XCTAssertNotNil(stage)
        stage = nil
        backing = nil
        wait(for: [finished], timeout: 2)
        XCTAssertNotNil(retained.value, "deferred fallback must quarantine its owner")
        XCTAssertEqual(retained.value?.calls, 0)
        XCTAssertNil(coordinator.failureReason)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [94_501])
        XCTAssertThrowsError(try coordinator.requireNoDeferredRetirements())
        XCTAssertNil(coordinator.failureReason, "visible deferred cleanup is not a health circuit fault")
    }

    func testDeinitHardReadinessFaultRetainsBackingAndTripsCircuit() {
        let finished = expectation(description: "fallback retirement completed")
        let coordinator = DisplayLifecycleCoordinator()
        var backing: Backing? = Backing()
        let retained = WeakBacking(backing)
        var stage: Stage? = Stage(testingBacking: backing!, onlineDisplayIDs: { [] },
                                  coordinator: coordinator,
                                  reconfigurationReadiness: { _ in
                                      throw SpaceOError.stageCreationFailed("host health blocked")
                                  }, fallbackRetirementCompletion: { finished.fulfill() })
        XCTAssertNotNil(stage)
        stage = nil
        backing = nil
        wait(for: [finished], timeout: 2)
        XCTAssertNotNil(retained.value)
        XCTAssertEqual(retained.value?.calls, 0)
        XCTAssertNotNil(coordinator.failureReason)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [94_501])
    }

    func testConfirmedRetirementDoesNotRepeatReadinessOrBackingMutation() {
        let backing = Backing(), gate = Gate(), coordinator = DisplayLifecycleCoordinator()
        gate.allow()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationReadiness: { try gate.check($0) },
                          reconfigurationCheck: { try gate.check(0) })
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0))
        let checks = gate.checkCount
        XCTAssertEqual(checks, 4)
        gate.refuseOnce()
        XCTAssertTrue(stage.invalidate())
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(gate.checkCount, checks, "verified removal needs no later readiness query")
        XCTAssertEqual(backing.calls, 1)
        XCTAssertNil(coordinator.failureReason)
    }

    func testConfirmedRemovalClearsVisibleDeferredOwnership() {
        let backing = Backing(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] }, coordinator: coordinator)
        coordinator.quarantineDeferred(backing, displayID: backing.displayID)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0))
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [])
        XCTAssertNoThrow(try coordinator.requireNoDeferredRetirements())
        XCTAssertNil(coordinator.failureReason)
    }

    func testSinglePoolRetirementLeavesFiveSecondsOfControllerLeaseHeadroom() throws {
        let backing = Backing(), clock = Clock(), gate = Gate()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          reconfigurationReadiness: { budget in
                              clock.record(budget)
                              try gate.check(budget)
                          })
        // This public factory initializer uses the production timeout-forwarding retirer.
        let pool = DisplayPool(displaySize: backing.bounds.size,
                               stageFactory: { _, _, _, _ in stage })
        let slot = try pool.allocate()
        XCTAssertFalse(pool.release(slot))
        XCTAssertEqual(clock.budgets, [15], "single pool cleanup totals 25s with 10s reserved for removal")
        XCTAssertEqual(backing.calls, 0)
        XCTAssertEqual(pool.displayCount, 1)
        XCTAssertTrue(stage.isValid)
        gate.allow()
        XCTAssertTrue(pool.release(slot))
        XCTAssertEqual(pool.displayCount, 0)
    }

    func testFallbackOwnerIsVisibleBeforeAndDuringReadinessWait() {
        let entered = expectation(description: "fallback readiness entered")
        let finished = expectation(description: "fallback retirement completed")
        let release = DispatchSemaphore(value: 0)
        let coordinator = DisplayLifecycleCoordinator()
        let backing = Backing()
        var stage: Stage? = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                                  coordinator: coordinator,
                                  reconfigurationReadiness: { _ in
                                      entered.fulfill()
                                      guard release.wait(timeout: .now() + .seconds(10)) == .success else {
                                          throw SpaceOError.stageCreationFailed("fixture gate timed out")
                                      }
                                      throw DisplayHostHealth.ReconfigurationSettlingRefusal(
                                          underlyingError: .stageCreationFailed("ColorSync has not settled"))
                                  }, fallbackRetirementCompletion: { finished.fulfill() })
        XCTAssertNotNil(stage)
        stage = nil
        // Registration occurs synchronously in deinit, before any async work is scheduled.
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
        wait(for: [entered], timeout: 2)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
        XCTAssertThrowsError(try coordinator.requireNoDeferredRetirements())
        XCTAssertEqual(backing.calls, 0)
        XCTAssertNil(coordinator.failureReason)
        release.signal()
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
        XCTAssertNil(coordinator.failureReason)
    }

    func testSuccessfulFallbackRemovesVisibleOwnerAndReleasesQuarantine() {
        let finished = expectation(description: "fallback retirement completed")
        let released = expectation(description: "verified backing released")
        let coordinator = DisplayLifecycleCoordinator()
        var backing: Backing? = Backing(onRelease: { released.fulfill() })
        var stage: Stage? = Stage(testingBacking: backing!, onlineDisplayIDs: { [] },
                                  coordinator: coordinator,
                                  fallbackRetirementCompletion: { finished.fulfill() })
        XCTAssertNotNil(stage)
        backing = nil
        stage = nil
        wait(for: [finished, released], timeout: 2)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [])
        XCTAssertNoThrow(try coordinator.requireNoDeferredRetirements())
        XCTAssertNil(coordinator.failureReason)
    }


    func testRetirementRechecksSettlingAfterActualMarkerWriteAndAcknowledgesAbort() throws {
        let fixture = try LeaseFixture()
        let backing = Backing(), gate = Gate(), coordinator = DisplayLifecycleCoordinator()
        gate.allow()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationCheck: { try gate.check(0) },
                          mutationLease: fixture.lease,
                          mutationMarkerDidPersist: {
                              XCTAssertEqual(try? fixture.pending(), true, "the real pending write preceded the new sample")
                              gate.refuseOnce()
                          })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 1))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid)
        XCTAssertNil(coordinator.failureReason)
        XCTAssertEqual(try fixture.pending(), false, "no-mutation abort must be durably acknowledged")
        XCTAssertEqual(fixture.lease.cachedStatus?.state, .ready)
        gate.allow()
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 1))
        XCTAssertEqual(backing.calls, 1)
        XCTAssertEqual(try fixture.pending(), false)
    }

    func testCreationRechecksSettlingAfterActualMarkerWriteWithoutAttaching() throws {
        let fixture = try LeaseFixture()
        let coordinator = DisplayLifecycleCoordinator(), gate = Gate(), attachments = Counter()
        gate.allow()
        XCTAssertThrowsError(try coordinator.perform(timeout: 3) { operation in
            try Stage.beginCheckedMutation(
                creation: true, operation: operation, coordinator: coordinator, lease: fixture.lease,
                markerDidPersist: {
                    XCTAssertEqual(try? fixture.pending(), true)
                    gate.refuseOnce()
                }, readiness: { try gate.check(0) })
            attachments.increment()
        }) { XCTAssertTrue($0 is DisplayHostHealth.ReconfigurationSettlingRefusal) }
        XCTAssertEqual(attachments.value, 0)
        XCTAssertEqual(try fixture.pending(), false)
        XCTAssertEqual(try fixture.attemptCount(), 1, "aborting must retain the conservative creation attempt")
        XCTAssertNil(coordinator.failureReason)
    }

    func testActualDeinitRegistrationDuringCreationMarkerWriteRefusesAttachmentAndAcknowledgesAbort() throws {
        let fixture = try LeaseFixture()
        let coordinator = DisplayLifecycleCoordinator(), attachments = Counter()
        let finished = expectation(description: "owner fallback deferred")
        let backing = Backing()
        let owner = Owner(Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                                coordinator: coordinator,
                                reconfigurationReadiness: { _ in
                                    throw DisplayHostHealth.ReconfigurationSettlingRefusal(
                                        underlyingError: .stageCreationFailed("ColorSync has not settled"))
                                }, fallbackRetirementCompletion: { finished.fulfill() }))
        XCTAssertNoThrow(try coordinator.requireNoDeferredRetirements())
        XCTAssertThrowsError(try coordinator.perform(timeout: 3) { operation in
            try Stage.beginCheckedMutation(
                creation: true, operation: operation, coordinator: coordinator, lease: fixture.lease,
                markerDidPersist: {
                    XCTAssertEqual(try? fixture.pending(), true)
                    owner.release()
                    XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
                }, readiness: {})
            attachments.increment()
        }) { XCTAssertTrue($0 is DisplayLifecycleCoordinator.CreationDeferred) }
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(attachments.value, 0)
        XCTAssertEqual(backing.calls, 0)
        XCTAssertEqual(coordinator.deferredRetirementDisplayIDs, [backing.displayID])
        XCTAssertEqual(try fixture.pending(), false)
        XCTAssertEqual(fixture.lease.cachedStatus?.state, .ready)
        XCTAssertNil(coordinator.failureReason)
    }

    func testHardFaultAfterMarkerWriteRetainsPendingLatchAndInvalidOwner() throws {
        let fixture = try LeaseFixture()
        let backing = Backing(), coordinator = DisplayLifecycleCoordinator(), checks = Counter()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationCheck: {
                              checks.increment()
                              if checks.value == 3 { throw SpaceOError.stageCreationFailed("host health blocked") }
                          }, mutationLease: fixture.lease)
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 1))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertFalse(stage.isValid)
        XCTAssertNotNil(coordinator.failureReason)
        XCTAssertEqual(try fixture.pending(), true, "hard health faults must not clear the pending marker")
    }

    func testAbortAcknowledgmentFailureRemainsSticky() throws {
        let fixture = try LeaseFixture()
        let backing = Backing(), gate = Gate(), coordinator = DisplayLifecycleCoordinator()
        gate.allow()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator,
                          reconfigurationCheck: { try gate.check(0) },
                          mutationLease: fixture.lease,
                          mutationMarkerDidPersist: {
                              fixture.lease.trip("injected persistent lease failure")
                              gate.refuseOnce()
                          })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 1))
        XCTAssertEqual(backing.calls, 0)
        XCTAssertFalse(stage.isValid)
        XCTAssertNotNil(coordinator.failureReason)
        XCTAssertEqual(try fixture.pending(), true)
        XCTAssertEqual(fixture.lease.cachedStatus?.state, .blocked)
    }


    func testCreationRateRefusalBeforeMarkerRemainsNonSticky() throws {
        let fixture = try LeaseFixture()
        let coordinator = DisplayLifecycleCoordinator()
        for _ in 0..<DisplayLifecycleLease.maximumCreationsPerMinute {
            try fixture.lease.begin(creation: true)
            try fixture.lease.finish()
        }
        XCTAssertThrowsError(try coordinator.perform(timeout: 3) { operation in
            try Stage.beginCheckedMutation(creation: true, operation: operation,
                                           coordinator: coordinator, lease: fixture.lease, readiness: {})
        }) { error in
            guard case SpaceOError.resourceLimit = error else {
                return XCTFail("expected the existing structured creation-rate refusal")
            }
        }
        XCTAssertEqual(try fixture.pending(), false)
        XCTAssertEqual(try fixture.attemptCount(), DisplayLifecycleLease.maximumCreationsPerMinute)
        XCTAssertNil(coordinator.failureReason)
    }


    func testPostMarkerRemovalBudgetExhaustionAcknowledgesAbortAndPreservesOwner() throws {
        let fixture = try LeaseFixture()
        let backing = Backing(), clock = Clock(), coordinator = DisplayLifecycleCoordinator()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] },
                          coordinator: coordinator, retirementNow: { clock.now() },
                          mutationLease: fixture.lease,
                          mutationMarkerDidPersist: {
                              XCTAssertEqual(try? fixture.pending(), true)
                              clock.advance(21)
                          })
        XCTAssertFalse(stage.invalidate())
        XCTAssertEqual(backing.calls, 0)
        XCTAssertTrue(stage.isValid, "an owner whose removal reserve was consumed remains retryable")
        XCTAssertEqual(stage.displayID, backing.displayID)
        XCTAssertEqual(try fixture.pending(), false)
        XCTAssertEqual(fixture.lease.cachedStatus?.state, .ready)
        XCTAssertNil(coordinator.failureReason)
    }

}
