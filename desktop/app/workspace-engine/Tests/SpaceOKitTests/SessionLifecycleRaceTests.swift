import XCTest
@testable import SpaceOKit

/// Deterministic SPAO-124 regressions. These exercise the exact coordinators used by
/// `SessionManager` and `AgentSession` without creating a virtual display or GUI process.
final class SessionLifecycleRaceTests: XCTestCase {

    private final class Resources: @unchecked Sendable {
        private let lock = NSLock()
        private var apps = 0
        private var displays: Int

        init(displays: Int) {
            self.displays = displays
        }

        func registerPartiallyLaunchedApp() {
            lock.withLock { apps += 1 }
        }

        func cleanSession() {
            lock.withLock {
                if apps > 0 { apps -= 1 }
            }
        }

        func retireAllDisplays() {
            lock.withLock { displays = 0 }
        }

        var snapshot: (apps: Int, displays: Int) {
            lock.withLock { (apps, displays) }
        }
    }

    private final class EventLog: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []

        func append(_ value: String) {
            lock.withLock { values.append(value) }
        }

        var snapshot: [String] { lock.withLock { values } }
    }

    func testDestroyWaitsForInFlightLaunchThenCleansPartialResources() async throws {
        let lifecycle = SessionLifecycle()
        let resources = Resources(displays: 1)
        let launchLease = try XCTUnwrap(lifecycle.beginOperation())

        let destroy = Task.detached {
            lifecycle.destroy {
                resources.cleanSession()
                resources.retireAllDisplays()
            }
        }

        while lifecycle.currentState == .active { await Task.yield() }
        XCTAssertEqual(lifecycle.currentState, .destroying)
        XCTAssertEqual(resources.snapshot.displays, 1,
                       "destroy must not retire the tile under an in-flight launch")

        // The process appears after destroy was requested, matching the original actor-
        // reentrancy race. Cleanup must wait long enough to see and remove it.
        resources.registerPartiallyLaunchedApp()
        launchLease.finish()

        let performedCleanup = await destroy.value
        XCTAssertTrue(performedCleanup)
        XCTAssertEqual(lifecycle.currentState, .destroyed)
        XCTAssertEqual(resources.snapshot.apps, 0)
        XCTAssertEqual(resources.snapshot.displays, 0)
        XCTAssertNil(lifecycle.beginOperation(),
                     "no operation may start or report success after destruction")
    }

    func testShutdownWaitsForEverySessionAndLeavesZeroResources() async throws {
        let first = SessionLifecycle()
        let second = SessionLifecycle()
        let firstLaunch = try XCTUnwrap(first.beginOperation())
        let secondCapture = try XCTUnwrap(second.beginOperation())
        let resources = Resources(displays: 2)

        let shutdown = Task.detached {
            _ = first.destroy { resources.cleanSession() }
            _ = second.destroy { resources.cleanSession() }
            resources.retireAllDisplays()
        }

        while first.currentState == .active { await Task.yield() }
        resources.registerPartiallyLaunchedApp()
        firstLaunch.finish()

        while second.currentState == .active { await Task.yield() }
        resources.registerPartiallyLaunchedApp()
        XCTAssertEqual(resources.snapshot.displays, 2,
                       "shutdown cannot retire displays while capture is in flight")
        secondCapture.finish()

        await shutdown.value
        XCTAssertEqual(first.currentState, .destroyed)
        XCTAssertEqual(second.currentState, .destroyed)
        XCTAssertEqual(resources.snapshot.apps, 0)
        XCTAssertEqual(resources.snapshot.displays, 0)
    }

    func testManagerGateDoesNotLetDestroyOvertakeLaunch() async {
        let gate = SessionOperationGate()
        let events = EventLog()
        let launch = try! await gate.enter()

        let destroy = Task.detached {
            do {
                let lease = try await gate.enter()
                events.append("destroy")
                lease.finish()
            } catch {
                XCTFail("unexpected gate failure: \(error)")
            }
        }

        while gate.pendingCount == 0 { await Task.yield() }
        XCTAssertTrue(events.snapshot.isEmpty)

        events.append("launch-finished")
        launch.finish()
        await destroy.value

        XCTAssertEqual(events.snapshot, ["launch-finished", "destroy"])
    }

    func testTimedAdmissionExpiresWhileHolderRemainsAndPreservesOtherWaiters() async throws {
        let gate = SessionOperationGate()
        let holder = try await gate.enter()
        defer { holder.finish() }
        let events = EventLog()
        let first = Task { let lease = try await gate.enter(); events.append("first"); lease.finish() }
        while gate.pendingCount != 1 { await Task.yield() }
        let expiring = Task { try await gate.enter(timeout: 0.02) }
        // Another ordinary waiter must remain queued when the timed one expires.
        let third = Task { let lease = try await gate.enter(); events.append("third"); lease.finish() }
        do { let lease = try await expiring.value; lease.finish(); XCTFail("expired request acquired authority") }
        catch { XCTAssertTrue(error is SessionOperationGate.TimedOut) }
        while gate.pendingCount != 2 { await Task.yield() }
        XCTAssertTrue(events.snapshot.isEmpty)
        do { let lease = try await gate.enter(timeout: 0); lease.finish(); XCTFail("timer released the original owner") }
        catch { XCTAssertTrue(error is SessionOperationGate.TimedOut) }
        holder.finish()
        try await first.value
        try await third.value
        XCTAssertEqual(events.snapshot, ["first", "third"])
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testTimedAdmissionCancellationRemovesWaiterBeforeItsDeadline() async throws {
        let gate = SessionOperationGate()
        let holder = try await gate.enter()
        defer { holder.finish() }
        let waiter = Task { try await gate.enter(timeout: 30) }
        while gate.pendingCount != 1 { await Task.yield() }
        waiter.cancel()
        do { let lease = try await waiter.value; lease.finish(); XCTFail("cancelled request acquired authority") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(gate.pendingCount, 0)
        holder.finish()
        let next = try await gate.enter(timeout: 0)
        next.finish()
    }

    func testCancelledTimedWaiterReleasesCapturedStateBeforeItsDeadline() async throws {
        final class Payload: Sendable {}
        let gate = SessionOperationGate()
        let holder = try await gate.enter()
        defer { holder.finish() }
        var payload: Payload? = Payload()
        weak var released: Payload?
        released = payload
        let waiter = Task { [payload = payload!] in
            defer { withExtendedLifetime(payload) {} }
            return try await gate.enter(timeout: 30)
        }
        payload = nil
        while gate.pendingCount != 1 { await Task.yield() }
        XCTAssertNotNil(released)
        waiter.cancel()
        do { let lease = try await waiter.value; lease.finish(); XCTFail("cancelled request acquired authority") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(released, "the deadline timer must not retain the cancelled request's state")
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testNonblockingAdmissionAndInvalidTimeouts() async throws {
        let gate = SessionOperationGate()
        for timeout in [-1.0, .nan, .infinity, 121] {
            do { let lease = try await gate.enter(timeout: timeout); lease.finish(); XCTFail("invalid timeout accepted") }
            catch { XCTAssertEqual((error as? SpaceOError)?.code, "bad_request") }
        }
        let first = try await gate.enter(timeout: 0)
        first.finish()
        let second = try await gate.enter(timeout: 0)
        second.finish()
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testTimedAdmissionHandoffRacesDoNotLeakAuthority() async throws {
        let gate = SessionOperationGate()
        for _ in 0..<40 {
            let holder = try await gate.enter()
            let waiter = Task { try await gate.enter(timeout: 0.001) }
            await Task.yield()
            holder.finish()
            do { let lease = try await waiter.value; lease.finish() }
            catch { XCTAssertTrue(error is SessionOperationGate.TimedOut) }
            let next = try await gate.enter(timeout: 0)
            next.finish()
            XCTAssertEqual(gate.pendingCount, 0)
        }
    }

    func testCancelledWaiterIsRemovedWithoutWaitingForStalledHolder() async throws {
        let gate = SessionOperationGate()
        let events = EventLog()
        let holder = try await gate.enter()
        let waiter = Task {
            do {
                let lease = try await gate.enter()
                events.append("cancelled waiter mutated state")
                lease.finish()
                return false
            } catch is CancellationError {
                return true
            } catch {
                return false
            }
        }

        while gate.pendingCount != 1 { await Task.yield() }
        waiter.cancel()
        let observedCancellation = await waiter.value

        XCTAssertTrue(observedCancellation)
        XCTAssertEqual(gate.pendingCount, 0,
                       "cancellation must unlink and resume a waiter immediately")
        XCTAssertTrue(events.snapshot.isEmpty,
                      "a cancelled queued command must never receive mutation authority")

        // The original holder is deliberately still alive. Cancellation must not depend on it
        // finishing, and the gate must remain usable once it eventually does.
        holder.finish()
        let probe = try await gate.enter()
        probe.finish()
    }

    func testCancellationPreservesFIFOAmongRemainingLiveWaiters() async throws {
        let gate = SessionOperationGate()
        let events = EventLog()
        let holder = try await gate.enter()

        let first = Task {
            let lease = try await gate.enter()
            events.append("first")
            lease.finish()
        }
        while gate.pendingCount != 1 { await Task.yield() }

        let cancelled = Task {
            let lease = try await gate.enter()
            events.append("cancelled")
            lease.finish()
        }
        while gate.pendingCount != 2 { await Task.yield() }

        let third = Task {
            let lease = try await gate.enter()
            events.append("third")
            lease.finish()
        }
        while gate.pendingCount != 3 { await Task.yield() }

        cancelled.cancel()
        do {
            try await cancelled.value
            XCTFail("cancelled waiter unexpectedly acquired the gate")
        } catch is CancellationError {
            // Expected.
        }
        XCTAssertEqual(gate.pendingCount, 2)

        holder.finish()
        try await first.value
        try await third.value

        XCTAssertEqual(events.snapshot, ["first", "third"])
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testCancelledManagerCommandCannotMutateAfterGateHandoff() async throws {
        let gate = SessionOperationGate()
        let holder = try await gate.enter()
        let manager = SessionManager(
            pool: DisplayPool(),
            runJanitor: false,
            operationGate: gate,
            sessionFactory: { AgentSession(id: $0, slot: $1) })

        let command = Task {
            await manager.handle(TestController.createRequest())
        }
        while gate.pendingCount != 1 { await Task.yield() }
        command.cancel()
        let response = await command.value

        XCTAssertFalse(response.ok)
        XCTAssertEqual(gate.pendingCount, 0)
        let sessionCount = await manager.count
        let displayCount = await manager.displayCount
        XCTAssertEqual(sessionCount, 0)
        XCTAssertEqual(displayCount, 0)

        holder.finish()
        let ping = await manager.handle(Request(cmd: "ping"))
        XCTAssertTrue(ping.ok)
    }

    func testManagerRejectsCommandsAfterShutdownCompletes() async {
        let manager = SessionManager(runJanitor: false)

        let stopped = await manager.handle(Request(cmd: "daemon.stop"))
        XCTAssertTrue(stopped.ok)

        let lateCommand = await manager.handle(Request(cmd: "ping"))
        XCTAssertFalse(lateCommand.ok)
        XCTAssertTrue(lateCommand.error?.contains("shutting down") == true)
        let isEmpty = await manager.isEmpty
        let displayCount = await manager.displayCount
        XCTAssertTrue(isEmpty)
        XCTAssertEqual(displayCount, 0)
    }
}
