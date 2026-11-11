import Foundation

/// One monotonic observation budget, including time spent waiting for actor/command admission.
struct DevToolsDeadline: Sendable {
    struct Exceeded: Error {}
    private let deadline: ContinuousClock.Instant
    private let now: @Sendable () -> ContinuousClock.Instant

    init(timeout: TimeInterval, now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }) throws {
        guard timeout.isFinite, timeout <= 120 else {
            throw SpaceOError.badRequest("DevTools observation timeout must be greater than zero and at most 120 seconds")
        }
        guard timeout > 0 else { throw Exceeded() }
        self.now = now
        deadline = now().advanced(by: .seconds(timeout))
    }

    func remaining() throws -> TimeInterval {
        try Task.checkCancellation()
        let duration = now().duration(to: deadline).components
        let value = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        guard value > 0 else { throw Exceeded() }
        return value
    }

    func check() throws { _ = try remaining() }
}
