import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOMCP

final class FrameAdmissionTests: XCTestCase {
    /// A rejected append must not even begin traversing the incoming body.
    private struct UnreadableBytes: RandomAccessCollection {
        let count: Int
        var startIndex: Int { 0 }
        var endIndex: Int { count }
        func index(after index: Int) -> Int { index + 1 }
        func index(before index: Int) -> Int { index - 1 }
        subscript(index: Int) -> UInt8 { XCTFail("oversized bytes were consumed"); return 120 }
    }

    func testOversizeAdmissionDoesNotTraverseInputOrMutateExistingFrame() {
        for cap in [-1, 0, 3, 4] {
            var data = Data("kept".utf8)
            XCTAssertFalse(Transport.appendFrameBytes(UnreadableBytes(count: 1), to: &data, maximumBytes: cap))
            XCTAssertEqual(data, Data("kept".utf8))
        }
        var data = Data("kept".utf8)
        XCTAssertFalse(Transport.appendFrameBytes(UnreadableBytes(count: Int.max), to: &data, maximumBytes: Int.max))
        XCTAssertEqual(data, Data("kept".utf8))
        XCTAssertTrue(Transport.appendFrameBytes(Data("ok".utf8), to: &data, maximumBytes: 6))
        XCTAssertEqual(data, Data("keptok".utf8))
        XCTAssertTrue(Transport.appendFrameBytes(Data(), to: &data, maximumBytes: 6))
    }

    func testReadFramePreservesExactCapsAcrossReadBoundaries() throws {
        for count in [1, 8_191, 8_192, 8_193, 1_048_576] {
            let expected = Data(repeating: 120, count: count)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try (expected + Data("\nignored".utf8)).write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            for cap in [count, count - 1] {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let frame = Transport.readFrame(from: handle.fileDescriptor, maximumBytes: cap)
                if cap == count { XCTAssertEqual(frame, expected) }
                else { XCTAssertNil(frame) }
            }
        }
    }

    func testMCPDiscardPreservesTerminatorAndFollowingLinesAtChunkEdges() throws {
        // Exercise a newline at each edge of a 64 KiB read after a long rejected prefix,
        // including another rejected coalesced line and an exact-size unterminated tail.
        for length in [65_535, 65_536, 65_537, 131_071, 131_072, 131_073] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let exact = String(repeating: "v", count: 31)
            let input = String(repeating: "x", count: length) + "\n\n{}\n"
                + String(repeating: "y", count: 32) + "\n" + exact
            try Data(input.utf8).write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let reader = BoundedLineReader(handle: handle, maximumBytes: 31)
            XCTAssertThrowsError(try reader.next()) {
                XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .lineTooLong(31))
            }
            XCTAssertEqual(try reader.next(), "")
            XCTAssertEqual(try reader.next(), "{}")
            XCTAssertThrowsError(try reader.next()) {
                XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .lineTooLong(31))
            }
            XCTAssertEqual(try reader.next(), exact)
            XCTAssertNil(try reader.next())
        }
    }

    func testMCPExactBoundaryRetainsTailAfterDecodeFailure() throws {
        let cap = 65_536
        var input = Data(repeating: 120, count: cap - 1)
        input.append(255) // Exact-size but invalid UTF-8, followed by a valid coalesced line.
        input.append(Data("\n{}\n".utf8))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try input.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: cap)
        XCTAssertThrowsError(try reader.nextInputLine()) {
            XCTAssertEqual($0 as? BoundedLineReader.ReaderError, .invalidUTF8)
        }
        XCTAssertEqual((try reader.nextInputLine()?.jsonObject() as? [String: String])?.count, 0)
        XCTAssertNil(try reader.nextInputLine())
    }
}
