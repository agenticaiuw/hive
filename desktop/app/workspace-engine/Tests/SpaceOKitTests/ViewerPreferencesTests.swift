import CoreGraphics
import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-161. The Viewer remembers selection, zoom mode, inspector state and density in a file
/// beside the host-capture breadcrumb. Everything here runs against a scratch directory; the
/// real preferences file is never touched.
@MainActor
final class ViewerPreferencesTests: XCTestCase {

    func testInspectorStartsCollapsedAndExplicitNavigationRevealsIt() {
        let model = ViewerModel(automaticRefresh: false)
        XCTAssertFalse(model.inspectorVisible)
        model.showInspector(.health)
        XCTAssertTrue(model.inspectorVisible)
        XCTAssertEqual(model.inspectorSection, .health)
        model.toggleInspector()
        XCTAssertFalse(model.inspectorVisible)
        model.showInspector(.health)
        XCTAssertTrue(model.inspectorVisible, "Opening the same section must still reveal it")
    }

    func testSavedInspectorVisibilitySurvivesTheNewDefault() throws {
        XCTAssertFalse(ViewerPreferences().inspectorVisible)
        let loaded = try Wire.decoder.decode(
            ViewerPreferences.self, from: Data("{\"inspectorVisible\":true}".utf8))
        XCTAssertTrue(loaded.inspectorVisible)
    }

    // MARK: - Store

    func testPreferencesRoundTripThroughTheFileStore() throws {
        try withScratchStore { store in
            var preferences = ViewerPreferences()
            preferences.selectedSessionID = "research"
            preferences.selectedDisplayID = 71
            preferences.canvasMode = .display
            preferences.zoomMode = .custom(2.5)
            preferences.inspectorSection = .events
            preferences.sidebarVisible = false
            preferences.inspectorVisible = false
            preferences.lastDensity = 4
            preferences.showAgentActions = false
            preferences.walkthroughDismissed = true
            preferences.notifications.sessionAbandoned = true
            preferences.launchAsMenuBarItemOnly = true
            preferences.miniMonitorClickThrough = true

            store.save(preferences)
            XCTAssertEqual(store.load(), preferences)

            let attributes = try FileManager.default.attributesOfItem(atPath: store.url.path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600,
                           "preferences are owner-only, like the breadcrumb beside them")
        }
    }

    func testMissingOrMalformedFileLoadsDefaults() throws {
        try withScratchStore { store in
            XCTAssertEqual(store.load(), ViewerPreferences())
            try FileManager.default.createDirectory(
                at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("{ not json".utf8).write(to: store.url)
            XCTAssertEqual(store.load(), ViewerPreferences(),
                           "a corrupt file must never keep the console from opening")
        }
    }

    func testUnknownValuesFromAnotherVersionFallBackFieldByField() throws {
        let json = """
        {"canvasMode":"holographic","inspectorSection":"events","lastDensity":900,
         "zoomMode":{"mode":"custom","zoom":99},"futureKey":true}
        """
        let loaded = try Wire.decoder.decode(ViewerPreferences.self, from: Data(json.utf8))
        XCTAssertEqual(loaded.canvasMode, .session, "unknown mode falls back to the default")
        XCTAssertEqual(loaded.inspectorSection, .events, "known values survive")
        XCTAssertNil(loaded.lastDensity, "out-of-range density is dropped, not trusted")
        XCTAssertEqual(loaded.zoomMode, .custom(ViewerZoom.maximum), "zoom is clamped")
    }

    /// Restoring Control from disk would pause agents and take over a Mac before the person
    /// touched anything. The struct has no such field, and this pins that it never grows one
    /// by accident.
    func testPreferencesCarryNothingAboutControl() throws {
        let data = try Wire.encoder.encode(ViewerPreferences())
        let json = try XCTUnwrap(String(data: data, encoding: .utf8)).lowercased()
        for forbidden in ["control", "interaction", "capture", "paused"] {
            XCTAssertFalse(json.contains(forbidden),
                           "preferences must not persist anything about Control (\(forbidden))")
        }
    }

    // MARK: - Zoom

    func testActualSizeZoomIsOnePointPerPointAndNeverBelowFit() {
        // A 2560-wide display fit into 1280 points is at 0.5x; actual size is 2x.
        XCTAssertEqual(
            ViewerZoom.actualSizeZoom(
                displayBounds: CGRect(x: 0, y: 0, width: 2_560, height: 1_440),
                viewSize: CGSize(width: 1_280, height: 900)),
            2)
        // A display smaller than the console is already at actual size when fit.
        XCTAssertEqual(
            ViewerZoom.actualSizeZoom(
                displayBounds: CGRect(x: 0, y: 0, width: 640, height: 480),
                viewSize: CGSize(width: 1_280, height: 900)),
            1)
        XCTAssertEqual(
            ViewerZoom.actualSizeZoom(displayBounds: .zero, viewSize: CGSize(width: 10, height: 10)),
            1, "degenerate geometry never produces NaN")
    }

    func testZoomCommandsMoveBetweenModesAndPersist() throws {
        try withScratchStore { store in
            let display = DisplayEntry(
                id: 7, bounds: CGRect(x: 0, y: 0, width: 2_560, height: 1_440),
                isSpaceO: true, isActive: true, name: "Stage")
            let model = ViewerModel(
                automaticRefresh: false,
                initialDisplays: [display],
                initialSelectedID: 7,
                initialPermissions: PermissionState(screenRecording: false, accessibility: false),
                accessibilityAnnouncement: { _ in },
                preferencesStore: store)
            XCTAssertEqual(model.zoomMode, .fit, "Fit is the default")
            XCTAssertEqual(model.viewportZoom, 1)

            model.reportSurfaceSize(CGSize(width: 1_280, height: 900))
            model.zoomToActualSize()
            XCTAssertEqual(model.zoomMode, .actualSize)
            XCTAssertEqual(model.viewportZoom, 2)

            model.reportSurfaceSize(CGSize(width: 640, height: 450))
            XCTAssertEqual(model.viewportZoom, 4, "Actual Size follows the window size")

            model.zoomIn()
            XCTAssertEqual(model.zoomMode, .custom(4.25))
            model.zoomOut()
            model.zoomOut()
            XCTAssertEqual(model.viewportZoom, 3.75)

            model.zoomToFit()
            XCTAssertEqual(model.viewportZoom, 1)
            XCTAssertEqual(model.viewportPan, .zero)
            XCTAssertFalse(model.canZoomOut)
            XCTAssertTrue(model.canZoomIn)

            model.setZoom(2)
            model.flushPreferences()
            XCTAssertEqual(store.load().zoomMode, .custom(2))
        }
    }

    func testPanDeltaCoversTheZoomedOverflow() {
        // 1920x1080 in a 960x540 console at 2x: content is 1920 wide, overflow 960 in each axis.
        let delta = VMSurfaceView.panDelta(
            viewDelta: CGPoint(x: 480, y: -270),
            displayBounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            viewSize: CGSize(width: 960, height: 540),
            zoom: 2)
        XCTAssertEqual(delta?.x, -1, "dragging right half the overflow moves the pan one unit left")
        XCTAssertEqual(delta?.y, 1)
        XCTAssertNil(VMSurfaceView.panDelta(
            viewDelta: CGPoint(x: 10, y: 10),
            displayBounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            viewSize: CGSize(width: 960, height: 540),
            zoom: 1), "nothing to pan when fit")
    }

    // MARK: - Restore

    func testSavedSelectionAndInspectorStateAreRestoredOnTheFirstPoll() throws {
        try withScratchStore { store in
            var saved = ViewerPreferences()
            saved.selectedSessionID = "second"
            saved.canvasMode = .session
            saved.inspectorSection = .windows
            saved.inspectorVisible = false
            saved.sidebarVisible = false
            store.save(saved)

            let display = DisplayEntry(
                id: 7, bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
                isSpaceO: true, isActive: true, name: "Stage")
            let first = try Self.session(id: "first", createdAt: "2026-07-30T00:00:01Z")
            let second = try Self.session(id: "second", createdAt: "2026-07-30T00:00:00Z")
            let model = ViewerModel(
                automaticRefresh: false,
                initialDisplays: [display],
                initialPermissions: PermissionState(screenRecording: false, accessibility: false),
                accessibilityAnnouncement: { _ in },
                preferencesStore: store)

            XCTAssertEqual(model.inspectorSection, .windows)
            XCTAssertFalse(model.inspectorVisible)
            XCTAssertEqual(model.columnVisibility, .detailOnly)
            XCTAssertFalse(model.interactionEnabled, "Control is never restored")

            model.applyControlPlane(sessions: [first, second], poolResponse: Response(ok: true))
            XCTAssertEqual(model.selectedSessionID, "second",
                           "the remembered session wins over the newest-first fallback")
            XCTAssertEqual(model.inspectorSection, .windows,
                           "restoring the selection must not reset the remembered section")
            XCTAssertFalse(model.interactionEnabled)

            // A later poll does not keep forcing the old choice back.
            model.selectSession("first")
            model.applyControlPlane(sessions: [first, second], poolResponse: Response(ok: true))
            XCTAssertEqual(model.selectedSessionID, "first")
            model.flushPreferences()
            XCTAssertEqual(store.load().selectedSessionID, "first")
        }
    }

    func testModelWithoutAStoreNeverTouchesDisk() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        XCTAssertNil(model.preferencesStore)
        model.updatePreferences { $0.walkthroughDismissed = true }
        model.flushPreferences()
        XCTAssertTrue(model.preferences.walkthroughDismissed)
    }

    // MARK: - Helpers

    private func withScratchStore(_ body: (ViewerPreferencesStore) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-viewer-preferences-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ViewerPreferencesStore(
            url: root.appendingPathComponent("Viewer/preferences.json", isDirectory: false))
        try body(store)
    }

    static func session(id: String, displayID: UInt32 = 7, createdAt: String) throws -> SessionInfo {
        let json = """
        {
          "id": "\(id)", "displayID": \(displayID),
          "x": 0, "y": 0, "width": 1920, "height": 1080,
          "tileIndex": 0, "tileCapacity": 1, "exclusiveDisplay": true,
          "spaces": [], "hasOwnSpace": true, "apps": [], "windows": [],
          "createdAt": "\(createdAt)", "teardownPending": false, "runtimeAttached": true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }
}
