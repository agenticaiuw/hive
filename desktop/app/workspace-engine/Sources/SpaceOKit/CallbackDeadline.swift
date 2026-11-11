import Foundation

/// Resumes one callback-backed continuation exactly once.
///
/// Native and network callbacks can arrive after their deadline or cancellation.
/// The timeout and the callback therefore race deliberately; this gate
/// makes the first result authoritative without making either path wait for the other to exit.
private final class CallbackContinuationGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var claimed = false
    private var completedResult: Result<Value, Error>?
    private var timer: DispatchSourceTimer?

    /// Cancellation may win before the continuation is installed, or while cleanup runs.
    func install(_ continuation: CheckedContinuation<Value, Error>) -> Bool {
        let state = lock.withLock { () -> (Bool, Result<Value, Error>?) in
            if let result = completedResult {
                completedResult = nil
                return (false, result)
            }
            self.continuation = continuation
            return (!claimed, nil)
        }
        if let result = state.1 { continuation.resume(with: result) }
        return state.0
    }

    func installTimer(_ timer: DispatchSourceTimer) -> Bool {
        let installed = lock.withLock {
            guard !claimed else { return false }
            self.timer = timer
            return true
        }
        if !installed { timer.cancel() }
        return installed
    }

    @discardableResult
    func resume(
        with result: Result<Value, Error>,
        beforeResuming: @Sendable () -> Void = {}
    ) -> Bool {
        let state = lock.withLock { () -> (Bool, DispatchSourceTimer?) in
            guard !claimed else { return (false, nil) }
            claimed = true
            defer { timer = nil }
            return (true, timer)
        }
        guard state.0 else { return false }
        state.1?.cancel()
        // Retire a stale transport before making the caller runnable. Installing a continuation
        // during cleanup must also wait here; it cannot observe a result until cleanup finishes.
        beforeResuming()
        let pending = lock.withLock { () -> CheckedContinuation<Value, Error>? in
            guard let pending = continuation else {
                completedResult = result
                return nil
            }
            continuation = nil
            return pending
        }
        pending?.resume(with: result)
        return true
    }
}

/// A deadline that does not wait for an uncooperative callback to finish after cancellation.
enum CallbackDeadline {
    static func firstCompletion<Value: Sendable>(
        within timeout: TimeInterval,
        timeoutError: Error,
        start: (@escaping @Sendable (Result<Value, Error>) -> Void) -> Void,
        onTimeout: @escaping @Sendable () -> Void = {}
    ) async throws -> Value {
        let gate = CallbackContinuationGate<Value>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard gate.install(continuation) else { return }
                let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
                timer.setEventHandler { [weak gate] in
                    gate?.resume(
                        with: .failure(timeoutError),
                        beforeResuming: onTimeout)
                }
                timer.schedule(deadline: .now() + timeout)
                timer.resume()
                guard gate.installTimer(timer) else { return }
                start { result in gate.resume(with: result) }
            }
        } onCancel: {
            gate.resume(with: .failure(CancellationError()), beforeResuming: onTimeout)
        }
    }
}
