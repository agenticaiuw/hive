import Foundation
import XCTest
@testable import SpaceOKit

final class LineBufferValidationTests: XCTestCase {
    private struct SegmentedBytes: Collection {
        let bytes: [UInt8]
        var startIndex: Int { bytes.startIndex }
        var endIndex: Int { bytes.endIndex }
        func index(after i: Int) -> Int { i + 1 }
        subscript(index: Int) -> UInt8 { bytes[index] }
    }

    func testContiguousSlicesAndCollectionFallbackEnforceTheSameTransactionalLimits() throws {
        XCTAssertNil(SegmentedBytes(bytes: [1]).withContiguousStorageIfAvailable { $0.count })
        for cap in [0, 1, 4, 16] {
            for prefixCount in [0, cap] {
                let prefix = Array(repeating: UInt8(120), count: prefixCount)
                for length in 0...7 {
                    for pattern in 0..<(1 << length) {
                        let bytes: [UInt8] = (0..<length).map { pattern & (1 << $0) == 0 ? 120 : 10 }
                        let combined = prefix + bytes
                        let fits = combined.split(separator: 10, omittingEmptySubsequences: false)
                            .allSatisfy { $0.count <= cap }
                        var contiguous = Transport.LineBuffer(maximumBytes: cap)
                        var segmented = Transport.LineBuffer(maximumBytes: cap)
                        try contiguous.append(prefix)
                        try segmented.append(SegmentedBytes(bytes: prefix))
                        // Both ArraySlice and Data slices may have nonzero collection indices.
                        let slice = ([255] + bytes).dropFirst()
                        if fits {
                            try contiguous.append(slice)
                            try segmented.append(SegmentedBytes(bytes: bytes))
                        } else {
                            XCTAssertThrowsError(try contiguous.append(slice))
                            XCTAssertThrowsError(try segmented.append(SegmentedBytes(bytes: bytes)))
                        }
                        let accepted = fits ? combined : prefix
                        var expected = accepted.split(separator: 10, omittingEmptySubsequences: false).map { Data($0) }
                        let tail = expected.removeLast()
                        for line in expected {
                            XCTAssertEqual(contiguous.nextLine(), line)
                            XCTAssertEqual(segmented.nextLine(), line)
                        }
                        XCTAssertNil(contiguous.nextLine())
                        XCTAssertNil(segmented.nextLine())
                        XCTAssertEqual(contiguous.hasPartialLine, !tail.isEmpty)
                        XCTAssertEqual(segmented.hasPartialLine, !tail.isEmpty)
                        try contiguous.append(Data([255, 10]).dropFirst())
                        try segmented.append(SegmentedBytes(bytes: [10]))
                        XCTAssertEqual(contiguous.nextLine(), tail)
                        XCTAssertEqual(segmented.nextLine(), tail)
                    }
                }
            }
        }
    }
}
