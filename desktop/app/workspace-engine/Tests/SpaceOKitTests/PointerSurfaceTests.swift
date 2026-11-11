import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

/// The agent-facing pointer surface: which actions exist, what they refuse, and whether a
/// coordinate read off a screenshot is a coordinate a click accepts.
///
/// Pure logic only — nothing here touches the WindowServer.
final class PointerSurfaceTests: XCTestCase {

    // MARK: - Buttons and modifiers

    func testEveryMouseButtonMapsToItsOwnEventTypes() {
        // A middle click used to be unrepresentable, so an agent could not open a link in a new
        // tab or close one from a tab strip.
        XCTAssertEqual(MouseButton.middle.downType, .otherMouseDown)
        XCTAssertEqual(MouseButton.middle.upType, .otherMouseUp)
        XCTAssertEqual(MouseButton.middle.draggedType, .otherMouseDragged)
        XCTAssertEqual(MouseButton.middle.cgButton, .center)

        let downTypes = Set(MouseButton.allCases.map(\.downType))
        XCTAssertEqual(downTypes.count, MouseButton.allCases.count,
                       "two buttons sharing a down event would silently press the wrong one")
    }

    func testButtonParsingDefaultsToLeftAndRejectsUnknownNames() throws {
        XCTAssertEqual(try MouseButton.parse(nil), .left)
        XCTAssertEqual(try MouseButton.parse(""), .left)
        XCTAssertEqual(try MouseButton.parse("RIGHT"), .right)
        XCTAssertEqual(try MouseButton.parse("middle"), .middle)
        XCTAssertThrowsError(try MouseButton.parse("sideways"))
    }

    func testModifierParsingAcceptsAliasesAndRejectsUnknownNames() throws {
        XCTAssertEqual(try ModifierKeys.parse(nil), [])
        XCTAssertEqual(try ModifierKeys.parse([]), [])
        XCTAssertEqual(try ModifierKeys.parse(["cmd"]), .maskCommand)
        XCTAssertEqual(try ModifierKeys.parse(["command"]), .maskCommand)
        XCTAssertEqual(try ModifierKeys.parse(["opt"]), .maskAlternate)
        XCTAssertEqual(try ModifierKeys.parse(["shift", "ctrl"]),
                       [.maskShift, .maskControl])
        XCTAssertThrowsError(try ModifierKeys.parse(["hyper"]))
        XCTAssertThrowsError(
            try ModifierKeys.parse(["cmd", "shift", "alt", "ctrl", "fn", "cmd"]),
            "an unbounded modifier list is a free allocation from a caller-supplied array")
    }

    // MARK: - Coordinate space

    func testCaptureScaleIsOnePointPerPixelUnlessAsked() throws {
        // The default has to make an image pixel and a click coordinate the same number. While
        // window captures were hard-coded to 2x and tile captures to 1x, an agent reading a
        // coordinate off the default screenshot clicked at half the intended position, and no
        // field in the response let it discover the difference.
        XCTAssertEqual(try Capture.validatedScale(nil), 1)
        XCTAssertEqual(try Capture.validatedScale(2), 2)
        XCTAssertThrowsError(try Capture.validatedScale(0))
        XCTAssertThrowsError(try Capture.validatedScale(5))
    }

    func testImageGeometryTellsTheAgentHowToConvertPixelsToClicks() {
        let oneToOne = ImageGeometry(
            origin: "window", scale: 1, pixelWidth: 800, pixelHeight: 600,
            pointWidth: 800, pointHeight: 600, originX: 100, originY: 40, windowID: 7)
        XCTAssertTrue(oneToOne.advice.contains("directly"),
                      "a 1x window capture needs no conversion and should say so")

        let retina = ImageGeometry(
            origin: "window", scale: 2, pixelWidth: 1_600, pixelHeight: 1_200,
            pointWidth: 800, pointHeight: 600, originX: 100, originY: 40, windowID: 7)
        XCTAssertTrue(retina.advice.contains("Divide"))
        XCTAssertTrue(retina.advice.contains("2"))

        // A tile capture is not window-relative, so its advice has to state both terms of the
        // conversion. The old text said only "subtract the window's origin", which is the
        // window-capture formula: applied to a tile it lands a whole tile away from the window.
        let tile = ImageGeometry(
            origin: "tile", scale: 1, pixelWidth: 1_440, pixelHeight: 900,
            pointWidth: 1_440, pointHeight: 900, originX: 1_920, originY: 0)
        XCTAssertTrue(tile.advice.contains("+ 1920 - windowX"),
                      "advice must name the capture origin term, not just the window one: "
                          + tile.advice)
        XCTAssertTrue(tile.advice.contains("+ 0 - windowY"), tile.advice)
        XCTAssertNil(tile.windowID)

        let zoomed = ImageGeometry(
            origin: "tile", scale: 2, pixelWidth: 800, pixelHeight: 600,
            pointWidth: 400, pointHeight: 300, originX: 2_020, originY: 50)
        XCTAssertTrue(zoomed.advice.contains("pixel_x / 2 + 2020 - windowX"), zoomed.advice)

        // A negative origin has to read as a subtraction rather than "+ -1920".
        let leftOfMain = ImageGeometry(
            origin: "tile", scale: 1, pixelWidth: 100, pixelHeight: 100,
            pointWidth: 100, pointHeight: 100, originX: -1_920, originY: 0)
        XCTAssertTrue(leftOfMain.advice.contains("pixel_x - 1920 - windowX"), leftOfMain.advice)
    }

    /// The whole point of the geometry: a coordinate read off a tile screenshot has to be a
    /// coordinate `click` accepts, and it has to land on the pixel the agent actually saw.
    func testTileScreenshotCoordinateConvertsToAClickThatLandsOnThatPixel() throws {
        // The reported failure: virtual stage at global x=1512, TextEdit placed just inside it.
        let tile = CGRect(x: 1_512, y: 0, width: 1_440, height: 900)
        let windowFrame = CGRect(x: 1_522, y: 10, width: 800, height: 600)
        let window = WindowRef(windowID: 11, pid: 900, title: "TextEdit", frame: windowFrame)
        let geometry = ImageGeometry(
            origin: "tile", scale: 1, pixelWidth: Int(tile.width), pixelHeight: Int(tile.height),
            pointWidth: tile.width, pointHeight: tile.height,
            originX: tile.minX, originY: tile.minY)

        let click = geometry.clickPoint(
            pixelX: 200, pixelY: 300, windowX: windowFrame.minX, windowY: windowFrame.minY)
        XCTAssertEqual(click.x, 190)
        XCTAssertEqual(click.y, 290)

        // `click` accepts it, and the global point it resolves to is exactly where that pixel
        // sits on screen — tile origin plus the pixel offset.
        let global = try InputRouter.globalPoint(
            click, in: window, bounds: windowFrame, what: "click")
        XCTAssertEqual(global.x, tile.minX + 200)
        XCTAssertEqual(global.y, tile.minY + 300)

        // Dropping the origin term is the bug this test exists to catch: it produces a negative
        // coordinate that `click` refuses outright.
        XCTAssertThrowsError(
            try InputRouter.globalPoint(
                CGPoint(x: 200 - windowFrame.minX, y: 300 - windowFrame.minY),
                in: window, bounds: windowFrame, what: "click"),
            "pixel - windowX is the formula the old advice described; it must not be the one "
                + "that works, or this test proves nothing")
    }

    func testZoomedRegionCoordinateConvertsFromTheSubRegionOrigin() throws {
        // After a subRect, pixel (0,0) is the sub-region's origin — not the tile's. Capture
        // reports the sub-region's global origin, so the one formula still holds.
        let tile = CGRect(x: 1_512, y: 0, width: 1_440, height: 900)
        let subRect = CGRect(x: 100, y: 50, width: 400, height: 300)
        let captured = CGRect(x: tile.minX + subRect.minX, y: tile.minY + subRect.minY,
                              width: subRect.width, height: subRect.height)
        let windowFrame = CGRect(x: 1_522, y: 10, width: 800, height: 600)
        let window = WindowRef(windowID: 12, pid: 901, title: "TextEdit", frame: windowFrame)

        // scale 2, so the pixel-to-point divide is exercised alongside the origin term.
        let geometry = ImageGeometry(
            origin: "tile", scale: 2, pixelWidth: 800, pixelHeight: 600,
            pointWidth: captured.width, pointHeight: captured.height,
            originX: captured.minX, originY: captured.minY)

        let click = geometry.clickPoint(
            pixelX: 20, pixelY: 40, windowX: windowFrame.minX, windowY: windowFrame.minY)
        XCTAssertEqual(click.x, 10 + captured.minX - windowFrame.minX)
        XCTAssertEqual(click.y, 20 + captured.minY - windowFrame.minY)

        let global = try InputRouter.globalPoint(
            click, in: window, bounds: windowFrame, what: "click")
        XCTAssertEqual(global.x, captured.minX + 10)
        XCTAssertEqual(global.y, captured.minY + 20)
    }

    func testWindowCaptureConversionCancelsToPlainPixelsOverScale() {
        // Same formula, both capture kinds: for a window capture the two origins are the same
        // window, so the origin terms cancel and only the scale divide survives.
        let windowFrame = CGRect(x: 1_522, y: 10, width: 800, height: 600)
        let geometry = ImageGeometry(
            origin: "window", scale: 2, pixelWidth: 1_600, pixelHeight: 1_200,
            pointWidth: windowFrame.width, pointHeight: windowFrame.height,
            originX: windowFrame.minX, originY: windowFrame.minY, windowID: 13)

        let click = geometry.clickPoint(
            pixelX: 400, pixelY: 200, windowX: windowFrame.minX, windowY: windowFrame.minY)
        XCTAssertEqual(click.x, 200)
        XCTAssertEqual(click.y, 100)
    }

    func testScreenshotOverMCPCarriesTheGeometryTheClickFormulaNeeds() throws {
        // Prose is not machine-readable: without the structured geometry an MCP client has no
        // way to recover originX, and so no way to convert a tile pixel into a click at all.
        let geometry = ImageGeometry(
            origin: "tile", scale: 1, pixelWidth: 1_440, pixelHeight: 900,
            pointWidth: 1_440, pointHeight: 900, originX: 1_512, originY: 0)
        let content = try MCPServer.screenshotContent(
            message: "captured tile 2/2\n  \(geometry.advice)",
            geometry: geometry,
            pngBase64: Data([137, 80, 78, 71, 13, 10, 26, 10]).base64EncodedString())

        let texts = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
        guard let json = texts.first(where: { $0.contains("\"originX\"") }) else {
            return XCTFail("no geometry block in \(texts)")
        }
        let payload = String(json.drop(while: { $0 != "{" }))
        let decoded = try JSONDecoder().decode(ImageGeometry.self, from: Data(payload.utf8))
        XCTAssertEqual(decoded, geometry, "the client must see the same numbers the daemon sent")

        XCTAssertEqual(content.last?["type"] as? String, "image",
                       "the image still has to be the last block the model sees")
    }

    func testScreenshotForwardingPreservesEncodingAndRejectsInvalidPayloads() throws {
        let signature = Data([137, 80, 78, 71, 13, 10, 26, 10])
        let valid = (signature + Data(repeating: 0xFF, count: 5 * 1_048_576 - 8)).base64EncodedString()
        let content = try MCPServer.screenshotContent(message: nil, geometry: nil, pngBase64: valid)
        XCTAssertEqual(content.last?["data"] as? String, valid)
        XCTAssertEqual(content.last?["mimeType"] as? String, "image/png")
        for invalid in [nil, "", "!!!!", signature.dropLast().base64EncodedString(),
                        Data("not a png".utf8).base64EncodedString(), valid + "\n",
                        (signature + Data(repeating: 0, count: 5 * 1_048_576 - 7)).base64EncodedString(),
                        String(repeating: "A", count: 7 * 1_048_576 + 1)] {
            XCTAssertThrowsError(try MCPServer.screenshotContent(message: nil, geometry: nil, pngBase64: invalid))
        }
    }

    func testImageGeometrySurvivesAWireRoundTrip() throws {
        let geometry = ImageGeometry(
            origin: "window", scale: 2, pixelWidth: 1_600, pixelHeight: 1_200,
            pointWidth: 800, pointHeight: 600, originX: 12, originY: 34, windowID: 99)
        var response = Response(ok: true)
        response.image = geometry

        let decoded = try Wire.decoder.decode(
            Response.self, from: Wire.encoder.encode(response))
        XCTAssertEqual(decoded.image, geometry,
                       "geometry that does not survive the socket cannot be acted on")
    }

    // MARK: - Point validation

    func testPointsOutsideTheWindowAreRefusedWithAScaleHint() {
        let window = WindowRef(windowID: 4, pid: 321, title: "t",
                               frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let bounds = CGRect(x: 100, y: 50, width: 400, height: 300)

        XCTAssertNoThrow(try InputRouter.globalPoint(
            CGPoint(x: 10, y: 20), in: window, bounds: bounds, what: "click"))

        // The out-of-bounds case is overwhelmingly a scale mistake, so the error says so rather
        // than leaving the agent to guess why a coordinate it just read was rejected.
        do {
            _ = try InputRouter.globalPoint(
                CGPoint(x: 780, y: 40), in: window, bounds: bounds, what: "click")
            XCTFail("a point beyond the window width must be refused")
        } catch {
            XCTAssertTrue("\(error)".contains("divide by 2"),
                          "unhelpful refusal: \(error)")
        }

        XCTAssertThrowsError(try InputRouter.globalPoint(
            CGPoint(x: Double.nan, y: 0), in: window, bounds: bounds, what: "click"))
    }

    func testGlobalPointTranslatesByTheWindowOrigin() throws {
        let window = WindowRef(windowID: 4, pid: 321, title: "t", frame: .zero)
        let point = try InputRouter.globalPoint(
            CGPoint(x: 10, y: 20),
            in: window,
            bounds: CGRect(x: 100, y: 50, width: 400, height: 300),
            what: "click")
        XCTAssertEqual(point, CGPoint(x: 110, y: 70))
    }

    // MARK: - MCP surface

    func testPointerToolsAreAdvertised() throws {
        let names = Set(MCPServer.toolSchemas.compactMap { $0["name"] as? String })
        // Without these an agent cannot reach below the fold, open a hover-only menu, or move a
        // slider — ordinary steps on ordinary UI, not edge cases.
        XCTAssertTrue(names.contains("spaceo_scroll"))
        XCTAssertTrue(names.contains("spaceo_move"))
        XCTAssertTrue(names.contains("spaceo_drag"))
    }

    func testScrollSchemaExplainsTheObservedGestureDirection() throws {
        let scroll = try XCTUnwrap(MCPServer.toolSchemas.first {
            $0["name"] as? String == "spaceo_scroll"
        })
        let description = try XCTUnwrap(scroll["description"] as? String)
        let schema = try XCTUnwrap(scroll["inputSchema"] as? [String: Any])
        let properties = try XCTUnwrap(schema["properties"] as? [String: Any])
        let dy = try XCTUnwrap(properties["dy"] as? [String: Any])
        let dx = try XCTUnwrap(properties["dx"] as? [String: Any])

        XCTAssertTrue(description.contains("negative dy moves the view down"))
        XCTAssertTrue(description.contains("negative dx moves the view right"))
        XCTAssertTrue((dy["description"] as? String)?.contains("-600 to page down") == true)
        XCTAssertTrue(
            (dx["description"] as? String)?.contains("-600 to reveal later columns") == true)
    }

    func testElementClickRefusesPointerOnlyArguments() throws {
        // An element index performs an accessibility press, which has no button, count, or
        // modifier state. Accepting those and pressing anyway reported success for an action
        // that never happened: the agent believed it had opened a context menu.
        for arguments in [
            ["element": "3", "button": "right"] as [String: Any],
            ["element": "3", "count": 2],
            ["element": "3", "modifiers": ["shift"]],
        ] {
            XCTAssertThrowsError(
                try MCPServer.toolRequest(name: "spaceo_click", arguments: arguments),
                "pointer-only argument silently dropped: \(arguments)")
        }

        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_click", arguments: ["element": "3"]))
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_click",
            arguments: ["x": 10, "y": 20, "button": "right", "modifiers": ["shift"]]))
    }

    func testScrollAndDragRequireTheArgumentsThatMakeThemMeaningful() throws {
        // An unpositioned scroll is a coin flip in any app with two scrollable regions.
        XCTAssertThrowsError(
            try MCPServer.toolRequest(name: "spaceo_scroll", arguments: ["dy": -600]))
        XCTAssertThrowsError(
            try MCPServer.toolRequest(name: "spaceo_scroll", arguments: ["x": 10, "y": 20]),
            "a scroll with no delta does nothing and should say so")
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_scroll", arguments: ["x": 10, "y": 20, "dy": -600]))

        XCTAssertThrowsError(
            try MCPServer.toolRequest(name: "spaceo_drag", arguments: ["x": 1, "y": 2]))
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_drag",
            arguments: ["x": 1, "y": 2, "to_x": 3, "to_y": 4]))
    }

    // MARK: - Scroll convention

    func testScrollDeltaKeepsBothAxesInSignParityAcrossEverySurface() throws {
        // The bug this pins: `dy` was negated on the way to DevTools and `dx` was not, so
        // `--dx 600` moved a native window's view left and a page's view right — both
        // reporting ok. Whatever a surface does to one axis it must do to the other.
        let gesture = try ScrollDelta(dx: 600, dy: 400, ticks: 1)

        // A scroll bar's value and a DOM wheel delta both count offset from the origin, so
        // both run opposite to the gesture, on both axes.
        XCTAssertEqual(gesture.axHorizontalPixels, -600)
        XCTAssertEqual(gesture.axVerticalPixels, -400)
        XCTAssertEqual(gesture.domDeltaX, -600)
        XCTAssertEqual(gesture.domDeltaY, -400)

        // CGEvent's wheel is already gesture-signed, on both axes.
        XCTAssertEqual(gesture.wheel2, 600)
        XCTAssertEqual(gesture.wheel1, 400)

        // Stated as the invariant rather than as fixed numbers, so a future change that flips
        // one axis for one surface and forgets the other fails here.
        for (dx, dy) in [(600, 400), (-600, 400), (600, -400), (-600, -400), (1, -1)] {
            let delta = try ScrollDelta(dx: Int32(dx), dy: Int32(dy), ticks: 1)
            XCTAssertEqual(
                Double(delta.axHorizontalPixels), delta.domDeltaX,
                "horizontal: the native scroll bar and DevTools disagree at dx=\(dx)")
            XCTAssertEqual(
                Double(delta.axVerticalPixels), delta.domDeltaY,
                "vertical: the native scroll bar and DevTools disagree at dy=\(dy)")
            XCTAssertEqual(
                Double(delta.wheel2), -delta.domDeltaX,
                "horizontal: the synthetic wheel and DevTools disagree at dx=\(dx)")
            XCTAssertEqual(
                Double(delta.wheel1), -delta.domDeltaY,
                "vertical: the synthetic wheel and DevTools disagree at dy=\(dy)")
        }
    }

    func testScrollDeltaRejectsWhatTheNativePathAlwaysRejected() throws {
        // These guards used to live only inside InputRouter.scroll, so the DevTools branch
        // accepted a no-op scroll and an out-of-range delta and answered ok.
        XCTAssertThrowsError(try ScrollDelta(dx: 0, dy: 0, ticks: 1),
                             "a scroll with no delta does nothing and should say so")
        XCTAssertThrowsError(try ScrollDelta(dx: 10_001, dy: 0, ticks: 1))
        XCTAssertThrowsError(try ScrollDelta(dx: 0, dy: -10_001, ticks: 1))
        XCTAssertThrowsError(try ScrollDelta(dx: 0, dy: 600, ticks: 0))
        XCTAssertThrowsError(try ScrollDelta(dx: 0, dy: 600, ticks: 101))

        XCTAssertNoThrow(try ScrollDelta(dx: 0, dy: -600, ticks: 100))
        XCTAssertNoThrow(try ScrollDelta(dx: -10_000, dy: 10_000, ticks: 1))
    }

    func testScreenshotRegionMustBeCompleteAndScaleBounded() throws {
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_screenshot", arguments: ["x": 0, "y": 0, "width": 10]))
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_screenshot",
            arguments: ["x": 0, "y": 0, "width": 10, "height": 10]))
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_screenshot", arguments: ["scale": 9]))
        XCTAssertNoThrow(try MCPServer.toolRequest(
            name: "spaceo_screenshot", arguments: ["scale": 2]))
    }

    func testEveryPointerCommandIsOwnerScopedSoMCPAttachesItsLease() throws {
        // The MCP client attaches the session's controller lease to owner-scoped mutations, and
        // leases are deliberately never returned in a session list — so a command missing from
        // this set is one an agent can never successfully call. It fails with "controller lease
        // is required" and has no way to obtain one. Found by driving the real MCP server after
        // scroll, move, and drag were added to the daemon but not to the client's list.
        for command in ["click", "scroll", "move", "drag", "type", "key"] {
            XCTAssertTrue(
                DaemonCommand.ownerScopedMutations.contains(command),
                "\(command) mutates a session but is not owner-scoped")
        }

        // Read-only commands must stay out, or an agent would need a lease just to look.
        for command in ["ax", "screenshot", "windows", "verify", "pool", "session.list"] {
            XCTAssertFalse(
                DaemonCommand.ownerScopedMutations.contains(command),
                "\(command) only reads and should not demand a lease")
        }
    }

    func testPointerToolsMapToTheirDaemonCommands() throws {
        let scroll = try MCPServer.toolRequest(
            name: "spaceo_scroll",
            arguments: ["x": 10, "y": 20, "dy": -600, "ticks": 3, "modifiers": ["shift"]])
        XCTAssertEqual(scroll.cmd, "scroll")
        XCTAssertEqual(scroll.dy, -600)
        XCTAssertEqual(scroll.ticks, 3)
        XCTAssertEqual(scroll.modifiers, ["shift"])

        let drag = try MCPServer.toolRequest(
            name: "spaceo_drag",
            arguments: ["x": 1, "y": 2, "to_x": 30, "to_y": 40, "button": "middle"])
        XCTAssertEqual(drag.cmd, "drag")
        XCTAssertEqual(drag.toX, 30)
        XCTAssertEqual(drag.toY, 40)
        XCTAssertEqual(drag.button, "middle")

        let move = try MCPServer.toolRequest(
            name: "spaceo_move", arguments: ["x": 5, "y": 6])
        XCTAssertEqual(move.cmd, "move")
        XCTAssertEqual(move.x, 5)
    }

    // MARK: - Window-scoped accessibility press
    //
    // A coordinate click takes an AXPress shortcut and reports the result as *confirmed*. The
    // hit test behind it walks the whole application, so without window scoping a click aimed at
    // a background window presses the frontmost window's control and still answers `ok: true`.

    func testCoordinatePressAimedAtABackgroundWindowFindsNoElementToPress() {
        // TextEdit with a document (front) and an empty Untitled behind it, at identical frames.
        let ax = StubAXHierarchy(
            roles: [1: kAXWindowRole as String, 2: kAXToolbarRole as String,
                    3: kAXButtonRole as String,
                    4: kAXWindowRole as String, 5: kAXButtonRole as String],
            parents: [2: 1, 3: 2, 5: 4],
            windowIDs: [1: 10, 4: 11])

        // The app-wide hit test answers with the front window's button (3) for a point the
        // caller expressed in the *back* window's coordinates.
        XCTAssertNil(AX.element(3, inWindow: 11, provider: ax),
                     "a press aimed at window 11 must not resolve to window 10's control")
        XCTAssertEqual(AX.element(3, inWindow: 10, provider: ax), 3,
                       "a press aimed at the window the hit belongs to still takes the shortcut")
        XCTAssertEqual(AX.element(5, inWindow: 11, provider: ax), 5)
        XCTAssertNil(AX.element(nil, inWindow: 10, provider: ax))
    }

    func testUnprovableAncestryIsNeverTreatedAsTheRequestedWindow() {
        // Nothing here can prove the element is in window 10, and an unproven window is exactly
        // the case that must fall through to unconfirmed synthetic delivery.
        let orphan = StubAXHierarchy(roles: [1: kAXButtonRole as String],
                                     parents: [:], windowIDs: [:])
        XCTAssertFalse(AX.belongs(1, toWindow: 10, provider: orphan), "no window ancestor")

        let cycle = StubAXHierarchy(
            roles: [1: kAXButtonRole as String, 2: kAXGroupRole as String],
            parents: [1: 2, 2: 1], windowIDs: [:])
        XCTAssertFalse(AX.belongs(1, toWindow: 10, provider: cycle), "a parent cycle")

        // A window whose id could not be read (the private lookup answers 0) is not window 10.
        let unidentified = StubAXHierarchy(
            roles: [1: kAXButtonRole as String, 2: kAXWindowRole as String],
            parents: [1: 2], windowIDs: [:])
        XCTAssertFalse(AX.belongs(1, toWindow: 10, provider: unidentified))
    }

    func testAncestryWalkStopsAtItsDepthLimitInsteadOfClimbingForever() {
        // A tree deeper than the limit is unproven, not confirmed.
        XCTAssertTrue(AX.belongs(
            0, toWindow: 10,
            provider: StubAXHierarchy.chain(depth: AX.maxAncestryDepth - 1, windowID: 10)))
        XCTAssertFalse(AX.belongs(
            0, toWindow: 10,
            provider: StubAXHierarchy.chain(depth: AX.maxAncestryDepth, windowID: 10)))
    }
}

/// An in-memory accessibility hierarchy: enough to walk parents to a window, and nothing else.
private struct StubAXHierarchy: AXAncestryProviding {
    var roles: [Int: String]
    var parents: [Int: Int]
    var windowIDs: [Int: CGWindowID]

    func role(_ element: Int) -> String { roles[element] ?? "AXUnknown" }
    func parent(_ element: Int) -> Int? { parents[element] }
    func windowID(_ element: Int) -> CGWindowID { windowIDs[element] ?? 0 }

    /// `depth` non-window nodes, 0 at the bottom, with a window above them.
    static func chain(depth: Int, windowID: CGWindowID) -> StubAXHierarchy {
        var roles = [Int: String]()
        var parents = [Int: Int]()
        for node in 0..<depth {
            roles[node] = kAXGroupRole as String
            parents[node] = node + 1
        }
        roles[depth] = kAXWindowRole as String
        return StubAXHierarchy(roles: roles, parents: parents, windowIDs: [depth: windowID])
    }
}
