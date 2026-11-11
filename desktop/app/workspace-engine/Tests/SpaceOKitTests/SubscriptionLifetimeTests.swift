import Foundation
import XCTest
@testable import SpaceOKit

final class SubscriptionLifetimeTests: XCTestCase {
    private final class Capture: @unchecked Sendable {
        // Assigned before callbacks can run, then read only during deinitialization.
        weak var subscription: Transport.EventSubscription?
        let released: XCTestExpectation?
        init(released: XCTestExpectation? = nil) { self.released = released }
        deinit {
            subscription?.cancel() // Must not run under the subscription's lock.
            released?.fulfill()
        }
    }

    func testFailedSetupReleasesBothCallbackCapturesWhileHandleIsRetained() {
        var capture: Capture? = Capture()
        weak var retained: Capture?
        retained = capture
        let closed = expectation(description: "failed setup closes once")
        let subscription = Transport.EventSubscription(
            path: "/tmp/spaceo-missing-\(UUID().uuidString).sock", sinceSeq: 0,
            onResponse: { [capture] _ in withExtendedLifetime(capture) { XCTFail("unexpected response") } },
            onClose: { [capture] error in
                withExtendedLifetime(capture) { XCTAssertNotNil(error); closed.fulfill() }
            })
        capture?.subscription = subscription
        capture = nil
        XCTAssertNotNil(retained)
        subscription.start()
        wait(for: [closed], timeout: 1)
        XCTAssertNil(retained, "finished handles must not retain callback owners")
        subscription.cancel()
        subscription.start()
        XCTAssertFalse(subscription.isRunning)
    }

    func testCancellationBeforeStartIsTerminalAndReleasesCaptures() {
        var capture: Capture? = Capture()
        weak var retained: Capture?
        retained = capture
        let closed = expectation(description: "unused subscription cancelled once")
        let subscription = Transport.EventSubscription(path: "/tmp/unused-spaceo.sock", sinceSeq: 0,
            onResponse: { [capture] _ in withExtendedLifetime(capture) { XCTFail("unexpected response") } },
            onClose: { [capture] error in
                withExtendedLifetime(capture) { XCTAssertNil(error); closed.fulfill() }
            })
        capture?.subscription = subscription
        capture = nil
        subscription.cancel()
        wait(for: [closed], timeout: 1)
        XCTAssertNil(retained)
        subscription.start()
        subscription.cancel()
        XCTAssertFalse(subscription.isRunning)
    }

    func testCleanEOFReleasesCallbackCapturesBeforeRetainedHandleIsDropped() throws {
        let path = "/tmp/spaceo-life-\(UUID().uuidString.prefix(8)).sock"
        let server = Transport.Server(path: path) { _ in .success() }
        server.streamHandler = { _, write in _ = write(Response.success("synthetic")) }
        try server.start()
        defer { server.stop() }
        let released = expectation(description: "captures released")
        var capture: Capture? = Capture(released: released)
        weak var retained: Capture?
        retained = capture
        let received = expectation(description: "response")
        let closed = expectation(description: "clean EOF")
        let subscription = Transport.EventSubscription(path: path, sinceSeq: 0,
            onResponse: { [capture] response in
                withExtendedLifetime(capture) { XCTAssertEqual(response.message, "synthetic"); received.fulfill() }
            }, onClose: { [capture] error in
                withExtendedLifetime(capture) { XCTAssertNil(error); closed.fulfill() }
            })
        capture?.subscription = subscription
        capture = nil
        subscription.start()
        wait(for: [received, closed, released], timeout: 3)
        XCTAssertNil(retained)
        XCTAssertFalse(subscription.isRunning)
    }
}
