import Foundation

/// Poll transient browser/adapter readiness without retrying cancelled work or accepting a
/// late observation. A probe retains its own transport timeout; this bounds subsequent polls.
enum BridgeReadiness {
    static func wait(timeout: TimeInterval, interval: TimeInterval,
                     runtime: WaitRuntime = .live,
                     validate: () throws -> Void = {},
                     probe: () async throws -> Bool) async throws -> Bool {
        guard timeout.isFinite, timeout >= 0, timeout <= 120,
              interval.isFinite, interval > 0, interval <= 120 else {
            throw SpaceOError.badRequest("invalid bridge readiness polling limits")
        }
        let deadline = runtime.now().addingTimeInterval(timeout)
        while runtime.now() < deadline {
            try Task.checkCancellation()
            try validate()
            try Task.checkCancellation()
            guard runtime.now() < deadline else { return false }
            let ready: Bool
            do {
                ready = try await probe()
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                try Task.checkCancellation()
                ready = false
            }
            try Task.checkCancellation()
            try validate()
            let remaining = deadline.timeIntervalSince(runtime.now())
            guard remaining > 0 else { return false }
            if ready { return true }
            try await runtime.sleep(min(interval, remaining))
        }
        try Task.checkCancellation()
        return false
    }
}
