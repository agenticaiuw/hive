import XCTest
import CoreGraphics
@testable import SpaceOViewer

/// A saved capture leaves the Viewer and becomes evidence somewhere else. Its name is the only
/// scope it still carries, so the name has to agree with what the image actually contains.
///
/// `setCanvasMode(.display)` deliberately keeps `selectedSessionID` — the sidebar still knows
/// which session you came from and the inspector still describes it, which is what makes the
/// Session/Display toggle a two-way door. The toolbar label and `currentStreamTarget` both
/// branch on `canvasMode`; the save panel's suggested name branched on `selectedSessionID`
/// alone, so pressing **Capture Display** wrote a whole-display image — every tile on it,
/// including other agents' — as `spaceo-session-<id>.png`.
final class ViewerScreenshotNamingTests: XCTestCase {

    func testTileCaptureIsNamedForItsSession() {
        XCTAssertEqual(
            ViewerModel.screenshotFileName(
                canvasMode: .session, sessionID: "research", displayID: 71),
            "spaceo-session-research.png")
    }

    func testWholeDisplayCaptureIsNamedForItsDisplayEvenWithASessionStillSelected() {
        XCTAssertEqual(
            ViewerModel.screenshotFileName(
                canvasMode: .display, sessionID: "research", displayID: 71),
            "spaceo-display-71.png",
            "this image contains the whole display; naming it after one session claims a tile "
            + "scope the file does not have")
    }

    func testDisplayCaptureWithNoSessionSelectedIsUnchanged() {
        XCTAssertEqual(
            ViewerModel.screenshotFileName(
                canvasMode: .display, sessionID: nil, displayID: 3),
            "spaceo-display-3.png")
    }

    /// The session canvas cannot be reached without a session, but the name must not invent one
    /// if it ever is.
    func testSessionCanvasWithoutASessionFallsBackToTheDisplayName() {
        XCTAssertEqual(
            ViewerModel.screenshotFileName(
                canvasMode: .session, sessionID: nil, displayID: 12),
            "spaceo-display-12.png")
    }
}
