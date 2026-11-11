import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

/// Whether an MCP agent can finish the screenshot-pixel-to-click conversion using only what the
/// MCP surface actually emits.
///
/// The conversion is `pixel / scale + originX - windowX`. The screenshot result carries the
/// `originX` term in its image geometry; the `windowX` term exists nowhere but the window lines
/// `spaceo_list_windows` and `spaceo_session_list` print. Those lines used to render size and
/// title only, so an agent holding a correct formula and a correct geometry block still could not
/// evaluate it, and fell back to clicking raw pixels — off target by the window's inset inside its
/// tile, which `WindowPlacement.defaultFrame` makes at least 40 points.
///
/// Pure logic only — nothing here touches the WindowServer.
final class WindowOriginOverMCPTests: XCTestCase {

    /// Read an origin back out of a rendered window line the way an agent reading the text would.
    /// Returns nil when the line carries no origin at all, which is the regression under test.
    private func parseOrigin(windowID: UInt32, in rendered: String) -> CGPoint? {
        guard let line = rendered
            .split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { $0.contains("window \(windowID) ") }) else { return nil }
        guard let match = line.firstMatch(of: #/ at \((-?\d+),(-?\d+)\)/#),
              let x = Double(match.1), let y = Double(match.2) else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// Build a `WindowInfo` the way the MCP process really gets one: decoded off the wire. The
    /// struct's only initializer needs a live `AgentSession`, and going through `Wire` also proves
    /// the fields survive the daemon-to-MCP hop rather than being invented in the test.
    private func decodeWindow(
        windowID: UInt32,
        frame: CGRect,
        title: String,
        onStage: Bool = true
    ) throws -> WindowInfo {
        let json: [String: Any] = [
            "windowID": windowID, "pid": 900, "title": title,
            "x": frame.minX, "y": frame.minY,
            "width": frame.width, "height": frame.height,
            "onStage": onStage, "spaces": [1],
        ]
        return try Wire.decoder.decode(
            WindowInfo.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// The whole point: take a pixel off a tile screenshot, take the origin off `list_windows`,
    /// and land the click on the pixel the agent actually saw.
    func testListWindowsCarriesTheOriginTheClickFormulaNeeds() throws {
        // Virtual stage at global x=1512, the window inset inside it — the reported shape.
        let tile = CGRect(x: 1_512, y: 0, width: 1_440, height: 900)
        let windowFrame = CGRect(x: 1_552, y: 40, width: 1_360, height: 820)
        let window = WindowRef(windowID: 42, pid: 900, title: "Untitled", frame: windowFrame)

        var response = Response(ok: true)
        response.windows = [
            try decodeWindow(windowID: 42, frame: windowFrame, title: "Untitled"),
            // A display left of the main one puts a window at a negative origin; the rendered
            // form has to stay parseable there too, not just for positive coordinates.
            try decodeWindow(windowID: 43, frame: CGRect(x: -900, y: -120, width: 400, height: 300),
                             title: "Left Display", onStage: false),
        ]
        let rendered = MCPServer.render(response)

        guard let origin = parseOrigin(windowID: 42, in: rendered) else {
            return XCTFail("no window origin in list_windows output; the conversion is "
                           + "unevaluatable from MCP alone:\n\(rendered)")
        }
        XCTAssertEqual(origin, windowFrame.origin)
        XCTAssertEqual(parseOrigin(windowID: 43, in: rendered), CGPoint(x: -900, y: -120),
                       "a negative origin must render in a form an agent can read back")

        // Only MCP-visible numbers from here on: the capture geometry the screenshot result
        // reports, and the origin parsed out of the text above. The formula is evaluated the way
        // the instructions state it rather than through a helper, because what is under test is
        // whether an agent holding only MCP output has every term it needs.
        let geometry = ImageGeometry(
            origin: "tile", scale: 1, pixelWidth: Int(tile.width), pixelHeight: Int(tile.height),
            pointWidth: tile.width, pointHeight: tile.height,
            originX: tile.minX, originY: tile.minY)
        let click = CGPoint(x: 200 / geometry.scale + geometry.originX - origin.x,
                            y: 300 / geometry.scale + geometry.originY - origin.y)

        let global = try InputRouter.globalPoint(
            click, in: window, bounds: windowFrame, what: "click")
        XCTAssertEqual(global.x, tile.minX + 200, "the click must land on the pixel that was seen")
        XCTAssertEqual(global.y, tile.minY + 300)

        // Without the origin an agent can only click the raw pixel. Prove that is wrong rather
        // than assuming it: it lands a full window inset away from the intended point.
        let rawPixelClick = try InputRouter.globalPoint(
            CGPoint(x: 200, y: 300), in: window, bounds: windowFrame, what: "click")
        XCTAssertEqual(rawPixelClick.x - global.x, windowFrame.minX - tile.minX)
        XCTAssertNotEqual(rawPixelClick, global)
    }

    /// `session_list` renders its windows through the same function, and an agent that lists
    /// sessions rather than windows must not get a degraded view.
    func testSessionListWindowLinesCarryTheOriginToo() throws {
        let windowFrame = CGRect(x: 1_552, y: 40, width: 1_360, height: 820)
        let session: [String: Any] = [
            "id": "s1", "displayID": 7,
            "x": 1_512, "y": 0, "width": 1_440, "height": 900,
            "tileIndex": 0, "tileCapacity": 2, "exclusiveDisplay": false,
            "spaces": [1], "hasOwnSpace": true, "apps": [],
            "createdAt": "2026-01-01T00:00:00Z", "teardownPending": false,
            "windows": [[
                "windowID": 42, "pid": 900, "title": "Untitled",
                "x": windowFrame.minX, "y": windowFrame.minY,
                "width": windowFrame.width, "height": windowFrame.height,
                "onStage": true, "spaces": [1],
            ]],
        ]
        var response = Response(ok: true)
        response.sessions = [try Wire.decoder.decode(
            SessionInfo.self, from: JSONSerialization.data(withJSONObject: session))]

        let rendered = MCPServer.render(response)
        XCTAssertEqual(parseOrigin(windowID: 42, in: rendered), windowFrame.origin, rendered)
    }
}
