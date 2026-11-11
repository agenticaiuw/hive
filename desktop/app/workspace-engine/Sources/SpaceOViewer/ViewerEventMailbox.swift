import Foundation
import SpaceOKit

/// Bounded handoff from one socket reader to the main actor. A full mailbox parks that reader
/// until a batch is taken; the daemon's bounded ring then supplies explicit overrun notices.
final class ViewerEventMailbox: @unchecked Sendable {
    struct Batch {
        let events: [DaemonEvent]
        let receivedOK: Bool
        let resyncRequired: Bool
        let closed: Bool
    }

    static let maximumEvents = 128
    static let maximumBytes = 1_048_576
    private let condition = NSCondition()
    private var events: [DaemonEvent] = []
    private var bytes = 0
    private var scheduled = false
    private var stopped = false
    private var inputClosed = false
    private var receivedOK = false
    private var resyncRequired = false
    private var closePending = false

    func offer(_ response: Response, schedule: @Sendable () -> Void) {
        guard response.ok else { return }
        let incoming = response.events ?? []
        if incoming.isEmpty { enqueue(nil, resync: response.resyncRequired == true, schedule: schedule) }
        for event in incoming {
            enqueue(event, resync: response.resyncRequired == true, schedule: schedule)
        }
    }

    private func enqueue(_ event: DaemonEvent?, resync: Bool, schedule: @Sendable () -> Void) {
        let cost = event.flatMap(Self.retainedBytes)
        condition.lock()
        while !stopped && !inputClosed, let cost,
              events.count == Self.maximumEvents || cost > Self.maximumBytes - bytes {
            condition.wait()
        }
        guard !stopped, !inputClosed else { condition.unlock(); return }
        receivedOK = true
        resyncRequired = resyncRequired || resync
        if let event, let cost {
            events.append(event)
            bytes += cost
        } else if event != nil {
            // Never retain an arbitrarily large decoded event. Make omitted history visible.
            resyncRequired = true
        }
        let needsSchedule = !scheduled
        scheduled = true
        condition.unlock()
        if needsSchedule { schedule() }
    }

    func finish(schedule: @Sendable () -> Void) {
        condition.lock()
        guard !stopped, !inputClosed else { condition.unlock(); return }
        inputClosed = true
        closePending = true
        let needsSchedule = !scheduled
        scheduled = true
        condition.broadcast()
        condition.unlock()
        if needsSchedule { schedule() }
    }

    func take() -> Batch? {
        condition.lock()
        defer { condition.unlock() }
        guard !stopped, scheduled else { return nil }
        let batch = Batch(events: events, receivedOK: receivedOK,
                          resyncRequired: resyncRequired, closed: closePending)
        events = []
        bytes = 0
        receivedOK = false
        resyncRequired = false
        closePending = false
        scheduled = false
        condition.broadcast()
        return batch
    }

    func stop() {
        condition.lock()
        stopped = true
        events = []
        bytes = 0
        scheduled = false
        condition.broadcast()
        condition.unlock()
    }

    var pendingCount: Int {
        condition.lock(); defer { condition.unlock() }
        return events.count
    }

    /// Logical retained payload plus structural allowance, not an RSS measurement.
    static func retainedBytes(_ event: DaemonEvent) -> Int? {
        var remaining = maximumBytes - 256
        func charge(_ amount: Int) -> Bool {
            guard amount <= remaining else { return false }
            remaining -= amount
            return true
        }
        guard charge(event.kind.utf8.count), charge(event.session?.utf8.count ?? 0) else { return nil }
        for (key, value) in event.detail {
            guard charge(64), charge(key.utf8.count), charge(value.utf8.count) else { return nil }
        }
        return maximumBytes - remaining
    }
}
