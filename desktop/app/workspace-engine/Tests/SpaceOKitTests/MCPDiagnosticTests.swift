import Foundation
import XCTest
@testable import SpaceOMCP

final class MCPDiagnosticTests: XCTestCase {
    func testOrdinaryTyposKeepSortedNamesAndAllowedKeysAreOmitted() {
        XCTAssertNil(MCPDiagnostic.unexpected(["session", "text"], allowed: ["session", "text"]))
        XCTAssertEqual(MCPDiagnostic.unexpected(["zeta", "session", "alpha"], allowed: ["session"]),
                       "unexpected argument(s): alpha, zeta")
        // Membership still uses Swift String equality, including canonical equivalence.
        XCTAssertNil(MCPDiagnostic.unexpected(["e\u{301}"], allowed: ["é"]))
    }

    func testManyKeysProduceADeterministicBoundedPreviewAndOmittedCount() throws {
        let keys = (0..<10_000).map { String(format: "extra_%05d", $0) }
        let diagnostic = try XCTUnwrap(MCPDiagnostic.unexpected(keys, allowed: []))
        XCTAssertEqual(diagnostic, MCPDiagnostic.unexpected(keys.reversed(), allowed: []))
        XCTAssertTrue(diagnostic.contains("extra_00000, extra_00001"))
        XCTAssertTrue(diagnostic.contains("extra_00007 (and 9992 more)"))
        XCTAssertFalse(diagnostic.contains("extra_00008"))
        XCTAssertLessThanOrEqual(diagnostic.utf8.count, 1_024)
    }

    func testUnicodeAndControlNamesCannotAmplifyOrForgeDiagnosticLines() {
        let names = ["a" + String(repeating: "\u{301}", count: 100_000),
                     String(repeating: "😀", count: 100_000),
                     "\n\r\t\0\u{202E}\u{2028}tail", "a,b\\c", ""]
        for name in names {
            let rendered = MCPDiagnostic.name(name)
            XCTAssertLessThanOrEqual(rendered.utf8.count, MCPDiagnostic.maximumNameBytes)
            XCTAssertFalse(rendered.unicodeScalars.contains {
                [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory)
            })
            XCTAssertNotNil(String(data: Data(rendered.utf8), encoding: .utf8))
        }
        XCTAssertEqual(MCPDiagnostic.name("a,b\\c"), "a\\,b\\\\c")
        XCTAssertEqual(MCPDiagnostic.name(""), "\"\"")
        XCTAssertTrue(MCPDiagnostic.name(names[0]).hasSuffix("..."))
        XCTAssertTrue(MCPDiagnostic.name(names[2]).contains("\\u{202E}"))
    }

    func testLogPreviewBoundsBytesEvenForOneHugeGraphemeAndManyNewlines() {
        for value in ["a" + String(repeating: "\u{301}", count: 100_000),
                      String(repeating: "\n", count: 100_000), String(repeating: "😀", count: 10_000)] {
            let preview = MCPDiagnostic.preview(value)
            XCTAssertLessThanOrEqual(preview.utf8.count, 600)
            XCTAssertTrue(preview.hasSuffix("..."))
            XCTAssertFalse(preview.contains("\n"))
        }
        XCTAssertEqual(MCPDiagnostic.preview("ordinary error, with details"), "ordinary error, with details")
        for cap in [-1, 0, 1, 2] { XCTAssertEqual(MCPDiagnostic.preview("text", maximumBytes: cap), "") }
    }

    func testTranslatorRejectsLargeNamesAndDictionariesWithSmallErrors() throws {
        let arguments = Dictionary(uniqueKeysWithValues: (0..<10_000).map { ("extra_\($0)", NSNull()) })
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_list", arguments: arguments)) { error in
            XCTAssertLessThanOrEqual(String(describing: error).utf8.count, 1_024)
            XCTAssertTrue(String(describing: error).contains("and 9992 more"))
        }
        let name = "a" + String(repeating: "\u{301}", count: 100_000)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: name, arguments: [:])) { error in
            XCTAssertLessThan(String(describing: error).utf8.count, 128)
            XCTAssertTrue(String(describing: error).hasPrefix("unknown tool '"))
        }
        XCTAssertNoThrow(try MCPServer.toolRequest(name: "spaceo_session_list", arguments: [:]))
    }
}
