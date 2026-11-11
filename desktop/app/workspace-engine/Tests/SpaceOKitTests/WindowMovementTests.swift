import ApplicationServices
import CoreGraphics
import XCTest
@testable import SpaceOKit

final class WindowMovementTests: XCTestCase {
    private let target = CGRect(x: 1_000, y: 100, width: 600, height: 400)
    private let before = CGRect(x: 0, y: 100, width: 800, height: 600)

    private final class Provider: AXWindowMovementProviding {
        typealias Element = Int
        var time: UInt64 = 0
        var calls: [String] = []
        var timeouts: [Float] = []
        var sleeps: [UInt64] = []
        var costs: [String: UInt64] = [:]
        var timeoutAccepted = true
        var setterAccepted = true
        var id: CGWindowID = 42
        var axPoint: CGPoint?
        var axSize: CGSize?
        var onCall: ((String) -> Void)?
        func record(_ call: String) {
            calls.append(call)
            time += costs[call, default: 0]
            onCall?(call)
        }
        func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool {
            timeouts.append(seconds)
            time += costs["timeout", default: 0]
            return timeoutAccepted
        }
        func windowID(_ element: Int) -> CGWindowID { record("id"); return id }
        func setPosition(_ element: Int, _ point: CGPoint) -> Bool { record("position"); return setterAccepted }
        func setDimensions(_ element: Int, _ size: CGSize) -> Bool { record("dimensions"); return setterAccepted }
        func point(_ element: Int, attribute: String) -> CGPoint? { record("point"); return axPoint }
        func size(_ element: Int, attribute: String) -> CGSize? { record("size"); return axSize }
        func string(_ element: Int, attribute: String) -> String? { XCTFail("unnecessary text read"); return nil }
        func bool(_ element: Int, attribute: String) -> Bool? { XCTFail("unnecessary boolean read"); return nil }
        func actions(_ element: Int) -> [String] { XCTFail("unnecessary action read"); return [] }
        func arrayCount(_ element: Int, attribute: String) -> Int { XCTFail("no tree traversal"); return 0 }
        func elements(_ element: Int, attribute: String, start: Int, maxValues: Int) -> [Int] {
            XCTFail("no array copies"); return []
        }
    }

    private func move(_ provider: Provider, limits: AXTraversalLimits = WindowMovement.limits,
                      validate: () throws -> Void = {}, bounds: () -> CGRect?) throws -> CGRect {
        let budget = try AXTraversalBudget(limits: limits, now: { provider.time }, isCancelled: { false })
        return try WindowMovement.perform(windowID: 42, target: target, element: 1,
            provider: provider, budget: budget, validate: validate, liveBounds: {
                provider.record("bounds")
                return bounds()
            }, sleep: { provider.sleeps.append($0); provider.time += $0 })
    }

    private func assertStopped(_ reason: AXTraversalStopReason, _ operation: () throws -> Void,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason, file: file, line: line)
        }
    }

    func testExactServerGeometryAvoidsEverySetterAndSleep() throws {
        let provider = Provider()
        XCTAssertEqual(try move(provider, bounds: { target }), target)
        XCTAssertEqual(provider.calls, ["id", "bounds"])
        XCTAssertEqual(provider.timeouts, [0.25])
        XCTAssertTrue(provider.sleeps.isEmpty)
    }

    func testMismatchedServerGeometryStillMovesAndConfirmsTheTarget() throws {
        let provider = Provider()
        var probes = 0
        XCTAssertEqual(try move(provider) {
            probes += 1
            return probes == 1 ? before : target
        }, target)
        XCTAssertEqual(provider.calls, ["id", "bounds", "position", "dimensions", "position", "bounds"])
        XCTAssertEqual(provider.timeouts, [0.25, 0.25, 0.25, 0.25])
        XCTAssertTrue(provider.sleeps.isEmpty)
    }

    func testContainedButDifferentGeometryDoesNotSkipTheRequestedMutation() throws {
        let provider = Provider()
        var probes = 0
        let smaller = target.insetBy(dx: 10, dy: 10)
        XCTAssertEqual(try move(provider) {
            probes += 1
            return probes == 1 ? smaller : target
        }, target)
        XCTAssertEqual(provider.calls.filter { $0 == "position" }.count, 2)
        XCTAssertEqual(provider.calls.filter { $0 == "dimensions" }.count, 1)
    }

    func testLateInitialObservationCannotConfirmANoOpOrStartSetters() {
        let provider = Provider()
        provider.costs["bounds"] = 1_000_000_000
        assertStopped(.deadline) { _ = try move(provider, bounds: { target }) }
        XCTAssertEqual(provider.calls, ["id", "bounds"])
        XCTAssertTrue(provider.sleeps.isEmpty)
    }

    func testChangedProcessDuringInitialObservationCannotConfirmANoOpOrStartSetters() {
        let provider = Provider()
        var valid = true
        XCTAssertThrowsError(try move(provider, validate: {
            if !valid { throw SpaceOError.windowNotFound("process changed") }
        }, bounds: {
            valid = false
            return target
        })) {
            guard case .windowNotFound = $0 as? SpaceOError else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(provider.calls, ["id", "bounds"])
        XCTAssertTrue(provider.sleeps.isEmpty)
    }

    func testPositionAloneDoesNotFinishButGridSnappedContainedSizeDoes() throws {
        let provider = Provider()
        var probes = 0
        let snapped = CGRect(x: target.minX, y: target.minY, width: 590, height: 390)
        let observed = try move(provider) {
            probes += 1
            return probes <= 2 ? CGRect(origin: target.origin, size: before.size) : snapped
        }
        XCTAssertEqual(observed, snapped)
        XCTAssertEqual(provider.sleeps, [20_000_000])
        XCTAssertFalse(provider.calls.contains("point"))
    }

    func testRefusalReturnsOnlyObservedGeometryAndCapsFinalSleep() throws {
        let provider = Provider()
        var limits = WindowMovement.limits
        limits.timeout = 0.055
        limits.maxCallDuration = 0.01
        XCTAssertEqual(try move(provider, limits: limits, bounds: { before }), before)
        XCTAssertEqual(provider.sleeps, [20_000_000, 20_000_000, 15_000_000])
        XCTAssertEqual(provider.calls.filter { $0 == "bounds" }.count, 4)
        XCTAssertEqual(provider.time, 55_000_000)
    }

    func testUnavailableGeometryNeverEchoesRequestedFrameOrMakesAFinalUnbudgetedRead() {
        let provider = Provider()
        assertStopped(.deadline) { _ = try move(provider, bounds: { nil }) }
        XCTAssertEqual(provider.time, 1_000_000_000)
        XCTAssertEqual(provider.calls.filter { $0 == "bounds" }.count, 51)
        XCTAssertEqual(provider.calls.filter { $0 == "point" }.count, 50)
        XCTAssertEqual(provider.calls.filter { $0 == "size" }.count, 0,
                       "an unavailable position cannot be repaired by another size query")
        XCTAssertEqual(provider.sleeps.count, 50)
    }

    func testFallbackReadsShareRemainingTimeAndDiscardALateFrame() throws {
        let provider = Provider()
        provider.axPoint = target.origin
        provider.axSize = target.size
        XCTAssertEqual(try move(provider, bounds: { nil }), target)
        XCTAssertEqual(provider.calls.suffix(3), ["bounds", "point", "size"])

        let late = Provider()
        late.axPoint = target.origin
        late.axSize = target.size
        late.costs = ["point": 150_000_000, "size": 60_000_000]
        var probes = 0
        assertStopped(.deadline) {
            _ = try move(late, bounds: {
                probes += 1
                if probes > 1 { late.time += 800_000_000 }
                return nil
            })
        }
        XCTAssertEqual(late.timeouts.suffix(2).first!, 0.2, accuracy: 0.00001)
        XCTAssertEqual(late.timeouts.last!, 0.05, accuracy: 0.00001)
        XCTAssertTrue(late.sleeps.isEmpty)
    }

    func testLateServerResultKeepsPriorObservationRatherThanClaimingArrival() throws {
        let provider = Provider()
        var probes = 0
        XCTAssertEqual(try move(provider) {
            probes += 1
            if probes <= 2 { return before }
            provider.time += 1_000_000_000
            return target
        }, before)
        XCTAssertEqual(probes, 3)
        XCTAssertEqual(provider.sleeps, [20_000_000])
        XCTAssertFalse(provider.calls.contains("point"))
    }

    func testMutationTimeConsumesTheSameBudgetAndStopsRemainingWork() {
        let provider = Provider()
        provider.costs = ["position": 400_000_000, "dimensions": 400_000_000]
        assertStopped(.deadline) { _ = try move(provider, bounds: { before }) }
        XCTAssertEqual(provider.calls, ["id", "bounds", "position", "dimensions", "position"])
        XCTAssertEqual(provider.timeouts.last!, 0.2, accuracy: 0.00001)
        XCTAssertTrue(provider.sleeps.isEmpty)
    }

    func testFailedSettersDoNotPreventObservingAnAlreadySatisfiedTarget() throws {
        let provider = Provider()
        provider.setterAccepted = false
        var probes = 0
        XCTAssertEqual(try move(provider) {
            probes += 1
            return probes == 1 ? before : target
        }, target)
        XCTAssertEqual(provider.calls.filter { $0 == "position" }.count, 2)
        XCTAssertEqual(provider.calls.filter { $0 == "dimensions" }.count, 1)
        XCTAssertTrue(provider.sleeps.isEmpty)
        let unknown = Provider()
        unknown.setterAccepted = false
        assertStopped(.deadline) { _ = try move(unknown, bounds: { nil }) }
    }

    func testInvalidGeometryCannotCountAsLanded() {
        for invalid in [CGRect.zero, CGRect(x: 1_000, y: 100, width: -1, height: 100),
                        CGRect(x: CGFloat.nan, y: 100, width: 100, height: 100),
                        CGRect(x: 1_000, y: 100, width: CGFloat.infinity, height: 100),
                        CGRect(x: CGFloat.greatestFiniteMagnitude, y: 0,
                               width: CGFloat.greatestFiniteMagnitude, height: 100)] {
            let provider = Provider()
            provider.axPoint = invalid.origin
            provider.axSize = invalid.size
            assertStopped(.deadline) { _ = try move(provider, bounds: { invalid }) }
        }
    }

    func testWindowOrProcessIdentityFailureStopsWithoutInventingGeometry() {
        let provider = Provider()
        provider.id = 99
        XCTAssertThrowsError(try move(provider, bounds: { target }))
        XCTAssertEqual(provider.calls, ["id"])
        for failureAt in [1, 2, 3] {
            let changed = Provider()
            var validations = 0
            XCTAssertThrowsError(try move(changed, validate: {
                validations += 1
                if validations == failureAt { throw SpaceOError.windowNotFound("process changed") }
            }, bounds: { target })) {
                guard case .windowNotFound = $0 as? SpaceOError else { return XCTFail("\($0)") }
            }
            XCTAssertTrue(changed.sleeps.isEmpty)
        }
    }

    func testCallBudgetAndRejectedTimeoutPreventFurtherProviderWork() {
        let provider = Provider()
        var limits = WindowMovement.limits
        limits.maxAXCalls = 4
        assertStopped(.axCalls) { _ = try move(provider, limits: limits, bounds: { nil }) }
        XCTAssertFalse(provider.calls.contains("point"))
        let rejected = Provider()
        rejected.timeoutAccepted = false
        assertStopped(.provider) { _ = try move(rejected, bounds: { target }) }
        XCTAssertTrue(rejected.calls.isEmpty)
    }

    func testExpiredValidationOrTimeoutSetupDoesNotStartNativeOperation() {
        let provider = Provider()
        assertStopped(.deadline) {
            _ = try move(provider, validate: { provider.time += 1_000_000_000 }, bounds: { target })
        }
        XCTAssertTrue(provider.calls.isEmpty)
        let setup = Provider()
        setup.costs["timeout"] = 1_000_000_000
        assertStopped(.deadline) { _ = try move(setup, bounds: { target }) }
        XCTAssertTrue(setup.calls.isEmpty)
    }

    func testRollbackCanObserveCompletionEvenWhenAdmittingTaskWasCancelled() async throws {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            let provider = Provider()
            return try move(provider, bounds: { target })
        }
        let observed = try await task.value
        XCTAssertEqual(observed, target)
    }

    func testDeadlineRemainderUsesOneClockReadAcrossTheExpiryBoundary() throws {
        var reads = 0
        let budget = try AXTraversalBudget(limits: WindowMovement.limits, now: {
            reads += 1
            switch reads {
            case 1, 2: return 0
            case 3: return 999_999_999
            default: return 1_000_000_001
            }
        }, isCancelled: { false })
        XCTAssertEqual(try budget.beginAXCall(), 0.001, accuracy: 0.000001)
        XCTAssertEqual(reads, 3, "two remainder reads could underflow UInt64 when the deadline passes")
        assertStopped(.deadline) { try budget.check() }
        XCTAssertEqual(budget.remainingNanoseconds, 0)
    }

    private func watcher(_ provider: Provider, discoveryCost: UInt64 = 0,
                         discoveryCalls: Int = 0) -> WindowWatcher {
        let window = WindowRef(windowID: 42, pid: 42, title: "Fixture", frame: before)
        let driver = WindowWatcherDriver(pid: 42, validate: {}, discover: { budget in
            provider.time += discoveryCost
            for _ in 0..<discoveryCalls { _ = try budget.beginAXCall() }
            return AXWindowDiscovery.Result(windows: [window], elements: [42: 1])
        }, isContained: { _, _ in false }, moveWithBudget: { window, element, frame, parent in
            try WindowMovement.perform(windowID: window.windowID, target: frame, element: element,
                provider: provider, budget: WindowMovement.budget(parent: parent), validate: {},
                liveBounds: { provider.record("bounds"); return self.before },
                sleep: { provider.sleeps.append($0); provider.time += $0 })
        })
        return WindowWatcher(testingPID: 42, region: { self.target }, driver: driver,
                             now: { provider.time })
    }

    func testWatcherMovementUsesOnlyTheRemainingSweepTime() {
        let provider = Provider()
        let watcher = watcher(provider, discoveryCost: 1_950_000_000)
        watcher.sweep()
        XCTAssertEqual(provider.time, 2_000_000_000)
        XCTAssertEqual(provider.sleeps, [20_000_000, 20_000_000, 10_000_000])
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 <= 0.050001 })
        XCTAssertEqual(watcher.placedCount, 0)
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertTrue(watcher.sweepFailure?.contains("deadline") == true)
    }

    func testWatcherStopDuringNativeMutationPreventsRemainingWritesAndKeepsQuiescenceHonest() {
        let provider = Provider()
        let watcher = watcher(provider)
        provider.onCall = { [weak watcher] call in
            guard call == "position", let watcher else { return }
            watcher.stop()
            XCTAssertFalse(watcher.isQuiescent, "an entered native mutation has not returned yet")
            watcher.sweep()
        }
        watcher.sweep()
        XCTAssertEqual(provider.calls, ["id", "bounds", "position"])
        XCTAssertTrue(provider.sleeps.isEmpty)
        XCTAssertTrue(watcher.isQuiescent)
        XCTAssertEqual(watcher.placedCount, 0)
        XCTAssertEqual(watcher.refusedCount, 0)
    }

    func testWatcherDiscoveryAndMovementShareTheAXCallLimit() {
        let provider = Provider()
        let watcher = watcher(provider, discoveryCalls: 2_047)
        watcher.sweep()
        XCTAssertEqual(provider.calls, ["id", "bounds"], "discovery left no AX call budget for a mutation")
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertTrue(watcher.sweepFailure?.contains("axCalls") == true)
    }
}
