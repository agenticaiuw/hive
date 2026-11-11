import Foundation

/// Synchronous cleanup workers retain their authority until this wait returns. Cancellation
/// must not turn an unconfirmed process exit into permission to discard its resource ledger.
enum ProcessExitWait {
    struct Runtime: Sendable {
        let now: @Sendable () -> UInt64
        let sleep: @Sendable (UInt64) -> Void

        static let live = Runtime(now: { DispatchTime.now().uptimeNanoseconds }, sleep: {
            Thread.sleep(forTimeInterval: Double($0) / 1_000_000_000)
        })
    }

    /// Return survivors in input order. `isAlive` must preserve uncertain liveness as true;
    /// only a confirmed exit (including a confirmed replacement identity) removes an entry.
    /// Zero/invalid timeouts retain the existing one-shot liveness check without sleeping.
    /// Positive waits stop starting probes at their deadline and retain late/unqueried entries.
    static func wait<Value>(
        _ values: [Value], timeout: TimeInterval, runtime: Runtime = .live,
        isAlive: (Value) -> Bool
    ) -> [Value] {
        guard !values.isEmpty else { return [] }
        let boundedTimeout = timeout.isFinite ? min(max(timeout, 0), 30) : 0
        guard boundedTimeout > 0 else { return values.filter(isAlive) }
        let duration = UInt64(boundedTimeout * 1_000_000_000)
        let (end, overflow) = runtime.now().addingReportingOverflow(duration)
        let deadline = overflow ? UInt64.max : end
        var pending = values
        while !pending.isEmpty {
            // An expired scan keeps its unqueried suffix; it does not manufacture exit evidence.
            pending.removeAll { value in
                guard runtime.now() < deadline else { return false }
                let alive = isAlive(value)
                guard runtime.now() <= deadline else { return false }
                return !alive
            }
            let now = runtime.now()
            guard !pending.isEmpty, now < deadline else { return pending }
            runtime.sleep(min(120_000_000, deadline - now))
        }
        return pending
    }
}
