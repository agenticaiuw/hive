import Foundation
import XCTest
@testable import SpaceOMCP

final class MCPPromptTests: XCTestCase {
    private func text(_ result: [String: Any]) throws -> String {
        let messages = try XCTUnwrap(result["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?["role"] as? String, "user")
        let content = try XCTUnwrap(messages.first?["content"] as? [String: Any])
        XCTAssertEqual(content["type"] as? String, "text")
        return try XCTUnwrap(content["text"] as? String)
    }

    func testEveryPromptPreservesValidArgumentAndDocumentContent() throws {
        for prompt in Playbook.prompts {
            let argument = try XCTUnwrap(prompt.arguments.first)
            let document = try XCTUnwrap(Playbook.documents.first { $0.name == prompt.documentName })
            for value in ["", "synthetic é😀", "line one\nline two"] {
                let result = try MCPServer.promptResult(["name": prompt.name, "arguments": [argument.name: value]])
                XCTAssertEqual(result["description"] as? String, prompt.description)
                XCTAssertEqual(try text(result), "\(argument.name): \(value)\n\n" + document.markdown)
            }
            let description = MCPServer.promptArgumentDescription(argument.description)
            XCTAssertTrue(description.contains("4096 characters"))
            XCTAssertTrue(description.contains("16384 UTF-8 bytes"))
        }
    }

    func testIndependentCharacterAndByteLimitsWithExactUnicodeBoundaries() throws {
        let atByteLimit = "ab" + String(repeating: "\u{301}", count: 8_191)
        XCTAssertEqual(atByteLimit.utf8.count, 16_384)
        let accepted = [String(repeating: "a", count: 4_096), String(repeating: "😀", count: 4_096), atByteLimit]
        for value in accepted {
            let result = try MCPServer.promptResult(["name": "drive-app", "arguments": ["app": value]])
            XCTAssertTrue(try text(result).hasPrefix("app: " + value + "\n\n"))
        }
        for value in [String(repeating: "a", count: 4_097), String(repeating: "😀", count: 4_097),
                      atByteLimit + "x", "a" + String(repeating: "\u{301}", count: 250_000)] {
            XCTAssertThrowsError(try MCPServer.promptResult(["name": "drive-app", "arguments": ["app": value]])) {
                XCTAssertTrue(String(describing: $0).contains("4096 characters and 16384 UTF-8 bytes"))
                XCTAssertLessThan(String(describing: $0).utf8.count, 160)
            }
        }
    }

    func testMalformedShapesAreExplainedInsteadOfBecomingMissingArguments() {
        for supplied: Any in [[], "text", 4, NSNull()] {
            XCTAssertThrowsError(try MCPServer.promptResult(["name": "drive-app", "arguments": supplied])) {
                XCTAssertEqual(String(describing: $0), "prompt arguments must be an object")
            }
        }
        for supplied: Any in [[], 4, NSNull()] {
            XCTAssertThrowsError(try MCPServer.promptResult(["name": "drive-app", "arguments": ["app": supplied]])) {
                XCTAssertEqual(String(describing: $0), "prompt argument 'app' must be a string")
            }
        }
        XCTAssertThrowsError(try MCPServer.promptResult(["name": "drive-app"])) {
            XCTAssertEqual(String(describing: $0), "prompt 'drive-app' needs argument 'app'")
        }
    }

    func testUnexpectedFieldsAreRefusedWithBoundedDiagnosticsAndRecovery() throws {
        var arguments: [String: Any] = ["app": "synthetic"]
        for index in 0..<1_000 { arguments["extra_\(index)"] = NSNull() }
        XCTAssertThrowsError(try MCPServer.promptResult(["name": "drive-app", "arguments": arguments])) {
            XCTAssertTrue(String(describing: $0).contains("and 992 more"))
            XCTAssertLessThanOrEqual(String(describing: $0).utf8.count, 1_024)
        }
        XCTAssertThrowsError(try MCPServer.promptResult(["name": String(repeating: "x", count: 100_000)])) {
            XCTAssertEqual(String(describing: $0), "unknown prompt")
        }
        XCTAssertNoThrow(try MCPServer.promptResult(["name": "drive-app", "arguments": ["app": "synthetic"]]))
    }
}
