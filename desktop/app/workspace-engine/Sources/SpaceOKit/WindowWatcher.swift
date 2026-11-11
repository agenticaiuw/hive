import Foundation
import ApplicationServices
import CoreGraphics

/// Native operations are injected so containment failure and shutdown are testable without AX.
struct WindowWatcherDriver {
    struct Discovery {
        let windows: [WindowRef]
        let move: (WindowRef, CGRect) throws -> CGRect
    }

    let validate: () throws -> Void
    let discover: (AXTraversalBudget) throws -> Discovery
    let isContained: (CGWindowID, CGRect) -> Bool?

    /// Each successful discovery owns its handles only for that sweep. Moving a discovered
    /// window must never enumerate the app again or silently switch to a replacement handle.
    init<Element>(pid: pid_t, validate: @escaping () throws -> Void,
                  discover: @escaping (AXTraversalBudget) throws -> AXWindowDiscovery.Result<Element>,
                  isContained: @escaping (CGWindowID, CGRect) -> Bool?,
                  move: @escaping (WindowRef, Element, CGRect) throws -> CGRect) {
        self.init(pid: pid, validate: validate, discover: discover, isContained: isContained,
                  moveWithBudget: { window, element, frame, _ in try move(window, element, frame) })
    }

    init<Element>(pid: pid_t, validate: @escaping () throws -> Void,
                  discover: @escaping (AXTraversalBudget) throws -> AXWindowDiscovery.Result<Element>,
                  isContained: @escaping (CGWindowID, CGRect) -> Bool?,
                  moveWithBudget: @escaping (WindowRef, Element, CGRect, AXTraversalBudget) throws -> CGRect) {
        self.validate = validate
        self.isContained = isContained
        self.discover = { budget in
            let result = try discover(budget)
            guard result.windows.allSatisfy({ $0.pid == pid && result.elements[$0.windowID] != nil }) else {
                throw AXWindowDiscovery.incomplete("watcher handles do not cover the discovered windows")
            }
            return Discovery(windows: result.windows, move: { [elements = result.elements] window, target in
                guard window.pid == pid, let element = elements[window.windowID] else {
                    throw SpaceOError.windowNotFound("window is absent from this watcher discovery")
                }
                try budget.check()
                return try moveWithBudget(window, element, target, budget)
            })
        }
    }

    static func live(pid: pid_t, includeTitles: Bool) throws -> Self {
        guard let identity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.applicationExited("process exited before installing its window watcher")
        }
        return Self(pid: pid, validate: {
            try Stage.checkActiveHostHealth()
            guard identity.isAlive else { throw SpaceOError.applicationExited("window watcher process exited or changed") }
        }, discover: { budget in
            try AXWindowDiscovery.discover(of: pid, app: AX.application(pid),
                provider: SystemAXTraversalProvider(), budget: budget,
                liveBounds: { try? WindowPlacement.liveBounds(of: $0) },
                includeTitles: includeTitles, retainingElements: true)
        },
        isContained: { WindowPlacement.isFullyInRegion($0, $1) },
        moveWithBudget: { try WindowPlacement.move($0, to: $2, element: $1,
                                                   identity: identity, parentBudget: $3) })
    }
}

/// Catches windows an app opens *after* launch and pulls them into the session's tile.
///
/// One-shot placement at launch is not enough. Real apps open windows later — a restore-session
/// prompt, an update notice, a file dialog, a second document — and every one of those appears
/// on whichever display macOS feels like, which in practice means the user's. Measured with
/// Cursor: its "Reopen?" dialog landed in the middle of the user's screen a second after launch.
///
/// That is precisely the intrusion SpaceO exists to prevent, so we watch for new windows and
/// relocate them on the notification rather than on a poll.
public final class WindowWatcher {

    public typealias Placement = (WindowRef) -> Void

    /// What a sweep observed about containment, for the daemon's event stream.
    ///
    /// `escaped` fires on the *first* refusal of a window — when it is outside the tile and the
    /// move did not land — not on every sweep that finds it still refused, so a sheet that can
    /// never move produces one event rather than one every two seconds. `reparked` fires when a
    /// window that was outside the tile was confirmed back inside it.
    public enum ContainmentEvent: Sendable {
        case escaped(WindowRef)
        case reparked(WindowRef)
    }

    /// What the AX callback's refcon actually points at.
    ///
    /// The observer outlives an in-flight callback dispatch, but the watcher may not: a session
    /// can be destroyed on the daemon actor while the main run loop is still inside the
    /// callback. A raw unretained watcher pointer there is a use-after-free. The box is retained
    /// by the refcon itself and holds the watcher only weakly, so a late callback resolves to
    /// nil instead of a dangling pointer.
    private final class CallbackTarget {
        weak var watcher: WindowWatcher?
        init(_ watcher: WindowWatcher) { self.watcher = watcher }
    }

    /// Why the watcher could not be built.
    ///
    /// Carried rather than collapsed into `nil`: a caller that only learns "no watcher" has
    /// nothing to put in the session audit, and an unexplained missing watcher reads like an
    /// app that never needed one. The two realistic causes are both transient and both worth
    /// naming, because the operator's next action differs.
    public struct CreationFailure: Error, CustomStringConvertible {
        public let axError: AXError

        public var description: String {
            switch axError {
            case .apiDisabled:
                return "Accessibility permission is off (AXObserverCreate: apiDisabled)"
            case .invalidUIElement:
                return "the process is not accessibility-registered yet "
                     + "(AXObserverCreate: invalidUIElement)"
            default:
                return "AXObserverCreate failed (AX error \(axError.rawValue))"
            }
        }
    }

    /// Registered in `init` and removed in `stop()` — one list so the two cannot drift.
    private static let observedNotifications = [kAXWindowCreatedNotification,
                                                kAXFocusedWindowChangedNotification,
                                                kAXApplicationShownNotification]

    /// How often the safety-net sweep runs when no notification has arrived.
    ///
    /// Notifications remain the primary mechanism — this is the backstop for the case the whole
    /// ticket is about: a notification that never arrives, because registration silently failed,
    /// because the app suppressed it, or because it landed in a window the observer does not
    /// cover. Two seconds is short enough that a stray dialog is a blink rather than a fixture,
    /// and long enough that the WindowServer round trip is not a background CPU cost.
    public static let periodicSweepInterval: TimeInterval = 2.0

    private let pid: pid_t
    private let region: () -> CGRect
    private let onPlaced: Placement?
    /// Settable after construction so the session factory signature stays unchanged. Guarded by
    /// `lock`; invoked outside it.
    private var containmentHandler: ((ContainmentEvent) -> Void)?
    private var observer: AXObserver?
    private var callbackTarget: Unmanaged<CallbackTarget>?
    private let element: AXUIElement?
    private let driver: WindowWatcherDriver
    private let now: () -> UInt64
    private var timer: DispatchSourceTimer?

    /// The geometry of each refused window is also the complete refusal ledger.
    private var refusedGeometry: [CGWindowID: (window: CGRect, region: CGRect)] = [:]
    private let lock = NSLock()
    private let coalescer = SweepCoalescer()
    private var stopped = false
    private var sweepsSuspended = false
    private var sweepRequestedDuringSuspension = false
    private var activeSweeps = 0
    /// True only after stop has fenced admission and every admitted sweep has returned.
    /// Coalescer cancellation alone is not evidence that native work has finished.
    var isQuiescent: Bool { lock.withLock { stopped && activeSweeps == 0 } }
    private var lastSweepFailure: String?
    public var sweepFailure: String? { lock.withLock { lastSweepFailure } }
    private var isStopped: Bool { lock.withLock { stopped } }

    /// Notifications the observer refused to register, with the AX error. Empty is the healthy
    /// case; anything here means notification-driven containment is degraded for this app and
    /// only the periodic sweep is holding the line, which the session audit must say out loud.
    public private(set) var registrationFailures: [String] = []

    private var placedTotal = 0
    public var placedCount: Int { lock.withLock { placedTotal } }
    public var refusedCount: Int { lock.withLock { refusedGeometry.count } }
    /// Completed sweeps. Lets a test prove the periodic sweep really runs without reaching into
    /// the WindowServer for evidence.
    private var sweepTotal = 0
    public var sweepCount: Int { lock.withLock { sweepTotal } }

    /// - Parameter region: read lazily, because a session's tile can move if the display
    ///   arrangement changes.
    /// - Parameter periodicSweep: set false only in tests that drive `sweep()` by hand.
    /// - Throws: `CreationFailure` when the observer cannot be created, or an exited-process
    ///   error when its original identity cannot be established. Failing loudly is the
    ///   point: this object *is* both containment mechanisms, so a caller that cannot build one
    ///   has to record that and take over, not carry on with a hole where the watcher should be.
    public init(pid: pid_t,
                region: @escaping () -> CGRect,
                onPlaced: Placement? = nil,
                periodicSweep: Bool = true) throws {
        self.pid = pid
        self.region = region
        self.onPlaced = onPlaced
        self.driver = try WindowWatcherDriver.live(pid: pid, includeTitles: onPlaced != nil)
        self.now = { DispatchTime.now().uptimeNanoseconds }
        let applicationElement = AXUIElementCreateApplication(pid)
        self.element = applicationElement

        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let target = Unmanaged<CallbackTarget>.fromOpaque(refcon).takeUnretainedValue()
            target.watcher?.sweep()
        }
        let creation = AXObserverCreate(pid, callback, &created)
        guard creation == .success, let observer = created else {
            // A `.success` with no observer is a contract violation rather than a diagnosis;
            // report it as a plain failure instead of "AX error 0", which reads as healthy.
            throw CreationFailure(axError: creation == .success ? .failure : creation)
        }
        self.observer = observer

        let target = Unmanaged.passRetained(CallbackTarget(self))
        self.callbackTarget = target
        let context = target.toOpaque()
        var failures: [String] = []
        for notification in Self.observedNotifications {
            let result = AXObserverAddNotification(observer, applicationElement,
                                                   notification as CFString, context)
            // kAXErrorNotificationAlreadyRegistered is benign — the notification is live either
            // way, which is all this list is claiming.
            if result != .success && result != .notificationAlreadyRegistered {
                failures.append("\(notification) (AX error \(result.rawValue))")
            }
        }
        self.registrationFailures = failures
        CFRunLoopAddSource(CFRunLoopGetMain(),
                           AXObserverGetRunLoopSource(observer),
                           .defaultMode)

        if periodicSweep { startPeriodicSweep() }
    }

    init(testingPID pid: pid_t, region: @escaping () -> CGRect,
         onPlaced: Placement? = nil, driver: WindowWatcherDriver,
         now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
        self.pid = pid
        self.region = region
        self.onPlaced = onPlaced
        self.driver = driver
        self.now = now
        self.element = nil
    }

    /// The backstop sweep uses checked discovery, coalesced against notification-driven sweeps.
    /// Stop prevents further work; a native call already entered must still return normally.
    private func startPeriodicSweep() {
        let source = DispatchSource.makeTimerSource(
            queue: DispatchQueue.global(qos: .utility))
        source.schedule(deadline: .now() + Self.periodicSweepInterval,
                        repeating: Self.periodicSweepInterval,
                        leeway: .milliseconds(250))
        source.setEventHandler { [weak self] in self?.sweep() }
        timer = source
        source.resume()
    }

    /// Move any window of this app that is not already inside the region.
    ///
    /// Driven by the notification rather than a timer, but written as a full sweep because
    /// `kAXWindowCreated` does not reliably tell you *which* window appeared.
    public func sweep() {
        guard lock.withLock({
            guard !stopped else { return false }
            if sweepsSuspended {
                sweepRequestedDuringSuspension = true
                return false
            }
            guard coalescer.beginOrCoalesce() else { return false }
            activeSweeps += 1
            return true
        }) else { return }
        defer { lock.withLock { activeSweeps -= 1 } }
        repeat {
            sweepOnce()
            lock.withLock { sweepTotal += 1 }
        } while coalescer.endOrRepeat()
    }

    /// Run synchronous rollback only when no admitted sweep or placement callback is active.
    /// Failure restores ordinary containment without rebuilding an observer. Never block the
    /// main run loop or a reentrant placement callback waiting for that same callback to finish.
    func withQuiescentSuspension(_ operation: () -> Bool) -> Bool {
        guard lock.withLock({
            guard activeSweeps == 0 && !sweepsSuspended else { return false }
            sweepsSuspended = true
            return true
        }) else { return false }
        defer {
            let replay = lock.withLock {
                sweepsSuspended = false
                defer { sweepRequestedDuringSuspension = false }
                return sweepRequestedDuringSuspension && !stopped
            }
            if replay { sweep() }
        }
        return operation()
    }

    private func sweepOnce() {
        guard !isStopped else { return }
        do {
            try performSweep()
            lock.withLock { lastSweepFailure = nil }
        } catch {
            guard !isStopped else { return }
            let message = BoundedDiagnosticText.prefix(error.localizedDescription, maximumBytes: 512)
            lock.withLock { lastSweepFailure = message }
        }
    }

    private func performSweep() throws {
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
            now: now,
            isCancelled: { [weak self] in (self?.isStopped ?? true) || Task.isCancelled })
        try budget.check()
        try driver.validate()
        let target = region()
        try WindowPlacement.validate(frame: target)

        let discovery = try driver.discover(budget)
        try driver.validate()
        try budget.check()
        lock.withLock {
            // Closed windows must not remain in the accounting forever. In particular, a
            // refused modal sheet that later closes should stop making every future audit fail.
            guard !refusedGeometry.isEmpty else { return }
            let liveIDs = Set(discovery.windows.lazy.map(\.windowID))
            let closed = refusedGeometry.keys.filter { !liveIDs.contains($0) }
            for id in closed { refusedGeometry.removeValue(forKey: id) }
        }

        for window in discovery.windows {
            try budget.check()
            try driver.validate()
            try budget.check()
            // Containment is re-derived from the WindowServer every sweep, for *every* window
            // including ones previously placed successfully — an app that repositions itself after
            // placement, or grows past its tile, must be caught rather than trusted.
            let containment = driver.isContained(window.windowID, target)
            try budget.check()
            guard let contained = containment else {
                continue  // the WindowServer forgot it mid-sweep; the next pass will drop it
            }
            if contained {
                lock.withLock {
                    _ = refusedGeometry.removeValue(forKey: window.windowID)
                }
                continue
            }

            // An identical rejected frame is not new evidence. Avoid repeatedly moving a
            // fixed panel/sheet until its geometry or target changes; explicit repark can retry.
            let alreadyRefused = lock.withLock {
                guard let last = refusedGeometry[window.windowID] else { return false }
                return last.window == window.frame && last.region == target
            }
            if alreadyRefused { continue }

            // Sheets and some dialogs refuse AXPosition. Try, and count the refusals rather
            // than pretending they were contained.
            let fitted = WindowPlacement.targetFrame(for: window.frame, in: target)
            // Accept only on full containment, and re-read the live bounds rather than trusting
            // the value `move` echoed back: an app is free to resize itself the instant it is
            // repositioned, and the echo would not show it.
            try budget.check()
            try driver.validate()
            let placed = try discovery.move(window, fitted)
            try budget.check()
            let containmentAfterMove = driver.isContained(window.windowID, target)
            try budget.check()
            guard let landed = containmentAfterMove else {
                throw AXWindowDiscovery.incomplete("post-move containment is unavailable")
            }
            if landed {
                let handler = lock.withLock { () -> ((ContainmentEvent) -> Void)? in
                    refusedGeometry.removeValue(forKey: window.windowID)
                    placedTotal += 1
                    return containmentHandler
                }
                let reparked = WindowRef(windowID: window.windowID, pid: pid,
                                         title: window.title, frame: placed)
                onPlaced?(reparked)
                handler?(.reparked(reparked))
            } else {
                let (firstRefusal, handler) = lock.withLock {
                    () -> (Bool, ((ContainmentEvent) -> Void)?) in
                    let first = refusedGeometry[window.windowID] == nil
                    refusedGeometry[window.windowID] = (window.frame, target)
                    return (first, containmentHandler)
                }
                if firstRefusal { handler?(.escaped(window)) }
            }
        }
    }

    /// Receive `escaped`/`reparked` observations. Called on the sweeping thread; the handler must
    /// only touch thread-safe state.
    public func setContainmentHandler(_ handler: ((ContainmentEvent) -> Void)?) {
        lock.withLock { containmentHandler = handler }
    }

    /// Forget a refusal so a later sweep can retry even when its geometry is unchanged.
    public func release(_ windowID: CGWindowID) {
        lock.withLock {
            _ = refusedGeometry.removeValue(forKey: windowID)
        }
    }

    public func stop() {
        // The timer goes first, so no new sweep can start while the observer is being torn down.
        // Cancelling the coalescer releases any repeat loop that is mid-flight; without it a
        // final burst of notifications could keep the loop sweeping a dead app.
        let source = lock.withLock { () -> DispatchSourceTimer? in
            stopped = true
            defer { timer = nil }
            return timer
        }
        source?.cancel()
        coalescer.cancel()

        // Idempotent and thread-safe: destroy paths can race a deinit-driven stop.
        // `observer` and `callbackTarget` are set together in init, so take them together.
        let state: (observer: AXObserver, target: Unmanaged<CallbackTarget>)? = lock.withLock {
            guard let observer, let target = callbackTarget else { return nil }
            self.observer = nil
            callbackTarget = nil
            return (observer, target)
        }
        guard let state, let element else { return }
        for notification in Self.observedNotifications {
            AXObserverRemoveNotification(state.observer, element, notification as CFString)
        }
        CFRunLoopRemoveSource(CFRunLoopGetMain(),
                              AXObserverGetRunLoopSource(state.observer),
                              .defaultMode)
        // A callback may be mid-flight on the main run loop right now, still holding the
        // refcon. Callbacks and this block both run on the main loop, so releasing the box
        // there guarantees it happens strictly after any in-flight dispatch completes.
        let target = state.target
        CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
            target.release()
        }
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }

    deinit { stop() }
}
