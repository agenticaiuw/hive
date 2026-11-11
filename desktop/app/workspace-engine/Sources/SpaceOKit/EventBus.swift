import Foundation

/// The daemon's in-memory event stream (`events.subscribe`, `events.poll`).
///
/// A fixed-capacity ring rather than an unbounded log: the bus exists so agents can notice
/// activity, not so the daemon keeps history, and a chatty producer must never grow daemon
/// memory. Every input is clamped here — detail size, subscriber count, replay limit — so no
/// caller has to remember to.
///
/// A lock guards the bounded ring and subscriber cursors. Callbacks run outside it, with
/// one drain per subscriber, so nested publication stays ordered without recursive delivery
/// or an unbounded pending-event queue. Slow consumers explicitly report ring overruns.
public final class EventBus: @unchecked Sendable {
    public static let defaultCapacity = 4096
    public static let capacityRange = 1...65_536
    public static let maximumSubscribers = 64
    public static let maximumDetailKeys = 32
    public static let maximumKeyBytes = 64
    public static let maximumValueBytes = 480
    public static let maximumKindBytes = 64
    public static let maximumSessionBytes = 128
    public static let defaultReplayLimit = 500
    /// Yield a busy serial delivery queue without allocating one work item per event.
    static let maximumQueuedDeliveriesPerTurn = 128

    /// Emitted once on the bus itself when a subscribe is refused for saturation, so the
    /// refusal is visible to operators instead of silently dropping deliveries.
    public static let subscriberLimitKind = "bus.subscriber_limit"

    /// Daemon-wide bus. Tests construct their own so they never observe each other's traffic.
    public static let shared = EventBus()

    public struct Subscription: Hashable, Sendable {
        public let id: UUID
    }

    public struct DeliveryGap: Equatable, Sendable {
        public let requestedSeq: UInt64
        public let resumeAfterSeq: UInt64
        public let latestSeq: UInt64
    }

    private final class Subscriber {
        var cursor: UInt64
        var draining = false
        let queue: DispatchQueue?
        let onGap: @Sendable (DeliveryGap) -> Void
        let redactor: @Sendable (DaemonEvent) -> DaemonEvent?
        let deliver: @Sendable (DaemonEvent) -> Void

        init(cursor: UInt64, queue: DispatchQueue?, onGap: @escaping @Sendable (DeliveryGap) -> Void,
             redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent?,
             deliver: @escaping @Sendable (DaemonEvent) -> Void) {
            self.cursor = cursor
            self.queue = queue
            self.onGap = onGap
            self.redactor = redactor
            self.deliver = deliver
        }
    }

    private let lock = NSLock()
    private let capacity: Int
    /// Ring storage: `buffer[(head + i) % capacity]` is the i-th oldest retained event.
    private var buffer: [DaemonEvent?]
    private var head = 0
    private var count = 0
    private var nextSequence: UInt64 = 1
    private var subscribers: [UUID: Subscriber] = [:]
    /// Insertion order so delivery order across subscribers is deterministic.
    private var subscriberOrder: [UUID] = []

    public init(capacity: Int = EventBus.defaultCapacity) {
        let clamped = min(max(capacity, Self.capacityRange.lowerBound), Self.capacityRange.upperBound)
        self.capacity = clamped
        self.buffer = Array(repeating: nil, count: clamped)
    }

    // MARK: Publishing

    /// Append an event, dropping the oldest retained one when the ring is full, then deliver it
    /// to listeners. Inline listeners drain synchronously unless already delivering;
    /// queued listeners coalesce notifications into one scheduled worker each.
    @discardableResult
    public func publish(kind: String, session: String?, detail: [String: String] = [:], at: Date = Date()) -> DaemonEvent {
        // Bound caller-owned text before holding the ring lock.
        let boundedKind = Self.utf8Prefix(kind, maximumBytes: Self.maximumKindBytes)
        let boundedSession = session.map { Self.utf8Prefix($0, maximumBytes: Self.maximumSessionBytes) }
        let boundedDetail = Self.boundedDetail(detail)
        lock.lock()
        let event = DaemonEvent(
            seq: nextSequence,
            at: at,
            kind: boundedKind, session: boundedSession, detail: boundedDetail)
        nextSequence += 1
        append(event)
        let ids = subscriberOrder
        lock.unlock()
        for id in ids { requestDrain(id) }
        return event
    }

    private func append(_ event: DaemonEvent) {
        if count == capacity {
            buffer[head] = event
            head = (head + 1) % capacity
        } else {
            buffer[(head + count) % capacity] = event
            count += 1
        }
    }

    // MARK: Cursor state

    /// Highest `seq` ever assigned; zero before the first publish.
    public var latestSeq: UInt64 {
        lock.lock(); defer { lock.unlock() }
        return nextSequence - 1
    }

    /// `seq` of the oldest event still in the ring, or nil when nothing has been published.
    public var oldestRetainedSeq: UInt64? {
        lock.lock(); defer { lock.unlock() }
        return oldestRetainedSeqLocked()
    }

    private func oldestRetainedSeqLocked() -> UInt64? {
        count == 0 ? nil : buffer[head]?.seq
    }

    // MARK: Replay

    /// Events with `seq` greater than `since`, oldest first, at most `limit` of them.
    ///
    /// `resyncRequired` is true when the caller's cursor is not a position in the retained
    /// history: either events between `since` and the oldest retained one were dropped (the
    /// client fell behind), or `since` is ahead of `latestSeq` (the daemon restarted and the
    /// cursor belongs to a previous bus). The retained tail is returned regardless so the
    /// client can still catch up; the flag tells it not to assume it saw everything.
    public func replay(since seq: UInt64, limit: Int = EventBus.defaultReplayLimit) -> (events: [DaemonEvent], nextSeq: UInt64, resyncRequired: Bool) {
        lock.lock(); defer { lock.unlock() }
        let bounded = min(max(limit, 1), capacity)
        let latest = nextSequence - 1

        if seq > latest {
            return (events: [], nextSeq: latest, resyncRequired: true)
        }

        var gap = false
        if let oldest = oldestRetainedSeqLocked(), seq + 1 < oldest {
            gap = true
        }

        // Sequence numbers are contiguous, so locate the unread suffix directly. Polling a
        // caught-up cursor allocates nothing; a small page copies only the requested events.
        let unread = Int(min(UInt64(count), latest - seq))
        let pageCount = min(unread, bounded)
        var page: [DaemonEvent] = []
        page.reserveCapacity(pageCount)
        for offset in 0..<pageCount {
            if let event = buffer[(head + count - unread + offset) % capacity] {
                page.append(event)
            }
        }
        return (events: page, nextSeq: page.last?.seq ?? seq, resyncRequired: gap)
    }

    // MARK: Subscriptions

    /// Number of live subscribers (refused subscriptions are not counted).
    public var subscriberCount: Int {
        lock.lock(); defer { lock.unlock() }
        return subscribers.count
    }

    public var isSaturated: Bool {
        lock.lock(); defer { lock.unlock() }
        return subscribers.count >= Self.maximumSubscribers
    }

    /// Register an inline listener. Reentrant publications are drained after the current
    /// callback. A concurrent or nested producer may return before an existing drain catches
    /// up. Use the queued overload with onGap when overrun reporting is required.
    public func subscribe(
        since seq: UInt64 = 0,
        redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent? = { $0 },
        deliver: @escaping @Sendable (DaemonEvent) -> Void
    ) -> Subscription {
        let subscription = Subscription(id: UUID())
        _ = register(subscription, since: seq, queue: nil, onGap: { _ in },
                     redactor: redactor, deliver: deliver)
        return subscription
    }

    /// Register before replay, then drain on the supplied serial queue. The ring is the only
    /// event backlog; a consumer overtaken by eviction gets onGap before retained events.
    /// Nil means subscriber capacity was exhausted. Unsubscribe prevents new callbacks;
    /// one callback already selected for delivery may still finish.
    /// Large or continuously replenished backlogs drain in bounded queued turns, allowing
    /// other work on the queue to run. One queue barrier does not flush an entire backlog.
    public func subscribe(
        since seq: UInt64 = 0, on queue: DispatchQueue,
        onGap: @escaping @Sendable (DeliveryGap) -> Void,
        redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent? = { $0 },
        deliver: @escaping @Sendable (DaemonEvent) -> Void
    ) -> Subscription? {
        let subscription = Subscription(id: UUID())
        return register(subscription, since: seq, queue: queue, onGap: onGap,
                        redactor: redactor, deliver: deliver) ? subscription : nil
    }

    private func register(
        _ subscription: Subscription, since seq: UInt64, queue: DispatchQueue?,
        onGap: @escaping @Sendable (DeliveryGap) -> Void,
        redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent?,
        deliver: @escaping @Sendable (DaemonEvent) -> Void
    ) -> Bool {
        lock.lock()
        guard subscribers.count < Self.maximumSubscribers else {
            lock.unlock()
            publish(kind: Self.subscriberLimitKind, session: nil, detail: [
                "limit": String(Self.maximumSubscribers), "refused": subscription.id.uuidString,
            ])
            return false
        }
        subscribers[subscription.id] = Subscriber(cursor: seq, queue: queue, onGap: onGap,
                                                  redactor: redactor, deliver: deliver)
        subscriberOrder.append(subscription.id)
        lock.unlock()
        requestDrain(subscription.id)
        return true
    }

    private func requestDrain(_ id: UUID) {
        lock.lock()
        guard let subscriber = subscribers[id], !subscriber.draining else { lock.unlock(); return }
        subscriber.draining = true
        let queue = subscriber.queue
        lock.unlock()
        if let queue {
            queue.async { [weak self] in self?.drain(id) }
        } else {
            drain(id)
        }
    }

    private enum Delivery {
        case gap(DeliveryGap)
        case event(DaemonEvent)
    }

    private func drain(_ id: UUID) {
        var remaining = Self.maximumQueuedDeliveriesPerTurn
        while true {
            lock.lock()
            guard let subscriber = subscribers[id] else { lock.unlock(); return }
            let latest = nextSequence - 1
            if remaining == 0, let queue = subscriber.queue, subscriber.cursor != latest {
                // Keep draining=true while handing off, so concurrent publishers cannot
                // schedule duplicate workers. The successor rechecks membership and gaps.
                lock.unlock()
                queue.async { [weak self] in self?.drain(id) }
                return
            }
            let oldest = oldestRetainedSeqLocked() ?? nextSequence
            let delivery: Delivery
            if subscriber.cursor > latest || subscriber.cursor < oldest - 1 {
                let resume = subscriber.cursor > latest ? latest : oldest - 1
                delivery = .gap(DeliveryGap(requestedSeq: subscriber.cursor,
                                            resumeAfterSeq: resume, latestSeq: latest))
                subscriber.cursor = resume
            } else if subscriber.cursor < latest {
                let offset = Int(subscriber.cursor + 1 - oldest)
                guard let event = buffer[(head + offset) % capacity] else {
                    subscriber.draining = false
                    lock.unlock()
                    return
                }
                subscriber.cursor = event.seq
                delivery = .event(event)
            } else {
                subscriber.draining = false
                lock.unlock()
                return
            }
            lock.unlock()
            if subscriber.queue != nil { remaining -= 1 }
            switch delivery {
            case .gap(let gap): subscriber.onGap(gap)
            case .event(let event):
                if let visible = subscriber.redactor(event) { subscriber.deliver(visible) }
            }
        }
    }

    public func unsubscribe(_ subscription: Subscription) {
        let removed = lock.withLock {
            let removed = subscribers.removeValue(forKey: subscription.id)
            if removed != nil { subscriberOrder.removeAll { $0 == subscription.id } }
            return removed
        }
        // Callback captures can deinitialize objects that reenter the bus. Keep the
        // subscriber alive through the locked mutation, then release it after unlocking.
        withExtendedLifetime(removed) {}
    }

    // MARK: Redaction

    /// Lease-scoped visibility rule, kept pure so it can be tested without a bus.
    ///
    /// An operator sees everything. A lease holder sees full detail for the sessions its lease
    /// covers and for daemon-wide events (no session); for anyone else's session it still learns
    /// that something happened — `kind`, `session`, `seq`, `at` survive — but `detail` is emptied
    /// and `redacted` is set so an empty detail is never mistaken for "nothing to report".
    public static func redacting(_ event: DaemonEvent, coveredSessions: Set<String>, operatorScope: Bool) -> DaemonEvent {
        if operatorScope { return event }
        guard let session = event.session, !coveredSessions.contains(session) else { return event }
        var copy = event
        copy.detail = [:]
        copy.redacted = true
        return copy
    }

    // MARK: Bounds

    /// Clamp detail to the documented budget. Keys are kept in sorted order so which extras get
    /// dropped is deterministic; oversized keys are dropped rather than truncated because a
    /// truncated key could collide with a legitimate one.
    static func boundedDetail(_ detail: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for key in BoundedDiagnosticText.smallestKeys(detail.keys, limit: maximumDetailKeys,
                                                       maximumBytes: maximumKeyBytes) {
            result[key] = utf8Prefix(detail[key] ?? "", maximumBytes: maximumValueBytes)
        }
        return result
    }

    /// Prefix on character boundaries so truncation never produces invalid UTF-8 or a split
    /// grapheme, with a marker so the reader knows content was cut.
    static func utf8Prefix(_ value: String, maximumBytes: Int) -> String {
        BoundedDiagnosticText.prefix(value, maximumBytes: maximumBytes)
    }
}
