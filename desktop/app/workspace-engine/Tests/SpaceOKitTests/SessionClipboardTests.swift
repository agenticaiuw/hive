import XCTest
import CoreGraphics
@testable import SpaceOKit

/// SPAO-143/160: the per-session clipboard broker and its pure routing table.
final class SessionClipboardTests: XCTestCase {

    // MARK: - Bounds

    func testSetGetRoundTripAndByteCount() throws {
        let clipboard = SessionClipboard()
        XCTAssertTrue(clipboard.isEmpty)
        XCTAssertNil(clipboard.get())
        XCTAssertEqual(clipboard.byteCount, 0)

        try clipboard.set("héllo")
        XCTAssertEqual(clipboard.get(), "héllo")
        XCTAssertEqual(clipboard.byteCount, "héllo".utf8.count)
        XCTAssertFalse(clipboard.isEmpty)
    }

    func testAcceptsExactlyMaximumBytesAndRefusesOneMore() throws {
        let clipboard = SessionClipboard()
        let atLimit = String(repeating: "a", count: SessionClipboard.maximumBytes)
        try clipboard.set(atLimit)
        XCTAssertEqual(clipboard.byteCount, SessionClipboard.maximumBytes)

        XCTAssertThrowsError(try clipboard.set(atLimit + "b")) { error in
            guard case .badRequest = error as? SpaceOError else {
                return XCTFail("expected badRequest, got \(error)")
            }
        }
        // A refused write leaves the previous contents intact.
        XCTAssertEqual(clipboard.byteCount, SessionClipboard.maximumBytes)
    }

    func testRejectsNUL() throws {
        let clipboard = SessionClipboard()
        try clipboard.set("before")
        XCTAssertThrowsError(try clipboard.set("a\u{0}b")) { error in
            guard case .badRequest = error as? SpaceOError else {
                return XCTFail("expected badRequest, got \(error)")
            }
        }
        XCTAssertEqual(clipboard.get(), "before")
    }

    func testEmptyStringIsStoredButDistinctFromCleared() throws {
        let clipboard = SessionClipboard()
        try clipboard.set("")
        XCTAssertEqual(clipboard.get(), "")
        XCTAssertFalse(clipboard.isEmpty)
        XCTAssertEqual(clipboard.byteCount, 0)
    }

    // MARK: - Clear on demand

    func testClearDropsContents() throws {
        let clipboard = SessionClipboard()
        try clipboard.set("secret")
        clipboard.clear()
        XCTAssertNil(clipboard.get())
        XCTAssertTrue(clipboard.isEmpty)
        XCTAssertEqual(clipboard.byteCount, 0)
        clipboard.clear()   // idempotent
        XCTAssertTrue(clipboard.isEmpty)
    }

    // MARK: - Intercept mapping

    func testInterceptMapsPlainCommandShortcuts() throws {
        XCTAssertEqual(ClipboardRoute.intercept(for: try KeyCombo.parse("cmd+c")), .copy)
        XCTAssertEqual(ClipboardRoute.intercept(for: try KeyCombo.parse("command+x")), .cut)
        XCTAssertEqual(ClipboardRoute.intercept(for: try KeyCombo.parse("cmd+v")), .paste)
    }

    func testInterceptReturnsNilForModifiedVariantsAndOtherKeys() throws {
        for combo in ["cmd+shift+c", "cmd+shift+v", "cmd+option+x", "cmd+ctrl+v", "cmd+fn+c"] {
            XCTAssertNil(ClipboardRoute.intercept(for: try KeyCombo.parse(combo)), combo)
            // Those variants stay under the existing shared-pasteboard refusal.
            XCTAssertTrue(try KeyCombo.parse(combo).accessesSharedPasteboard, combo)
        }
        for combo in ["c", "v", "shift+c", "ctrl+c", "cmd+a", "cmd+z", "cmd+return"] {
            XCTAssertNil(ClipboardRoute.intercept(for: try KeyCombo.parse(combo)), combo)
        }
    }

    func testInterceptedCombosAreExactlyTheGuardedOnes() throws {
        // Every combo the broker intercepts is one the guard would otherwise refuse, so
        // brokering never widens what reaches the shared pasteboard.
        for combo in ["cmd+c", "cmd+x", "cmd+v"] {
            let parsed = try KeyCombo.parse(combo)
            XCTAssertNotNil(ClipboardRoute.intercept(for: parsed))
            XCTAssertTrue(parsed.accessesSharedPasteboard)
        }
    }

    // MARK: - Paste route table

    func testPasteRouteTable() {
        XCTAssertEqual(ClipboardRoute.pasteRoute(focusedElementSettable: true, isChromium: true), "devtools")
        XCTAssertEqual(ClipboardRoute.pasteRoute(focusedElementSettable: false, isChromium: true), "devtools")
        XCTAssertEqual(ClipboardRoute.pasteRoute(focusedElementSettable: true, isChromium: false), "accessibility")
        XCTAssertEqual(ClipboardRoute.pasteRoute(focusedElementSettable: false, isChromium: false), "typing")
    }

    func testRefusalNoteMentionsScopeAndBridge() {
        for intercept in [ClipboardRoute.Intercept.copy, .cut, .paste] {
            let withBridge = ClipboardRoute.refusalNote(for: intercept, hasBridge: true)
            XCTAssertTrue(withBridge.contains("plain text"))
            XCTAssertTrue(withBridge.contains("files"))
            XCTAssertFalse(withBridge.contains("No DevTools bridge"))
            let withoutBridge = ClipboardRoute.refusalNote(for: intercept, hasBridge: false)
            XCTAssertTrue(withoutBridge.contains("No DevTools bridge"))
        }
        XCTAssertTrue(ClipboardRoute.refusalNote(for: .cut, hasBridge: true).hasPrefix("cut "))
    }

    // MARK: - Source invariant

    func testSessionClipboardSourceNeverReferencesTheSharedPasteboard() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // SpaceOKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // repo root
        let source = root.appendingPathComponent("Sources/SpaceOKit/SessionClipboard.swift")
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("NSPasteboard"), "SessionClipboard must never touch the shared pasteboard")
        XCTAssertFalse(text.contains("import AppKit"), "SessionClipboard must not import AppKit")
    }
}
