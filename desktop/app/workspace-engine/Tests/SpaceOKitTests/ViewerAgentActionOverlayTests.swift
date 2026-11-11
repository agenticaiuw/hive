import CoreGraphics
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-158 follow-up. The ripple is drawn where the agent clicked, so its placement uses the
/// same mapping as the tiles and the input path; a drift here would show the human a click that
/// landed somewhere else.
final class ViewerAgentActionOverlayTests: XCTestCase {

    // A 1080p stage; the session's window sits at (100, 200) and the agent clicked 50,25 into it.
    private let stage = CGRect(x: 0, y: 0, width: 1_920, height: 1_080)

    private func session(
        outcome: String? = "confirmed",
        target: String? = "button Save",
        windowID: UInt32 = 41,
        actionWindowID: UInt32 = 41,
        x: Double = 50,
        y: Double = 25
    ) throws -> SessionInfo {
        let outcomeJSON = outcome.map { "\"lastAgentActionOutcome\":\"\($0)\"," } ?? ""
        let targetJSON = target.map { "\"lastAgentActionTarget\":\"\($0)\"," } ?? ""
        let json = """
        {
          "id":"clicker","displayID":7,"x":0,"y":0,"width":1920,"height":1080,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],
          "windows":[{"windowID":\(windowID),"pid":9,"title":"Doc","x":100,"y":200,
            "width":800,"height":600,"onStage":true,"spaces":[]}],
          "createdAt":"2026-07-28T00:00:00Z","teardownPending":false,"runtimeAttached":true,
          "lastAgentAction":"click","lastAgentActionAt":"2026-07-28T00:00:10Z",
          "lastAgentActionX":\(x),"lastAgentActionY":\(y),
          "lastAgentActionWindowID":\(actionWindowID),
          \(outcomeJSON)\(targetJSON)
          "inputPaused":false
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    func testMarkerLandsOnTheClickedPixelAtFitZoom() throws {
        let console = CGSize(width: 960, height: 540)
        let marker = try XCTUnwrap(SessionOverlayLayout.actionMarker(
            for: try session(), displayBounds: stage, viewSize: console))

        // Global (150, 225) at 0.5x.
        XCTAssertEqual(marker.center, CGPoint(x: 75, y: 112.5))
        XCTAssertEqual(marker.outcome, .confirmed)
        XCTAssertEqual(marker.action, "click")
        XCTAssertEqual(marker.target, "button Save")
        XCTAssertEqual(marker.sessionID, "clicker")

        // The same point the input path would map a click at the marker back to.
        let mapping = MirrorInput.ViewportMapping(displayBounds: stage, viewSize: console)
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: marker.center),
                       CGPoint(x: 150, y: 225))
    }

    func testMarkerTracksZoomAndPan() throws {
        let console = CGSize(width: 960, height: 540)
        let pan = CGPoint(x: -1, y: -1)
        let marker = try XCTUnwrap(SessionOverlayLayout.actionMarker(
            for: try session(), displayBounds: stage, viewSize: console, zoom: 2, pan: pan))

        // At 2x panned to the top-left the top-left quadrant fills the console, so global
        // (150, 225) is at view (150, 225).
        XCTAssertEqual(marker.center, CGPoint(x: 150, y: 225))
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: stage, viewSize: console, zoom: 2, pan: pan)
        XCTAssertEqual(mapping.globalPoint(fromViewPoint: marker.center),
                       CGPoint(x: 150, y: 225))
    }

    func testMarkerUsesTheTileAsDisplayBoundsInSessionScope() throws {
        // Session scope streams only the tile, so the mapping's display is the tile itself.
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        let marker = try XCTUnwrap(SessionOverlayLayout.actionMarker(
            for: try session(), displayBounds: tile, viewSize: CGSize(width: 960, height: 540)))
        XCTAssertEqual(marker.center, CGPoint(x: 150, y: 225))
    }

    func testOutcomeColoursFollowTheReceiptVocabulary() throws {
        XCTAssertEqual(try marker(outcome: "confirmed").outcome, .confirmed)
        XCTAssertEqual(try marker(outcome: "unconfirmed").outcome, .unconfirmed)
        XCTAssertEqual(try marker(outcome: "refused").outcome, .refused)
        XCTAssertEqual(try marker(outcome: nil).outcome, .unconfirmed,
                       "no verdict is not a success claim")
        XCTAssertEqual(try marker(outcome: "sparkly").outcome, .unconfirmed)
    }

    func testNoMarkerWithoutAPointOrAKnownWindow() throws {
        XCTAssertNil(SessionOverlayLayout.actionMarker(
            for: try session(actionWindowID: 999), displayBounds: stage,
            viewSize: CGSize(width: 960, height: 540)),
            "a window that left the session's list cannot place the action")
        XCTAssertNil(SessionOverlayLayout.actionMarker(
            for: try session(x: 5_000, y: 5_000), displayBounds: stage,
            viewSize: CGSize(width: 960, height: 540)),
            "a point off the display is not drawn")
        XCTAssertNil(SessionOverlayLayout.actionMarker(
            for: try session(), displayBounds: stage, viewSize: .zero),
            "a degenerate console produces no NaN positions")
    }

    func testEventDetailCarriesActionOutcomeAndTarget() throws {
        XCTAssertEqual(ViewerModel.agentActionDetail(try session()),
                       "click · confirmed · button Save")
        XCTAssertEqual(ViewerModel.agentActionDetail(try session(outcome: nil, target: nil)),
                       "click")
    }

    // MARK: - Sparkline

    func testSparklineBucketsTheLastMinuteOldestFirst() {
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        let buckets = ViewerActivitySparkline.buckets(
            timestamps: [
                now,                              // last bucket
                now.addingTimeInterval(-4),       // last bucket
                now.addingTimeInterval(-7),       // second to last
                now.addingTimeInterval(-59),      // first bucket
                now.addingTimeInterval(-61),      // outside the window
                now.addingTimeInterval(5),        // the future is not activity
            ],
            now: now)
        XCTAssertEqual(buckets.count, 12)
        XCTAssertEqual(buckets.last, 2)
        XCTAssertEqual(buckets[10], 1)
        XCTAssertEqual(buckets.first, 1)
        XCTAssertEqual(buckets.reduce(0, +), 4)
    }

    private func marker(outcome: String?) throws -> SessionOverlayLayout.ActionMarker {
        try XCTUnwrap(SessionOverlayLayout.actionMarker(
            for: try session(outcome: outcome), displayBounds: stage,
            viewSize: CGSize(width: 960, height: 540)))
    }
}
