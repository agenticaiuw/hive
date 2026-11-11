import AppKit
import XCTest
@testable import SpaceOViewer

final class AgentWorkspaceShortcutTests: XCTestCase {
    private let flags = NSEvent.EventType.flagsChanged.rawValue
    private let key = NSEvent.EventType.keyDown.rawValue

    func testCycleIncludesAllCurrentWorkspacesAndReturnsToPhysical() {
        let order = ["first", "second", "third"]
        XCTAssertEqual(WorkspaceCycle.next(current: nil, ordered: order), "first")
        XCTAssertEqual(WorkspaceCycle.next(current: "first", ordered: order), "second")
        XCTAssertEqual(WorkspaceCycle.next(current: "second", ordered: order), "third")
        XCTAssertNil(WorkspaceCycle.next(current: "third", ordered: order))
        XCTAssertNil(WorkspaceCycle.next(current: nil, ordered: []))
        XCTAssertEqual(WorkspaceCycle.next(current: "removed", ordered: ["second"]), "second")
    }

    func testVirtualDisplayRejectsCrossingAndAllowsPhysicalDisplays() {
        let virtual = [CGRect(x: 1440, y: 0, width: 1920, height: 1080),
                       CGRect(x: -1920, y: -100, width: 1920, height: 1080)]
        let physical = [CGRect(x: 0, y: 0, width: 1440, height: 900),
                        CGRect(x: 0, y: -900, width: 1440, height: 900)]
        let last = CGPoint(x: 1439, y: 500)
        XCTAssertEqual(WorkspacePointerBoundary.destination(CGPoint(x: 1441, y: 500), virtualBounds: virtual, previous: last, physicalBounds: physical), last)
        XCTAssertEqual(WorkspacePointerBoundary.destination(CGPoint(x: -1, y: 500), virtualBounds: virtual, previous: nil, physicalBounds: physical), CGPoint(x: 0, y: 500))
        XCTAssertNil(WorkspacePointerBoundary.destination(CGPoint(x: 100, y: -100), virtualBounds: virtual, previous: last, physicalBounds: physical))
        // A previous point on a retired virtual display is not a safe destination.
        XCTAssertEqual(WorkspacePointerBoundary.destination(CGPoint(x: 1441, y: 500), virtualBounds: virtual, previous: CGPoint(x: 2000, y: 500), physicalBounds: physical), last)
        XCTAssertTrue(WorkspacePointerBoundary.isWorkspaceDisplay(vendor: 0x1AF2, model: 1))
        XCTAssertFalse(WorkspacePointerBoundary.isWorkspaceDisplay(vendor: 0x1AF2, model: 2))
    }

    func testRightOptionTapSwitches() {
        var tap = RightOptionTap()
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: NSEvent.ModifierFlags.option.rawValue, down: true, now: 10))
        XCTAssertTrue(tap.observe(type: flags, code: 61, flags: 0, down: false, now: 10.1))
    }

    func testOptionChordAndLongHoldDoNotSwitch() {
        var tap = RightOptionTap()
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: NSEvent.ModifierFlags.option.rawValue, down: true, now: 10))
        XCTAssertFalse(tap.observe(type: key, code: 0, flags: NSEvent.ModifierFlags.option.rawValue, down: false, now: 10.1))
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: 0, down: false, now: 10.2))
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: NSEvent.ModifierFlags.option.rawValue, down: true, now: 20))
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: 0, down: false, now: 21))
    }

    func testPointerMovementDoesNotCancelOptionTap() {
        var tap = RightOptionTap()
        XCTAssertFalse(tap.observe(type: flags, code: 61, flags: 0x80040, down: true, now: 10))
        XCTAssertFalse(tap.observe(type: NSEvent.EventType.mouseMoved.rawValue, code: 0,
                                   flags: 0x80040, down: false, now: 10.05))
        XCTAssertTrue(tap.observe(type: flags, code: 61, flags: 0, down: false, now: 10.1))
    }

    func testDockHitRoutingExcludesUnrelatedClicks() {
        let bounds = CGRect(x: 20, y: 500, width: 100, height: 40)
        let items = [AgentDockItem(frame: CGRect(x: 20, y: 500, width: 30, height: 40),
                                   appPath: "/Applications/Fixture.app")]
        if case .outside = AgentDockHit.classify(CGPoint(x: 10, y: 510), bounds: bounds, items: items) {} else { XCTFail("outside click must pass") }
        if case .app(let path) = AgentDockHit.classify(CGPoint(x: 30, y: 510), bounds: bounds, items: items) {
            XCTAssertEqual(path, "/Applications/Fixture.app")
        } else { XCTFail("app icon must route to its app") }
        if case .unsupported = AgentDockHit.classify(CGPoint(x: 100, y: 510), bounds: bounds, items: items) {} else { XCTFail("unsupported Dock items must not leak through") }
    }
}
