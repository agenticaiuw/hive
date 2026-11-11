import XCTest
import CoreGraphics
import ImageIO
@testable import SpaceOKit

/// The agent-ergonomics commands (drain, batches, clipboard broker, annotation, hand-off notes,
/// event stream, persist-on-change) driven through `SessionManager.handle` like a socket client,
/// against a fake display so nothing touches the WindowServer.
final class ErgonomicsCommandTests: XCTestCase {

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
        private let lock = NSLock()
        private var ledger: SessionLedger?
        private(set) var saveCount = 0

        func load() -> SessionLedger? { lock.withLock { ledger } }
        func save(_ ledger: SessionLedger) throws {
            lock.withLock {
                saveCount += 1
                self.ledger = ledger
            }
        }
        var saves: Int { lock.withLock { saveCount } }
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
        persistence: LiveSessionPersistence? = nil,
        waitRuntime: WaitRuntime = .live,
        recordingRootDirectory: URL? = nil,
        recordingFrameCapture: RecordingFrameCapture = RecordingFrameCapture(),
        isolationPreflight: @escaping @Sendable () -> IsolationReport? = { nil }
    ) throws -> SessionManager {
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 2,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        if let persistence {
            return try SessionManager(
                pool: pool,
                runJanitor: false,
                waitRuntime: waitRuntime,
                livePersistence: persistence,
                recordingRootDirectory: recordingRootDirectory,
                recordingFrameCapture: recordingFrameCapture,
                isolationPreflight: isolationPreflight,
                sessionFactory: { AgentSession(id: $0, slot: $1) })
        }
        return SessionManager(
            pool: pool,
            runJanitor: false,
            waitRuntime: waitRuntime,
            recordingRootDirectory: recordingRootDirectory,
            recordingFrameCapture: recordingFrameCapture,
            isolationPreflight: isolationPreflight,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
    }

    @discardableResult
    private func create(
        _ manager: SessionManager,
        name: String,
        ownerID: String = "unit-test-controller",
        leaseID: UUID = TestController.leaseID
    ) async -> Response {
        let response = await manager.handle(
            TestController.createRequest(session: name, ownerID: ownerID, leaseID: leaseID))
        XCTAssertTrue(response.ok, response.error ?? "")
        return response
    }

    // MARK: - Drain (SPAO-204)

    func testDrainRefusesNewSessionsAndKeepsServingExistingOnes() async throws {
        let manager = try makeManager(displayID: 96_001)
        await create(manager, name: "alpha")

        var drain = Request(cmd: "daemon.drain")
        drain.operatorScope = true
        drain.timeout = 900  // the CLI's default restart patience, beyond the command bound
        let draining = await manager.handle(drain)
        XCTAssertTrue(draining.ok, draining.error ?? "")
        let isDraining = await manager.isDrainingNow
        XCTAssertTrue(isDraining)

        let refused = await manager.handle(TestController.createRequest(session: "beta"))
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "daemon_draining")
        XCTAssertEqual(refused.recovery?.tool, "spaceo_session_create")

        let listed = await manager.handle(TestController.request("session.list"))
        XCTAssertTrue(listed.ok, listed.error ?? "")
        XCTAssertEqual(listed.sessions?.map(\.id), ["alpha"])

        var unscoped = Request(cmd: "daemon.drain")
        let refusedDrain = await manager.handle(unscoped)
        XCTAssertFalse(refusedDrain.ok, "drain crosses controller boundaries and needs operator scope")
        unscoped.operatorScope = true
    }

    // MARK: - Batches (SPAO-208)

    func testBatchValidatesShapeAndStopsAtTheFirstFailure() async throws {
        let manager = try makeManager(displayID: 96_002)
        await create(manager, name: "batch")

        var tooMany = TestController.request("steps.run", session: "batch")
        tooMany.steps = (0..<17).map { _ in
            var step = Request(cmd: "click"); step.element = "1"; return step
        }
        let refusedCount = await manager.handle(tooMany)
        XCTAssertFalse(refusedCount.ok)
        XCTAssertEqual(refusedCount.errorCode, "bad_request")

        var nested = TestController.request("steps.run", session: "batch")
        var outer = Request(cmd: "click"); outer.element = "1"; outer.steps = [Request(cmd: "click")]
        nested.steps = [outer]
        let refusedNesting = await manager.handle(nested)
        XCTAssertFalse(refusedNesting.ok)
        XCTAssertTrue(refusedNesting.error?.contains("nest") == true, refusedNesting.error ?? "")

        var forbidden = TestController.request("steps.run", session: "batch")
        forbidden.steps = [Request(cmd: "session.destroy")]
        let refusedCommand = await manager.handle(forbidden)
        XCTAssertFalse(refusedCommand.ok)
        XCTAssertTrue(refusedCommand.error?.contains("batches accept") == true, refusedCommand.error ?? "")

        // Step 0 fails (there is no window to click); step 1 must not run.
        var batch = TestController.request("steps.run", session: "batch")
        var first = Request(cmd: "click"); first.element = "3"
        var second = Request(cmd: "key"); second.key = "return"
        batch.steps = [first, second]
        let result = await manager.handle(batch)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.firstFailureIndex, 0)
        XCTAssertEqual(result.steps?.count, 2)
        XCTAssertEqual(result.steps?[0].executed, true)
        XCTAssertEqual(result.steps?[0].ok, false)
        XCTAssertEqual(result.steps?[1].executed, false)
        XCTAssertEqual(result.steps?[1].errorCode, "not_executed")

        var foreign = Request(cmd: "steps.run")
        foreign.session = "batch"
        foreign.controllerLeaseID = UUID()
        foreign.steps = [first]
        let refusedLease = await manager.handle(foreign)
        XCTAssertFalse(refusedLease.ok)
        XCTAssertTrue(refusedLease.error?.contains("lease") == true, refusedLease.error ?? "")
    }

    private final class WaitClock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = Date(timeIntervalSince1970: 1000)
        private var hold: XCTestExpectation?
        private var continuation: CheckedContinuation<Void, Never>?
        init(hold: XCTestExpectation? = nil) { self.hold = hold }
        var runtime: WaitRuntime {
            WaitRuntime(now: { self.lock.withLock { self.time } }, sleep: { duration in
                let hold = self.lock.withLock { let value = self.hold; self.hold = nil; return value }
                if let hold {
                    await withCheckedContinuation { continuation in
                        self.lock.withLock { self.continuation = continuation }
                        hold.fulfill()
                    }
                }
                try Task.checkCancellation()
                self.lock.withLock { self.time = self.time.addingTimeInterval(duration) }
            })
        }
        func advance(_ seconds: TimeInterval) {
            lock.withLock { time = time.addingTimeInterval(seconds) }
        }
        func resume() {
            let pending = lock.withLock { let value = continuation; continuation = nil; return value }
            pending?.resume()
        }
    }

    private func pauseStep(_ milliseconds: Int, timeout: Double? = nil) -> Request {
        var step = Request(cmd: "wait")
        step.waitCondition = "ms"
        step.waitValue = String(milliseconds)
        step.timeout = timeout
        return step
    }

    func testBatchWaitReleasesGateAndHonoursPauseBeforeNextStep() async throws {
        let sleeping = expectation(description: "batch sleeping")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_020, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1000), pauseStep(1)]
        let batch = Task { await manager.handle(request) }
        await fulfillment(of: [sleeping], timeout: 2)
        let paused = expectation(description: "pause completes while batch is sleeping")
        let pause = Task {
            var control = TestController.request("session.control", session: "batch")
            control.paused = true
            let result = await manager.handle(control)
            paused.fulfill()
            return result
        }
        await fulfillment(of: [paused], timeout: 1)
        clock.resume()
        let pauseResult = await pause.value
        XCTAssertTrue(pauseResult.ok, pauseResult.error ?? "")
        let result = await batch.value
        XCTAssertEqual(result.firstFailureIndex, 1)
        XCTAssertEqual(result.steps?[0].completion, "met")
        XCTAssertEqual(result.steps?[1].errorCode, "session_paused")
        XCTAssertEqual(result.steps?[1].executed, false)
    }

    func testBatchWaitCannotContinueInAReplacementSession() async throws {
        let sleeping = expectation(description: "wait suspended")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_021, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1000), pauseStep(1)]
        let batch = Task { await manager.handle(request) }
        await fulfillment(of: [sleeping], timeout: 2)
        let replaced = expectation(description: "replacement completes during wait")
        let replacement = Task {
            let destroyed = await manager.handle(TestController.request("session.destroy", session: "batch"))
            XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
            let created = await manager.handle(TestController.createRequest(session: "batch"))
            replaced.fulfill()
            return created
        }
        await fulfillment(of: [replaced], timeout: 1)
        clock.resume()
        let replacementResult = await replacement.value
        XCTAssertTrue(replacementResult.ok, replacementResult.error ?? "")
        let result = await batch.value
        XCTAssertEqual(result.firstFailureIndex, 0)
        XCTAssertEqual(result.steps?[0].errorCode, "application_exited")
        XCTAssertEqual(result.steps?[1].executed, false)
        XCTAssertNil(result.session)
    }

    func testBatchTimeoutStopsDependentStepsUnlessExplicitlyConfiguredToContinue() async throws {
        let clock = WaitClock()
        let manager = try makeManager(displayID: 96_022, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        for stop in [true, false] {
            var request = TestController.request("steps.run", session: "batch")
            request.steps = [pauseStep(1000, timeout: 0.5), pauseStep(1)]
            request.stopOnFailure = stop
            let result = await manager.handle(request)
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.firstFailureIndex, 0)
            XCTAssertEqual(result.steps?[0].completion, "timeout")
            XCTAssertEqual(result.steps?[0].errorCode, "wait_timeout")
            XCTAssertEqual(result.steps?[1].executed, !stop)
        }
    }

    func testBatchTimeBudgetStopsEvenWhenContinueOnFailureWasRequested() async throws {
        let clock = WaitClock()
        let manager = try makeManager(displayID: 96_025, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "batch", mode: .actions, rootDirectory: root)
        await manager.installRecordingFixture(recorder, sessionID: "batch")
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(30_000, timeout: 30), pauseStep(30_000, timeout: 30), Request(cmd: "click"), Request(cmd: "type")]
        request.stopOnFailure = false
        let result = await manager.handle(request)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.firstFailureIndex, 2)
        XCTAssertEqual(result.steps?[0].completion, "met")
        XCTAssertEqual(result.steps?[1].completion, "met")
        XCTAssertEqual(result.steps?[2].errorCode, "batch_timeout")
        XCTAssertEqual(result.steps?[2].executed, false)
        XCTAssertEqual(result.steps?[3].executed, false)
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let action = try SessionRecorder.decoder.decode(RecordedAction.self, from: data)
        XCTAssertEqual(action.cmd, "steps.run", "deadline-skipped input must not produce action receipts")
    }

    func testCancelledBatchPreservesReceiptsAndSkipsRemainingSteps() async throws {
        let sleeping = expectation(description: "wait suspended")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_023, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1000), pauseStep(1)]
        request.stopOnFailure = false
        let batch = Task { await manager.handle(request) }
        await fulfillment(of: [sleeping], timeout: 2)
        batch.cancel()
        clock.resume()
        let result = await batch.value
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.steps?[0].completion, "cancelled")
        XCTAssertEqual(result.steps?[0].errorCode, "wait_cancelled")
        XCTAssertEqual(result.steps?[1].executed, false)
    }

    func testInitialWaitQueueTimeoutReturnsBeforeHolderReleases() async throws {
        let manager = try makeManager(displayID: 96_036)
        await create(manager, name: "wait")
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        var request = TestController.request("wait", session: "wait")
        request.waitCondition = "ms"
        request.waitValue = "1"
        request.timeout = 0.5
        let returned = expectation(description: "queue timeout returns while holder remains")
        let waiting = Task { let response = await manager.handle(request); returned.fulfill(); return response }
        await fulfillment(of: [returned], timeout: 2)
        // Release even on a failing implementation, so the regression cannot hang the suite.
        let remaining = gate.pendingCount
        holder.finish()
        let response = await waiting.value
        XCTAssertEqual(remaining, 0)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "wait_queue_timeout")
        XCTAssertTrue(response.error?.contains("initial admission") == true)
        XCTAssertNil(response.wait)
        XCTAssertNil(response.session)
        XCTAssertNotNil(response.recovery)
    }

    func testInitialBatchQueueTimeoutReturnsWithoutStartingSteps() async throws {
        let manager = try makeManager(displayID: 96_038)
        await create(manager, name: "batch")
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1)]
        request.timeout = 0.5
        let returned = expectation(description: "batch initial admission expires")
        let batch = Task { let result = await manager.handle(request); returned.fulfill(); return result }
        await fulfillment(of: [returned], timeout: 2)
        let pending = gate.pendingCount
        holder.finish()
        let response = await batch.value
        XCTAssertEqual(pending, 0)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "batch_queue_timeout")
        XCTAssertTrue(response.error?.contains("no steps executed") == true)
        XCTAssertNil(response.steps)
        XCTAssertNil(response.session)
        XCTAssertNotNil(response.recovery)
    }

    private func awaitQueued(_ count: Int, on gate: SessionOperationGate) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while gate.pendingCount < count, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(gate.pendingCount, count)
    }

    func testBatchInitialQueueConsumesStepBudget() async throws {
        let clock = WaitClock()
        let manager = try makeManager(displayID: 96_039, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1), Request(cmd: "click")]
        request.timeout = 1
        request.stopOnFailure = false
        let batch = Task { await manager.handle(request) }
        await awaitQueued(1, on: gate)
        clock.advance(0.75)
        holder.finish()
        let response = await batch.value
        XCTAssertEqual(response.errorCode, "batch_timeout")
        XCTAssertEqual(response.steps?.map(\.executed), [false, false])
        XCTAssertEqual(response.firstFailureIndex, 0)
    }

    func testBatchInvalidTimeoutDoesNotArmAnInvalidAdmissionTimer() async throws {
        let manager = try makeManager(displayID: 96_041)
        await create(manager, name: "batch")
        for timeout in [Double.nan, .infinity, -1, 0.3, 121] {
            var request = TestController.request("steps.run", session: "batch")
            request.steps = [pauseStep(1)]
            request.timeout = timeout
            let response = await manager.handle(request)
            XCTAssertFalse(response.ok)
            XCTAssertEqual(response.errorCode, "bad_request")
            XCTAssertNil(response.steps)
        }
    }

    func testBatchFinalQueueTimeoutPreservesSuccessfulReceipt() async throws {
        let response = try await batchBlockedAfterFirstStep(remainingSteps: [], cancel: false)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "batch_queue_timeout")
        XCTAssertNil(response.firstFailureIndex, "finalization failure is not a failed step")
        XCTAssertEqual(response.steps?.count, 1)
        XCTAssertEqual(response.steps?.first?.completion, "met")
        XCTAssertEqual(response.steps?.first?.ok, true)
        XCTAssertTrue(response.warnings?.contains { $0.contains("do not replay completed steps") } == true)
        XCTAssertTrue(response.recovery?.then.contains("do not replay completed steps") == true)
    }

    func testBatchStepQueueTimeoutSkipsInputEvenWhenContinueWasRequested() async throws {
        let response = try await batchBlockedAfterFirstStep(
            remainingSteps: [Request(cmd: "click"), Request(cmd: "type")], cancel: false)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "batch_timeout")
        XCTAssertEqual(response.firstFailureIndex, 1)
        XCTAssertEqual(response.steps?.map(\.executed), [true, false, false])
        XCTAssertEqual(response.steps?.first?.completion, "met")
        XCTAssertEqual(response.steps?[1].errorCode, "batch_timeout")
        XCTAssertEqual(response.steps?[2].errorCode, "not_executed")
    }

    func testCancelledBatchStepAdmissionDoesNotClaimExecution() async throws {
        let response = try await batchBlockedAfterFirstStep(
            remainingSteps: [Request(cmd: "click"), Request(cmd: "type")], cancel: true)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.firstFailureIndex, 1)
        XCTAssertEqual(response.steps?.map(\.executed), [true, false, false])
        XCTAssertEqual(response.steps?.first?.completion, "met")
    }

    private func batchBlockedAfterFirstStep(remainingSteps: [Request], cancel: Bool) async throws -> Response {
        let sleeping = expectation(description: "first step sleeping")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_040, waitRuntime: clock.runtime)
        await create(manager, name: "batch")
        var request = TestController.request("steps.run", session: "batch")
        request.steps = [pauseStep(1)] + remainingSteps
        request.timeout = 1
        request.stopOnFailure = false
        let returned = expectation(description: "batch returns before holder releases")
        let batch = Task { let result = await manager.handle(request); returned.fulfill(); return result }
        await fulfillment(of: [sleeping], timeout: 2)
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        clock.resume()
        await awaitQueued(1, on: gate) // The nested wait's final authorization.
        let nextHolder = Task { try await gate.enter() }
        await awaitQueued(2, on: gate)
        holder.finish()
        let blocker = try await nextHolder.value
        defer { blocker.finish() }
        await awaitQueued(1, on: gate) // The next step, or the batch's final authorization.
        clock.advance(1)
        if cancel { batch.cancel() }
        await fulfillment(of: [returned], timeout: 2)
        let pending = gate.pendingCount
        blocker.finish() // Also allow a regressed implementation to finish after the assertion.
        let response = await batch.value
        XCTAssertEqual(pending, 0)
        XCTAssertNil(response.session)
        XCTAssertNil(response.readiness)
        XCTAssertNil(response.snapshotID)
        XCTAssertNil(response.handoff)
        XCTAssertNil(response.isolation)
        return response
    }

    func testFinalWaitQueueTimeoutDoesNotPublishUnreauthorizedMetadata() async throws {
        let sleeping = expectation(description: "plain wait sleeping")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_037, waitRuntime: clock.runtime)
        await create(manager, name: "wait")
        var request = TestController.request("wait", session: "wait")
        request.waitCondition = "ms"
        request.waitValue = "1"
        request.timeout = 0.5
        let returned = expectation(description: "final authorization timeout")
        let waiting = Task { let response = await manager.handle(request); returned.fulfill(); return response }
        await fulfillment(of: [sleeping], timeout: 1)
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        clock.advance(1)
        clock.resume()
        await fulfillment(of: [returned], timeout: 1)
        let remaining = gate.pendingCount
        holder.finish()
        let response = await waiting.value
        XCTAssertEqual(remaining, 0)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "wait_queue_timeout")
        XCTAssertTrue(response.error?.contains("final authorization") == true)
        XCTAssertNil(response.session)
        XCTAssertNil(response.readiness)
        XCTAssertNil(response.snapshotID)
        XCTAssertNil(response.handoff)
        XCTAssertNil(response.wait)
    }

    func testQueuedWaitProbeSkipsObservationAfterItsDeadline() async throws {
        let sleeping = expectation(description: "first probe completed and wait sleeping")
        let clock = WaitClock(hold: sleeping)
        let manager = try makeManager(displayID: 96_033, waitRuntime: clock.runtime)
        await create(manager, name: "wait")
        var request = TestController.request("wait", session: "wait")
        request.waitCondition = "window_title_contains"
        request.waitValue = "No windows in fixture"
        request.timeout = 1
        let waiting = Task { await manager.handle(request) }
        await fulfillment(of: [sleeping], timeout: 1)
        let gate = await manager.operationGate
        let holder = try await gate.enter()
        defer { holder.finish() }
        clock.resume()
        let queuedDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while gate.pendingCount == 0 && ContinuousClock.now < queuedDeadline { await Task.yield() }
        XCTAssertEqual(gate.pendingCount, 1)
        clock.advance(2)
        holder.finish()
        let response = await waiting.value
        XCTAssertTrue(response.ok, response.error ?? "")
        XCTAssertEqual(response.wait?.outcome, "timeout")
        XCTAssertEqual(response.wait?.probes, 1, "expired queued work must not become a second observation")
        XCTAssertNotNil(response.readiness, "final authorization still allows covered response metadata")
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testStandaloneAndNestedWaitsRetainRequiredIsolationEvidence() async throws {
        for nested in [false, true] {
            for strict in [false, true] {
                let report = IsolationReport(checks: IsolationDimension.allCases.map { dimension in
                    let observed = strict || dimension == .cursorLocation
                    return IsolationCheckReport(dimension: dimension,
                        coverage: observed ? .observed : .unknown,
                        status: observed ? .passed : .unknown, evidence: "synthetic isolation fixture")
                })
                let manager = try makeManager(displayID: 96_035, waitRuntime: WaitClock().runtime,
                    isolationPreflight: { report })
                await create(manager, name: "wait")
                var request = TestController.request(nested ? "steps.run" : "wait", session: "wait")
                if strict { request.strictIsolation = true }
                else { request.requiredIsolation = [.cursorLocation] }
                if nested { request.steps = [pauseStep(1)] }
                else { request.waitCondition = "ms"; request.waitValue = "1" }
                let response = await manager.handle(request)
                XCTAssertTrue(response.ok, response.error ?? "")
                XCTAssertEqual(response.verificationAssertion?.satisfied, true)
                XCTAssertEqual(response.isolation?.verdict, strict ? .intact : .partial)
                if nested { XCTAssertEqual(response.steps?.first?.ok, true) }
                else { XCTAssertEqual(response.wait?.outcome, "met") }
            }
        }
    }

    func testStandaloneAndNestedWaitFinalizationPreserveHandoffDelivery() async throws {
        for nested in [false, true] {
            let manager = try makeManager(displayID: 96_034, waitRuntime: WaitClock().runtime)
            await create(manager, name: "wait")
            var control = Request(cmd: "session.control")
            control.session = "wait"
            control.operatorScope = true
            control.paused = true
            _ = await manager.handle(control)
            control.paused = false
            control.handoffNote = "synthetic wait handoff"
            _ = await manager.handle(control)
            var request = TestController.request(nested ? "steps.run" : "wait", session: "wait")
            if nested { request.steps = [pauseStep(1)] }
            else { request.waitCondition = "ms"; request.waitValue = "1" }
            let response = await manager.handle(request)
            XCTAssertTrue(response.ok, response.error ?? "")
            XCTAssertTrue(response.handoff?.summaryLine.contains("synthetic wait handoff") == true)
            XCTAssertNotNil(response.readiness)
            let next = await manager.handle(TestController.request("verify", session: "wait"))
            XCTAssertNil(next.handoff)
        }
    }

    func testStandaloneWaitAppliesPreflightAndKeepsTimeoutAsNormalReceipt() async throws {
        let clock = WaitClock()
        let manager = try makeManager(displayID: 96_024, waitRuntime: clock.runtime)
        await create(manager, name: "wait")
        for timeout in [Double.nan, .infinity, 0.1, 0.3, 61] {
            var request = TestController.request("wait", session: "wait")
            request.waitCondition = "ms"; request.waitValue = "1"; request.timeout = timeout
            let result = await manager.handle(request)
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.errorCode, "bad_request")
        }
        var request = TestController.request("wait", session: "wait")
        request.waitCondition = "ms"; request.waitValue = "1000"; request.timeout = 0.5
        let result = await manager.handle(request)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.wait?.outcome, "timeout")
    }

    // MARK: - Clipboard broker (SPAO-143)

    func testClipboardIsPerSessionBoundedAndLeaseScoped() async throws {
        let manager = try makeManager(displayID: 96_003)
        await create(manager, name: "clip")

        var set = TestController.request("clipboard.set", session: "clip")
        set.text = "hello from the agent"
        let stored = await manager.handle(set)
        XCTAssertTrue(stored.ok, stored.error ?? "")
        XCTAssertEqual(stored.clipboardBytes, 20)

        let read = await manager.handle(TestController.request("clipboard.get", session: "clip"))
        XCTAssertTrue(read.ok, read.error ?? "")
        XCTAssertEqual(read.value, "hello from the agent")

        var oversized = TestController.request("clipboard.set", session: "clip")
        oversized.text = String(repeating: "x", count: SessionClipboard.maximumBytes + 1)
        let refused = await manager.handle(oversized)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "bad_request")
        let unchanged = await manager.handle(TestController.request("clipboard.get", session: "clip"))
        XCTAssertEqual(unchanged.value, "hello from the agent", "a refused write must leave the buffer intact")

        var foreign = Request(cmd: "clipboard.get")
        foreign.session = "clip"
        foreign.controllerLeaseID = UUID()
        let redacted = await manager.handle(foreign)
        XCTAssertFalse(redacted.ok, "another controller must not read this session's clipboard")

        var operatorRead = Request(cmd: "clipboard.get")
        operatorRead.session = "clip"
        operatorRead.operatorScope = true
        let viewer = await manager.handle(operatorRead)
        XCTAssertTrue(viewer.ok, "the Viewer's explicit Copy from Session uses operator scope")
        XCTAssertEqual(viewer.value, "hello from the agent")
    }

    // MARK: - Annotation (SPAO-218)

    func testAnnotationShowsUpInSessionInfoAndRejectsUnknownColours() async throws {
        let manager = try makeManager(displayID: 96_004)
        await create(manager, name: "named")

        var annotate = TestController.request("session.annotate", session: "named")
        annotate.title = "Booking flight to SFO"
        annotate.colorTag = "blue"
        let annotated = await manager.handle(annotate)
        XCTAssertTrue(annotated.ok, annotated.error ?? "")
        XCTAssertEqual(annotated.session?.title, "Booking flight to SFO")
        XCTAssertEqual(annotated.session?.colorTag, "blue")

        let listed = await manager.handle(TestController.request("session.list"))
        XCTAssertEqual(listed.sessions?.first?.title, "Booking flight to SFO")

        var bad = Request(cmd: "session.annotate")
        bad.session = "named"
        bad.operatorScope = true
        bad.colorTag = "chartreuse"
        let refused = await manager.handle(bad)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "bad_request")

        var clear = Request(cmd: "session.annotate")
        clear.session = "named"
        clear.operatorScope = true
        clear.title = ""
        let cleared = await manager.handle(clear)
        XCTAssertTrue(cleared.ok)
        XCTAssertNil(cleared.session?.title)
        XCTAssertEqual(cleared.session?.colorTag, "blue", "nil leaves a field alone; empty clears it")
    }

    // MARK: - Hand-off (SPAO-219)

    func testOperatorHandoffIsDeliveredToTheAgentExactlyOnce() async throws {
        let manager = try makeManager(displayID: 96_005)
        await create(manager, name: "handoff")

        var pause = Request(cmd: "session.control")
        pause.session = "handoff"
        pause.paused = true
        pause.operatorScope = true
        let paused = await manager.handle(pause)
        XCTAssertTrue(paused.ok, paused.error ?? "")

        var click = TestController.request("click", session: "handoff")
        click.element = "0"
        let refused = await manager.handle(click)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "session_paused")
        XCTAssertEqual(refused.recovery?.tool, "spaceo_session_list")

        var resume = Request(cmd: "session.control")
        resume.session = "handoff"
        resume.paused = false
        resume.operatorScope = true
        resume.handoffNote = "dismissed the login dialog for you"
        let resumed = await manager.handle(resume)
        XCTAssertTrue(resumed.ok, resumed.error ?? "")
        XCTAssertNotNil(resumed.session?.operatorHandoff, "the note is visible in the session row while unread")

        let first = await manager.handle(TestController.request("verify", session: "handoff"))
        XCTAssertNotNil(first.handoff, "the agent's next covered command carries the note")
        XCTAssertTrue(first.handoff?.summaryLine.contains("dismissed the login dialog") == true)

        let second = await manager.handle(TestController.request("verify", session: "handoff"))
        XCTAssertNil(second.handoff, "delivered exactly once")

        let listed = await manager.handle(TestController.request("session.list"))
        XCTAssertNil(listed.sessions?.first?.operatorHandoff)
    }

    func testAgentPauseReasonIsReportedAndTheAgentCanResumeItself() async throws {
        let manager = try makeManager(displayID: 96_006)
        await create(manager, name: "reason")

        var pause = TestController.request("session.control", session: "reason")
        pause.paused = true
        pause.reason = "needs 2FA code"
        let paused = await manager.handle(pause)
        XCTAssertTrue(paused.ok, paused.error ?? "")
        XCTAssertEqual(paused.session?.agentPauseReason, "needs 2FA code")
        XCTAssertEqual(paused.session?.inputPaused, true)

        var type = TestController.request("type", session: "reason")
        type.text = "x"
        let refused = await manager.handle(type)
        XCTAssertEqual(refused.errorCode, "session_paused")
        XCTAssertTrue(refused.error?.contains("needs 2FA code") == true, refused.error ?? "")

        var resume = TestController.request("session.control", session: "reason")
        resume.paused = false
        let resumed = await manager.handle(resume)
        XCTAssertTrue(resumed.ok, resumed.error ?? "")
        XCTAssertNil(resumed.session?.agentPauseReason)
        XCTAssertNil(resumed.handoff, "an agent-initiated pause produces no operator hand-off")
    }

    // MARK: - Event stream (SPAO-214)

    func testEventsPollRedactsSessionsTheCallerDoesNotHold() async throws {
        let manager = try makeManager(displayID: 96_007)
        let before = EventBus.shared.latestSeq
        await create(manager, name: "mine", ownerID: "client-a", leaseID: TestController.leaseID)

        var own = TestController.request("events.poll")
        own.sinceSeq = before
        own.controllerOwner = TestController.owner(id: "client-a")
        let visible = await manager.handle(own)
        XCTAssertTrue(visible.ok, visible.error ?? "")
        let created = visible.events?.first { $0.kind == "session.created" && $0.session == "mine" }
        XCTAssertNotNil(created)
        XCTAssertNil(created?.redacted)
        XCTAssertEqual(created?.detail["owner"], "unit test controller")
        XCTAssertNotNil(visible.nextSeq)

        var foreign = Request(cmd: "events.poll")
        foreign.sinceSeq = before
        foreign.controllerLeaseID = UUID()
        foreign.controllerOwner = TestController.owner(id: "client-b")
        let redacted = await manager.handle(foreign)
        let hidden = redacted.events?.first { $0.kind == "session.created" && $0.session == "mine" }
        XCTAssertEqual(hidden?.redacted, true)
        XCTAssertEqual(hidden?.detail, [:])

        var operatorView = Request(cmd: "events.poll")
        operatorView.sinceSeq = before
        operatorView.operatorScope = true
        let full = await manager.handle(operatorView)
        XCTAssertNil(full.events?.first { $0.session == "mine" }?.redacted)
    }

    // MARK: - Persist on change (SPAO-151)

    func testIdleJanitorPassesWriteNothingAndAChangeWritesOnce() async throws {
        let memory = LedgerMemory()
        let manager = try makeManager(
            displayID: 96_008,
            persistence: LiveSessionPersistence(load: { memory.load() }, save: { try memory.save($0) }))
        await create(manager, name: "quiet")
        let afterCreate = memory.saves
        XCTAssertGreaterThan(afterCreate, 0)

        for _ in 0..<20 { _ = try await manager.runJanitorPass() }
        XCTAssertEqual(memory.saves, afterCreate, "an idle daemon must not rewrite an identical ledger")
        let skipped = await manager.idleWritesSkipped
        XCTAssertGreaterThanOrEqual(skipped, 20)

        var annotate = Request(cmd: "session.annotate")
        annotate.session = "quiet"
        annotate.operatorScope = true
        annotate.title = "changed"
        let annotated = await manager.handle(annotate)
        XCTAssertTrue(annotated.ok, annotated.error ?? "")
        XCTAssertEqual(memory.saves, afterCreate + 1, "a real change persists exactly once")
        XCTAssertEqual(memory.load()?.sessions.first?.title, "changed")

        _ = try await manager.runJanitorPass()
        XCTAssertEqual(memory.saves, afterCreate + 1)
    }

    // MARK: - Create presets and titles (SPAO-211, 218)

    func testCreateWithTitleAndUnknownPresetOrRecordModeIsRefusedBeforeAllocation() async throws {
        let manager = try makeManager(displayID: 96_009)

        var titled = TestController.createRequest(session: "titled")
        titled.title = "Renaming invoices"
        let created = await manager.handle(titled)
        XCTAssertTrue(created.ok, created.error ?? "")
        XCTAssertEqual(created.session?.title, "Renaming invoices")

        var badPreset = TestController.createRequest(session: "nope")
        badPreset.preset = "gigantic"
        let refused = await manager.handle(badPreset)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "bad_request")

        var badRecord = TestController.createRequest(session: "nope")
        badRecord.record = "everything"
        let refusedRecord = await manager.handle(badRecord)
        XCTAssertFalse(refusedRecord.ok)
        let count = await manager.count
        XCTAssertEqual(count, 1, "refused presets and modes allocate nothing")
    }

    // MARK: - Recovery hints (SPAO-210)

    func testEveryErrorCodeHasARecoveryHintOrIsListedAsTerminal() {
        let samples: [SpaceOError] = [
            .applicationExited("x"), .windowNotReady("x"), .staleSnapshot("x"), .staleGeometry("x"),
            .isolationUnverified("x"), .isolationBreached("x"), .daemonStopping,
            .unavailable(capability: "x"), .accessibilityDenied, .screenRecordingDenied,
            .daemonDraining, .waitQueueTimeout("initial admission"), .batchQueueTimeout("initial admission"),
            .sessionPaused("x"), .leaseRequired("x"), .webTargetAmbiguous("x"),
            .stageCreationFailed("x"), .unknownSession("x"), .launchFailed("x"), .windowNotFound("x"),
            .unsupportedTarget("x"), .elementNotPressable(role: "AXGroup", actions: []),
            .captureFailed("x"), .badRequest("x"), .teardownIncomplete(TeardownReport()),
            .resourceLimit(kind: .sessions, detail: "x", retryAfter: nil),
            .resourceLimit(kind: .creationRate, detail: "x", retryAfter: 5),
            .sessionDetached("x"), .noApplication("x"),
        ]
        for error in samples {
            let covered = error.recovery != nil || RecoveryHint.terminalCodes.contains(error.code)
            XCTAssertTrue(covered, "\(error.code) has neither a recovery hint nor a terminal listing")
        }
        let bound = SpaceOError.staleSnapshot("x").recovery!.bound(session: "s1", window: 42)
        XCTAssertEqual(bound.arguments["session"], "s1")
        XCTAssertEqual(bound.arguments["window"], "42")
        XCTAssertEqual(Response.failure(SpaceOError.staleSnapshot("x")).recovery?.tool, "spaceo_read_screen")
        // A full pool is retryable, so it carries a hint instead of a terminal listing.
        XCTAssertFalse(RecoveryHint.terminalCodes.contains("resource_limit"))
        XCTAssertEqual(SpaceOError.resourceLimit(kind: .displays, detail: "x", retryAfter: nil).recovery?.tool,
                       "spaceo_pool_status")
        XCTAssertEqual(SpaceOError.sessionDetached("x").recovery?.tool, "spaceo_session_create")
        XCTAssertEqual(SpaceOError.noApplication("x").recovery?.tool, "spaceo_open_app")
        XCTAssertEqual(SpaceOError.noApplication("x").code, "window_not_ready")
    }

    // MARK: - Recording evidence

    private final class FrameFixture: @unchecked Sendable {
        private let lock = NSLock()
        private var captures: [(CGRect, Double)] = []
        var fail = false
        var observations: [(CGRect, Double)] { lock.withLock { captures } }
        func capture(_ rect: CGRect, scale: Double) throws -> CGImage {
            let count = lock.withLock { captures.append((rect, scale)); return captures.count }
            if fail { throw SpaceOError.captureFailed("synthetic private error detail") }
            let context = try XCTUnwrap(CGContext(data: nil, width: 16, height: 16,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.setFillColor(CGColor(gray: count % 2 == 0 ? 1 : 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
            return try XCTUnwrap(context.makeImage())
        }
    }

    func testRecordedFramesBracketFailedLaunchInSessionTileAndPersistDistinctImages() async throws {
        let fixture = FrameFixture()
        let capture = RecordingFrameCapture { _, rect, _, scale in try fixture.capture(rect, scale: scale) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = try makeManager(displayID: 96_030, recordingRootDirectory: root, recordingFrameCapture: capture)
        var request = TestController.createRequest(session: "framed")
        request.record = "actions+frames"
        request.app = "" // Execute fails before touching an application.
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "bad_request")
        let expectedRect = await manager.sessions["framed"]?.frame
        XCTAssertEqual(fixture.observations.count, 2)
        XCTAssertTrue(fixture.observations.allSatisfy { $0.0 == expectedRect && $0.1 < 1 })
        let active = await manager.recorders["framed"]
        let recorder = try XCTUnwrap(active)
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let action = try SessionRecorder.decoder.decode(RecordedAction.self, from: data)
        XCTAssertEqual(action.beforeFrameStatus, "captured")
        XCTAssertEqual(action.afterFrameStatus, "captured")
        let before = try Data(contentsOf: recorder.directory.appendingPathComponent(XCTUnwrap(action.beforeFrame)))
        let after = try Data(contentsOf: recorder.directory.appendingPathComponent(XCTUnwrap(action.afterFrame)))
        XCTAssertNotEqual(before, after)
        for bytes in [before, after] {
            let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertLessThanOrEqual(max(image.width, image.height), 480)
            XCTAssertLessThanOrEqual(bytes.count, RecordingFrameCapture.maximumPNGBytes)
        }
    }

    func testRecordingFramesAreOptInAndUnavailableCaptureDoesNotChangeCommandFailure() async throws {
        for mode in ["actions", "actions+frames"] {
            let fixture = FrameFixture()
            fixture.fail = true
            let capture = RecordingFrameCapture { _, rect, _, scale in try fixture.capture(rect, scale: scale) }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let manager = try makeManager(displayID: 96_031, recordingRootDirectory: root, recordingFrameCapture: capture)
            var request = TestController.createRequest(session: "framed")
            request.record = mode
            request.app = ""
            let response = await manager.handle(request)
            XCTAssertFalse(response.ok)
            XCTAssertEqual(response.errorCode, "bad_request")
            XCTAssertEqual(fixture.observations.count, mode == "actions" ? 0 : 2)
            XCTAssertEqual(response.warnings?.contains { $0.contains("Recording frame unavailable") } == true, mode != "actions")
            let active = await manager.recorders["framed"]
            let recorder = try XCTUnwrap(active)
            let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
            let action = try SessionRecorder.decoder.decode(RecordedAction.self, from: data)
            XCTAssertNil(action.beforeFrame)
            XCTAssertNil(action.afterFrame)
            XCTAssertEqual(action.beforeFrameStatus, mode == "actions" ? nil : "capture_unavailable")
            XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("synthetic private error"))
            var foreign = TestController.request("run", session: "framed")
            foreign.controllerLeaseID = UUID()
            foreign.app = ""
            _ = await manager.handle(foreign)
            XCTAssertEqual(fixture.observations.count, mode == "actions" ? 0 : 2)
        }
    }

    func testBatchPropagatesFrameWarningsAndDoesNotCaptureSummaryOrSkippedStep() async throws {
        let fixture = FrameFixture()
        fixture.fail = true
        let capture = RecordingFrameCapture { _, rect, _, scale in try fixture.capture(rect, scale: scale) }
        let manager = try makeManager(displayID: 96_032, recordingFrameCapture: capture)
        await create(manager, name: "batch")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "batch", mode: .actionsAndFrames, rootDirectory: root)
        await manager.installRecordingFixture(recorder, sessionID: "batch")
        var request = TestController.request("steps.run", session: "batch")
        // Missing key is rejected before window lookup or input, after the before-frame boundary.
        request.steps = [Request(cmd: "key"), Request(cmd: "click")]
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.steps?.map(\.executed), [true, false])
        XCTAssertEqual(fixture.observations.count, 2)
        XCTAssertEqual(response.warnings?.filter { $0.contains("Recording frame unavailable") }.count, 1)
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let actions = try data.split(separator: 10).map { try SessionRecorder.decoder.decode(RecordedAction.self, from: $0) }
        XCTAssertEqual(actions.map(\.cmd), ["key", "steps.run"])
        XCTAssertEqual(actions.last?.beforeFrameStatus, "step_evidence")
        XCTAssertEqual(actions.last?.afterFrameStatus, "step_evidence")
    }

    func testCreateAndOpenFailureKeepsCreatedSessionLeaseAndLaunchReceipt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = try makeManager(displayID: 96_026, recordingRootDirectory: root)
        var request = TestController.createRequest(session: "partial")
        request.app = "" // Rejected before application lookup or launch.
        request.record = "actions"
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "bad_request")
        XCTAssertEqual(response.session?.id, "partial")
        XCTAssertEqual(response.controllerLeaseID, request.controllerLeaseID)
        let activeRecorder = await manager.recorders["partial"]
        let recorder = try XCTUnwrap(activeRecorder)
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let action = try SessionRecorder.decoder.decode(RecordedAction.self, from: data)
        XCTAssertEqual(action.cmd, "run")
        XCTAssertFalse(action.ok)
        XCTAssertEqual(action.errorCode, "bad_request")
        var destroy = TestController.request("session.destroy", session: "partial")
        destroy.controllerLeaseID = response.controllerLeaseID
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    func testRecordingSetupFailureKeepsCreatedSessionAvailableForCleanup() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("synthetic non-directory".utf8).write(to: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = try makeManager(displayID: 96_029, recordingRootDirectory: root)
        var request = TestController.createRequest(session: "partial")
        request.record = "actions"
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.session?.id, "partial")
        XCTAssertEqual(response.controllerLeaseID, request.controllerLeaseID)
        XCTAssertNil(response.session?.recording)
        XCTAssertTrue(response.error?.contains("setup failed") == true)
        var destroy = TestController.request("session.destroy", session: "partial")
        destroy.controllerLeaseID = response.controllerLeaseID
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    func testBatchRecordsAttemptsOnceAndOmitsSkippedAndForeignActions() async throws {
        for stop in [true, false] {
            let manager = try makeManager(displayID: 96_027)
            await create(manager, name: "batch")
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let recorder = try SessionRecorder(sessionID: "batch", mode: .actions, rootDirectory: root)
            await manager.installRecordingFixture(recorder, sessionID: "batch")
            var typed = Request(cmd: "type")
            typed.text = "nested-private-fixture"
            typed.duration = .infinity
            var click = Request(cmd: "click")
            click.duration = .infinity
            var request = TestController.request("steps.run", session: "batch")
            request.steps = [typed, click]
            request.stopOnFailure = stop
            let response = await manager.handle(request)
            XCTAssertFalse(response.ok)
            XCTAssertEqual(response.steps?.map(\.executed), [true, !stop])
            let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
            let actions = try data.split(separator: 10).map {
                try SessionRecorder.decoder.decode(RecordedAction.self, from: $0)
            }
            XCTAssertEqual(actions.map(\.cmd), stop ? ["type", "steps.run"] : ["type", "click", "steps.run"])
            XCTAssertTrue(actions.allSatisfy { !$0.ok })
            XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("nested-private-fixture"))
            request.controllerLeaseID = UUID()
            let refused = await manager.handle(request)
            XCTAssertFalse(refused.ok)
            XCTAssertEqual(recorder.actionCount, actions.count)
        }
    }

    func testNestedEnrichmentPreservesHandoffForOuterResponse() async throws {
        let manager = try makeManager(displayID: 96_028)
        await create(manager, name: "handoff")
        var control = Request(cmd: "session.control")
        control.session = "handoff"
        control.operatorScope = true
        control.paused = true
        _ = await manager.handle(control)
        control.paused = false
        control.handoffNote = "synthetic handoff note"
        _ = await manager.handle(control)
        let inner = await manager.enrichRecordingFixture(.success(),
            request: TestController.request("click", session: "handoff"), nested: true)
        XCTAssertNil(inner.handoff)
        XCTAssertNil(inner.geometries)
        XCTAssertNil(inner.readiness)
        XCTAssertNotNil(inner.action)
        let outer = await manager.enrichRecordingFixture(.success(),
            request: TestController.request("steps.run", session: "handoff"))
        XCTAssertTrue(outer.handoff?.summaryLine.contains("synthetic handoff note") == true)
        XCTAssertNotNil(outer.readiness)
        let next = await manager.enrichRecordingFixture(.success(),
            request: TestController.request("steps.run", session: "handoff"))
        XCTAssertNil(next.handoff)
    }


    func testRecordedReceiptsUseFinalMetadataAndUTF8PayloadLengths() async throws {
        let manager = try makeManager(displayID: 96_020)
        await create(manager, name: "recorded")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "recorded", mode: .actions, rootDirectory: root)
        await manager.installRecordingFixture(recorder, sessionID: "recorded")
        for command in ["type", "key"] {
            var request = TestController.request(command, session: "recorded")
            request.text = "秘密🙂"
            request.key = "cmd+é"
            var response = Response.success("echo 秘密🙂 cmd+é")
            response.action = ActionReceipt(command: command, windowID: 7, route: "fixture-route",
                completion: "attempted", requestedDuration: nil, elapsedSeconds: 0)
            let enriched = await manager.enrichRecordingFixture(response, request: request)
            XCTAssertTrue(enriched.ok)
        }
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let actions = try data.split(separator: 10).map {
            try SessionRecorder.decoder.decode(RecordedAction.self, from: $0)
        }
        XCTAssertEqual(actions.map(\.payloadLength), ["秘密🙂".utf8.count, "cmd+é".utf8.count])
        XCTAssertEqual(actions.map(\.route), ["fixture-route", "fixture-route"])
        XCTAssertEqual(actions.map(\.completion), Array(repeating: "operation_completed_postcondition_not_asserted", count: 2))
        XCTAssertEqual(actions.map(\.windowID), [7, 7])
        XCTAssertTrue(actions.allSatisfy { $0.message == nil && $0.error == nil })
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("秘密"))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("cmd+é"))
    }

    func testFailedCommandsAreRecordedWithoutInventingRouteOrInvalidCoordinates() async throws {
        let manager = try makeManager(displayID: 96_021)
        await create(manager, name: "failed")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "failed", mode: .actions, rootDirectory: root)
        await manager.installRecordingFixture(recorder, sessionID: "failed")
        var request = TestController.request("drag", session: "failed")
        request.duration = .infinity
        request.x = .nan
        request.y = .infinity
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "bad_request")
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let action = try SessionRecorder.decoder.decode(RecordedAction.self, from: data)
        XCTAssertFalse(action.ok)
        XCTAssertEqual(action.errorCode, "bad_request")
        XCTAssertEqual(action.completion, "failed")
        XCTAssertNil(action.route)
        XCTAssertNil(action.x)
        XCTAssertNil(action.y)
        request.controllerLeaseID = UUID()
        let refused = await manager.handle(request)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(recorder.actionCount, 1, "foreign callers cannot append to the owner's recording")
    }

    func testRecordingBoundsDiagnosticsAndOmitsTypingFailureEchoes() async throws {
        let manager = try makeManager(displayID: 96_023)
        await create(manager, name: "bounded")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "bounded", mode: .actions, rootDirectory: root)
        await manager.installRecordingFixture(recorder, sessionID: "bounded")
        var response = Response(ok: false)
        response.message = "e" + String(repeating: "\u{301}", count: 10_000)
        response.error = String(repeating: "E", count: 10_000)
        response.errorCode = "fixture_error"
        response.action = ActionReceipt(command: "click", windowID: nil,
            route: String(repeating: "R", count: 1_000), completion: "failed",
            requestedDuration: nil, elapsedSeconds: 0)
        _ = await manager.enrichRecordingFixture(response, request: TestController.request("click", session: "bounded"))
        var typed = TestController.request("type", session: "bounded")
        typed.text = "private-fixture-payload"
        let typedFailure = Response.failure(SpaceOError.badRequest("rejected private-fixture-payload"))
        _ = await manager.enrichRecordingFixture(typedFailure, request: typed)
        var batch = TestController.request("steps.run", session: "bounded")
        batch.steps = [typed]
        _ = await manager.enrichRecordingFixture(typedFailure, request: batch)
        let data = try Data(contentsOf: recorder.directory.appendingPathComponent("actions.jsonl"))
        let actions = try data.split(separator: 10).map {
            try SessionRecorder.decoder.decode(RecordedAction.self, from: $0)
        }
        XCTAssertEqual(actions.count, 3)
        XCTAssertLessThanOrEqual(actions[0].message?.utf8.count ?? 0, 1_600)
        XCTAssertLessThanOrEqual(actions[0].error?.utf8.count ?? 0, 4_096)
        XCTAssertLessThanOrEqual(actions[0].route?.utf8.count ?? 0, 256)
        XCTAssertNil(actions[1].error)
        XCTAssertEqual(actions[1].errorCode, "bad_request")
        XCTAssertNil(actions[2].error, "batch summaries must not echo a nested typing failure")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-fixture-payload"))
    }

    func testBrokenRecorderWarningPreservesCommandFailure() async throws {
        let manager = try makeManager(displayID: 96_024)
        await create(manager, name: "broken")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "broken", mode: .actions, rootDirectory: root)
        try recorder.finish(reason: "closed fixture")
        await manager.installRecordingFixture(recorder, sessionID: "broken")
        let result = await manager.enrichRecordingFixture(
            .failure(SpaceOError.badRequest("command fixture failed")),
            request: TestController.request("click", session: "broken"))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.errorCode, "bad_request")
        XCTAssertTrue(result.error?.contains("command fixture failed") == true)
        XCTAssertTrue(result.warnings?.contains { $0.contains("write_failed") } == true)
        let remaining = await manager.recorders.count
        XCTAssertEqual(remaining, 0)
    }

    func testRecordingCapacityFailureIsVisibleAndStopsRepeatedWrites() async throws {
        let manager = try makeManager(displayID: 96_022)
        await create(manager, name: "full")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = try SessionRecorder(sessionID: "full", mode: .actions, rootDirectory: root, capacityBytes: 1)
        await manager.installRecordingFixture(recorder, sessionID: "full")
        let request = TestController.request("click", session: "full")
        let response = await manager.enrichRecordingFixture(.success(), request: request)
        XCTAssertTrue(response.ok, "evidence failure must not turn a completed action into a retry instruction")
        XCTAssertTrue(response.warnings?.contains { $0.contains("capacity_exhausted") } == true)
        let active = await manager.recorders.count
        XCTAssertEqual(active, 0)
        let warnings = await manager.recordingFailureWarnings.count
        XCTAssertEqual(warnings, 1)
        let read = await manager.enrichRecordingFixture(.success(), request: TestController.request("windows", session: "full"))
        XCTAssertEqual(read.warnings, response.warnings)
        var foreign = TestController.request("windows", session: "full")
        foreign.controllerLeaseID = UUID()
        let hidden = await manager.enrichRecordingFixture(.success(), request: foreign)
        XCTAssertNil(hidden.warnings)
        let repeated = await manager.enrichRecordingFixture(.success(), request: request)
        XCTAssertEqual(repeated.warnings, response.warnings)
        XCTAssertEqual(recorder.actionCount, 0)
        let destroyed = await manager.handle(TestController.request("session.destroy", session: "full"))
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        let remainingWarnings = await manager.recordingFailureWarnings.count
        XCTAssertEqual(remainingWarnings, 0)
    }

}


private extension SessionManager {
    func installRecordingFixture(_ recorder: SessionRecorder, sessionID: String) {
        recorders[sessionID] = recorder
        sessions[sessionID]?.setRecordingMode(recorder.mode.rawValue)
    }

    func enrichRecordingFixture(_ supplied: Response, request: Request, nested: Bool = false) -> Response {
        var response = supplied
        enrich(&response, request: request, elapsed: 0.01, includeSessionMetadata: !nested)
        return response
    }
}
