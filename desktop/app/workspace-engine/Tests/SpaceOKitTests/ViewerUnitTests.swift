import XCTest
import AppKit
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOViewer

/// Pure-logic tests for the viewer's input path. No WindowServer state, no permissions.
final class ViewerUnitTests: XCTestCase {

    // MARK: - Viewport mapping
    //
    // The renderer letterboxes with `resizeAspect`; the mapping is that math in reverse.
    // If these drift apart, clicks land next to what the user sees — so the mapping is pinned.

    func testFullscreenStretchMapsPixelsAndInputToSameEdges() {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 1440, y: 0, width: 1920, height: 1080),
            viewSize: CGSize(width: 1440, height: 900), stretch: true)
        XCTAssertEqual(mapping.contentRect, CGRect(x: 0, y: 0, width: 1440, height: 900))
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: CGPoint(x: 720, y: 450)),
                       CGPoint(x: 2400, y: 540))
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: CGPoint(x: 0, y: 0)),
                       CGPoint(x: 1440, y: 0))
    }

    func testMappingWithoutLetterboxScalesAndOffsets() {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 2000, y: 100, width: 1920, height: 1080),
            viewSize: CGSize(width: 960, height: 540))
        XCTAssertEqual(mapping.contentRect, CGRect(x: 0, y: 0, width: 960, height: 540))
        let global = mapping.globalPoint(fromViewPoint: CGPoint(x: 480, y: 270))
        XCTAssertEqual(global, CGPoint(x: 2960, y: 640))
    }

    func testMappingPillarboxCentersContentAndRejectsMargins() {
        // 1920x1080 display in a 1000x540 view: content is 960x540 centered, 20pt bars.
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
            viewSize: CGSize(width: 1000, height: 540))
        XCTAssertEqual(mapping.contentRect, CGRect(x: 20, y: 0, width: 960, height: 540))
        XCTAssertNil(mapping.globalPoint(fromViewPoint: CGPoint(x: 10, y: 100)),
                     "points in the letterbox margin must not map to the display")
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: CGPoint(x: 20, y: 0)),
                       CGPoint(x: 0, y: 0),
                       "the content origin maps to the display origin")
    }

    func testMappingLetterboxTopAndBottom() {
        // 1600x1200 display in an 800x800 view: content is 800x600 centered vertically.
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 0, y: 0, width: 1600, height: 1200),
            viewSize: CGSize(width: 800, height: 800))
        XCTAssertEqual(mapping.contentRect, CGRect(x: 0, y: 100, width: 800, height: 600))
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: CGPoint(x: 400, y: 400)),
                       CGPoint(x: 800, y: 600))
    }

    func testDegenerateGeometryRefusesToMap() {
        let zeroDisplay = MirrorInput.ViewportMapping(
            displayBounds: .zero, viewSize: CGSize(width: 800, height: 600))
        XCTAssertEqual(zeroDisplay.contentRect, .zero)
        XCTAssertNil(zeroDisplay.globalPoint(fromViewPoint: CGPoint(x: 1, y: 1)))

        let zeroView = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 0, y: 0, width: 1920, height: 1080), viewSize: .zero)
        XCTAssertNil(zeroView.globalPoint(fromViewPoint: .zero))
    }

    func testOverlayProjectionMatchesInputMapping() {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: CGRect(x: 1920, y: 0, width: 2560, height: 1600),
            viewSize: CGSize(width: 1280, height: 800))
        let tile = CGRect(x: 1920 + 1280, y: 800, width: 1280, height: 800)
        XCTAssertEqual(mapping.viewRect(fromGlobalRect: tile),
                       CGRect(x: 640, y: 400, width: 640, height: 400))
    }

    func testZoomAndPanKeepRenderedPixelsAndInputMappingAligned() {
        let bounds = CGRect(x: 1_000, y: 200, width: 1_600, height: 900)
        let centered = MirrorInput.ViewportMapping(
            displayBounds: bounds,
            viewSize: CGSize(width: 800, height: 450),
            zoom: 2,
            pan: .zero
        )
        XCTAssertEqual(centered.contentRect, CGRect(x: -400, y: -225, width: 1_600, height: 900))
        XCTAssertEqual(
            centered.globalPoint(fromViewPoint: CGPoint(x: 400, y: 225)),
            CGPoint(x: 1_800, y: 650)
        )

        let right = MirrorInput.ViewportMapping(
            displayBounds: bounds,
            viewSize: CGSize(width: 800, height: 450),
            zoom: 2,
            pan: CGPoint(x: 1, y: 0)
        )
        XCTAssertEqual(right.contentRect.minX, -800)
        XCTAssertEqual(
            right.globalPoint(fromViewPoint: CGPoint(x: 400, y: 225)),
            CGPoint(x: 2_200, y: 650)
        )
    }

    func testTileScopedFrameDimensionsRespectDisplayScale() {
        XCTAssertEqual(
            DisplayStream.frameDimensions(
                pixelWidth: 3_840,
                pixelHeight: 2_160,
                fallbackPointSize: CGSize(width: 1_920, height: 1_080),
                sourceRect: CGRect(x: 960, y: 0, width: 960, height: 540)
            ).width,
            1_920
        )
        XCTAssertEqual(
            DisplayStream.frameDimensions(
                pixelWidth: 3_840,
                pixelHeight: 2_160,
                fallbackPointSize: CGSize(width: 1_920, height: 1_080),
                sourceRect: CGRect(x: 960, y: 0, width: 960, height: 540)
            ).height,
            1_080
        )
    }

    // MARK: - Hit-testing selection
    //
    // Candidates arrive front-to-back from the WindowServer; the selection rules decide which
    // window a console click belongs to.

    private func candidate(_ id: CGWindowID, pid: pid_t, layer: Int = 0,
                           _ bounds: CGRect) -> MirrorInput.WindowCandidate {
        MirrorInput.WindowCandidate(windowID: id, pid: pid, layer: layer,
                                    bounds: bounds, title: "w\(id)", appName: "app\(pid)")
    }

    func testSelectTargetPrefersFrontmost() {
        let front = candidate(10, pid: 100, CGRect(x: 0, y: 0, width: 400, height: 400))
        let back = candidate(11, pid: 101, CGRect(x: 0, y: 0, width: 400, height: 400))
        let hit = MirrorInput.selectTarget(from: [front, back],
                                           containing: CGPoint(x: 50, y: 50))
        XCTAssertEqual(hit?.windowID, 10)
    }

    func testSelectTargetAllowsNonZeroLayers() {
        let overlay = candidate(10, pid: 100, layer: 25,
                                CGRect(x: 0, y: 0, width: 400, height: 400))
        let normal = candidate(11, pid: 101, CGRect(x: 0, y: 0, width: 400, height: 400))
        let hit = MirrorInput.selectTarget(from: [overlay, normal],
                                           containing: CGPoint(x: 50, y: 50))
        XCTAssertEqual(hit?.windowID, 10)
    }

    func testAccessibilityPressCanReachAControlBelowANonActionableOverlay() {
        let overlay = candidate(10, pid: 100, layer: 1_000,
                                CGRect(x: 0, y: 0, width: 400, height: 400))
        let control = candidate(11, pid: 101,
                                CGRect(x: 0, y: 0, width: 200, height: 200))
        let candidates = MirrorInput.targets(
            from: [overlay, control],
            containing: CGPoint(x: 50, y: 50)
        )
        var attempts: [pid_t] = []

        let target = ViewerInputController.pressFirstActionableTarget(candidates) { candidate in
            attempts.append(candidate.pid)
            return candidate.pid == 101
        }

        XCTAssertEqual(attempts, [100, 101])
        XCTAssertEqual(target?.windowID, 11)
    }

    func testNonActionableWindowsRemainEligibleForPointerFallback() {
        let overlay = candidate(10, pid: 100, layer: 1_000,
                                CGRect(x: 0, y: 0, width: 400, height: 400))
        let candidates = MirrorInput.targets(
            from: [overlay],
            containing: CGPoint(x: 50, y: 50)
        )

        XCTAssertNil(ViewerInputController.pressFirstActionableTarget(candidates) { _ in false })
        XCTAssertEqual(candidates.first?.windowID, 10,
                       "custom/canvas windows remain the geometric pointer fallback")
    }

    func testSelectTargetSkipsExcludedPIDsAndMisses() {
        let mine = candidate(10, pid: 100, CGRect(x: 0, y: 0, width: 400, height: 400))
        let other = candidate(11, pid: 101, CGRect(x: 500, y: 0, width: 100, height: 100))
        XCTAssertNil(MirrorInput.selectTarget(from: [mine, other],
                                              containing: CGPoint(x: 50, y: 50),
                                              excluding: [100]),
                     "explicit exclusions and misses stay misses")
        let hit = MirrorInput.selectTarget(from: [mine, other],
                                           containing: CGPoint(x: 550, y: 50),
                                           excluding: [100])
        XCTAssertEqual(hit?.windowID, 11)
    }

    // MARK: - Pointer phases

    func testPointerPhaseEventTypes() {
        XCTAssertEqual(MirrorInput.eventType(for: .move, button: .left), .mouseMoved)
        XCTAssertEqual(MirrorInput.eventType(for: .down, button: .left), .leftMouseDown)
        XCTAssertEqual(MirrorInput.eventType(for: .up, button: .left), .leftMouseUp)
        XCTAssertEqual(MirrorInput.eventType(for: .drag, button: .left), .leftMouseDragged)
        XCTAssertEqual(MirrorInput.eventType(for: .down, button: .right), .rightMouseDown)
        XCTAssertEqual(MirrorInput.eventType(for: .drag, button: .right), .rightMouseDragged)
    }

    // MARK: - Keyboard translation

    func testModifierFlagTranslation() {
        let flags = MirrorInput.flags(from: [.command, .shift])
        XCTAssertTrue(flags.contains(.maskCommand))
        XCTAssertTrue(flags.contains(.maskShift))
        XCTAssertFalse(flags.contains(.maskAlternate))
        XCTAssertEqual(MirrorInput.flags(from: []), [])
    }

    func testUnicodePayloadPolicy() {
        XCTAssertTrue(MirrorInput.shouldCarryUnicode("a"))
        XCTAssertTrue(MirrorInput.shouldCarryUnicode("é"))
        XCTAssertTrue(MirrorInput.shouldCarryUnicode("🙂"))
        XCTAssertFalse(MirrorInput.shouldCarryUnicode(""), "empty payloads carry nothing")
        XCTAssertFalse(MirrorInput.shouldCarryUnicode("\r"),
                       "the virtual key code already says Return")
        XCTAssertFalse(MirrorInput.shouldCarryUnicode("\u{F700}"),
                       "AppKit function-key code points must not become literal text")
        XCTAssertFalse(MirrorInput.shouldCarryUnicode(String(repeating: "x", count: 64)),
                       "a key event is one keystroke, not a paste")
    }

}
