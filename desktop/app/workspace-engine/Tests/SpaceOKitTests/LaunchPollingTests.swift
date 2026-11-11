import Darwin
import Foundation
import XCTest
@testable import SpaceOKit

final class LaunchPollingTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = Date(timeIntervalSinceReferenceDate: 0)
        private var intervals: [TimeInterval] = []
        var sleeps: [TimeInterval] { lock.withLock { intervals } }
        func now() -> Date { lock.withLock { time } }
        func advance(_ duration: TimeInterval) { lock.withLock { time += duration } }
        func sleep(_ duration: TimeInterval) {
            lock.withLock { intervals.append(duration); time += duration }
        }
        var runtime: WaitRuntime { .init(now: { self.now() }, sleep: { self.sleep($0) }) }
    }

    private func profile() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("spaceo-marker-test-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }

    func testRevealedWindowCanBecomeReadableAfterTwoSeconds() async throws {
        let clock = Clock()
        let start = clock.now()
        let found: Bool? = try await AppLauncher.waitForRevealedWindow(timeout: 10) { budget in
            try await WindowReadiness.wait(timeout: budget, pollNanoseconds: 500_000_000,
                                           runtime: clock.runtime) { _ in
                clock.now().timeIntervalSince(start) >= 3 ? true : nil
            }
        }
        XCTAssertEqual(found, true)
        XCTAssertGreaterThanOrEqual(clock.now().timeIntervalSince(start), 3)
    }

    func testLaunchAXFailureNamesPhaseWithoutChangingStopReason() throws {
        for phase in AppLauncher.LaunchPhase.allCases {
            for reason: AXTraversalStopReason in [.provider, .deadline, .cancelled] {
                let original = AXTraversalStopped(reason: reason, detail: "window count unavailable")
                let error = AppLauncher.launchFailure(original, application: "not included", phase: phase)
                let stopped = try XCTUnwrap(error as? AXTraversalStopped)
                XCTAssertEqual(stopped.reason, reason)
                XCTAssertEqual(stopped.detail, "launch \(phase.rawValue): window count unavailable")
                XCTAssertFalse(stopped.detail.contains("not included"))
            }
        }
    }

    func testChromiumStartupDeadlineHasActionableLaunchError() {
        let error = AppLauncher.launchFailure(DevToolsDeadline.Exceeded(), application: "Test Browser")
        guard case let SpaceOError.launchFailed(message) = error else {
            return XCTFail("startup deadline must map to launch_failed, got \(error)")
        }
        XCTAssertTrue(message.contains("Test Browser"))
        XCTAssertTrue(message.contains("DevTools"))
    }

    func testStartupContainmentCoversReadinessAndStopsOnSuccessFailureAndCancellation() async throws {
        for outcome in 0..<3 {
            var active = false
            var stops = 0
            do {
                let value = try await AppLauncher.withStartupContainment(install: {
                    active = true
                    return { active = false; stops += 1 }
                }, operation: {
                    XCTAssertTrue(active, "containment must precede endpoint discovery")
                    await Task.yield()
                    XCTAssertTrue(active, "containment must cover readiness waits")
                    if outcome == 1 { throw SpaceOError.launchFailed("fixture") }
                    if outcome == 2 { throw CancellationError() }
                    return 43123
                })
                XCTAssertEqual(outcome, 0)
                XCTAssertEqual(value, 43123)
            } catch {
                XCTAssertNotEqual(outcome, 0)
                if outcome == 2 { XCTAssertTrue(error is CancellationError) }
            }
            XCTAssertFalse(active)
            XCTAssertEqual(stops, 1)
        }
    }

    func testStartupContainmentFailurePreventsBrowserReadinessWork() async {
        do {
            try await AppLauncher.withStartupContainment(install: {
                throw SpaceOError.launchFailed("watcher unavailable")
            }, operation: { XCTFail("discovery must not run without containment") })
            XCTFail("installation failure must propagate")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("watcher unavailable"))
        }
    }

    func testStartupErrorMappingPreservesCancellationAndProcessExit() {
        XCTAssertTrue(AppLauncher.launchFailure(CancellationError(), application: "Test") is CancellationError)
        let error = AppLauncher.launchFailure(
            SpaceOError.applicationExited("browser exited during startup"), application: "Test")
        guard case let SpaceOError.applicationExited(message) = error else {
            return XCTFail("process exit must retain its public error, got \(error)")
        }
        XCTAssertEqual(message, "browser exited during startup")
    }

    func testMarkerAcceptsCompletePortLinesWithinBoundAndRejectsPartialOrMalformedPorts() throws {
        let profile = try profile()
        let marker = profile.appendingPathComponent("DevToolsActivePort")
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
        for (line, port) in [("1\n", 1), ("65535\n/devtools/browser/test\n", 65535), ("43123\r\n", 43123)] {
            try Data(line.utf8).write(to: marker)
            XCTAssertEqual(AppLauncher.devToolsPort(in: profile), port)
        }
        for line in ["", "43123", "\n43123\n", "0\n", "65536\n", "123456\n",
                     "-1\n", "+1\n", " 1\n", "1 \n", "1\r", "１\n", "4\u{0}3\n"] {
            try Data(line.utf8).write(to: marker)
            XCTAssertNil(AppLauncher.devToolsPort(in: profile), "must reject \(line.debugDescription)")
        }
        try (Data("43123\n".utf8) + Data(repeating: 120, count: 4090)).write(to: marker)
        XCTAssertEqual(AppLauncher.devToolsPort(in: profile), 43123)
        try (Data("43123\n".utf8) + Data(repeating: 120, count: 4091)).write(to: marker)
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
    }

    func testMarkerRejectsLargeSparseFilesSymlinksDirectoriesAndPipes() throws {
        let profile = try profile()
        let marker = profile.appendingPathComponent("DevToolsActivePort")
        try Data("43123\n".utf8).write(to: marker)
        let handle = try FileHandle(forWritingTo: marker)
        try handle.truncate(atOffset: 64 * 1024 * 1024)
        try handle.close()
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
        try FileManager.default.removeItem(at: marker)
        let target = profile.appendingPathComponent("target")
        try Data("43123\n".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: marker, withDestinationURL: target)
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
        try FileManager.default.removeItem(at: marker)
        try FileManager.default.createDirectory(at: marker, withIntermediateDirectories: false)
        XCTAssertNil(AppLauncher.devToolsPort(in: profile))
        try FileManager.default.removeItem(at: marker)
        XCTAssertEqual(mkfifo(marker.path, 0o600), 0)
        XCTAssertNil(AppLauncher.devToolsPort(in: profile), "a FIFO with no writer must never block discovery")
    }

    func testMarkerPollingUsesRemainderAndAcceptsACompletedMarkerOnNextProbe() async throws {
        let profile = try profile()
        let clock = Clock()
        let absent = try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 0.25,
                                                              runtime: clock.runtime)
        XCTAssertNil(absent)
        XCTAssertEqual(clock.sleeps.count, 3)
        XCTAssertEqual(clock.sleeps.last!, 0.05, accuracy: 0.000001)
        let marker = profile.appendingPathComponent("DevToolsActivePort")
        try Data("43".utf8).write(to: marker)
        let next = Clock()
        let runtime = WaitRuntime(now: { next.now() }, sleep: {
            next.sleep($0)
            try Data("43123\n/devtools/browser/test\n".utf8).write(to: marker)
        })
        let ready = try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 1, runtime: runtime)
        XCTAssertEqual(ready, 43123)
        XCTAssertEqual(next.sleeps, [0.1])
    }

    func testMarkerPollingRejectsLateResultAndStopsOnIdentityFailure() async throws {
        let profile = try profile()
        try Data("43123\n".utf8).write(to: profile.appendingPathComponent("DevToolsActivePort"))
        let clock = Clock()
        let late = try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 0.1,
            runtime: clock.runtime, validate: { clock.advance(0.1) })
        XCTAssertNil(late)
        XCTAssertTrue(clock.sleeps.isEmpty)
        do {
            _ = try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 1,
                runtime: clock.runtime, validate: { throw SpaceOError.applicationExited("test") })
            XCTFail("identity failure must propagate")
        } catch is SpaceOError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancelledMarkerSleepDoesNotProbeAgain() async throws {
        let profile = try profile()
        let clock = Clock()
        var validations = 0
        do {
            _ = try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 1,
                runtime: .init(now: { clock.now() }, sleep: { _ in throw CancellationError() }),
                validate: { validations += 1 })
            XCTFail("cancelled sleep must propagate")
        } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(validations, 2, "only the first probe's identity checks should run")
    }

    func testRevealStopsImmediatelyWhenVisibleAndPollsHiddenStateWithinDeadline() async throws {
        let clock = Clock()
        var attempts = 0
        try await AppLauncher.reveal(name: "Test", runtime: clock.runtime, validate: {},
            isHidden: { _ in false }, unhide: { XCTFail("already visible") })
        XCTAssertTrue(clock.sleeps.isEmpty)
        try await AppLauncher.reveal(name: "Test", runtime: clock.runtime, validate: {},
            isHidden: { _ in attempts < 2 }, unhide: { attempts += 1 })
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(clock.sleeps, [0.025])
        let refusing = Clock()
        do {
            try await AppLauncher.reveal(name: "Test", runtime: refusing.runtime, validate: {},
                isHidden: { _ in true }, unhide: {})
            XCTFail("a permanently hidden app must fail")
        } catch is SpaceOError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(refusing.sleeps.reduce(0, +), 1, accuracy: 0.000001)
        XCTAssertTrue(refusing.sleeps.allSatisfy { $0 <= 0.025 })
    }

    func testRevealDoesNotAcceptUnknownVisibilityOrFailedReads() async throws {
        for fails in [false, true] {
            let clock = Clock()
            var probes = 0
            do {
                try await AppLauncher.reveal(name: "Test", runtime: clock.runtime, validate: {},
                    isHidden: { remaining in
                        probes += 1
                        XCTAssertGreaterThanOrEqual(remaining, 0.01)
                        XCTAssertLessThanOrEqual(remaining, 1)
                        if fails { throw SpaceOError.accessibilityDenied }
                        return nil
                    }, unhide: { XCTFail("unknown state does not authorize another reveal attempt") })
                XCTFail("unknown visibility must not become success")
            } catch is SpaceOError {} catch { XCTFail("unexpected error: \(error)") }
            XCTAssertGreaterThan(probes, 1)
            XCTAssertEqual(clock.sleeps.reduce(0, +), 1, accuracy: 0.000001)
        }
    }

    func testRevealChargesObservationTimeAndRejectsLateResults() async throws {
        for hidden in [false, true] {
            let clock = Clock()
            var probes = 0
            do {
                try await AppLauncher.reveal(name: "Test", runtime: clock.runtime, validate: {},
                    isHidden: { remaining in
                        probes += 1
                        XCTAssertEqual(remaining, 1)
                        clock.advance(1.1)
                        return hidden
                    }, unhide: { XCTFail("late state must not trigger unhide") })
                XCTFail("late visibility must not succeed")
            } catch is SpaceOError {} catch { XCTFail("unexpected error: \(error)") }
            XCTAssertEqual(probes, 1)
            XCTAssertTrue(clock.sleeps.isEmpty)
        }
    }

    func testRevealDoesNotUnhideAfterCancellationOrIdentityFailure() async throws {
        let clock = Clock()
        var attempts = 0
        do {
            try await AppLauncher.reveal(name: "Test",
                runtime: .init(now: { clock.now() }, sleep: { _ in throw CancellationError() }),
                validate: {}, isHidden: { _ in true }, unhide: { attempts += 1 })
            XCTFail("cancelled sleep must stop reveal")
        } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(attempts, 1)
        do {
            try await AppLauncher.reveal(name: "Test", runtime: clock.runtime,
                validate: { throw SpaceOError.applicationExited("test") },
                isHidden: { _ in true }, unhide: { attempts += 1 })
            XCTFail("identity failure must stop reveal")
        } catch is SpaceOError {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(attempts, 1)
    }

    func testAlreadyCancelledLaunchPollingDoesNoProviderWork() async throws {
        let profile = try profile()
        let markerTask = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await AppLauncher.waitForDevToolsPort(in: profile, timeout: 1,
                validate: { XCTFail("cancelled marker wait must not validate or read") })
        }
        do { _ = try await markerTask.value; XCTFail("cancellation must propagate") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        let revealTask = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await AppLauncher.reveal(name: "Test", validate: { XCTFail("cancelled validation") },
                isHidden: { _ in XCTFail("cancelled state read"); return true },
                unhide: { XCTFail("cancelled reveal") })
        }
        do { try await revealTask.value; XCTFail("cancellation must propagate") }
        catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
    }
}
