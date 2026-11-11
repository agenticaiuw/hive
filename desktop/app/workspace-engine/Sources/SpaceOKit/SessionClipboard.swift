import Foundation
import CoreGraphics

/// A per-session text clipboard that lives entirely inside the daemon (SPAO-143, SPAO-160).
///
/// **Invariant:** this type never reads or writes the shared user pasteboard. It does not import
/// AppKit and contains no reference to the system pasteboard API, so an agent's Command-C /
/// Command-X / Command-V can be brokered without ever overwriting or disclosing the user's own
/// clipboard. `SessionClipboardTests` greps this source file to keep that invariant honest.
///
/// Only plain text is brokered. Rich content (RTF, HTML, images) and file promises are out of
/// scope; the daemon reports those refusals through `ClipboardRoute.refusalNote`.
public final class SessionClipboard: @unchecked Sendable {

    /// Upper bound on stored UTF-8 bytes. Matches the daemon's other text-input ceilings so a
    /// runaway copy cannot pin arbitrary memory in a long-lived session.
    public static let maximumBytes = 1_048_576

    private let lock = NSLock()
    private var text: String?

    public init() {}

    /// Refuses text larger than `maximumBytes` and text containing NUL, which no Accessibility
    /// value setter or keystroke route can deliver faithfully.
    public func set(_ text: String) throws {
        let bytes = text.utf8.count
        guard bytes <= Self.maximumBytes else {
            throw SpaceOError.badRequest(
                "clipboard text is \(bytes) bytes; the per-session clipboard holds at most "
                + "\(Self.maximumBytes) bytes")
        }
        guard !text.utf8.contains(0) else {
            throw SpaceOError.badRequest("clipboard text must not contain NUL characters")
        }
        lock.lock()
        defer { lock.unlock() }
        self.text = text
    }

    public func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return text
    }

    /// Drop the contents. Called on demand and when the owning session is destroyed.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        text = nil
    }

    public var byteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return text?.utf8.count ?? 0
    }

    public var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return text == nil
    }
}

/// Pure decision logic for the daemon's Command-C / Command-X / Command-V interception.
///
/// Every function here is deterministic and free of side effects so the routing table can be
/// tested without a display, an application, or the shared pasteboard.
public enum ClipboardRoute {

    public enum Intercept: Equatable, Sendable {
        case copy
        case cut
        case paste
    }

    private static let copyKeyCode: CGKeyCode = 8   // c
    private static let cutKeyCode: CGKeyCode = 7    // x
    private static let pasteKeyCode: CGKeyCode = 9  // v

    /// Modifier bits that distinguish one shortcut from another. Device-dependent and
    /// non-coalesced bits are ignored, but any extra Shift/Option/Control/Fn makes the combo a
    /// different shortcut that the existing pasteboard guard keeps refusing.
    private static let significantFlags: CGEventFlags = [
        .maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn,
    ]

    /// The clipboard operation a key combo stands for, or nil when the combo should fall through
    /// to the normal key route (and, for `cmd+shift+v`-style variants, its existing refusal).
    public static func intercept(for combo: KeyCombo) -> Intercept? {
        guard combo.flags.intersection(significantFlags) == [.maskCommand] else { return nil }
        switch combo.keyCode {
        case copyKeyCode:  return .copy
        case cutKeyCode:   return .cut
        case pasteKeyCode: return .paste
        default:           return nil
        }
    }

    /// How brokered text should reach the focused control. Values match
    /// `PasteReceipt.insertedVia`.
    ///
    /// Chromium targets go through the DevTools bridge first because their Accessibility value
    /// setter is unreliable for rich editors; native settable elements take the Accessibility
    /// route; everything else falls back to synthesized typing.
    public static func pasteRoute(focusedElementSettable: Bool, isChromium: Bool) -> String {
        if isChromium { return "devtools" }
        if focusedElementSettable { return "accessibility" }
        return "typing"
    }

    public static func refusalNote(for intercept: Intercept, hasBridge: Bool) -> String {
        let verb: String
        switch intercept {
        case .copy:  verb = "copy"
        case .cut:   verb = "cut"
        case .paste: verb = "paste"
        }
        var note = "\(verb) is brokered through the per-session clipboard, which holds plain text "
            + "only; rich content (RTF, HTML, images) and files are out of scope and the shared "
            + "user pasteboard is never touched."
        if !hasBridge {
            note += " No DevTools bridge is attached, so text moves via Accessibility or typing."
        }
        return note
    }
}
