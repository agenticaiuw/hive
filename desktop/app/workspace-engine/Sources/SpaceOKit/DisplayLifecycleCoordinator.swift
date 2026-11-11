import Foundation

/// Bounds the caller's wait, not the underlying synchronous WindowServer IPC. A timed-out
/// operation remains on this one worker; no replacement workers or subsequent mutations run.
/// Retaining its context prevents ARC from turning a late result into an unplanned teardown.
final class DisplayLifecycleCoordinator: @unchecked Sendable {
    struct QueryDeferred: Error {}
    struct CreationDeferred: Error, LocalizedError {
        let underlyingError: SpaceOError
        var errorDescription: String? { underlyingError.errorDescription }
    }
    final class Operation: @unchecked Sendable {
        private let lock = NSLock()
        private var retained: [AnyObject] = []
        let deadline: DispatchTime
        private let checkHealth: @Sendable () throws -> Void

        init(deadline: DispatchTime, checkHealth: @escaping @Sendable () throws -> Void) {
            self.deadline = deadline
            self.checkHealth = checkHealth
        }

        func retain(_ value: AnyObject) { lock.withLock { retained.append(value) } }
        var retainedValues: [AnyObject] { lock.withLock { retained } }
        func check() throws { try checkHealth() }
    }

    private final class Completion<T>: @unchecked Sendable {
        let lock = NSLock()
        let signal = DispatchSemaphore(value: 0)
        var result: Result<T, Error>?
        /// The caller of a read-only query stopped waiting; the worker cleans up when it returns.
        var abandoned = false
    }

    private let queue = DispatchQueue(label: "spaceo.display-lifecycle")
    private let failureQueue = DispatchQueue(label: "spaceo.display-lifecycle-failure")
    /// Best-effort diagnostics never share `failureQueue`, which persists the safety latch.
    private let diagnosticsQueue = DispatchQueue(label: "spaceo.display-lifecycle-diagnostics")
    private var slowQueryReportPending = false
    private let lock = NSLock()
    private var failure: String?
    private var operations: [UUID: Operation] = [:]
    private var quarantined: [ObjectIdentifier: AnyObject] = [:]
    private var deferredRetirements: Set<UInt32> = []
    private let onFailure: @Sendable (String) -> Void
    private let onSlowQuery: @Sendable (TimeInterval) -> Void

    init(onFailure: @escaping @Sendable (String) -> Void = { _ in }) {
        self.onFailure = onFailure
        self.onSlowQuery = { _ in }
    }

    /// `onSlowQuery` observes a read-only query that outlived its caller's deadline.
    init(onFailure: @escaping @Sendable (String) -> Void,
         onSlowQuery: @escaping @Sendable (TimeInterval) -> Void) {
        self.onFailure = onFailure
        self.onSlowQuery = onSlowQuery
    }

    var failureReason: String? { lock.withLock { failure } }

    func check() throws {
        if let reason = failureReason { throw SpaceOError.stageCreationFailed(reason) }
    }

    func trip(_ reason: String) {
        let first = lock.withLock { () -> Bool in
            guard failure == nil else { return false }
            failure = "display safety circuit is open: \(reason); stop live work and inspect "
                + "docs/DISPLAY_SAFETY.md before recovery"
            return true
        }
        if first {
            // The lifecycle worker may be stuck holding the journal lock in fsync. Never
            // make the timeout caller wait for that same lock (or for logging/filesystem I/O).
            // Give normal persistence a short bounded chance to finish before returning.
            let saved = DispatchSemaphore(value: 0)
            failureQueue.async { [onFailure] in
                onFailure(reason)
                saved.signal()
            }
            _ = saved.wait(timeout: .now() + .milliseconds(100))
        }
    }

    func quarantine(_ value: AnyObject) {
        lock.withLock { quarantined[ObjectIdentifier(value)] = value }
    }

    /// A fallback has transferred ownership here without attempting a graph mutation.
    /// Retain and report it without relabeling a settling refusal as a sticky OS failure.
    func quarantineDeferred(_ value: AnyObject, displayID: UInt32) {
        lock.withLock {
            quarantined[ObjectIdentifier(value)] = value
            if displayID != 0 { deferredRetirements.insert(displayID) }
        }
    }

    var deferredRetirementDisplayIDs: [UInt32] { lock.withLock { deferredRetirements.sorted() } }

    func clearDeferredRetirement(_ displayID: UInt32, releasing value: AnyObject? = nil) {
        lock.withLock {
            _ = deferredRetirements.remove(displayID)
            if let value { quarantined.removeValue(forKey: ObjectIdentifier(value)) }
        }
    }

    func requireNoDeferredRetirements() throws {
        guard deferredRetirementDisplayIDs.isEmpty else {
            throw SpaceOError.stageCreationFailed("a fallback display retirement is deferred; "
                + "retain the daemon owner and inspect display safety before creating another display")
        }
    }

    /// Linearize final creation admission with fallback registration. No journal I/O or
    /// private display IPC runs while this lock is held. Owners registered after admission
    /// block subsequent creation; they cannot retroactively cancel an admitted attachment.
    func admitCreation() throws {
        try lock.withLock {
            if let failure { throw SpaceOError.stageCreationFailed(failure) }
            guard deferredRetirements.isEmpty else {
                throw CreationDeferred(underlyingError: .stageCreationFailed(
                    "a fallback display retirement is deferred; retain the daemon owner "
                        + "and inspect display safety before creating another display"))
            }
        }
    }

    func annotatingDeferredRetirements(_ status: DisplaySafetyStatus) -> DisplaySafetyStatus {
        let ids = deferredRetirementDisplayIDs
        var result = !ids.isEmpty && status.state == .ready
            ? DisplaySafetyStatus(state: .blocked, reason: "fallback display retirement is pending or deferred; "
                + "retain the daemon owner and inspect display safety") : status
        result.deferredRetirementDisplayIDs = ids.isEmpty ? nil : ids
        result.creationRateTestingOverride = status.creationRateTestingOverride
        return result
    }

    /// `readOnly` marks an idle-only query that changes nothing. Its deadline bounds the caller
    /// but is not evidence of an unknown graph change, so it does not open the circuit: the
    /// caller receives `QueryDeferred` and keeps its last verified snapshot (#54). The query
    /// stays registered until it returns, so later queries defer and any mutation still waits
    /// behind it under its own deadline, which does open the circuit if the worker never frees.
    func perform<T>(
        timeout: TimeInterval,
        retaining value: AnyObject? = nil,
        onlyWhenIdle: Bool = false,
        readOnly: Bool = false,
        _ body: @escaping @Sendable (Operation) throws -> T
    ) throws -> T {
        guard !readOnly || onlyWhenIdle else {
            throw SpaceOError.badRequest("a read-only display query must not wait behind a mutation")
        }
        let seconds = timeout.isFinite ? min(max(timeout, 0.1), 30) : 10
        let deadline = DispatchTime.now() + seconds
        let operation = makeOperation(deadline: deadline, readOnly: readOnly)
        if let value { operation.retain(value) }
        let id = UUID()
        let completion = Completion<T>()
        // Keep contexts even on refusal after a failure: releasing a display-owning object
        // here could mutate the already unhealthy graph. Production stages are finite-budgeted.
        let admitted = try lock.withLock { () throws -> Bool in
            if onlyWhenIdle, failure == nil, !operations.isEmpty { throw QueryDeferred() }
            guard failure == nil, operations.count < 16 else {
                if let value { quarantined[ObjectIdentifier(value)] = value }
                return false
            }
            operations[id] = operation
            // Enqueue while admission is locked, so another mutation cannot jump ahead of an
            // idle-only query after it has been admitted with its short execution deadline.
            queue.async {
                let result = Result { () throws -> T in
                    try operation.check()
                    return try body(operation)
                }
                let abandoned = completion.lock.withLock { () -> Bool in
                    completion.result = result
                    return completion.abandoned
                }
                completion.signal.signal()
                // Nobody publishes a late read. Keep what it retained instead of releasing it:
                // dropping the last reference to a display backing would be an unplanned teardown.
                if abandoned { self.finishAbandonedQuery(id, operation) }
            }
            return true
        }
        guard admitted else {
            trip("too many pending lifecycle operations or an earlier lifecycle failure")
            try check()
            throw SpaceOError.stageCreationFailed("display lifecycle admission refused")
        }
        guard completion.signal.wait(timeout: deadline) == .success else {
            // A read that answered just after its deadline is still an answer.
            let late = readOnly && completion.lock.withLock { () -> Bool in
                guard completion.result == nil else { return false }
                completion.abandoned = true
                return true
            }
            if late {
                reportSlowQuery(seconds)
                throw QueryDeferred()
            }
            if !readOnly {
                trip("a display operation exceeded \(seconds) seconds; its delivery is unknown")
                try check()
                throw SpaceOError.stageCreationFailed("display lifecycle timed out")
            }
            return try finish(id, completion)
        }
        return try finish(id, completion)
    }

    /// A mutation that reaches its deadline before or while running opens the circuit. A
    /// read-only query that only starts after its deadline (a starved worker) is skipped: it has
    /// changed nothing, and its caller already returned the last verified snapshot.
    func makeOperation(deadline: DispatchTime, readOnly: Bool) -> Operation {
        Operation(deadline: deadline) { [weak self] in
            guard let self else {
                throw SpaceOError.stageCreationFailed("display lifecycle owner no longer exists")
            }
            if DispatchTime.now() >= deadline {
                if readOnly { throw QueryDeferred() }
                self.trip("a display operation exhausted its total deadline")
            }
            try self.check()
        }
    }

    private func finish<T>(_ id: UUID, _ completion: Completion<T>) throws -> T {
        // A queued call may have timed out while this one was running. Never publish its result
        // as success once any caller has declared the shared lifecycle unhealthy.
        try lock.withLock {
            if let failure { throw SpaceOError.stageCreationFailed(failure) }
            operations.removeValue(forKey: id)
        }
        return try completion.lock.withLock {
            guard let result = completion.result else {
                throw SpaceOError.stageCreationFailed("display operation completed without a result")
            }
            return try result.get()
        }
    }

    /// Off the caller and off failure persistence; while one report is outstanding (a stalled
    /// logger), further slow queries are coalesced rather than queued without bound.
    private func reportSlowQuery(_ seconds: TimeInterval) {
        let start = lock.withLock { () -> Bool in
            guard !slowQueryReportPending else { return false }
            slowQueryReportPending = true
            return true
        }
        guard start else { return }
        diagnosticsQueue.async { [weak self, onSlowQuery] in
            onSlowQuery(seconds)
            guard let self else { return }
            self.lock.withLock { self.slowQueryReportPending = false }
        }
    }

    private func finishAbandonedQuery(_ id: UUID, _ operation: Operation) {
        lock.withLock {
            for value in operation.retainedValues { quarantined[ObjectIdentifier(value)] = value }
            operations.removeValue(forKey: id)
        }
    }

    var pendingOperationCount: Int { lock.withLock { operations.count } }
}
