import Foundation

/// FIFO exclusion for commands that may suspend while they own mutable session state.
///
/// An actor alone is not enough: actor methods are reentrant at every `await`, so a destroy
/// request can otherwise run while launch, capture, or DevTools work is suspended.
final class SessionOperationGate: @unchecked Sendable {
    final class Lease: @unchecked Sendable {
        private let lock = NSLock()
        private var gate: SessionOperationGate?

        fileprivate init(gate: SessionOperationGate) {
            self.gate = gate
        }

        func finish() {
            let owner = lock.withLock {
                let owner = gate
                gate = nil
                return owner
            }
            owner?.leave()
        }

        deinit { finish() }
    }

    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Lease, any Error>
        let timer: DispatchSourceTimer?
    }

    private enum Registration {
        case grant
        case queued
        case cancelled
        case timedOut
    }

    struct TimedOut: Error {}

    private let lock = NSLock()
    private var occupied = false
    private var waiters: [Waiter] = []

    /// Nil preserves ordinary FIFO admission. Zero is a nonblocking attempt: grant only
    /// when free. A positive timeout bounds queue residence, not the lease holder's work.
    func enter(timeout: TimeInterval? = nil) async throws -> Lease {
        if let timeout, !timeout.isFinite || timeout < 0 || timeout > 120 {
            throw SpaceOError.badRequest("operation queue timeout must be from 0 through 120 seconds")
        }
        let deadline = timeout.flatMap { $0 > 0 ? DispatchTime.now() + $0 : nil }
        let waiterID = UUID()
        let lease = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let registration = lock.withLock {
                    guard !Task.isCancelled else {
                        return Registration.cancelled
                    }
                    if let deadline, DispatchTime.now() >= deadline { return Registration.timedOut }
                    if occupied {
                        guard timeout != 0 else { return Registration.timedOut }
                        var timer: DispatchSourceTimer?
                        if let deadline {
                            let source = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
                            source.setEventHandler { [weak self] in
                                self?.removeWaiter(id: waiterID, error: TimedOut())
                            }
                            source.schedule(deadline: deadline)
                            source.resume()
                            timer = source
                        }
                        waiters.append(Waiter(
                            id: waiterID,
                            continuation: continuation, timer: timer))
                        return Registration.queued
                    }
                    occupied = true
                    return Registration.grant
                }
                switch registration {
                case .grant:
                    continuation.resume(returning: Lease(gate: self))
                case .queued:
                    break
                case .cancelled:
                    continuation.resume(throwing: CancellationError())
                case .timedOut:
                    continuation.resume(throwing: TimedOut())
                }
            }
        } onCancel: {
            self.removeWaiter(id: waiterID, error: CancellationError())
        }

        // Cancellation can race the atomic queue-to-owner handoff. If the handoff won, release
        // its authority here instead of returning a lease to code that has already been
        // cancelled or whose queue budget has expired.
        do {
            try Task.checkCancellation()
            if let deadline, DispatchTime.now() >= deadline { throw TimedOut() }
            return lease
        } catch {
            lease.finish()
            throw error
        }
    }

    private func removeWaiter(id: UUID, error: Error) {
        let continuation = lock.withLock {
            guard let index = waiters.firstIndex(where: { $0.id == id }) else {
                return nil as CheckedContinuation<Lease, any Error>?
            }
            let waiter = waiters.remove(at: index)
            waiter.timer?.cancel()
            return waiter.continuation
        }
        continuation?.resume(throwing: error)
    }

    private func leave() {
        let next = lock.withLock { () -> CheckedContinuation<Lease, any Error>? in
            guard !waiters.isEmpty else {
                occupied = false
                return nil
            }
            let waiter = waiters.removeFirst()
            waiter.timer?.cancel()
            return waiter.continuation
        }
        next?.resume(returning: Lease(gate: self))
    }

    var pendingCount: Int { lock.withLock { waiters.count } }
}

/// Per-session barrier between work and teardown.
///
/// Operations acquire a lease before touching session-owned apps, windows, bridges, or the
/// display tile. Destroy marks the session unavailable immediately, waits for every existing
/// lease, performs cleanup once, and only then reports completion.
final class SessionLifecycle: @unchecked Sendable {
    enum State: Equatable, Sendable {
        case active
        case destroying
        case destroyed
    }

    final class Lease: @unchecked Sendable {
        private let lock = NSLock()
        private var lifecycle: SessionLifecycle?

        fileprivate init(lifecycle: SessionLifecycle) {
            self.lifecycle = lifecycle
        }

        func finish() {
            let owner = lock.withLock {
                let owner = lifecycle
                lifecycle = nil
                return owner
            }
            owner?.finishOperation()
        }

        deinit { finish() }
    }

    private let condition = NSCondition()
    private var state: State = .active
    private var activeOperations = 0
    /// `prepareForDestroy` fences new work before cleanup is moved off the manager actor. The
    /// first later `destroy` call claims the cleanup; concurrent destroy callers wait for it.
    private var cleanupClaimed = false

    func beginOperation() -> Lease? {
        condition.lock()
        defer { condition.unlock() }
        guard state == .active else { return nil }
        activeOperations += 1
        return Lease(lifecycle: self)
    }

    /// Stop admitting new operations without waiting for existing work to drain.
    ///
    /// The manager calls this while it still owns the short global command lease, then releases
    /// that lease before process-exit waits begin on a worker. Existing per-session operations
    /// remain protected by `activeOperations` and are drained by `destroy(cleanup:)`.
    func prepareForDestroy() {
        condition.lock()
        if state == .active { state = .destroying }
        condition.unlock()
    }

    /// Returns true only to the caller that performed cleanup.
    @discardableResult
    func destroy(cleanup: () -> Void) -> Bool {
        condition.lock()
        switch state {
        case .destroyed:
            condition.unlock()
            return false
        case .destroying:
            if cleanupClaimed {
                while state != .destroyed { condition.wait() }
                condition.unlock()
                return false
            }
            cleanupClaimed = true
            while activeOperations > 0 { condition.wait() }
            condition.unlock()
        case .active:
            state = .destroying
            cleanupClaimed = true
            while activeOperations > 0 { condition.wait() }
            condition.unlock()
        }

        cleanup()

        condition.lock()
        state = .destroyed
        condition.broadcast()
        condition.unlock()
        return true
    }

    private func finishOperation() {
        condition.lock()
        precondition(activeOperations > 0, "unbalanced session lifecycle lease")
        activeOperations -= 1
        if activeOperations == 0 { condition.broadcast() }
        condition.unlock()
    }

    var currentState: State {
        condition.lock()
        defer { condition.unlock() }
        return state
    }
}
