import Foundation
import CoreGraphics

/// One full-resolution stability capture per manager, including native work that outlives its
/// request. A busy probe is unknown evidence, never a reused frame or proof of stability.
final class WaitFrameCapture: @unchecked Sendable {
    typealias Provider = @Sendable (Stage, CGRect, Capture.ForeignContent) async throws -> CGImage
    enum Failure: Error { case busy, timeout, invalidImage }
    private let provider: Provider
    private let lock = NSLock()
    private var pending: UUID?
    private var task: Task<Void, Never>?
    private var cancelled = false

    init(provider: @escaping Provider = { stage, rect, foreign in
        try await Capture.region(stage, rect, scale: 1, foreignContent: foreign).image
    }) {
        self.provider = provider
    }

    var isQuiescent: Bool { lock.withLock { pending == nil } }

    /// Takes ownership of the capture lease on every path, including rejection before startup.
    func hash(stage: Stage, rect: CGRect, foreign: Capture.ForeignContent,
              timeout: TimeInterval, lease: SessionCaptureWork.Lease) async throws -> UInt64 {
        let token = UUID()
        var transferred = false
        defer {
            if !transferred {
                lease.finish()
                lock.withLock { if pending == token { pending = nil } }
            }
        }
        try Task.checkCancellation()
        guard timeout.isFinite, timeout <= WaitPolicy.maximumDeadline else {
            throw SpaceOError.badRequest("capture observation timeout must be finite and at most 60 seconds")
        }
        guard timeout > 0 else { throw Failure.timeout }
        let deadline = ContinuousClock.now.advanced(by: .seconds(timeout))
        let dimensions = try Capture.validatedDimensions(width: rect.width, height: rect.height, scale: 1)
        guard rect.origin.x.isFinite, rect.origin.y.isFinite else { throw Failure.invalidImage }
        guard lock.withLock({
            guard pending == nil else { return false }
            pending = token
            cancelled = false
            return true
        }) else { throw Failure.busy }
        let duration = ContinuousClock.now.duration(to: deadline).components
        let remaining = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        guard remaining > 0 else { throw Failure.timeout }
        return try await CallbackDeadline.firstCompletion(
            within: remaining, timeoutError: Failure.timeout,
            start: { completion in
                self.lock.withLock {
                    guard self.pending == token, !self.cancelled else { return }
                    transferred = true
                    self.task = Task.detached(priority: .utility) {
                        let result: Result<UInt64, Error>
                        do {
                            try Task.checkCancellation()
                            guard ContinuousClock.now < deadline else { throw Failure.timeout }
                            let image = try await self.provider(stage, rect, foreign)
                            try Task.checkCancellation()
                            guard ContinuousClock.now < deadline else { throw Failure.timeout }
                            guard image.width > 0, image.height > 0,
                                  image.width == dimensions.width, image.height == dimensions.height else {
                                throw Failure.invalidImage
                            }
                            let hash = try Capture.validatedFrameHash(image)
                            try Task.checkCancellation()
                            guard ContinuousClock.now < deadline else { throw Failure.timeout }
                            result = .success(hash)
                        } catch { result = .failure(error) }
                        // All native work and pixel reads have returned before teardown may retry.
                        lease.finish()
                        self.lock.withLock {
                            if self.pending == token { self.task = nil; self.pending = nil }
                        }
                        completion(result)
                    }
                }
            }, onTimeout: {
                let active = self.lock.withLock { () -> Task<Void, Never>? in
                    guard self.pending == token else { return nil }
                    self.cancelled = true
                    return self.task
                }
                active?.cancel()
            })
    }
}
