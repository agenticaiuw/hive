import Foundation
import CoreGraphics

/// Wire format between the `spaceo` CLI and the daemon.
///
/// Deliberately one flat struct rather than a per-command type: it keeps the socket protocol
/// trivially inspectable with `nc`, which matters a lot when debugging something that talks to
/// the WindowServer.
public struct Request: Codable, Sendable {
    public var strictIsolation: Bool?
    public var requiredIsolation: [IsolationDimension]?
    public var requireWindow: Bool?
    public var allowNoWindows: Bool?
    public var memory: Bool?
    public var timeout: Double?
    public var duration: Double?
    public var snapshotID: String?
    public var label: String?
    public var geometryToken: String?
    public var placement: String?
    public var arguments: [String]?
    public var cmd: String
    public var session: String?
    public var width: Int?
    public var height: Int?
    public var app: String?
    public var files: [String]?
    public var pid: Int32?
    public var window: UInt32?
    public var text: String?
    public var key: String?
    /// Chromium DevTools page target selected by `target.attach`.
    public var target: String?
    /// Either an AX index ("7") or a web-content index ("w7").
    public var element: String?
    /// Target the page rather than the app chrome.
    public var web: Bool?
    public var x: Double?
    public var y: Double?
    /// Drag destination, window-local like `x`/`y`.
    public var toX: Double?
    public var toY: Double?
    /// Scroll deltas in pixels; positive `dy` scrolls content up.
    public var dx: Int32?
    public var dy: Int32?
    public var ticks: Int?
    /// Modifier keys held for the duration of a pointer action (cmd, shift, alt, ctrl, fn).
    public var modifiers: [String]?
    public var button: String?
    public var count: Int?
    /// Capture scale. 1 makes screenshot pixels equal click coordinates; 2 doubles detail.
    public var scale: Int?
    public var output: String?
    public var quitApps: Bool?
    public var full: Bool?
    /// Human-operator arbitration for `session.control`.
    public var paused: Bool?
    /// Selection endpoints for `select`, in editor coordinates: zero-based line and character.
    /// The anchor is where the selection starts and the active end is where it finishes, which
    /// is the same orientation a drag would have had.
    public var anchorLine: Int?
    public var anchorCharacter: Int?
    public var activeLine: Int?
    public var activeCharacter: Int?
    /// Optional controller metadata for `session.create`.
    public var controllerOwner: DurableSessionOwner?
    /// Current lease credential for `session.heartbeat` and owner-scoped mutations.
    public var controllerLeaseID: UUID?
    /// Requested create-time lease duration. The daemon bounds client values.
    public var controllerTTLSeconds: Double?
    /// The caller acts for the machine's human operator rather than as one agent among many.
    /// Required by commands whose blast radius crosses controller boundaries (`daemon.stop`,
    /// `session.destroy --all` over foreign sessions, `pool.configure`), and it lifts the
    /// foreign-session redaction in `session.list`. Coordination, not security: every client
    /// on the socket shares one uid, so this is an explicit confirmation, not a credential.
    public var operatorScope: Bool?
    /// `daemon.stop` only: exit even though a previous daemon's detached recovery records are
    /// still inside their grace period, leaving them on disk for the next daemon to recover.
    /// The daemon's own signal handler sets it, because a SIGTERM cannot wait for a grace
    /// boundary and a refused signal only invites SIGKILL. Requires `operatorScope`.
    public var leaveDetachedRecords: Bool?
    /// Privacy-safe correlation id supplied by a client for diagnostics. It is never an
    /// authorization token and must not contain user input; MCP uses a random UUID per tool call.
    public var diagnosticTraceID: String?
    /// Privacy-safe run correlation supplied by a client. Unlike the daemon's process-wide
    /// environment, this keeps concurrent MCP clients separable on one shared daemon.
    public var diagnosticRunID: String?
    /// Requests per-call resource telemetry for this non-secret operation. It changes logging,
    /// never command semantics, and carries no payload itself.
    public var diagnosticMetrics: Bool?
    /// Which kind of client sent this request (`cli`, `mcp`, `viewer`), stamped by
    /// `Transport.send` for the daemon log. Diagnostic only; never an authorization input.
    public var diagnosticClient: String?

    // MARK: Agent ergonomics (SPAO-146, 140, 144, 207–213, 218–221)

    /// `open.url`: a remote URL to navigate the session's managed Chromium to.
    public var url: String?
    /// `open.url`: open in a new tab instead of navigating the bound target.
    public var newTab: Bool?
    /// `ax.find`: case-insensitive substring matched against label, value and role.
    public var query: String?
    /// `ax.find`: optional role filter such as `Button` or `AXTextField`.
    public var role: String?
    /// `ax`: snapshot id to diff against; the response then carries only what changed.
    public var since: String?
    /// `steps.run`: at most 16 nested requests executed in order under one lease.
    /// Its budget includes queue admission; final queue expiry preserves historical step receipts.
    public var steps: [Request]?
    public var stopOnFailure: Bool?
    /// `wait`: condition kind — element_label, element_gone, window_title_contains,
    /// web_selector, web_title_contains, stable_ms, ms.
    public var waitCondition: String?
    /// `wait`: the condition's operand (label, title fragment, selector, or a millisecond count).
    public var waitValue: String?
    /// `ax.text`: maximum characters returned, bounded by the daemon to 20 000.
    public var maxChars: Int?
    /// `key`: hold the combination for this many milliseconds (0–5000) before releasing.
    public var holdMs: Int?
    /// `key`: `tap` (default), `down`, or `up`. A `down` without a matching `up` is released by
    /// the daemon's held-key watchdog and reported.
    public var keyAction: String?
    /// `type`: append Return after the text, reported separately in the receipt.
    public var submit: Bool?
    /// `type`: select the focused element's existing contents first so the text replaces them.
    public var replace: Bool?
    /// `session.control`: why an agent paused itself ("needs 2FA code"), shown on the tile.
    public var reason: String?
    /// `session.control` (operator release): a one-line note delivered once to the agent.
    public var handoffNote: String?
    /// `session.annotate` / `session.create`: human-readable session title.
    public var title: String?
    /// `session.annotate`: colour tag name (red, orange, yellow, green, blue, purple, gray).
    public var colorTag: String?
    /// `session.create`: shared (default), exclusive, exclusive_1080p, exclusive_1440p.
    public var preset: String?
    /// `session.create`: recording mode — `actions` or `actions+frames`.
    public var record: String?
    /// `screenshot`: draw numbered element tags on the returned PNG only.
    public var annotate: Bool?
    /// `drag`: element references standing in for the start and end points.
    public var fromElement: String?
    public var toElement: String?
    /// `run`: force a second instance even when the session already owns one of this app.
    public var newInstance: Bool?
    /// `run`: launch a managed Chromium with `--mute-audio`.
    public var muteAudio: Bool?
    /// `clean`: report what would be removed without removing it.
    public var dryRun: Bool?
    /// `events.subscribe` / `events.poll`: replay from this sequence number.
    public var sinceSeq: UInt64?

    // MARK: 2026-09-23 UX round

    /// `menu`: menu-bar path starting at a top-level title, e.g. `["File", "Export as PDF…"]`.
    /// Absent or empty lists the top-level menus.
    public var menuPath: [String]?
    /// `menu`: press the item named by `menuPath` instead of listing it.
    public var press: Bool?
    /// `wait` element conditions and `click` by label: `exact` (default) or `contains`, matched
    /// against the element's accessible name rather than its rendered `Role — name · value` line.
    public var match: String?
    /// `session.create`: how long an abandoned session (its controller process exited) keeps its
    /// apps while waiting for `session.claim` by the same controller id. 30–1800 seconds.
    public var orphanGraceSeconds: Double?
    /// `pool.remove`: the SpaceO virtual display to remove, as `pool` reports it.
    public var display: UInt32?

    public init(cmd: String) { self.cmd = cmd }
}

/// The daemon's command vocabulary, in the one place both sides can agree on.
public enum DaemonCommand {

    /// Commands that act on an application: their receipts carry a delivery verdict and a
    /// recording captures them.
    public static let actions: Set<String> = [
        "click", "scroll", "move", "drag", "type", "key", "select", "run", "adopt", "place",
        "repark", "open.url",
    ]

    /// Commands that mutate a session and therefore need its controller lease.
    ///
    /// This exists as shared data rather than a literal in each client because the two copies
    /// drift silently and in opposite directions: a client that forgets an entry sends work the
    /// daemon refuses with "controller lease is required", and the agent has no way to supply
    /// one because leases are deliberately never returned in a session list. Adding a mutating
    /// command means adding it here, once.
    public static let ownerScopedMutations: Set<String> = [
        "session.heartbeat",
        "session.control",
        "run",
        "adopt",
        "click",
        "scroll",
        "move",
        "drag",
        "type",
        "key",
        "select",
        "repark",
        "place",
        "target.attach",
        "open.url",
        "steps.run",
        "clipboard.set",
        "session.annotate",
        // Pressing acts on the app; listing reveals its state, so both need the lease.
        "menu",
    ]

    /// Commands that read one session's covered state — its windows, accessibility tree,
    /// pixels, or audit — and therefore need that session's controller lease. Unscoped
    /// inventory (`session.list`, `pool`) deliberately stays open; cross-agent *content* is
    /// what leases fence, so a second client cannot screenshot or dump another agent's work.
    public static let ownerScopedReads: Set<String> = [
        "windows",
        "ax",
        "screenshot",
        "verify",
        "targets",
        "ax.find",
        "ax.text",
        "wait",
        "clipboard.get",
    ]

    /// Commands that mint a new controller lease for the caller instead of presenting one.
    ///
    /// `session.claim` is here and deliberately in neither owner-scoped set: it exists for the
    /// controller that has *lost* its lease (an MCP client restart), so demanding a lease would
    /// make it useless. The daemon grants it only for an abandoned session. Leases coordinate
    /// same-user clients; they are not a security boundary.
    public static let leaseIssuing: Set<String> = [
        "session.create",
        "session.claim",
    ]
}

public struct WindowInfo: Codable, Sendable {
    public var windowID: UInt32
    public var pid: Int32
    public var title: String
    public var x: Double, y: Double, width: Double, height: Double
    public var onStage: Bool
    public var spaces: [UInt64]
    /// The owning application reports this window as its focused window (where its keys go).
    public var focused: Bool?
    /// The window is an application-modal dialog or sheet that blocks the rest of the app.
    public var modal: Bool?
    /// Commands that omit `window` act on this one.
    public var defaultTarget: Bool?

    public init(_ window: WindowRef, session: AgentSession) {
        self.windowID = window.windowID
        self.pid = window.pid
        self.title = window.title
        self.x = window.frame.origin.x
        self.y = window.frame.origin.y
        self.width = window.frame.width
        self.height = window.frame.height
        self.onStage = WindowPlacement.isContained(window, in: session.frame)
        self.spaces = WindowPlacement.spaces(of: window)
        let markers = session.focusMarkers(for: window)
        self.focused = markers.focused
        self.modal = markers.modal
        self.defaultTarget = markers.defaultTarget
    }

    /// A row from the retained ledger when discovery could not confirm the window's owner.
    /// Window IDs are recycled, so nothing here asks the WindowServer about this ID: placement
    /// is judged from the last-known frame, Spaces are unknown (empty), and so is the default
    /// target, whose choice reads live geometry. Focus comes from cached observations.
    init(lastKnown window: WindowRef, session: AgentSession) {
        self.windowID = window.windowID
        self.pid = window.pid
        self.title = window.title
        self.x = window.frame.origin.x
        self.y = window.frame.origin.y
        self.width = window.frame.width
        self.height = window.frame.height
        self.onStage = WindowPlacement.isFullyInside(window.frame, session.frame)
        self.spaces = []
        let markers = session.cachedFocusMarkers(for: window)
        self.focused = markers.focused
        self.modal = markers.modal
        self.defaultTarget = nil
    }
}

public struct AppInfo: Codable, Sendable {
    public var pid: Int32
    public var name: String
    public var bundleID: String?
    public var startedByUs: Bool

    public init(_ app: LaunchedApp) {
        self.pid = app.pid
        self.name = app.name
        self.bundleID = app.bundleIdentifier
        self.startedByUs = app.startedByUs
    }

    public init(_ app: DurableSessionApp) {
        self.pid = app.identity.pid
        self.name = app.name
        self.bundleID = app.bundleIdentifier
        self.startedByUs = app.provenance == .launched
    }
}

public struct SessionInfo: Codable, Sendable {
    public var id: String
    public var generation: UUID?
    public var lifecycleReason: String?
    public var displayID: UInt32
    /// The session's tile, not the whole display.
    public var x: Double, y: Double, width: Double, height: Double
    public var tileIndex: Int
    public var tileCapacity: Int
    public var exclusiveDisplay: Bool
    public var spaces: [UInt64]
    public var hasOwnSpace: Bool
    public var apps: [AppInfo]
    public var windows: [WindowInfo]
    public var createdAt: Date
    public var teardownPending: Bool
    /// `false` for diagnostic records recovered from a prior daemon. Their persisted display
    /// and tile coordinates are never authority to target a current WindowServer object.
    ///
    /// Optional for wire compatibility with older daemons, whose session lists contained only
    /// attached runtime sessions.
    public var runtimeAttached: Bool?
    public var controllerOwner: DurableSessionOwner?
    public var ageSeconds: Double?
    public var lastActivityAt: Date?
    public var leaseExpiresAt: Date?
    public var abandoned: Bool?
    public var reclaimable: Bool?
    public var recoveryBlockers: [DurableRecoveryBlocker]?
    /// Set when another controller holds this session and the caller lacks operator scope:
    /// `apps` and `windows` were deliberately emptied, not observed to be empty.
    public var redacted: Bool?
    /// Whether agent-originated input commands are currently refused for this live session.
    public var inputPaused: Bool?
    /// Most recent successful agent input action, for Viewer arbitration and observability.
    public var lastAgentAction: String?
    public var lastAgentActionAt: Date?
    /// Where the last agent action landed, window-local, so the Viewer can draw it on the
    /// canvas. Absent for actions with no point (typing, key presses, launches).
    public var lastAgentActionX: Double?
    public var lastAgentActionY: Double?
    public var lastAgentActionWindowID: UInt32?
    /// `confirmed`, `unconfirmed`, or `refused` — the same vocabulary as action receipts.
    public var lastAgentActionOutcome: String?
    /// Role and label of the element the action addressed, when it addressed one.
    public var lastAgentActionTarget: String?
    /// Human-readable task title set by the agent (`title` on create) or renamed by the human.
    public var title: String?
    /// Colour tag chosen in the Viewer; persisted in the ledger.
    public var colorTag: String?
    /// Note the human left when handing Control back. Present while unread by the agent.
    public var operatorHandoff: OperatorHandoff?
    /// Why the agent paused itself, when it said so.
    public var agentPauseReason: String?
    /// Recording mode when the daemon records this session's actions.
    public var recording: String?
    /// Seconds since the controller last acted on or read this session. Lease heartbeats do
    /// not count, so a forgotten session shows its real idle time.
    public var idleSeconds: Double?
    public var lastOwnerActionAt: Date?
    /// Apps this session held that have since exited, most recent first (bounded).
    public var exitedApps: [ExitedAppInfo]?
    /// How long this session survives its controller's exit before its apps are quit.
    public var orphanGraceSeconds: Double?
    /// Abandoned sessions only: seconds left to `session.claim` it before the janitor quits its
    /// apps. Zero means reclamation is due on the janitor's next pass.
    public var graceRemainingSeconds: Double?
    /// Why the latest window refresh did not complete. `windows` is then the retained
    /// last-known ledger, not a fresh observation.
    public var windowDiscoveryFailure: String?

    /// `lastKnownWindows` builds window rows from the retained ledger alone; it also applies
    /// whenever the session's latest refresh failed.
    public init(_ session: AgentSession, includeLiveGeometry: Bool = true, lastKnownWindows: Bool = false) {
        let bounds = includeLiveGeometry ? session.frame : .zero
        let controller = session.controllerSnapshot()
        self.id = session.id
        self.generation = session.generation
        self.lifecycleReason = session.teardownPending
            ? "cleanup_pending"
            : (session.isDisplayLost
                ? "display_lost"
                : (session.windows.isEmpty ? "window_absent_reason_unknown" : nil))
        self.displayID = session.stage.displayID
        self.x = bounds.origin.x
        self.y = bounds.origin.y
        self.width = bounds.width
        self.height = bounds.height
        self.tileIndex = session.slot.index
        self.tileCapacity = session.slot.capacity
        self.exclusiveDisplay = session.hasExclusiveDisplay
        self.spaces = includeLiveGeometry ? session.stage.spaces : []
        self.hasOwnSpace = includeLiveGeometry && session.stage.hasOwnSpace
        self.apps = session.apps.map(AppInfo.init)
        let unverified = lastKnownWindows || session.windowRefreshFailure != nil
        self.windows = includeLiveGeometry
            ? session.windows.map {
                unverified ? WindowInfo(lastKnown: $0, session: session) : WindowInfo($0, session: session)
            } : []
        self.createdAt = session.createdAt
        self.teardownPending = session.teardownPending
        self.runtimeAttached = true
        self.controllerOwner = controller?.owner
        self.ageSeconds = controller?.ageSeconds
        self.lastActivityAt = controller?.lastActivityAt
        self.leaseExpiresAt = controller?.lease.expiresAt
        self.abandoned = controller?.abandoned
        self.reclaimable = controller?.reclaimable
        self.idleSeconds = controller?.idleSeconds
        self.lastOwnerActionAt = controller?.lastOwnerActionAt
        self.orphanGraceSeconds = controller?.gracePeriod
        self.graceRemainingSeconds = controller?.graceRemainingSeconds
        self.windowDiscoveryFailure = includeLiveGeometry ? session.windowRefreshFailure : nil
        self.recoveryBlockers = nil
        let input = session.agentInputSnapshot()
        self.inputPaused = input.paused
        self.lastAgentAction = input.lastAction
        self.lastAgentActionAt = input.lastActionAt
        self.lastAgentActionX = input.lastActionPoint.map { Double($0.x) }
        self.lastAgentActionY = input.lastActionPoint.map { Double($0.y) }
        self.lastAgentActionWindowID = input.lastActionWindowID
        self.lastAgentActionOutcome = input.lastActionOutcome
        self.lastAgentActionTarget = input.lastActionTarget
        self.agentPauseReason = input.pauseReason
        let annotation = session.annotationSnapshot()
        self.title = annotation.title
        self.colorTag = annotation.colorTag
        self.operatorHandoff = annotation.pendingHandoff
        self.recording = annotation.recording
        let exited = session.exitedApps()
        self.exitedApps = exited.isEmpty ? nil : exited
        if self.lifecycleReason == "window_absent_reason_unknown", !exited.isEmpty,
           !session.apps.contains(where: { $0.identity.isAlive }) {
            self.lifecycleReason = "app_exited"
        }
    }

    /// Observer-only representation of a session recovered from a prior daemon.
    ///
    /// Placement is included so operators can diagnose what the old daemon owned, but
    /// `runtimeAttached == false` is the load-bearing instruction that no current display,
    /// window, Space, or input route may be inferred from those numbers.
    public init(_ record: DurableSessionRecord, now: Date = Date()) {
        let placement = record.lastKnownPlacement
        self.id = record.id
        self.displayID = placement?.displayID ?? 0
        self.x = placement?.x ?? 0
        self.y = placement?.y ?? 0
        self.width = placement?.width ?? 0
        self.height = placement?.height ?? 0
        self.tileIndex = placement?.tileIndex ?? 0
        self.tileCapacity = placement?.tileCapacity ?? 0
        self.exclusiveDisplay = placement?.exclusiveDisplay ?? false
        self.spaces = []
        self.hasOwnSpace = false
        self.apps = record.apps.map(AppInfo.init)
        self.windows = []
        self.createdAt = record.createdAt
        self.teardownPending = record.operationState != .ready
        self.runtimeAttached = false
        self.controllerOwner = record.owner
        self.ageSeconds = max(0, now.timeIntervalSince(record.createdAt))
        self.lastActivityAt = record.lastActivityAt
        self.leaseExpiresAt = nil
        self.abandoned = record.ownershipState == .abandoned
        self.reclaimable = record.recoveryState == .reclaimable
        self.graceRemainingSeconds = record.reclaimableAfter.map {
            max(0, $0.timeIntervalSince(now))
        }
        self.recoveryBlockers =
            record.recoveryBlockers.isEmpty ? nil : record.recoveryBlockers
        self.inputPaused = nil
        self.lastAgentAction = nil
        self.lastAgentActionAt = nil
        self.title = record.title
        self.colorTag = record.colorTag
    }
}

/// What the human did while holding Control, delivered to the agent exactly once on resume.
public struct OperatorHandoff: Codable, Sendable, Equatable {
    public var note: String?
    public var controlDurationSeconds: Double
    public var windowsChanged: Bool
    public var releasedAt: Date

    public init(note: String?, controlDurationSeconds: Double, windowsChanged: Bool, releasedAt: Date) {
        self.note = note
        self.controlDurationSeconds = controlDurationSeconds
        self.windowsChanged = windowsChanged
        self.releasedAt = releasedAt
    }

    /// The one line an agent reads at the top of its next response.
    public var summaryLine: String {
        let seconds = Int(max(0, controlDurationSeconds).rounded())
        var line = "HUMAN HANDOFF: the operator held Control for \(seconds)s"
        line += windowsChanged ? " and the window set changed" : "; windows unchanged"
        if let note, !note.isEmpty { line += ". Note: \(note)" }
        line += ". Re-read the screen before acting on stale indices."
        return line
    }
}

/// One line of the daemon's event stream (`events.subscribe`, `events.poll`).
public struct DaemonEvent: Codable, Sendable, Equatable {
    public var seq: UInt64
    public var at: Date
    /// Every kind the daemon emits, and nothing it does not:
    /// session.created, session.claimed, session.destroyed (detail `reason`: owner, operator,
    /// janitor_abandoned, detached_recovery), session.display_lost, session.annotated,
    /// app.launched, app.exited, window.escaped (first refusal of a window outside its tile),
    /// window.reparked, agent.action, operator.action, input.paused, input.resumed,
    /// isolation.verdict, lease.expiring (80% of the TTL elapsed without renewal),
    /// recording.stopped, daemon.draining, bus.subscriber_limit.
    public var kind: String
    public var session: String?
    public var detail: [String: String]
    /// True when the subscriber's lease or scope did not cover the session, so `detail` was
    /// emptied rather than observed to be empty.
    public var redacted: Bool?

    public init(seq: UInt64, at: Date, kind: String, session: String?, detail: [String: String], redacted: Bool? = nil) {
        self.seq = seq
        self.at = at
        self.kind = kind
        self.session = session
        self.detail = detail
        self.redacted = redacted
    }
}

/// Why a screen read stopped short, stated on every read so silence never means "complete".
public struct TruncationReport: Codable, Sendable, Equatable {
    public var shown: Int
    public var truncated: Bool
    /// Reasons may be combined with `+`: traversal/value clipping, native/page result caps,
    /// the page index cap, or unavailable page evidence. Nil when complete.
    public var reason: String?
    public var hint: String?

    public init(shown: Int, truncated: Bool, reason: String? = nil, hint: String? = nil) {
        self.shown = shown
        self.truncated = truncated
        self.reason = reason
        self.hint = hint
    }

    public var footer: String {
        var text = "elements: \(shown) shown, truncated: \(truncated)"
        if let reason { text += ", reason: \(reason)" }
        if let hint { text += ", hint: \(hint)" }
        return text
    }
}

/// An incremental screen read: what changed since the snapshot the caller named.
public struct ScreenDiff: Codable, Sendable, Equatable {
    public var baseSnapshotID: String
    public var added: [String]
    public var removed: [String]
    public var changed: [String]
    public var unchangedCount: Int
    /// The base was gone (daemon restarted, window replaced); the full outline was returned.
    public var baseMissing: Bool

    public init(baseSnapshotID: String, added: [String], removed: [String], changed: [String], unchangedCount: Int, baseMissing: Bool) {
        self.baseSnapshotID = baseSnapshotID
        self.added = added
        self.removed = removed
        self.changed = changed
        self.unchangedCount = unchangedCount
        self.baseMissing = baseMissing
    }
}

/// Receipt for one step of `steps.run`, shaped like the single-call response it stands for.
public struct StepReceipt: Codable, Sendable, Equatable {
    public var index: Int
    public var cmd: String
    public var ok: Bool
    public var executed: Bool
    public var message: String?
    public var error: String?
    public var errorCode: String?
    public var completion: String?
    /// Observation from this step, not a guarantee that later steps left these indices current.
    public var outline: String?
    public var snapshotID: String?
    public var outputTruncated: Bool?
    /// Completeness of the underlying observation, separate from clipping the step output.
    public var truncation: TruncationReport?
    static let maximumOutlineBytes = 16 * 1_024

    public init(index: Int, cmd: String, ok: Bool, executed: Bool, message: String? = nil, error: String? = nil, errorCode: String? = nil, completion: String? = nil, outline: String? = nil, snapshotID: String? = nil, outputTruncated: Bool? = nil, truncation: TruncationReport? = nil) {
        self.index = index
        self.cmd = cmd
        self.ok = ok
        self.executed = executed
        self.message = message
        self.error = error
        self.errorCode = errorCode
        self.completion = completion
        self.outline = outline
        self.snapshotID = snapshotID
        self.outputTruncated = outputTruncated
        self.truncation = truncation
    }

    init(index: Int, cmd: String, response: Response, executed: Bool = true) {
        self.init(index: index, cmd: cmd, ok: response.ok, executed: executed,
                  message: response.message.map { String($0.prefix(400)) },
                  error: response.error, errorCode: response.errorCode,
                  completion: response.action?.completion ?? response.wait?.outcome,
                  outline: response.outline.map { EventBus.utf8Prefix($0, maximumBytes: Self.maximumOutlineBytes) },
                  snapshotID: response.snapshotID,
                  outputTruncated: response.outline.map { $0.utf8.count > Self.maximumOutlineBytes } == true ? true : nil,
                  truncation: response.truncation)
    }
}

/// The point a pointer action actually used, so an agent that addressed an element learns the
/// coordinate for later.
public struct ResolvedPoint: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double
    /// `element` or `coordinates`.
    public var source: String
    public var element: String?
    public var toX: Double?
    public var toY: Double?

    public init(x: Double, y: Double, source: String, element: String? = nil, toX: Double? = nil, toY: Double? = nil) {
        self.x = x
        self.y = y
        self.source = source
        self.element = element
        self.toX = toX
        self.toY = toY
    }
}

/// Outcome of a bounded `wait`.
public struct WaitReceipt: Codable, Sendable, Equatable {
    public var condition: String
    public var value: String?
    /// `met`, `timeout`, or `cancelled`.
    public var outcome: String
    public var elapsedSeconds: Double
    public var matchedIndex: Int?
    public var matchedTitle: String?
    public var snapshotID: String?
    public var probes: Int
    /// `window_title_contains`: id of the window whose title matched.
    public var matchedWindowID: UInt32?
    /// `session_resumed`: the operator's hand-back note, when one was left.
    public var handoffNote: String?

    public init(condition: String, value: String?, outcome: String, elapsedSeconds: Double, matchedIndex: Int? = nil, matchedTitle: String? = nil, snapshotID: String? = nil, probes: Int,
                matchedWindowID: UInt32? = nil, handoffNote: String? = nil) {
        self.condition = condition
        self.value = value
        self.outcome = outcome
        self.elapsedSeconds = elapsedSeconds
        self.matchedIndex = matchedIndex
        self.matchedTitle = matchedTitle
        self.snapshotID = snapshotID
        self.probes = probes
        self.matchedWindowID = matchedWindowID
        self.handoffNote = handoffNote
    }
}

/// How a brokered paste reached the target. `refused` is a real outcome, never a success.
public struct PasteReceipt: Codable, Sendable, Equatable {
    /// `accessibility`, `typing`, `devtools`, or `refused`.
    public var insertedVia: String
    public var bytes: Int
    public var note: String?

    public init(insertedVia: String, bytes: Int, note: String? = nil) {
        self.insertedVia = insertedVia
        self.bytes = bytes
        self.note = note
    }
}

/// Result of `open.url`.
public struct NavigationReceipt: Codable, Sendable, Equatable {
    public var title: String
    public var finalURL: String
    public var targetID: String
    /// `complete` or `timeout`.
    public var load: String
    public var reusedBrowser: Bool

    public init(title: String, finalURL: String, targetID: String, load: String, reusedBrowser: Bool) {
        self.title = title
        self.finalURL = finalURL
        self.targetID = targetID
        self.load = load
        self.reusedBrowser = reusedBrowser
    }
}

/// What a captured image's pixels mean, so a coordinate read off it can be clicked.
///
/// Without this an agent cannot tell a 2× window capture from a 1× tile capture, and there is no
/// way to recover the difference from the image alone: it reads a coordinate off the picture,
/// sends it as a click, and lands at half or double the intended position — near the top-left it
/// silently hits the wrong control, near the edges it fails as out-of-bounds. Every field here
/// exists to make that conversion mechanical rather than guessed.
public struct ImageGeometry: Codable, Sendable, Equatable {
    /// `window` — coordinates are window-local, directly usable as click x/y.
    /// `tile` — coordinates are measured from `originX`/`originY`, the *global* origin of the
    /// captured area. For a zoomed sub-region that is the sub-region's origin, not the tile's,
    /// so neither the tile nor the window origin alone converts it. Use `clickPoint`.
    public var origin: String
    /// Pixels per point. Divide an image pixel coordinate by this to get a click coordinate.
    public var scale: Double
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var pointWidth: Double
    public var pointHeight: Double
    /// Global-screen origin of the captured area, so tile and window spaces can be related.
    public var originX: Double
    public var originY: Double
    /// The window a `window` capture belongs to; nil for a tile capture.
    public var windowID: UInt32?

    public init(
        origin: String,
        scale: Double,
        pixelWidth: Int,
        pixelHeight: Int,
        pointWidth: Double,
        pointHeight: Double,
        originX: Double,
        originY: Double,
        windowID: UInt32? = nil
    ) {
        self.origin = origin
        self.scale = scale
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.pointWidth = pointWidth
        self.pointHeight = pointHeight
        self.originX = originX
        self.originY = originY
        self.windowID = windowID
    }

    /// The window-local point `click` takes for a pixel read off this image.
    ///
    /// Three spaces meet here and all three terms are load-bearing. A pixel is measured from the
    /// captured area's *global* origin; `click` is measured from the target window's *global*
    /// origin; `scale` relates pixels to points. Omitting `+ originX` — as the advice text used
    /// to — puts a tile screenshot's coordinates a whole tile away from the window, which `click`
    /// then refuses as out of bounds. `windowX`/`windowY` are the target window's `x`/`y` from
    /// `list_windows`. For a `window` capture the two origins are the same window, so those terms
    /// cancel and the formula degrades to `pixel / scale` on its own.
    public func clickPoint(
        pixelX: Double,
        pixelY: Double,
        windowX: Double,
        windowY: Double
    ) -> CGPoint {
        CGPoint(x: pixelX / scale + originX - windowX,
                y: pixelY / scale + originY - windowY)
    }

    /// One line an agent can act on without consulting documentation.
    ///
    /// The tile form spells out the arithmetic with this capture's actual origin substituted in,
    /// because an agent that has to infer the origin term is an agent that omits it.
    public var advice: String {
        let divisor = Self.plain(scale)
        let scaledX = scale == 1 ? "pixel_x" : "pixel_x / \(divisor)"
        let scaledY = scale == 1 ? "pixel_y" : "pixel_y / \(divisor)"
        if origin == "window" {
            return scale == 1
                ? "Image pixels are window-local points: click these coordinates directly."
                : "Image is \(divisor)x window-local. Divide pixel coordinates by \(divisor) to "
                    + "get click coordinates: x = \(scaledX), y = \(scaledY)."
        }
        return "Image \(scale == 1 ? "pixels are points" : "is \(divisor)x and") measured from "
            + "this capture's global origin (\(Self.plain(originX)), \(Self.plain(originY))), "
            + "not from any window. click takes window-local points, so: "
            + "x = \(scaledX) \(Self.signedTerm(originX)) - windowX, "
            + "y = \(scaledY) \(Self.signedTerm(originY)) - windowY, "
            + "where windowX/windowY are the target window's x/y from list_windows."
    }

    /// `1512.0` as `1512`, so a formula an agent reads is a formula it can retype.
    static func plain(_ value: Double) -> String {
        guard value.isFinite, value == value.rounded(), abs(value) < 1e15 else {
            return String(value)
        }
        return String(Int(value))
    }

    /// The origin term with its own sign, so a negative origin reads `- 12` rather than `+ -12`.
    static func signedTerm(_ value: Double) -> String {
        value < 0 ? "- \(plain(-value))" : "+ \(plain(value))"
    }
}

/// Effective allocation limits, flattened for wire compatibility.
public struct ResourceLimitsReport: Codable, Sendable, Equatable {
    public var policy: String?
    public var maximumSessions: Int
    public var maximumDisplays: Int
    public var maximumTotalPixels: Int
    public var maximumTotalBytes: Int
    public var maximumCreationsPerMinute: Int
    /// Persistent per-user lifecycle cap, including the unrestricted resource mode.
    /// Nil when decoding an older daemon that did not report the ten-minute window.
    public var maximumCreationsPerTenMinutes: Int?
    public var maximumCreationsPerDay: Int?
    /// True when persistent rolling creation admission is explicitly bypassed for diagnostics.
    /// Pool resource limits still apply; absent for normal and older reports.
    public var creationRateTestingOverride: Bool?
    public var minimumTileWidth: Int
    public var minimumTileHeight: Int
    public var maximumDisplayEdge: Int
    /// True only for the explicit unrestricted daemon-start override.
    public var unsafeOperatorMode: Bool

    public init(_ budget: ResourceBudget) {
        self.init(budget, testingOverride: DisplayTestingPolicy.enabled())
    }

    init(_ budget: ResourceBudget, testingOverride: Bool) {
        policy = budget.isUnsafe ? "explicit-unrestricted-operator-override" : "bounded"
        maximumSessions = budget.maximumSessions
        maximumDisplays = budget.maximumDisplays
        maximumTotalPixels = budget.maximumTotalPixels
        maximumTotalBytes = budget.maximumTotalBytes
        maximumCreationsPerMinute = testingOverride ? budget.maximumCreationsPerMinute
            : min(budget.maximumCreationsPerMinute, DisplayLifecycleLease.maximumCreationsPerMinute)
        maximumCreationsPerTenMinutes = testingOverride ? nil : DisplayLifecycleLease.maximumCreationsPerTenMinutes
        maximumCreationsPerDay = testingOverride ? nil : DisplayLifecycleLease.maximumCreationsPerDay
        creationRateTestingOverride = testingOverride ? true : nil
        minimumTileWidth = Int(budget.minimumTileSize.width)
        minimumTileHeight = Int(budget.minimumTileSize.height)
        maximumDisplayEdge = budget.maximumDisplayEdge
        unsafeOperatorMode = budget.isUnsafe
    }
}

/// A process that was still alive after every requested graceful and forced quit attempt.
public struct SurvivingProcessInfo: Codable, Sendable, Equatable {
    public var identity: ProcessIdentity
    public var pid: Int32
    public var name: String

    public init(_ app: LaunchedApp) {
        identity = app.identity
        pid = app.pid
        name = app.name
    }
}

/// A window that was still on the agent display after teardown evacuated what it could.
///
/// Evacuation is best effort — an app-modal sheet stays attached to its parent and refuses to
/// move — so teardown re-reads authoritative bounds and reports what stayed behind.
public struct StrandedWindowInfo: Codable, Sendable, Equatable {
    public var windowID: UInt32
    public var pid: Int32
    public var title: String
    /// True when the window is still inside the destroyed session's own tile, which is the
    /// case that would leak into the next session's capture of that tile.
    public var inTile: Bool

    public init(window: WindowRef, inTile: Bool) {
        windowID = window.windowID
        pid = window.pid
        title = window.title
        self.inTile = inTile
    }
}

/// Structured outcome of a session or daemon teardown.
///
/// An incomplete report is deliberately retryable. Pending sessions and displays remain owned
/// by the daemon until a later cleanup attempt proves their resources are gone.
public struct TeardownReport: Codable, Sendable, Equatable {
    public var survivingProcesses: [SurvivingProcessInfo]
    public var strandedWindows: [StrandedWindowInfo]
    public var stillAttachedDisplayIDs: [UInt32]
    public var pendingSessionIDs: [String]
    /// Bounded producer diagnostics; absent in reports from older daemons.
    public var windowDiscoveryFailures: [String]?

    public init(
        survivingProcesses: [SurvivingProcessInfo] = [],
        strandedWindows: [StrandedWindowInfo] = [],
        stillAttachedDisplayIDs: [UInt32] = [],
        pendingSessionIDs: [String] = [],
        windowDiscoveryFailures: [String]? = nil
    ) {
        self.survivingProcesses = survivingProcesses
        self.strandedWindows = strandedWindows
        self.stillAttachedDisplayIDs = Array(Set(stillAttachedDisplayIDs)).sorted()
        self.pendingSessionIDs = Array(Set(pendingSessionIDs)).sorted()
        self.windowDiscoveryFailures = windowDiscoveryFailures
    }

    /// Older daemons omit stranded windows and discovery diagnostics, but still report the
    /// other three fields exactly. Defaulting a *missing* surviving-process list to
    /// empty would turn a truncated payload into a false "teardown complete".
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            survivingProcesses: try container.decode(
                [SurvivingProcessInfo].self, forKey: .survivingProcesses),
            strandedWindows: try container.decodeIfPresent(
                [StrandedWindowInfo].self, forKey: .strandedWindows) ?? [],
            stillAttachedDisplayIDs: try container.decode(
                [UInt32].self, forKey: .stillAttachedDisplayIDs),
            pendingSessionIDs: try container.decode(
                [String].self, forKey: .pendingSessionIDs),
            windowDiscoveryFailures: try container.decodeIfPresent(
                [String].self, forKey: .windowDiscoveryFailures))
    }

    public var isComplete: Bool {
        survivingProcesses.isEmpty
            && strandedWindows.isEmpty
            && stillAttachedDisplayIDs.isEmpty
            && pendingSessionIDs.isEmpty
            && (windowDiscoveryFailures?.isEmpty ?? true)
    }

    public mutating func merge(_ other: TeardownReport) {
        let processes = Dictionary(
            (survivingProcesses + other.survivingProcesses).map {
                ($0.identity, $0)
            },
            uniquingKeysWith: { current, _ in current })
        survivingProcesses = processes.values.sorted {
            ($0.pid, $0.identity.startedAtMicroseconds)
                < ($1.pid, $1.identity.startedAtMicroseconds)
        }
        let windows = Dictionary(
            (strandedWindows + other.strandedWindows).map { ($0.windowID, $0) },
            uniquingKeysWith: { current, _ in current })
        strandedWindows = windows.values.sorted { ($0.pid, $0.windowID) < ($1.pid, $1.windowID) }
        stillAttachedDisplayIDs = Array(
            Set(stillAttachedDisplayIDs).union(other.stillAttachedDisplayIDs)
        ).sorted()
        pendingSessionIDs = Array(
            Set(pendingSessionIDs).union(other.pendingSessionIDs)
        ).sorted()
        if windowDiscoveryFailures != nil || other.windowDiscoveryFailures != nil {
            windowDiscoveryFailures = Array(Set(windowDiscoveryFailures ?? [])
                .union(other.windowDiscoveryFailures ?? [])).sorted()
        }
    }

    public var recoveryDescription: String {
        var lines = ["teardown incomplete; SpaceO kept ownership so cleanup can be retried."]
        for failure in windowDiscoveryFailures ?? [] {
            lines.append("  Window discovery incomplete: \(failure)")
        }
        if windowDiscoveryFailures?.isEmpty == false {
            lines.append("  Retry cleanup after the app responds.")
        }
        if !survivingProcesses.isEmpty {
            let listed = survivingProcesses.map {
                "\($0.name) pid \($0.pid) "
                    + "(started \($0.identity.startedAtMicroseconds))"
            }.joined(separator: ", ")
            lines.append("  Processes still alive: \(listed).")
            lines.append(
                "  Close any save dialogs or quit those exact processes, then retry cleanup.")
        }
        if !strandedWindows.isEmpty {
            let listed = strandedWindows.map {
                "\($0.title.isEmpty ? "untitled" : $0.title) "
                    + "(window \($0.windowID), pid \($0.pid))"
            }.joined(separator: ", ")
            lines.append("  Windows still on the agent display: \(listed).")
            lines.append(
                "  These refused to move out, so SpaceO kept the tile rather than recycling it "
                    + "under them. Close their dialogs or move them yourself, then retry cleanup.")
        }
        if !stillAttachedDisplayIDs.isEmpty {
            lines.append(
                "  Virtual displays still attached: "
                    + stillAttachedDisplayIDs.map(String.init).joined(separator: ", ")
                    + ".")
        }
        if pendingSessionIDs.isEmpty {
            lines.append("  Retry with `spaceo session destroy --all` or `spaceo daemon stop`.")
        } else {
            lines.append(
                "  Pending sessions: \(pendingSessionIDs.joined(separator: ", ")). "
                    + "Retry their destroy command, `spaceo session destroy --all`, "
                    + "or `spaceo daemon stop`.")
        }
        lines.append(
            "  If a display remains after its processes exit, retry once more; "
                + "run `spaceo doctor` before restarting the login session.")
        return lines.joined(separator: "\n")
    }
}

/// An app that exited while its session was live.
public struct ExitedAppInfo: Codable, Sendable, Equatable {
    public var name: String
    public var pid: Int32
    public var exitedAt: Date
    public var startedByUs: Bool
    /// `exited(N)`, `signal(N)`, or nil when the status could not be observed.
    public var status: String?

    public init(name: String, pid: Int32, exitedAt: Date, startedByUs: Bool, status: String? = nil) {
        self.name = name
        self.pid = pid
        self.exitedAt = exitedAt
        self.startedByUs = startedByUs
        self.status = status
    }
}

/// What `session.destroy` (or the janitor, or recovery) actually did.
public struct DestroySummary: Codable, Sendable, Equatable {
    /// `owner`, `operator`, `janitor_abandoned`, `janitor_idle`, or `detached_recovery`.
    public var reason: String
    /// Apps SpaceO launched and quit, by name, including any listed in `forcedApps`. Only
    /// processes confirmed gone are listed; survivors fail the destroy instead.
    public var quitApps: [String]
    /// Apps that had to be force-terminated after a graceful quit timed out.
    public var forcedApps: [String]
    /// Adopted apps that were released (left running) rather than quit.
    public var releasedApps: [String]
    public var durationSeconds: Double
    public var actionCount: Int?
    public var recordingPath: String?
    public var recordingError: String?
    public var clipboardCleared: Bool
    public var profilesRemoved: Int

    public init(reason: String, quitApps: [String] = [], forcedApps: [String] = [],
                releasedApps: [String] = [], durationSeconds: Double, actionCount: Int? = nil,
                recordingPath: String? = nil, recordingError: String? = nil,
                clipboardCleared: Bool = false, profilesRemoved: Int = 0) {
        self.reason = reason
        self.quitApps = quitApps
        self.forcedApps = forcedApps
        self.releasedApps = releasedApps
        self.durationSeconds = durationSeconds
        self.actionCount = actionCount
        self.recordingPath = recordingPath
        self.recordingError = recordingError
        self.clipboardCleared = clipboardCleared
        self.profilesRemoved = profilesRemoved
    }

    /// One line for a human or an agent, e.g.
    /// `quit TextEdit, Chrome (1 forced); released Notes; recording saved; 1.4s`.
    public var summaryLine: String {
        var parts: [String] = []
        if !quitApps.isEmpty {
            parts.append("quit " + quitApps.joined(separator: ", ")
                + (forcedApps.isEmpty ? "" : " (\(forcedApps.count) forced)"))
        }
        if !releasedApps.isEmpty {
            parts.append("released " + releasedApps.joined(separator: ", "))
        }
        if parts.isEmpty { parts.append("no apps to quit") }
        if profilesRemoved > 0 { parts.append("\(profilesRemoved) private profile(s) removed") }
        if clipboardCleared { parts.append("session clipboard cleared") }
        if let actionCount { parts.append("\(actionCount) recorded action(s)") }
        if let recordingError {
            parts.append("recording" + (recordingPath.map { " at \($0)" } ?? "")
                + " not finalized: \(recordingError)")
        } else if let recordingPath {
            parts.append("recording saved to \(recordingPath)")
        }
        let seconds = durationSeconds.isFinite ? max(0, durationSeconds) : 0
        parts.append(String(format: "%.1fs", seconds))
        return parts.joined(separator: "; ")
    }
}

/// One capacity holder named in a `resource_limit` failure. Never carries app or window content.
public struct PoolHolder: Codable, Sendable, Equatable {
    public var session: String
    public var owner: String?
    public var ageSeconds: Double?
    public var idleSeconds: Double?
    public var abandoned: Bool
    /// Seconds until the janitor frees this session's tile, when it is already abandoned.
    public var reclaimableInSeconds: Double?

    public init(session: String, owner: String? = nil, ageSeconds: Double? = nil,
                idleSeconds: Double? = nil, abandoned: Bool = false, reclaimableInSeconds: Double? = nil) {
        self.session = session
        self.owner = owner
        self.ageSeconds = ageSeconds
        self.idleSeconds = idleSeconds
        self.abandoned = abandoned
        self.reclaimableInSeconds = reclaimableInSeconds
    }
}

/// One menu-bar item as returned by `menu`.
public struct MenuItemInfo: Codable, Sendable, Equatable {
    public var title: String
    public var enabled: Bool
    public var checked: Bool
    public var hasSubmenu: Bool
    /// Rendered shortcut such as `⌘⇧S`, when the item declares one.
    public var shortcut: String?

    public init(title: String, enabled: Bool = true, checked: Bool = false,
                hasSubmenu: Bool = false, shortcut: String? = nil) {
        self.title = title
        self.enabled = enabled
        self.checked = checked
        self.hasSubmenu = hasSubmenu
        self.shortcut = shortcut
    }
}

public struct Response: Codable, Sendable {
    public var errorCode: String?
    public var nextAction: String?
    public var readiness: ReadinessReport?
    public var verificationAssertion: VerificationAssertion?
    public var geometry: GeometryReceipt?
    public var geometries: [GeometryReceipt]?
    public var displayTarget: DisplayTargetReceipt?
    public var snapshotID: String?
    public var placement: PlacementReceipt?
    public var capture: CaptureReceipt?
    public var imageBase64: String?
    public var action: ActionReceipt?
    public var ok: Bool
    public var error: String?
    public var message: String?
    public var session: SessionInfo?
    public var sessions: [SessionInfo]?
    public var windows: [WindowInfo]?
    public var outline: String?
    /// True when an accessibility or page read stopped at a budget rather than at the end of the
    /// tree. Silence here reads as "this is the whole screen", which is the lie that makes an
    /// agent reason confidently over a partial view.
    public var truncated: Bool?
    public var path: String?
    /// How to convert this image's pixels into click coordinates.
    public var image: ImageGeometry?
    /// Structured isolation coverage and verdict.
    public var isolation: IsolationReport?
    /// Legacy isolation failures. Omitted for a partial report so `[]` cannot be read as clean.
    public var drift: [String]?
    public var ambient: [String]?
    /// Things that happened but could not be confirmed. An empty or absent list means the
    /// command's effect was verified; it is never a place for advisory chatter.
    public var warnings: [String]?
    public var findings: [String]?
    public var displays: [DisplayPool.DisplayReport]?
    /// Packing density used for displays created from now on. Existing display reports retain
    /// the capacity they were created with, so their `capacity` cannot represent this setting
    /// after an operator changes it.
    public var sessionsPerDisplay: Int?
    /// What the pool is holding right now, against the limits it will refuse at. Reported by
    /// `pool` so an operator can see how close they are before an allocation is denied.
    public var usage: ResourceBudget.Usage?
    public var limits: ResourceLimitsReport?
    public var value: String?
    /// Returned only to the controller by create/heartbeat; never included in SessionInfo lists.
    public var controllerLeaseID: UUID?
    /// Present on every incomplete teardown failure, including daemon stop.
    public var teardown: TeardownReport?
    /// Identity of the daemon process that produced this response. Clients use it to detect the
    /// common development/upgrade failure where a newly installed CLI is still connected to an
    /// older long-lived daemon image.
    public var daemon: DaemonRuntimeInfo?
    /// Machine-actionable recovery for the ten most common failures; prose stays in `nextAction`.
    public var recovery: RecoveryHint?
    /// Present on every screen read; `truncated` is the legacy boolean form of the same fact.
    public var truncation: TruncationReport?
    public var diff: ScreenDiff?
    public var steps: [StepReceipt]?
    public var firstFailureIndex: Int?
    public var handoff: OperatorHandoff?
    public var resolvedPoint: ResolvedPoint?
    public var wait: WaitReceipt?
    public var paste: PasteReceipt?
    public var navigation: NavigationReceipt?
    /// `run` found the session already owned a live instance of the app and reused it.
    public var reused: Bool?
    /// `ax.text`: `accessibility` or `devtools`.
    public var source: String?
    public var clipboardBytes: Int?
    public var events: [DaemonEvent]?
    /// Resume with sinceSeq equal to this value; events strictly after it are returned.
    public var nextSeq: UInt64?
    public var resyncRequired: Bool?
    public var reclaimedBytes: Int?
    public var removedPaths: [String]?
    public var quarantinedPaths: [String]?
    /// Typing receipt details: whether Return was appended and whether existing contents were
    /// replaced first.
    public var submitted: Bool?
    public var replaced: Bool?
    /// `key`: the daemon released a key its watchdog found still held.
    public var releasedHeldKeys: [String]?
    /// `session.destroy`: what teardown did, so the caller does not have to infer it.
    public var destroySummary: DestroySummary?
    /// `resource_limit` failures: seconds after which a retry can succeed, when known.
    public var retryAfterSeconds: Double?
    /// `resource_limit` failures: who holds the capacity (no window or app content).
    public var holders: [PoolHolder]?
    /// `menu`: the listed menu level, or the pressed item's siblings.
    public var menu: [MenuItemInfo]?

    public init(ok: Bool) { self.ok = ok }

    public static func failure(_ error: Error) -> Response {
        var response = Response(ok: false)
        // The package's own error types conform to LocalizedError (their errorDescription is
        // their description), so this single call renders deliberate messages for them and
        // still gives Cocoa errors their proper localized text. No per-type casts needed here.
        response.error = error.localizedDescription
        response.errorCode = (error as? SpaceOError)?.code ?? "operation_failed"
        response.nextAction = (error as? SpaceOError)?.nextAction
        response.recovery = (error as? SpaceOError)?.recovery
        if let partial = error as? BackgroundPageOpenFailure {
            response.errorCode = "file_open_incomplete"
            response.steps = partial.steps
            response.firstFailureIndex = partial.failedIndex < partial.total ? partial.failedIndex : nil
            response.nextAction = "Do not replay confirmed opens. Inspect browser targets before retrying a file with unknown delivery."
        }
        if case .notRunning = error as? Transport.TransportError {
            response.errorCode = "daemon_not_running"
            response.nextAction = "spaceo daemon"
        }
        if case .busy = error as? Transport.TransportError {
            response.errorCode = "daemon_busy"
            response.nextAction = "retry after a short back-off; the daemon is serving its connection ceiling"
        }
        if case .teardownIncomplete(let report) = error as? SpaceOError {
            response.teardown = report
        }
        return response
    }

    public static func success(_ message: String? = nil) -> Response {
        var response = Response(ok: true)
        response.message = message
        return response
    }
}

/// Non-secret daemon provenance returned on every socket response.
public struct DaemonRuntimeInfo: Codable, Sendable, Equatable {
    public var version: String
    public var protocolVersion: Int
    public var executableSHA256: String?
    public var executableBuildUUID: String?
    public var pid: Int32
    public var instanceID: UUID
    public var startedAt: Date
    /// Capability state sampled inside the daemon process, rather than inferred from whichever
    /// short-lived CLI or Viewer happens to be asking. Optional for compatibility with daemons
    /// that predate runtime health reporting.
    public var accessibilityGranted: Bool?
    public var screenRecordingGranted: Bool?
    public var canDrive: Bool?
    public var canCapture: Bool?
    /// Bundle name and path of the process macOS attributes this daemon's TCC grants to.
    public var responsibleProcess: String?
    /// True while the daemon refuses new sessions ahead of a restart.
    public var draining: Bool?
    /// Current lifecycle circuit/journal state; absent on older daemons.
    public var displaySafety: DisplaySafetyStatus?
    public var hostHealth: DisplayHostHealthReport?
    /// True when a LaunchAgent supervises this daemon.
    public var supervisedByLaunchd: Bool?

    public init(
        version: String,
        protocolVersion: Int = 1,
        executableSHA256: String?,
        executableBuildUUID: String? = nil,
        pid: Int32,
        instanceID: UUID,
        startedAt: Date,
        accessibilityGranted: Bool? = nil,
        screenRecordingGranted: Bool? = nil,
        canDrive: Bool? = nil,
        canCapture: Bool? = nil,
        responsibleProcess: String? = nil,
        draining: Bool? = nil,
        supervisedByLaunchd: Bool? = nil,
        displaySafety: DisplaySafetyStatus? = nil
    ) {
        self.version = version
        self.protocolVersion = protocolVersion
        self.executableSHA256 = executableSHA256
        self.executableBuildUUID = executableBuildUUID
        self.pid = pid
        self.instanceID = instanceID
        self.startedAt = startedAt
        self.accessibilityGranted = accessibilityGranted
        self.screenRecordingGranted = screenRecordingGranted
        self.canDrive = canDrive
        self.canCapture = canCapture
        self.responsibleProcess = responsibleProcess
        self.draining = draining
        self.supervisedByLaunchd = supervisedByLaunchd
        self.displaySafety = displaySafety
    }
}

public enum Wire {
    /// Where the daemon listens. Overridable for tests so a test run never collides with a
    /// daemon the user is actually using.
    public static func socketPath(_ override: String? = nil) -> String {
        if let override { return override }
        if let env = ProcessInfo.processInfo.environment["SPACEO_SOCKET"] { return env }
        return NSTemporaryDirectory() + "spaceo-\(getuid()).sock"
    }

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        // '/' needs no JSON escape. Escaping base64 slashes wastes bandwidth and can push
        // an otherwise permitted 5 MiB image past the transport's 8 MiB response limit.
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
