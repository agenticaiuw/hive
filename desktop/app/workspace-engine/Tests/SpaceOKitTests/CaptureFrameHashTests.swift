import XCTest
import CoreGraphics
@testable import SpaceOKit

final class CaptureFrameHashTests: XCTestCase {
    private func image(width: Int = 64, height: Int = 64, padding: Int = 0,
                       bytes: [UInt8]) throws -> CGImage {
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        return try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8,
                                    bitsPerPixel: 32, bytesPerRow: width * 4 + padding,
                                    space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                    provider: provider, decode: nil, shouldInterpolate: false,
                                    intent: .defaultIntent))
    }

    func testChangesBetweenOldGridSamplesAndAtFinalPixelAreDetected() throws {
        var bytes = [UInt8](repeating: 0, count: 64 * 64 * 4)
        let original = try Capture.validatedFrameHash(image(bytes: bytes))
        // The former 32x32 grid sampled only even coordinates on a 64x64 image.
        bytes[(1 * 64 + 1) * 4] = 1
        XCTAssertNotEqual(try Capture.validatedFrameHash(image(bytes: bytes)), original)
        bytes[(1 * 64 + 1) * 4] = 0
        bytes[bytes.count - 1] = 1
        XCTAssertNotEqual(try Capture.validatedFrameHash(image(bytes: bytes)), original)
    }

    func testEqualPixelsIgnoreRowPadding() throws {
        let plain = [UInt8](repeating: 0, count: 64 * 64 * 4)
        var padded = [UInt8](repeating: 0, count: 64 * (64 * 4 + 16))
        for row in 0..<64 {
            for offset in 256..<272 { padded[row * 272 + offset] = 255 }
        }
        XCTAssertEqual(try Capture.validatedFrameHash(image(bytes: plain)),
                       try Capture.validatedFrameHash(image(padding: 16, bytes: padded)))
    }

    func testMatchingPayloadWithDifferentDimensionsIsNotStable() throws {
        let bytes = [UInt8](repeating: 0, count: 64 * 64 * 4)
        XCTAssertNotEqual(try Capture.validatedFrameHash(image(bytes: bytes)),
                          try Capture.validatedFrameHash(image(width: 32, height: 128, bytes: bytes)))
    }

    func testRepeatedImageIsStableAndPublicHelperAgrees() throws {
        let frame = try image(bytes: [UInt8](repeating: 42, count: 64 * 64 * 4))
        let hash = try Capture.validatedFrameHash(frame)
        XCTAssertEqual(try Capture.validatedFrameHash(frame), hash)
        XCTAssertEqual(Capture.frameHash(frame), hash)
    }

    func testInvalidAndOverflowingLayoutsCannotEstablishStability() throws {
        // CoreGraphics rejects short providers at image construction on this host. Exercise
        // the same checked layout boundary used before creating the raw row views directly.
        for (width, height, stride, available) in [
            (64, 64, 256, 4), (64, 64, 255, 64 * 256), (0, 64, 256, 64 * 256),
            (Int.max, 64, 256, Int.max), (64, Int.max, 256, Int.max),
        ] {
            XCTAssertThrowsError(try Capture.frameRowByteCount(
                width: width, height: height, bitsPerPixel: 32,
                bytesPerRow: stride, availableBytes: available))
        }
        XCTAssertEqual(try Capture.frameRowByteCount(width: 64, height: 64, bitsPerPixel: 32,
                                                      bytesPerRow: 272, availableBytes: 63 * 272 + 256), 256)
    }
}
