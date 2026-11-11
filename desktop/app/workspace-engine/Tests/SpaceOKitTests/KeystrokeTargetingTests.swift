import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Where a keystroke actually lands, decided before it is sent.
///
/// `CGEventPostToPid` addresses a process, and the process routes the event to its own key
/// window. `InputRouter.prepareForInput` was the step meant to make that window the one the
/// caller named, and it returns immediately — doing nothing at all — when the host has no
/// focus-without-raise record. Every host without that private path (`spaceo doctor`: `MISS
/// focus-without-raise`) therefore delivered `--window A` to whatever window the application
/// already had focused, and returned `ok`.
///
/// Measured on 2026-08-29 against TextEdit with two documents open:
///
/// ```
/// $ spaceo type "MARKER-INTO-ALPHA " --window 15506     # 15506 == DOC-ALPHA
/// before  15505 DOC-BETA  : "BETA-ORIGINAL-CONTENT"
/// before  15506 DOC-ALPHA : "ALPHA-ORIGINAL-CONTENT"
/// after   15505 DOC-BETA  : "MARKER-INTO-ALPHA BETA-ORIGINAL-CONTENT"   <- the text went here
/// after   15506 DOC-ALPHA : "ALPHA-ORIGINAL-CONTENT"                    <- the window asked for
/// ```
///
/// The text was written into a document the caller never named, and the command reported success.
/// `type` and `key` share this delivery path, so they share the decision — and a misrouted
/// `cmd+s` saves the wrong document, which is the worse of the two.
final class KeystrokeTargetingTests: XCTestCase {

    private func decide(
        requested: CGWindowID,
        focused: CGWindowID?,
        windows: Int,
        action: String = "type"
    ) -> InputRouter.KeystrokeTargeting {
        InputRouter.keystrokeTargeting(
            requestedWindowID: requested,
            focusedWindowID: focused,
            windowsOwnedByTarget: windows,
            action: action)
    }

    private func refusal(_ decision: InputRouter.KeystrokeTargeting) -> String? {
        guard case let .refuse(message) = decision else { return nil }
        return message
    }

    // MARK: - The application agrees

    func testDeliversWhenTheApplicationFocusesTheRequestedWindow() {
        XCTAssertEqual(decide(requested: 15_506, focused: 15_506, windows: 2), .deliver)
    }

    // MARK: - The application disagrees

    func testRefusesWhenTheApplicationFocusesADifferentWindow() {
        let message = try? XCTUnwrap(
            refusal(decide(requested: 15_506, focused: 15_505, windows: 2)))
        let text = try? XCTUnwrap(message)
        XCTAssertTrue(text?.contains("15506") == true && text?.contains("15505") == true, """
            the refusal has to name both windows — the one asked for and the one that would \
            actually have received the input: \(text ?? "<no refusal>")
            """)
    }

    /// The same wrong-window answer must refuse for `key`, not only for `type`.
    func testRefusalCoversKeyPressesToo() {
        let decision = decide(
            requested: 15_506, focused: 15_505, windows: 2, action: "press a key in")
        XCTAssertNotNil(refusal(decision),
                        "a misrouted cmd+s saves a document the caller never named")
        XCTAssertTrue(refusal(decision)?.contains("press a key in") == true)
    }

    // MARK: - The application will not say

    /// Unknown focus is the un-attributable case, and with a second window to misroute into it
    /// must fail closed. This is the branch that used to warn and send anyway.
    func testRefusesWhenFocusIsUnknownAndTheProcessOwnsMoreThanOneWindow() {
        for focused in [CGWindowID?.none, .some(CGWindowID(0))] {
            let decision = decide(requested: 15_506, focused: focused, windows: 2)
            let message = refusal(decision)
            XCTAssertNotNil(message, """
                focus \(String(describing: focused)) with 2 windows is exactly "I cannot tell \
                which window gets this"; sending is how the wrong document gets written
                """)
            XCTAssertTrue(message?.contains("2 windows") == true, message ?? "")
        }
    }

    /// ...but a process with exactly one window has nowhere else to route, so refusing there
    /// would ground the ordinary single-window agent for no safety gain.
    func testDeliversUnverifiedWhenFocusIsUnknownAndTheProcessOwnsExactlyOneWindow() {
        switch decide(requested: 15_506, focused: nil, windows: 1) {
        case let .deliverUnverified(note):
            XCTAssertFalse(note.isEmpty, "an unverified delivery has to say so")
        default:
            XCTFail("a single-window target must still be drivable")
        }
    }

    /// Zero is not "one or fewer". A count that does not even include the window we were handed
    /// is a disagreement about what this process owns, not a licence to send blind.
    func testRefusesWhenFocusIsUnknownAndTheTargetOwnsNoKnownWindows() {
        XCTAssertNotNil(
            refusal(decide(requested: 15_506, focused: nil, windows: 0)),
            """
            the session lists no window for this pid, so the window id we were handed cannot be \
            reconciled against it; unknown focus plus an unknown window set is the least \
            attributable state there is
            """)
    }

    /// A zero window id cannot be compared against anything.
    func testRefusesWithoutAWindowToAimAt() {
        XCTAssertNotNil(refusal(decide(requested: 0, focused: 15_505, windows: 1)))
        XCTAssertNotNil(refusal(decide(requested: 0, focused: nil, windows: 1)))
    }
}
