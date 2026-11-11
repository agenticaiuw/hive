import Foundation
import CoreGraphics

/// Bounded screenshot work; a timed-out worker keeps its slot and session resources until it
/// actually returns. Workers never publish files or mutate session/AX state.
final class ScreenshotCapture: @unchecked Sendable {
    enum Source: Sendable {
        case window(WindowRef, scale: Double)
        case region(Stage, CGRect, subRect: CGRect?, scale: Double, foreign: Capture.ForeignContent)
    }
    struct Frame: Sendable {
        let image: CGImage
        let geometry: ImageGeometry
        /// When the provider returned the image, before geometry checks and pixel processing.
        /// This is not a renderer/scanout timestamp or proof that the displayed pixels are fresh.
        let capturedAt: Date

        init(image: CGImage, geometry: ImageGeometry, capturedAt: Date = Date()) {
            self.image = image
            self.geometry = geometry
            self.capturedAt = capturedAt
        }
    }
    enum Payload: Sendable {
        case memory(String)
        case file(Data)
    }
    struct Prepared: Sendable {
        let payload: Payload
        let rendered: Bool
    }
    struct Budget: Sendable {
        let deadline: ContinuousClock.Instant
        let now: @Sendable () -> ContinuousClock.Instant
        static var expired: SpaceOError {
            .captureFailed("screenshot processing timed out; retry after pending capture work finishes")
        }
        func remaining() throws -> TimeInterval {
            try Task.checkCancellation()
            let duration = now().duration(to: deadline).components
            let value = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
            guard value > 0 else { throw Self.expired }
            return value
        }
        func check() throws { _ = try remaining() }
        func axLimits() throws -> AXTraversalLimits {
            let remaining = try remaining()
            guard remaining >= 0.01 else { throw Self.expired }
            var limits = AXTraversalLimits()
            limits.timeout = min(limits.timeout, remaining)
            return limits
        }
    }
    typealias Provider = @Sendable (Source) async throws -> Frame
    typealias Encoder = @Sendable (CGImage, Int) throws -> Data
    static let maximumFilePNGBytes = 64 * 1_048_576
    private let provider: Provider
    private let encoder: Encoder
    private let timeout: TimeInterval
    private let now: @Sendable () -> ContinuousClock.Instant
    private let lock = NSLock()
    private var pending: UUID?
    private var task: Task<Void, Never>?
    private var cancelled = false

    init(timeout: TimeInterval = 15,
         now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
         provider: @escaping Provider = { try await ScreenshotCapture.live($0) },
         encoder: @escaping Encoder = { try Capture.pngData($0, maximumBytes: $1) }) {
        self.timeout = timeout.isFinite && timeout > 0 ? min(timeout, 15) : 15
        self.now = now
        self.provider = provider
        self.encoder = encoder
    }

    private static func live(_ source: Source) async throws -> Frame {
        let captured: (image: CGImage, geometry: ImageGeometry)
        switch source {
        case .window(let window, let scale):
            captured = try await Capture.window(window, scale: scale)
        case .region(let stage, let rect, let subRect, let scale, let foreign):
            captured = try await Capture.region(stage, rect, subRect: subRect, scale: scale, foreignContent: foreign)
        }
        return Frame(image: captured.image, geometry: captured.geometry)
    }

    var isQuiescent: Bool { lock.withLock { pending == nil } }
    func makeBudget() -> Budget { Budget(deadline: now().advanced(by: .seconds(timeout)), now: now) }

    func capture(_ source: Source, budget: Budget, lease: SessionCaptureWork.Lease) async throws -> Frame {
        try await perform(budget: budget, lease: lease) {
            let rect: CGRect
            let scale: Double
            switch source {
            case .window(let window, let requested): rect = window.frame; scale = requested
            case .region(let stage, let tile, let subRect, let requested, _):
                let crop = subRect.map { CGRect(x: tile.minX + $0.minX, y: tile.minY + $0.minY,
                                               width: $0.width, height: $0.height).intersection(tile) } ?? tile
                rect = crop.intersection(stage.bounds)
                scale = requested
            }
            _ = try Capture.boundedDimensions(width: rect.width, height: rect.height, scale: scale)
            try budget.check()
            let frame = try await self.provider(source)
            try budget.check()
            let expected = try Capture.boundedDimensions(width: frame.geometry.pointWidth,
                height: frame.geometry.pointHeight, scale: frame.geometry.scale)
            guard frame.image.width == expected.width, frame.image.height == expected.height,
                  frame.geometry.pixelWidth == expected.width, frame.geometry.pixelHeight == expected.height else {
                throw SpaceOError.captureFailed("screenshot did not return the complete requested image")
            }
            return frame
        }
    }

    func prepare(_ image: CGImage, tags: [AnnotationTag]?, memory: Bool,
                 budget: Budget, lease: SessionCaptureWork.Lease) async throws -> Prepared {
        try await perform(budget: budget, lease: lease) {
            let output = try tags.map { try CaptureAnnotation.annotate(image, tags: $0) } ?? image
            try budget.check()
            let rendered = Capture.looksRendered(output)
            try budget.check()
            let maximumBytes = memory ? Capture.maximumInMemoryPNGBytes : Self.maximumFilePNGBytes
            let bytes = try self.encoder(output, maximumBytes)
            guard bytes.count <= maximumBytes else {
                throw SpaceOError.captureFailed("PNG exceeds \(maximumBytes) bytes; reduce scale or capture a smaller region")
            }
            try budget.check()
            return Prepared(payload: memory ? .memory(bytes.base64EncodedString()) : .file(bytes), rendered: rendered)
        }
    }

    private func perform<Value: Sendable>(budget: Budget, lease: SessionCaptureWork.Lease,
        operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        let token = UUID()
        var transferred = false
        defer {
            if !transferred {
                lease.finish()
                lock.withLock { if pending == token { pending = nil } }
            }
        }
        try budget.check()
        guard lock.withLock({
            guard pending == nil else { return false }
            pending = token
            cancelled = false
            return true
        }) else {
            throw SpaceOError.captureFailed("a previous screenshot is still running; retry after it completes")
        }
        return try await CallbackDeadline.firstCompletion(
            within: budget.remaining(), timeoutError: Budget.expired,
            start: { completion in
                self.lock.withLock {
                    guard self.pending == token, !self.cancelled else { return }
                    transferred = true
                    self.task = Task.detached(priority: .utility) {
                        let result: Result<Value, Error>
                        do {
                            try budget.check()
                            let value = try await operation()
                            try budget.check()
                            result = .success(value)
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
}
