import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import SpaceOPrivate

public enum MouseButton: String, Sendable, CaseIterable {
    case left, right, middle

    var downType: CGEventType {
        switch self {
        case .left:   return .leftMouseDown
        case .right:  return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left:   return .leftMouseUp
        case .right:  return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    var draggedType: CGEventType {
        switch self {
        case .left:   return .leftMouseDragged
        case .right:  return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }

    var cgButton: CGMouseButton {
        switch self {
        case .left:   return .left
        case .right:  return .right
        case .middle: return .center
        }
    }

    public static func parse(_ raw: String?) throws -> MouseButton {
        guard let raw, !raw.isEmpty else { return .left }
        guard let button = MouseButton(rawValue: raw.lowercased()) else {
            throw SpaceOError.badRequest(
                "button must be one of "
                + MouseButton.allCases.map(\.rawValue).joined(separator: ", "))
        }
        return button
    }
}

/// Modifier keys held down for the duration of a pointer action.
///
/// Parsed separately from `KeyCombo` because a modifier-held click has no key of its own —
/// `shift`, `cmd`, `alt`, `ctrl` and `fn` are the whole request.
public enum ModifierKeys {
    public static func parse(_ names: [String]?) throws -> CGEventFlags {
        guard let names, !names.isEmpty else { return [] }
        guard names.count <= 5 else {
            throw SpaceOError.badRequest("at most 5 modifiers may be held")
        }
        var flags: CGEventFlags = []
        for name in names {
            switch name.lowercased() {
            case "cmd", "command":       flags.insert(.maskCommand)
            case "shift":                flags.insert(.maskShift)
            case "alt", "opt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control":      flags.insert(.maskControl)
            case "fn":                   flags.insert(.maskSecondaryFn)
            default:
                throw SpaceOError.badRequest(
                    "unknown modifier '\(name)' (use cmd, shift, alt, ctrl, or fn)")
            }
        }
        return flags
    }
}

/// A parsed keystroke such as `cmd+s` or `return`.
public struct KeyCombo: Sendable, Equatable {
    public let keyCode: CGKeyCode
    public let flags: CGEventFlags

    /// `key` actions: a whole press, or only its down or up half.
    public static let actions = ["tap", "down", "up"]
    /// How long a tap may hold its key before releasing it.
    public static let holdMillisecondsRange = 0...5_000

    /// Command-C and Command-X can replace the shared pasteboard; Command-V can disclose it.
    /// Extra modifiers do not make them safe: applications are free to bind variants such as
    /// Command-Shift-C to another kind of copy.
    var accessesSharedPasteboard: Bool {
        flags.contains(.maskCommand) && (keyCode == 8 || keyCode == 7 || keyCode == 9)
    }

    func requireClipboardSafeRoute() throws {
        guard !accessesSharedPasteboard else {
            throw SpaceOError.unsupportedTarget(
                "clipboard-safe Command-C/Command-X/Command-V delivery is unavailable: copy and "
                + "cut can overwrite the shared user pasteboard, while paste can disclose its "
                + "contents to an agent app. Use a non-clipboard read/edit action; enabling these "
                + "shortcuts requires an isolated per-session clipboard broker.")
        }
    }

    public static func parse(_ input: String) throws -> KeyCombo {
        guard !input.isEmpty, input.count <= 64, input.utf8.count <= 256 else {
            throw SpaceOError.badRequest(
                "key combo must be 1 through 64 characters and at most 256 UTF-8 bytes")
        }
        let parts = input.lowercased().split(separator: "+").map(String.init)
        guard let keyName = parts.last else { throw SpaceOError.badRequest("empty key combo") }

        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            switch modifier {
            case "cmd", "command":       flags.insert(.maskCommand)
            case "shift":                flags.insert(.maskShift)
            case "alt", "opt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control":      flags.insert(.maskControl)
            case "fn":                   flags.insert(.maskSecondaryFn)
            default: throw SpaceOError.badRequest("unknown modifier '\(modifier)'")
            }
        }
        guard let code = Self.keyCodes[keyName] else {
            throw SpaceOError.badRequest("unknown key '\(keyName)' (try a letter, digit, or return/tab/esc/space/delete/arrow)")
        }
        return KeyCombo(keyCode: code, flags: flags)
    }

    static let keyCodes: [String: CGKeyCode] = {
        var map: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
            "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
            "escape": 53, "esc": 53, "forwarddelete": 117,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        ]
        for n in 1...12 { map["f\(n)"] = CGKeyCode([122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][n - 1]) }
        return map
    }()
}

/// A validated wheel delta, and the one place SpaceO's scroll convention is written down.
///
/// SpaceO speaks in *gesture* terms on both axes: positive `dy` scrolls content up, moving the
/// view back towards the top, and positive `dx` is that same gesture sideways — the view moves
/// back towards the left, revealing earlier columns. Every surface derives its own signs from
/// this type rather than restating them, because the three surfaces disagree with each other:
/// a scroll bar's value and a DOM wheel delta both count *offset from the origin*, so they run
/// opposite to the gesture, while `CGEvent`'s wheel already matches it. `dy` used to be negated
/// for DevTools and `dx` passed through raw, which left a horizontal scroll walking one way in
/// a native window and the other way on a page in the same session.
public struct ScrollDelta: Sendable, Equatable {
    public let dx: Int32
    public let dy: Int32
    public let ticks: Int

    public init(dx: Int32, dy: Int32, ticks: Int) throws {
        guard (1...100).contains(ticks) else {
            throw SpaceOError.badRequest("scroll ticks must be from 1 through 100")
        }
        guard (-10_000...10_000).contains(dx), (-10_000...10_000).contains(dy) else {
            throw SpaceOError.badRequest("scroll deltas must be from -10000 through 10000 pixels")
        }
        guard dx != 0 || dy != 0 else {
            throw SpaceOError.badRequest("scroll needs a non-zero dx or dy")
        }
        self.dx = dx
        self.dy = dy
        self.ticks = ticks
    }

    /// Pixels to move along the vertical scroll bar, whose value grows downwards from the top.
    public var axVerticalPixels: CGFloat { CGFloat(-dy) }

    /// Pixels to move along the horizontal scroll bar, whose value grows rightwards.
    public var axHorizontalPixels: CGFloat { CGFloat(-dx) }

    /// `CGEvent(scrollWheelEvent2Source:)` is already gesture-signed on both axes.
    public var wheel1: Int32 { dy }
    public var wheel2: Int32 { dx }

    /// DOM wheel deltas are scroll-offset increments: positive `deltaY` raises `scrollTop`,
    /// positive `deltaX` raises `scrollLeft`. Both are therefore the gesture negated.
    public var domDeltaX: Double { Double(-dx) }
    public var domDeltaY: Double { Double(-dy) }
}

/// Delivers input to a specific process without touching the cursor or the frontmost app.
///
/// Order matters. `focus` flips input routing only; it never calls
/// `SLPSSetFrontProcessWithOptions`, which is the one API that would raise the window and drag
/// the user to the app's Space.
public enum InputRouter {

    public struct UserInputRoute {
        let app: NSRunningApplication
        let windowID: CGWindowID
    }

    // MARK: - Focus

    enum FocusRecord: Int, CaseIterable, Sendable {
        case activation = 1
        case keyDown = 2
        case keyUp = 3

        var description: String {
            switch self {
            case .activation: return "activation"
            case .keyDown: return "key-window down"
            case .keyUp: return "key-window up"
            }
        }
    }

    /// A failed private record is not evidence of no mutation. Once a record was attempted the
    /// only safe response is to restore and verify the route captured before the transaction.
    enum FocusAttempt: Equatable, Sendable {
        case notAttempted
        case failed(after: FocusRecord)
        case succeeded
    }

    typealias FocusPrimitive = (pid_t, CGWindowID) -> FocusAttempt
    typealias RouteRestorer = (UserInputRoute) -> Bool

    static func privateFocusAttempt(pid: pid_t, windowID: CGWindowID) -> FocusAttempt {
        switch SPOFocusWithoutRaiseResult(pid, windowID) {
        case .notAttempted:
            return .notAttempted
        case .failedAfterActivationRecord:
            return .failed(after: .activation)
        case .failedAfterKeyDownRecord:
            return .failed(after: .keyDown)
        case .failedAfterKeyUpRecord:
            return .failed(after: .keyUp)
        case .succeeded:
            return .succeeded
        @unknown default:
            // An unknown result came back from a private mutation boundary. Treat it as
            // mutation-possible rather than inventing a safe "not attempted" state.
            return .failed(after: .activation)
        }
    }

    private static func unverifiedRecoveryError(_ context: String) -> SpaceOError {
        .unsupportedTarget(
            "\(context) may have changed the system input route, and SpaceO could not verify "
            + "restoration. Input was not sent. Click or activate the app you were using to "
            + "recover keyboard input, then retry after running `spaceo doctor`.")
    }

    /// Execute the three-record private transaction. Every mutation-possible failure restores
    /// the exact route captured before record one; an unverifiable restore is a hard input error.
    @discardableResult
    static func applyFocus(
        _ window: WindowRef,
        recoveringTo originalRoute: UserInputRoute,
        attempt: FocusPrimitive = privateFocusAttempt,
        restore: RouteRestorer = restoreUserInputRoute,
        settle: () -> Void = { usleep(120_000) }
    ) throws -> Bool {
        switch attempt(window.pid, window.windowID) {
        case .notAttempted:
            // No private record was posted, so there is no partial mutation to repair. Optional
            // input priming may safely fall back to direct per-PID delivery.
            return false
        case .failed(let record):
            guard restore(originalRoute) else {
                throw unverifiedRecoveryError(
                    "focus failed at the \(record.description) record for pid \(window.pid)")
            }
            throw SpaceOError.unsupportedTarget(
                "pid \(window.pid) refused the \(record.description) focus record; "
                + "the original user input route was restored and input was not sent")
        case .succeeded:
            settle()
            return true
        }
    }

    /// Make `window` the input target of its app without raising it or switching Space.
    ///
    /// The original route is captured first so a partial private failure can always be repaired.
    public static func focus(_ window: WindowRef) throws {
        guard SPOCapabilityAvailable(.focusWithoutRaise) else {
            let name = SPOCapabilityName(.focusWithoutRaise)
            let reason = SPOCapabilityUnavailableReason(.focusWithoutRaise)
            throw SpaceOError.unavailable(
                capability: reason.map { "\(name): \($0)" } ?? name
            )
        }
        let originalRoute = try captureUserInputRoute(excluding: [window.pid])
        guard try applyFocus(window, recoveringTo: originalRoute) else {
            throw SpaceOError.unsupportedTarget(
                "pid \(window.pid) could not begin the focus transaction; input was not sent")
        }
    }

    /// Prime an agent window for per-PID input, then immediately give the global input route
    /// back to the user's existing frontmost app.
    ///
    /// `SPOFocusWithoutRaise` does not raise the agent's window, but its first record still makes
    /// that process active for WindowServer input routing. Leaving that route in place can make
    /// the user's keyboard and pointer appear frozen even though their screen and applications
    /// are otherwise alive. Per-PID events only need the agent window to have been made key
    /// *within its own app*; they do not need the agent to remain the global input route.
    public static func prepareForInput(_ window: WindowRef) throws {
        // Priming improves compatibility but never justifies an un-restorable mutation. If no
        // route can be captured, skip priming and retain direct per-PID delivery.
        guard SPOCapabilityAvailable(.focusWithoutRaise) else { return }
        try prepareForInput(
            window,
            capturedRoute: { try? captureUserInputRoute(excluding: [window.pid]) },
            attempt: privateFocusAttempt,
            restore: restoreUserInputRoute,
            settle: { usleep(120_000) })
    }

    /// Injectable transaction used by focused recovery tests. A throwing result guarantees the
    /// caller will not proceed to its per-PID key, text, or pointer delivery.
    static func prepareForInput(
        _ window: WindowRef,
        capturedRoute: () -> UserInputRoute?,
        attempt: FocusPrimitive,
        restore: RouteRestorer,
        settle: () -> Void = {}
    ) throws {
        guard let userRoute = capturedRoute() else { return }
        guard try applyFocus(
            window,
            recoveringTo: userRoute,
            attempt: attempt,
            restore: restore,
            settle: settle)
        else {
            return
        }
        guard restore(userRoute) else {
            throw unverifiedRecoveryError(
                "focus priming for pid \(window.pid) succeeded, but route recovery")
        }
    }

    /// Hold the target's WindowServer input route for a pointer transaction.
    ///
    /// Some AppKit controls discard per-PID mouse events unless their window remains the
    /// process's input target through mouse-down and mouse-up. This compatibility wrapper is
    /// retained for interactive viewer input. Agent input uses `beginPointerInputChecked(_:)`,
    /// which fails closed when focus recovery cannot be verified.
    public static func beginPointerInput(_ window: WindowRef) -> UserInputRoute? {
        try? beginPointerInputChecked(window)
    }

    /// Agent-input form of `beginPointerInput`: partial failures are restored, and unverifiable
    /// restoration is surfaced so the caller cannot continue posting pointer events.
    public static func beginPointerInputChecked(_ window: WindowRef) throws -> UserInputRoute? {
        guard SPOCapabilityAvailable(.focusWithoutRaise),
              let route = try? captureUserInputRoute(excluding: [window.pid])
        else { return nil }
        guard try applyFocus(window, recoveringTo: route) else { return nil }
        return route
    }

    public static func endPointerInput(_ route: UserInputRoute?) {
        guard let route else { return }
        _ = restoreUserInputRoute(route)
    }

    public static func endPointerInputChecked(_ route: UserInputRoute?) throws {
        guard let route else { return }
        guard restoreUserInputRoute(route) else {
            throw unverifiedRecoveryError("pointer transaction route recovery")
        }
    }

    static func captureUserInputRoute(
        excluding agentPIDs: Set<pid_t> = []
    ) throws -> UserInputRoute {
        guard let app = NSWorkspace.shared.frontmostApplication,
              !agentPIDs.contains(app.processIdentifier) else {
            throw SpaceOError.unsupportedTarget(
                "no safe user input route is available; refusing to focus the agent window")
        }

        let appElement = AX.application(app.processIdentifier)
        AX.setTimeout(appElement, seconds: 1.0)
        let focusedWindow = AX.element(appElement, kAXFocusedWindowAttribute as String)
        let windowID = focusedWindow.map(AX.windowID) ?? 0
        return UserInputRoute(app: app, windowID: windowID)
    }

    static func userRouteIsCurrent(_ route: UserInputRoute) -> Bool {
        let pid = route.app.processIdentifier
        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard frontmostPID == pid else {
            return false
        }
        // When capture identified a concrete focused window, restoring only the application is
        // insufficient: another window in that application can be key and receive the user's
        // next keystroke. An unreadable or mismatched focused window therefore fails closed.
        guard route.windowID != 0 else {
            return routeIdentityMatches(
                expectedPID: pid,
                expectedWindowID: 0,
                frontmostPID: frontmostPID,
                focusedWindowID: nil)
        }
        let appElement = AX.application(pid)
        guard AX.setTimeout(appElement, seconds: 0.25),
              let focused = AX.element(appElement, kAXFocusedWindowAttribute as String)
        else {
            return false
        }
        return routeIdentityMatches(
            expectedPID: pid,
            expectedWindowID: route.windowID,
            frontmostPID: frontmostPID,
            focusedWindowID: AX.windowID(focused))
    }

    /// Pure identity check kept separate from the AX query so same-process/wrong-window
    /// recovery has deterministic regression coverage.
    static func routeIdentityMatches(
        expectedPID: pid_t,
        expectedWindowID: CGWindowID,
        frontmostPID: pid_t?,
        focusedWindowID: CGWindowID?
    ) -> Bool {
        guard frontmostPID == expectedPID else { return false }
        return expectedWindowID == 0 || focusedWindowID == expectedWindowID
    }

    /// What to do with a keystroke aimed at a specific window, given where the application says
    /// its focus actually is.
    public enum KeystrokeTargeting: Equatable {
        /// The application agrees the requested window has focus.
        case deliver
        /// Focus is unknown, but the target owns exactly one window, so there is nowhere else
        /// inside that process for the keystroke to land. Carries the disclosure.
        case deliverUnverified(String)
        /// Delivery would land somewhere the caller did not ask for. Carries the refusal.
        case refuse(String)
    }

    /// Which channel a `type` or `key` goes through.
    public enum KeystrokeRoute: Equatable, Sendable {
        /// Per-pid keyboard events to the application's key window.
        case native
        /// DevTools input into page content. `automatic` when SpaceO chose it because the
        /// agent's last click went to a page element, rather than the caller passing `web`.
        case devTools(automatic: Bool)

        public var receiptRoute: String? {
            switch self {
            case .native: return nil
            case .devTools(let automatic): return automatic ? "chromium-devtools (auto)" : "chromium-devtools"
            }
        }
    }

    /// Pure routing decision for keystrokes, kept apart from the session so it is testable.
    ///
    /// After `click element:"w3"` focuses a page field, plain `type` used to go to the
    /// browser's own UI — synthetic keys never reach a renderer — unless the agent remembered
    /// `web:true`. When `web` is omitted, follow the last click: if it landed in page content of
    /// this same window and a DevTools bridge exists, type there. An explicit `web` always wins,
    /// and `devToolsCanCarry` false (held keys, separate down/up) keeps the native route.
    public static func keystrokeRoute(
        web: Bool?,
        windowID: CGWindowID,
        pid: pid_t,
        hasBridge: Bool,
        lastPointer: PointerFocusMemory?,
        devToolsCanCarry: Bool = true
    ) -> KeystrokeRoute {
        if let web { return web ? .devTools(automatic: false) : .native }
        guard hasBridge, devToolsCanCarry, let lastPointer, lastPointer.web,
              lastPointer.windowID == windowID, lastPointer.pid == pid else { return .native }
        return .devTools(automatic: true)
    }

    /// Turn a keystroke refusal into its structured error. When the application named another
    /// focused window, the agent's next step is mechanical — read that window — so it gets
    /// `focus_elsewhere` with a runnable recovery instead of a terminal `bad_request`.
    static func keystrokeRefusalError(
        _ message: String,
        requestedWindowID: CGWindowID,
        focusedWindowID: CGWindowID?
    ) -> SpaceOError {
        guard let focusedWindowID, focusedWindowID != 0, focusedWindowID != requestedWindowID else {
            return .badRequest(message)
        }
        return .focusElsewhere(windowID: focusedWindowID, detail: message)
    }

    /// Pure targeting decision, kept separate from the AX query the way `routeIdentityMatches`
    /// is, so every branch has deterministic regression coverage.
    ///
    /// `CGEventPostToPid` addresses a *process*, and the process routes to its own key window.
    /// The only question that matters before sending is therefore "is the window I was asked to
    /// type into the one this application will route to", and there are three honest answers:
    ///
    /// * yes — deliver;
    /// * no — refuse, because sending would write the caller's text into a document it did not
    ///   name and then report success;
    /// * I cannot tell — which is *also* a refusal as soon as the process owns more than one
    ///   window, because "unknown" and "correct" are not the same answer and the cost of being
    ///   wrong is somebody else's document. Exactly one window is the one case where unknown is
    ///   harmless: there is no second window to misroute to, so refusing there would ground the
    ///   ordinary single-window agent for no gain. *Zero* is not that case — it means the count
    ///   disagrees with the window we were handed, and a count we cannot reconcile is another
    ///   way of saying we do not know where this is going.
    public static func keystrokeTargeting(
        requestedWindowID: CGWindowID,
        focusedWindowID: CGWindowID?,
        windowsOwnedByTarget: Int,
        action: String
    ) -> KeystrokeTargeting {
        guard requestedWindowID != 0 else {
            return .refuse("refusing to \(action): no window id to aim at.")
        }
        if let focusedWindowID, focusedWindowID != 0 {
            guard focusedWindowID != requestedWindowID else { return .deliver }
            return .refuse("""
                refusing to \(action): window \(requestedWindowID) is not where this \
                application's keystrokes go — it reports window \(focusedWindowID) as focused, \
                and per-pid delivery follows the application's own key window. Sending anyway \
                would put the input in the wrong window and report success. Address window \
                \(focusedWindowID), or bring \(requestedWindowID) forward first (a click inside \
                it is usually enough).
                """)
        }
        guard windowsOwnedByTarget == 1 else {
            return .refuse("""
                refusing to \(action): this application will not say which of its \
                \(windowsOwnedByTarget) windows has focus, so there is no way to tell whether \
                window \(requestedWindowID) is the one that would receive the input. Close or \
                address the other windows, or bring \(requestedWindowID) forward first.
                """)
        }
        return .deliverUnverified("""
            \(action) was delivered to the only window this application has, but it did not \
            report a focused window and this host has no focus-without-raise record, so the \
            keystrokes reaching that window is not directly confirmed.
            """)
    }

    @discardableResult
    static func restoreUserInputRoute(_ route: UserInputRoute) -> Bool {
        guard NSRunningApplication(processIdentifier: route.app.processIdentifier) != nil else {
            return false
        }

        var posted = false
        if SPOCapabilityAvailable(.focusWithoutRaise),
           route.windowID != 0,
           privateFocusAttempt(
               pid: route.app.processIdentifier,
               windowID: route.windowID) == .succeeded {
            posted = true
        }
        if !posted {
            // Some applications do not expose AXFocusedWindow. Public activation is the
            // fallback; the target was already frontmost before the operation.
            posted = route.app.activate()
        }
        guard posted else { return false }

        // Private key/typing/front-process getters are not queried: resolving a private symbol
        // does not prove its ABI. Verify restoration through AppKit's public frontmost-app state.
        let deadline = Date().addingTimeInterval(1.0)
        repeat {
            if userRouteIsCurrent(route) {
                return true
            }
            usleep(20_000)
        } while Date() < deadline

        // One last public activation can recover an accepted-but-ineffective private record.
        if route.app.activate() {
            let fallbackDeadline = Date().addingTimeInterval(1.0)
            repeat {
                if userRouteIsCurrent(route) {
                    return true
                }
                usleep(20_000)
            } while Date() < fallbackDeadline
        }
        return false
    }

    // MARK: - Keyboard

    /// One unit of typing work: a literal scalar carried in a unicode event, or a Return.
    enum Keystroke: Equatable {
        case scalar(Unicode.Scalar)
        case returnKey
    }

    /// The single definition of how text becomes keystrokes: newline scalars become Return
    /// keystrokes (many controls ignore \n in a unicode string) and "\r\n" is one line break,
    /// not two. Both the send loop and the pre-flight duration estimate consume this, so the
    /// estimate cannot drift from what is actually typed.
    static func keystrokes(for text: String) -> [Keystroke] {
        var out: [Keystroke] = []
        out.reserveCapacity(text.unicodeScalars.count)
        var previous: Unicode.Scalar?
        for scalar in text.unicodeScalars {
            defer { previous = scalar }
            if scalar == "\n" || scalar == "\r" {
                if scalar == "\n", previous == "\r" { continue }
                out.append(.returnKey)
                continue
            }
            out.append(.scalar(scalar))
        }
        return out
    }

    /// Type literal text into `pid`. Unicode-safe: characters are carried as a unicode string
    /// rather than synthesised from keycodes, so accents and emoji work.
    public static func type(_ text: String, to pid: pid_t, charactersPerSecond: Double = 90) throws {
        try validateTyping(text, charactersPerSecond: charactersPerSecond)
        let source = CGEventSource(stateID: .hidSystemState)
        let delay = UInt32(max(1_000, 1_000_000 / charactersPerSecond))

        for keystroke in Self.keystrokes(for: text) {
            switch keystroke {
            case .returnKey:
                try key(KeyCombo(keyCode: 36, flags: []), to: pid)
            case .scalar(let character):
                var utf16 = Array(String(character).utf16)
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                else { continue }
                down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                try postEventToPID(down, pid: pid)
                try postEventToPID(up, pid: pid)
                usleep(delay)
            }
        }
    }

    public static func validateTyping(
        _ text: String,
        charactersPerSecond: Double = 90
    ) throws {
        let scalars = text.unicodeScalars
        guard text.count <= 8_000, scalars.count <= 8_000,
              text.utf8.count <= 32_000 else {
            throw SpaceOError.badRequest(
                "text is too long (maximum 8000 characters/scalars "
                + "and 32000 UTF-8 bytes)")
        }
        guard charactersPerSecond.isFinite, (1...1_000).contains(charactersPerSecond) else {
            throw SpaceOError.badRequest(
                "typing speed must be a finite value from 1 through 1000 characters per second")
        }
        let estimatedSeconds = estimatedTypingSeconds(text, charactersPerSecond: charactersPerSecond)
        guard estimatedSeconds <= 110 else {
            throw SpaceOError.badRequest(
                "typing request would take about \(Int(estimatedSeconds.rounded())) seconds; "
                + "maximum is 110")
        }
    }

    /// Cost model over the same `keystrokes(for:)` stream `type(_:to:)` sends, so the duration
    /// gate and the actual typing agree by construction. Internal for regression tests.
    static func estimatedTypingSeconds(_ text: String, charactersPerSecond: Double) -> Double {
        var returnCount = 0
        var ordinaryCount = 0
        for keystroke in keystrokes(for: text) {
            if keystroke == .returnKey { returnCount += 1 } else { ordinaryCount += 1 }
        }
        return Double(ordinaryCount) / charactersPerSecond + Double(returnCount) * 0.045
    }

    public static func key(_ combo: KeyCombo, to pid: pid_t) throws {
        try deliverKey(combo) {
            try postKey(combo, to: pid)
        }
    }

    /// Shared production/test seam so recognition and guarding cannot drift apart. The real
    /// route supplies `postKey`; tests observe whether delivery was attempted.
    static func deliverKey(
        _ combo: KeyCombo,
        delivery: () throws -> Void
    ) throws {
        // Deliberately inspect no pasteboard state. There is no safe shared-pasteboard
        // transaction to start, so fail before synthesising either key event. This applies to
        // paste as well as copy/cut: reading the user's clipboard into an agent app is a leak.
        try combo.requireClipboardSafeRoute()
        try delivery()
    }

    /// One half of a key press, for `hold_ms` and explicit down/up actions (SPAO-140). Goes
    /// through the same clipboard guard as `key`, so a held Command-V is refused exactly like
    /// a tapped one.
    public static func keyEvent(_ combo: KeyCombo, down: Bool, to pid: pid_t) throws {
        try combo.requireClipboardSafeRoute()
        let source = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
        else { throw SpaceOError.badRequest("could not synthesise key event") }
        event.flags = combo.flags
        try postEventToPID(event, pid: pid)
    }

    private static func postKey(_ combo: KeyCombo, to pid: pid_t) throws {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: false)
        else { throw SpaceOError.badRequest("could not synthesise key event") }
        down.flags = combo.flags
        up.flags = combo.flags
        try postEventToPID(down, pid: pid)
        usleep(15_000)
        try postEventToPID(up, pid: pid)
        usleep(30_000)
    }

    // MARK: - Mouse

    /// `kCGMouseEventWindowUnderMousePointer`. Not exposed in the Swift overlay.
    static let windowUnderPointer = CGEventField(rawValue: 91)!
    /// `kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent`.
    static let windowUnderPointerThatCanHandleEvent = CGEventField(rawValue: 92)!

    /// Convert a window-local point to global coordinates, refusing points outside the window.
    ///
    /// Agent-facing pointer coordinates are window-local **points**, which is what a screenshot
    /// taken at scale 1 hands back directly. The 1 pt tolerance covers a border click landing
    /// exactly on the edge after the WindowServer's own rounding.
    static func globalPoint(
        _ localPoint: CGPoint,
        in window: WindowRef,
        bounds: CGRect,
        what: String
    ) throws -> CGPoint {
        guard localPoint.x.isFinite, localPoint.y.isFinite else {
            throw SpaceOError.badRequest("\(what) coordinates must be finite")
        }
        let global = CGPoint(x: bounds.origin.x + localPoint.x, y: bounds.origin.y + localPoint.y)
        guard bounds.insetBy(dx: -1, dy: -1).contains(global) else {
            throw SpaceOError.badRequest(
                String(format: "%@ point (%.0f,%.0f) is outside the window (%.0fx%.0f). "
                       + "Coordinates are window-local points; if you read them from a screenshot "
                       + "taken at scale 2, divide by 2.",
                       what, localPoint.x, localPoint.y, bounds.width, bounds.height))
        }
        return global
    }

    /// One pointer transaction against a single window.
    ///
    /// Click, hover, drag and scroll all need the same three things — the target's input route
    /// held for the duration, every event stamped with the window it happened over, and a
    /// verified route restore afterwards. Sharing one body is what keeps a new action from
    /// quietly skipping the stamp: posting straight to a pid bypasses the WindowServer, which is
    /// normally what tells the app which window an event belongs to, and an unstamped event is
    /// dropped rather than delivered.
    private static func withPointerTransaction(
        _ window: WindowRef,
        _ body: (CGEventSource?, (CGEvent) throws -> Void) throws -> Void
    ) throws {
        let source = CGEventSource(stateID: .hidSystemState)
        let userRoute = try beginPointerInputChecked(window)
        var routeRecoveryVerified = false
        defer {
            if !routeRecoveryVerified {
                // Best effort after an event-construction error or a failed verification. The
                // throwing checked restore below remains the caller-visible source of truth.
                endPointerInput(userRoute)
            }
        }

        func post(_ event: CGEvent) throws {
            event.setIntegerValueField(windowUnderPointer, value: Int64(window.windowID))
            event.setIntegerValueField(
                windowUnderPointerThatCanHandleEvent, value: Int64(window.windowID))
            try postEventToPID(event, pid: window.pid)
        }

        try body(source, post)
        try endPointerInputChecked(userRoute)
        routeRecoveryVerified = true
    }

    /// Click inside a window. `localPoint` is relative to the window's top-left, which is what
    /// an agent reading a window screenshot naturally has.
    ///
    /// The accessibility shortcut is taken only for a plain single left click. A modifier-held,
    /// multi-, or non-left click means something different from `AXPress` — shift-click extends a
    /// selection, double-click selects a word, right-click opens a context menu — so silently
    /// substituting a press would report success for an action that never happened.
    /// How a pointer action actually reached the target, so a caller can tell a confirmed action
    /// from one that was merely posted.
    public enum PointerDelivery: String, Sendable {
        /// An accessibility action the target acknowledged. Confirmed.
        case accessibility
        /// Synthetic events posted per-PID. On a host without the focus-without-raise record
        /// these are **not known to reach AppKit** — measured on macOS 27, a coordinate click
        /// into a TextEdit document did not move the insertion point, and scroll wheel events
        /// moved nothing, while both reported success.
        case syntheticUnverified

        public var isConfirmed: Bool { self == .accessibility }
    }

    @discardableResult
    public static func click(
        _ window: WindowRef,
        at localPoint: CGPoint,
        button: MouseButton = .left,
        clickCount: Int = 1,
        modifiers: CGEventFlags = []
    ) throws -> PointerDelivery {
        guard (1...3).contains(clickCount) else {
            throw SpaceOError.badRequest("click count must be from 1 through 3")
        }
        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
        let global = try globalPoint(localPoint, in: window, bounds: bounds, what: "click")

        if button == .left, clickCount == 1, modifiers.isEmpty,
           press(at: global, in: window.pid, windowID: window.windowID) {
            return .accessibility
        }

        try withPointerTransaction(window) { source, post in
            // A move first: apps that track hover state need to believe the pointer arrived, and
            // Chromium uses it to decide which frame is under the cursor.
            if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                  mouseCursorPosition: global, mouseButton: button.cgButton) {
                move.flags = modifiers
                try post(move)
                usleep(15_000)
            }

            for click in 1...clickCount {
                guard let down = CGEvent(mouseEventSource: source, mouseType: button.downType,
                                         mouseCursorPosition: global, mouseButton: button.cgButton),
                      let up = CGEvent(mouseEventSource: source, mouseType: button.upType,
                                       mouseCursorPosition: global, mouseButton: button.cgButton)
                else { continue }
                for event in [down, up] {
                    event.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                    event.flags = modifiers
                }
                try post(down)
                usleep(25_000)
                try post(up)
                usleep(40_000)
            }
        }
        return .syntheticUnverified
    }

    /// The sentence a caller should show when a pointer action could only be posted, not
    /// confirmed. Kept in one place so click, drag, and hover word it identically.
    public static func unverifiedDeliveryNote(_ action: String) -> String {
        "the \(action) was posted as synthetic per-PID events but could not be confirmed: no "
        + "accessibility element accepted it, and this host has no focus-without-raise record, "
        + "where synthetic pointer events are not known to reach AppKit. Verify with a "
        + "screenshot, or address the control by element index from read_screen."
    }

    public static func unverifiedMotionDeliveryNote(_ action: String) -> String {
        "the \(action) was posted as synthetic per-PID events; delivery to the target and its "
            + "effect were not verified. Check the target's state before relying on the result."
    }

    /// Move the pointer over a window-local point without pressing anything.
    ///
    /// Hover-only affordances — menus that open on hover, tooltips, drag handles that fade in —
    /// are invisible to an agent that can only click, because the control it needs to press does
    /// not exist in the accessibility tree until something hovers it.
    public static func move(
        _ window: WindowRef,
        to localPoint: CGPoint,
        modifiers: CGEventFlags = []
    ) throws {
        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
        let global = try globalPoint(localPoint, in: window, bounds: bounds, what: "move")

        try withPointerTransaction(window) { source, post in
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                     mouseCursorPosition: global, mouseButton: .left)
            else { throw SpaceOError.badRequest("could not synthesise a pointer move") }
            move.flags = modifiers
            try post(move)
            usleep(15_000)
        }
    }

    /// Press at one window-local point, drag to another, and release.
    ///
    /// The intermediate moves are not cosmetic. A down followed immediately by an up at a
    /// different point reads as a click at the destination to most controls; sliders, selection,
    /// and reordering all need to see the pointer travel.
    public static func drag(
        _ window: WindowRef,
        from startLocal: CGPoint,
        to endLocal: CGPoint,
        button: MouseButton = .left,
        modifiers: CGEventFlags = [],
        steps: Int = 12,
        duration: Double? = nil
    ) throws {
        guard (1...200).contains(steps) else {
            throw SpaceOError.badRequest("drag steps must be from 1 through 200")
        }
        if let duration, !duration.isFinite || !(0.05...30).contains(duration) {
            throw SpaceOError.badRequest("drag duration must be from 0.05 through 30 seconds")
        }
        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
        let start = try globalPoint(startLocal, in: window, bounds: bounds, what: "drag start")
        let end = try globalPoint(endLocal, in: window, bounds: bounds, what: "drag end")

        try withPointerTransaction(window) { source, post in
            func mouse(_ type: CGEventType, _ at: CGPoint) throws {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                                          mouseCursorPosition: at, mouseButton: button.cgButton)
                else { throw SpaceOError.badRequest("could not synthesise a drag event") }
                event.flags = modifiers
                event.setIntegerValueField(.mouseEventClickState, value: 1)
                try post(event)
            }

            try mouse(.mouseMoved, start)
            usleep(15_000)
            try mouse(button.downType, start)
            usleep(25_000)
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                try mouse(button.draggedType,
                          CGPoint(x: start.x + (end.x - start.x) * t,
                                  y: start.y + (end.y - start.y) * t))
                if Task<Never, Never>.isCancelled { throw CancellationError() }
                usleep(useconds_t((duration.map { $0 / Double(steps) } ?? 0.012) * 1_000_000))
            }
            try mouse(button.upType, end)
            usleep(40_000)
        }
    }

    /// Scroll over a window-local point, in the convention `ScrollDelta` defines.
    ///
    /// A point is required rather than optional: an app with two scrollable regions routes the
    /// wheel by what is under the pointer, so an unpositioned scroll is a coin flip.
    public static func scroll(
        _ window: WindowRef,
        at localPoint: CGPoint,
        delta: ScrollDelta,
        modifiers: CGEventFlags = []
    ) throws {
        let ticks = delta.ticks
        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
        let global = try globalPoint(localPoint, in: window, bounds: bounds, what: "scroll")

        // Accessibility first, and it is not a nicety. Synthetic scroll wheel events posted with
        // `CGEventPostToPid` do not reach AppKit on a host without the private
        // focus-without-raise record — measured against TextEdit on macOS 27 across pixel and
        // line units, stamped and unstamped, with and without an explicit location: every
        // variant reported success and moved nothing. A scroll bar's AXValue is public, settable,
        // and readable back, so this path can prove it worked.
        if let area = AX.scrollArea(
            at: global, in: window.pid, windowID: window.windowID) {
            var moved = false
            for _ in 0..<ticks {
                if delta.dy != 0,
                   AX.scroll(area, byPixels: delta.axVerticalPixels) != nil { moved = true }
                if delta.dx != 0,
                   AX.scroll(area, byPixels: delta.axHorizontalPixels,
                             horizontal: true) != nil { moved = true }
                usleep(20_000)
            }
            if moved { return }
        }

        // No scroll area, or one that refused: fall back to the synthetic wheel rather than
        // refusing outright, because a canvas or custom surface may consume wheel events without
        // exposing a scroll bar. The caller is told which path ran.
        try withPointerTransaction(window) { source, post in
            // Position the pointer first so the app routes the wheel to the region the agent
            // aimed at rather than wherever it last believed the pointer was.
            if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                  mouseCursorPosition: global, mouseButton: .left) {
                move.flags = modifiers
                try post(move)
                usleep(15_000)
            }
            for _ in 0..<ticks {
                guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                                          wheelCount: 2,
                                          wheel1: delta.wheel1, wheel2: delta.wheel2, wheel3: 0)
                else { throw SpaceOError.badRequest("could not synthesise a scroll event") }
                event.flags = modifiers
                event.location = global
                try post(event)
                usleep(20_000)
            }
        }
        throw SpaceOError.unsupportedTarget(
            "no scrollable accessibility element was found at (\(Int(localPoint.x)),"
            + "\(Int(localPoint.y))), so the scroll fell back to synthetic wheel events. "
            + "This host has no focus-without-raise record, where per-PID wheel events are not "
            + "known to reach AppKit — treat this scroll as unconfirmed and verify with a "
            + "screenshot rather than assuming the view moved.")
    }

    // MARK: - Accessibility actions (preferred)

    /// Press an element directly. Coordinate-free, focus-free, cannot miss, works occluded.
    /// This is the path an agent should use whenever the element is addressable.
    public static func press(_ element: AXUIElement) throws {
        let available = AX.actions(element)
        for candidate in [kAXPressAction, kAXConfirmAction, kAXPickAction, "AXOpen"] {
            if available.contains(candidate as String), AX.perform(element, candidate as String) {
                return
            }
        }
        throw SpaceOError.elementNotPressable(role: AX.role(element), actions: available)
    }

    /// Press the accessible control at a global screen point, inside one exact window.
    ///
    /// AppKit accepts AXPress while it can discard coordinate mouse events posted straight to
    /// a background pid. A missing element/action is not a refusal: callers fall through to raw
    /// pointer delivery for canvases, games and custom surfaces.
    ///
    /// The window id is required, not optional. Hit-testing an application answers with its
    /// frontmost window at the point, so a press aimed at a background window of the same app —
    /// two TextEdit documents at identical frames — would fire on the wrong window's control and
    /// still be reported as a confirmed action. An element outside the requested window is
    /// treated as no element at all, which drops the caller to unconfirmed synthetic delivery
    /// and the warning that goes with it.
    public static func press(at global: CGPoint, in pid: pid_t, windowID: CGWindowID) -> Bool {
        guard let element = AX.element(at: global, in: pid, windowID: windowID),
              AX.actions(element).contains(kAXPressAction as String) else {
            return false
        }
        return AX.perform(element, kAXPressAction as String)
    }

    /// Set a text field's value outright — faster and more reliable than typing, and it never
    /// touches the keyboard focus at all.
    public static func setValue(_ element: AXUIElement, _ text: String) throws {
        guard text.count <= 8_000, text.unicodeScalars.count <= 8_000,
              text.utf8.count <= 32_000 else {
            throw SpaceOError.badRequest(
                "text is too long (maximum 8000 characters/scalars "
                + "and 32000 UTF-8 bytes)")
        }
        guard AX.setString(element, kAXValueAttribute as String, text) else {
            throw SpaceOError.unsupportedTarget("element rejected a value assignment")
        }
    }
}

/// Where the agent's most recent click or drag went: which window, which process, and whether
/// DevTools delivered it into page content. Only these actions move keyboard focus; a scroll or
/// hover leaves it where it was.
public struct PointerFocusMemory: Equatable, Sendable {
    public let windowID: CGWindowID
    public let pid: pid_t
    public let web: Bool

    public init(windowID: CGWindowID, pid: pid_t, web: Bool) {
        self.windowID = windowID
        self.pid = pid
        self.web = web
    }
}
