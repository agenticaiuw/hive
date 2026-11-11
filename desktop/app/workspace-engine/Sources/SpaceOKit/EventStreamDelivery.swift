import Foundation

/// Exactly one task waits here; all handler waiters share that task's completion.
private final class EventStreamCloseSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { continuation in
            let alreadyFinished = lock.withLock {
                guard !finished else { return true }
                self.continuation = continuation
                return false
            }
            if alreadyFinished { continuation.resume() }
        }
    }

    func finish() {
        let pending = lock.withLock {
            finished = true
            let pending = continuation
            continuation = nil
            return pending
        }
        pending?.resume()
    }
}

/// One socket subscriber's serialized delivery and heartbeat lifecycle. EventBus retains the
/// bounded backlog; this object never queues a copy of every event or writes on a producer.
public final class EventStreamDelivery: @unchecked Sendable {
    private var bus: EventBus?
    private var write: (@Sendable (Response) -> Bool)?
    private let queue = DispatchQueue(label: "spaceo.events.delivery", qos: .utility)
    private let lock = NSLock()
    private var closed = false
    private var subscription: EventBus.Subscription?
    private var timer: DispatchSourceTimer?
    private let closeSignal = EventStreamCloseSignal()
    private let completion: Task<Void, Never>
    // Only the delivery queue accesses the cursor after initialization.
    private var cursor: UInt64

    public convenience init(
        bus: EventBus, since: UInt64,
        redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent? = { $0 },
        write: @escaping @Sendable (Response) -> Bool
    ) {
        self.init(bus: bus, since: since, heartbeatNanoseconds: 15_000_000_000,
                  redactor: redactor, write: write)
    }

    init(
        bus: EventBus, since: UInt64, heartbeatNanoseconds: UInt64,
        redactor: @escaping @Sendable (DaemonEvent) -> DaemonEvent?,
        write: @escaping @Sendable (Response) -> Bool
    ) {
        self.bus = bus
        self.cursor = since
        self.write = write
        let signal = closeSignal
        completion = Task { await signal.wait() }
        // Install every owned resource before callbacks can run. The first queued operation
        // emits the handshake, followed by the subscription's single replay/live drain.
        queue.suspend()
        defer { queue.resume() }
        queue.async { [weak self] in
            guard let self else { return }
            guard self.lock.withLock({ self.subscription != nil }) else {
                _ = self.send(.failure(Transport.TransportError.busy("too many event subscribers")))
                self.close()
                return
            }
            var hello = Response.success("subscribed")
            hello.events = []
            hello.nextSeq = self.cursor // Do not acknowledge a replay that has not been sent.
            _ = self.send(hello)
        }
        subscription = bus.subscribe(since: since, on: queue, onGap: { [weak self] gap in
            guard let self else { return }
            var response = Response.success("event history gap; resync required: run session list")
            response.events = []
            response.resyncRequired = true
            response.nextSeq = gap.resumeAfterSeq
            if self.send(response) { self.cursor = gap.resumeAfterSeq }
        }, redactor: redactor, deliver: { [weak self] event in
            guard let self else { return }
            var response = Response(ok: true)
            response.events = [event]
            response.nextSeq = event.seq // since is exclusive, as in events.poll.
            if self.send(response) { self.cursor = event.seq }
        })
        let heartbeat = DispatchSource.makeTimerSource(queue: queue)
        let interval = Int(min(max(heartbeatNanoseconds, 1_000_000), 60_000_000_000))
        heartbeat.schedule(deadline: .now() + .nanoseconds(interval), repeating: .nanoseconds(interval))
        heartbeat.setEventHandler { [weak self] in
            guard let self else { return }
            var response = Response.success("heartbeat")
            // Only acknowledge successfully delivered events, never the bus's unseen head.
            response.nextSeq = self.cursor
            _ = self.send(response)
        }
        timer = heartbeat
        heartbeat.resume()
    }

    public var isClosed: Bool { lock.withLock { closed } }

    @discardableResult
    private func send(_ response: Response) -> Bool {
        let write = lock.withLock { closed ? nil : self.write }
        guard let write else { return false }
        guard write(response) else { close(); return false }
        return true
    }

    public func close() {
        let resources = lock.withLock { () -> (
            bus: EventBus?, subscription: EventBus.Subscription?, timer: DispatchSourceTimer?,
            write: (@Sendable (Response) -> Bool)?
        )? in
            guard !closed else { return nil }
            closed = true
            let resources = (bus, subscription, timer, write)
            bus = nil
            subscription = nil
            timer = nil
            write = nil
            return resources
        }
        guard let resources else { return }
        // Release writer/owner captures outside the lock. A writer already selected on the
        // delivery queue retains its local callback until it finishes; waitUntilClosed's
        // queue barrier still protects descriptor ownership.
        withExtendedLifetime(resources) {
            resources.timer?.cancel()
            if let subscription = resources.subscription { resources.bus?.unsubscribe(subscription) }
            closeSignal.finish()
        }
    }

    /// Keep the transport handler alive while its serial writer owns the socket. Completion
    /// wakes the handler directly; idle streams need no half-second liveness polling.
    public func waitUntilClosed() async {
        await withTaskCancellationHandler {
            await completion.value
        } onCancel: {
            self.close()
        }
        // The transport closes its descriptor when this method returns. A cancellation may
        // have arrived during a bounded socket write; let that writer finish before fd reuse.
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
    }

    deinit { close() }
}
