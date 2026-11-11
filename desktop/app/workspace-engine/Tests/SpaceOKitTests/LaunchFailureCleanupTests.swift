import Foundation
import XCTest
@testable import SpaceOKit

final class LaunchFailureCleanupTests: XCTestCase {
    private final class World: @unchecked Sendable {
        enum Outcome { case refuse, graceful, forced, replacedDuringWait, impreciseDuringWait }
        let identity = ProcessIdentity(pid: 70001, startedAtMicroseconds: 1)
        private let lock = NSLock()
        private var current: ProcessIdentity?
        private var time = Date(timeIntervalSinceReferenceDate: 0)
        private var intervals: [TimeInterval] = []
        private var signals: [Bool] = []
        private var cleanups = 0
        private var cancelledCallbacks = 0
        private let outcome: Outcome

        init(_ outcome: Outcome, precise: Bool = true, exited: Bool = false) {
            self.outcome = outcome
            current = exited ? nil : ProcessIdentity(pid: 70001, startedAtMicroseconds: precise ? 1 : 0)
        }
        var quits: [Bool] { lock.withLock { signals } }
        var sleeps: [TimeInterval] { lock.withLock { intervals } }
        var cleanupCount: Int { lock.withLock { cleanups } }
        var cancelledCount: Int { lock.withLock { cancelledCallbacks } }
        var runtime: WaitRuntime {
            .init(now: { self.lock.withLock { self.time } }, sleep: { duration in
                try Task.checkCancellation()
                self.lock.withLock {
                    self.intervals.append(duration)
                    self.time += duration
                    if self.outcome == .replacedDuringWait {
                        self.current = ProcessIdentity(pid: self.identity.pid, startedAtMicroseconds: 2)
                    } else if self.outcome == .impreciseDuringWait {
                        self.current = ProcessIdentity(pid: self.identity.pid, startedAtMicroseconds: 0)
                    }
                }
            })
        }
        var driver: LaunchFailureCleanup.Driver {
            .init(currentIdentity: { _ in self.lock.withLock { self.current } }, quit: { _, force in
                self.lock.withLock {
                    self.signals.append(force)
                    if Task.isCancelled { self.cancelledCallbacks += 1 }
                    if self.outcome == .graceful || (force && self.outcome == .forced) { self.current = nil }
                }
            }, cleanupResources: { _ in
                self.lock.withLock {
                    self.cleanups += 1
                    if Task.isCancelled { self.cancelledCallbacks += 1 }
                }
            })
        }
        func app(startedByUs: Bool = true) -> LaunchedApp {
            LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: nil,
                        name: "Test", url: URL(fileURLWithPath: "/Applications/Test.app"),
                        startedByUs: startedByUs, devToolsPort: nil, temporaryProfile: nil)
        }
    }

    func testGracefulExitCleansOnceWithoutForceOrSleep() async {
        let world = World(.graceful)
        await LaunchFailureCleanup.run(world.app(), driver: world.driver, runtime: world.runtime)
        XCTAssertEqual(world.quits, [false])
        XCTAssertTrue(world.sleeps.isEmpty)
        XCTAssertEqual(world.cleanupCount, 1)
    }

    func testForceEscalationWaitsForGracefulBudgetAndStopsOnConfirmedExit() async {
        let world = World(.forced)
        await LaunchFailureCleanup.run(world.app(), driver: world.driver, runtime: world.runtime)
        XCTAssertEqual(world.quits, [false, true])
        XCTAssertEqual(world.sleeps.reduce(0, +), 2, accuracy: 0.000001)
        XCTAssertEqual(world.cleanupCount, 1)
    }

    func testCancelledParentStillAwaitsBoundedCleanupAndPreservesItsOriginalError() async {
        let world = World(.refuse)
        let parent = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do { throw CancellationError() }
            catch {
                await LaunchFailureCleanup.run(world.app(), driver: world.driver, runtime: world.runtime)
                XCTAssertEqual(world.cleanupCount, 1, "the parent cannot finish before cleanup responsibility returns")
                throw error
            }
        }
        do { try await parent.value; XCTFail("the original cancellation must propagate") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(world.quits, [false, true])
        XCTAssertEqual(world.sleeps.reduce(0, +), 4, accuracy: 0.000001)
        XCTAssertTrue(world.sleeps.allSatisfy { $0 > 0 && $0 <= 0.1 })
        XCTAssertEqual(world.cancelledCount, 0)
    }

    func testPIDReplacementEndsWaitWithoutSignallingReplacement() async {
        let world = World(.replacedDuringWait)
        await LaunchFailureCleanup.run(world.app(), driver: world.driver, runtime: world.runtime)
        XCTAssertEqual(world.quits, [false])
        XCTAssertEqual(world.sleeps, [0.1])
        XCTAssertEqual(world.cleanupCount, 1)
    }

    func testImpreciseIdentityNeverAuthorizesTerminationOrClaimsExit() async {
        for precise in [true, false] {
            let world = World(.impreciseDuringWait, precise: precise)
            await LaunchFailureCleanup.run(world.app(), driver: world.driver, runtime: world.runtime)
            XCTAssertEqual(world.quits, precise ? [false] : [])
            XCTAssertEqual(world.sleeps.reduce(0, +), 4, accuracy: 0.000001)
            XCTAssertEqual(world.cleanupCount, 1, "resource cleanup retains its own live-process guard")
        }
    }

    func testExitedAndAdoptedAppsAreNotTerminated() async {
        let exited = World(.refuse, exited: true)
        await LaunchFailureCleanup.run(exited.app(), driver: exited.driver, runtime: exited.runtime)
        XCTAssertTrue(exited.quits.isEmpty)
        XCTAssertTrue(exited.sleeps.isEmpty)
        XCTAssertEqual(exited.cleanupCount, 1)
        let adopted = World(.refuse)
        await LaunchFailureCleanup.run(adopted.app(startedByUs: false), driver: adopted.driver, runtime: adopted.runtime)
        XCTAssertTrue(adopted.quits.isEmpty)
        XCTAssertTrue(adopted.sleeps.isEmpty)
        XCTAssertEqual(adopted.cleanupCount, 1)
    }
}
