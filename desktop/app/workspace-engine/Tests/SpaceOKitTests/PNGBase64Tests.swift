import XCTest
import Foundation
@testable import SpaceOKit
@testable import SpaceOMCP

final class PNGBase64Tests: XCTestCase {
    private let signature = Data([137, 80, 78, 71, 13, 10, 26, 10])
    private let alphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)

    /// A deliberately noncontiguous collection to exercise the allocation-free scalar fallback.
    private struct StridedBytes: RandomAccessCollection {
        let storage: [UInt8]
        var startIndex: Int { 0 }
        var endIndex: Int { storage.count / 2 }
        subscript(index: Int) -> UInt8 { storage[index * 2] }
        func index(after index: Int) -> Int { index + 1 }
        func index(before index: Int) -> Int { index - 1 }
    }

    func testEveryByteAtSIMDLanesAndTailsMatchesBase64Alphabet() {
        for count in [0, 1, 15, 16, 31, 32, 33, 63, 64, 65, 95, 96, 97] {
            var storage = [UInt8](repeating: 65, count: count + 3)
            XCTAssertTrue(PNGBase64.containsOnlyAlphabet(storage[3...]))
            for position in 0..<count {
                for value in UInt8.min...UInt8.max {
                    storage[position + 3] = value
                    XCTAssertEqual(PNGBase64.containsOnlyAlphabet(storage[3...]), alphabet.contains(value),
                        "count=\(count), position=\(position), byte=\(value)")
                }
                storage[position + 3] = 65
            }
        }
    }

    func testNoncontiguousFallbackMatchesAlphabet() {
        for value in UInt8.min...UInt8.max {
            let bytes = StridedBytes(storage: [65, 255, value, 255, 47, 255])
            XCTAssertNil(bytes.withContiguousStorageIfAvailable { $0.count })
            XCTAssertEqual(PNGBase64.containsOnlyAlphabet(bytes), alphabet.contains(value))
        }
    }

    func testCanonicalPayloadsPreserveAllPaddingLengthsAndExactSizeLimits() {
        var state: UInt32 = 71
        for size in 8...512 {
            var bytes = signature
            for _ in 8..<size {
                state = state &* 1_664_525 &+ 1_013_904_223
                bytes.append(UInt8(truncatingIfNeeded: state >> 16))
            }
            let encoded = bytes.base64EncodedString()
            XCTAssertTrue(PNGBase64.isValid(encoded, maximumDecodedBytes: size))
            XCTAssertEqual(Data(base64Encoded: encoded), bytes)
            XCTAssertFalse(PNGBase64.isValid(encoded, maximumDecodedBytes: size - 1))
        }
    }

    func testLargeBoundaryUsesDecodedCountEvenWhenEncodedLengthIsUnchanged() {
        let maximum = Capture.maximumInMemoryPNGBytes
        let valid = (signature + Data(repeating: 173, count: maximum - signature.count)).base64EncodedString()
        let tooLarge = (signature + Data(repeating: 173, count: maximum - signature.count + 1)).base64EncodedString()
        XCTAssertEqual(valid.utf8.count, tooLarge.utf8.count)
        XCTAssertTrue(PNGBase64.isValid(valid, maximumDecodedBytes: maximum))
        XCTAssertFalse(PNGBase64.isValid(tooLarge, maximumDecodedBytes: maximum))
    }

    func testMalformedPaddingWhitespaceAndUnicodeAreRefused() {
        let prefix = (signature + Data([0])).base64EncodedString() // Complete unpadded groups.
        for suffix in ["====", "AA=A", "AAA==", "AA==AAAA", "AAA=AAAA", "A===", "AAAA====",
                       "AAAA\n", "AAAA\r\n", "AAAA ", "AAA\t", "AAAA\0", "AA-_", "😀", "éé"] {
            XCTAssertFalse(PNGBase64.isValid(prefix + suffix, maximumDecodedBytes: 1_024), suffix.debugDescription)
        }
        // Do not depend on a platform-specific Foundation bug for the expected rejection.
        XCTAssertFalse(PNGBase64.isValid(signature.base64EncodedString() + "====", maximumDecodedBytes: 1_024))
    }

    func testInvalidAlphabetAnywhereCannotHideAfterAValidPNGPrefix() {
        let original = Array((signature + Data(repeating: 3, count: 120)).base64EncodedString().utf8)
        for position in original.indices {
            for invalid: UInt8 in [0, 9, 10, 13, 32, 33, 45, 95, 127] {
                var bytes = original
                bytes[position] = invalid
                let value = String(decoding: bytes, as: UTF8.self)
                XCTAssertNil(Data(base64Encoded: value))
                XCTAssertFalse(PNGBase64.isValid(value, maximumDecodedBytes: 1_024))
            }
        }
    }

    func testPNGSignatureAndArithmeticAdmissionChecks() {
        for bytes in [Data(), signature.dropLast(), Data("not a png".utf8)] {
            XCTAssertFalse(PNGBase64.isValid(bytes.base64EncodedString(), maximumDecodedBytes: 1_024))
        }
        for maximum in [-1, 0, 7, Int.max] {
            XCTAssertFalse(PNGBase64.isValid(signature.base64EncodedString(), maximumDecodedBytes: maximum))
        }
        XCTAssertFalse(PNGBase64.isValid(String(repeating: "A", count: 100), maximumDecodedBytes: 8))
    }

    func testMCPForwardsOriginalEncodingAndRejectsMalformedPadding() throws {
        let valid = (signature + Data([255, 127, 1])).base64EncodedString()
        let result = try MCPServer.screenshotContent(message: nil, geometry: nil, pngBase64: valid)
        XCTAssertEqual(result.last?["data"] as? String, valid)
        XCTAssertThrowsError(try MCPServer.screenshotContent(message: nil, geometry: nil,
            pngBase64: signature.base64EncodedString() + "===="))
    }
}
