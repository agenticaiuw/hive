import XCTest
import CoreGraphics
@testable import SpaceOKit

/// `type` confirms itself by printing the text it believes it just wrote. That confirmation is
/// only worth anything if it describes the window the caller named.
///
/// The read-back used to be `AXTree.focusedValue(pid:)` — the application's focused element,
/// app-wide. Typing is delivered per-pid after a focus attempt that this host cannot verify
/// (`spaceo doctor` reports `focus-without-raise` as MISS), so when the attempt does not take,
/// the keystrokes land in whichever window the app already had focused. Observed on 2026-08-29
/// against TextEdit with two documents open: `spaceo_type --window 13262` answered
/// `window text now: <the text of window 13261>`, and nothing in the response distinguished that
/// from success.
///
/// `AXTree`'s own documentation had already named this hazard — "app-wide, so ambiguous when an
/// app has several windows", and the live suite reads back with `AXTree.text(in: window)` for
/// exactly this reason — but the shipped tool used the ambiguous reader anyway.
///
/// The AX queries themselves need a real application, so the rule they turn on is extracted the
/// way `InputRouter.routeIdentityMatches` is, and pinned here.
final class TypeReadBackAttributionTests: XCTestCase {

    func testFocusedValueIsAttributableOnlyToTheFocusedWindow() {
        XCTAssertTrue(
            AXTree.focusedValueIsAttributable(focusedWindowID: 4_242, to: 4_242),
            "the app agrees our window has focus, so its focused element is our window's")
        XCTAssertFalse(
            AXTree.focusedValueIsAttributable(focusedWindowID: 4_243, to: 4_242),
            "the app is focused on another of its windows; reporting that window's text as ours "
            + "is the misattribution this rule exists to prevent")
    }

    /// "Could not tell" is the case that produced the defect, so it must not resolve to "yes".
    func testAnUnknownFocusedWindowIsNotAMatch() {
        XCTAssertFalse(
            AXTree.focusedValueIsAttributable(focusedWindowID: nil, to: 4_242),
            "the app did not answer kAXFocusedWindow; that is unknown, not agreement")
        XCTAssertFalse(
            AXTree.focusedValueIsAttributable(focusedWindowID: 0, to: 4_242),
            "_AXUIElementGetWindow returns 0 when it cannot resolve a window id, and 0 is not a "
            + "window that can match")
        XCTAssertFalse(
            AXTree.focusedValueIsAttributable(focusedWindowID: 0, to: 0),
            "two unknowns are not each other")
    }
}
