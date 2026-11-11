import XCTest
@testable import SpaceOKit

final class DisplayReconfigurationSettlingTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = 100.0
        var value: Double {
            get { lock.withLock { time } }
            set { lock.withLock { time = newValue } }
        }
    }

    private final class UptimeClock: @unchecked Sendable {
        private let lock = NSLock()
        var offset: Double {
            get { lock.withLock { adjustment } }
            set { lock.withLock { adjustment = newValue } }
        }
        private var adjustment = -5.0
        var value: Double { ProcessInfo.processInfo.systemUptime + offset }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func next() -> Int { lock.withLock { defer { value += 1 }; return value } }
    }

    private final class SnapshotClock: @unchecked Sendable {
        let readerQueue = DispatchQueue(label: "spaceo.test.expiry-snapshot")
        let readEntered = DispatchSemaphore(value: 0)
        let resumeRead = DispatchSemaphore(value: 0)
        private let readerKey = DispatchSpecificKey<Bool>()
        private let lock = NSLock()
        private var time = 104.0
        private var armed = true

        init() { readerQueue.setSpecific(key: readerKey, value: true) }

        func advance(to time: Double) { lock.withLock { self.time = time } }

        func read() -> Double {
            let snapshot = lock.withLock { () -> (Double, Bool) in
                let block = armed && DispatchQueue.getSpecific(key: readerKey) == true
                if block { armed = false }
                return (time, block)
            }
            if snapshot.1 {
                readEntered.signal()
                _ = resumeRead.wait(timeout: .now() + 4)
            }
            return snapshot.0
        }
    }

    private func observation(_ time: Double, cpu: Double, swap: UInt64 = 0,
                             pressure: UInt32 = 1) -> DisplayHostHealthSample {
        let services = DisplayHostHealthSampler.services
        return .init(uptime: time, pressure: pressure, swapins: swap, swapouts: 0,
                     services: [services[0]: .running(pid: 1, start: "inert", cpuSeconds: cpu, launches: 1),
                                services[1]: .idle(launches: 0)])
    }

    private func monitor(_ clock: Clock) -> DisplayHostHealth {
        // Deterministic feeds own all samples; no WindowServer or process queries.
        DisplayHostHealth(sample: { throw DisplayHostHealthSample.Unknown("inert_fixture") },
                          now: { clock.value })
    }

    private func feed(_ monitor: DisplayHostHealth, _ clock: Clock, _ time: Double, _ cpu: Double) {
        clock.value = time
        monitor.accept(observation(time, cpu: cpu))
    }

    func testThreeRawObservationsAreRequiredAndCachedReadsNeverCount() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 105, 11.2) // 24%, first assessed interval.
        for _ in 0..<100 {
            XCTAssertEqual(health.report.state, .ready)
            XCTAssertFalse(health.isSettledForReconfiguration)
        }
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration()) {
            XCTAssertTrue($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        feed(health, clock, 110, 12.4) // 24%, second distinct interval.
        XCTAssertTrue(health.isSettledForReconfiguration)
        XCTAssertEqual(health.report.reconfigurationSettled, true)
        XCTAssertEqual(health.report.reconfigurationCPUThresholdPercent, 25)
        XCTAssertNoThrow(try health.requireSettledForReconfiguration(timeout: 0))
        XCTAssertNoThrow(try health.requireStillSettledForReconfiguration())
        XCTAssertFalse(health.hasStarted, "cached settled evidence needs no extra sampler")
    }

    func testWarmIntervalsResetQuietStreakAndBoundaryIsStrict() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 105, 11.2) // 24%.
        feed(health, clock, 110, 12.5) // 26%, ready for use but not reconfiguration.
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 115, 13.7) // 24% alone is insufficient after 26%.
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 120, 14.9)
        XCTAssertTrue(health.isSettledForReconfiguration)
        // Exactly representable counters exercise the strict 25% boundary independently.
        let boundaryClock = Clock()
        let boundary = monitor(boundaryClock)
        feed(boundary, boundaryClock, 100, 0)
        feed(boundary, boundaryClock, 105, 1)
        feed(boundary, boundaryClock, 110, 2)
        XCTAssertTrue(boundary.isSettledForReconfiguration)
        feed(boundary, boundaryClock, 115, 3.25)
        XCTAssertEqual(boundary.report.state, .ready)
        XCTAssertFalse(boundary.isSettledForReconfiguration)
        XCTAssertThrowsError(try boundary.requireStillSettledForReconfiguration())
    }

    func testGraphChangeFencesOldAndInFlightCPUObservations() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 105, 11.2)
        feed(health, clock, 110, 12.4)
        XCTAssertTrue(health.isSettledForReconfiguration)
        clock.value = 117
        health.resetReconfigurationSettling() // Observation at 115 is still in flight.
        XCTAssertFalse(health.isSettledForReconfiguration)
        health.accept(observation(115, cpu: 13.6))
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 120, 14.8) // Previous endpoint predates the graph change.
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 125, 16)
        XCTAssertFalse(health.isSettledForReconfiguration)
        feed(health, clock, 130, 17.2)
        XCTAssertTrue(health.isSettledForReconfiguration)
    }

    func testSettlingTimeoutIsBoundedAndDoesNotLatchAReadyWarmHost() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 105, 11.5) // 30%, permitted for ongoing use.
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0.02)) { error in
            guard let refusal = error as? DisplayHostHealth.ReconfigurationSettlingRefusal else {
                return XCTFail("ready warm health must produce a typed transient refusal")
            }
            XCTAssertEqual(refusal.localizedDescription, refusal.underlyingError.localizedDescription)
            guard case .stageCreationFailed = refusal.underlyingError else {
                return XCTFail("public refusal retains the existing stage creation error")
            }
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 1)
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertEqual(health.report.reconfigurationSettled, false)
        XCTAssertEqual(health.report.reconfigurationCPUThresholdPercent, 25)
        XCTAssertEqual(health.report.reasons, [])
        XCTAssertFalse(health.isSettledForReconfiguration)
        XCTAssertEqual(health.reconfigurationWaiterCount, 0)
        // A timeout releases admission rather than retaining a synchronization object.
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0.02)) {
            XCTAssertTrue($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        XCTAssertEqual(health.reconfigurationWaiterCount, 0)
    }

    func testSettlingWaitUsesRealMonotonicDeadlineWithoutSignals() {
        let clock = UptimeClock()
        let waited = expectation(description: "monotonic wait timed out without a signal")
        let health = DisplayHostHealth(
            sample: { throw DisplayHostHealthSample.Unknown("inert_fixture") },
            now: { clock.value },
            waitForReconfiguration: { signal, deadline in
                XCTAssertEqual(signal.wait(timeout: deadline), .timedOut)
                waited.fulfill()
            })
        health.accept(observation(clock.value, cpu: 10))
        clock.offset = 0
        health.accept(observation(clock.value, cpu: 11.5)) // Ready, approximately 30%.
        let start = DispatchTime.now().uptimeNanoseconds
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0.03)) {
            XCTAssertTrue($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
        wait(for: [waited], timeout: 1)
        XCTAssertGreaterThanOrEqual(elapsed, 0.025)
        XCTAssertLessThan(elapsed, 1)
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertEqual(health.reconfigurationWaiterCount, 0)
    }

    func testSignalBeforeWaitWakesEveryConcurrentSettlingWaiter() {
        let clock = Clock()
        let registered = expectation(description: "both waiters registered under the state lock")
        registered.expectedFulfillmentCount = 2
        let finished = expectation(description: "both waiters consumed their own queued signal")
        finished.expectedFulfillmentCount = 2
        let enterWait = DispatchSemaphore(value: 0)
        let health = DisplayHostHealth(
            sample: { throw DisplayHostHealthSample.Unknown("inert_fixture") },
            now: { clock.value },
            waitForReconfiguration: { signal, deadline in
                registered.fulfill()
                // Pause after registration so the sample signal necessarily precedes wait.
                XCTAssertEqual(enterWait.wait(timeout: .now() + 3), .success)
                XCTAssertEqual(signal.wait(timeout: deadline), .success)
            })
        feed(health, clock, 100, 10)
        feed(health, clock, 104, 10.96)
        clock.value = 106.9
        for _ in 0..<2 {
            DispatchQueue.global().async {
                do { try health.requireSettledForReconfiguration(timeout: 3) }
                catch { XCTFail("queued fresh quiet evidence must settle: \(error)") }
                finished.fulfill()
            }
        }
        wait(for: [registered], timeout: 2)
        XCTAssertEqual(health.reconfigurationWaiterCount, 2)
        // Four seconds since the previous observation also keeps the real sampler idle.
        feed(health, clock, 108, 11.92)
        enterWait.signal()
        enterWait.signal()
        wait(for: [finished], timeout: 2)
        XCTAssertTrue(health.isSettledForReconfiguration)
        XCTAssertEqual(health.reconfigurationWaiterCount, 0)
    }

    func testWaiterCapIsTransientAndExistingWaitersCanRewaitAndAllFinish() {
        let clock = Clock()
        let limit = DisplayHostHealth.maximumReconfigurationWaiters
        XCTAssertEqual(limit, 32)
        let calls = Counter()
        let registered = expectation(description: "waiter capacity reached")
        registered.expectedFulfillmentCount = limit
        let reregistered = expectation(description: "existing waiters rewait at capacity")
        reregistered.expectedFulfillmentCount = limit
        let finished = expectation(description: "all admitted waiters settle")
        finished.expectedFulfillmentCount = limit
        let firstWait = DispatchSemaphore(value: 0)
        let secondWait = DispatchSemaphore(value: 0)
        let health = DisplayHostHealth(
            sample: { throw DisplayHostHealthSample.Unknown("inert_fixture") },
            now: { clock.value },
            waitForReconfiguration: { signal, deadline in
                let call = calls.next()
                if call < limit {
                    registered.fulfill()
                    XCTAssertEqual(firstWait.wait(timeout: .now() + 5), .success)
                } else {
                    XCTAssertLessThan(call, limit * 2, "only one explicit non-settled wake is issued")
                    reregistered.fulfill()
                    XCTAssertEqual(secondWait.wait(timeout: .now() + 5), .success)
                }
                XCTAssertEqual(signal.wait(timeout: deadline), .success)
            })
        feed(health, clock, 100, 10)
        feed(health, clock, 104, 10.96)
        clock.value = 106.9
        for _ in 0..<limit {
            DispatchQueue.global().async {
                do { try health.requireSettledForReconfiguration(timeout: 5) }
                catch { XCTFail("an admitted waiter must retain its slot and settle: \(error)") }
                finished.fulfill()
            }
        }
        wait(for: [registered], timeout: 3)
        XCTAssertEqual(health.reconfigurationWaiterCount, limit)
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 1)) { error in
            guard let refusal = error as? DisplayHostHealth.ReconfigurationSettlingRefusal else {
                return XCTFail("saturation must retain retirement ownership without a hard fault")
            }
            guard case let .resourceLimit(kind, _, retryAfter) = refusal.underlyingError else {
                return XCTFail("creation saturation must preserve its structured resource limit")
            }
            XCTAssertEqual(kind, .displays)
            XCTAssertNil(retryAfter)
        }
        // An expired budget keeps its existing settling refusal instead of resource_limit.
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0)) { error in
            guard let refusal = error as? DisplayHostHealth.ReconfigurationSettlingRefusal else {
                return XCTFail("ready health remains a transient refusal")
            }
            guard case .stageCreationFailed = refusal.underlyingError else {
                return XCTFail("deadline refusal must precede capacity admission")
            }
        }
        XCTAssertEqual(health.report.state, .ready)
        health.resetReconfigurationSettling()
        for _ in 0..<limit { firstWait.signal() }
        wait(for: [reregistered], timeout: 3)
        XCTAssertEqual(health.reconfigurationWaiterCount, limit)
        // All intervals remain below the sampler's five-second spacing. The graph fence
        // excludes the old endpoint, so three fresh observations establish settling.
        feed(health, clock, 108, 11.92)
        feed(health, clock, 112, 12.88)
        feed(health, clock, 116, 13.84)
        XCTAssertTrue(health.isSettledForReconfiguration)
        XCTAssertNoThrow(try health.requireSettledForReconfiguration(timeout: 0))
        XCTAssertEqual(health.reconfigurationWaiterCount, limit, "settled reads consume no slot")
        for _ in 0..<limit { secondWait.signal() }
        wait(for: [finished], timeout: 3)
        XCTAssertEqual(health.reconfigurationWaiterCount, 0)
        XCTAssertEqual(health.report.state, .ready)
    }

    func testSettledEvidenceStillExpiresAndLateReadsCannotRestoreIt() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 105, 11.2)
        feed(health, clock, 110, 12.4)
        clock.value = 120.1
        XCTAssertFalse(health.isSettledForReconfiguration)
        XCTAssertEqual(health.report.reasons, ["host_health_stale_or_timed_out"])
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration()) {
            XCTAssertTrue($0 is SpaceOError)
            XCTAssertFalse($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0))
    }

    func testHealthFailureWakesSettlingWaiterAndRemainsSticky() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 105, 11.5)
        let entered = expectation(description: "settling waiter entered")
        let refused = expectation(description: "health fault wakes waiter")
        DispatchQueue.global().async {
            entered.fulfill()
            do {
                try health.requireSettledForReconfiguration(timeout: 2)
                XCTFail("a health fault must refuse reconfiguration")
            } catch {
                XCTAssertTrue(error is SpaceOError)
                XCTAssertFalse(error is DisplayHostHealth.ReconfigurationSettlingRefusal)
            }
            refused.fulfill()
        }
        wait(for: [entered], timeout: 1)
        // Same CPU clock: memory pressure is immediately authoritative. The injected sampler
        // stays idle while the existing signal wakes or precedes the waiter safely.
        health.accept(observation(105, cpu: 11.5, pressure: 2))
        wait(for: [refused], timeout: 1)
        XCTAssertEqual(health.report.reasons, ["memory_pressure"])
        XCTAssertFalse(health.isSettledForReconfiguration)
    }

    func testFreshQuietAssessmentWakesSettlingWaiter() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        feed(health, clock, 104, 10.96) // First valid, quiet four-second CPU interval.
        clock.value = 106.9
        let entered = expectation(description: "quiet waiter entered")
        let settled = expectation(description: "fresh quiet assessment wakes waiter")
        DispatchQueue.global().async {
            entered.fulfill()
            do { try health.requireSettledForReconfiguration(timeout: 2) }
            catch { XCTFail("fresh quiet evidence must settle: \(error)") }
            settled.fulfill()
        }
        wait(for: [entered], timeout: 1)
        // Until accept publishes this sample, even the timer sees less than its five-second
        // spacing. No asynchronous sampler can race the controlled four-second feed.
        feed(health, clock, 108, 11.92)
        wait(for: [settled], timeout: 1)
        XCTAssertTrue(health.isSettledForReconfiguration)
        XCTAssertEqual(health.report.state, .ready)
    }

    func testExpirySnapshotCannotCompareOldTimeAgainstNewAssessment() throws {
        let clock = SnapshotClock()
        let health = DisplayHostHealth(
            sample: { throw DisplayHostHealthSample.Unknown("inert_fixture") },
            now: { clock.read() })
        clock.advance(to: 100)
        health.accept(observation(100, cpu: 10))
        clock.advance(to: 104)
        health.accept(observation(104, cpu: 10.96))
        try health.requireHealthy() // Start expiry checks; the frozen clock prevents sampling.
        let readerDone = expectation(description: "expiry reader finished")
        let writerDone = expectation(description: "fresh assessment published")
        let writerFinished = DispatchSemaphore(value: 0)
        clock.readerQueue.async {
            _ = health.report
            readerDone.fulfill()
        }
        XCTAssertEqual(clock.readEntered.wait(timeout: .now() + 2), .success)
        let fresh = observation(108, cpu: 11.92)
        DispatchQueue.global().async {
            clock.advance(to: 108)
            health.accept(fresh)
            writerFinished.signal()
            writerDone.fulfill()
        }
        // With an atomic snapshot the writer waits for the reader's clock/state lock.
        // The old implementation publishes first, then mistakes the captured 104 for
        // a clock reversal against the new assessment at 108. This ordering is bounded.
        _ = writerFinished.wait(timeout: .now() + 2)
        clock.resumeRead.signal()
        wait(for: [readerDone, writerDone], timeout: 2)
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertTrue(health.isSettledForReconfiguration)
    }

    func testHardCPUFaultSwapAndUnknownStillRefuseReconfiguration() {
        for fault in ["cpu", "swap", "pressure", "unknown"] {
            let clock = Clock()
            let health = monitor(clock)
            feed(health, clock, 100, 10)
            clock.value = 105
            switch fault {
            case "cpu": health.accept(observation(105, cpu: 12.5))
            case "swap": health.accept(observation(105, cpu: 10, swap: 1))
            case "pressure": health.accept(observation(105, cpu: 10, pressure: 2))
            default: health.accept(observation(105, cpu: .nan))
            }
            XCTAssertEqual(health.report.state, .blocked, fault)
            XCTAssertFalse(health.isSettledForReconfiguration, fault)
            XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(), fault) {
                XCTAssertTrue($0 is SpaceOError, fault)
                XCTAssertFalse($0 is DisplayHostHealth.ReconfigurationSettlingRefusal, fault)
            }
        }
    }

    func testInvalidWaitBoundsDoNotStartSampler() {
        let health = monitor(Clock())
        for timeout in [-1, 31, Double.infinity, Double.nan] {
            XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: timeout))
        }
        XCTAssertFalse(health.hasStarted)
    }

    func testUnknownHealthIsNotClassifiedAsTransientWarmSettling() {
        let health = monitor(Clock())
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration()) {
            XCTAssertTrue($0 is SpaceOError)
            XCTAssertFalse($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0)) {
            XCTAssertTrue($0 is SpaceOError)
            XCTAssertFalse($0 is DisplayHostHealth.ReconfigurationSettlingRefusal)
        }
        XCTAssertFalse(health.hasStarted)
        XCTAssertEqual(health.report.state, .unknown)
    }

    func testHardUnknownReconfigurationRefusalIncludesUnavailableInput() {
        let clock = Clock()
        let health = monitor(clock)
        feed(health, clock, 100, 10)
        clock.value = 105
        health.accept(observation(105, cpu: .nan))
        XCTAssertEqual(health.report.state, .blocked)
        XCTAssertEqual(health.report.unavailableInput, "colorsync_service_counter")
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration()) { error in
            XCTAssertTrue(error is SpaceOError)
            XCTAssertFalse(error is DisplayHostHealth.ReconfigurationSettlingRefusal)
            XCTAssertTrue(error.localizedDescription.contains("unavailable input: colorsync_service_counter"))
        }
        XCTAssertThrowsError(try health.requireSettledForReconfiguration(timeout: 0)) { error in
            XCTAssertTrue(error.localizedDescription.contains("unavailable input: colorsync_service_counter"))
        }
    }

    func testOlderHealthReportDecodesWithOptionalReconfigurationFieldsAbsent() throws {
        let data = Data(#"{"state":"ready","reasons":[],"colorsyncCPUPercent":30}"#.utf8)
        let report = try JSONDecoder().decode(DisplayHostHealthReport.self, from: data)
        XCTAssertEqual(report.state, .ready)
        XCTAssertNil(report.reconfigurationSettled)
        XCTAssertNil(report.reconfigurationCPUThresholdPercent)
    }
}
