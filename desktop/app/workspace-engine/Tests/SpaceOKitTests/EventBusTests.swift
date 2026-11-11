import XCTest
import Foundation
@testable import SpaceOKit

/// Collects deliveries from a subscription so ordering and content can be asserted.
private final class Sink: @unchecked Sendable {
    private let lock = NSLock()
    private var received: [DaemonEvent] = []
    func deliver(_ event: DaemonEvent) { lock.withLock { received.append(event) } }
    var events: [DaemonEvent] { lock.withLock { received } }
    var seqs: [UInt64] { events.map(\.seq) }
}

final class EventBusTests: XCTestCase {

    private let at = Date(timeIntervalSince1970: 1_700_000_000)

    func testSequenceIsMonotonicFromOne() {
        let bus = EventBus(capacity: 8)
        XCTAssertEqual(bus.latestSeq, 0)
        XCTAssertNil(bus.oldestRetainedSeq)
        let first = bus.publish(kind: "session.created", session: "a", at: at)
        let second = bus.publish(kind: "app.launched", session: "a", detail: ["bundle": "com.x"], at: at)
        XCTAssertEqual(first.seq, 1)
        XCTAssertEqual(second.seq, 2)
        XCTAssertEqual(second.at, at)
        XCTAssertEqual(second.detail, ["bundle": "com.x"])
        XCTAssertNil(second.redacted)
        XCTAssertEqual(bus.latestSeq, 2)
        XCTAssertEqual(bus.oldestRetainedSeq, 1)
    }

    func testRingDropsOldestBeyondCapacity() {
        let bus = EventBus(capacity: 3)
        for i in 1...5 { bus.publish(kind: "k\(i)", session: nil, at: at) }
        XCTAssertEqual(bus.latestSeq, 5)
        XCTAssertEqual(bus.oldestRetainedSeq, 3)
        let replay = bus.replay(since: 0)
        XCTAssertEqual(replay.events.map(\.seq), [3, 4, 5])
        XCTAssertEqual(replay.events.map(\.kind), ["k3", "k4", "k5"])
        XCTAssertEqual(replay.nextSeq, 5)
        XCTAssertTrue(replay.resyncRequired, "events 1-2 were dropped, so a cursor at 0 has a gap")
    }

    func testCapacityIsClamped() {
        let tiny = EventBus(capacity: 0)
        tiny.publish(kind: "a", session: nil, at: at)
        tiny.publish(kind: "b", session: nil, at: at)
        XCTAssertEqual(tiny.replay(since: 0).events.map(\.kind), ["b"])
    }

    func testReplayWithoutGapAndCursorSemantics() {
        let bus = EventBus(capacity: 10)
        for _ in 1...6 { bus.publish(kind: "e", session: nil, at: at) }

        let fromStart = bus.replay(since: 0)
        XCTAssertEqual(fromStart.events.map(\.seq), [1, 2, 3, 4, 5, 6])
        XCTAssertFalse(fromStart.resyncRequired)
        XCTAssertEqual(fromStart.nextSeq, 6)

        let middle = bus.replay(since: 4)
        XCTAssertEqual(middle.events.map(\.seq), [5, 6])
        XCTAssertFalse(middle.resyncRequired)

        let caughtUp = bus.replay(since: 6)
        XCTAssertTrue(caughtUp.events.isEmpty)
        XCTAssertEqual(caughtUp.nextSeq, 6, "an empty page keeps the caller's cursor")
        XCTAssertFalse(caughtUp.resyncRequired)

        let limited = bus.replay(since: 0, limit: 2)
        XCTAssertEqual(limited.events.map(\.seq), [1, 2])
        XCTAssertEqual(limited.nextSeq, 2)
        let continued = bus.replay(since: limited.nextSeq, limit: 2)
        XCTAssertEqual(continued.events.map(\.seq), [3, 4])

        XCTAssertEqual(bus.replay(since: 0, limit: 0).events.count, 1, "limit is clamped to at least one")
    }

    func testReplayAfterGapSetsResyncAndReturnsTail() {
        let bus = EventBus(capacity: 4)
        for _ in 1...10 { bus.publish(kind: "e", session: nil, at: at) }
        XCTAssertEqual(bus.oldestRetainedSeq, 7)

        let gap = bus.replay(since: 3)
        XCTAssertTrue(gap.resyncRequired)
        XCTAssertEqual(gap.events.map(\.seq), [7, 8, 9, 10])
        XCTAssertEqual(gap.nextSeq, 10)

        // A cursor exactly one behind the oldest retained event has seen everything.
        let edge = bus.replay(since: 6)
        XCTAssertFalse(edge.resyncRequired)
        XCTAssertEqual(edge.events.map(\.seq), [7, 8, 9, 10])
    }

    func testReplayWithCursorAheadOfLatestRequiresResync() {
        let bus = EventBus(capacity: 4)
        bus.publish(kind: "e", session: nil, at: at)
        let ahead = bus.replay(since: 40)
        XCTAssertTrue(ahead.resyncRequired, "a cursor from a previous daemon life is not valid here")
        XCTAssertTrue(ahead.events.isEmpty)
        XCTAssertEqual(ahead.nextSeq, 1)
    }

    func testReplayPagesMatchReferenceAcrossRingWrapsAndExtremeCursors() {
        for capacity in [1, 3, 8] {
            let bus = EventBus(capacity: capacity)
            var all: [DaemonEvent] = []
            for published in 0...24 {
                if published > 0 {
                    all.append(bus.publish(kind: "event", session: nil, at: at))
                }
                let retained = Array(all.suffix(capacity))
                for cursor in (0...UInt64(published + 1)).map({ $0 }) + [UInt64.max] {
                    for limit in [Int.min, 1, 2, capacity, Int.max] {
                        let result = bus.replay(since: cursor, limit: limit)
                        let expected = Array(retained.filter { $0.seq > cursor }
                            .prefix(min(max(limit, 1), capacity)))
                        XCTAssertEqual(result.events, expected)
                        XCTAssertEqual(result.nextSeq,
                            cursor > UInt64(published) ? UInt64(published) : expected.last?.seq ?? cursor)
                        let gap = retained.first.map { cursor < $0.seq - 1 } ?? false
                        XCTAssertEqual(result.resyncRequired, cursor > UInt64(published) || gap)
                    }
                }
            }
        }
    }

    func testSubscribeReplaysBacklogThenLiveEventsInOrder() {
        let bus = EventBus(capacity: 10)
        bus.publish(kind: "one", session: "a", at: at)
        bus.publish(kind: "two", session: "a", at: at)
        bus.publish(kind: "three", session: "a", at: at)

        let sink = Sink()
        let subscription = bus.subscribe(since: 1) { sink.deliver($0) }
        XCTAssertEqual(sink.seqs, [2, 3], "backlog after the cursor arrives synchronously on subscribe")
        XCTAssertEqual(bus.subscriberCount, 1)

        bus.publish(kind: "four", session: "a", at: at)
        XCTAssertEqual(sink.seqs, [2, 3, 4], "live events are delivered synchronously from publish")

        bus.unsubscribe(subscription)
        XCTAssertEqual(bus.subscriberCount, 0)
        bus.publish(kind: "five", session: "a", at: at)
        XCTAssertEqual(sink.seqs, [2, 3, 4], "nothing after unsubscribe")
        bus.unsubscribe(subscription)  // idempotent
    }

    func testRedactorCanDropOrRedactBothBacklogAndLive() {
        let bus = EventBus(capacity: 10)
        bus.publish(kind: "app.launched", session: "mine", detail: ["bundle": "com.a"], at: at)
        bus.publish(kind: "app.launched", session: "theirs", detail: ["bundle": "com.b"], at: at)
        bus.publish(kind: "handoff.note", session: "secret", detail: ["note": "x"], at: at)

        let sink = Sink()
        let redactor: @Sendable (DaemonEvent) -> DaemonEvent? = { event in
            if event.session == "secret" { return nil }
            return EventBus.redacting(event, coveredSessions: ["mine"], operatorScope: false)
        }
        _ = bus.subscribe(since: 0, redactor: redactor) { sink.deliver($0) }

        XCTAssertEqual(sink.seqs, [1, 2], "the dropped event never reaches deliver")
        XCTAssertEqual(sink.events[0].detail, ["bundle": "com.a"])
        XCTAssertNil(sink.events[0].redacted)
        XCTAssertEqual(sink.events[1].detail, [:])
        XCTAssertEqual(sink.events[1].redacted, true)
        XCTAssertEqual(sink.events[1].session, "theirs")

        bus.publish(kind: "handoff.note", session: "secret", at: at)
        bus.publish(kind: "window.placed", session: "theirs", detail: ["id": "9"], at: at)
        bus.publish(kind: "daemon.draining", session: nil, detail: ["reason": "restart"], at: at)
        XCTAssertEqual(sink.seqs, [1, 2, 5, 6])
        XCTAssertEqual(sink.events[2].redacted, true)
        XCTAssertEqual(sink.events[3].detail, ["reason": "restart"], "daemon-wide events are not session-scoped")
    }

    func testMultipleSubscribersReceiveInRegistrationOrder() {
        let bus = EventBus(capacity: 10)
        let order = Sink()
        _ = bus.subscribe { event in
            var tagged = event; tagged.detail["who"] = "first"; order.deliver(tagged)
        }
        _ = bus.subscribe { event in
            var tagged = event; tagged.detail["who"] = "second"; order.deliver(tagged)
        }
        bus.publish(kind: "e", session: nil, at: at)
        XCTAssertEqual(order.events.map { $0.detail["who"] }, ["first", "second"])
    }

    func testSubscriberPublishingFromCallbackDoesNotDeadlock() {
        let bus = EventBus(capacity: 10)
        let sink = Sink()
        _ = bus.subscribe { event in
            sink.deliver(event)
            if event.kind == "trigger" { bus.publish(kind: "reaction", session: nil, at: self.at) }
        }
        bus.publish(kind: "trigger", session: nil, at: at)
        XCTAssertEqual(sink.events.map(\.kind), ["trigger", "reaction"])
        XCTAssertEqual(sink.seqs, [1, 2])
    }

    func testNestedPublicationStaysOrderedForEverySubscriber() {
        let bus = EventBus(capacity: 8)
        let first = Sink(), second = Sink()
        _ = bus.subscribe { event in
            first.deliver(event)
            if event.seq == 1 { bus.publish(kind: "nested", session: nil) }
        }
        _ = bus.subscribe { second.deliver($0) }
        bus.publish(kind: "outer", session: nil)
        XCTAssertEqual(first.seqs, [1, 2])
        XCTAssertEqual(second.seqs, [1, 2])
    }

    func testPublishingDuringReplayDoesNotLoseTheNewEvent() {
        let bus = EventBus(capacity: 8)
        bus.publish(kind: "retained", session: nil)
        let sink = Sink()
        _ = bus.subscribe { event in
            sink.deliver(event)
            if event.seq == 1 { bus.publish(kind: "during-replay", session: nil) }
        }
        XCTAssertEqual(sink.seqs, [1, 2])
    }

    func testLongReentrantChainDrainsWithoutRecursiveCallbacks() {
        let bus = EventBus(capacity: 8)
        let sink = Sink()
        _ = bus.subscribe { event in
            sink.deliver(event)
            if event.seq < 2_000 { bus.publish(kind: "next", session: nil) }
        }
        bus.publish(kind: "first", session: nil)
        XCTAssertEqual(sink.seqs, Array(1...2_000))
    }

    func testSlowQueuedSubscriberDoesNotBlockPublishersAndReportsEviction() throws {
        let bus = EventBus(capacity: 4)
        let queue = DispatchQueue(label: "spaceo.test.slow-events")
        let started = expectation(description: "slow callback entered")
        let published = expectation(description: "publisher completed while callback blocked")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let slow = Sink(), fast = Sink(), gaps = Sink()
        let subscription = try XCTUnwrap(bus.subscribe(on: queue, onGap: { gap in
            gaps.deliver(DaemonEvent(seq: gap.resumeAfterSeq, at: Date(), kind: "gap", session: nil,
                                     detail: ["requested": String(gap.requestedSeq)]))
        }) { event in
            slow.deliver(event)
            if event.seq == 1 {
                started.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            }
        })
        _ = bus.subscribe { fast.deliver($0) }
        bus.publish(kind: "first", session: nil)
        wait(for: [started], timeout: 2)
        DispatchQueue.global().async {
            for _ in 2...20 { bus.publish(kind: "next", session: nil) }
            published.fulfill()
        }
        wait(for: [published], timeout: 2)
        XCTAssertEqual(fast.seqs, Array(1...20))
        release.signal()
        queue.sync {}
        XCTAssertEqual(slow.seqs, [1, 17, 18, 19, 20])
        XCTAssertEqual(gaps.seqs, [16])
        XCTAssertEqual(gaps.events.first?.detail["requested"], "1")
        bus.unsubscribe(subscription)
    }

    func testConcurrentPublishersPreserveSubscriberSequenceOrder() throws {
        let bus = EventBus(capacity: 2_000)
        let queue = DispatchQueue(label: "spaceo.test.concurrent-events")
        let inline = Sink(), queued = Sink()
        let caughtUp = expectation(description: "queued subscriber reached final sequence")
        _ = bus.subscribe { inline.deliver($0) }
        let subscription = try XCTUnwrap(bus.subscribe(on: queue, onGap: { _ in XCTFail("no eviction expected") }) {
            queued.deliver($0)
            if $0.seq == 1_000 { caughtUp.fulfill() }
        })
        DispatchQueue.concurrentPerform(iterations: 4) { _ in
            for _ in 0..<250 { bus.publish(kind: "event", session: nil) }
        }
        wait(for: [caughtUp], timeout: 3)
        XCTAssertEqual(inline.seqs, Array(1...1_000))
        XCTAssertEqual(queued.seqs, Array(1...1_000))
        bus.unsubscribe(subscription)
    }

    func testReplenishedQueuedDrainYieldsToControlWorkAndUnsubscribeStopsContinuation() throws {
        let bus = EventBus(capacity: 256)
        let queue = DispatchQueue(label: "spaceo.test.event-fairness")
        let sink = Sink()
        queue.suspend()
        let subscription = try XCTUnwrap(bus.subscribe(on: queue, onGap: { _ in XCTFail("unexpected gap") }) { event in
            sink.deliver(event)
            if event.seq < 1_000 { bus.publish(kind: "replenished", session: nil) }
        })
        bus.publish(kind: "seed", session: nil)
        let controlRan = expectation(description: "control work ran before backlog caught up")
        queue.async {
            XCTAssertEqual(sink.seqs, Array(1...UInt64(EventBus.maximumQueuedDeliveriesPerTurn)))
            bus.unsubscribe(subscription)
            controlRan.fulfill()
        }
        queue.resume()
        wait(for: [controlRan], timeout: 3)
        queue.sync {} // The queued successor sees that its subscriber was removed.
        XCTAssertEqual(sink.events.count, EventBus.maximumQueuedDeliveriesPerTurn)
        XCTAssertEqual(bus.latestSeq, UInt64(EventBus.maximumQueuedDeliveriesPerTurn + 1))
        XCTAssertEqual(bus.subscriberCount, 0)
    }

    func testGapAndRedactedEventsConsumeQueuedTurnBudgetWithoutLosingCursor() throws {
        let bus = EventBus(capacity: 512)
        for _ in 0..<1_000 { bus.publish(kind: "hidden", session: nil) }
        let queue = DispatchQueue(label: "spaceo.test.filtered-event-fairness")
        let filtered = Sink()
        let caughtUp = expectation(description: "all retained events considered")
        let yielded = expectation(description: "gap and filtering yielded")
        queue.suspend()
        let subscription = try XCTUnwrap(bus.subscribe(on: queue, onGap: { gap in
            XCTAssertEqual(gap.resumeAfterSeq, 488)
        }, redactor: { event in
            filtered.deliver(event)
            if event.seq == 1_000 { caughtUp.fulfill() }
            return nil
        }) { _ in XCTFail("redacted events must not be delivered") })
        queue.async {
            XCTAssertEqual(filtered.events.count, EventBus.maximumQueuedDeliveriesPerTurn - 1,
                           "the gap notification consumes one delivery decision")
            yielded.fulfill()
        }
        queue.resume()
        wait(for: [yielded, caughtUp], timeout: 3, enforceOrder: true)
        XCTAssertEqual(filtered.seqs, Array(489...1_000))
        bus.unsubscribe(subscription)
    }

    func testQueuedSubscriptionRefusalAndUnsubscribeBeforeDrain() throws {
        let bus = EventBus(capacity: 8)
        let queue = DispatchQueue(label: "spaceo.test.queued-subscription")
        queue.suspend()
        defer { queue.resume() }
        let subscription = try XCTUnwrap(bus.subscribe(on: queue, onGap: { _ in XCTFail("removed") }) {
            _ in XCTFail("removed subscriptions must not drain")
        })
        bus.publish(kind: "pending", session: nil)
        bus.unsubscribe(subscription)
        for _ in 0..<EventBus.maximumSubscribers { _ = bus.subscribe { _ in } }
        XCTAssertNil(bus.subscribe(on: queue, onGap: { _ in XCTFail("refused") }) { _ in XCTFail("refused") })
    }

    func testSubscriberLimitEmitsEventAndRefusesDeliveries() {
        let bus = EventBus(capacity: 100)
        var subscriptions: [EventBus.Subscription] = []
        for _ in 0..<EventBus.maximumSubscribers {
            subscriptions.append(bus.subscribe { _ in })
        }
        XCTAssertTrue(bus.isSaturated)
        XCTAssertEqual(bus.subscriberCount, EventBus.maximumSubscribers)
        XCTAssertEqual(Set(subscriptions).count, EventBus.maximumSubscribers, "subscriptions are distinct")

        let refusedSink = Sink()
        let refused = bus.subscribe { refusedSink.deliver($0) }
        XCTAssertEqual(bus.subscriberCount, EventBus.maximumSubscribers)
        let limitEvents = bus.replay(since: 0).events.filter { $0.kind == EventBus.subscriberLimitKind }
        XCTAssertEqual(limitEvents.count, 1)
        XCTAssertEqual(limitEvents.first?.detail["limit"], String(EventBus.maximumSubscribers))
        XCTAssertEqual(limitEvents.first?.detail["refused"], refused.id.uuidString)

        bus.publish(kind: "e", session: nil, at: at)
        XCTAssertTrue(refusedSink.events.isEmpty, "a refused subscription receives nothing")

        bus.unsubscribe(refused)  // no-op, must not disturb live subscribers
        XCTAssertEqual(bus.subscriberCount, EventBus.maximumSubscribers)
        bus.unsubscribe(subscriptions[0])
        XCTAssertFalse(bus.isSaturated)
    }

    // MARK: Bounds

    func testDetailBoundsTruncateValuesAndDropExtraKeys() {
        let bus = EventBus(capacity: 4)
        var detail: [String: String] = [:]
        for i in 0..<50 { detail[String(format: "k%02d", i)] = "v" }
        let long = String(repeating: "x", count: 2_000)
        detail["k00"] = long
        detail[String(repeating: "K", count: EventBus.maximumKeyBytes + 1)] = "dropped"
        detail["exact"] = String(repeating: "y", count: EventBus.maximumValueBytes)

        let event = bus.publish(kind: "agent.action", session: "s", detail: detail, at: at)
        XCTAssertEqual(event.detail.count, EventBus.maximumDetailKeys)
        XCTAssertTrue(event.detail.keys.allSatisfy { $0.utf8.count <= EventBus.maximumKeyBytes })
        XCTAssertTrue(event.detail.values.allSatisfy { $0.utf8.count <= EventBus.maximumValueBytes })
        XCTAssertTrue(event.detail["k00"]?.hasSuffix("…") ?? false)
        XCTAssertEqual(event.detail["exact"]?.utf8.count, EventBus.maximumValueBytes, "an exact fit is not truncated")
        // Sorted keys mean the retained set is deterministic: "exact" then k00...k30.
        XCTAssertNotNil(event.detail["exact"])
        XCTAssertNotNil(event.detail["k30"])
        XCTAssertNil(event.detail["k31"])
    }

    func testTruncationRespectsCharacterBoundaries() {
        // Each "é" is two bytes; a byte limit that falls mid-character must not split it.
        let value = String(repeating: "é", count: 300)
        let truncated = EventBus.utf8Prefix(value, maximumBytes: 9)
        XCTAssertEqual(truncated, "ééé…")  // 6 bytes + 3-byte ellipsis
        XCTAssertLessThanOrEqual(truncated.utf8.count, 9)
        XCTAssertEqual(EventBus.utf8Prefix("short", maximumBytes: 9), "short")
    }

    func testKindAndSessionAreBounded() {
        let bus = EventBus(capacity: 2)
        let event = bus.publish(
            kind: String(repeating: "k", count: 500),
            session: String(repeating: "s", count: 500), at: at)
        XCTAssertLessThanOrEqual(event.kind.utf8.count, EventBus.maximumKindBytes)
        XCTAssertLessThanOrEqual(event.session?.utf8.count ?? 0, EventBus.maximumSessionBytes)
    }

    func testRunawayProducerDoesNotGrowRetention() {
        let bus = EventBus(capacity: 16)
        for i in 0..<10_000 {
            bus.publish(kind: "spam", session: "s", detail: ["i": String(i)], at: at)
        }
        XCTAssertEqual(bus.replay(since: 0, limit: 10_000).events.count, 16)
        XCTAssertEqual(bus.latestSeq, 10_000)
        XCTAssertEqual(bus.oldestRetainedSeq, 9_985)
    }

    // MARK: Pure redaction rules

    func testRedactingRules() {
        let event = DaemonEvent(seq: 5, at: at, kind: "agent.action", session: "b", detail: ["tool": "click"])

        let asOperator = EventBus.redacting(event, coveredSessions: [], operatorScope: true)
        XCTAssertEqual(asOperator, event, "operators see everything")

        let covered = EventBus.redacting(event, coveredSessions: ["a", "b"], operatorScope: false)
        XCTAssertEqual(covered, event, "a covered session is returned untouched")

        let foreign = EventBus.redacting(event, coveredSessions: ["a"], operatorScope: false)
        XCTAssertEqual(foreign.seq, 5)
        XCTAssertEqual(foreign.at, at)
        XCTAssertEqual(foreign.kind, "agent.action")
        XCTAssertEqual(foreign.session, "b")
        XCTAssertEqual(foreign.detail, [:])
        XCTAssertEqual(foreign.redacted, true)
        XCTAssertEqual(event.detail, ["tool": "click"], "the input is not mutated")

        let daemonWide = DaemonEvent(seq: 6, at: at, kind: "daemon.draining", session: nil, detail: ["reason": "restart"])
        XCTAssertEqual(EventBus.redacting(daemonWide, coveredSessions: [], operatorScope: false), daemonWide,
                       "events with no session are visible to every lease holder")
    }
}
