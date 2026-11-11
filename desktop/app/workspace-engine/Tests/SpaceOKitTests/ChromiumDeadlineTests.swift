import XCTest
import Foundation
@testable import SpaceOKit

final class ChromiumDeadlineTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ContinuousClock.now
        private var armed = false
        var now: ContinuousClock.Instant { lock.withLock { value } }
        func advance(_ seconds: Double) { lock.withLock { value = value.advanced(by: .seconds(seconds)) } }
        func arm() { lock.withLock { armed = true } }
        func discovered(_ request: String) {
            guard request.hasPrefix("GET /json/list ") else { return }
            lock.withLock { if armed { value = value.advanced(by: .milliseconds(750)) } }
        }
    }

    private func withBridge(
        clock: Clock,
        executor: @escaping (String, [String: Any]) async throws -> [String: Any],
        body: (ChromiumBridge) async throws -> Void
    ) async throws {
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one")], port: port)
        }, requestObserver: { clock.discovered($0) }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: executor)
        try await bridge.attach(toTargetID: "A")
        do { try await body(bridge) }
        catch { await bridge.detach(); throw error }
        await bridge.detach()
    }

    func testDiscoveryAndEvaluationConsumeOneObservationBudget() async throws {
        let clock = Clock()
        var calls: [String] = []
        try await withBridge(clock: clock, executor: { method, params in
            calls.append(method)
            if method == "Runtime.evaluate" {
                XCTAssertEqual(try XCTUnwrap(params["timeout"] as? Double), 250, accuracy: 0.001)
                clock.advance(0.1)
                return ["result": ["value": "yes", "objectId": "temporary"]]
            }
            XCTAssertEqual(method, "Runtime.releaseObjectGroup")
            return [:]
        }) { bridge in
            let budget = try DevToolsDeadline(timeout: 1, now: { clock.now })
            clock.arm()
            let exists = try await bridge.selectorExists("button", budget: budget)
            XCTAssertTrue(exists)
            XCTAssertEqual(try budget.remaining(), 0.15, accuracy: 0.001)
        }
        XCTAssertEqual(calls, ["Runtime.evaluate", "Runtime.releaseObjectGroup"])
    }

    func testLateEvaluationRetiresTransportWithoutStartingFreshCleanup() async throws {
        let clock = Clock()
        var calls = 0
        try await withBridge(clock: clock, executor: { _, _ in
            calls += 1
            clock.advance(2)
            return ["result": ["value": "yes", "objectId": "temporary"]]
        }) { bridge in
            let budget = try DevToolsDeadline(timeout: 1, now: { clock.now })
            do { _ = try await bridge.selectorExists("button", budget: budget); XCTFail("late observation") }
            catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            let binding = await bridge.boundTargetID
            XCTAssertNil(binding)
        }
        XCTAssertEqual(calls, 1)
    }

    func testCleanupExpiryRemainsATimeoutAndRetiresObjectOwner() async throws {
        let clock = Clock()
        var calls: [String] = []
        try await withBridge(clock: clock, executor: { method, _ in
            calls.append(method)
            if method == "Runtime.evaluate" {
                clock.advance(0.1)
                return ["result": ["value": "yes", "objectId": "temporary"]]
            }
            clock.advance(1)
            return [:]
        }) { bridge in
            let budget = try DevToolsDeadline(timeout: 1, now: { clock.now })
            clock.arm()
            do { _ = try await bridge.selectorExists("button", budget: budget); XCTFail("late cleanup") }
            catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            let binding = await bridge.boundTargetID
            XCTAssertNil(binding)
        }
        XCTAssertEqual(calls, ["Runtime.evaluate", "Runtime.releaseObjectGroup"])
    }

    func testExpiredDiscoveryStartsNoEvaluationAndKeepsHealthyBinding() async throws {
        let clock = Clock()
        var calls = 0
        try await withBridge(clock: clock, executor: { _, _ in calls += 1; return [:] }) { bridge in
            let budget = try DevToolsDeadline(timeout: 0.5, now: { clock.now })
            clock.arm()
            do { _ = try await bridge.selectorExists("button", budget: budget); XCTFail("late discovery") }
            catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            let binding = await bridge.boundTargetID
            XCTAssertEqual(binding, "A")
        }
        XCTAssertEqual(calls, 0)
    }

    func testObservationQueueExpiryRemovesWaiterWithoutSending() async throws {
        let clock = Clock()
        var calls = 0
        try await withBridge(clock: clock, executor: { _, _ in calls += 1; return [:] }) { bridge in
            let gate = await bridge.commandGate
            let holder = try await gate.enter()
            defer { holder.finish() }
            do {
                _ = try await bridge.selectorExists("button", budget: DevToolsDeadline(timeout: 0.03))
                XCTFail("queue deadline must apply")
            } catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            XCTAssertEqual(gate.pendingCount, 0)
            let binding = await bridge.boundTargetID
            XCTAssertEqual(binding, "A")
        }
        XCTAssertEqual(calls, 0)
    }

    func testHTTPDeadlineCancelsBeforeHeadersAndDuringBody() async throws {
        for headers in [false, true] {
            let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .stalled(sendHeaders: headers)))
            defer { server.stop() }
            let bridge = ChromiumBridge(port: server.port)
            let started = ContinuousClock.now
            do {
                _ = try await bridge.targets(budget: DevToolsDeadline(timeout: 0.05))
                XCTFail("stalled response must expire")
            } catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            XCTAssertLessThan(started.duration(to: .now), .seconds(1))
        }
    }

    func testHTTPCancellationDoesNotWaitForStalledResponse() async throws {
        let entered = expectation(description: "HTTP request entered")
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .stalled(sendHeaders: true),
            requestObserver: { _ in entered.fulfill() }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        let request = Task { try await bridge.targets(budget: DevToolsDeadline(timeout: 10)) }
        await fulfillment(of: [entered], timeout: 1)
        let cancelled = ContinuousClock.now
        request.cancel()
        do { _ = try await request.value; XCTFail("cancelled request succeeded") }
        catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        XCTAssertLessThan(cancelled.duration(to: .now), .seconds(1))
    }

    func testLateTitleDiscoveryIsNotAnObservation() async throws {
        let clock = Clock()
        try await withBridge(clock: clock, executor: { _, _ in XCTFail("title needs no command"); return [:] }) { bridge in
            let budget = try DevToolsDeadline(timeout: 0.5, now: { clock.now })
            clock.arm()
            do { _ = try await bridge.currentTarget(budget: budget); XCTFail("late title") }
            catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
            let binding = await bridge.boundTargetID
            XCTAssertEqual(binding, "A")
        }
    }

    func testTitleDiscoveryRejectsBindingChangedDuringHTTP() async throws {
        final class Pause: @unchecked Sendable {
            let lock = NSLock()
            var armed = false
            let entered: XCTestExpectation
            let release = DispatchSemaphore(value: 0)
            init(_ entered: XCTestExpectation) { self.entered = entered }
            func arm() { lock.withLock { armed = true } }
            func observe(_ request: String) {
                guard request.hasPrefix("GET /json/list "), lock.withLock({ armed }) else { return }
                entered.fulfill()
                _ = release.wait(timeout: .now() + 2)
            }
        }
        let entered = expectation(description: "title discovery entered")
        let pause = Pause(entered)
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "stale title")], port: port)
        }, requestObserver: { pause.observe($0) }))
        defer { pause.release.signal(); server.stop() }
        let bridge = ChromiumBridge(port: server.port)
        try await bridge.attach(toTargetID: "A")
        pause.arm()
        let observation = Task { try await bridge.currentTarget(budget: DevToolsDeadline(timeout: 1)) }
        await fulfillment(of: [entered], timeout: 1)
        await bridge.detach()
        pause.release.signal()
        do { _ = try await observation.value; XCTFail("title from old binding") }
        catch { XCTAssertTrue(error.localizedDescription.contains("target changed"), "\(error)") }
    }

    func testExpiredBudgetDoesNotStartHTTPAndRejectsInvalidDurations() async throws {
        let clock = Clock()
        let budget = try DevToolsDeadline(timeout: 1, now: { clock.now })
        clock.advance(1)
        let bridge = ChromiumBridge(port: 1)
        do { _ = try await bridge.targets(budget: budget); XCTFail("expired request") }
        catch { XCTAssertTrue(error is DevToolsDeadline.Exceeded, "\(error)") }
        for timeout in [Double.nan, .infinity, 121] {
            XCTAssertThrowsError(try DevToolsDeadline(timeout: timeout))
        }
        for timeout in [0.0, -1] {
            XCTAssertThrowsError(try DevToolsDeadline(timeout: timeout)) { XCTAssertTrue($0 is DevToolsDeadline.Exceeded) }
        }
    }
}
