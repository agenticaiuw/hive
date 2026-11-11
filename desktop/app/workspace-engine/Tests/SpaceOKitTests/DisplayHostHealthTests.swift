import XCTest
@testable import SpaceOKit

final class DisplayHostHealthTests: XCTestCase {
    func testProcessReadFailureFromSamplerDoesNotTripPersistentFailure() {
        for reason in ["colorsync_process_list", "colorsync_process_list_timeout"] {
            let sampled = expectation(description: "sampler ran")
            let tripped = expectation(description: "transient read must not trip")
            tripped.isInverted = true
            let health = DisplayHostHealth(testingOverride: false, sample: {
                sampled.fulfill()
                throw DisplayHostHealthSample.Unknown(reason)
            }, onFailure: { _ in tripped.fulfill() })
            health.tick()
            wait(for: [sampled, tripped], timeout: 0.2)
            XCTAssertEqual(health.report.state, .unknown)
            XCTAssertEqual(health.report.unavailableInput, reason)
        }
    }
    func testTransientProcessReadFailureRequiresFreshObservations() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: false, now: { clock.value })
        feed(health, clock, sample(100, cpu: 10))
        feed(health, clock, sample(105, cpu: 10.1))
        feed(health, clock, sample(110, cpu: 10.2))
        try health.requireStillSettledForReconfiguration()
        health.transientProcessListFailure("colorsync_process_list")
        XCTAssertEqual(health.report.state, .unknown)
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(115, cpu: 10.3))
        XCTAssertEqual(health.report.state, .unknown)
        feed(health, clock, sample(120, cpu: 10.4))
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(125, cpu: 10.5))
        try health.requireStillSettledForReconfiguration()
    }
    func testReservedTestingOverrideRequiresBothExplicitFlags() throws {
        XCTAssertFalse(DisplayTestingPolicy.enabled(environment: [:]))
        XCTAssertFalse(DisplayTestingPolicy.enabled(environment: ["SPACEO_LIVE_TESTS": "1"]))
        XCTAssertFalse(DisplayTestingPolicy.enabled(environment: ["SPACEO_TESTING_HOST": "1"]))
        XCTAssertTrue(DisplayTestingPolicy.enabled(environment: ["SPACEO_LIVE_TESTS": "1", "SPACEO_TESTING_HOST": "1"]))
        let health = DisplayHostHealth(testingOverride: true, sample: { throw DisplayHostHealthSample.Unknown() })
        try health.requireHealthy()
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(),
                             "graph changes wait for ColorSync observations even under the override")
        XCTAssertEqual(health.report.testingOverride, true)
        XCTAssertEqual(health.report.reasons, ["testing_override"])
        XCTAssertNil(health.report.colorsyncCPUPercent)
        XCTAssertTrue(DisplayLifecycleLease.isRecoverableHostHealthFailure(
            "host health: recent_windowserver_diagnostic", testingOverride: true))
        XCTAssertFalse(DisplayLifecycleLease.isRecoverableHostHealthFailure(
            "display mutation failed", testingOverride: true))
    }

    func testTestingOverrideStillRefusesGraphChangesUnderMeasuredColorSyncLoad() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, sample: { throw DisplayHostHealthSample.Unknown() },
                                       now: { clock.value })
        // Pressure and swap are waived; quiet intervals settle.
        feed(health, clock, sample(100, cpu: 10, pressure: 4, swap: 50))
        feed(health, clock, sample(105, cpu: 10.5, pressure: 4, swap: 90))
        feed(health, clock, sample(110, cpu: 11, pressure: 4, swap: 120))
        try health.requireStillSettledForReconfiguration()
        XCTAssertEqual(health.report.state, .ready)
        XCTAssertEqual(health.report.reasons, ["testing_override"])

        // Every DisplayHostHealthSampler service at 0.4 CPU-seconds per second is well over 25%.
        feed(health, clock, sample(115, cpu: 13, swap: 120))
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(health.report.colorsyncCPUPercent), 25)
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration()) {
            XCTAssertTrue("\($0)".contains("ColorSync has not settled"), "\($0)")
        }
        XCTAssertEqual(health.report.state, .ready, "load refuses changes without a sticky fault")

        feed(health, clock, sample(120, cpu: 13.1, swap: 120))
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(125, cpu: 13.2, swap: 120))
        try health.requireStillSettledForReconfiguration()
    }

    func testTestingOverrideAdmitsUnmeasurableIntervals() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, now: { clock.value })
        feed(health, clock, sample(100, pid: 7))
        feed(health, clock, sample(105, pid: 8))  // a restarted service has no measurable interval
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(110, pid: 9))
        try health.requireStillSettledForReconfiguration()
        XCTAssertNil(health.report.colorsyncCPUPercent)
        XCTAssertEqual(health.report.state, .ready)
    }

    func testTestingOverrideNeverCountsAnUnmeasurableIntervalAsQuietAfterAMeasurement() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, now: { clock.value })
        feed(health, clock, sample(100, cpu: 10))
        feed(health, clock, sample(105, cpu: 10.5))
        feed(health, clock, sample(110, cpu: 11))
        try health.requireStillSettledForReconfiguration()
        feed(health, clock, sample(115, cpu: 13))  // busy
        // Saturation shows up as restarts and overrun intervals, not as quiet measurements.
        feed(health, clock, sample(120, cpu: 13, pid: 40))
        feed(health, clock, sample(125, cpu: 13, pid: 50))
        health.acceptFailedCaptureForTesting()
        health.acceptFailedCaptureForTesting()
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(130, cpu: 13, pid: 50))
        feed(health, clock, sample(135, cpu: 13.1, pid: 50))
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(), "two quiet intervals follow a busy one")
        feed(health, clock, sample(140, cpu: 13.2, pid: 50))
        try health.requireStillSettledForReconfiguration()
    }

    func testTestingOverrideMeasuresAfterEveryGraphChange() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, now: { clock.value })
        feed(health, clock, sample(100, cpu: 10))
        feed(health, clock, sample(105, cpu: 10.1))
        feed(health, clock, sample(110, cpu: 10.2))
        try health.requireStillSettledForReconfiguration()
        clock.value = 111
        health.resetReconfigurationSettling()
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(),
                             "a change waits for an interval measured after it")
        feed(health, clock, sample(115, cpu: 10.3))
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(),
                             "an interval that began before the change cannot show its effect")
        feed(health, clock, sample(120, cpu: 10.4))
        try health.requireStillSettledForReconfiguration()
    }

    private func feed(_ health: DisplayHostHealth, _ clock: Clock, _ observation: DisplayHostHealthSample) {
        clock.value = observation.uptime
        health.accept(observation)
    }

    func testTestingOverrideIgnoresLateCapturesAndAgesOutQuietEvidence() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, now: { clock.value })
        feed(health, clock, sample(100, cpu: 10))
        feed(health, clock, sample(105, cpu: 10.1))
        // Delivered four seconds after it was captured: not evidence about the current host.
        clock.value = 114
        health.accept(sample(110, cpu: 10.2))
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        feed(health, clock, sample(119, cpu: 10.3))
        feed(health, clock, sample(124, cpu: 10.4))
        try health.requireStillSettledForReconfiguration()
        // A sampler that stops reporting does not leave its last quiet result standing.
        clock.value = 135
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration())
        XCTAssertEqual(health.report.reconfigurationSettled, false)
    }

    func testTestingOverrideAgesEvidenceFromWhenItWasObserved() throws {
        let clock = Clock()
        let health = DisplayHostHealth(testingOverride: true, now: { clock.value })
        feed(health, clock, sample(100, cpu: 10))
        feed(health, clock, sample(105, cpu: 10.1))
        clock.value = 112.9  // observed at 110, delivered just inside the freshness limit
        health.accept(sample(110, cpu: 10.2))
        clock.value = 119
        try health.requireStillSettledForReconfiguration()
        clock.value = 120.5
        XCTAssertThrowsError(try health.requireStillSettledForReconfiguration(),
                             "late delivery must not extend the ten-second evidence window")
    }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = 100.0
        var value: Double {
            get { lock.withLock { time } }
            set { lock.withLock { time = newValue } }
        }
    }

    private func sample(_ time: Double = 100, cpu: Double = 10, pressure: UInt32 = 1,
                        swap: UInt64 = 50, swapout: UInt64 = 100, pid: Int32 = 1,
                        start: String = "start", launches: UInt64 = 1) -> DisplayHostHealthSample {
        .init(uptime: time, pressure: pressure, swapins: swap, swapouts: swapout,
              services: Dictionary(uniqueKeysWithValues: DisplayHostHealthSampler.services.enumerated().map {
                  ($0.element, .running(pid: pid + Int32($0.offset), start: start, cpuSeconds: cpu, launches: launches))
              }))
    }

    private func sample(_ time: Double, _ services: [DisplayHostHealthSample.Service]) -> DisplayHostHealthSample {
        .init(uptime: time, pressure: 1, swapins: 50, swapouts: 100,
              services: Dictionary(uniqueKeysWithValues: zip(DisplayHostHealthSampler.services, services)))
    }

    private func assertUnknown<T>(_ expression: @autoclosure () throws -> T, _ reason: String,
                                  file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try expression(), file: file, line: line) {
            XCTAssertEqual(($0 as? DisplayHostHealthSample.Unknown)?.reason, reason, file: file, line: line)
        }
    }

    private static let idleFields = ["state = not running", "active count = 0", "runs = 23",
        "last exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT",
        "last jetsam exit details = JETSAM_REASON_MEMORY_IDLE_EXIT", "job state = exited",
        "properties = partial import | supports pressured exit | system service"]
    private static let neverStartedFields = ["active count = 0", "state = not running", "runs = 0",
        "last exit code = (never exited)", "properties = supports pressured exit"]

    private func record(_ fields: [String], service: String = DisplayHostHealthSampler.services[0],
                        program: String? = nil) -> String {
        // Nested launchd blocks are deliberately ignored; only top-level fields are evidence.
        "system/" + DisplayHostHealthSampler.launchdLabel(service) + " = {\n\tprogram = " + (program ?? service) + "\n"
            + fields.map { "\t" + $0 + "\n" }.joined()
            + "\tendpoints = {\n\t\t\"x\" = {\n\t\t\tpid = 9\n\t\t\tstate = running\n\t\t}\n\t}\n}\n"
    }

    private func runningRecord(_ pid: Int32, runs: UInt64 = 1, service: String) -> String {
        record(["active count = 2", "state = running", "runs = \(runs)", "pid = \(pid)",
                "last exit code = (never exited)", "job state = running"], service: service)
    }

    func testPolicyRejectsPressureSwapAndBusyColorSync() throws {
        XCTAssertEqual(try DisplayHostHealthSample.assess(sample(), sample(105)).state, .ready)
        for (after, reason) in [(sample(105, cpu: 11.25), "colorsync_busy"),
                                (sample(105, pressure: 2), "memory_pressure"),
                                (sample(105, swap: 51), "swap_activity")] {
            let report = try DisplayHostHealthSample.assess(sample(), after)
            XCTAssertEqual(report.state, .blocked)
            XCTAssertTrue(report.reasons.contains(reason))
        }
    }

    func testUnknownCountersNeverBecomeHealthy() {
        for after in [sample(103), sample(111), sample(105, cpu: 9), sample(105, cpu: .nan),
                      sample(105, swap: 49), sample(105, pid: 2), sample(105, start: "restarted"),
                      sample(105, pressure: 0)] {
            XCTAssertThrowsError(try DisplayHostHealthSample.assess(sample(), after))
        }
    }

    func testCachedHealthExpiresAndLateHealthySamplesCannotResetIt() {
        let clock = Clock()
        let failed = expectation(description: "one sticky failure")
        failed.assertForOverFulfill = true
        let monitor = DisplayHostHealth(sample: { throw DisplayHostHealthSample.Unknown() },
                                       now: { clock.value }, onFailure: { _ in failed.fulfill() })
        XCTAssertEqual(monitor.report.state, .unknown)
        XCTAssertFalse(monitor.hasStarted)
        monitor.accept(sample())
        XCTAssertEqual(monitor.report.state, .unknown)
        clock.value = 105
        monitor.accept(sample(105))
        XCTAssertEqual(monitor.report.state, .ready)
        clock.value = 116
        XCTAssertEqual(monitor.report.state, .blocked)
        monitor.accept(sample(116))
        monitor.accept(sample(121))
        XCTAssertThrowsError(try monitor.requireHealthy())
        XCTAssertEqual(monitor.report.state, .blocked)
        wait(for: [failed], timeout: 1)
    }

    func testStuckSamplerHasOneWorkerAndLateResultCannotResume() {
        let clock = Clock()
        let entered = expectation(description: "sampler started once")
        entered.assertForOverFulfill = true
        let exited = expectation(description: "late sampler exited")
        let release = DispatchSemaphore(value: 0)
        let first = sample()
        let monitor = DisplayHostHealth(sample: {
            entered.fulfill()
            release.wait()
            exited.fulfill()
            return first
        }, now: { clock.value })
        monitor.tick()
        wait(for: [entered], timeout: 1)
        clock.value = 104
        monitor.tick()
        XCTAssertEqual(monitor.report.state, .blocked)
        clock.value = 120
        for _ in 0..<100 { monitor.tick() }
        release.signal()
        wait(for: [exited], timeout: 1)
        XCTAssertEqual(monitor.report.state, .blocked)
    }

    func testPressureRefusesWithoutWaitingForSecondSample() {
        let clock = Clock()
        let monitor = DisplayHostHealth(now: { clock.value })
        monitor.accept(sample(pressure: 2))
        XCTAssertEqual(monitor.report.reasons, ["memory_pressure"])
        XCTAssertThrowsError(try monitor.requireHealthy())
    }

    func testMemoryPressureRecoversOnlyAfterTwoFreshQuietIntervals() throws {
        let clock = Clock()
        let failure = expectation(description: "pressure must not trip lifecycle")
        failure.isInverted = true
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value },
                                        onFailure: { _ in failure.fulfill() })
        feed(monitor, clock, sample(100, cpu: 10, pressure: 2))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(105, cpu: 10.1))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(110, cpu: 10.2))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(115, cpu: 10.3))
        XCTAssertEqual(monitor.report.state, .ready)
        try monitor.requireStillSettledForReconfiguration()
        wait(for: [failure], timeout: 0.05)
    }

    func testSamplerContinuesAfterMemoryPressureRefusal() {
        let clock = Clock()
        let sampled = expectation(description: "read-only sampler runs after pressure")
        let next = sample(105, cpu: 10.1)
        let monitor = DisplayHostHealth(testingOverride: false, sample: {
            sampled.fulfill()
            return next
        }, now: { clock.value })
        feed(monitor, clock, sample(100, cpu: 10, pressure: 2))
        clock.value = 105
        monitor.tick()
        wait(for: [sampled], timeout: 1)
    }

    func testPressureRecoveryDoesNotReuseIntervalsBeforeDisplayChange() {
        let clock = Clock()
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value })
        feed(monitor, clock, sample(100, cpu: 10, pressure: 2))
        feed(monitor, clock, sample(105, cpu: 10.1))
        feed(monitor, clock, sample(110, cpu: 10.2))
        clock.value = 111
        monitor.resetReconfigurationSettling()
        feed(monitor, clock, sample(115, cpu: 10.3))
        feed(monitor, clock, sample(120, cpu: 10.4))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(125, cpu: 10.5))
        XCTAssertEqual(monitor.report.state, .ready)
    }

    func testLargeSwapDuringMemoryPressureRecoveryResetsQuietPeriod() {
        let clock = Clock()
        let failure = expectation(description: "swap must not trip lifecycle")
        failure.isInverted = true
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value },
                                        onFailure: { _ in failure.fulfill() })
        feed(monitor, clock, sample(100, pressure: 2, swap: 10))
        feed(monitor, clock, sample(105, pressure: 2, swap: 1000, swapout: 300))
        XCTAssertEqual(monitor.report.state, .blocked)
        XCTAssertEqual(monitor.report.reasons, ["swap_activity"])
        XCTAssertEqual(monitor.report.swapinsDelta, 990)
        XCTAssertEqual(monitor.report.swapoutsDelta, 200)
        feed(monitor, clock, sample(110, cpu: 10.1, swap: 1000, swapout: 300))
        feed(monitor, clock, sample(115, cpu: 10.2, swap: 1000, swapout: 300))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(120, cpu: 10.3, swap: 1000, swapout: 300))
        XCTAssertEqual(monitor.report.state, .ready)
        wait(for: [failure], timeout: 0.05)
    }

    func testSmallSwapInPausesAndRecoversAfterFreshQuietIntervals() {
        let clock = Clock()
        let failure = expectation(description: "small swap-in must not trip")
        failure.isInverted = true
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value },
                                        onFailure: { _ in failure.fulfill() })
        feed(monitor, clock, sample(100, cpu: 10, swap: 10))
        feed(monitor, clock, sample(105, cpu: 10.1, swap: 14))
        XCTAssertEqual(monitor.report.state, .blocked)
        XCTAssertEqual(monitor.report.reasons, ["swap_activity"])
        feed(monitor, clock, sample(110, cpu: 10.2, swap: 14))
        feed(monitor, clock, sample(115, cpu: 10.3, swap: 14))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(120, cpu: 10.4, swap: 14))
        XCTAssertEqual(monitor.report.state, .ready)
        wait(for: [failure], timeout: 0.05)
    }

    func testRepeatedSmallSwapInRestartsQuietPeriod() {
        let clock = Clock()
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value })
        feed(monitor, clock, sample(100, cpu: 10, swap: 10))
        feed(monitor, clock, sample(105, cpu: 10.1, swap: 14))
        feed(monitor, clock, sample(110, cpu: 10.2, swap: 14))
        feed(monitor, clock, sample(115, cpu: 10.3, swap: 15))
        feed(monitor, clock, sample(120, cpu: 10.4, swap: 15))
        feed(monitor, clock, sample(125, cpu: 10.5, swap: 15))
        XCTAssertEqual(monitor.report.state, .blocked)
        feed(monitor, clock, sample(130, cpu: 10.6, swap: 15))
        XCTAssertEqual(monitor.report.state, .ready)
    }

    func testSwapOutPausesAndRecovers() {
        let clock = Clock()
        let failure = expectation(description: "swap out does not trip lifecycle")
        failure.isInverted = true
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value },
                                        onFailure: { _ in failure.fulfill() })
        feed(monitor, clock, sample(100, swap: 10))
        feed(monitor, clock, sample(105, swap: 10, swapout: 101))
        XCTAssertEqual(monitor.report.state, .blocked)
        XCTAssertEqual(monitor.report.swapoutsDelta, 1)
        feed(monitor, clock, sample(110, cpu: 10.1, swap: 10, swapout: 101))
        feed(monitor, clock, sample(115, cpu: 10.2, swap: 10, swapout: 101))
        feed(monitor, clock, sample(120, cpu: 10.3, swap: 10, swapout: 101))
        XCTAssertEqual(monitor.report.state, .ready)
        wait(for: [failure], timeout: 0.05)
    }

    func testSwapRefusalClearsStaleProcessReadDiagnostic() {
        let clock = Clock()
        let monitor = DisplayHostHealth(testingOverride: false, now: { clock.value })
        feed(monitor, clock, sample(100, pressure: 2, swap: 10))
        monitor.transientProcessListFailure("colorsync_process_list_timeout")
        XCTAssertEqual(monitor.report.unavailableInput, "colorsync_process_list_timeout")
        feed(monitor, clock, sample(105, pressure: 2, swap: 10, swapout: 101))
        XCTAssertNil(monitor.report.unavailableInput)
        XCTAssertEqual(monitor.report.reasons, ["swap_activity"])
    }

    func testPastWindowServerReportsAreNotAnAdmissionInput() throws {
        // Owner direction (October 16, 2026): a WindowServer report from earlier in the boot no
        // longer refuses display creation; current ColorSync, pressure and swap still do.
        let report = try DisplayHostHealthSample.assess(sample(), sample(105))
        XCTAssertEqual(report.state, .ready)
        let encoded = String(decoding: try JSONEncoder().encode(report), as: UTF8.self)
        XCTAssertFalse(encoded.contains("windowServerDiagnosticReports"))
        XCTAssertFalse(encoded.contains("recent_windowserver_diagnostic"))
    }

    func testSamplerDoesNotStartBeforeFiveSecondsAfterObservation() {
        let clock = Clock()
        clock.value = 102
        let sampled = expectation(description: "no compressed three-second sample")
        sampled.isInverted = true
        let result = sample(105)
        let monitor = DisplayHostHealth(sample: { sampled.fulfill(); return result }, now: { clock.value })
        monitor.accept(sample(102))
        clock.value = 105
        monitor.tick()
        wait(for: [sampled], timeout: 0.05)
        XCTAssertEqual(monitor.report.state, .unknown)
    }

    func testTickPacesFromObservationDespiteSlowTrailingAndLeadingHelpers() {
        let clock = Clock()
        let first = sample(100)
        clock.value = 102.2 // First capture's trailing reconciliation took 2.2 seconds.
        let sampled = expectation(description: "next capture starts from observation spacing")
        sampled.assertForOverFulfill = true
        let monitor = DisplayHostHealth(sample: {
            clock.value += 2.2 // Next capture spends 2.2 seconds before observing CPU.
            sampled.fulfill()
            return .init(uptime: clock.value, pressure: first.pressure,
                         swapins: first.swapins, swapouts: first.swapouts,
                         services: first.services)
        }, now: { clock.value })
        monitor.accept(first)
        // A one-second timer can land almost a second after the five-second spacing.
        clock.value = 106
        monitor.tick()
        wait(for: [sampled], timeout: 1)
        let accepted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            monitor.report.state == .ready
        }, object: nil)
        // XCTest polls predicate expectations once per second. Allow multiple polls for
        // worker completion; runtime timing is asserted solely by the injected clock.
        wait(for: [accepted], timeout: 3)
        XCTAssertEqual(clock.value, 108.2, accuracy: 0.0001)
        XCTAssertEqual(monitor.report.state, .ready)
    }

    func testTrailingValidationDoesNotExtendObservedHealthFreshness() {
        let clock = Clock()
        let monitor = DisplayHostHealth(now: { clock.value })
        monitor.accept(sample(100))
        clock.value = 107.2
        monitor.accept(sample(105)) // Validation completed 2.2 seconds after observation.
        XCTAssertEqual(monitor.report.state, .ready)
        clock.value = 115.1
        XCTAssertEqual(monitor.report.state, .blocked)
        XCTAssertEqual(monitor.report.reasons, ["host_health_stale_or_timed_out"])
    }

    func testProcessParserAllowsAbsentOnDemandServicesAndRequiresExactIdentities() throws {
        let lines = DisplayHostHealthSampler.services.enumerated().map {
            "\($0.offset + 10) Tue Sep 29 20:00:00 2026 01:02.50 \($0.element)"
        }
        let parsed = try DisplayHostHealthSampler.parseServices(lines.joined(separator: "\n"))
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed.values.first?.cpuSeconds, 62.5)
        XCTAssertEqual(try DisplayHostHealthSampler.parseServices(lines[0]).count, 1)
        XCTAssertEqual(try DisplayHostHealthSampler.parseServices("99 Tue Sep 29 20:00:00 2026 00:00.01 /bin/ps").count, 0)
        XCTAssertThrowsError(try DisplayHostHealthSampler.parseServices(""))
        XCTAssertThrowsError(try DisplayHostHealthSampler.parseServices("malformed listing"))
        XCTAssertThrowsError(try DisplayHostHealthSampler.parseServices("invalid " + DisplayHostHealthSampler.services[0]))
        XCTAssertThrowsError(try DisplayHostHealthSampler.parseServices((lines + [lines[0]]).joined(separator: "\n")))
        XCTAssertEqual(try DisplayHostHealthSampler.cpuSeconds("1-02:03:04.5"), 93_784.5)
        for bad in ["NaN", "00:60", "1:99:00", "-1:02", "1:inf"] {
            XCTAssertThrowsError(try DisplayHostHealthSampler.cpuSeconds(bad))
        }
    }


    func testLaunchdEvidenceAcceptsOnlyExactRunningIdleExitAndNeverStartedShapes() throws {
        let service = DisplayHostHealthSampler.services[0]
        XCTAssertEqual(try DisplayHostHealthSampler.launchdService(record(Self.idleFields), service: service), .idle(launches: 23))
        XCTAssertEqual(try DisplayHostHealthSampler.launchdService(record(Self.neverStartedFields), service: service), .idle(launches: 0))
        XCTAssertEqual(try DisplayHostHealthSampler.launchdService(runningRecord(533, runs: 4, service: service), service: service),
                       .running(pid: 533, launches: 4))
        func idle(replacing old: String, with new: String?) -> String {
            record(Self.idleFields.compactMap { $0.hasPrefix(old) ? new : $0 })
        }
        for unsupported in [idle(replacing: "last exit reason", with: "last exit reason = JETSAM_REASON_MEMORY_HIGHWATER"),
                            idle(replacing: "last jetsam exit details", with: "last jetsam exit details = JETSAM_REASON_MEMORY_HIGHWATER"),
                            record(Self.idleFields + ["last terminating signal = Killed: 9"]),
                            record(Self.idleFields + ["last exit code = 1"]),
                            record(Self.idleFields + ["pid = 42"]),
                            idle(replacing: "active count", with: "active count = 1"),
                            idle(replacing: "properties", with: "properties = system service"),
                            idle(replacing: "job state", with: "job state = spawn scheduled"),
                            idle(replacing: "state = not running", with: "state = spawn scheduled"),
                            idle(replacing: "runs", with: "runs = 0"),
                            record(Self.neverStartedFields.map { $0 == "runs = 0" ? "runs = 1" : $0 }),
                            record(Self.neverStartedFields + ["last exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT"]),
                            record(Self.neverStartedFields + ["job state = exited"]),
                            record(["state = running", "runs = 1"]),
                            record(["state = running", "runs = 0", "pid = 533"]),
                            record(["state = running", "runs = 1", "pid = 0"])] {
            assertUnknown(try DisplayHostHealthSampler.launchdService(unsupported, service: service),
                          "colorsync_launchd_state_unsupported")
        }
        for invalid in ["", "malformed", idle(replacing: "runs", with: "runs = -1"), idle(replacing: "runs", with: nil),
                        record(Self.idleFields + ["state = not running"]),
                        record(["state = running", "runs = 1", "pid = 99999999999"]),
                        record(Self.idleFields, service: DisplayHostHealthSampler.services[1])] {
            assertUnknown(try DisplayHostHealthSampler.launchdService(invalid, service: service),
                          "colorsync_launchd_record_invalid")
        }
        assertUnknown(try DisplayHostHealthSampler.launchdService(record(Self.idleFields, program: "/private/other"), service: service),
                      "colorsync_launchd_program_mismatch")
    }

    func testCrashLoopHiddenBetweenAbsentProcessListingsIsUnknownAndSticky() {
        // Neither process listing sees the service, but launchd counted two launches between them.
        assertUnknown(try DisplayHostHealthSample.assess(sample(100, [.idle(launches: 5), .idle(launches: 0)]),
                                                         sample(105, [.idle(launches: 7), .idle(launches: 0)])),
                      "colorsync_launch_count_changed")
        let clock = Clock()
        let monitor = DisplayHostHealth(now: { clock.value })
        monitor.accept(sample(100, [.idle(launches: 5), .idle(launches: 0)]))
        clock.value = 105
        monitor.accept(sample(105, [.idle(launches: 7), .idle(launches: 0)]))
        XCTAssertEqual(monitor.report.state, .blocked)
        XCTAssertEqual(monitor.report.reasons, ["host_health_unknown"])
        XCTAssertEqual(monitor.report.unavailableInput, "colorsync_launch_count_changed")
        clock.value = 110
        monitor.accept(sample(110, [.idle(launches: 7), .idle(launches: 0)]))
        clock.value = 115
        monitor.accept(sample(115, [.idle(launches: 7), .idle(launches: 0)]))
        XCTAssertEqual(monitor.report.state, .blocked)
    }

    func testLaunchCountTransitionsAdmitOnlyStableIdleOrOneAccountedStart() throws {
        let stable = try DisplayHostHealthSample.assess(sample(100, [.idle(launches: 5), .idle(launches: 0)]),
                                                        sample(105, [.idle(launches: 5), .idle(launches: 0)]))
        XCTAssertEqual(stable.state, .ready)
        XCTAssertEqual(stable.colorsyncCPUPercent, 0)
        let started = try DisplayHostHealthSample.assess(
            sample(100, [.idle(launches: 5), .idle(launches: 0)]),
            sample(105, [.running(pid: 40, start: "s", cpuSeconds: 0.1, launches: 6), .idle(launches: 0)]))
        XCTAssertEqual(started.state, .ready)
        XCTAssertEqual(started.colorsyncCPUPercent!, 2, accuracy: 0.001)
        // Whole lifetime CPU of the single new instance still counts toward the busy policy.
        XCTAssertEqual(try DisplayHostHealthSample.assess(
            sample(100, [.idle(launches: 5), .idle(launches: 0)]),
            sample(105, [.running(pid: 40, start: "s", cpuSeconds: 2.5, launches: 6), .idle(launches: 0)])).reasons,
            ["colorsync_busy"])
        for (before, after, reason) in [
            (DisplayHostHealthSample.Service.idle(launches: 5), DisplayHostHealthSample.Service.running(pid: 40, start: "s", cpuSeconds: 0, launches: 7), "colorsync_launch_count_changed"),
            (.idle(launches: 5), .running(pid: 40, start: "s", cpuSeconds: 0, launches: 5), "colorsync_launch_count_changed"),
            (.idle(launches: 5), .idle(launches: 4), "colorsync_launch_count_changed"),
            (.running(pid: 40, start: "s", cpuSeconds: 1, launches: 3), .running(pid: 40, start: "s", cpuSeconds: 1, launches: 4), "colorsync_launch_count_changed"),
            (.running(pid: 40, start: "s", cpuSeconds: 1, launches: 3), .running(pid: 41, start: "s", cpuSeconds: 1, launches: 4), "colorsync_service_changed"),
            (.running(pid: 40, start: "s", cpuSeconds: 1, launches: 3), .idle(launches: 3), "colorsync_service_transition"),
            (.idle(launches: 0), .running(pid: 40, start: "s", cpuSeconds: 1, launches: 0), "colorsync_service_counter"),
            (.idle(launches: UInt64.max), .running(pid: 40, start: "s", cpuSeconds: 1, launches: UInt64.max), "colorsync_launch_count_changed")] {
            assertUnknown(try DisplayHostHealthSample.assess(sample(100, [before, .idle(launches: 0)]),
                                                             sample(105, [after, .idle(launches: 0)])), reason)
        }
        assertUnknown(try DisplayHostHealthSample.assess(sample(100, [.idle(launches: 0)]), sample(105, [.idle(launches: 0)])),
                      "sampling_interval_or_counters")
    }

    func testIdleServiceDoesNotMaskBusyRunningPeer() throws {
        let report = try DisplayHostHealthSample.assess(
            sample(100, [.idle(launches: 23), .running(pid: 2, start: "s", cpuSeconds: 10, launches: 1)]),
            sample(105, [.idle(launches: 23), .running(pid: 2, start: "s", cpuSeconds: 12.5, launches: 1)]))
        XCTAssertEqual(report.reasons, ["colorsync_busy"])
        XCTAssertEqual(report.colorsyncCPUPercent!, 50, accuracy: 0.001)
    }

    func testServiceSampleReconcilesProcessListingsWithBothExactLaunchdJobs() throws {
        let names = DisplayHostHealthSampler.services
        let unrelated = "1 Tue Sep 29 20:00:00 2026 00:00.01 /sbin/launchd"
        func row(_ pid: Int32, _ name: String, start: String = "Tue Sep 29 20:00:00 2026", cpu: String = "00:01.00") -> String {
            "\(pid) \(start) \(cpu) \(name)"
        }
        func run(_ outputs: [String?]) throws -> [String: DisplayHostHealthSample.Service] {
            var queue = outputs, calls: [[String]] = []
            if queue.count == 4 { queue.append(contentsOf: [outputs[1], outputs[2]]) }
            defer { XCTAssertLessThanOrEqual(calls.count, 6) }
            let observation = try DisplayHostHealthSampler.serviceSample(deadline: .init(budget: 60)) { executable, arguments, _ in
                calls.append([executable] + arguments)
                let expected = calls.count == 1 || calls.count == 4 ? "/bin/ps"
                    : "/bin/launchctl"
                XCTAssertEqual(executable, expected)
                if expected == "/bin/launchctl" {
                    let index = calls.count <= 3 ? calls.count - 2 : calls.count - 5
                    XCTAssertEqual(arguments, ["print", "system/" + DisplayHostHealthSampler.launchdLabel(names[index])])
                }
                guard let output = queue.removeFirst() else { throw DisplayHostHealthSample.Unknown() }
                return output
            }
            return observation.services
        }
        let idle0 = record(Self.idleFields, service: names[0]), idle1 = record(Self.neverStartedFields, service: names[1])
        XCTAssertEqual(try run([unrelated, idle0, idle1, unrelated]),
                       [names[0]: .idle(launches: 23), names[1]: .idle(launches: 0)])
        let running = [unrelated, row(533, names[0]), row(546, names[1])].joined(separator: "\n")
        let later = [unrelated, row(533, names[0], cpu: "00:01.50"), row(546, names[1])].joined(separator: "\n")
        XCTAssertEqual(try run([running, runningRecord(533, runs: 2, service: names[0]), runningRecord(546, service: names[1]), later]),
                       [names[0]: .running(pid: 533, start: "Tue Sep 29 20:00:00 2026", cpuSeconds: 1.5, launches: 2),
                        names[1]: .running(pid: 546, start: "Tue Sep 29 20:00:00 2026", cpuSeconds: 1, launches: 1)])
        let appeared = [unrelated, row(533, names[0])].joined(separator: "\n")
        let restarted = [unrelated, row(533, names[0], start: "Tue Sep 29 20:00:09 2026")].joined(separator: "\n")
        let wrongPID = [unrelated, row(534, names[0])].joined(separator: "\n")
        for outputs: [String?] in [[unrelated, idle0, idle1, appeared],                       // started after launchd read
                                   [appeared, idle0, idle1, unrelated],                       // exited before launchd read
                                   [unrelated, runningRecord(533, service: names[0]), idle1, appeared],
                                   [appeared, runningRecord(533, service: names[0]), idle1, restarted],
                                   [wrongPID, runningRecord(533, service: names[0]), idle1, wrongPID]] {
            assertUnknown(try run(outputs), "colorsync_visibility_changed")
        }
        assertUnknown(try run([unrelated, nil]), "colorsync_launchd_unreadable")
        assertUnknown(try run([nil]), "colorsync_process_list")
        assertUnknown(try run(["malformed listing"]), "colorsync_service_counter")
        assertUnknown(try run([unrelated, idle0, "system/ = {"]), "colorsync_launchd_record_invalid")
        assertUnknown(try run([unrelated, idle0, record(["state = not running", "active count = 0", "runs = 4",
                                                         "last terminating signal = Segmentation fault: 11"], service: names[1])]),
                      "colorsync_launchd_state_unsupported")
    }

    func testCPUObservationTimeExcludesAsymmetricTrailingLaunchdLatency() throws {
        let names = DisplayHostHealthSampler.services
        let clock = Clock()
        var capture = 0
        func observe() throws -> DisplayHostHealthSample {
            var calls = 0
            let observation = try DisplayHostHealthSampler.serviceSample(
                deadline: .init(budget: 2.5, clock: { clock.value })
            ) { executable, arguments, _ in
                calls += 1
                if executable == "/bin/ps" {
                    clock.value += 0.05
                    // Forty percent of one CPU, continuously, independent of helper latency.
                    let cpu = String(format: "00:%05.2f", clock.value * 0.4)
                    return "1 Tue Sep 29 20:00:00 2026 00:00.01 /sbin/launchd\n"
                        + "533 Tue Sep 29 20:00:00 2026 \(cpu) \(names[0])"
                }
                if capture == 0, calls == 5 { clock.value += 2 }
                return arguments[1].hasSuffix(DisplayHostHealthSampler.launchdLabel(names[0]))
                    ? self.runningRecord(533, service: names[0])
                    : self.record(Self.neverStartedFields, service: names[1])
            }
            return .init(uptime: observation.uptime, pressure: 1, swapins: 0, swapouts: 0,
                         services: observation.services)
        }
        let before = try observe()
        XCTAssertEqual(before.uptime, 100.1, accuracy: 0.0001)
        // The first reconciliation finished two seconds after the CPU observation. It is
        // still within the capture/watchdog freshness budget, and must not change CPU units.
        let monitor = DisplayHostHealth(now: { clock.value })
        monitor.accept(before)
        clock.value += 5
        capture += 1
        let after = try observe()
        XCTAssertEqual(after.uptime - before.uptime, 7.1, accuracy: 0.0001)
        let report = try DisplayHostHealthSample.assess(before, after)
        XCTAssertEqual(report.state, .ready)
        XCTAssertEqual(report.colorsyncCPUPercent!, 40, accuracy: 0.0001)
        monitor.accept(after)
        XCTAssertEqual(monitor.report.state, .ready)
    }

    func testLaunchAndExitBetweenLaunchdReadAndFinalProcessListRemainsUnknown() {
        let names = DisplayHostHealthSampler.services
        let unrelated = "1 Tue Sep 29 20:00:00 2026 00:00.01 /sbin/launchd"
        let initial = names.map { record(Self.idleFields, service: $0) }
        for changedService in names.indices {
            var final = initial
            final[changedService] = final[changedService].replacingOccurrences(of: "runs = 23", with: "runs = 24")
            var outputs = [unrelated, initial[0], initial[1], unrelated, final[0], final[1]]
            assertUnknown(try DisplayHostHealthSampler.serviceSample(deadline: .init(budget: 60)) { _, _, _ in
                outputs.removeFirst()
            }, "colorsync_visibility_changed")
        }
    }

    func testCaptureBudgetBoundsEveryHelperByRemainingTimeAndStopsWhenSpent() {
        final class FakeTime: @unchecked Sendable { var value = 0.0 }
        let time = FakeTime()
        let deadline = DisplayHostHealthSampler.Deadline(budget: 2.5) { time.value }
        XCTAssertEqual(try deadline.remaining(atMost: 1), 1)
        var timeouts: [TimeInterval] = []
        let names = DisplayHostHealthSampler.services
        assertUnknown(try DisplayHostHealthSampler.serviceSample(deadline: deadline) { executable, _, timeout in
            timeouts.append(timeout)
            time.value += 1
            if executable == "/bin/ps" { return "1 Tue Sep 29 20:00:00 2026 00:00.01 /sbin/launchd" }
            return self.record(Self.idleFields, service: names[timeouts.count - 2])
        }, "host_health_capture_budget")
        XCTAssertEqual(timeouts, [2.5, 1.5, 0.5])
        XCTAssertLessThan(DisplayHostHealthSampler.captureBudget, 3, "must finish inside the in-flight watchdog")
        time.value = .nan
        assertUnknown(try deadline.remaining(), "host_health_capture_budget")
    }

    func testUnavailableInputIsExposedWithoutChangingReasonContract() {
        let failed = expectation(description: "failure diagnostic")
        let monitor = DisplayHostHealth(sample: { throw DisplayHostHealthSample.Unknown("vm_statistics") },
            onFailure: { reason in
                XCTAssertEqual(reason, "host health: host_health_unknown (vm_statistics)")
                failed.fulfill()
            })
        monitor.tick()
        wait(for: [failed], timeout: 1)
        XCTAssertEqual(monitor.report.reasons, ["host_health_unknown"])
        XCTAssertEqual(monitor.report.unavailableInput, "vm_statistics")
    }

    func testReadOnlyHelperDeadlineAndOutputLimit() throws {
        XCTAssertEqual(try DisplayHostHealthSampler.readHelper(executable: "/usr/bin/printf", arguments: ["safe"]), "safe")
        XCTAssertThrowsError(try DisplayHostHealthSampler.readHelper(executable: "/usr/bin/printf", arguments: ["too large"], maximumBytes: 2)) {
            XCTAssertEqual($0 as? DisplayHostHealthSampler.HelperFailure, .outputLimit)
        }
        let start = ContinuousClock.now
        XCTAssertThrowsError(try DisplayHostHealthSampler.readHelper(executable: "/bin/sleep", arguments: ["3"], timeout: 0.05)) {
            XCTAssertEqual($0 as? DisplayHostHealthSampler.HelperFailure, .timeout)
        }
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
    }

    func testProcessHelperFailureCategoryIsReportedWithoutProcessOutput() {
        let secret = "should-never-appear"
        let deadline = DisplayHostHealthSampler.Deadline()
        XCTAssertThrowsError(try DisplayHostHealthSampler.serviceSample(deadline: deadline) { _, _, _ in
            _ = secret
            throw DisplayHostHealthSampler.HelperFailure.timeout
        }) { error in
            let reason = (error as? DisplayHostHealthSample.Unknown)?.reason
            XCTAssertEqual(reason, "colorsync_process_list_timeout")
            XCTAssertFalse(reason?.contains(secret) ?? true)
        }
    }
}
