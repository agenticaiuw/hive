import AppKit
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// Control transitions must not strand a pressed mouse button in the remote app.
///
/// A revoked Control never sees the operator's own mouse-up — the surface stops forwarding the
/// moment the gate closes — so the transition itself has to send the up. Without it the remote
/// app stays in its mouse-tracking loop: a selection keeps extending, a dragged window stays
/// glued to the pointer. These tests drive the controller through its injected seams, so no
/// synthetic event can escape the test runner.
@MainActor
final class HeldPointerReleaseTests: XCTestCase {

    /// A 1920x1080 stage shown in a 1920x1200 view: the display's pixels occupy y 60...1140 and
    /// the 60pt bands above and below are letterbox margin that maps to no global point.
    private let viewSize = CGSize(width: 1_920, height: 1_200)

    func testRevokingControlMidDragReleasesTheHeldButtonToTheDownWindow() {
        let harness = Harness(viewSize: viewSize, test: self)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        harness.press(.down, at: CGPoint(x: 960, y: 600))
        harness.waitForEvents(2)
        harness.press(.drag, at: CGPoint(x: 1_200, y: 660))
        harness.waitForEvents(3)

        harness.controller.interactionEnabled = false
        harness.waitForEvents(4)

        XCTAssertEqual(harness.recorder.events.map(\.phase), [.move, .down, .drag, .up],
                       "the down that reached the app needs a matching up on revoke")
        let release = harness.recorder.events.last
        XCTAssertEqual(release?.button, .left)
        XCTAssertEqual(release?.pid, harness.target.pid)
        XCTAssertEqual(release?.windowID, harness.target.windowID)
        XCTAssertEqual(release?.point, CGPoint(x: 1_200, y: 600),
                       "the up lands where the app last saw the pointer")
    }

    func testDisplayTransitionMidDragReleasesTheHeldButton() {
        let harness = Harness(viewSize: viewSize, test: self)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        harness.press(.down, at: CGPoint(x: 960, y: 600))
        harness.waitForEvents(2)

        harness.controller.display = harness.otherDisplay
        harness.waitForEvents(3)

        XCTAssertEqual(harness.recorder.events.map(\.phase), [.move, .down, .up])
        XCTAssertEqual(harness.recorder.events.last?.pid, harness.target.pid)
        XCTAssertEqual(harness.recorder.events.last?.point, CGPoint(x: 960, y: 540),
                       "with no drag delivered the up returns to the down point")
        XCTAssertFalse(harness.controller.interactionEnabled)
    }

    func testUpOutsideTheLetterboxIsForcedToTheLastDeliveredPoint() {
        let harness = Harness(viewSize: viewSize, test: self)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        harness.press(.down, at: CGPoint(x: 960, y: 600))
        harness.waitForEvents(2)
        harness.press(.drag, at: CGPoint(x: 1_200, y: 660))
        harness.waitForEvents(3)
        // Released with the pointer dragged up into the letterbox margin, which maps to no
        // global point at all.
        harness.press(.up, at: CGPoint(x: 960, y: 20))
        harness.waitForEvents(4)

        XCTAssertEqual(harness.recorder.events.map(\.phase), [.move, .down, .drag, .up])
        XCTAssertEqual(harness.recorder.events.last?.point, CGPoint(x: 1_200, y: 600))

        harness.controller.interactionEnabled = false
        harness.expectNoFurtherEvents()
        XCTAssertEqual(harness.recorder.events.count, 4,
                       "an up that was already delivered must not be sent twice")
    }

    func testCompletedClickLeavesNothingForTheTransitionToRelease() {
        let harness = Harness(viewSize: viewSize, test: self)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        harness.press(.down, at: CGPoint(x: 960, y: 600))
        harness.waitForEvents(2)
        harness.press(.up, at: CGPoint(x: 960, y: 600))
        harness.waitForEvents(3)

        harness.controller.interactionEnabled = false
        harness.expectNoFurtherEvents()
        XCTAssertEqual(harness.recorder.events.map(\.phase), [.move, .down, .up])
    }

    func testTitleBarDragMovesTheWindowInsteadOfPostingPointerEvents() {
        let harness = Harness(viewSize: viewSize, test: self, dragStartsOnTitleBar: true)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        // View and display share a size here, so view points are global points.
        harness.press(.down, at: CGPoint(x: 400, y: 110))
        harness.press(.drag, at: CGPoint(x: 500, y: 160))
        harness.press(.up, at: CGPoint(x: 520, y: 170))
        harness.waitForMoves(2)
        harness.expectNoFurtherEvents()

        XCTAssertEqual(harness.recorder.events, [],
                       "the app sees no pointer events for a title-bar drag")
        let moves = harness.recorder.moves
        XCTAssertEqual(moves.first?.origin, CGPoint(x: 200, y: 150))
        XCTAssertEqual(moves.last?.origin, CGPoint(x: 220, y: 160),
                       "the up always lands the window where the pointer let go")
        XCTAssertEqual(Set(moves.map(\.windowID)), [91])
    }

    func testTitleBarDragKeepsTheWindowInsideTheSessionArea() {
        let drag = MirrorInput.WindowDrag(
            element: AXUIElementCreateApplication(getpid()),
            windowID: 1,
            startFrame: CGRect(x: 100, y: 100, width: 800, height: 600),
            startPoint: CGPoint(x: 400, y: 110))
        let area = CGRect(x: 0, y: 0, width: 1_920, height: 1_080)
        XCTAssertEqual(drag.origin(for: CGPoint(x: -900, y: -500), within: area), .zero)
        XCTAssertEqual(drag.origin(for: CGPoint(x: 9_000, y: 9_000), within: area),
                       CGPoint(x: 1_120, y: 480))
        let wide = MirrorInput.WindowDrag(
            element: AXUIElementCreateApplication(getpid()),
            windowID: 1,
            startFrame: CGRect(x: 0, y: 0, width: 3_000, height: 2_000),
            startPoint: .zero)
        XCTAssertEqual(wide.origin(for: CGPoint(x: 500, y: 500), within: area), .zero,
                       "a window larger than the area pins its title bar in reach")
    }

    func testOnlyWindowChromeStartsAWindowDrag() {
        XCTAssertTrue(MirrorInput.startsWindowDrag(hitRole: "AXWindow", parentRole: nil,
                                                   depthBelowTop: 12))
        XCTAssertTrue(MirrorInput.startsWindowDrag(hitRole: "AXStaticText", parentRole: "AXWindow",
                                                   depthBelowTop: 12))
        XCTAssertTrue(MirrorInput.startsWindowDrag(hitRole: "AXGroup", parentRole: "AXToolbar",
                                                   depthBelowTop: 40))
        XCTAssertFalse(MirrorInput.startsWindowDrag(hitRole: "AXButton", parentRole: "AXToolbar",
                                                    depthBelowTop: 40))
        XCTAssertFalse(MirrorInput.startsWindowDrag(hitRole: "AXStaticText", parentRole: "AXGroup",
                                                    depthBelowTop: 12))
        XCTAssertFalse(MirrorInput.startsWindowDrag(hitRole: "AXWindow", parentRole: nil,
                                                    depthBelowTop: 300),
                       "window background below the chrome is content")
    }

    func testAccessibilityPressedControlHoldsNoButtonToRelease() {
        let harness = Harness(viewSize: viewSize, test: self, accessibilityPressSucceeds: true)
        harness.controller.display = harness.display
        harness.controller.interactionEnabled = true

        harness.press(.down, at: CGPoint(x: 960, y: 600))
        harness.controller.interactionEnabled = false

        harness.expectNoFurtherEvents()
        XCTAssertEqual(harness.recorder.events, [],
                       "an AXPress posts no pointer down, so it strands no button")
    }

    // MARK: - Harness

    private final class Harness {
        let recorder = PostedPointerRecorder()
        let controller: ViewerInputController
        let target: SpaceOKit.WindowRef
        let display: DisplayEntry
        let otherDisplay: DisplayEntry
        private let viewSize: CGSize
        private unowned let test: XCTestCase

        init(viewSize: CGSize, test: XCTestCase, accessibilityPressSucceeds: Bool = false,
             dragStartsOnTitleBar: Bool = false) {
            self.viewSize = viewSize
            self.test = test
            display = Self.stage(id: 11)
            otherDisplay = Self.stage(id: 12)
            let candidate = MirrorInput.WindowCandidate(
                windowID: 91,
                pid: getpid() + 3,
                layer: 0,
                bounds: display.bounds,
                title: "Untitled",
                appName: "TextEdit"
            )
            target = candidate.ref
            let recorder = self.recorder
            controller = ViewerInputController(
                keyPoster: { _, _, _, _, _ in },
                frontWindowProvider: { _ in nil },
                pointerPoster: recorder.record,
                candidateProvider: { [candidate] },
                accessibilityPress: { _, _ in accessibilityPressSucceeds },
                pointerRouteCapture: { _ in nil },
                windowDragResolver: { candidate, global in
                    guard dragStartsOnTitleBar else { return nil }
                    // The element is opaque here: the mover below is stubbed and never uses it.
                    return MirrorInput.WindowDrag(
                        element: AXUIElementCreateApplication(candidate.pid),
                        windowID: candidate.windowID,
                        startFrame: CGRect(x: 100, y: 100, width: 800, height: 600),
                        startPoint: global)
                },
                windowMover: { [recorder] drag, origin in
                    recorder.recordMove(windowID: drag.windowID, origin: origin)
                }
            )
        }

        func press(_ phase: MirrorInput.PointerPhase, at viewPoint: CGPoint) {
            controller.pointer(phase, button: .left, viewPoint: viewPoint,
                               viewSize: viewSize, clickCount: 1, template: nil)
        }

        /// Delivery and transition cleanup both run on the controller's own queue, so every step
        /// has to be observed rather than assumed complete when the call returns.
        func waitForEvents(_ count: Int, line: UInt = #line) {
            let reached = test.expectation(description: "\(count) pointer events delivered")
            reached.assertForOverFulfill = false
            let alreadyRecorded = recorder.observe { total in
                if total >= count { reached.fulfill() }
            }
            if alreadyRecorded >= count { reached.fulfill() }
            test.wait(for: [reached], timeout: 5)
            recorder.observe(nil)
        }

        func waitForMoves(_ count: Int) {
            let deadline = Date().addingTimeInterval(5)
            while recorder.moves.count < count, Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            }
            XCTAssertGreaterThanOrEqual(recorder.moves.count, count)
        }

        func expectNoFurtherEvents(line: UInt = #line) {
            let unexpected = test.expectation(description: "no further pointer events")
            unexpected.isInverted = true
            recorder.observe { _ in unexpected.fulfill() }
            test.wait(for: [unexpected], timeout: 0.5)
            recorder.observe(nil)
        }

        private static func stage(id: CGDirectDisplayID) -> DisplayEntry {
            DisplayEntry(
                id: id,
                bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
                isSpaceO: true,
                isActive: true,
                name: "Stage \(id)"
            )
        }
    }
}

private struct PostedPointer: Equatable {
    let phase: MirrorInput.PointerPhase
    let button: MouseButton
    let point: CGPoint
    let windowID: CGWindowID
    let pid: pid_t
}

private final class PostedPointerRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [PostedPointer] = []
    private var handler: ((Int) -> Void)?

    var events: [PostedPointer] {
        lock.withLock { stored }
    }

    private var storedMoves: [(windowID: CGWindowID, origin: CGPoint)] = []
    var moves: [(windowID: CGWindowID, origin: CGPoint)] {
        lock.withLock { storedMoves }
    }

    func recordMove(windowID: CGWindowID, origin: CGPoint) -> Bool {
        lock.withLock { storedMoves.append((windowID, origin)) }
        return true
    }

    /// Installs an observer and reports how many events are already recorded in the same critical
    /// section, so a caller cannot miss one that lands between checking and observing.
    @discardableResult
    func observe(_ handler: ((Int) -> Void)?) -> Int {
        lock.withLock {
            self.handler = handler
            return stored.count
        }
    }

    func record(_ phase: MirrorInput.PointerPhase, _ button: MouseButton, _ global: CGPoint,
                _ target: SpaceOKit.WindowRef, _ clickCount: Int, _ template: CGEvent?) throws {
        let event = PostedPointer(phase: phase, button: button, point: global,
                                  windowID: target.windowID, pid: target.pid)
        let (count, observer) = lock.withLock { () -> (Int, ((Int) -> Void)?) in
            stored.append(event)
            return (stored.count, handler)
        }
        observer?(count)
    }
}
