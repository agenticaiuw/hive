import Foundation
import XCTest
@testable import SpaceOMCP

final class MCPInputLineTests: XCTestCase {
    func testASCIIClassifierCoversEveryByteAtBlockAndTailPositions() {
        for count in [0, 1, 15, 31, 32, 33, 63, 64, 65, 95, 96, 97] {
            var bytes = Data(repeating: 65, count: count + 3)
            XCTAssertTrue(MCPInputLine.isASCII(bytes.dropFirst(3)))
            for position in 0..<count {
                for value in UInt8.min...UInt8.max {
                    bytes[position + 3] = value
                    XCTAssertEqual(MCPInputLine.isASCII(bytes.dropFirst(3)), value < 128,
                                   "count=\(count), position=\(position), value=\(value)")
                }
                bytes[position + 3] = 65
            }
        }
    }

    func testParsingMatchesOriginalUTF8AndWhitespaceBehavior() throws {
        let values = ["", " \t ", "\r", "\t\r ", "{}", " \t{}\t ",
                      "{\"text\":\"é😀\"}", "\u{a0}{}\u{2003}", "\u{2003}\u{a0}",
                      "\u{feff}{}", "[1,2]", "null", "true", "123", "\"text\"", "{bad}",
                      "{\"text\":\"a\nb\"}", "\u{000b}{}", "{}\u{000c}"]
        var inputs = values.map { Data($0.utf8) }
        inputs += [Data([0xFF]), Data([0xC0, 0xAF]), Data([0xED, 0xA0, 0x80]),
                   Data([0xF4, 0x90, 0x80, 0x80]), Data([0xC3]),
                   Data([0xFF, 0xFE, 0x7B, 0, 0x7D, 0])]
        // Foundation can auto-detect ASCII-only UTF-16/32; preserve the original UTF-8-first
        // conversion and edge trimming even for these unusual NUL-containing byte sequences.
        for encoding in [String.Encoding.utf16LittleEndian, .utf16BigEndian, .utf32LittleEndian] {
            for text in ["{}", " {} "] {
                inputs.append(try XCTUnwrap(text.data(using: encoding)))
            }
        }
        for data in inputs {
            guard let originalText = String(data: data, encoding: .utf8) else {
                XCTAssertNil(MCPInputLine(data: data))
                continue
            }
            let line = try XCTUnwrap(MCPInputLine(data: data))
            let trimmed = originalText.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                XCTAssertNil(try line.jsonObject())
            } else if let original = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) {
                let actual = try XCTUnwrap(try line.jsonObject())
                XCTAssertEqual(try JSONSerialization.data(withJSONObject: actual, options: [.sortedKeys]),
                               try JSONSerialization.data(withJSONObject: original, options: [.sortedKeys]))
            } else {
                XCTAssertThrowsError(try line.jsonObject())
            }
        }
    }

    func testByteInputKeepsLimitsRecoveryAndReturnedLineOwnership() throws {
        let limit = 131_072
        let large = Data(("{\"text\":\"" + String(repeating: "x", count: limit - 11) + "\"}").utf8)
        XCTAssertEqual(large.count, limit)
        var input = Data("{\"first\":true}\n".utf8)
        input.append(large)
        input.append(Data("\n".utf8))
        input.append(Data(repeating: 120, count: limit + 1))
        input.append(contentsOf: [10, 255, 10])
        input.append(Data("\u{a0}{\"unicode\":\"😀\"}\u{a0}\n{}".utf8))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try input.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let reader = BoundedLineReader(handle: handle, maximumBytes: limit)
        let first = try XCTUnwrap(reader.nextInputLine())
        let second = try XCTUnwrap(reader.nextInputLine())
        XCTAssertEqual((try second.jsonObject() as? [String: String])?["text"]?.utf8.count, limit - 11)
        guard case .recoverable(let oversize) = MCPServer.nextInput(from: reader) else {
            return XCTFail("oversized input must remain recoverable")
        }
        XCTAssertEqual(oversize as? BoundedLineReader.ReaderError, .lineTooLong(limit))
        guard case .recoverable(let malformed) = MCPServer.nextInput(from: reader) else {
            return XCTFail("invalid UTF-8 must remain recoverable")
        }
        XCTAssertEqual(malformed as? BoundedLineReader.ReaderError, .invalidUTF8)
        XCTAssertEqual(try reader.nextInputLine()?.jsonObject() as? [String: String], ["unicode": "😀"])
        XCTAssertEqual((try reader.nextInputLine()?.jsonObject() as? [String: String])?.count, 0)
        XCTAssertNil(try reader.nextInputLine())
        XCTAssertEqual(try first.jsonObject() as? [String: Bool], ["first": true])
        XCTAssertEqual((try second.jsonObject() as? [String: String])?["text"]?.utf8.count, limit - 11)
    }
}
