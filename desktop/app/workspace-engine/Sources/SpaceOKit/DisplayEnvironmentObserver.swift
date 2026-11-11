import Foundation
import AppKit
import CoreGraphics

/// Tells the daemon when the display graph may have changed under its sessions: the Mac woke
/// from sleep, or CoreGraphics reconfigured its displays.
///
/// Public API only — `NSWorkspace` wake notifications and
/// `CGDisplayRegisterReconfigurationCallback`. Observation never mutates the display graph.
///
/// CoreGraphics reports one reconfiguration as a burst of per-display callbacks (and SpaceO's
/// own display attach/retire produces the same bursts), so changes are debounced into a single
/// handler call after a quiet interval. At most one call is ever pending, which is what keeps
/// this bounded no matter how noisy the display graph gets.
public final class DisplayEnvironmentObserver: @unchecked Sendable {

    public enum Change: String, Sendable {
        case wake
        case reconfiguration
    }

    /// Quiet interval before the handler runs. Long enough to absorb a reconfiguration burst,
    /// short enough that a lost display is reported before the agent's next few actions.
    public static let defaultDebounce: TimeInterval = 1.0

    private let debounce: TimeInterval
    private let handler: @Sendable (Change) -> Void
    private let queue = DispatchQueue(label: "spaceo.display-environment")
    private let lock = NSLock()
    private var pending: DispatchWorkItem?
    private var pendingChange: Change?
    private var wakeTokens: [NSObjectProtocol] = []
    private var callbackTarget: Unmanaged<CallbackTarget>?
    private var deliveredCount = 0

    var deliveries: Int { lock.withLock { deliveredCount } }

    public init(
        debounce: TimeInterval = DisplayEnvironmentObserver.defaultDebounce,
        handler: @escaping @Sendable (Change) -> Void
    ) {
        self.debounce = debounce.isFinite ? min(max(debounce, 0), 30) : Self.defaultDebounce
        self.handler = handler
    }

    /// Register for wake and display reconfiguration. Idempotent.
    public func start() {
        let alreadyStarted = lock.withLock { callbackTarget != nil || !wakeTokens.isEmpty }
        guard !alreadyStarted else { return }
        let center = NSWorkspace.shared.notificationCenter
        var tokens: [NSObjectProtocol] = []
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            tokens.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.notify(.wake)
            })
        }
        let target = Unmanaged.passRetained(CallbackTarget(self))
        let result = CGDisplayRegisterReconfigurationCallback(
            displayEnvironmentReconfigured, target.toOpaque())
        lock.withLock {
            wakeTokens = tokens
            if result == .success {
                callbackTarget = target
            } else {
                target.release()
            }
        }
        if result != .success {
            // Wake still revalidates; reconfiguration without sleep will go unobserved.
            DaemonLog.shared.event("display.observer.degraded", [
                "error": "CGDisplayRegisterReconfigurationCallback returned \(result.rawValue)",
            ])
        }
    }

    /// Unregister everything and drop a pending, not-yet-delivered change. Idempotent.
    public func stop() {
        let (tokens, target, work) = lock.withLock {
            () -> ([NSObjectProtocol], Unmanaged<CallbackTarget>?, DispatchWorkItem?) in
            defer {
                wakeTokens = []
                callbackTarget = nil
                pending = nil
                pendingChange = nil
            }
            return (wakeTokens, callbackTarget, pending)
        }
        work?.cancel()
        let center = NSWorkspace.shared.notificationCenter
        tokens.forEach { center.removeObserver($0) }
        guard let target else { return }
        CGDisplayRemoveReconfigurationCallback(displayEnvironmentReconfigured, target.toOpaque())
        // Callbacks run on the main run loop; releasing there orders the release after any
        // callback already in flight.
        DispatchQueue.main.async { target.release() }
    }

    /// Record a change and (re)arm the debounce. A wake outranks a reconfiguration as the
    /// reported reason, because it is the more useful explanation for a lost display.
    func notify(_ change: Change) {
        let work = DispatchWorkItem { [weak self] in self?.deliver() }
        let previous: DispatchWorkItem? = lock.withLock {
            if pendingChange != .wake { pendingChange = change }
            defer { pending = work }
            return pending
        }
        previous?.cancel()
        queue.asyncAfter(deadline: .now() + debounce, execute: work)
    }

    private func deliver() {
        let change: Change? = lock.withLock {
            defer {
                pendingChange = nil
                pending = nil
            }
            if pendingChange != nil { deliveredCount += 1 }
            return pendingChange
        }
        if let change { handler(change) }
    }

    deinit { stop() }
}

/// C-convention trampoline; begin-configuration callbacks are ignored because the matching
/// end-of-change callbacks follow in the same burst.
private let displayEnvironmentReconfigured: CGDisplayReconfigurationCallBack = { _, flags, userInfo in
    guard let userInfo, !flags.contains(.beginConfigurationFlag) else { return }
    Unmanaged<CallbackTarget>.fromOpaque(userInfo).takeUnretainedValue()
        .observer?.notify(.reconfiguration)
}

/// The CoreGraphics callback's refcon. It holds the observer weakly so a callback already
/// dispatched on the main run loop after `stop()` resolves to nil rather than a freed object.
private final class CallbackTarget {
    weak var observer: DisplayEnvironmentObserver?
    init(_ observer: DisplayEnvironmentObserver) { self.observer = observer }
}
