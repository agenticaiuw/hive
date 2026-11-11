import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOViewer

/// The session-tile overlay is drawn *and* clicked through the same rects, so a placement error
/// silently moves the click target too. These pin the rects against the mapping the renderer
/// uses, and pin the SwiftUI placement rule the view body depends on.
final class SessionOverlayLayoutTests: XCTestCase {

    // A 4K stage split into four 1080p tiles — the arrangement the viewer shows by default.
    private let stage = CGRect(x: 0, y: 0, width: 3840, height: 2160)

    private func fourTiles() throws -> [SessionInfo] {
        try [
            (0, CGRect(x: 0, y: 0, width: 1920, height: 1080)),
            (1, CGRect(x: 1920, y: 0, width: 1920, height: 1080)),
            (2, CGRect(x: 0, y: 1080, width: 1920, height: 1080)),
            (3, CGRect(x: 1920, y: 1080, width: 1920, height: 1080)),
        ].map { try session(index: $0.0, frame: $0.1) }
    }

    private func session(index: Int, frame: CGRect) throws -> SessionInfo {
        let json = """
        {
          "id": "tile-\(index)",
          "displayID": 7,
          "x": \(frame.minX), "y": \(frame.minY),
          "width": \(frame.width), "height": \(frame.height),
          "tileIndex": \(index),
          "tileCapacity": 4,
          "exclusiveDisplay": false,
          "spaces": [],
          "hasOwnSpace": false,
          "apps": [],
          "windows": [],
          "createdAt": "2026-07-28T00:00:00Z",
          "teardownPending": false
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    /// SwiftUI resolves `.position(p)` by centering the child on `p` in the container's own
    /// coordinate space, independent of the container's alignment. Modeling the rule here is what
    /// makes these assertions about the *rendered* frame rather than about the input rect.
    private func renderedOrigin(size: CGSize, position: CGPoint) -> CGPoint {
        CGPoint(x: position.x - size.width / 2, y: position.y - size.height / 2)
    }

    /// `.offset` by contrast starts from wherever alignment already put the child — the bug this
    /// suite exists for. A centered `ZStack` resolves it to this.
    private func centerAlignedOffsetOrigin(
        console: CGSize,
        size: CGSize,
        offset: CGPoint
    ) -> CGPoint {
        CGPoint(x: (console.width - size.width) / 2 + offset.x,
                y: (console.height - size.height) / 2 + offset.y)
    }

    // MARK: - Placement

    func testTilesRenderAtTheirViewRectOriginOnANonSquareConsole() throws {
        let console = CGSize(width: 800, height: 450)
        let mapping = MirrorInput.ViewportMapping(displayBounds: stage, viewSize: console)
        let tiles = SessionOverlayLayout.tiles(
            for: try fourTiles(),
            displayBounds: stage,
            viewSize: console
        )

        XCTAssertEqual(tiles.count, 4)
        for tile in tiles {
            let expected = try XCTUnwrap(mapping.viewRect(fromGlobalRect: CGRect(
                x: tile.session.x, y: tile.session.y,
                width: tile.session.width, height: tile.session.height)))
            XCTAssertEqual(tile.frame, expected, "tile \(tile.session.id) rect drifted")
            XCTAssertEqual(
                renderedOrigin(size: tile.frame.size, position: tile.center),
                expected.origin,
                "tile \(tile.session.id) does not render at its own pixels")
        }

        // The exact numbers, so a mapping change cannot quietly redefine "correct".
        XCTAssertEqual(tiles[0].frame, CGRect(x: 0, y: 0, width: 400, height: 225))
        XCTAssertEqual(tiles[1].frame, CGRect(x: 400, y: 0, width: 400, height: 225))
        XCTAssertEqual(tiles[2].frame, CGRect(x: 0, y: 225, width: 400, height: 225))
        XCTAssertEqual(tiles[3].frame, CGRect(x: 400, y: 225, width: 400, height: 225))

        // Every tile stays inside the console: under the old `.offset` the right-hand column ran
        // off the edge and was clipped away.
        for tile in tiles {
            XCTAssertTrue(CGRect(origin: .zero, size: console).contains(tile.frame),
                          "tile \(tile.session.id) escapes the console")
        }
    }

    func testTilesFollowTheLetterboxWhenTheConsoleAspectDiffers() throws {
        // 16:9 stage in a 4:3 console: 800x450 of content, centered, with 75pt bars.
        let console = CGSize(width: 800, height: 600)
        let tiles = SessionOverlayLayout.tiles(
            for: try fourTiles(),
            displayBounds: stage,
            viewSize: console
        )

        XCTAssertEqual(tiles[0].frame, CGRect(x: 0, y: 75, width: 400, height: 225))
        XCTAssertEqual(tiles[3].frame, CGRect(x: 400, y: 300, width: 400, height: 225))
        for tile in tiles {
            XCTAssertEqual(renderedOrigin(size: tile.frame.size, position: tile.center),
                           tile.frame.origin)
        }
    }

    func testTilesTrackZoomAndPan() throws {
        let console = CGSize(width: 800, height: 450)
        let zoom: CGFloat = 2
        let pan = CGPoint(x: -1, y: -1)
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: stage, viewSize: console, zoom: zoom, pan: pan)
        let tiles = SessionOverlayLayout.tiles(
            for: try fourTiles(),
            displayBounds: stage,
            viewSize: console,
            zoom: zoom,
            pan: pan
        )

        // Panned hard to the top-left, tile 0 fills the console at 2x.
        XCTAssertEqual(tiles[0].frame, CGRect(x: 0, y: 0, width: 800, height: 450))
        for tile in tiles {
            let expected = try XCTUnwrap(mapping.viewRect(fromGlobalRect: CGRect(
                x: tile.session.x, y: tile.session.y,
                width: tile.session.width, height: tile.session.height)))
            XCTAssertEqual(tile.frame, expected,
                           "tile \(tile.session.id) ignores the viewport transform")
        }
    }

    func testDegenerateConsoleYieldsNoTiles() throws {
        XCTAssertTrue(SessionOverlayLayout.tiles(
            for: try fourTiles(), displayBounds: stage, viewSize: .zero).isEmpty)
        XCTAssertTrue(SessionOverlayLayout.tiles(
            for: try fourTiles(),
            displayBounds: CGRect(x: 0, y: 0, width: 0, height: 0),
            viewSize: CGSize(width: 800, height: 450)).isEmpty)
    }

    // MARK: - Click targets

    func testAClickOnATilesPixelsSelectsThatSession() throws {
        let console = CGSize(width: 800, height: 450)
        let mapping = MirrorInput.ViewportMapping(displayBounds: stage, viewSize: console)
        let tiles = SessionOverlayLayout.tiles(
            for: try fourTiles(),
            displayBounds: stage,
            viewSize: console
        )

        // Probe each tile's own pixels, derived from the mapping rather than from the layout, so
        // the two have to agree. A button's hit region is its rendered frame.
        for expected in tiles {
            let pixels = try XCTUnwrap(mapping.viewRect(fromGlobalRect: CGRect(
                x: expected.session.x, y: expected.session.y,
                width: expected.session.width, height: expected.session.height)))
            let probes = [
                CGPoint(x: pixels.midX, y: pixels.midY),
                CGPoint(x: pixels.minX + 1, y: pixels.minY + 1),
                CGPoint(x: pixels.maxX - 1, y: pixels.maxY - 1),
            ]
            for probe in probes {
                let hits = tiles.filter { $0.frame.contains(probe) }
                XCTAssertEqual(hits.count, 1, "\(probe) is ambiguous between tiles")
                XCTAssertEqual(hits.first?.session.id, expected.session.id,
                               "\(probe) selects the wrong session")
            }
        }

        // The console center belongs to the bottom-right tile. The old placement centered tile 0's
        // 400x225 button on the console, so this click — and every click in the lower-right
        // quadrant of tile 0's own pixels — selected tile 0 from the wrong pixels.
        let consoleCenter = CGPoint(x: console.width / 2, y: console.height / 2)
        XCTAssertEqual(
            tiles.first(where: { $0.frame.contains(consoleCenter) })?.session.id, "tile-3")
        let strayTile0 = CGRect(
            origin: centerAlignedOffsetOrigin(console: console,
                                              size: tiles[0].frame.size,
                                              offset: tiles[0].frame.origin),
            size: tiles[0].frame.size)
        XCTAssertTrue(strayTile0.contains(consoleCenter),
                      "the misplacement this suite guards against no longer covers the center")
    }

    func testOverlayYieldsClicksToTheDisplayDuringInputCapture() {
        XCTAssertTrue(SessionOverlayLayout.acceptsClicks(interactionEnabled: false))
        XCTAssertFalse(SessionOverlayLayout.acceptsClicks(interactionEnabled: true),
                       "captured input belongs to the agent's display, not to the tile buttons")
    }

    // MARK: - The view body
    //
    // Correct rects only reach the screen if the body places them absolutely and honours the
    // capture. SwiftUI layout is not reachable from a headless test, so the wiring is pinned at
    // the source — it is two lines, and getting either wrong is exactly the bug above.

    func testSessionOverlayPlacesTilesAbsolutelyAndHonoursCapture() throws {
        let body = try sessionOverlayBody()
        XCTAssertTrue(
            body.contains(".position(tile.center)"),
            "sessionOverlay must place tiles with .position; see SessionOverlayLayout.Tile.center")
        XCTAssertFalse(
            body.contains(".offset("),
            """
            sessionOverlay offsets a tile. .offset is relative to the console ZStack's center \
            alignment, so tile rects — which are top-left-origin — land half a console away from \
            their own pixels, taking the click target with them. Use .position(tile.center).
            """)
        XCTAssertTrue(
            body.contains("SessionOverlayLayout.acceptsClicks("),
            "the tile buttons must stop taking clicks while input is captured")
    }

    /// `sessionOverlay(for:in:)` as written, read from the checkout these tests were built from.
    private func sessionOverlayBody() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SpaceOKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // repo root
        let source = root.appendingPathComponent("Sources/SpaceOViewer/ContentView.swift")
        let lines = try String(contentsOf: source, encoding: .utf8)
            .components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: {
            $0.contains("private func sessionOverlay(")
        }) else {
            XCTFail("sessionOverlay(for:in:) is gone from \(source.path) — was it renamed?")
            return ""
        }
        // Member bodies close on a `}` at member indentation; nested braces are deeper.
        guard let end = lines[start...].firstIndex(of: "    }") else {
            XCTFail("could not find the end of sessionOverlay(for:in:)")
            return ""
        }
        return lines[start...end].joined(separator: "\n")
    }
}
