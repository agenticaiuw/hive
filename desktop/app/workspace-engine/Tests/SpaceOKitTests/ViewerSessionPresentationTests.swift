import CoreGraphics
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

final class ViewerSessionPresentationTests: XCTestCase {

    func testBadgePrecedenceMakesTerminalAndRecoveryStatesUnambiguous() {
        let owner = DurableSessionOwner(
            id: "controller-1",
            kind: .mcp,
            label: "Codex"
        )

        XCTAssertEqual(
            presentation(
                teardownPending: true,
                owner: owner,
                abandoned: true,
                reclaimable: true
            ).badge,
            .cleanupPending
        )
        XCTAssertEqual(
            presentation(owner: owner, abandoned: true, reclaimable: true).badge,
            .reclaimable
        )
        XCTAssertEqual(
            presentation(owner: owner, abandoned: true, reclaimable: false).badge,
            .abandoned
        )
        XCTAssertEqual(
            presentation(owner: owner, abandoned: false, reclaimable: false).badge,
            .owned
        )
    }

    func testMissingControllerMetadataDoesNotMislabelAnOlderDaemonResponse() {
        let result = presentation()

        XCTAssertNil(result.badge)
        XCTAssertNil(result.ownerText)
        XCTAssertNil(result.timingText)
    }

    func testOwnerAndActivityDetailsAreCompactAndAccessible() {
        let now = Date(timeIntervalSinceReferenceDate: 10_000)
        let owner = DurableSessionOwner(
            id: "controller-1",
            kind: .mcp,
            label: "Codex"
        )
        let result = ViewerSessionPresentation(
            teardownPending: false,
            controllerOwner: owner,
            ageSeconds: 3_661,
            lastActivityAt: now.addingTimeInterval(-125),
            abandoned: false,
            reclaimable: false,
            now: now
        )

        XCTAssertEqual(result.badge, .owned)
        XCTAssertEqual(result.ownerText, "Owner: Codex · MCP")
        XCTAssertEqual(result.timingText, "Last activity 2m ago · Age 1h 1m")
        XCTAssertEqual(
            result.accessibilityDescription(sessionID: "research"),
            "Session research. Status: Owned. Owner: Codex · MCP. "
                + "Last activity 2m ago · Age 1h 1m."
        )
    }

    func testBlankOwnerLabelFallsBackToStableControllerID() {
        let owner = DurableSessionOwner(
            id: "cli-42",
            kind: .cli,
            label: "  "
        )

        XCTAssertEqual(
            presentation(owner: owner).ownerText,
            "Owner: cli-42 · CLI"
        )
    }

    func testOverlayRequiresCurrentActiveSpaceODisplayAndContainedGeometry() {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 100, y: 50, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage — Test"
        )
        let tile = CGRect(x: 100, y: 50, width: 960, height: 540)

        XCTAssertEqual(
            ViewerSessionPresentation.overlayFrame(displayID: 7, frame: tile, on: display),
            tile
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(displayID: 8, frame: tile, on: display)
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: CGRect(x: -900, y: 50, width: 960, height: 540),
                on: display
            ),
            "last-known geometry outside the live display must never become an overlay"
        )

        let physicalDisplay = DisplayEntry(
            id: display.id,
            bounds: display.bounds,
            isSpaceO: false,
            isActive: true,
            name: "Built-in Display"
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: tile,
                on: physicalDisplay
            ),
            "a recycled physical display ID must not inherit a stale SpaceO tile"
        )

        let inactiveDisplay = DisplayEntry(
            id: display.id,
            bounds: display.bounds,
            isSpaceO: true,
            isActive: false,
            name: display.name
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: tile,
                runtimeAttached: false,
                on: display
            ),
            "a detached durable record must never overlay recyclable display geometry"
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: tile,
                on: inactiveDisplay
            )
        )
    }

    func testOverlayRejectsInvalidGeometry() {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage — Test"
        )

        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: CGRect(x: 0, y: 0, width: 0, height: 100),
                on: display
            )
        )
        XCTAssertNil(
            ViewerSessionPresentation.overlayFrame(
                displayID: 7,
                frame: CGRect(x: CGFloat.nan, y: 0, width: 100, height: 100),
                on: display
            )
        )
    }

    @MainActor
    func testDetachedSessionWireStateIsExplicitlyNonTargetable() throws {
        let liveJSON = """
        {
          "id":"live","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          "createdAt":"2026-07-28T00:00:00Z","teardownPending":false,
          "runtimeAttached":true
        }
        """
        let detachedJSON = liveJSON.replacingOccurrences(
            of: #""runtimeAttached":true"#,
            with: #""runtimeAttached":false"#)
            .replacingOccurrences(of: #""id":"live""#, with: #""id":"detached""#)
        let legacyJSON = liveJSON.replacingOccurrences(
            of: #""runtimeAttached":true"#,
            with: #""legacyDaemonOmittedAttachmentState":true"#)

        let live = try Wire.decoder.decode(
            SessionInfo.self, from: Data(liveJSON.utf8))
        let detached = try Wire.decoder.decode(
            SessionInfo.self, from: Data(detachedJSON.utf8))
        let legacy = try Wire.decoder.decode(
            SessionInfo.self, from: Data(legacyJSON.utf8))

        XCTAssertEqual(live.runtimeAttached, true)
        XCTAssertEqual(detached.runtimeAttached, false)
        XCTAssertNil(legacy.runtimeAttached)
        XCTAssertEqual(
            ViewerModel.detachedSessions(from: [live, detached, legacy]).map(\.id),
            ["detached"],
            "only the explicitly detached record belongs in the recovery section")
    }

    func testSessionSearchCoversIdentityOwnerAppsWindowsAndState() throws {
        let json = """
        {
          "id":"research-alpha","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,
          "apps":[{"pid":44,"name":"Safari","bundleID":"com.apple.Safari","startedByUs":true}],
          "windows":[{"windowID":9,"pid":44,"title":"Market report","x":0,"y":0,
            "width":100,"height":100,"onStage":true,"spaces":[]}],
          "createdAt":"2026-07-28T00:00:00Z","teardownPending":false,
          "runtimeAttached":true,
          "controllerOwner":{"id":"codex-1","kind":"mcp","label":"Research agent"},
          "abandoned":true
        }
        """
        let session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))

        XCTAssertTrue(ViewerSessionSearch.matches(session, query: "research safari"))
        XCTAssertTrue(ViewerSessionSearch.matches(session, query: "market 44"))
        XCTAssertTrue(ViewerSessionSearch.matches(session, query: "abandoned codex"))
        XCTAssertFalse(ViewerSessionSearch.matches(session, query: "terminal"))
    }

    private func presentation(
        teardownPending: Bool = false,
        owner: DurableSessionOwner? = nil,
        abandoned: Bool? = nil,
        reclaimable: Bool? = nil
    ) -> ViewerSessionPresentation {
        ViewerSessionPresentation(
            teardownPending: teardownPending,
            controllerOwner: owner,
            ageSeconds: nil,
            lastActivityAt: nil,
            abandoned: abandoned,
            reclaimable: reclaimable
        )
    }
}
