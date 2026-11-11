import Foundation
import CoreGraphics

/// One low-resolution capture may remain pending after a native API ignores cancellation.
/// Refuse further captures until it returns, so timeouts cannot accumulate tasks or images.
final class RecordingFrameCapture: @unchecked Sendable {
    typealias Provider = @Sendable (Stage, CGRect, Capture.ForeignContent, Double) async throws -> CGImage
    static let maximumEdge = 480
    static let maximumPNGBytes = 1_048_576
    private let provider: Provider
    private let timeout: TimeInterval
    private let now: @Sendable () -> ContinuousClock.Instant
    private let lock = NSLock()
    private var pending: UUID?
    private var task: Task<Void, Never>?
    private var cancelled = false

    enum Failure: Error { case busy, timeout, invalidImage }

    convenience init(timeout: TimeInterval = 2, provider: @escaping Provider = { stage, rect, foreign, scale in
        try await Capture.region(stage, rect, scale: scale, foreignContent: foreign).image
    }) {
        self.init(timeout: timeout, now: { .now }, provider: provider)
    }

    init(timeout: TimeInterval = 2, now: @escaping @Sendable () -> ContinuousClock.Instant,
         provider: @escaping Provider) {
        self.timeout = timeout.isFinite && timeout > 0 ? min(timeout, 2) : 2
        self.provider = provider
        self.now = now
    }

    func capture(stage: Stage, rect: CGRect, foreign: Capture.ForeignContent,
                 lease: SessionCaptureWork.Lease) async throws -> Data {
        var transferred = false
        defer { if !transferred { lease.finish() } }
        try Task.checkCancellation()
        let deadline = now().advanced(by: .seconds(timeout))
        let scale = try Self.scale(for: rect)
        let token = UUID()
        guard lock.withLock({
            guard pending == nil else { return false }
            pending = token
            cancelled = false
            return true
        }) else { throw Failure.busy }
        defer {
            // Cancellation can win before firstCompletion calls start.
            lock.withLock {
                if pending == token, task == nil { pending = nil }
            }
        }
        let duration = now().duration(to: deadline).components
        let remaining = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        guard remaining > 0 else { throw Failure.timeout }
        return try await CallbackDeadline.firstCompletion(
            within: remaining, timeoutError: Failure.timeout,
            start: { completion in
                self.lock.withLock {
                    guard self.pending == token, !self.cancelled else { return }
                    transferred = true
                    self.task = Task.detached(priority: .utility) {
                        let result: Result<Data, Error>
                        do {
                            try Task.checkCancellation()
                            guard self.now() < deadline else { throw Failure.timeout }
                            let image = try await self.provider(stage, rect, foreign, scale)
                            try Task.checkCancellation()
                            guard self.now() < deadline else { throw Failure.timeout }
                            guard image.width <= Self.maximumEdge, image.height <= Self.maximumEdge else {
                                throw Failure.invalidImage
                            }
                            let bytes = try Capture.pngData(image, maximumBytes: Self.maximumPNGBytes)
                            try Task.checkCancellation()
                            guard self.now() < deadline else { throw Failure.timeout }
                            result = .success(bytes)
                        } catch { result = .failure(error) }
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

    static func scale(for rect: CGRect) throws -> Double {
        guard rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.width.isFinite, rect.height.isFinite, rect.width >= 1, rect.height >= 1 else {
            throw Failure.invalidImage
        }
        // Floor the dominant edge slightly below the ceiling to avoid floating-point ceil
        // producing a 481st pixel in the capture configuration.
        return min(1, Double(maximumEdge - 1) / max(rect.width, rect.height))
    }
}

struct RecordingFrameEvidence {
    var bytes: Data?
    var status: String
    static let notAttempted = Self(bytes: nil, status: "not_attempted")
    static let stepEvidence = Self(bytes: nil, status: "step_evidence")
}

struct RecordingFrames {
    var before: RecordingFrameEvidence
    var after: RecordingFrameEvidence
}
