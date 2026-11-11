import XCTest
import CoreGraphics
@testable import SpaceOKit

final class WindowWatcherTests: XCTestCase {
    private final class Fixture {
        var windows = [WindowRef(windowID: 1, pid: 42, title: "Fixture",
            frame: CGRect(x: 1000, y: 1000, width: 200, height: 100))]
        var discoveryError: Error?
        var movementError: Error?
        var valid = true
        var moves: [CGWindowID] = []
        var discoveries = 0
        var containmentReads = 0
        var lands = false
        var contained = false
        var containmentAvailable = true
        var onContainment: (() -> Void)?
        var onDiscover: (() -> Void)?
        var onMove: (() -> Void)?
        var driver: WindowWatcherDriver {
            WindowWatcherDriver(pid: 42, validate: {
                if !self.valid { throw SpaceOError.applicationExited("fixture identity changed") }
            }, discover: { budget in
                self.discoveries += 1
                if let error = self.discoveryError { throw error }
                for _ in self.windows { try budget.consumeNode() }
                self.onDiscover?()
                return AXWindowDiscovery.Result(windows: self.windows,
                    elements: Dictionary(uniqueKeysWithValues: self.windows.map { ($0.windowID, Int($0.windowID)) }))
            }, isContained: { _, _ in
                self.containmentReads += 1
                self.onContainment?()
                return self.containmentAvailable ? self.contained : nil
            }, move: { window, _, target in
                self.moves.append(window.windowID)
                if let error = self.movementError { throw error }
                self.contained = self.lands
                self.onMove?()
                return target
            })
        }
    }

    private func watcher(_ fixture: Fixture) -> WindowWatcher {
        WindowWatcher(testingPID: 42, region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
                      driver: fixture.driver)
    }

    func testIncompleteDiscoveryPreservesRefusalsUntilACompleteSweep() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        fixture.discoveryError = AXWindowDiscovery.incomplete("fixture missing page")
        fixture.windows = []
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        XCTAssertTrue(watcher.sweepFailure?.contains("missing page") == true)
        XCTAssertEqual(fixture.moves, [1])
        fixture.discoveryError = nil
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertNil(watcher.sweepFailure)
    }

    func testUnchangedRefusalAvoidsRepeatedMovesAndChangedGeometryRetries() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        watcher.sweep()
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1])
        fixture.windows[0] = WindowRef(windowID: 1, pid: 42, title: "Fixture",
            frame: CGRect(x: 1200, y: 1000, width: 200, height: 100))
        fixture.lands = true
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1])
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertEqual(watcher.placedCount, 1)
    }

    func testStoppedWatcherCannotRestartFromALateSweepRequest() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        watcher.stop()
        for _ in 0..<20 { watcher.sweep() }
        watcher.stop()
        XCTAssertEqual(fixture.discoveries, 0)
        XCTAssertEqual(fixture.moves, [])
        XCTAssertEqual(watcher.sweepCount, 0)
    }

    func testStopDuringDiscoveryPreventsContainmentReadsAndMoves() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        fixture.onDiscover = { [weak watcher] in watcher?.sweep(); watcher?.stop() }
        watcher.sweep()
        watcher.sweep()
        XCTAssertEqual(fixture.discoveries, 1)
        XCTAssertEqual(fixture.containmentReads, 0)
        XCTAssertTrue(fixture.moves.isEmpty)
    }

    func testStopDuringMovePreventsFurtherNativeReadsAndMoves() {
        let fixture = Fixture()
        fixture.windows.append(WindowRef(windowID: 2, pid: 42, title: "Second",
            frame: CGRect(x: 1200, y: 1000, width: 200, height: 100)))
        let watcher = watcher(fixture)
        fixture.onMove = { [weak watcher] in watcher?.stop() }
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1])
        XCTAssertEqual(fixture.containmentReads, 1, "stop must prevent even the post-move bounds query")
        XCTAssertEqual(watcher.placedCount, 0)
    }

    func testChangedProcessAfterDiscoveryPreventsMovementAndReportsFailure() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        fixture.onDiscover = { [weak fixture] in fixture?.valid = false }
        watcher.sweep()
        XCTAssertTrue(fixture.moves.isEmpty)
        XCTAssertEqual(fixture.containmentReads, 0)
        XCTAssertTrue(watcher.sweepFailure?.contains("identity changed") == true)
        fixture.onDiscover = nil
        fixture.valid = true
        fixture.contained = true
        watcher.sweep()
        XCTAssertNil(watcher.sweepFailure)
    }

    func testSweepFailureDiagnosticsAreBounded() {
        let fixture = Fixture()
        fixture.discoveryError = SpaceOError.badRequest(String(repeating: "x", count: 10_000))
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertLessThanOrEqual(watcher.sweepFailure?.utf8.count ?? .max, 512)
        XCTAssertTrue(fixture.moves.isEmpty)
    }

    func testUnconfirmedMovementRetriesWithoutChangingItsGeometry() {
        let fixture = Fixture()
        fixture.movementError = AXTraversalStopped(reason: .deadline, detail: "unconfirmed movement")
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1])
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertNotNil(watcher.sweepFailure)
        fixture.movementError = nil
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1], "failed observation must not suppress a retry")
        XCTAssertNil(watcher.sweepFailure)
        XCTAssertEqual(watcher.refusedCount, 1, "a completed move with observed overflow is a refusal")
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1], "a confirmed unchanged refusal still avoids wasted moves")
    }

    func testUnavailablePostMoveGeometryDoesNotSuppressTheNextSweep() {
        let fixture = Fixture()
        fixture.onMove = { fixture.containmentAvailable = false }
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertTrue(watcher.sweepFailure?.contains("containment is unavailable") == true)
        fixture.onMove = nil
        fixture.containmentAvailable = true
        fixture.lands = true
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1])
        XCTAssertEqual(watcher.placedCount, 1)
        XCTAssertNil(watcher.sweepFailure)
    }

    func testLateContainmentCannotEraseKnownRefusalHistory() {
        let fixture = Fixture()
        var time: UInt64 = 0
        let watcher = WindowWatcher(testingPID: 42, region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
                                    driver: fixture.driver, now: { time })
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        fixture.contained = true
        fixture.onContainment = { time += 2_000_000_000 }
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        XCTAssertTrue(watcher.sweepFailure?.contains("deadline") == true)
        fixture.onContainment = nil
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 0)
        XCTAssertNil(watcher.sweepFailure)
    }

    func testQuiescenceRequiresStopAndTheAdmittedSweepToReturn() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        XCTAssertFalse(watcher.isQuiescent, "an idle watcher still admits work")
        fixture.onMove = { [weak watcher] in
            guard let watcher else { return XCTFail("watcher disappeared") }
            watcher.sweep() // Queue a repeat; stop must discard it without claiming completion.
            watcher.stop()
            XCTAssertFalse(watcher.isQuiescent, "the current native move has not returned")
            watcher.stop()
            XCTAssertFalse(watcher.isQuiescent, "idempotent stop must retain in-flight accounting")
        }
        watcher.sweep()
        XCTAssertTrue(watcher.isQuiescent)
        watcher.sweep()
        XCTAssertTrue(watcher.isQuiescent)
        XCTAssertEqual(fixture.discoveries, 1)
        XCTAssertEqual(fixture.moves, [1])
    }

    func testIncompleteOrWrongProcessHandlesPreventAllContainmentWork() {
        for wrongPID in [false, true] {
            var reads = 0
            var moves = 0
            let window = WindowRef(windowID: 1, pid: wrongPID ? 43 : 42,
                title: "Fixture", frame: CGRect(x: 1000, y: 1000, width: 200, height: 100))
            let driver = WindowWatcherDriver(pid: 42, validate: {}, discover: { _ in
                AXWindowDiscovery.Result(windows: [window], elements: wrongPID ? [1: 101] : [:])
            }, isContained: { _, _ in reads += 1; return false }, move: { _, _, target in
                moves += 1
                return target
            })
            let watcher = WindowWatcher(testingPID: 42,
                region: { CGRect(x: 0, y: 0, width: 800, height: 600) }, driver: driver)
            watcher.sweep()
            XCTAssertTrue(watcher.sweepFailure?.contains("handles do not cover") == true)
            XCTAssertEqual(reads, 0)
            XCTAssertEqual(moves, 0)
        }
    }

    func testDiscoveryHandlesAreReleasedAfterSuccessFailureAndStop() {
        final class Handle {}
        for outcome in ["success", "failure", "stop"] {
            weak var retainedHandle: Handle?
            weak var stopTarget: WindowWatcher?
            var moves = 0
            let window = WindowRef(windowID: 1, pid: 42, title: "Fixture",
                frame: CGRect(x: 1000, y: 1000, width: 200, height: 100))
            let driver = WindowWatcherDriver(pid: 42, validate: {}, discover: { _ in
                let handle = Handle()
                retainedHandle = handle
                return AXWindowDiscovery.Result(windows: [window], elements: [1: handle])
            }, isContained: { _, _ in moves > 0 }, move: { _, handle, target in
                moves += 1
                XCTAssertTrue(handle === retainedHandle, outcome)
                if outcome == "failure" { throw SpaceOError.windowNotFound("fixture closed") }
                if outcome == "stop" { stopTarget?.stop() }
                return target
            })
            let watcher = WindowWatcher(testingPID: 42,
                region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
                onPlaced: { _ in XCTAssertNotNil(retainedHandle, "handle lives through the callback") },
                driver: driver)
            stopTarget = watcher
            watcher.sweep()
            XCTAssertEqual(moves, 1, outcome)
            XCTAssertEqual(watcher.placedCount, outcome == "success" ? 1 : 0, outcome)
            XCTAssertEqual(watcher.refusedCount, 0, "an unconfirmed move is retryable, not a cached refusal")
            if outcome == "failure" { XCTAssertNotNil(watcher.sweepFailure) }
            XCTAssertNil(retainedHandle, "\(outcome) must not retain handles between sweeps")
        }
    }

    func testReleaseAllowsAnUnchangedRefusalToRetry() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        watcher.release(1)
        XCTAssertEqual(watcher.refusedCount, 0)
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1])
        XCTAssertEqual(watcher.refusedCount, 1)
    }

    func testPreviouslyPlacedWindowIsMovedAgainIfItEscapes() {
        let fixture = Fixture()
        fixture.lands = true
        let watcher = watcher(fixture)
        watcher.sweep()
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1], "a contained window needs no new move")
        fixture.contained = false
        watcher.sweep()
        XCTAssertEqual(fixture.moves, [1, 1])
        XCTAssertEqual(watcher.placedCount, 2)
        XCTAssertEqual(watcher.refusedCount, 0)
    }

    func testClosingOneRefusedWindowPreservesTheOtherRefusalAndItsRetryGuard() {
        let fixture = Fixture()
        fixture.windows.append(WindowRef(windowID: 2, pid: 42, title: "Second",
            frame: CGRect(x: 1200, y: 1000, width: 200, height: 100)))
        let watcher = watcher(fixture)
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 2)
        fixture.windows.removeFirst()
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 1)
        XCTAssertEqual(fixture.moves, [1, 2], "pruning a closed window must not retry an unchanged refusal")
        fixture.contained = true
        watcher.sweep()
        XCTAssertEqual(watcher.refusedCount, 0, "external containment clears the remaining refusal")
    }

    func testTemporarySuspensionBlocksSweepsAndResumesAfterFailure() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        XCTAssertFalse(watcher.withQuiescentSuspension {
            for _ in 0..<3 { watcher.sweep() }
            XCTAssertEqual(fixture.discoveries, 0)
            XCTAssertFalse(watcher.withQuiescentSuspension {
                XCTFail("a nested suspension must not start another rollback")
                return true
            })
            return false
        })
        XCTAssertEqual(fixture.discoveries, 1, "coalesce and replay requests received during suspension")
        watcher.sweep()
        XCTAssertEqual(fixture.discoveries, 2, "failed rollback must not permanently stop containment")
        XCTAssertEqual(fixture.moves, [1])
    }

    func testSuspensionDoesNotRunRollbackInsideAnActiveMove() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        fixture.onMove = { [weak watcher] in
            XCTAssertFalse(watcher?.withQuiescentSuspension {
                XCTFail("active native work must finish before rollback starts")
                return true
            } ?? true)
        }
        watcher.sweep()
        XCTAssertTrue(watcher.withQuiescentSuspension { true })
        XCTAssertEqual(fixture.moves, [1])
    }

    func testTemporarySuspensionCannotUndoPermanentStop() {
        let fixture = Fixture()
        let watcher = watcher(fixture)
        XCTAssertTrue(watcher.withQuiescentSuspension { watcher.sweep(); watcher.stop(); return true })
        watcher.sweep()
        XCTAssertTrue(watcher.isQuiescent)
        XCTAssertEqual(fixture.discoveries, 0)
    }
}
