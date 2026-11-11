import Foundation
import XCTest
@testable import SpaceOKit

final class EventCallbackLifetimeTests: XCTestCase {
    private final class Capture: @unchecked Sendable {
        // Set before dropping the test's strong reference; read only at deinitialization.
        weak var delivery: EventStreamDelivery?
        weak var bus: EventBus?
        let released: XCTestExpectation
        init(_ released: XCTestExpectation) { self.released = released }
        deinit {
            delivery?.close()
            _ = bus?.subscriberCount
            released.fulfill()
        }
    }

    func testUnsubscribeReleasesCallbackCapturesOutsideBusLock() async throws {
        let bus = EventBus(capacity: 8)
        let released = expectation(description: "capture can reenter bus on release")
        var capture: Capture? = Capture(released)
        capture?.bus = bus
        weak var retained: Capture?
        retained = capture
        let subscription = try XCTUnwrap(bus.subscribe(since: 0, on: .global(),
            onGap: { [capture] _ in withExtendedLifetime(capture) {} },
            redactor: { [capture] event in withExtendedLifetime(capture) { event } },
            deliver: { [capture] _ in withExtendedLifetime(capture) {} }))
        capture = nil
        XCTAssertNotNil(retained)
        let finished = expectation(description: "unsubscribe returns")
        DispatchQueue.global().async { bus.unsubscribe(subscription); finished.fulfill() }
        await fulfillment(of: [released, finished], timeout: 2)
        XCTAssertNil(retained)
        XCTAssertEqual(bus.subscriberCount, 0)
        bus.unsubscribe(subscription)
    }

    func testClosedRetainedHandleReleasesBusAndWriterForExplicitAndFailedWrites() async {
        for failWrite in [false, true] {
            var bus: EventBus? = EventBus(capacity: 8)
            weak var retainedBus: EventBus?
            retainedBus = bus
            let released = expectation(description: "writer capture released")
            var capture: Capture? = Capture(released)
            weak var retainedCapture: Capture?
            retainedCapture = capture
            let delivery = EventStreamDelivery(bus: bus!, since: 0) { [capture] _ in
                withExtendedLifetime(capture) { !failWrite }
            }
            capture?.delivery = delivery
            capture = nil
            bus = nil
            if !failWrite { delivery.close() }
            await delivery.waitUntilClosed()
            await fulfillment(of: [released], timeout: 2)
            XCTAssertTrue(delivery.isClosed)
            XCTAssertNil(retainedCapture)
            XCTAssertNil(retainedBus, "a retained closed handle must not keep the event backlog alive")
            delivery.close()
        }
    }

    func testCloseKeepsSelectedWriterAliveOnlyUntilItFinishes() async {
        let bus = EventBus(capacity: 8)
        let started = expectation(description: "writer selected")
        let released = expectation(description: "selected writer released")
        let unblock = DispatchSemaphore(value: 0)
        defer { unblock.signal() }
        var capture: Capture? = Capture(released)
        weak var retained: Capture?
        retained = capture
        let delivery = EventStreamDelivery(bus: bus, since: 0) { [capture] response in
            withExtendedLifetime(capture) {
                if response.events?.first != nil {
                    started.fulfill()
                    XCTAssertEqual(unblock.wait(timeout: .now() + 5), .success)
                }
                return true
            }
        }
        capture?.delivery = delivery
        capture = nil
        bus.publish(kind: "synthetic", session: nil)
        await fulfillment(of: [started], timeout: 2)
        delivery.close()
        XCTAssertTrue(delivery.isClosed)
        XCTAssertNotNil(retained, "an in-flight writer must retain its resources until returning")
        XCTAssertEqual(bus.subscriberCount, 0)
        unblock.signal()
        await delivery.waitUntilClosed()
        await fulfillment(of: [released], timeout: 2)
        XCTAssertNil(retained)
    }
}
