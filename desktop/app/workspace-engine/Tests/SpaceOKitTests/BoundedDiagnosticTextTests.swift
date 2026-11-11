import XCTest
@testable import SpaceOKit

final class BoundedDiagnosticTextTests: XCTestCase {
    private func reference<Text: StringProtocol>(_ value: Text, bytes: Int, characters: Int = Int.max) -> String {
        let limited = value.prefix(characters)
        guard limited.utf8.count > bytes else { return String(limited) }
        guard bytes >= 3 else { return "" }
        var result = ""
        for character in limited {
            let candidate = result + String(character)
            if candidate.utf8.count > bytes - 3 { break }
            result = candidate
        }
        return result + "…"
    }

    func testBoundedLookaheadMatchesOriginalUnicodeAndCharacterLimitSemantics() {
        let parts = ["a", "\r", "\n", "\0", "é", "😀", "\u{301}", "\u{200D}",
                     "🇦", "🇧", "🇨", "👩", "🏽", "\u{600}", "\u{903}",
                     "\u{1100}", "\u{1161}", "\u{11A8}", "क", "्", "ष"]
        var state: UInt64 = 17
        for _ in 0..<150 {
            var value = ""
            for _ in 0..<20 {
                state = state &* 6364136223846793005 &+ 1
                value += parts[Int(state % UInt64(parts.count))]
            }
            for cap in 0...64 {
                for characters in [0, 1, 3, 8, Int.max] {
                    let expected = reference(value, bytes: cap, characters: characters)
                    XCTAssertEqual(BoundedDiagnosticText.prefix(value, maximumBytes: cap, maximumCharacters: characters), expected)
                    let wrapped = "[" + value + "]"
                    let substring = wrapped.dropFirst().dropLast()
                    XCTAssertEqual(BoundedDiagnosticText.prefix(substring, maximumBytes: cap, maximumCharacters: characters),
                                   reference(substring, bytes: cap, characters: characters))
                }
            }
        }
    }

    func testCharacterCapKeepsExactByteFitsWithoutAddingAnEllipsis() {
        for value in [String(repeating: "😀", count: 4096), String(repeating: "x", count: 4096),
                      String(repeating: "e\u{301}", count: 4096)] {
            let extended = value + "extra"
            XCTAssertEqual(BoundedDiagnosticText.prefix(extended, maximumBytes: value.utf8.count,
                                                       maximumCharacters: 4096), value)
        }
        let huge = "before a" + String(repeating: "\u{301}", count: 250_000) + "after"
        for cap in [3, 32, 480, 16_384] {
            XCTAssertEqual(BoundedDiagnosticText.prefix(huge, maximumBytes: cap, maximumCharacters: 4096),
                           reference(huge, bytes: cap, characters: 4096))
        }
    }

    func testSubstringScalarOffsetsAndExtremeCapsPreserveExistingResults() {
        for value in ["🇦🇧🇨🇩🇪 tail", "a\u{301}\u{301} b", "👩🏽‍👩‍👦 tail", "\r\nend"] {
            for index in value.unicodeScalars.indices {
                let substring = value[index...]
                for cap in [Int.min, -1, 0, 1, 2, 3, 4, 7, 12, 25, Int.max] {
                    XCTAssertEqual(BoundedDiagnosticText.prefix(substring, maximumBytes: cap),
                                   reference(substring, bytes: cap))
                }
            }
        }
    }

    func testSmallestKeysMatchesFilteredSortRegardlessOfInputOrder() {
        let keys = (0..<20_000).map { String(format: "key%05d", $0) }
            + ["", "é", String(repeating: "a", count: 65)]
        let expected = Array(keys.filter { $0.utf8.count <= 64 }.sorted().prefix(32))
        for input in [keys, Array(keys.reversed()), Array(keys.dropFirst(17)) + keys.prefix(17)] {
            XCTAssertEqual(BoundedDiagnosticText.smallestKeys(input, limit: 32, maximumBytes: 64), expected)
        }
        XCTAssertEqual(BoundedDiagnosticText.smallestKeys(keys, limit: 0, maximumBytes: 64), [])
        XCTAssertEqual(Set(BoundedDiagnosticText.smallestKeys(["z", "a", "too long"], limit: 3, maximumBytes: 1)), ["a", "z"])
    }

    func testPrefixPreservesGraphemesAndExactFits() {
        for value in ["", "plain ascii", "é😀e\u{0301}👨‍👩‍👧‍👦tail"] {
            for cap in 0...40 {
                var expected = value
                if value.utf8.count > cap {
                    expected = ""
                    if cap >= 3 {
                        for character in value {
                            let next = expected + String(character)
                            if next.utf8.count > cap - 3 { break }
                            expected = next
                        }
                        expected += "…"
                    }
                }
                XCTAssertEqual(BoundedDiagnosticText.prefix(value, maximumBytes: cap), expected)
                let surrounded = "[" + value + "]"
                XCTAssertEqual(BoundedDiagnosticText.prefix(surrounded.dropFirst().dropLast(), maximumBytes: cap), expected)
            }
        }
    }

    func testOversizedSingleGraphemeDoesNotProduceAnOversizedPrefix() {
        let value = "a" + String(repeating: "\u{0301}", count: 100_000)
        XCTAssertEqual(value.count, 1)
        XCTAssertEqual(BoundedDiagnosticText.prefix(value, maximumBytes: 480), "…")
    }
}
