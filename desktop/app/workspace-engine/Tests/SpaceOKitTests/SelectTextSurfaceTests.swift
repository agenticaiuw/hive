import XCTest
@testable import SpaceOKit
@testable import SpaceOMCP

/// The agent-facing surface for semantic text selection.
///
/// Selection exists because VS Code-family renderers drop synthetic drags: `spaceo_drag` returns
/// without selecting anything. The tool is only worth having if an agent can actually reach it,
/// which is why the lease registration below is a test rather than a convention — a mutating
/// command missing from `ownerScopedMutations` is refused by the daemon with a lease error the
/// client has no way to satisfy.
final class SelectTextSurfaceTests: XCTestCase {
    func testSelectIsOwnerScopedSoMCPAttachesItsLease() {
        XCTAssertTrue(
            DaemonCommand.ownerScopedMutations.contains("select"),
            "select mutates a session, so MCP must attach the lease or it is uncallable")
    }

    func testTheToolIsAdvertised() {
        let names = Set(MCPServer.toolSchemas.compactMap { $0["name"] as? String })
        XCTAssertTrue(names.contains("spaceo_select_text"))
    }

    func testCoordinatesChooseThePaneAndTheRangeComesFromLineAndCharacter() throws {
        let request = try MCPServer.toolRequest(
            name: "spaceo_select_text",
            arguments: [
                "x": 400, "y": 300,
                "anchor_line": 12, "anchor_character": 0,
                "active_line": 12, "active_character": 40,
            ])
        XCTAssertEqual(request.cmd, "select")
        XCTAssertEqual(request.x, 400)
        XCTAssertEqual(request.y, 300)
        XCTAssertEqual(request.anchorLine, 12)
        XCTAssertEqual(request.anchorCharacter, 0)
        XCTAssertEqual(request.activeLine, 12)
        XCTAssertEqual(request.activeCharacter, 40)
    }

    func testAMissingRangeIsRefusedRatherThanDefaulted() {
        XCTAssertThrowsError(
            try MCPServer.toolRequest(
                name: "spaceo_select_text",
                arguments: ["x": 400, "y": 300, "anchor_line": 1, "anchor_character": 0]),
            "a half-specified range must not silently become a cursor placement")
    }

    func testAMissingPointIsRefused() {
        XCTAssertThrowsError(
            try MCPServer.toolRequest(
                name: "spaceo_select_text",
                arguments: [
                    "anchor_line": 1, "anchor_character": 0,
                    "active_line": 1, "active_character": 4,
                ]),
            "without a point there is no way to tell which editor pane was meant")
    }

    func testNegativePositionsAreRefused() {
        XCTAssertThrowsError(
            try MCPServer.toolRequest(
                name: "spaceo_select_text",
                arguments: [
                    "x": 400, "y": 300,
                    "anchor_line": -1, "anchor_character": 0,
                    "active_line": 1, "active_character": 4,
                ]))
    }

    func testUnknownArgumentsAreRefused() {
        XCTAssertThrowsError(
            try MCPServer.toolRequest(
                name: "spaceo_select_text",
                arguments: [
                    "x": 400, "y": 300,
                    "anchor_line": 1, "anchor_character": 0,
                    "active_line": 1, "active_character": 4,
                    "web": true,
                ]),
            "select has no web form; accepting the flag would silently ignore it")
    }
}
