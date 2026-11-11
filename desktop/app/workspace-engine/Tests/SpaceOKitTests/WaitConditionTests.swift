import XCTest
import Foundation
@testable import SpaceOKit

/// A clock that only moves when the loop sleeps, so every test is deterministic and finishes
/// without waiting for real time.
private final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000)
    private(set) var sleeps: [TimeInterval] = []

    func now() -> Date { lock.withLock { current } }

    func advance(_ duration: TimeInterval) { lock.withLock { current = current.addingTimeInterval(duration) } }

    func sleep(_ duration: TimeInterval) async throws {
        lock.withLock {
            sleeps.append(duration)
            current = current.addingTimeInterval(duration)
        }
    }
}

/// Replays a script of results, one per probe, and repeats the last entry forever so a test
/// can describe "not yet, not yet, met" without worrying about extra probes.
private final class ScriptedEvaluator: WaitEvaluating, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [WaitProbeResult]
    private(set) var probeCount = 0
    private(set) var conditions: [WaitCondition] = []
    var error: Error?
    var onProbe: (() -> Void)?

    init(_ script: [WaitProbeResult]) { self.script = script }

    func probe(_ condition: WaitCondition) async throws -> WaitProbeResult {
        try lock.withLock {
            if let error { throw error }
            probeCount += 1
            onProbe?()
            conditions.append(condition)
            let index = min(probeCount - 1, script.count - 1)
            return script[index]
        }
    }
}

private final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var afterSleeps: Int
    private var sleeps = 0
    init(afterSleeps: Int) { self.afterSleeps = afterSleeps }
    func recordSleep() { lock.withLock { sleeps += 1 } }
    func isCancelled() -> Bool { lock.withLock { sleeps >= afterSleeps } }
}

final class WaitConditionTests: XCTestCase {

    private func run(
        _ condition: WaitCondition,
        deadline: TimeInterval = 5,
        interval: TimeInterval = 0.25,
        maximumProbes: Int = 400,
        evaluator: ScriptedEvaluator,
        clock: FakeClock = FakeClock(),
        isCancelled: @escaping @Sendable () -> Bool = { false }
    ) async throws -> WaitReceipt {
        let policy = try WaitPolicy(deadline: deadline, interval: interval, maximumProbes: maximumProbes)
        return try await WaitLoop.run(
            condition, policy: policy, evaluator: evaluator,
            now: { clock.now() }, sleep: { try await clock.sleep($0) }, isCancelled: isCancelled)
    }

    // MARK: Parsing

    func testParseAcceptsEveryKindAndRoundTripsKindAndValue() throws {
        let cases: [(String, String, WaitCondition)] = [
            ("element_label", "Save", .elementLabel("Save")),
            ("element_gone", "Loading", .elementGone("Loading")),
            ("window_title_contains", "Untitled", .windowTitleContains("Untitled")),
            ("web_selector", "#done", .webSelector("#done")),
            ("web_title_contains", "Inbox", .webTitleContains("Inbox")),
            ("stable_ms", "500", .stableMs(500)),
            ("ms", "250", .ms(250)),
        ]
        for (kind, value, expected) in cases {
            let parsed = try WaitCondition.parse(kind: kind, value: value)
            XCTAssertEqual(parsed, expected)
            XCTAssertEqual(parsed.kind, kind)
            XCTAssertEqual(parsed.value, value)
        }
    }

    func testParseRejectsUnknownKind() {
        XCTAssertThrowsError(try WaitCondition.parse(kind: "pixel_color", value: "x")) { error in
            guard case .badRequest(let message)? = error as? SpaceOError else { return XCTFail("\(error)") }
            XCTAssertTrue(message.contains("pixel_color"))
            XCTAssertTrue(message.contains("element_label"))
        }
    }

    func testParseRejectsMissingEmptyOversizedAndControlStrings() {
        XCTAssertThrowsError(try WaitCondition.parse(kind: "element_label", value: nil))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "element_label", value: ""))
        let oversized = String(repeating: "a", count: WaitCondition.maximumValueBytes + 1)
        XCTAssertThrowsError(try WaitCondition.parse(kind: "web_selector", value: oversized)) { error in
            XCTAssertEqual((error as? SpaceOError)?.code, "bad_request")
            XCTAssertTrue("\(error)".contains("481 bytes"))
        }
        let exact = String(repeating: "é", count: WaitCondition.maximumValueBytes / 2)  // 2 bytes each
        XCTAssertNoThrow(try WaitCondition.parse(kind: "web_selector", value: exact))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "window_title_contains", value: "a\u{1B}b")) { error in
            XCTAssertTrue("\(error)".contains("control characters"))
        }
    }

    func testParseBoundsIntegers() {
        XCTAssertThrowsError(try WaitCondition.parse(kind: "stable_ms", value: "99"))
        XCTAssertNoThrow(try WaitCondition.parse(kind: "stable_ms", value: "100"))
        XCTAssertNoThrow(try WaitCondition.parse(kind: "stable_ms", value: "60000"))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "stable_ms", value: "60001"))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "ms", value: "0"))
        XCTAssertNoThrow(try WaitCondition.parse(kind: "ms", value: "1"))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "ms", value: "60001"))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "ms", value: "soon"))
        XCTAssertThrowsError(try WaitCondition.parse(kind: "ms", value: nil))
    }

    func testPolicyValidation() {
        XCTAssertThrowsError(try WaitPolicy(deadline: 0))
        XCTAssertThrowsError(try WaitPolicy(deadline: 61))
        XCTAssertThrowsError(try WaitPolicy(deadline: .infinity))
        XCTAssertThrowsError(try WaitPolicy(deadline: 5, interval: 0))
        XCTAssertThrowsError(try WaitPolicy(deadline: 1, interval: 2))
        XCTAssertThrowsError(try WaitPolicy(deadline: 5, maximumProbes: 0))
        XCTAssertNoThrow(try WaitPolicy(deadline: 60))
        let policy = try? WaitPolicy(deadline: 10)
        XCTAssertEqual(policy?.interval, 0.25)
        XCTAssertEqual(policy?.maximumProbes, 400)
    }

    // MARK: Loop semantics

    func testMetOnThirdProbeCarriesProbeDetail() async throws {
        let clock = FakeClock()
        let evaluator = ScriptedEvaluator([
            .notYet(nil), .notYet(WaitProbe(snapshotID: "s1")),
            .met(WaitProbe(matchedIndex: 7, matchedTitle: "Save", snapshotID: "s2")),
        ])
        let receipt = try await run(.elementLabel("Save"), evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "met")
        XCTAssertEqual(receipt.probes, 3)
        XCTAssertEqual(evaluator.probeCount, 3)
        XCTAssertEqual(receipt.matchedIndex, 7)
        XCTAssertEqual(receipt.matchedTitle, "Save")
        XCTAssertEqual(receipt.snapshotID, "s2")
        XCTAssertEqual(receipt.condition, "element_label")
        XCTAssertEqual(receipt.value, "Save")
        XCTAssertEqual(receipt.elapsedSeconds, 0.5, accuracy: 0.0001)
        XCTAssertEqual(clock.sleeps, [0.25, 0.25])
        XCTAssertEqual(evaluator.conditions.first, .elementLabel("Save"))
    }

    func testTimeoutIsANormalOutcomeWithExactProbeCount() async throws {
        let clock = FakeClock()
        let evaluator = ScriptedEvaluator([.notYet(WaitProbe(snapshotID: "last"))])
        let receipt = try await run(.windowTitleContains("Never"), deadline: 1, interval: 0.25,
                                    evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "timeout")
        // No additional remote query begins when the deadline has already arrived.
        XCTAssertEqual(receipt.probes, 4)
        XCTAssertEqual(receipt.elapsedSeconds, 1, accuracy: 0.0001)
        XCTAssertEqual(receipt.snapshotID, "last")
        XCTAssertNil(receipt.matchedIndex)
    }

    func testFinalSleepIsClampedToTheDeadline() async throws {
        let clock = FakeClock()
        let evaluator = ScriptedEvaluator([.notYet(nil)])
        let receipt = try await run(.webSelector("#x"), deadline: 1, interval: 0.4,
                                    evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(clock.sleeps.count, 3)
        for (actual, expected) in zip(clock.sleeps, [0.4, 0.4, 0.2]) {
            XCTAssertEqual(actual, expected, accuracy: 0.0001)
        }
        XCTAssertEqual(receipt.elapsedSeconds, 1, accuracy: 0.0001)
    }

    func testMaximumProbesTerminatesEvenWhenClockIsFrozen() async throws {
        // A clock that never advances would otherwise loop forever.
        let evaluator = ScriptedEvaluator([.notYet(nil)])
        let policy = try WaitPolicy(deadline: 5, interval: 0.25, maximumProbes: 3)
        let frozen = Date(timeIntervalSince1970: 10)
        let receipt = try await WaitLoop.run(
            .elementGone("Spinner"), policy: policy, evaluator: evaluator,
            now: { frozen }, sleep: { _ in }, isCancelled: { false })
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.probes, 3)
    }

    func testStableRequiresUnchangedHashForTheFullDuration() async throws {
        let clock = FakeClock()
        // Hash changes at probes 1-3, then holds from probe 4 on. With a 250ms interval a
        // 500ms stability window needs probes 4, 5, 6 (t=0.75, 1.0, 1.25).
        let evaluator = ScriptedEvaluator([
            .notYet(WaitProbe(frameHash: 1)), .notYet(WaitProbe(frameHash: 2)),
            .notYet(WaitProbe(frameHash: 3)), .notYet(WaitProbe(frameHash: 9)),
        ])
        let receipt = try await run(.stableMs(500), evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "met")
        XCTAssertEqual(receipt.probes, 6)
        XCTAssertEqual(receipt.elapsedSeconds, 1.25, accuracy: 0.0001)
    }

    func testStabilityConfirmationDoesNotRoundUpToPollingInterval() async throws {
        for milliseconds in [100, 130, 300, 450, 550] {
            let clock = FakeClock()
            let evaluator = ScriptedEvaluator([.notYet(WaitProbe(frameHash: 7))])
            let receipt = try await run(.stableMs(milliseconds), deadline: 1,
                                        evaluator: evaluator, clock: clock)
            XCTAssertEqual(receipt.outcome, "met")
            XCTAssertEqual(receipt.elapsedSeconds, Double(milliseconds) / 1_000, accuracy: 0.000001)
            XCTAssertEqual(receipt.probes, Int(ceil(Double(milliseconds) / 250)) + 1)
            XCTAssertTrue(clock.sleeps.allSatisfy { $0 > 0 && $0 <= 0.25 })
        }
    }

    func testStabilityCanBeConfirmedBeforeDeadlineBetweenNormalPolls() async throws {
        let receipt = try await run(.stableMs(450), deadline: 0.5,
            evaluator: ScriptedEvaluator([.notYet(WaitProbe(frameHash: 7))]))
        XCTAssertEqual(receipt.outcome, "met")
        XCTAssertEqual(receipt.elapsedSeconds, 0.45, accuracy: 0.000001)
        XCTAssertEqual(receipt.probes, 3)
    }

    func testStabilityWatchdogDoesNotShortenLongWaitsWithIntermediateConfirmations() async throws {
        let condition = WaitCondition.stableMs(251)
        let policy = try WaitPolicy(deadline: 60, condition: condition)
        let clock = FakeClock()
        // The image changes on each confirmation, then holds at the intervening ordinary poll.
        let evaluator = ScriptedEvaluator((0..<1_000).map {
            .notYet(WaitProbe(frameHash: UInt64($0 / 2)))
        })
        let receipt = try await WaitLoop.run(condition, policy: policy, evaluator: evaluator,
            now: { clock.now() }, sleep: { try await clock.sleep($0) })
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.elapsedSeconds, 60, accuracy: 0.000001)
        XCTAssertGreaterThan(receipt.probes, 400)
        XCTAssertLessThanOrEqual(receipt.probes, policy.maximumProbes)
        XCTAssertLessThanOrEqual(try WaitPolicy(deadline: 60, condition: .stableMs(100)).maximumProbes,
                                 WaitPolicy.maximumProbeCeiling)
        XCTAssertEqual(try WaitPolicy(deadline: 60, condition: .elementLabel("Done")).maximumProbes, 400)
        XCTAssertThrowsError(try WaitPolicy(deadline: 60, condition: .stableMs(0)))
    }

    func testShortStabilityIntervalStillRequiresAConfirmingObservationAfterChanges() async throws {
        let evaluator = ScriptedEvaluator([
            .notYet(WaitProbe(frameHash: 1)), .notYet(WaitProbe(frameHash: 2)),
            .notYet(WaitProbe(frameHash: 2)),
        ])
        let receipt = try await run(.stableMs(100), evaluator: evaluator)
        XCTAssertEqual(receipt.outcome, "met")
        XCTAssertEqual(receipt.elapsedSeconds, 0.2, accuracy: 0.000001)
        XCTAssertEqual(receipt.probes, 3)
    }

    func testExpiredProbeAdmissionReturnsTimeoutWithoutCountingAnObservation() async throws {
        let evaluator = ScriptedEvaluator([.notYet(nil)])
        evaluator.error = WaitProbeDeadlineExceeded()
        let receipt = try await run(.elementLabel("Done"), evaluator: evaluator)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.probes, 0)
        XCTAssertEqual(evaluator.probeCount, 0)
        XCTAssertNil(receipt.snapshotID)
    }

    func testStableIgnoresEvaluatorMetVerdictAndResetsOnChange() async throws {
        let clock = FakeClock()
        // The evaluator claims "met" on every probe but the hash keeps flipping: never stable.
        let evaluator = ScriptedEvaluator([
            .met(WaitProbe(frameHash: 1)), .met(WaitProbe(frameHash: 2)),
        ])
        var receipt = try await run(.stableMs(300), deadline: 0.5, evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "timeout")

        // A missing hash resets the run; stability is counted from the next hash seen.
        let gappy = ScriptedEvaluator([
            .notYet(WaitProbe(frameHash: 5)), .notYet(nil), .notYet(WaitProbe(frameHash: 5)),
        ])
        receipt = try await run(.stableMs(250), evaluator: gappy, clock: FakeClock())
        XCTAssertEqual(receipt.outcome, "met")
        // Probe 3 (t=0.5) restarts the window; probe 4 (t=0.75) completes 250ms.
        XCTAssertEqual(receipt.probes, 4)
    }

    func testInitialQueueResidenceConsumesPlainPauseBudget() async throws {
        let clock = FakeClock()
        let started = clock.now()
        clock.advance(0.8)
        let evaluator = ScriptedEvaluator([.met(WaitProbe())])
        let receipt = try await WaitLoop.run(.ms(500), policy: WaitPolicy(deadline: 1), evaluator: evaluator,
            now: { clock.now() }, sleep: { try await clock.sleep($0) }, startedAt: started)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.elapsedSeconds, 1, accuracy: 0.000001)
        XCTAssertEqual(clock.sleeps.count, 1)
        XCTAssertEqual(clock.sleeps.first ?? 0, 0.2, accuracy: 0.000001)
        XCTAssertEqual(evaluator.probeCount, 0)
    }

    func testExpiredInitialBudgetNeverStartsAnObservation() async throws {
        let clock = FakeClock()
        let started = clock.now()
        clock.advance(1)
        let evaluator = ScriptedEvaluator([.met(WaitProbe())])
        let receipt = try await WaitLoop.run(.elementLabel("Done"), policy: WaitPolicy(deadline: 1), evaluator: evaluator,
            now: { clock.now() }, sleep: { try await clock.sleep($0) }, startedAt: started)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.probes, 0)
        XCTAssertEqual(evaluator.probeCount, 0)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testPlainMsSleepsOnceWithoutProbing() async throws {
        let clock = FakeClock()
        let evaluator = ScriptedEvaluator([.met(WaitProbe())])
        let receipt = try await run(.ms(750), evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "met")
        XCTAssertEqual(receipt.probes, 0)
        XCTAssertEqual(evaluator.probeCount, 0)
        XCTAssertEqual(clock.sleeps, [0.75])
        XCTAssertEqual(receipt.elapsedSeconds, 0.75, accuracy: 0.0001)
    }

    func testPlainMsIsClampedToThePolicyDeadline() async throws {
        let clock = FakeClock()
        let receipt = try await run(.ms(60_000), deadline: 2, evaluator: ScriptedEvaluator([.notYet(nil)]), clock: clock)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(clock.sleeps, [2])
    }

    func testCancellationProducesCancelledOutcome() async throws {
        let clock = FakeClock()
        let flag = CancelFlag(afterSleeps: 2)
        let evaluator = ScriptedEvaluator([.notYet(nil)])
        let policy = try WaitPolicy(deadline: 10)
        let receipt = try await WaitLoop.run(
            .elementLabel("Done"), policy: policy, evaluator: evaluator,
            now: { clock.now() },
            sleep: { duration in try await clock.sleep(duration); flag.recordSleep() },
            isCancelled: { flag.isCancelled() })
        XCTAssertEqual(receipt.outcome, "cancelled")
        XCTAssertEqual(receipt.probes, 2)
        XCTAssertEqual(receipt.elapsedSeconds, 0.5, accuracy: 0.0001)
    }

    func testCancellationErrorFromSleepBecomesCancelledOutcome() async throws {
        let clock = FakeClock()
        let policy = try WaitPolicy(deadline: 10)
        let receipt = try await WaitLoop.run(
            .ms(500), policy: policy, evaluator: ScriptedEvaluator([.notYet(nil)]),
            now: { clock.now() }, sleep: { _ in throw CancellationError() }, isCancelled: { false })
        XCTAssertEqual(receipt.outcome, "cancelled")
    }

    func testProbeThatFinishesAfterDeadlineCannotClaimMet() async throws {
        let clock = FakeClock()
        let evaluator = ScriptedEvaluator([.met(WaitProbe(matchedIndex: 7))])
        evaluator.onProbe = { clock.advance(2) }
        let receipt = try await run(.elementLabel("Done"), deadline: 1, evaluator: evaluator, clock: clock)
        XCTAssertEqual(receipt.outcome, "timeout")
        XCTAssertEqual(receipt.probes, 1)
        XCTAssertNil(receipt.matchedIndex)
    }

    func testCancellationDuringProbeWinsOverItsResult() async throws {
        let flag = CancelFlag(afterSleeps: 1)
        let evaluator = ScriptedEvaluator([.met(WaitProbe())])
        evaluator.onProbe = { flag.recordSleep() }
        let receipt = try await run(.elementLabel("Done"), evaluator: evaluator,
                                    isCancelled: { flag.isCancelled() })
        XCTAssertEqual(receipt.outcome, "cancelled")
        XCTAssertEqual(receipt.probes, 1)
    }

    func testProbeCancellationProducesReceipt() async throws {
        for error in [CancellationError() as Error, AXTraversalStopped(reason: .cancelled, detail: "test")] {
            let evaluator = ScriptedEvaluator([.notYet(nil)])
            evaluator.error = error
            let receipt = try await run(.elementLabel("Done"), evaluator: evaluator)
            XCTAssertEqual(receipt.outcome, "cancelled")
        }
    }

    func testMutatedPolicyIsValidatedBeforeExecuting() async throws {
        let evaluator = ScriptedEvaluator([.met(WaitProbe())])
        var policy = try WaitPolicy(deadline: 1)
        policy.interval = .nan
        do {
            _ = try await WaitLoop.run(.ms(5), policy: policy, evaluator: evaluator,
                                      now: { Date() }, sleep: { _ in XCTFail("must not sleep") })
            XCTFail("invalid policy was accepted")
        } catch {
            XCTAssertEqual((error as? SpaceOError)?.code, "bad_request")
        }
        XCTAssertEqual(evaluator.probeCount, 0)
    }

    func testEvaluatorErrorsPropagate() async throws {
        let evaluator = ScriptedEvaluator([.notYet(nil)])
        evaluator.error = SpaceOError.accessibilityDenied
        do {
            _ = try await run(.elementLabel("X"), evaluator: evaluator)
            XCTFail("expected the evaluator error to propagate")
        } catch let error as SpaceOError {
            XCTAssertEqual(error, .accessibilityDenied)
        }
    }
}
