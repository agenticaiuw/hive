import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOMCP

final class StringAdmissionTests: XCTestCase {
    func testTypingAdmissionPreservesCharacterScalarAndByteBoundaries() async {
        let inputs = ["", String(repeating: "a", count: 8_000), String(repeating: "a", count: 8_001),
                      String(repeating: "😀", count: 8_000), String(repeating: "😀", count: 8_001),
                      String(repeating: "e\u{301}", count: 4_000), String(repeating: "e\u{301}", count: 4_001),
                      String(repeating: "👨‍👩‍👧‍👦", count: 1_142), String(repeating: "👨‍👩‍👧‍👦", count: 1_143),
                      "a" + String(repeating: "\u{301}", count: 16_000)]
        let manager = SessionManager()
        let bridge = ChromiumBridge(port: 1) // Unattached: no endpoint discovery or input occurs.
        for text in inputs {
            let previouslyAccepted = text.count <= 8_000 && text.unicodeScalars.count <= 8_000
                && text.utf8.count <= 32_000
            do {
                let parsed = try MCPServer.toolRequest(name: "spaceo_type", arguments: ["text": text, "web": true])
                XCTAssertTrue(previouslyAccepted)
                XCTAssertEqual(parsed.text, text)
            } catch { XCTAssertFalse(previouslyAccepted, "valid boundary rejected: \(error)") }

            var request = Request(cmd: "type")
            request.text = text
            request.web = true
            request.session = "absent-input-test"
            let response = await manager.handle(request)
            XCTAssertFalse(response.ok, "no real session or input route exists in this fixture")
            XCTAssertEqual(response.error?.contains("text is too long") == true, !previouslyAccepted)

            do {
                try await bridge.type(text)
                XCTFail("an unattached bridge cannot deliver typing")
            } catch {
                XCTAssertEqual(String(describing: error).contains("text is too long"), !previouslyAccepted)
                if previouslyAccepted {
                    XCTAssertTrue(String(describing: error).contains("not attached"))
                }
            }
        }
    }

    func testMCPPathsPreserveIndependentCharacterAndByteLimits() {
        for value in [String(repeating: "a", count: 4_096), String(repeating: "a", count: 4_097),
                      String(repeating: "😀", count: 4_096), String(repeating: "😀", count: 4_097),
                      "a" + String(repeating: "\u{301}", count: 10_000)] {
            let accepted = value.count <= 4_096 && value.utf8.count <= 16_384
            for arguments: [String: Any] in [["app": value], ["app": "synthetic", "files": [value]]] {
                do {
                    _ = try MCPServer.toolRequest(name: "spaceo_open_app", arguments: arguments)
                    XCTAssertTrue(accepted)
                } catch { XCTAssertFalse(accepted) }
            }
        }
    }
}
