import XCTest
import CoreGraphics
@testable import SpaceOKit

final class DisplayLifecycleContainmentTests: XCTestCase {
    func testDeferredFallbackIsVisibleWithoutTrippingAndRefusesNewCreation() throws {
        let coordinator = DisplayLifecycleCoordinator()
        coordinator.quarantineDeferred(Backing(), displayID: 99_111)
        coordinator.quarantineDeferred(Backing(), displayID: 99_111)
        XCTAssertNil(coordinator.failureReason)
        XCTAssertNoThrow(try coordinator.check(), "ongoing use is separate from new creation")
        XCTAssertThrowsError(try coordinator.requireNoDeferredRetirements())
        let status = coordinator.annotatingDeferredRetirements(.init(state: .ready))
        XCTAssertEqual(status.state, .blocked, "older clients must also refuse new creation")
        XCTAssertEqual(status.deferredRetirementDisplayIDs, [99_111])
        XCTAssertFalse(status.allowsCreation)
        let encoded = try JSONEncoder().encode(status)
        XCTAssertEqual(try JSONDecoder().decode(DisplaySafetyStatus.self, from: encoded), status)
        coordinator.clearDeferredRetirement(99_111)
        XCTAssertNoThrow(try coordinator.requireNoDeferredRetirements())
        XCTAssertTrue(coordinator.annotatingDeferredRetirements(.init(state: .ready)).allowsCreation)
    }

    func testFinalCreationAdmissionLinearizesWithFallbackRegistration() throws {
        let coordinator = DisplayLifecycleCoordinator()
        XCTAssertNoThrow(try coordinator.admitCreation())
        // Registration after the admission point cannot retroactively cancel that attachment,
        // and is visible to every subsequent admission without holding a lock across display IPC.
        coordinator.quarantineDeferred(Backing(), displayID: 99_111)
        XCTAssertThrowsError(try coordinator.admitCreation()) {
            XCTAssertTrue($0 is DisplayLifecycleCoordinator.CreationDeferred)
        }
        XCTAssertNil(coordinator.failureReason)
    }

    func testOlderSafetyStatusDecodesWithoutDeferredFallbacks() throws {
        let status = try JSONDecoder().decode(DisplaySafetyStatus.self,
                                             from: Data(#"{"state":"ready"}"#.utf8))
        XCTAssertNil(status.deferredRetirementDisplayIDs)
        XCTAssertTrue(status.allowsCreation)
    }

    private final class Backing: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID = 99_111
        private let lock = NSLock()
        private var frame = CGRect(x: 2000, y: 0, width: 1280, height: 800)
        private var gate: (() -> Void)?
        /// Runs on every geometry read, outside the lock, to simulate a slow WindowServer reply.
        func gateReads(_ gate: (() -> Void)?) { lock.withLock { self.gate = gate } }
        var bounds: CGRect {
            get {
                lock.withLock { gate }?()
                return lock.withLock { frame }
            }
            set { lock.withLock { frame = newValue } }
        }
        let pixelWidth: Int? = 2560
        let valid = true
        let block: () -> Void
        init(_ block: @escaping () -> Void = {}) { self.block = block }
        func invalidate() { block() }
    }

    private final class WeakBacking: @unchecked Sendable {
        private let lock = NSLock()
        private weak var storage: Backing?
        var value: Backing? {
            get { lock.withLock { storage } }
            set { lock.withLock { storage = newValue } }
        }
    }

    func testBlockedInventoryReturnsFalseAndNoRetryRuns() {
        let unblock = DispatchSemaphore(value: 0)
        let completed = expectation(description: "late inventory returned")
        let coordinator = DisplayLifecycleCoordinator()
        let backing = Backing()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: {
            unblock.wait()
            completed.fulfill()
            return []
        }, coordinator: coordinator)
        let start = ContinuousClock.now
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
        XCTAssertEqual(stage.displayID, 99_111)
        XCTAssertFalse(stage.isValid)
        XCTAssertNotNil(coordinator.failureReason)
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
        unblock.signal()
        wait(for: [completed], timeout: 1)
        // The late empty inventory cannot turn the failed operation back into success.
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
    }

    func testGeometryReadUsesPublishedSnapshotWhileMutationOwnsWorker() {
        let coordinator = DisplayLifecycleCoordinator()
        let backing = Backing()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] }, coordinator: coordinator)
        let expected = stage.bounds
        XCTAssertEqual(stage.backingScale, 2)
        let started = DispatchSemaphore(value: 0)
        let unblock = DispatchSemaphore(value: 0)
        let finished = expectation(description: "mutation finishes normally")
        DispatchQueue.global().async {
            do {
                try coordinator.perform(timeout: 3) { _ in
                    started.signal()
                    unblock.wait()
                }
            } catch { XCTFail("query must not trip mutation: \(error)") }
            finished.fulfill()
        }
        XCTAssertEqual(started.wait(timeout: .now() + 1), .success)
        backing.bounds = CGRect(x: 3000, y: 0, width: 2560, height: 1600)
        let start = ContinuousClock.now
        XCTAssertEqual(stage.bounds, expected)
        XCTAssertEqual(stage.backingScale, 2)
        XCTAssertLessThan(start.duration(to: .now), .seconds(0.5))
        XCTAssertNil(coordinator.failureReason)
        unblock.signal()
        wait(for: [finished], timeout: 2)
        XCTAssertEqual(stage.bounds, backing.bounds, "refresh the snapshot when the worker is idle")
        XCTAssertEqual(stage.backingScale, 1)
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0.1))
    }

    func testSlowReadOnlyQueryDefersWithoutTrippingAndRetainsItsContext() {
        let slow = expectation(description: "slow query reported off the caller")
        let coordinator = DisplayLifecycleCoordinator(
            onFailure: { _ in XCTFail("a slow read must not latch the journal") },
            onSlowQuery: { _ in slow.fulfill() })
        let unblock = DispatchSemaphore(value: 0)
        let returned = expectation(description: "late read returned")
        let observed = WeakBacking()
        var backing: Backing? = Backing { XCTFail("a late read must not detach its display") }
        observed.value = backing
        XCTAssertThrowsError(try coordinator.perform(
            timeout: 0.1, retaining: backing!, onlyWhenIdle: true, readOnly: true) { _ -> Int in
            unblock.wait()
            returned.fulfill()
            return 1
        }) { XCTAssertTrue($0 is DisplayLifecycleCoordinator.QueryDeferred, "\($0)") }
        backing = nil
        XCTAssertNil(coordinator.failureReason)
        wait(for: [slow], timeout: 1)

        // While the read is stuck, later reads defer at once instead of queueing behind it.
        let start = ContinuousClock.now
        XCTAssertThrowsError(try coordinator.perform(timeout: 1, onlyWhenIdle: true, readOnly: true) { _ in 2 }) {
            XCTAssertTrue($0 is DisplayLifecycleCoordinator.QueryDeferred, "\($0)")
        }
        XCTAssertLessThan(start.duration(to: .now), .seconds(0.5))

        unblock.signal()
        wait(for: [returned], timeout: 1)
        let deadline = Date().addingTimeInterval(2)
        while coordinator.pendingOperationCount > 0, Date() < deadline { usleep(5_000) }
        XCTAssertEqual(coordinator.pendingOperationCount, 0, "a late read releases the worker")
        XCTAssertNotNil(observed.value, "ARC must not implicitly detach a display after a late read")
        XCTAssertEqual(try coordinator.perform(timeout: 1, onlyWhenIdle: true, readOnly: true) { _ in 3 }, 3)
        XCTAssertNil(coordinator.failureReason)
    }

    func testAReadThatStartsAfterItsDeadlineIsSkippedWithoutTripping() {
        let coordinator = DisplayLifecycleCoordinator { _ in XCTFail("a starved read must not latch") }
        let expired = DispatchTime.now() - .milliseconds(1)
        XCTAssertThrowsError(try coordinator.makeOperation(deadline: expired, readOnly: true).check()) {
            XCTAssertTrue($0 is DisplayLifecycleCoordinator.QueryDeferred, "\($0)")
        }
        XCTAssertNil(coordinator.failureReason)
        XCTAssertNoThrow(try coordinator.makeOperation(deadline: .now() + 1, readOnly: true).check())

        let tripped = expectation(description: "mutation deadline opens the circuit")
        let mutations = DisplayLifecycleCoordinator { _ in tripped.fulfill() }
        XCTAssertThrowsError(try mutations.makeOperation(deadline: expired, readOnly: false).check())
        wait(for: [tripped], timeout: 1)
        XCTAssertNotNil(mutations.failureReason)
    }

    func testStalledSlowQueryLoggingCannotDelayFailurePersistence() {
        let logBlocked = DispatchSemaphore(value: 0)
        let unblockRead = DispatchSemaphore(value: 0)
        let persisted = expectation(description: "failure persisted while logging stalls")
        let coordinator = DisplayLifecycleCoordinator(
            onFailure: { _ in persisted.fulfill() },
            onSlowQuery: { _ in _ = logBlocked.wait(timeout: .now() + 3) })
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1, onlyWhenIdle: true, readOnly: true) { _ -> Int in
            _ = unblockRead.wait(timeout: .now() + 3)
            return 1
        })
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.2) { _ in })
        wait(for: [persisted], timeout: 1)
        logBlocked.signal()
        unblockRead.signal()
    }

    func testMutationBehindAStuckReadStillOpensTheCircuitAtItsDeadline() {
        let tripped = expectation(description: "circuit opened")
        let coordinator = DisplayLifecycleCoordinator { _ in tripped.fulfill() }
        let unblock = DispatchSemaphore(value: 0)
        let returned = expectation(description: "stuck read returned")
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1, onlyWhenIdle: true, readOnly: true) { _ -> Int in
            unblock.wait()
            returned.fulfill()
            return 1
        })
        XCTAssertNil(coordinator.failureReason)
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.2) { _ in
            XCTFail("a mutation must never start after its deadline")
        })
        wait(for: [tripped], timeout: 1)
        XCTAssertNotNil(coordinator.failureReason, "an unanswered worker still fails closed for mutations")
        unblock.signal()
        wait(for: [returned], timeout: 1)
    }

    func testStageGeometryKeepsItsSnapshotWhenAReadIsSlow() {
        let coordinator = DisplayLifecycleCoordinator { _ in XCTFail("a slow read must not latch") }
        let backing = Backing()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [] }, coordinator: coordinator)
        let expected = stage.bounds
        let unblock = DispatchSemaphore(value: 0)
        backing.gateReads { _ = unblock.wait(timeout: .now() + 3) }
        backing.bounds = CGRect(x: 3000, y: 0, width: 2560, height: 1600)
        XCTAssertEqual(stage.bounds, expected, "the last verified snapshot stands in for a slow read")
        XCTAssertNil(coordinator.failureReason)
        XCTAssertFalse(stage.hasLifecycleFailure)
        backing.gateReads(nil)
        unblock.signal()
        let deadline = Date().addingTimeInterval(2)
        while coordinator.pendingOperationCount > 0, Date() < deadline { usleep(5_000) }
        XCTAssertEqual(stage.bounds, backing.bounds, "refresh once the worker answers again")
        XCTAssertTrue(stage.invalidate(waitingForRemoval: 0.1))
    }

    func testFallbackPreInvalidationFailureRetainsBackingAfterStageIsDropped() {
        let failed = expectation(description: "fallback quarantine completed")
        let coordinator = DisplayLifecycleCoordinator { _ in failed.fulfill() }
        var backing: Backing? = Backing { XCTFail("failed preflight must not invalidate") }
        let observed = WeakBacking()
        observed.value = backing
        var stage: Stage? = Stage(testingBacking: backing!, onlineDisplayIDs: { [] },
            coordinator: coordinator,
            configuration: { throw SpaceOError.stageCreationFailed("preflight unavailable") })
        XCTAssertNotNil(stage)
        backing = nil
        stage = nil
        wait(for: [failed], timeout: 1)
        XCTAssertNotNil(observed.value, "fallback failure must retain the backing before Stage deallocates")
        XCTAssertNotNil(coordinator.failureReason)
    }

    func testPreInvalidationFailureRetainsBackingAfterStageIsDropped() {
        let coordinator = DisplayLifecycleCoordinator()
        var backing: Backing? = Backing { XCTFail("failed preflight must not invalidate") }
        let observed = WeakBacking()
        observed.value = backing
        var stage: Stage? = Stage(testingBacking: backing!, onlineDisplayIDs: { [] },
            coordinator: coordinator,
            configuration: { throw SpaceOError.stageCreationFailed("preflight unavailable") })
        backing = nil
        XCTAssertFalse(stage!.invalidate(waitingForRemoval: 0.1))
        stage = nil
        XCTAssertNotNil(observed.value, "retain backing to prevent implicit deallocation teardown")
        XCTAssertNotNil(coordinator.failureReason)
    }

    func testCachedLeaseStatusTracksPendingCompletionAndFailure() throws {
        try withJournal { path in
            let lease = DisplayLifecycleLease(path: path)
            XCTAssertNil(lease.cachedStatus)
            try lease.acquire()
            XCTAssertEqual(lease.cachedStatus?.state, .ready)
            try lease.begin(creation: false)
            XCTAssertEqual(lease.cachedStatus?.state, .blocked)
            try lease.finish()
            XCTAssertEqual(lease.cachedStatus?.state, .ready)
            // A response uses the acquired owner's snapshot, without reopening the journal.
            try Data("unreadable external replacement".utf8).write(to: URL(fileURLWithPath: path))
            XCTAssertEqual(lease.cachedStatus?.state, .ready)
            lease.trip("injected failure")
            XCTAssertEqual(lease.cachedStatus?.state, .blocked)
        }
    }

    func testBlockedBackingInvalidationAlsoHasABoundedCaller() {
        let unblock = DispatchSemaphore(value: 0)
        let completed = expectation(description: "backing returned")
        let stage = Stage(testingBacking: Backing {
            unblock.wait()
            completed.fulfill()
        }, onlineDisplayIDs: {
            XCTFail("must not query after a timed-out mutation")
            return []
        })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
        XCTAssertEqual(stage.displayID, 99_111)
        unblock.signal()
        wait(for: [completed], timeout: 1)
    }

    func testBlockedFailurePersistenceCannotExtendTheCallerDeadlineIndefinitely() {
        let unblockWorker = DispatchSemaphore(value: 0)
        let unblockFailure = DispatchSemaphore(value: 0)
        let saved = expectation(description: "failure persistence released")
        let coordinator = DisplayLifecycleCoordinator { _ in
            unblockFailure.wait()
            saved.fulfill()
        }
        let start = ContinuousClock.now
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1) { _ in unblockWorker.wait() })
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
        XCTAssertNotNil(coordinator.failureReason)
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1) { _ in XCTFail("must not restart work") })
        unblockWorker.signal()
        unblockFailure.signal()
        wait(for: [saved], timeout: 1)
    }

    func testFailedInventoryIsUnknownRatherThanSuccessfulRemoval() {
        let stage = Stage(testingBacking: Backing(), onlineDisplayIDs: {
            throw SpaceOError.stageCreationFailed("injected display service failure")
        })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
        XCTAssertEqual(stage.displayID, 99_111)
    }

    func testManagerDoesNotReenterDisplayIPCToPruneATimedOutRetirement() async throws {
        let stage = Stage(testingBacking: Backing(), onlineDisplayIDs: {
            throw SpaceOError.stageCreationFailed("injected unavailable inventory")
        })
        let pool = DisplayPool(stageFactory: { _, _, _, _ in stage },
                               stageRetirer: { $0.invalidate(waitingForRemoval: 0.1) })
        let manager = SessionManager(pool: pool, runJanitor: false,
                                     onlineDisplayIDs: {
            XCTFail("must preserve unknown display IDs without another synchronous query")
            return []
        }, sessionFactory: { AgentSession(id: $0, slot: $1) })
        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok)
        var destroy = TestController.request("session.destroy")
        destroy.full = true
        let result = await manager.handle(destroy)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.teardown?.stillAttachedDisplayIDs, [99_111])
        let ping = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(ping.message?.contains("failed display teardown: [99111]") == true)
        let lost = await manager.revalidateDisplays(reason: "injected test event")
        XCTAssertTrue(lost.isEmpty)
    }

    func testLateCreationResultIsRetainedWithoutImplicitTeardown() {
        let unblock = DispatchSemaphore(value: 0)
        let completed = expectation(description: "late creation stopped")
        let coordinator = DisplayLifecycleCoordinator()
        let observed = WeakBacking()
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1) { operation in
            unblock.wait()
            let backing = Backing()
            operation.retain(backing)
            observed.value = backing
            defer { completed.fulfill() }
            try operation.check()
            XCTFail("a late creation must not be published")
        })
        unblock.signal()
        wait(for: [completed], timeout: 1)
        XCTAssertNotNil(observed.value, "ARC must not implicitly detach a late display")
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1) { _ in
            XCTFail("circuit must reject subsequent work")
        })
    }

    func testQueuedOperationNeverStartsAfterItsDeadlineTripsTheCircuit() {
        let coordinator = DisplayLifecycleCoordinator()
        let started = DispatchSemaphore(value: 0)
        let unblock = DispatchSemaphore(value: 0)
        let finished = expectation(description: "first operation stopped")
        DispatchQueue.global().async {
            do {
                try coordinator.perform(timeout: 2) { operation in
                    started.signal()
                    unblock.wait()
                    try operation.check()
                }
                XCTFail("the first operation must observe the circuit failure")
            } catch { /* Expected: the queued operation's deadline opened the circuit. */ }
            finished.fulfill()
        }
        XCTAssertEqual(started.wait(timeout: .now() + 1), .success)
        XCTAssertThrowsError(try coordinator.perform(timeout: 0.1) { _ in
            XCTFail("a timed-out queued operation must never execute")
        })
        unblock.signal()
        wait(for: [finished], timeout: 1)
    }

    func testRetirementPreambleConsumesTheSameDeadlineAndCannotInvalidateLate() {
        let unblock = DispatchSemaphore(value: 0)
        let returned = expectation(description: "late preflight returned")
        let stage = Stage(testingBacking: Backing { XCTFail("expired preflight must not detach a display") },
                          onlineDisplayIDs: { XCTFail("expired preflight must not query removal"); return [] },
                          configuration: {
            unblock.wait()
            returned.fulfill()
            return nil
        })
        XCTAssertFalse(stage.invalidate(waitingForRemoval: 0.1))
        unblock.signal()
        wait(for: [returned], timeout: 1)
        XCTAssertTrue(stage.hasLifecycleFailure)
    }

    func testPoolNeverPublishesAllocationAfterLifecycleFailure() throws {
        for exclusive in [false, true] {
            let coordinator = DisplayLifecycleCoordinator()
            let stage = Stage(testingBacking: Backing(), onlineDisplayIDs: { [] }, coordinator: coordinator)
            coordinator.trip("injected managed-Space query deadline")
            let pool = DisplayPool(stageFactory: { _, _, _, _ in stage })
            XCTAssertThrowsError(try exclusive ? pool.allocateExclusive() : pool.allocate())
            XCTAssertEqual(pool.sessionCount, 0)
            XCTAssertEqual(pool.displayCount, 0)
        }
    }

    private func withJournal(_ body: (String) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory.appendingPathComponent("safety.json").path)
    }

    func testDiagnosticCreationBudgetKeepsBoundedHistoryAndConstrainsNormalRestart() throws {
        try withJournal { path in
            let start = Date(timeIntervalSince1970: 2_000_000_000)
            var diagnostic: DisplayLifecycleLease? = DisplayLifecycleLease(path: path, testingOverride: true)
            try diagnostic!.acquire()
            XCTAssertEqual(diagnostic!.cachedStatus?.creationRateTestingOverride, true)
            let status = try XCTUnwrap(diagnostic!.cachedStatus)
            let decoded = try Wire.decoder.decode(DisplaySafetyStatus.self, from: Wire.encoder.encode(status))
            XCTAssertEqual(decoded.creationRateTestingOverride, true)
            for index in 0..<100 {
                try diagnostic!.begin(creation: true, now: start.addingTimeInterval(Double(index)))
                try diagnostic!.finish()
            }
            let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
            XCTAssertLessThanOrEqual(bytes.count, 4096)
            let journal = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let attempts = try XCTUnwrap(journal["attempts"] as? [Double])
            let day = try XCTUnwrap(journal["dayAttempts"] as? [Double])
            XCTAssertEqual(attempts.count, DisplayLifecycleLease.maximumCreationsPerTenMinutes)
            XCTAssertEqual(day.count, DisplayLifecycleLease.maximumCreationsPerDay)
            XCTAssertEqual(day.first, start.addingTimeInterval(68).timeIntervalSince1970)
            XCTAssertEqual(day.last, start.addingTimeInterval(99).timeIntervalSince1970)
            diagnostic = nil
            let normal = DisplayLifecycleLease(path: path, testingOverride: false)
            try normal.acquire()
            XCTAssertThrowsError(try normal.begin(creation: true, now: start.addingTimeInterval(100)))
            // The 32nd most recent entry expires exactly here; older omitted entries have
            // already expired, so restoring normal admission cannot undercount live history.
            try normal.begin(creation: true, now: start.addingTimeInterval(86_468))
            try normal.finish()
        }
    }

    func testEverySafetyReportPathRecordsDiagnosticCreationOverride() throws {
        try withJournal { path in
            // Doctor inspects read-only, possibly before any owner has acquired the lease.
            let unowned = DisplayLifecycleLease.status(path: path, testingOverride: true)
            XCTAssertEqual(unowned.state, .ready)
            XCTAssertEqual(unowned.creationRateTestingOverride, true)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path))
            let decoded = try Wire.decoder.decode(DisplaySafetyStatus.self, from: Wire.encoder.encode(unowned))
            XCTAssertEqual(decoded.creationRateTestingOverride, true)
            XCTAssertNil(DisplayLifecycleLease.status(path: path, testingOverride: false).creationRateTestingOverride)
            var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path, testingOverride: false)
            try owner!.acquire()
            owner!.trip("injected timeout")
            let blocked = DisplayLifecycleLease.status(path: path, testingOverride: true)
            XCTAssertEqual(blocked.state, .blocked)
            XCTAssertEqual(blocked.creationRateTestingOverride, true)
            owner = nil
            try Data("invalid".utf8).write(to: URL(fileURLWithPath: path))
            let unknown = DisplayLifecycleLease.status(path: path, testingOverride: true)
            XCTAssertEqual(unknown.state, .unknown)
            XCTAssertEqual(unknown.creationRateTestingOverride, true)
        }
        // Circuit failures and deferred retirements build their own status in Stage.
        let coordinator = DisplayLifecycleCoordinator()
        coordinator.quarantineDeferred(Backing(), displayID: 99_112)
        let deferred = Stage.reportedSafety(.init(state: .ready), coordinator: coordinator, testingOverride: true)
        XCTAssertEqual(deferred.state, .blocked)
        XCTAssertEqual(deferred.deferredRetirementDisplayIDs, [99_112])
        XCTAssertEqual(deferred.creationRateTestingOverride, true, "replacing a ready status keeps the bypass")
        coordinator.trip("injected circuit failure")
        let circuit = Stage.reportedSafety(.init(state: .blocked, reason: coordinator.failureReason),
                                           coordinator: coordinator, testingOverride: true)
        XCTAssertEqual(circuit.reason, coordinator.failureReason)
        XCTAssertEqual(circuit.creationRateTestingOverride, true)
        XCTAssertNil(Stage.reportedSafety(.init(state: .unknown), coordinator: coordinator,
                                          testingOverride: false).creationRateTestingOverride)
    }

    func testDiagnosticBudgetDoesNotClearPendingMutationOrPermitClockRollback() throws {
        try withJournal { path in
            let start = Date(timeIntervalSince1970: 2_000_000_000)
            var diagnostic: DisplayLifecycleLease? = DisplayLifecycleLease(path: path, testingOverride: true)
            try diagnostic!.acquire()
            try diagnostic!.begin(creation: true, now: start)
            try diagnostic!.finish()
            XCTAssertThrowsError(try diagnostic!.begin(creation: true, now: start.addingTimeInterval(-1)))
            try diagnostic!.begin(creation: true, now: start.addingTimeInterval(1))
            diagnostic = nil // Retain the unfinished mutation.
            let restarted = DisplayLifecycleLease(path: path, testingOverride: true)
            XCTAssertThrowsError(try restarted.acquire())
        }
    }

    func testDailyBudgetSurvivesRestartAndAllowsRetirement() throws {
        try withJournal { path in
            var lease: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try lease!.acquire()
            let start = Date(timeIntervalSince1970: 1000)
            for index in 0..<32 {
                try lease!.begin(creation: true, now: start.addingTimeInterval(Double(index * 601)))
                try lease!.finish()
            }
            lease = nil
            let restarted = DisplayLifecycleLease(path: path)
            try restarted.acquire()
            let refusedAt = start.addingTimeInterval(32 * 601)
            XCTAssertThrowsError(try restarted.begin(creation: true, now: refusedAt)) { error in
                guard case SpaceOError.resourceLimit(.creationRate, _, let retry) = error else {
                    return XCTFail("wrong error: \(error)")
                }
                XCTAssertEqual(retry, 86_400 - 32 * 601)
            }
            try restarted.begin(creation: false, now: refusedAt)
            try restarted.finish()
            try restarted.begin(creation: true, now: start.addingTimeInterval(86_400))
            try restarted.finish()
        }
    }

    func testLeaseExcludesOtherOwnersAndRetainsRateHistoryAcrossRestart() throws {
        try withJournal { path in
            var first: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try first!.acquire()
            let other = DisplayLifecycleLease(path: path)
            XCTAssertThrowsError(try other.acquire())
            let now = Date(timeIntervalSince1970: 1000)
            for _ in 0..<4 {
                try first!.begin(creation: true, now: now)
                try first!.finish()
            }
            XCTAssertThrowsError(try first!.begin(creation: true, now: now))
            first = nil
            try other.acquire()
            XCTAssertThrowsError(try other.begin(creation: true, now: now))
            try other.begin(creation: true, now: now.addingTimeInterval(60))
            try other.finish()
        }
    }

    func testInterruptedMutationAndCircuitFailureSurviveRestart() throws {
        for trip in [false, true] {
            try withJournal { path in
                var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
                try owner!.acquire()
                try owner!.begin(creation: true)
                if trip { owner!.trip("injected timeout") }
                owner = nil
                let restarted = DisplayLifecycleLease(path: path)
                XCTAssertThrowsError(try restarted.acquire())
            }
        }
    }

    func testLiveFailureBeforeAnyDisplayMutationSurvivesRestart() throws {
        try withJournal { path in
            var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try owner!.acquire()
            try owner!.beginLiveTest()
            // No Stage, mutation or failure callback is needed for interruption to persist.
            owner = nil
            let restarted = DisplayLifecycleLease(path: path)
            XCTAssertThrowsError(try restarted.acquire())
            XCTAssertThrowsError(try restarted.acquire(), "a second acquire must not bypass the latch")
        }
    }

    func testCompletedLiveCaseAllowsMutationAndAnotherCaseAndRestart() throws {
        try withJournal { path in
            var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try owner!.acquire()
            for _ in 0..<2 {
                try owner!.beginLiveTest()
                try owner!.begin(creation: true)
                try owner!.finish()
                try owner!.finishLiveTest()
            }
            owner = nil
            try DisplayLifecycleLease(path: path).acquire()
        }
    }

    func testTenMinuteBudgetCannotBeBypassedByPerMinutePacing() throws {
        try withJournal { path in
            let lease = DisplayLifecycleLease(path: path)
            try lease.acquire()
            let start = Date(timeIntervalSince1970: 1000)
            for index in 0..<12 {
                try lease.begin(creation: true, now: start.addingTimeInterval(Double(index * 30)))
                try lease.finish()
            }
            XCTAssertThrowsError(try lease.begin(creation: true, now: start.addingTimeInterval(360))) { error in
                guard case let SpaceOError.resourceLimit(_, _, retry) = error else {
                    return XCTFail("expected a creation budget refusal")
                }
                XCTAssertEqual(retry, 240)
            }
            try lease.begin(creation: true, now: start.addingTimeInterval(600))
            try lease.finish()
            XCTAssertThrowsError(try lease.begin(creation: true, now: start))
        }
    }

    func testMinuteBudgetReturnsItsActualRemainingWait() throws {
        try withJournal { path in
            let lease = DisplayLifecycleLease(path: path)
            try lease.acquire()
            let start = Date(timeIntervalSince1970: 1000)
            for _ in 0..<4 { try lease.begin(creation: true, now: start); try lease.finish() }
            XCTAssertThrowsError(try lease.begin(creation: true, now: start.addingTimeInterval(12))) { error in
                guard case let SpaceOError.resourceLimit(_, _, retry) = error else {
                    return XCTFail("expected a creation budget refusal")
                }
                XCTAssertEqual(retry, 48)
            }
        }
    }

    func testDiagnosticReportsLatchesWithoutTakingLeaseOrChangingJournal() throws {
        try withJournal { path in
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path))
            let owner = DisplayLifecycleLease(path: path)
            try owner.acquire()
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
            try owner.beginLiveTest()
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked)
            try owner.finishLiveTest()
            try owner.begin(creation: true)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .blocked)
            try owner.finish()
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .ready)
            owner.trip("injected timeout")
            let before = try Data(contentsOf: URL(fileURLWithPath: path))
            XCTAssertEqual(DisplayLifecycleLease.status(path: path),
                           DisplaySafetyStatus(state: .blocked, reason: "injected timeout"))
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), before)
        }
    }

    func testDiagnosticDeadlineDoesNotStartReplacementReadsOrAcceptLateHealth() {
        let worker = DisplayLifecycleCoordinator()
        let release = DispatchSemaphore(value: 0)
        let completed = expectation(description: "late reader completed")
        let start = Date()
        let result = DisplayLifecycleLease.inspectStatus(using: worker, timeout: 0.1) {
            release.wait()
            completed.fulfill()
            return .init(state: .ready)
        }
        XCTAssertEqual(result.state, .unknown)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        XCTAssertEqual(DisplayLifecycleLease.inspectStatus(using: worker) {
            XCTFail("a timed-out reader must not start replacement work")
            return .init(state: .ready)
        }.state, .unknown)
        release.signal()
        wait(for: [completed], timeout: 1)
        XCTAssertEqual(DisplayLifecycleLease.inspectStatus(using: worker) {
            XCTFail("late completion must not clear failed inspection")
            return .init(state: .ready)
        }.state, .unknown)
    }

    func testDiagnosticRefusesMalformedNonPrivateAndNonRegularJournals() throws {
        try withJournal { path in
            var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try owner!.acquire()
            owner = nil
            try Data("invalid".utf8).write(to: URL(fileURLWithPath: path))
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .unknown)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .unknown)
            try FileManager.default.removeItem(atPath: path)
            XCTAssertEqual(mkfifo(path, 0o600), 0)
            XCTAssertEqual(DisplayLifecycleLease.status(path: path).state, .unknown)
        }
    }

    func testMalformedOrNonPrivateJournalRefusesAdmission() throws {
        try withJournal { path in
            var owner: DisplayLifecycleLease? = DisplayLifecycleLease(path: path)
            try owner!.acquire()
            owner = nil
            try Data("invalid".utf8).write(to: URL(fileURLWithPath: path))
            XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire())
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
            XCTAssertThrowsError(try DisplayLifecycleLease(path: path).acquire())
        }
    }
}
