import Foundation
import XCTest
@testable import SpaceOKit

final class BridgeReadinessTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = Date(timeIntervalSinceReferenceDate: 0)
        private var recordedSleeps: [TimeInterval] = []
        var sleeps: [TimeInterval] { lock.withLock { recordedSleeps } }
        func advance(_ duration: TimeInterval) { lock.withLock { time += duration } }
        var runtime: WaitRuntime {
            WaitRuntime(now: { self.lock.withLock { self.time } }, sleep: { duration in
                self.lock.withLock {
                    self.recordedSleeps.append(duration)
                    self.time += duration
                }
            })
        }
    }

    func testDeadlineBoundsSleepAndDoesNotStartAnotherProbe() async throws {
        let clock = Clock()
        var probes = 0
        let ready = try await BridgeReadiness.wait(timeout: 0.6, interval: 0.25, runtime: clock.runtime) {
            probes += 1
            return false
        }
        XCTAssertFalse(ready)
        XCTAssertEqual(probes, 3)
        XCTAssertEqual(clock.sleeps.count, 3)
        XCTAssertEqual(clock.sleeps.last ?? 0, 0.1, accuracy: 0.000001)
    }

    func testLateSuccessDoesNotClaimReadiness() async throws {
        let clock = Clock()
        let ready = try await BridgeReadiness.wait(timeout: 1, interval: 0.25, runtime: clock.runtime) {
            clock.advance(2)
            return true
        }
        XCTAssertFalse(ready)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testTransientFailuresStillRetry() async throws {
        let clock = Clock()
        var probes = 0
        let ready = try await BridgeReadiness.wait(timeout: 1, interval: 0.25, runtime: clock.runtime) {
            probes += 1
            if probes == 1 { throw SpaceOError.badRequest("not serving yet") }
            return true
        }
        XCTAssertTrue(ready)
        XCTAssertEqual(probes, 2)
        XCTAssertEqual(clock.sleeps, [0.25])
    }

    func testProbeCancellationStopsWithoutSleeping() async throws {
        let clock = Clock()
        do {
            _ = try await BridgeReadiness.wait(timeout: 1, interval: 0.25, runtime: clock.runtime) {
                throw CancellationError()
            }
            XCTFail("probe cancellation must propagate")
        } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancelledSleepDoesNotRetry() async throws {
        var probes = 0
        let runtime = WaitRuntime(now: { Date(timeIntervalSinceReferenceDate: 0) },
                                  sleep: { _ in throw CancellationError() })
        do {
            _ = try await BridgeReadiness.wait(timeout: 1, interval: 0.25, runtime: runtime) {
                probes += 1
                return false
            }
            XCTFail("sleep cancellation must propagate")
        } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(probes, 1)
    }

    func testZeroDeadlineDoesNotProbe() async throws {
        let ready = try await BridgeReadiness.wait(timeout: 0, interval: 0.25) {
            XCTFail("zero deadline must not probe")
            return true
        }
        XCTAssertFalse(ready)
    }

    func testValidationThatConsumesDeadlineDoesNotStartProbe() async throws {
        let clock = Clock()
        let ready = try await BridgeReadiness.wait(timeout: 1, interval: 0.25,
            runtime: clock.runtime, validate: { clock.advance(1) }) {
                XCTFail("validation exhausted the deadline before provider work"); return true
            }
        XCTAssertFalse(ready)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancellationDuringValidationDoesNotStartProbe() async {
        let clock = Clock()
        let task = Task {
            try await BridgeReadiness.wait(timeout: 1, interval: 0.25,
                runtime: clock.runtime, validate: { withUnsafeCurrentTask { $0?.cancel() } }) {
                    XCTFail("cancelled validation must not start provider work"); return true
                }
        }
        do { _ = try await task.value; XCTFail("cancellation must propagate") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }
}
