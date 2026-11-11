import Foundation
import XCTest
@testable import SpaceOKit

private final class StreamReplies: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [Response] = []
    private var completed = false
    func append(_ response: Response) { lock.withLock { replies.append(response) } }
    var all: [Response] { lock.withLock { replies } }
    func markCompleted() { lock.withLock { completed = true } }
    var isCompleted: Bool { lock.withLock { completed } }
}

final class EventStreamDeliveryTests: XCTestCase {
    func testReplayRedactionHeartbeatAndReconnectUseExclusiveCursor() async {
        let bus = EventBus(capacity: 8)
        bus.publish(kind: "one", session: "mine", detail: ["value": "visible"])
        bus.publish(kind: "two", session: "other", detail: ["value": "hidden"])
        bus.publish(kind: "three", session: nil)
        let replies = StreamReplies()
        let delivery = EventStreamDelivery(bus: bus, since: 0, heartbeatNanoseconds: 10_000_000,
            redactor: { EventBus.redacting($0, coveredSessions: ["mine"], operatorScope: false) }) {
                replies.append($0)
                return $0.message != "heartbeat"
            }
        await delivery.waitUntilClosed()
        XCTAssertEqual(replies.all.compactMap(\.nextSeq), [0, 1, 2, 3, 3])
        let events = replies.all.flatMap { $0.events ?? [] }
        XCTAssertEqual(events.map(\.seq), [1, 2, 3])
        XCTAssertEqual(events[0].detail, ["value": "visible"])
        XCTAssertEqual(events[1].detail, [:])
        XCTAssertTrue(events[1].redacted == true)
        XCTAssertEqual(bus.subscriberCount, 0)

        bus.publish(kind: "four", session: nil)
        let reconnect = StreamReplies()
        let next = EventStreamDelivery(bus: bus, since: 3, heartbeatNanoseconds: 10_000_000,
                                      redactor: { $0 }) {
            reconnect.append($0)
            return $0.message != "heartbeat"
        }
        await next.waitUntilClosed()
        XCTAssertEqual(reconnect.all.compactMap(\.nextSeq), [3, 4, 4])
        XCTAssertEqual(reconnect.all.flatMap { $0.events ?? [] }.map(\.seq), [4])
    }

    func testSlowWriterDoesNotBlockFastWriterAndGapPrecedesRetainedEvents() async {
        let bus = EventBus(capacity: 4)
        let started = expectation(description: "blocked writer")
        let fastFinished = expectation(description: "fast writer caught up")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let slowReplies = StreamReplies()
        let slow = EventStreamDelivery(bus: bus, since: 0, heartbeatNanoseconds: 10_000_000,
                                      redactor: { $0 }) { response in
            slowReplies.append(response)
            if response.events?.first?.seq == 1 {
                started.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            }
            return response.message != "heartbeat" || response.nextSeq != 20
        }
        let fast = EventStreamDelivery(bus: bus, since: 0) { response in
            if response.events?.last?.seq == 20 { fastFinished.fulfill(); return false }
            return true
        }
        bus.publish(kind: "first", session: nil)
        await fulfillment(of: [started], timeout: 2)
        for _ in 2...20 { bus.publish(kind: "next", session: nil) }
        await fulfillment(of: [fastFinished], timeout: 2)
        release.signal()
        await slow.waitUntilClosed()
        await fast.waitUntilClosed()
        let replies = slowReplies.all
        XCTAssertEqual(replies.flatMap { $0.events ?? [] }.map(\.seq), [1, 17, 18, 19, 20])
        let gap = replies.firstIndex { $0.resyncRequired == true }
        let retained = replies.firstIndex { $0.events?.first?.seq == 17 }
        XCTAssertNotNil(gap)
        XCTAssertNotNil(retained)
        if let gap, let retained {
            XCTAssertLessThan(gap, retained)
            XCTAssertEqual(replies[gap].nextSeq, 16)
        }
        XCTAssertEqual(replies.last?.nextSeq, 20)
        XCTAssertEqual(bus.subscriberCount, 0)
    }

    func testCancellationWaitsForSelectedWriterBeforeReturningSocketOwnership() async {
        let bus = EventBus(capacity: 8)
        let started = expectation(description: "write selected")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let finished = StreamReplies()
        let delivery = EventStreamDelivery(bus: bus, since: 0) { response in
            if response.events?.first != nil {
                started.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            }
            return true
        }
        bus.publish(kind: "one", session: nil)
        await fulfillment(of: [started], timeout: 2)
        let waiter = Task { await delivery.waitUntilClosed(); finished.markCompleted() }
        waiter.cancel()
        let deadline = Date().addingTimeInterval(2)
        while !delivery.isClosed && Date() < deadline { try? await Task.sleep(nanoseconds: 1_000_000) }
        XCTAssertTrue(delivery.isClosed)
        XCTAssertFalse(finished.isCompleted, "the socket owner must outlive the active writer")
        release.signal()
        await waiter.value
        XCTAssertTrue(finished.isCompleted)
        XCTAssertEqual(bus.subscriberCount, 0)
    }

    func testCloseBeforeWaitWakesEveryHandlerWaiter() async {
        let bus = EventBus(capacity: 8)
        let delivery = EventStreamDelivery(bus: bus, since: 0) { _ in true }
        delivery.close()
        async let first: Void = delivery.waitUntilClosed()
        async let second: Void = delivery.waitUntilClosed()
        _ = await (first, second)
        delivery.close()
        XCTAssertTrue(delivery.isClosed)
        XCTAssertEqual(bus.subscriberCount, 0)
    }

    func testFutureCursorReportsResetAndRefusalDoesNotClaimSubscription() async {
        let bus = EventBus(capacity: 8)
        bus.publish(kind: "one", session: nil)
        let replies = StreamReplies()
        let delivery = EventStreamDelivery(bus: bus, since: 100, heartbeatNanoseconds: 10_000_000,
                                          redactor: { $0 }) {
            replies.append($0)
            return $0.message != "heartbeat"
        }
        await delivery.waitUntilClosed()
        XCTAssertEqual(replies.all.filter { $0.resyncRequired == true }.map(\.nextSeq), [1])
        XCTAssertEqual(replies.all.last?.nextSeq, 1)
        XCTAssertTrue(replies.all.flatMap { $0.events ?? [] }.isEmpty)

        for _ in 0..<EventBus.maximumSubscribers { _ = bus.subscribe { _ in } }
        let refusedReplies = StreamReplies()
        let refused = EventStreamDelivery(bus: bus, since: 0) { refusedReplies.append($0); return true }
        await refused.waitUntilClosed()
        XCTAssertEqual(refusedReplies.all.count, 1)
        XCTAssertEqual(refusedReplies.all.first?.errorCode, "daemon_busy")
        XCTAssertFalse(refusedReplies.all.first?.ok ?? true)
        XCTAssertEqual(bus.subscriberCount, EventBus.maximumSubscribers)
    }
}
