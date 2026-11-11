import XCTest
@testable import SpaceOKit

final class WindowReadinessTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSinceReferenceDate: 0)
        private(set) var sleeps: [TimeInterval] = []
        func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
        var runtime: WaitRuntime {
            WaitRuntime(now: { self.lock.withLock { self.current } }, sleep: { seconds in
                self.lock.withLock { self.sleeps.append(seconds); self.current += seconds }
            })
        }
    }

    func testPollingPassesRemainingBudgetAndClampsFinalSleep() async throws {
        let clock = Clock()
        var budgets: [TimeInterval] = []
        let result: Int? = try await WindowReadiness.wait(timeout: 0.55, pollNanoseconds: 200_000_000,
            runtime: clock.runtime, probe: { budgets.append($0); return nil })
        XCTAssertNil(result)
        XCTAssertEqual(budgets.count, 3)
        for (actual, expected) in zip(budgets, [0.55, 0.35, 0.15]) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
        for (actual, expected) in zip(clock.sleeps, [0.2, 0.2, 0.15]) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
        XCTAssertEqual(clock.sleeps.count, 3)
    }

    func testLateResultCannotEstablishReadiness() async throws {
        let clock = Clock()
        let result = try await WindowReadiness.wait(timeout: 0.5, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, probe: { _ in clock.advance(0.6); return "late window" })
        XCTAssertNil(result)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testReadinessReturnsObservedValueWithoutAnotherPoll() async throws {
        let clock = Clock()
        var calls = 0
        let result = try await WindowReadiness.wait(timeout: 1, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, probe: { _ -> [Int]? in
                calls += 1
                return calls == 1 ? nil : [42, 43]
            })
        XCTAssertEqual(result, [42, 43])
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(clock.sleeps, [0.1])
    }

    func testPersistentProviderFailureDoesNotBecomeAnEmptyPoll() async throws {
        let clock = Clock()
        var calls = 0
        do {
            let _: Int? = try await WindowReadiness.wait(timeout: 1, pollNanoseconds: 100_000_000,
                runtime: clock.runtime, probe: { _ in
                    calls += 1
                    throw AXWindowDiscovery.incomplete("fixture")
                })
            XCTFail("provider failure must propagate at the deadline")
        } catch {
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .provider)
            XCTAssertEqual((error as? AXTraversalStopped)?.detail, "incomplete window discovery: fixture")
        }
        XCTAssertGreaterThan(calls, 1, "a launching app's refused window count is retried")
        XCTAssertEqual(clock.sleeps.reduce(0, +), 1, accuracy: 0.00001)
    }

    /// A newly launched application refuses its AX window count until it has registered.
    /// That transient refusal must not fail the launch.
    func testTransientProviderFailureRetriesUntilWindowAppears() async throws {
        let clock = Clock()
        var calls = 0
        let result = try await WindowReadiness.wait(timeout: 2, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, probe: { _ -> Int? in
                calls += 1
                if calls < 3 { throw AXWindowDiscovery.incomplete("window count is unavailable (AXError -25204)") }
                return 7
            })
        XCTAssertEqual(result, 7)
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(clock.sleeps, [0.1, 0.1])
    }

    func testProviderFailureFollowedByEmptyPollTimesOutWithoutStaleFailure() async throws {
        let clock = Clock()
        var calls = 0
        let result: Int? = try await WindowReadiness.wait(timeout: 0.5, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, probe: { _ in
                calls += 1
                if calls == 1 { throw AXWindowDiscovery.incomplete("fixture") }
                return nil
            })
        XCTAssertNil(result, "a later confirmed empty read replaces the earlier failure")
    }

    func testPerProbeDeadlineRetriesOnlyWithinOverallBudget() async throws {
        let clock = Clock()
        var calls = 0
        let result = try await WindowReadiness.wait(timeout: 5, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, probe: { _ -> Int? in
                calls += 1
                if calls == 1 {
                    clock.advance(2)
                    throw AXTraversalStopped(reason: .deadline, detail: "fixture")
                }
                return 42
            })
        XCTAssertEqual(result, 42)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(clock.sleeps, [0.1])
    }

    func testValidationAfterProbeRejectsChangedProcess() async throws {
        let clock = Clock()
        var alive = true
        do {
            let _: Int? = try await WindowReadiness.wait(timeout: 1, pollNanoseconds: 100_000_000,
                runtime: clock.runtime, validate: {
                    if !alive { throw SpaceOError.applicationExited("fixture") }
                }, probe: { _ in alive = false; return 42 })
            XCTFail("a result from a replaced process cannot establish readiness")
        } catch { XCTAssertEqual((error as? SpaceOError)?.code, "application_exited") }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testValidationTimeCannotDispatchAnExpiredProbe() async throws {
        let clock = Clock()
        let result: Int? = try await WindowReadiness.wait(timeout: 0.5, pollNanoseconds: 100_000_000,
            runtime: clock.runtime, validate: { clock.advance(1) },
            probe: { _ in XCTFail("expired probe"); return 42 })
        XCTAssertNil(result)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancellationAndInvalidLimitsStartNoRetry() async throws {
        let clock = Clock()
        do {
            let _: Int? = try await WindowReadiness.wait(timeout: 1, pollNanoseconds: 100_000_000,
                runtime: clock.runtime, probe: { _ in
                    throw AXTraversalStopped(reason: .cancelled, detail: "fixture")
                })
            XCTFail("cancelled provider must propagate cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(clock.sleeps.isEmpty)
        for timeout in [Double.nan, .infinity, -1, 0.09, 121] {
            XCTAssertThrowsError(try WindowReadiness.validate(timeout: timeout, pollNanoseconds: 100_000_000))
        }
        for interval: UInt64 in [0, 9_999_999, 1_000_000_001, .max] {
            XCTAssertThrowsError(try WindowReadiness.validate(timeout: 1, pollNanoseconds: interval))
        }
    }
}
