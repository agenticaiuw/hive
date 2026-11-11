import AppKit
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// PAR-55. A Command-modified shortcut reaches the surface through `performKeyEquivalent`, and
/// AppKit delivers no `keyUp:` to the responder chain while Command is held. Forwarding only the
/// down left the remote app holding the key and left the input controller routing that key code
/// to that app forever, so later keystrokes landed in whatever window took the last shortcut.
///
/// These exercise the surface seam and the controller's held-key bookkeeping. No synthetic input
/// is posted to another process, so a failure cannot escape the test runner.
@MainActor
final class KeyEquivalentReleaseTests: XCTestCase {

    /// Window ids for windows that must not exist. The controller asks the WindowServer whether
    /// its pinned key target is still alive, and small ids are real: 71, 72 and 73 on this host
    /// all resolve to the 1512x33 menu bar. A fixture that collides with a live window is
    /// reported as alive, so the pin never clears and the test silently exercises the wrong path.
    private let unusedWindowID: CGWindowID = 4_000_000_000

    func testCommandKeyEquivalentForwardsAMatchingRelease() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var forwarded: [(down: Bool, keyCode: UInt16, modifiers: NSEvent.ModifierFlags)] = []
        view.onKey = { down, keyCode, modifiers, _ in
            forwarded.append((down, keyCode, modifiers))
        }

        XCTAssertTrue(view.handleKeyEquivalent(try keyEvent(keyCode: 8,
                                                            modifiers: [.command],
                                                            characters: "c")))

        XCTAssertEqual(forwarded.map(\.down), [true, false],
                       "a key equivalent never gets a key-up of its own — it must be synthesized")
        XCTAssertEqual(forwarded.map(\.keyCode), [8, 8])
        XCTAssertTrue(forwarded.allSatisfy { $0.modifiers.contains(.command) },
                      "the release carries the same modifiers the remote app saw on the down")
    }

    func testLocalExitKeyEquivalentStillForwardsNothing() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var exitCount = 0
        view.onExitControl = {
            exitCount += 1
            view.interactionEnabled = false
        }
        view.onKey = { _, _, _, _ in XCTFail("the local exit was forwarded") }

        // The reserved chord holds Command, so it arrives as a key equivalent too.
        XCTAssertTrue(view.handleKeyEquivalent(try keyEvent(
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command],
            characters: "\u{1b}"
        )))

        XCTAssertEqual(exitCount, 1)
        XCTAssertFalse(view.interactionEnabled)
    }

    func testKeyEquivalentIsLeftToAppKitWhileControlIsOff() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = false
        view.onKey = { _, _, _, _ in XCTFail("input was forwarded with Control off") }

        XCTAssertFalse(view.handleKeyEquivalent(try keyEvent(keyCode: 8,
                                                             modifiers: [.command],
                                                             characters: "c")),
                       "an unconsumed equivalent must reach the Viewer's own menu items")
    }

    /// Defence in depth for the same hazard: whatever loses a key-up, a stale entry must not
    /// outrank the current key target.
    func testAStaleHeldKeyIsReleasedInsteadOfMisroutingTheNextPress() {
        let textEdit = SpaceOKit.WindowRef(windowID: unusedWindowID + 1,
                                           pid: getpid() + 21,
                                           title: "TextEdit",
                                           frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let notes = SpaceOKit.WindowRef(windowID: unusedWindowID + 2,
                                        pid: getpid() + 22,
                                        title: "Notes",
                                        frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let front = FrontWindowBox(textEdit)
        let shortcutDelivered = expectation(description: "Cmd-C reaches TextEdit")
        let rerouted = expectation(description: "stale release and fresh down delivered")
        rerouted.expectedFulfillmentCount = 2
        // These expectations only sequence the two phases; the event list below is the real
        // assertion. Left asserting, a regression that posts one extra event raises an uncaught
        // NSException from `fulfill()` and terminates the whole test runner, so the failure
        // arrives as a crash with no diagnosis instead of as this test failing.
        shortcutDelivered.assertForOverFulfill = false
        rerouted.assertForOverFulfill = false
        let stalePID = textEdit.pid
        let log = PostedKeyLog { event in
            if event.down, event.pid == stalePID {
                shortcutDelivered.fulfill()
            } else {
                rerouted.fulfill()
            }
        }
        let controller = ViewerInputController(keyPoster: log.record,
                                               frontWindowProvider: { _ in front.value })
        controller.display = keyTestDisplay()
        controller.interactionEnabled = true

        // A key equivalent whose up was lost — the pre-fix `performKeyEquivalent` shape.
        controller.key(down: true, keyCode: 8,
                       modifiers: NSEvent.ModifierFlags.command, characters: "c")
        wait(for: [shortcutDelivered], timeout: 1)

        // The operator clicks Notes and types the same character.
        front.value = notes
        controller.key(down: true, keyCode: 8, modifiers: [], characters: "c")
        wait(for: [rerouted], timeout: 1)

        XCTAssertEqual(log.events, [
            PostedKeyLog.Event(keyCode: 8, down: true, pid: textEdit.pid),
            PostedKeyLog.Event(keyCode: 8, down: false, pid: textEdit.pid),
            PostedKeyLog.Event(keyCode: 8, down: true, pid: notes.pid),
        ], "the stuck key is released where it stuck, and the new press types into Notes")
    }

    func testAutoRepeatStaysWithTheAppHoldingTheKey() {
        let target = SpaceOKit.WindowRef(windowID: unusedWindowID + 3,
                                         pid: getpid() + 23,
                                         title: "TextEdit",
                                         frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let repeated = expectation(description: "every repeat delivered")
        repeated.expectedFulfillmentCount = 3
        let log = PostedKeyLog { _ in repeated.fulfill() }
        let controller = ViewerInputController(keyPoster: log.record,
                                               frontWindowProvider: { _ in target })
        controller.display = keyTestDisplay()
        controller.interactionEnabled = true

        controller.key(down: true, keyCode: 0, modifiers: [], characters: "a")
        controller.key(down: true, keyCode: 0, modifiers: [], characters: "a")
        controller.key(down: false, keyCode: 0, modifiers: [], characters: "a")
        wait(for: [repeated], timeout: 1)

        XCTAssertEqual(log.events.map(\.down), [true, true, false],
                       "a repeat of a still-held key must not synthesize a release")
        XCTAssertTrue(log.events.allSatisfy { $0.pid == target.pid })
    }

    private func keyEvent(keyCode: UInt16,
                          modifiers: NSEvent.ModifierFlags,
                          characters: String) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: keyCode
        ))
    }

    private func keyTestDisplay() -> DisplayEntry {
        DisplayEntry(id: 21,
                     bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
                     isSpaceO: true,
                     isActive: true,
                     name: "Stage 21")
    }
}

/// The front window the controller resolves to, swapped from the test thread while the delivery
/// queue reads it — stands in for the operator clicking a different window.
private final class FrontWindowBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: SpaceOKit.WindowRef

    init(_ initial: SpaceOKit.WindowRef) { stored = initial }

    var value: SpaceOKit.WindowRef {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private final class PostedKeyLog: @unchecked Sendable {
    struct Event: Equatable {
        let keyCode: UInt16
        let down: Bool
        let pid: pid_t
    }

    private let lock = NSLock()
    private var stored: [Event] = []
    private let onEvent: (Event) -> Void

    init(onEvent: @escaping (Event) -> Void) { self.onEvent = onEvent }

    var events: [Event] { lock.withLock { stored } }

    func record(_ code: CGKeyCode, _ flags: CGEventFlags, _ down: Bool,
                _ characters: String?, _ pid: pid_t) throws {
        let event = Event(keyCode: UInt16(code), down: down, pid: pid)
        lock.withLock { stored.append(event) }
        onEvent(event)
    }
}
