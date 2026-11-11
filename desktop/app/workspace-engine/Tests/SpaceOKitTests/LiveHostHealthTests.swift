import XCTest
@testable import SpaceOKit

final class LiveHostHealthTests: XCTestCase {
    func testHelperSuccessCannotHideNativeCircuitOrUnknownReadiness() throws {
        try LiveHostHealth.run(executable: "/usr/bin/true", arguments: [])
        for lifecycle in [DisplaySafetyStatus.State.ready, .blocked, .unknown] {
            for health in [DisplaySafetyStatus.State.ready, .blocked, .unknown] {
                let check = {
                    try LiveHostHealth.requireNativeReadiness(
                        lifecycle: .init(state: lifecycle, reason: nil),
                        health: .init(state: health, reasons: []))
                }
                if lifecycle == .ready && health == .ready { XCTAssertNoThrow(try check()) }
                else { XCTAssertThrowsError(try check()) }
            }
        }
        XCTAssertNoThrow(try LiveHostHealth.requireNativeReadiness(
            lifecycle: .init(state: .ready, reason: nil),
            health: .init(state: .unknown, reasons: ["not_sampled"])))
        XCTAssertThrowsError(try LiveHostHealth.requireNativeReadiness(
            lifecycle: .init(state: .ready, reason: nil),
            health: .init(state: .blocked, reasons: ["not_sampled"])))
        for lifecycle in [DisplaySafetyStatus.State.blocked, .unknown] {
            XCTAssertThrowsError(try LiveHostHealth.requireNativeReadiness(
                lifecycle: .init(state: lifecycle, reason: nil),
                health: .init(state: .unknown, reasons: ["not_sampled"])))
        }
        XCTAssertThrowsError(try LiveHostHealth.requireNativeReadiness(
            lifecycle: .init(state: .ready, reason: nil),
            health: .init(state: .unknown, reasons: ["not_sampled", "other"])))
    }
    func testOnlySuccessfulHelperExitAdmitsWork() throws {
        try LiveHostHealth.run(executable: "/usr/bin/true", arguments: [])
        XCTAssertThrowsError(try LiveHostHealth.run(executable: "/usr/bin/false", arguments: []))
        XCTAssertThrowsError(try LiveHostHealth.run(executable: "/missing-spaceo-health-helper", arguments: []))
    }

    func testMissingOrRelativeHelperIsRefused() {
        for path in [nil, "", "scripts/host-health.py", "/invalid\0path"] as [String?] {
            XCTAssertThrowsError(try LiveHostHealth.requireAdmission(scriptPath: path))
        }
    }

    func testStuckReadOnlyHelperIsBounded() {
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try LiveHostHealth.run(executable: "/bin/sleep", arguments: ["10"], timeout: 0.05)) {
            guard case LiveHostHealth.Failure.timedOut = $0 else {
                return XCTFail("expected helper deadline refusal")
            }
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2)
    }
}
