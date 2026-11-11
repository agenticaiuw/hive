import AppKit
import CoreGraphics
import SpaceOKit

/// AppKit drags in QuickDraw's ancient `WindowRef` typedef; in this module the name always
/// means SpaceOKit's window reference.
typealias WindowRef = SpaceOKit.WindowRef

struct InputNote: Equatable, Sendable {
    let text: String
    let isWarning: Bool
}

/// A transition has two restoration opportunities. The first promptly releases an established
/// pointer route; the second catches a route published by a mouse-down that was already running
/// when the input gate changed.
///
/// The cleanup is *scheduled* onto the delivery queue, never awaited. The gate epoch is bumped
/// synchronously before a transition reaches here, so the queued backlog is already invalid;
/// waiting for the queue to reach the cleanup would buy nothing the epoch does not guarantee and
/// would charge every Control and display transition the backlog's worst-case Accessibility
/// latency — seconds of blocked main thread at exactly the moment the UI has to stay responsive.
/// Scheduling also puts the second restore *on* the delivery queue, so it is ordered against the
/// events it is cancelling instead of racing a newly admitted down that is already running.
enum ViewerInputTransition {
    static func drainAndRestore(
        restore: @escaping @Sendable () -> Void,
        scheduling schedule: (@escaping @Sendable () -> Void) -> Void,
        drain: @escaping @Sendable () -> Void
    ) {
        restore()
        schedule {
            drain()
            restore()
        }
    }
}

/// The one keyboard chord the Viewer owns while remote Control is active.
///
/// An unmodified Escape must remain available to remote apps, and Control-Option is VoiceOver's
/// modifier. Control-Command-Escape is therefore reserved locally: it is uncommon in apps,
/// remains reachable with VoiceOver running, and is shown anywhere Control state is described.
enum ViewerControlPolicy {
    static let localExitDescription = "Control-Command-Escape"
    static let localExitKeyCode: UInt16 = 53

    enum KeyDisposition: Equatable {
        case local
        case forward
        case exitControl
    }

    enum ControlRequestDisposition: Equatable {
        case enable
        case disable
        case blocked(String)
    }

    static func keyDisposition(interactionEnabled: Bool,
                               keyCode: UInt16,
                               modifiers: NSEvent.ModifierFlags) -> KeyDisposition {
        guard interactionEnabled else { return .local }
        if isLocalExitChord(keyCode: keyCode, modifiers: modifiers) {
            return .exitControl
        }
        return .forward
    }

    static func isLocalExitChord(keyCode: UInt16,
                                 modifiers: NSEvent.ModifierFlags) -> Bool {
        let meaningful = modifiers.intersection([.command, .control, .option, .shift])
        return keyCode == localExitKeyCode && meaningful == [.command, .control]
    }

    static func controlRequest(enabling: Bool,
                               hasSelectedDisplay: Bool,
                               selectedDisplayIsSpaceO: Bool,
                               hasActiveSession: Bool,
                               streamRunning: Bool,
                               screenRecordingGranted: Bool,
                               accessibilityGranted: Bool) -> ControlRequestDisposition {
        guard enabling else { return .disable }
        guard hasSelectedDisplay else {
            return .blocked("Control unavailable. Select a display first.")
        }
        guard selectedDisplayIsSpaceO else {
            return .blocked(
                "Control unavailable. Physical displays are view-only; select a SpaceO display."
            )
        }
        guard hasActiveSession else {
            return .blocked(
                "Control unavailable. Wait for an active agent session on this display."
            )
        }
        guard streamRunning else {
            return .blocked(
                "Control unavailable. Wait for a live stream before sending input."
            )
        }
        guard screenRecordingGranted else {
            return .blocked(
                "Control unavailable. Screen Recording permission is required to see the "
                    + "display before sending input."
            )
        }
        guard accessibilityGranted else {
            return .blocked(
                "Control unavailable. Accessibility permission is required to send input "
                    + "to the selected display."
            )
        }
        return .enable
    }
}

enum ViewerAccessibility {
    static func surfaceLabel(displayName: String) -> String {
        "Remote display, \(displayName)"
    }

    static func surfaceValue(streamRunning: Bool, controlEnabled: Bool) -> String {
        let stream = streamRunning ? "Live stream" : "Stream unavailable"
        let control = controlEnabled
            ? "Control enabled"
            : "Viewing only"
        return "\(stream). \(control)."
    }

    static func surfaceHelp(streamRunning: Bool,
                            controlEnabled: Bool,
                            controlUnavailableReason: String? = nil) -> String {
        if controlEnabled {
            return "Keyboard and pointer input go to the remote display. Press "
                + "\(ViewerControlPolicy.localExitDescription) to exit Control."
        }
        if let controlUnavailableReason {
            return controlUnavailableReason
        }
        if !streamRunning {
            return "The remote display stream is unavailable. Control cannot be enabled until "
                + "the stream is live."
        }
        return "A streamed remote display. Turn on Control to send keyboard and pointer input."
    }

    static func controlAnnouncement(enabled: Bool, displayName: String?) -> String {
        if enabled {
            let destination = displayName.map { " for \($0)" } ?? ""
            return "Control enabled\(destination). Keyboard and pointer input now go to the "
                + "remote display. Press \(ViewerControlPolicy.localExitDescription) to exit."
        }
        return "Control disabled. Keyboard and pointer input stay on this Mac."
    }
}

/// Turns NSEvents from the console surface into per-PID deliveries on a background queue.
///
/// VM semantics live here: a drag keeps going to the window it started on even when the pointer
/// crosses another window, and the keyboard follows the last window the user clicked. Nothing
/// in this path activates an app, raises a window, or moves the real cursor.
/// Mutable delivery state is either queue-confined or protected by `stateLock`/`routeLock`.
/// UI callbacks are always invoked on the main queue.
final class ViewerInputController: @unchecked Sendable {

    typealias KeyPoster = (_ code: CGKeyCode, _ flags: CGEventFlags, _ down: Bool,
                           _ characters: String?, _ pid: pid_t) throws -> Void
    typealias PointerPoster = (_ phase: MirrorInput.PointerPhase, _ button: MouseButton,
                               _ global: CGPoint, _ target: WindowRef, _ clickCount: Int,
                               _ template: CGEvent?) throws -> Void
    typealias FrontWindowProvider = (_ displayBounds: CGRect) -> WindowRef?
    typealias CandidateProvider = () -> [MirrorInput.WindowCandidate]
    typealias AccessibilityPress = (_ candidate: MirrorInput.WindowCandidate,
                                    _ global: CGPoint) -> Bool
    typealias PointerRouteCapture = (_ target: WindowRef) throws -> InputRouter.UserInputRoute?
    /// A title-bar drag handle for the window under the pointer, or nil for content.
    typealias WindowDragResolver = (_ candidate: MirrorInput.WindowCandidate,
                                    _ global: CGPoint) -> MirrorInput.WindowDrag?
    typealias WindowMover = (_ drag: MirrorInput.WindowDrag, _ origin: CGPoint) -> Bool

    var onNote: ((InputNote?) -> Void)?
    /// Called on the main queue when keystrokes start going to a different window.
    var onKeyTargetChange: ((WindowRef) -> Void)?

    /// SPAO-160 intercept point. Runs on the main thread before a key is admitted; returning
    /// true consumes both the down and the matching up so the remote app never sees a stray
    /// half of a chord. The Viewer uses it for ⌘V, which is brokered through the daemon's
    /// session clipboard rather than typed as a keystroke the remote app would resolve against
    /// its own (empty) pasteboard.
    var keyInterceptor: ((_ down: Bool, _ keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags) -> Bool)?

    private let queue = DispatchQueue(label: "spaceo.viewer.input", qos: .userInteractive)
    private let postKeyEvent: KeyPoster
    private let postPointerEvent: PointerPoster
    private let frontWindowProvider: FrontWindowProvider
    private let candidateProvider: CandidateProvider
    private let accessibilityPress: AccessibilityPress
    private let capturePointerRoute: PointerRouteCapture
    private let resolveWindowDrag: WindowDragResolver
    private let moveWindow: WindowMover
    private let stateLock = NSLock()
    private var _display: DisplayEntry?
    private var _interactionEnabled = false

    /// The authority on whether a queued event may still be delivered. Bumped synchronously on
    /// every Control or display transition, so events already on the queue are invalid before
    /// the cleanup that follows them is even scheduled.
    private let gate = InputControlGate()

    // Queue-confined.
    private var dragTarget: WindowRef?
    /// A window being moved by its title bar. While set, pointer events move the window instead
    /// of reaching the app.
    private var windowDrag: MirrorInput.WindowDrag?
    private var keyTarget: WindowRef? {
        didSet {
            // Tell the UI where keys go now, so the captured banner can name it. Only a change
            // of window is reported; clearing the target is not a destination.
            guard let keyTarget, keyTarget.windowID != oldValue?.windowID
                    || keyTarget.pid != oldValue?.pid else { return }
            DispatchQueue.main.async { [weak self] in self?.onKeyTargetChange?(keyTarget) }
        }
    }
    private var accessibilityPressHandled = false
    private var pointerTransactionBlocked = false
    private var lastMoveUptime: UInt64 = 0
    private var candidateCache: (uptime: UInt64, list: [MirrorInput.WindowCandidate])?
    private var lastNote: InputNote?
    private struct HeldKey {
        let keyCode: UInt16
        let flags: CGEventFlags
        let characters: String?
        let pid: pid_t
    }
    private var heldKeys: [UInt16: HeldKey] = [:]

    /// A pointer button whose down reached a remote window. The point is the last one the button
    /// was successfully delivered at, so a forced or synthesized up lands where the remote app
    /// last saw the pointer instead of at a stale or unmappable location.
    private struct HeldButton {
        let button: MouseButton
        let target: WindowRef
        var point: CGPoint
    }
    private var heldButtons: [MouseButton: HeldButton] = [:]

    /// Held input state that must be released *promptly* on a transition, so it is guarded by a
    /// lock rather than confined to the queue. Restoring the user's input route is the one piece
    /// of cleanup that cannot be allowed to wait behind a backlog of events it is cancelling.
    private let routeLock = NSLock()
    private var pointerRoute: InputRouter.UserInputRoute?

    /// `CGEvent` is an immutable copy by the time it crosses onto the delivery queue, but the
    /// CoreGraphics SDK does not annotate the reference type as Sendable.
    private struct EventTemplate: @unchecked Sendable {
        let value: CGEvent?
    }

    init(
        keyPoster: @escaping KeyPoster = { code, flags, down, characters, pid in
            try MirrorInput.postKey(code: code, flags: flags, down: down,
                                    characters: characters, to: pid)
        },
        frontWindowProvider: @escaping FrontWindowProvider = { displayBounds in
            MirrorInput.frontWindow(on: displayBounds,
                                    excluding: MirrorInput.selfExcludedPIDs)
        },
        pointerPoster: @escaping PointerPoster = { phase, button, global, target,
                                                   clickCount, template in
            try MirrorInput.postPointer(phase, button: button, at: global, to: target,
                                        clickCount: clickCount, template: template)
        },
        candidateProvider: @escaping CandidateProvider = { MirrorInput.onScreenCandidates() },
        accessibilityPress: @escaping AccessibilityPress = { candidate, global in
            // Scoped to the candidate's own window: the press is attributed to that window by
            // the caller, so an app-wide hit test could report a press on a stacked sibling
            // window as a press on this one.
            InputRouter.press(at: global, in: candidate.pid, windowID: candidate.windowID)
        },
        pointerRouteCapture: @escaping PointerRouteCapture = { target in
            try InputRouter.beginPointerInputChecked(target)
        },
        windowDragResolver: @escaping WindowDragResolver = { candidate, global in
            MirrorInput.windowDrag(at: global, candidate: candidate)
        },
        windowMover: @escaping WindowMover = { drag, origin in
            MirrorInput.moveWindow(drag, to: origin)
        }
    ) {
        postKeyEvent = keyPoster
        self.frontWindowProvider = frontWindowProvider
        postPointerEvent = pointerPoster
        self.candidateProvider = candidateProvider
        self.accessibilityPress = accessibilityPress
        capturePointerRoute = pointerRouteCapture
        resolveWindowDrag = windowDragResolver
        moveWindow = windowMover
    }

    var display: DisplayEntry? {
        get { stateLock.withLock { _display } }
        set {
            stateLock.withLock { _display = newValue }
            // Order matters. Invalidate first: every event already queued for the old display
            // becomes a no-op immediately, rather than executing against it. Then release held
            // state; invalid queued events drain as no-ops before the cleanup runs.
            gate.select(displayID: newValue?.id)
            ViewerInputTransition.drainAndRestore(
                restore: { [self] in restorePointerRoute() },
                scheduling: { work in queue.async(execute: work) },
                drain: { [self] in
                    // The serial queue — not a synchronous hop — is what orders this: any
                    // currently executing down finishes and is recorded, the gate rejects
                    // everything queued behind it, and matching ups go out before targets clear.
                    releaseHeldKeys()
                    releaseHeldButtons()
                    dragTarget = nil
                    windowDrag = nil
                    keyTarget = nil
                    accessibilityPressHandled = false
                    pointerTransactionBlocked = false
                    candidateCache = nil
                })
            stateLock.withLock { _interactionEnabled = false }
        }
    }

    var interactionEnabled: Bool {
        get { stateLock.withLock { _interactionEnabled } }
        set {
            if newValue {
                let display = stateLock.withLock { () -> DisplayEntry? in
                    _interactionEnabled = true
                    return _display
                }
                if let display {
                    gate.enable(displayID: display.id)
                    return
                }
            }
            gate.disable()
            ViewerInputTransition.drainAndRestore(
                restore: { [self] in restorePointerRoute() },
                scheduling: { work in queue.async(execute: work) },
                drain: { [self] in
                    releaseHeldKeys()
                    releaseHeldButtons()
                    dragTarget = nil
                    windowDrag = nil
                    keyTarget = nil
                    accessibilityPressHandled = false
                    pointerTransactionBlocked = false
                    lastNote = nil
                })
            stateLock.withLock { _interactionEnabled = false }
        }
    }

    // MARK: - Event entry points (called on the main thread)
    //
    // Each admits against the gate here and carries the resulting ticket across the queue hop.
    // Admission alone is not permission to deliver — the ticket is rechecked at the far end.

    func pointer(_ phase: MirrorInput.PointerPhase,
                 button: MouseButton,
                 viewPoint: CGPoint,
                 viewSize: CGSize,
                 clickCount: Int,
                 template: CGEvent?,
                 zoom: CGFloat = 1,
                 pan: CGPoint = .zero) {
        guard let display = permittedDisplay(), let ticket = gate.admit() else { return }
        let eventTemplate = EventTemplate(value: template)
        queue.async { [weak self] in
            guard let self, self.gate.isCurrent(ticket) else { return }
            self.deliverPointer(phase, button: button, on: display,
                                viewPoint: viewPoint, viewSize: viewSize,
                                clickCount: clickCount, template: eventTemplate.value,
                                zoom: zoom, pan: pan)
        }
    }

    func scroll(deltaX: CGFloat, deltaY: CGFloat, viewPoint: CGPoint, viewSize: CGSize,
                zoom: CGFloat = 1, pan: CGPoint = .zero) {
        guard let display = permittedDisplay(), let ticket = gate.admit() else { return }
        queue.async { [weak self] in
            guard let self, self.gate.isCurrent(ticket) else { return }
            self.deliverScroll(deltaX: deltaX, deltaY: deltaY, on: display,
                               viewPoint: viewPoint, viewSize: viewSize,
                               zoom: zoom, pan: pan)
        }
    }

    func key(down: Bool, keyCode: UInt16, modifiers: NSEvent.ModifierFlags, characters: String?) {
        guard let display = permittedDisplay() else { return }
        if let keyInterceptor, keyInterceptor(down, keyCode, modifiers) { return }
        guard let ticket = gate.admit() else { return }
        queue.async { [weak self] in
            guard let self, self.gate.isCurrent(ticket) else { return }
            self.deliverKey(down: down, keyCode: keyCode, modifiers: modifiers,
                            characters: characters, on: display)
        }
    }

    // MARK: - Delivery (queue-confined)

    private func deliverPointer(_ phase: MirrorInput.PointerPhase,
                                button: MouseButton,
                                on display: DisplayEntry,
                                viewPoint: CGPoint,
                                viewSize: CGSize,
                                clickCount: Int,
                                template: CGEvent?,
                                zoom: CGFloat,
                                pan: CGPoint) {
        defer {
            if phase == .up {
                restorePointerRoute()
            }
        }
        if pointerTransactionBlocked {
            if phase == .down {
                pointerTransactionBlocked = false
            } else {
                if phase == .up { pointerTransactionBlocked = false }
                return
            }
        }
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: display.bounds,
            viewSize: viewSize,
            zoom: zoom,
            pan: pan
        )
        // An up is the only event that can end a transaction the remote app is already in, so it
        // is never dropped for landing in the letterbox margins: it is forced to the last point
        // the button was delivered at. With nothing held there is no remote transaction to end,
        // but the local route state still has to be cleared rather than left mid-drag.
        // A title-bar drag in progress: the window follows the pointer, clamped to the session's
        // area, and the app sees none of it. The WindowServer's own drag cannot be reached with
        // per-PID events, which is why this exists at all.
        if let drag = windowDrag, phase != .down {
            if phase == .move { return }
            if let point = mapping.globalPoint(fromViewPoint: viewPoint) {
                let now = DispatchTime.now().uptimeNanoseconds
                if phase == .up || now &- lastMoveUptime >= 8_000_000 {
                    lastMoveUptime = now
                    if !moveWindow(drag, drag.origin(for: point, within: display.bounds)) {
                        note("that window can't be moved", warning: true)
                    }
                }
            }
            if phase == .up { windowDrag = nil }
            return
        }

        guard let global = mapping.globalPoint(fromViewPoint: viewPoint)
            ?? (phase == .up ? heldButtons[button]?.point : nil) else {
            if phase == .up {
                dragTarget = nil
                accessibilityPressHandled = false
            }
            return
        }

        if phase == .move || phase == .drag {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now &- lastMoveUptime >= 8_000_000 else { return }   // ~120 Hz ceiling
            lastMoveUptime = now
        }

        let target: WindowRef?
        var downCandidates: [MirrorInput.WindowCandidate] = []
        switch phase {
        case .down:
            restorePointerRoute()
            accessibilityPressHandled = false
            windowDrag = nil
            downCandidates = hitCandidates(at: global)
            target = downCandidates.first?.ref
            dragTarget = target
        case .drag:
            target = dragTarget ?? hitTest(at: global)
        case .up:
            // A held button's own target outranks a fresh hit test: the up belongs to the window
            // that took the down, not to whatever now sits under the pointer.
            target = dragTarget ?? heldButtons[button]?.target ?? hitTest(at: global)
            dragTarget = nil
        case .move:
            target = hitTest(at: global)
        }
        guard let target else {
            if phase == .down { note("nothing to click there — that part of the stage is empty") }
            return
        }

        if accessibilityPressHandled {
            if phase == .up { accessibilityPressHandled = false }
            return
        }

        do {
            if phase == .down {
                if button == .left,
                   let pressedTarget = Self.pressFirstActionableTarget(
                       downCandidates,
                       pressing: { accessibilityPress($0, global) }
                   ) {
                    accessibilityPressHandled = true
                    dragTarget = pressedTarget
                    keyTarget = pressedTarget
                    describeTarget(pressedTarget)
                    return
                }
                // Nothing pressable, and the press is on the window's title bar or toolbar
                // background: move the window rather than posting a drag the app ignores.
                if button == .left, clickCount <= 1,
                   let candidate = downCandidates.first,
                   let drag = resolveWindowDrag(candidate, global) {
                    windowDrag = drag
                    dragTarget = nil
                    keyTarget = target
                    return
                }
                // Keep the target's input route through mouse-up. AppKit controls can discard
                // per-PID pointer events if the route is restored between down and up.
                // A mutation-possible focus failure must restore successfully; otherwise checked
                // preparation throws here before any pointer event is delivered.
                let captured = try capturePointerRoute(target)
                routeLock.withLock { pointerRoute = captured }
                try postPointerEvent(.move, button, global, target, 1, template)
                usleep(15_000)
            }
            try postPointerEvent(phase, button, global, target,
                                 max(1, min(3, clickCount)), template)
            switch phase {
            case .down:
                // Recorded only once the down has actually reached the remote app, so the
                // transition drain releases exactly the buttons that app believes are held.
                heldButtons[button] = HeldButton(button: button, target: target, point: global)
                keyTarget = target
                usleep(25_000)
            case .drag:
                heldButtons[button]?.point = global
            case .up:
                heldButtons.removeValue(forKey: button)
                usleep(40_000)
            case .move:
                break
            }
            if phase == .down { describeTarget(target) }
        } catch {
            if phase == .down {
                // Do not let drag/up events continue a pointer transaction whose checked route
                // preparation or initial delivery failed.
                pointerTransactionBlocked = true
                dragTarget = nil
                restorePointerRoute()
            }
            note(error.localizedDescription, warning: true)
        }
    }

    private func deliverScroll(deltaX: CGFloat, deltaY: CGFloat,
                               on display: DisplayEntry,
                               viewPoint: CGPoint,
                               viewSize: CGSize,
                               zoom: CGFloat,
                               pan: CGPoint) {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: display.bounds,
            viewSize: viewSize,
            zoom: zoom,
            pan: pan
        )
        guard let global = mapping.globalPoint(fromViewPoint: viewPoint),
              let target = hitTest(at: global) else { return }
        let dx = Int32(max(-500, min(500, deltaX.rounded())))
        let dy = Int32(max(-500, min(500, deltaY.rounded())))
        guard dx != 0 || dy != 0 else { return }
        do {
            let userRoute = try InputRouter.beginPointerInputChecked(target)
            var recoveryVerified = false
            defer {
                if !recoveryVerified {
                    InputRouter.endPointerInput(userRoute)
                }
            }
            try MirrorInput.postScroll(dx: dx, dy: dy, at: global, to: target)
            try InputRouter.endPointerInputChecked(userRoute)
            recoveryVerified = true
        } catch {
            note(error.localizedDescription, warning: true)
        }
    }

    private func deliverKey(down: Bool, keyCode: UInt16,
                            modifiers: NSEvent.ModifierFlags,
                            characters: String?,
                            on display: DisplayEntry) {
        let flags = MirrorInput.flags(from: modifiers)

        // The app that took the down owns that key's release, wherever the key target has moved
        // to since. Answered before the target is resolved: an up must reach the app holding the
        // key even when the window it went to has closed and there is no target left at all.
        if !down, let held = heldKeys[keyCode] {
            do {
                try postKeyEvent(CGKeyCode(keyCode), flags, false, characters, held.pid)
                heldKeys.removeValue(forKey: keyCode)
            } catch {
                note(error.localizedDescription, warning: true)
            }
            return
        }

        // The clicked window may have closed since; fall back to the stage's front window. This
        // has to run before the held-key decision below, not after: judging staleness against a
        // key target that has not been checked for liveness yet routes the press to the app that
        // took the down even when the window it was pinned to is gone.
        if let current = keyTarget,
           (try? WindowPlacement.liveBounds(of: current.windowID)) == nil {
            keyTarget = nil
        }
        let target = keyTarget ?? frontWindowProvider(display.bounds)
        guard let target else {
            if down { note("no window on this stage to type into — click one first") }
            return
        }

        if let held = heldKeys[keyCode] {
            // Auto-repeat belongs to the app still holding the key.
            if held.pid == target.pid {
                do {
                    try postKeyEvent(CGKeyCode(keyCode), flags, down, characters, held.pid)
                } catch {
                    note(error.localizedDescription, warning: true)
                }
                return
            }
            // A fresh down for a key still held by an app that is no longer the key target means
            // that key's up was lost. Honouring the stale entry would type into the wrong app for
            // as long as it survives, so end the stuck sequence where it started and let this
            // event route normally.
            heldKeys.removeValue(forKey: keyCode)
            release(held)
        }

        keyTarget = target
        do {
            try postKeyEvent(CGKeyCode(keyCode), flags, down, characters, target.pid)
            if down {
                heldKeys[keyCode] = HeldKey(keyCode: keyCode, flags: flags,
                                            characters: characters, pid: target.pid)
            }
        } catch {
            note(error.localizedDescription, warning: true)
        }
    }

    // MARK: - Hit-testing

    /// Window enumeration costs a WindowServer round trip, so pointer streams reuse a list for
    /// up to 100 ms. Clicks land on whatever the last few frames showed anyway.
    /// Excluded from every selection: viewing a physical display that contains the viewer's own
    /// window would otherwise let a click select that window and be posted straight back into
    /// this process, which drives the viewer's own controls and feeds itself forever.
    private func hitTest(at global: CGPoint) -> WindowRef? {
        hitCandidates(at: global).first?.ref
    }

    private func hitCandidates(at global: CGPoint) -> [MirrorInput.WindowCandidate] {
        let now = DispatchTime.now().uptimeNanoseconds
        let list: [MirrorInput.WindowCandidate]
        if let cache = candidateCache, now &- cache.uptime < 100_000_000 {
            list = cache.list
        } else {
            list = candidateProvider()
            candidateCache = (now, list)
        }
        return MirrorInput.targets(from: list, containing: global,
                                   excluding: MirrorInput.selfExcludedPIDs)
    }

    /// Try pressable controls front-to-back. A click-through overlay may be geometrically first
    /// even though it has no actionable element at the visible point; the underlying control
    /// should then win. If no candidate handles AXPress, normal pointer delivery still falls back
    /// to the first geometric candidate, preserving support for canvases and custom surfaces.
    static func pressFirstActionableTarget(
        _ candidates: [MirrorInput.WindowCandidate],
        pressing: (MirrorInput.WindowCandidate) -> Bool
    ) -> WindowRef? {
        candidates.first(where: pressing)?.ref
    }

    // MARK: - Support

    private func permittedDisplay() -> DisplayEntry? {
        let (display, enabled) = stateLock.withLock { (_display, _interactionEnabled) }
        guard enabled, let display else { return nil }
        return display
    }

    /// Queue-confined transition cleanup. Every key down successfully sent to a target gets one
    /// final key up sent to that same PID before the target and Control state are discarded.
    private func releaseHeldKeys() {
        let releases = Array(heldKeys.values)
        heldKeys.removeAll()
        for held in releases {
            release(held)
        }
    }

    /// Sends one key up to the PID that took the down, with the flags and characters that down
    /// carried, so the remote app sees the release it is waiting for rather than a new event.
    private func release(_ held: HeldKey) {
        do {
            try postKeyEvent(CGKeyCode(held.keyCode), held.flags, false,
                             held.characters, held.pid)
        } catch {
            note("could not release remote key \(held.keyCode): "
                 + error.localizedDescription, warning: true)
        }
    }

    /// The pointer half of the same contract. A revoked Control never reaches the host's own
    /// mouse-up — the surface stops forwarding the moment the gate closes — so a button whose
    /// down landed remotely stays down forever unless the transition sends the up itself. The
    /// remote app would keep extending a selection or dragging a window with the pointer.
    ///
    /// The up goes straight to the PID without re-taking the target's input route: the route was
    /// deliberately handed back to the operator microseconds ago, and re-focusing the remote app
    /// on the very transition that gives up Control is a worse outcome than an up that some
    /// AppKit control may ignore.
    private func releaseHeldButtons() {
        let releases = heldButtons.values.sorted { $0.button.rawValue < $1.button.rawValue }
        heldButtons.removeAll()
        for held in releases {
            do {
                try postPointerEvent(.up, held.button, held.point, held.target, 1, nil)
            } catch {
                note("could not release the remote \(held.button.rawValue) mouse button: "
                     + error.localizedDescription, warning: true)
            }
        }
    }

    /// Safe to call from any thread, and idempotent — a transition on the main thread and the
    /// mouse-up path on the input queue can both reach it.
    private func restorePointerRoute() {
        let route = routeLock.withLock { () -> InputRouter.UserInputRoute? in
            defer { pointerRoute = nil }
            return pointerRoute
        }
        guard let route else { return }
        do {
            try InputRouter.endPointerInputChecked(route)
        } catch {
            // One best-effort retry can still recover the user's route, but the failed verified
            // recovery remains a visible warning rather than being silently swallowed.
            InputRouter.endPointerInput(route)
            let warning = InputNote(
                text: "Pointer input stopped because the local input route could not be "
                    + "verified as restored: \(error.localizedDescription)",
                isWarning: true
            )
            DispatchQueue.main.async { [weak self] in self?.onNote?(warning) }
        }
    }

    private func describeTarget(_ target: WindowRef) {
        let app = NSRunningApplication(processIdentifier: target.pid)?.localizedName
            ?? "pid \(target.pid)"
        var text = "driving \(app)"
        if !target.title.isEmpty { text += " — \(target.title)" }
        note(text)
    }

    private func note(_ text: String?, warning: Bool = false) {
        let value = text.map { InputNote(text: $0, isWarning: warning) }
        guard value != lastNote else { return }
        lastNote = value
        DispatchQueue.main.async { [weak self] in self?.onNote?(value) }
    }
}
