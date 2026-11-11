import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

extension Capture {
    public static let maximumInMemoryPNGBytes = 5 * 1_048_576

    public static func pngData(_ image: CGImage) throws -> Data {
        try pngData(image, maximumBytes: Int.max)
    }

    /// Limit bytes retained by the output consumer, rather than encoding an arbitrarily large
    /// PNG and rejecting it afterwards. ImageIO's own working storage is outside this bound.
    static func pngData(_ image: CGImage, maximumBytes: Int) throws -> Data {
        let trace = PerformanceTrace.signposter.beginInterval("Capture.PNG", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Capture.PNG", trace) }
        guard maximumBytes > 0 else {
            throw SpaceOError.captureFailed("PNG byte limit must be positive")
        }
        let sink = PNGDataSink(maximumBytes: maximumBytes)
        let consumer = try sink.makeConsumer()
        guard let destination = CGImageDestinationCreateWithDataConsumer(
            consumer, UTType.png.identifier as CFString, 1, nil) else {
            throw SpaceOError.captureFailed("could not create PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        return try sink.result(finalized: CGImageDestinationFinalize(destination))
    }
}

/// Owns only accepted bytes. Once a write exceeds the budget, discard partial output and refuse
/// every subsequent write. A consumer owns its sink until CoreGraphics releases the callback info.
final class PNGDataSink {
    private let maximumBytes: Int
    private let lock = NSLock()
    private var data = Data()
    private var exceededLimit = false

    init(maximumBytes: Int) { self.maximumBytes = max(0, maximumBytes) }

    var retainedByteCount: Int { lock.withLock { data.count } }

    func append(_ bytes: UnsafeRawBufferPointer) -> Int {
        lock.withLock {
            guard !exceededLimit else { return 0 }
            guard bytes.count <= maximumBytes - data.count else {
                exceededLimit = true
                data = Data()
                return 0
            }
            if let base = bytes.baseAddress {
                data.append(base.assumingMemoryBound(to: UInt8.self), count: bytes.count)
            }
            return bytes.count
        }
    }

    func result(finalized: Bool) throws -> Data {
        try lock.withLock {
            guard !exceededLimit else {
                throw SpaceOError.captureFailed(
                    "PNG exceeds \(maximumBytes) bytes; reduce scale or capture a smaller region")
            }
            guard finalized else { throw SpaceOError.captureFailed("PNG encoding failed") }
            return data
        }
    }

    func makeConsumer() throws -> CGDataConsumer {
        var callbacks = CGDataConsumerCallbacks(
            putBytes: { info, buffer, count in
                guard let info else { return 0 }
                return Unmanaged<PNGDataSink>.fromOpaque(info).takeUnretainedValue()
                    .append(UnsafeRawBufferPointer(start: buffer, count: count))
            },
            releaseConsumer: { info in
                guard let info else { return }
                Unmanaged<PNGDataSink>.fromOpaque(info).release()
            })
        let info = Unmanaged.passRetained(self).toOpaque()
        guard let consumer = CGDataConsumer(info: info, cbks: &callbacks) else {
            Unmanaged<PNGDataSink>.fromOpaque(info).release()
            throw SpaceOError.captureFailed("could not create PNG output consumer")
        }
        return consumer
    }
}
