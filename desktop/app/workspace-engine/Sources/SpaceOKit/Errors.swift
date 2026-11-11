import Foundation

/// A recovery step an agent can execute without interpreting prose: the tool to call, the
/// arguments to pass, and what to do once it returns.
public struct RecoveryHint: Codable, Sendable, Equatable {
    public var tool: String
    public var arguments: [String: String]
    public var then: String

    public init(tool: String, arguments: [String: String] = [:], then: String) {
        self.tool = tool
        self.arguments = arguments
        self.then = then
    }

    /// Fill in the session (and window) the failing request named, so the hint is runnable as is.
    ///
    /// Only arguments the named tool accepts are bound. A hint that says "call
    /// spaceo_session_list with session=x" is not runnable — the tool rejects the argument — and
    /// binding a dead session's name into spaceo_session_create would ask to recreate it.
    public func bound(session: String?, window: UInt32? = nil) -> RecoveryHint {
        var copy = self
        if let session, copy.arguments["session"] == nil,
           !Self.sessionlessTools.contains(copy.tool) {
            copy.arguments["session"] = session
        }
        if let window, copy.arguments["window"] == nil, Self.windowTools.contains(copy.tool) {
            copy.arguments["window"] = String(window)
        }
        return copy
    }

    /// Tools that take no `session` argument (session.create names its session `name`).
    static let sessionlessTools: Set<String> = [
        "spaceo_session_create", "spaceo_session_list", "spaceo_pool_status", "spaceo_events",
    ]

    /// Tools that accept a `window` argument. Anything else gets no window binding: an unknown
    /// argument is refused, while an omitted window falls back to the session's default window.
    static let windowTools: Set<String> = [
        "spaceo_read_screen", "spaceo_screenshot", "spaceo_click", "spaceo_scroll", "spaceo_move",
        "spaceo_drag", "spaceo_select_text", "spaceo_type", "spaceo_press_key", "spaceo_wait_for",
        "spaceo_find", "spaceo_read_text", "spaceo_list_targets", "spaceo_attach_target",
        "spaceo_open_url", "spaceo_place_window",
    ]

    /// Codes whose only recovery is a human: the table-driven test lists them explicitly so a
    /// new code cannot slip through with neither a hint nor a reason.
    public static let terminalCodes: Set<String> = [
        "bad_request", "capability_unavailable", "display_creation_failed", "launch_failed",
        "capture_failed", "teardown_incomplete", "unknown_session", "isolation_requirements_unmet",
        "daemon_stopping", "unsupported_target", "operation_failed", "daemon_not_running",
        "placement_rejected",
    ]
}

/// Which pool bound a `resource_limit` failure hit. Hard caps clear when a session is destroyed
/// or reclaimed; the creation rate clears on its own once the rolling minute moves on.
public enum ResourceLimitKind: String, Codable, Sendable, Equatable {
    case sessions
    case displays
    case creationRate = "creation_rate"
}

/// "a, b or c": how refusals name the values a field accepts.
public func alternatives(_ values: [String]) -> String {
    guard let last = values.last, values.count > 1 else { return values.first ?? "" }
    return values.dropLast().joined(separator: ", ") + " or " + last
}

/// Every failure mode SpaceO can produce.
///
/// Error types in this package conform to LocalizedError so that `localizedDescription` —
/// which generic code like `Response.failure` reaches for — carries the deliberate message
/// instead of Foundation's generic "operation couldn't be completed" text.
public enum SpaceOError: Error, CustomStringConvertible, LocalizedError, Equatable {
    case applicationExited(String)
    case windowNotReady(String)
    case staleSnapshot(String)
    case staleGeometry(String)
    case isolationUnverified(String)
    case isolationBreached(String)
    case daemonStopping
    case waitQueueTimeout(String)
    /// Batch admission/finalization exceeded its queue budget; receipts remain historical.
    case batchQueueTimeout(String)
    /// A private symbol or class this OS build no longer provides.
    case unavailable(capability: String)
    /// Accessibility permission missing. Carries the exact remedy, naming the responsible app
    /// when the daemon could resolve it.
    case accessibilityDenied
    case screenRecordingDenied
    /// The daemon is draining ahead of a restart and refuses new sessions only.
    case daemonDraining
    /// Agent input is refused because a human holds Control or the agent paused itself.
    case sessionPaused(String)
    /// A session mutation or covered read arrived without the controller lease it needs.
    case leaseRequired(String)
    /// A web action needs one bound Chromium target and the browser has several.
    case webTargetAmbiguous(String)
    case stageCreationFailed(String)
    case unknownSession(String)
    /// The app could not be launched or never produced a window.
    case launchFailed(String)
    case windowNotFound(String)
    /// The target rejected an operation.
    case unsupportedTarget(String)
    /// The addressed element exists but exposes no press-like action. Distinct from
    /// `unsupportedTarget`: nothing is wrong with the app, the caller just picked a node
    /// that is not a button.
    case elementNotPressable(role: String, actions: [String])
    case captureFailed(String)
    case badRequest(String)
    /// Requested cleanup left processes or virtual displays alive.
    case teardownIncomplete(TeardownReport)
    /// The pool is at one of its bounds. Not a malformed call: the same request can succeed
    /// after `retryAfter` seconds (when known) or once another session is released.
    case resourceLimit(kind: ResourceLimitKind, detail: String, retryAfter: Double?)
    /// The session exists only as a detached record left by a previous daemon; nothing in it
    /// can be driven again. Carries the full sentence, including when and what happens next.
    case sessionDetached(String)
    /// A window was needed but the session holds no application at all — nothing to wait for.
    /// Shares `window_not_ready` with its siblings, but its recovery opens an app instead of
    /// polling a window list that can never fill.
    case noApplication(String)
    /// A keystroke was refused because the application routes keys to another of its windows.
    case focusElsewhere(windowID: UInt32, detail: String)

    public var description: String {
        switch self {
        case .applicationExited(let why), .windowNotReady(let why), .staleSnapshot(let why),
             .staleGeometry(let why), .isolationUnverified(let why), .isolationBreached(let why),
             .sessionDetached(let why), .noApplication(let why): return why
        case .resourceLimit(_, let detail, let retryAfter):
            guard let retryAfter else { return detail }
            return "\(detail); retry in \(Self.wholeSeconds(retryAfter)) s"
        case .daemonStopping: return "the daemon is shutting down; wait for stop completion before starting a replacement"
        case .daemonDraining:
            return "the daemon is draining ahead of a restart: existing sessions keep working, "
                + "new sessions are refused until the replacement daemon is up. Retry create in a few seconds."
        case .sessionPaused(let why), .leaseRequired(let why), .webTargetAmbiguous(let why): return why
        case .unavailable(let cap):
            return """
            unavailable on this host: \(cap)
              The current macOS runtime does not provide a required class or symbol.
              The host check (spaceo doctor) has the full report.
            """
        case .accessibilityDenied:
            return """
            Accessibility permission is required.
              System Settings > Privacy & Security > Accessibility
              Add and enable \(Self.responsibleAppPhrase()), then retry.
            """
        case .screenRecordingDenied:
            return """
            Screen Recording permission is required for capture.
              System Settings > Privacy & Security > Screen & System Audio Recording
              Add and enable \(Self.responsibleAppPhrase()). Input and placement still work without it.
            """
        case .stageCreationFailed(let why):  return "could not create the agent display: \(why)"
        case .unknownSession(let id):        return "no session named '\(id)'"
        case .launchFailed(let why):         return "launch failed: \(why)"
        case .windowNotFound(let why):       return "window not found: \(why)"
        case .unsupportedTarget(let why):
            return "target rejected the operation: \(why)"
        case .elementNotPressable(let role, let actions):
            let available = actions.isEmpty ? "none" : actions.joined(separator: ", ")
            // `InputRouter.press` tries every advertised press-like action, so an advertised one
            // reaching this error means the app refused it, not that it was missing.
            let pressLike: Set<String> = ["AXPress", "AXConfirm", "AXPick", "AXOpen"]
            let refused = actions.filter(pressLike.contains)
            let lead = refused.isEmpty
                ? "that element is not pressable: \(role) exposes no press action (available: \(available))"
                : "that element refused its press: \(role) advertises \(refused.joined(separator: ", ")) but did not perform it"
            return """
            \(lead)
              Read the screen again and pick a Button, Link or CheckBox index, or click by coordinates.
              For a text field, typing after focusing it is usually what you want.
            """
        case .waitQueueTimeout(let phase): return "wait queue budget exhausted during \(phase); final session evidence is unavailable"
        case .batchQueueTimeout(let phase): return "batch queue budget exhausted during \(phase); final session evidence is unavailable"
        case .captureFailed(let why):        return "capture failed: \(why)"
        case .badRequest(let why):           return why
        case .teardownIncomplete(let report): return report.recoveryDescription
        case .focusElsewhere(_, let detail): return detail
        }
    }

    public var code: String {
        switch self {
        case .accessibilityDenied, .screenRecordingDenied: return "permission_denied"
        case .applicationExited: return "application_exited"
        case .windowNotReady, .windowNotFound: return "window_not_ready"
        case .staleSnapshot: return "stale_snapshot"
        case .staleGeometry: return "stale_geometry"
        case .isolationUnverified: return "isolation_requirements_unmet"
        case .isolationBreached: return "isolation_breached"
        case .waitQueueTimeout: return "wait_queue_timeout"
        case .batchQueueTimeout: return "batch_queue_timeout"
        case .daemonStopping: return "daemon_stopping"
        case .daemonDraining: return "daemon_draining"
        case .sessionPaused: return "session_paused"
        case .leaseRequired: return "lease_required"
        case .webTargetAmbiguous: return "web_target_ambiguous"
        case .unavailable: return "capability_unavailable"
        case .stageCreationFailed: return "display_creation_failed"
        case .unknownSession: return "unknown_session"
        case .launchFailed: return "launch_failed"
        case .unsupportedTarget, .elementNotPressable: return "unsupported_target"
        case .captureFailed: return "capture_failed"
        case .badRequest: return "bad_request"
        case .teardownIncomplete: return "teardown_incomplete"
        case .resourceLimit: return "resource_limit"
        case .sessionDetached: return "session_detached"
        case .noApplication: return "window_not_ready"
        case .focusElsewhere: return "focus_elsewhere"
        }
    }
    public var nextAction: String? {
        switch self {
        case .accessibilityDenied, .screenRecordingDenied, .unavailable: return "spaceo doctor --json"
        case .staleSnapshot: return "spaceo ax --help"
        case .staleGeometry: return "spaceo windows --help"
        case .windowNotReady, .windowNotFound: return "spaceo windows --timeout 10 --help"
        case .isolationUnverified, .isolationBreached: return "spaceo verify --help"
        case .waitQueueTimeout, .batchQueueTimeout: return "spaceo session list --json"
        case .daemonStopping: return "spaceo daemon wait --help"
        case .daemonDraining: return "retry session create after `spaceo daemon wait`"
        case .sessionPaused: return "spaceo session list --json (inputPaused, operatorHandoff)"
        case .leaseRequired: return "spaceo session create --help"
        case .webTargetAmbiguous: return "spaceo targets --help"
        case .elementNotPressable: return "spaceo ax --help"
        case .resourceLimit(_, _, let retryAfter):
            return retryAfter.map { "spaceo pool; retry after \(Self.wholeSeconds($0)) s" } ?? "spaceo pool"
        case .sessionDetached: return "spaceo session create --help"
        case .noApplication: return "spaceo run --help"
        default: return nil
        }
    }
    public var errorDescription: String? { description }

    /// The structured twin of `nextAction`. Nil for codes listed in `RecoveryHint.terminalCodes`.
    public var recovery: RecoveryHint? {
        switch self {
        case .staleSnapshot:
            return RecoveryHint(tool: "spaceo_read_screen", then: "retry with a fresh element index from the new snapshot")
        case .staleGeometry:
            return RecoveryHint(tool: "spaceo_list_windows", then: "retry with the new geometry token, or use an element index instead of coordinates")
        case .windowNotReady, .windowNotFound:
            return RecoveryHint(tool: "spaceo_list_windows", arguments: ["timeout": "10"], then: "retry once a window is listed")
        case .applicationExited:
            return RecoveryHint(tool: "spaceo_open_app", then: "relaunch the app, then read the screen again")
        case .accessibilityDenied, .screenRecordingDenied:
            return RecoveryHint(tool: "spaceo_session_list", then: "stop and tell the user which app needs the grant named in this error; no retry will succeed until it is granted")
        case .webTargetAmbiguous:
            return RecoveryHint(tool: "spaceo_list_targets", then: "call spaceo_attach_target with the intended target id, then retry")
        case .sessionPaused:
            return RecoveryHint(tool: "spaceo_session_list", then: "wait until inputPaused is false, read operatorHandoff, then re-read the screen before acting")
        case .leaseRequired:
            return RecoveryHint(tool: "spaceo_session_create", then: "create the session on this connection so it holds the lease, then retry")
        case .waitQueueTimeout:
            return RecoveryHint(tool: "spaceo_session_list", then: "inspect daemon/session responsiveness, then retry the wait; do not act on unconfirmed observation data")
        case .batchQueueTimeout:
            return RecoveryHint(tool: "spaceo_session_list", then: "review step receipts, then re-observe the session before further input; do not replay completed steps")
        case .daemonDraining:
            return RecoveryHint(tool: "spaceo_session_create", then: "wait a few seconds for the replacement daemon and retry create")
        case .elementNotPressable:
            return RecoveryHint(tool: "spaceo_read_screen", then: "pick a Button, Link or CheckBox index, or click the element's coordinates from a screenshot")
        case .focusElsewhere(let windowID, _):
            return RecoveryHint(tool: "spaceo_read_screen", arguments: ["window": String(windowID)], then: "deal with that window first (often a dialog), or retry with window set to it")
        case .isolationBreached:
            return RecoveryHint(tool: "spaceo_verify_isolation", then: "resolve the named breach, then spaceo_session_resume before further input")
        case .resourceLimit(let kind, _, let retryAfter):
            let when = retryAfter.map { "retry after \(Self.wholeSeconds($0)) s" }
            switch kind {
            case .creationRate:
                return RecoveryHint(tool: "spaceo_pool_status",
                                    then: (when ?? "retry in about a minute")
                                        + "; the display creation rate clears on its own")
            case .sessions, .displays:
                return RecoveryHint(tool: "spaceo_pool_status",
                                    then: "destroy sessions you no longer need"
                                        + (when.map { ", or \($0) when an abandoned session is reclaimed" } ?? "")
                                        + ", then retry")
            }
        case .sessionDetached:
            return RecoveryHint(tool: "spaceo_session_create",
                                then: "create a new session (a new name, or omit the name), then open your apps again")
        case .noApplication:
            return RecoveryHint(tool: "spaceo_open_app",
                                then: "open the app this session should drive, then read the screen")
        default:
            return nil
        }
    }

    /// Retry delays are reported in whole seconds, rounded up so an on-time retry cannot fail.
    static func wholeSeconds(_ seconds: Double) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int(min(seconds, 86_400).rounded(.up))
    }

    /// Process attribution shared by both permission errors. Installed once by the daemon (or
    /// CLI) at startup from `ResponsibleProcess.describeCurrent()`; without it the text falls
    /// back to the generic wording.
    private static let attributionLock = NSLock()
    nonisolated(unsafe) private static var attribution: String?

    public static func setResponsibleProcessAttribution(_ value: String?) {
        attributionLock.withLock { attribution = value }
    }

    static func responsibleAppPhrase() -> String {
        let value = attributionLock.withLock { attribution }
        if let value, !value.isEmpty { return value }
        return "the terminal or app running spaceo (macOS attributes the grant to that app, not to the spaceo binary)"
    }
}
