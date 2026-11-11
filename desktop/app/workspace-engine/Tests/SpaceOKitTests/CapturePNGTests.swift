import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import SpaceOKit

final class CapturePNGTests: XCTestCase {
    private func syntheticImage() throws -> CGImage {
        var pixels = [UInt8](repeating: 255, count: 128 * 128 * 4)
        var state: UInt32 = 42
        for index in pixels.indices where index % 4 != 3 {
            state = state &* 1_664_525 &+ 1_013_904_223
            pixels[index] = UInt8(truncatingIfNeeded: state >> 24)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        return try XCTUnwrap(CGImage(
            width: 128, height: 128, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 128 * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    }

    func testBoundedEncoderPreservesPNGBytesAtExactLimit() throws {
        let image = try syntheticImage()
        // Independent reference: the previous ImageIO memory destination, without our consumer.
        let reference = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            reference, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let bounded = try Capture.pngData(image, maximumBytes: reference.length)
        XCTAssertEqual(bounded, reference as Data)
        XCTAssertEqual(try Capture.pngData(image), bounded)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bounded as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, 128)
        XCTAssertEqual(decoded.height, 128)
    }

    func testEncoderRejectsOverflowInsteadOfReturningPartialPNG() throws {
        let image = try syntheticImage()
        let complete = try Capture.pngData(image)
        for limit in [1, 1_024, complete.count - 1] {
            XCTAssertThrowsError(try Capture.pngData(image, maximumBytes: limit)) { error in
                XCTAssertTrue(String(describing: error).contains("reduce scale or capture a smaller region"))
            }
        }
        XCTAssertThrowsError(try Capture.pngData(image, maximumBytes: 0))
        XCTAssertThrowsError(try Capture.pngData(image, maximumBytes: -1))
    }

    func testConsumerNeverRetainsOverflowingChunksAndFailureIsSticky() throws {
        let sink = PNGDataSink(maximumBytes: 64)
        let first = Data(repeating: 1, count: 40)
        let second = Data(repeating: 2, count: 24)
        XCTAssertEqual(first.withUnsafeBytes { sink.append($0) }, 40)
        XCTAssertEqual(second.withUnsafeBytes { sink.append($0) }, 24)
        XCTAssertEqual(sink.retainedByteCount, 64)
        XCTAssertEqual(try sink.result(finalized: true), first + second)
        XCTAssertEqual(Data([3]).withUnsafeBytes { sink.append($0) }, 0)
        XCTAssertEqual(sink.retainedByteCount, 0)
        XCTAssertEqual(first.withUnsafeBytes { sink.append($0) }, 0)
        XCTAssertEqual(sink.retainedByteCount, 0)
        XCTAssertThrowsError(try sink.result(finalized: true))
    }

    func testSingleOversizedWriteIsRefusedWithoutRetainingItsPrefix() {
        let sink = PNGDataSink(maximumBytes: 64)
        XCTAssertEqual(Data(repeating: 7, count: 1_024).withUnsafeBytes { sink.append($0) }, 0)
        XCTAssertEqual(sink.retainedByteCount, 0)
        XCTAssertThrowsError(try sink.result(finalized: true))
    }

    func testFinalizeFailureCannotReturnAcceptedPartialOutput() {
        let sink = PNGDataSink(maximumBytes: 64)
        _ = Data([1, 2, 3]).withUnsafeBytes { sink.append($0) }
        XCTAssertThrowsError(try sink.result(finalized: false))
    }

    func testConsumerKeepsSinkAliveOnlyUntilConsumerRelease() throws {
        weak var observed: PNGDataSink?
        try autoreleasepool {
            var sink: PNGDataSink? = PNGDataSink(maximumBytes: 64)
            observed = sink
            var consumer: CGDataConsumer? = try XCTUnwrap(sink).makeConsumer()
            sink = nil
            XCTAssertNotNil(observed)
            withExtendedLifetime(consumer) {}
            consumer = nil
        }
        XCTAssertNil(observed)
    }

    func testIncompatibleCaptureOptionsFailBeforeSessionOrCaptureAccess() async {
        let manager = SessionManager(runJanitor: false)
        var request = Request(cmd: "screenshot")
        request.memory = true
        request.output = "/unused-export.png"
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.errorCode, "bad_request")
        XCTAssertTrue(response.error?.contains("mutually exclusive") == true)
    }
}
