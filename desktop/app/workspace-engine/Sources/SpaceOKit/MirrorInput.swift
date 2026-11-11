import Foundation
import AppKit
import CoreGraphics
import SpaceOPrivate

/// Per-PID input forwarding for a human driving an agent display through the viewer.
///
/// Delivery follows the same rules as `InputRouter`: events are posted straight to the target
/// process and stamped with the window they belong to; nothing is activated, raised, or warped,
/// and the focus-routing primitive is not needed. The difference is shape — a viewer
/// forwards a live stream of pointer and keyboard events rather than synthesising one complete
/// click, so these primitives are stateless and sleep-free and the caller supplies pacing.
public enum MirrorInput {

    // MARK: - Self-exclusion
    //
    // Viewing a *physical* display is legitimate — that is how you drive an app that is not on a
    // stage. But the viewer's own window is on that display too, so hit testing could select it,
    // and delivery would post a synthetic event straight back into the process that generated
    // it. The result is a loop: each forwarded click produces another click, the queue grows,
    // and the user watches the viewer operate its own controls.
    //
    // Two layers. Callers exclude their PID from selection, which is where the fix belongs; and
    // the delivery primitives refuse it outright, which is what catches the path someone adds
    // later and forgets to filter.

    /// PIDs that must never receive synthetic input from this process.
    public static var selfExcludedPIDs: Set<pid_t> { [getpid()] }

    private static func rejectSelfDelivery(to pid: pid_t) throws {
        guard pid != getpid() else {
            throw SpaceOError.unsupportedTarget(
                "refusing to deliver synthetic input to SpaceO itself (pid \(pid)); "
                + "the viewer cannot drive its own window")
        }
    }

    // MARK: - Viewport geometry

    /// Maps points in an aspect-fit view of a display back to global screen coordinates.
    ///
    /// The rendering layer letterboxes with `resizeAspect`; this struct is the same math in
    /// reverse, so input and pixels cannot disagree. View points use a top-left origin.
    public struct ViewportMapping: Equatable {
        public let displayBounds: CGRect
        /// Where the display's pixels land inside the view. `.zero` when either rect is degenerate.
        public let contentRect: CGRect

        public init(
            displayBounds: CGRect,
            viewSize: CGSize,
            zoom: CGFloat = 1,
            pan: CGPoint = .zero,
            stretch: Bool = ProcessInfo.processInfo.environment["SPACEO_FULLSCREEN_STRETCH"] == "1"
        ) {
            self.displayBounds = displayBounds
            guard displayBounds.width.isFinite, displayBounds.height.isFinite,
                  viewSize.width.isFinite, viewSize.height.isFinite,
                  zoom.isFinite, zoom >= 1,
                  pan.x.isFinite, pan.y.isFinite,
                  displayBounds.width > 0, displayBounds.height > 0,
                  viewSize.width > 0, viewSize.height > 0 else {
                self.contentRect = .zero
                return
            }
            let scale = min(viewSize.width / displayBounds.width,
                            viewSize.height / displayBounds.height)
            let fittedSize = stretch ? viewSize : CGSize(width: displayBounds.width * scale,
                                                         height: displayBounds.height * scale)
            let fittedOrigin = CGPoint(
                x: (viewSize.width - fittedSize.width) / 2,
                y: (viewSize.height - fittedSize.height) / 2
            )
            let clampedPan = CGPoint(
                x: min(1, max(-1, pan.x)),
                y: min(1, max(-1, pan.y))
            )
            let size = CGSize(width: fittedSize.width * zoom,
                              height: fittedSize.height * zoom)
            let overflow = CGSize(width: size.width - fittedSize.width,
                                  height: size.height - fittedSize.height)
            self.contentRect = CGRect(
                x: fittedOrigin.x - overflow.width * (clampedPan.x + 1) / 2,
                y: fittedOrigin.y - overflow.height * (clampedPan.y + 1) / 2,
                                      width: size.width,
                                      height: size.height)
        }

        /// The global point under a view point, or nil in the letterbox margins.
        public func globalPoint(fromViewPoint viewPoint: CGPoint) -> CGPoint? {
            guard contentRect.width > 0, contentRect.height > 0,
                  contentRect.contains(viewPoint) else { return nil }
            let fractionX = (viewPoint.x - contentRect.minX) / contentRect.width
            let fractionY = (viewPoint.y - contentRect.minY) / contentRect.height
            return CGPoint(x: displayBounds.minX + fractionX * displayBounds.width,
                           y: displayBounds.minY + fractionY * displayBounds.height)
        }

        /// A global rect projected into view coordinates — for drawing session-tile overlays.
        public func viewRect(fromGlobalRect rect: CGRect) -> CGRect? {
            guard contentRect.width > 0, contentRect.height > 0,
                  displayBounds.width > 0, displayBounds.height > 0 else { return nil }
            let scaleX = contentRect.width / displayBounds.width
            let scaleY = contentRect.height / displayBounds.height
            return CGRect(x: contentRect.minX + (rect.minX - displayBounds.minX) * scaleX,
                          y: contentRect.minY + (rect.minY - displayBounds.minY) * scaleY,
                          width: rect.width * scaleX,
                          height: rect.height * scaleY)
        }
    }

    // MARK: - Host shortcut capture

    /// Suppress or restore host-global shortcuts while the Viewer owns an explicit input
    /// capture. This does not pause the agent or claim daemon ownership; it only changes where
    /// the human operator's local keystrokes go.
    @discardableResult
    public static func setHostGlobalShortcutsEnabled(_ enabled: Bool) -> Bool {
        SPOSetGlobalHotKeysEnabled(enabled)
    }

    // MARK: - Window hit-testing

    /// One on-screen window as the WindowServer reports it, front-to-back.
    public struct WindowCandidate: Equatable {
        public let windowID: CGWindowID
        public let pid: pid_t
        public let layer: Int
        public let bounds: CGRect
        public let title: String
        public let appName: String

        public init(windowID: CGWindowID, pid: pid_t, layer: Int,
                    bounds: CGRect, title: String, appName: String) {
            self.windowID = windowID
            self.pid = pid
            self.layer = layer
            self.bounds = bounds
            self.title = title
            self.appName = appName
        }

        public var ref: WindowRef {
            WindowRef(windowID: windowID, pid: pid, title: title, frame: bounds)
        }
    }

    /// Every on-screen window, frontmost first, straight from the WindowServer.
    public static func onScreenCandidates() -> [WindowCandidate] {
        let options: CGWindowListOption = [.optionOnScreenOnly]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
                as? [[String: Any]] else { return [] }
        return list.compactMap { info in
            guard let windowID = info[kCGWindowNumber as String] as? Int, windowID > 0,
                  let pid = info[kCGWindowOwnerPID as String] as? Int,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            if let alpha = info[kCGWindowAlpha as String] as? Double, alpha <= 0 { return nil }
            return WindowCandidate(
                windowID: CGWindowID(windowID),
                pid: pid_t(pid),
                layer: info[kCGWindowLayer as String] as? Int ?? 0,
                bounds: bounds,
                title: info[kCGWindowName as String] as? String ?? "",
                appName: info[kCGWindowOwnerName as String] as? String ?? "")
        }
    }

    /// The frontmost window containing `point`.
    public static func selectTarget(
        from candidates: [WindowCandidate],
        containing point: CGPoint,
        excluding excludedPIDs: Set<pid_t> = []
    ) -> WindowCandidate? {
        targets(from: candidates, containing: point, excluding: excludedPIDs).first
    }

    /// Every eligible window under a point, preserving WindowServer front-to-back order.
    ///
    /// Viewer pointer-down uses the full list to find an actionable Accessibility control below
    /// click-through overlays before falling back to the geometrically frontmost canvas/window.
    public static func targets(
        from candidates: [WindowCandidate],
        containing point: CGPoint,
        excluding excludedPIDs: Set<pid_t> = []
    ) -> [WindowCandidate] {
        candidates.filter { candidate in
            !excludedPIDs.contains(candidate.pid) && candidate.bounds.contains(point)
        }
    }

    /// The window that should receive an event at a global point.
    public static func target(
        at global: CGPoint,
        excluding excludedPIDs: Set<pid_t> = []
    ) -> WindowRef? {
        selectTarget(from: onScreenCandidates(), containing: global,
                     excluding: excludedPIDs)?.ref
    }

    /// The frontmost window whose centre sits on the given display — the keyboard
    /// destination before the user has clicked anything.
    public static func frontWindow(
        on displayBounds: CGRect,
        excluding excludedPIDs: Set<pid_t> = []
    ) -> WindowRef? {
        onScreenCandidates().first { candidate in
            !excludedPIDs.contains(candidate.pid)
                && displayBounds.contains(CGPoint(x: candidate.bounds.midX,
                                                  y: candidate.bounds.midY))
        }?.ref
    }

    // MARK: - Pointer

    public enum PointerPhase: Equatable, Sendable {
        case move, down, drag, up
    }

    static func eventType(for phase: PointerPhase, button: MouseButton) -> CGEventType {
        switch phase {
        case .move: return .mouseMoved
        case .down: return button.downType
        case .up:   return button.upType
        case .drag: return button == .left ? .leftMouseDragged : .rightMouseDragged
        }
    }

    public static func postPointer(
        _ phase: PointerPhase,
        button: MouseButton = .left,
        at global: CGPoint,
        to target: WindowRef,
        clickCount: Int = 1,
        template: CGEvent? = nil
    ) throws {
        try rejectSelfDelivery(to: target.pid)
        guard global.x.isFinite, global.y.isFinite else {
            throw SpaceOError.badRequest("pointer coordinates must be finite")
        }
        guard (1...3).contains(clickCount) else {
            throw SpaceOError.badRequest("click count must be from 1 through 3")
        }
        let event: CGEvent?
        if let template, let copy = template.copy() {
            copy.type = eventType(for: phase, button: button)
            copy.location = global
            event = copy
        } else {
            let source = CGEventSource(stateID: .hidSystemState)
            event = CGEvent(mouseEventSource: source,
                            mouseType: eventType(for: phase, button: button),
                            mouseCursorPosition: global,
                            mouseButton: button.cgButton)
        }
        guard let event else {
            throw SpaceOError.badRequest("could not synthesise mouse event")
        }
        if phase != .move {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        }
        stamp(event, windowID: target.windowID)
        try postEventToPID(event, pid: target.pid)
    }

    /// Forward a scroll at a global point. Deltas are in pixels, positive `dy` scrolls up.
    public static func postScroll(
        dx: Int32,
        dy: Int32,
        at global: CGPoint,
        to target: WindowRef
    ) throws {
        try rejectSelfDelivery(to: target.pid)
        guard global.x.isFinite, global.y.isFinite else {
            throw SpaceOError.badRequest("scroll coordinates must be finite")
        }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                                  wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
            throw SpaceOError.badRequest("could not synthesise scroll event")
        }
        event.location = global
        stamp(event, windowID: target.windowID)
        try postEventToPID(event, pid: target.pid)
    }

    // MARK: - Keyboard

    /// Forward one key transition. When `characters` carries plain text it rides along as the
    /// event's unicode payload, so accented input survives keyboard-layout differences.
    public static func postKey(
        code: CGKeyCode,
        flags: CGEventFlags,
        down: Bool,
        characters: String? = nil,
        to pid: pid_t
    ) throws {
        try rejectSelfDelivery(to: pid)
        let source = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(keyboardEventSource: source,
                                  virtualKey: code, keyDown: down) else {
            throw SpaceOError.badRequest("could not synthesise key event")
        }
        event.flags = flags
        if let characters, shouldCarryUnicode(characters) {
            var utf16 = Array(characters.utf16)
            event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        }
        try postEventToPID(event, pid: pid)
    }

    /// Control characters and AppKit's function-key code points (U+F700…U+F8FF) must not be
    /// carried as literal text — the virtual key code already says what they are, and a unicode
    /// payload would make some apps insert garbage glyphs for arrows and deletes.
    public static func shouldCarryUnicode(_ characters: String) -> Bool {
        guard !characters.isEmpty, characters.utf16.count <= 32 else { return false }
        return characters.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x20
                && scalar.value != 0x7F
                && !(0xF700...0xF8FF).contains(scalar.value)
        }
    }

    public static func flags(from modifiers: NSEvent.ModifierFlags) -> CGEventFlags {
        var flags: CGEventFlags = []
        if modifiers.contains(.command)  { flags.insert(.maskCommand) }
        if modifiers.contains(.shift)    { flags.insert(.maskShift) }
        if modifiers.contains(.option)   { flags.insert(.maskAlternate) }
        if modifiers.contains(.control)  { flags.insert(.maskControl) }
        if modifiers.contains(.function) { flags.insert(.maskSecondaryFn) }
        if modifiers.contains(.capsLock) { flags.insert(.maskAlphaShift) }
        return flags
    }

    // MARK: - Stamping

    /// Same trick as `InputRouter.click`: per-PID delivery bypasses the WindowServer, so the
    /// "which window is this over" fields must be filled in by hand or apps drop the event.
    private static func stamp(_ event: CGEvent, windowID: CGWindowID) {
        event.setIntegerValueField(InputRouter.windowUnderPointer,
                                   value: Int64(windowID))
        event.setIntegerValueField(InputRouter.windowUnderPointerThatCanHandleEvent,
                                   value: Int64(windowID))
    }
}
