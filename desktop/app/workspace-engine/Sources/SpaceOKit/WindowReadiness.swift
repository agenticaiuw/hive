import Foundation

/// Window polling preserves discovery failures and passes its remainder into each provider.
/// Native calls retain their authority until they return; late results never establish readiness.
///
/// A provider failure is retried within the budget: an application that is still registering
/// with Accessibility refuses its window count for a few hundred milliseconds after launch. A
/// failed read never becomes an empty poll, though — when the budget ends on one, that failure
/// is rethrown instead of reporting that no window appeared.
enum WindowReadiness {
    static func validate(timeout: TimeInterval, pollNanoseconds: UInt64) throws {
        guard timeout.isFinite, (0.1...120).contains(timeout) else {
            throw SpaceOError.badRequest("window timeout must be a finite value from 0.1 through 120 seconds")
        }
        guard (10_000_000...1_000_000_000).contains(pollNanoseconds) else {
            throw SpaceOError.badRequest("window poll interval must be from 10 milliseconds through 1 second")
        }
    }

    static func wait<Value: Sendable>(
        timeout: TimeInterval, pollNanoseconds: UInt64, runtime: WaitRuntime = .live,
        validate: () throws -> Void = {}, probe: (TimeInterval) throws -> Value?
    ) async throws -> Value? {
        try Self.validate(timeout: timeout, pollNanoseconds: pollNanoseconds)
        let deadline = runtime.now().addingTimeInterval(timeout)
        let interval = Double(pollNanoseconds) / 1_000_000_000
        var providerFailure: AXTraversalStopped?
        func expired() throws -> Value? {
            if let providerFailure { throw providerFailure }
            return nil
        }
        while runtime.now() < deadline {
            try Task.checkCancellation()
            try validate()
            let remaining = deadline.timeIntervalSince(runtime.now())
            guard remaining >= 0.01 else { return try expired() } // AX's minimum traversal envelope.
            let observed: Value?
            do { observed = try probe(remaining); providerFailure = nil }
            catch let stopped as AXTraversalStopped where stopped.reason == .deadline { observed = nil }
            catch let stopped as AXTraversalStopped where stopped.reason == .cancelled { throw CancellationError() }
            catch let stopped as AXTraversalStopped where stopped.reason == .provider {
                providerFailure = stopped
                observed = nil
            }
            try Task.checkCancellation()
            try validate()
            let afterProbe = deadline.timeIntervalSince(runtime.now())
            guard afterProbe > 0 else { return try expired() }
            if let observed { return observed }
            try await runtime.sleep(min(interval, afterProbe))
        }
        try Task.checkCancellation()
        return try expired()
    }
}
