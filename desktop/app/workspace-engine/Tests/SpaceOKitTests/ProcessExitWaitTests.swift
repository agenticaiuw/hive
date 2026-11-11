import XCTest
@testable import SpaceOKit

final class ProcessExitWaitTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        var time: UInt64 = 0
        var sleeps: [UInt64] = []
        var oversleep: UInt64 = 0
        var runtime: ProcessExitWait.Runtime {
            .init(now: { self.time }, sleep: {
                self.sleeps.append($0)
                self.time += $0 + self.oversleep
            })
        }
    }

    func testEmptyInputAndImmediateExitDoNotSleep() {
        let clock = Clock()
        XCTAssertEqual(ProcessExitWait.wait([Int](), timeout: 30, runtime: clock.runtime) { _ in
            XCTFail("empty input must not probe"); return true
        }, [])
        var reads: [Int] = []
        XCTAssertEqual(ProcessExitWait.wait([1, 2], timeout: 30, runtime: clock.runtime) {
            reads.append($0); return false
        }, [])
        XCTAssertEqual(reads, [1, 2])
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testFinalSleepUsesRemainderAndNoProbeStartsAtDeadline() {
        let clock = Clock()
        var probeTimes: [UInt64] = []
        XCTAssertEqual(ProcessExitWait.wait([1], timeout: 0.55, runtime: clock.runtime) { _ in
            probeTimes.append(clock.time); return true
        }, [1])
        XCTAssertEqual(probeTimes, [0, 120_000_000, 240_000_000, 360_000_000, 480_000_000])
        XCTAssertEqual(clock.sleeps, [120_000_000, 120_000_000, 120_000_000, 120_000_000, 70_000_000])
        XCTAssertEqual(clock.time, 550_000_000)
    }

    func testConfirmedExitsAreNeverPolledAgainAndSurvivorOrderIsStable() {
        let clock = Clock()
        var reads: [Int] = []
        let survivors = ProcessExitWait.wait([1, 2, 3, 4], timeout: 0.3, runtime: clock.runtime) {
            reads.append($0)
            return $0 != 1 && !($0 == 3 && clock.time >= 120_000_000)
        }
        XCTAssertEqual(survivors, [2, 4])
        XCTAssertEqual(reads, [1, 2, 3, 4, 2, 3, 4, 2, 4])
        XCTAssertEqual(clock.sleeps, [120_000_000, 120_000_000, 60_000_000])
    }

    func testAllProcessesExitingOnNextPollEndsWithoutAnotherSleep() {
        let clock = Clock()
        XCTAssertEqual(ProcessExitWait.wait([1, 2], timeout: 2, runtime: clock.runtime) { _ in
            clock.time == 0
        }, [])
        XCTAssertEqual(clock.sleeps, [120_000_000])
    }

    func testSlowProbeRetainsItsLateExitAndUnqueriedSuffix() {
        let clock = Clock()
        var reads: [Int] = []
        XCTAssertEqual(ProcessExitWait.wait([1, 2, 3], timeout: 0.2, runtime: clock.runtime) {
            reads.append($0)
            if $0 == 2 { clock.time = 210_000_000 }
            return false
        }, [2, 3])
        XCTAssertEqual(reads, [1, 2])
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testProbeDurationReducesSleepAndLateWakeDoesNotStartMoreWork() {
        let clock = Clock()
        var reads = 0
        XCTAssertEqual(ProcessExitWait.wait([1], timeout: 0.15, runtime: clock.runtime) { _ in
            reads += 1; clock.time += 80_000_000; return true
        }, [1])
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(clock.sleeps, [70_000_000])

        clock.time = 0
        clock.sleeps = []
        clock.oversleep = 1_000_000_000
        reads = 0
        XCTAssertEqual(ProcessExitWait.wait([1], timeout: 0.15, runtime: clock.runtime) { _ in
            reads += 1; return true
        }, [1])
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(clock.sleeps, [120_000_000])
    }

    func testZeroNegativeAndNonfiniteTimeoutsPerformOneScanWithoutSleep() {
        for timeout in [0, -1, Double.nan, Double.infinity, -Double.infinity] {
            let clock = Clock()
            var reads: [Int] = []
            XCTAssertEqual(ProcessExitWait.wait([1, 2], timeout: timeout, runtime: clock.runtime) {
                reads.append($0); return $0 == 2
            }, [2])
            XCTAssertEqual(reads, [1, 2])
            XCTAssertTrue(clock.sleeps.isEmpty)
        }
    }

    func testHugeTimeoutIsCappedAndNanosecondDeadlineCannotOverflow() {
        let clock = Clock()
        XCTAssertEqual(ProcessExitWait.wait([1], timeout: .greatestFiniteMagnitude,
                                            runtime: clock.runtime) { _ in true }, [1])
        XCTAssertEqual(clock.time, 30_000_000_000)
        XCTAssertEqual(clock.sleeps.count, 250)
        clock.time = UInt64.max - 10
        clock.sleeps = []
        XCTAssertEqual(ProcessExitWait.wait([1], timeout: 1, runtime: clock.runtime) { _ in true }, [1])
        XCTAssertEqual(clock.sleeps, [10])
    }

    func testExactIdentityReplacementCompletesButUncertaintyRemainsPending() {
        let original = ProcessIdentity(pid: 101, startedAtMicroseconds: 1)
        let other = ProcessIdentity(pid: 102, startedAtMicroseconds: 2)
        let replacement = ProcessIdentity(pid: 101, startedAtMicroseconds: 3)
        let clock = Clock()
        var reads: [ProcessIdentity] = []
        XCTAssertEqual(ProcessExitWait.wait([original, other], timeout: 0.3, runtime: clock.runtime) {
            reads.append($0)
            if $0 == other { return true } // Missing evidence of exit retains ownership.
            let current = clock.time == 0 ? original : replacement
            return current == $0
        }, [other])
        XCTAssertEqual(reads, [original, other, original, other, other])
    }
}
