import Foundation
import AppKit
import CoreGraphics
import SpaceOPrivate

/// Injectable process operations keep teardown deterministic in tests without weakening the
/// production identity checks in `AppLauncher`.
struct SessionAppTeardownDriver: Sendable {
    let isAlive: @Sendable (ProcessIdentity) -> Bool
    let quit: @Sendable (LaunchedApp, Bool) -> Void
    let waitForExit: @Sendable ([LaunchedApp], TimeInterval) -> [LaunchedApp]
    let cleanupTemporaryProfile: @Sendable (LaunchedApp) -> Void

    static let live = SessionAppTeardownDriver(
        isAlive: { $0.isAlive },
        quit: { AppLauncher.quit($0, force: $1) },
        waitForExit: { apps, timeout in
            ProcessExitWait.wait(apps, timeout: timeout) { $0.identity.isAlive }
        },
        cleanupTemporaryProfile: { AppLauncher.cleanupTemporaryProfileEventually(for: $0) }
    )
}

/// Injectable window geometry. Teardown's evacuation verdict depends on what the WindowServer
/// says *after* a move, so a window that refuses to leave the tile must be reproducible in tests
/// without a real display.
struct SessionWindowDriver: Sendable {
    let checkedWindows: @Sendable (pid_t, AXTraversalBudget, Bool) throws -> [WindowRef]
    let movement: @Sendable (ProcessIdentity, AXTraversalBudget) throws -> SessionWindowMovement
    let userDisplayBounds: @Sendable () -> CGRect?
    /// Authoritative live bounds, or nil once the WindowServer no longer knows the window.
    let liveBounds: @Sendable (CGWindowID) -> CGRect?
    /// Authoritative current owner, or nil once the WindowServer no longer knows the window.
    /// Geometry is not identity: window ids are recycled, so anything that keeps a window on a
    /// WindowServer lookup alone can end up holding a stranger's window.
    let liveOwnerPID: @Sendable (CGWindowID) -> pid_t?
    /// The window the application reports as focused, and whether it is modal. Nil is
    /// "unknown", which falls back to the largest window rather than guessing.
    let focusedWindow: @Sendable (pid_t) -> FocusedWindowObservation?

    /// Defaulted so a fake that does not care about ownership keeps compiling; `.live` and every
    /// ownership-sensitive test supply a real answer. `nil` reads as "unknown", and unknown is
    /// never treated as a match.
    init(
        windows: @escaping @Sendable (pid_t) -> [WindowRef],
        userDisplayBounds: @escaping @Sendable () -> CGRect?,
        move: @escaping @Sendable (WindowRef, CGRect) -> Void,
        liveBounds: @escaping @Sendable (CGWindowID) -> CGRect?,
        liveOwnerPID: @escaping @Sendable (CGWindowID) -> pid_t? = { _ in nil },
        checkedWindows: (@Sendable (pid_t, AXTraversalBudget, Bool) throws -> [WindowRef])? = nil,
        movement: (@Sendable (ProcessIdentity, AXTraversalBudget) throws -> SessionWindowMovement)? = nil,
        focusedWindow: @escaping @Sendable (pid_t) -> FocusedWindowObservation? = { _ in nil }
    ) {
        // Existing fake drivers remain usable; live discovery supplies checked paging below.
        let checked: @Sendable (pid_t, AXTraversalBudget, Bool) throws -> [WindowRef] = checkedWindows ?? { pid, budget, _ in
            try budget.check()
            let found = windows(pid)
            for _ in found { try budget.consumeNode() }
            return found
        }
        self.checkedWindows = checked
        self.movement = movement ?? { identity, budget in
            SessionWindowMovement(windows: try checked(identity.pid, budget, true), move: move)
        }
        self.userDisplayBounds = userDisplayBounds
        self.liveBounds = liveBounds
        self.liveOwnerPID = liveOwnerPID
        self.focusedWindow = focusedWindow
    }

    static let live = SessionWindowDriver(
        windows: { WindowPlacement.windows(of: $0) },
        userDisplayBounds: { Stage.preferredActiveUserDisplayBounds() },
        move: { window, frame in _ = try? WindowPlacement.move(window, to: frame) },
        liveBounds: { try? WindowPlacement.liveBounds(of: $0) },
        liveOwnerPID: { WindowPlacement.liveOwnerPID(of: $0) },
        checkedWindows: { try AXWindowDiscovery.liveWindows(of: $0, budget: $1, includeTitles: $2) },
        movement: { try SessionWindowMovement.live(identity: $0, budget: $1) },
        focusedWindow: { AXTree.focusedWindowObservation(pid: $0) })
}

/// How an `AgentSession` builds the watcher that contains an app's late windows.
///
/// Injectable because the failure the session now has to survive — `AXObserverCreate` refusing —
/// cannot be provoked in a test without revoking the machine's Accessibility permission.
typealias WindowWatcherFactory = (pid_t, @escaping () -> CGRect) throws -> WindowWatcher

let liveWindowWatcherFactory: WindowWatcherFactory = { pid, region in
    try WindowWatcher(pid: pid, region: region)
}

/// Runtime policy for controller lease expiry and abandoned-session reclamation.
///
/// The clock and liveness probe are injectable so expiry, PID reuse, and grace periods can be
/// tested without sleeping or launching a controller process.
public struct SessionReclamationPolicy: Sendable {
    public static let clientTTLRange: ClosedRange<TimeInterval> = 30...3_600
    /// Client-requested orphan grace (`orphanGraceSeconds`). The floor keeps today's 30 s
    /// behaviour reachable; the ceiling bounds how long an unowned session can hold a tile and
    /// keep its apps alive after its controller has gone.
    public static let orphanGraceRange: ClosedRange<TimeInterval> = 30...1_800

    let defaultTTL: TimeInterval
    let gracePeriod: TimeInterval
    let now: @Sendable () -> Date
    let ownerIsAlive: @Sendable (DurableSessionOwner) -> Bool

    init(
        defaultTTL: TimeInterval = 300,
        gracePeriod: TimeInterval = 30,
        now: @escaping @Sendable () -> Date = { Date() },
        ownerIsAlive: @escaping @Sendable (DurableSessionOwner) -> Bool = {
            $0.processIdentity?.isAlive ?? true
        }
    ) {
        precondition(defaultTTL.isFinite && defaultTTL > 0)
        precondition(gracePeriod.isFinite && gracePeriod >= 0)
        self.defaultTTL = defaultTTL
        self.gracePeriod = gracePeriod
        self.now = now
        self.ownerIsAlive = ownerIsAlive
    }

    func duration(requested: TimeInterval?) throws -> TimeInterval {
        guard let requested else { return defaultTTL }
        guard requested.isFinite, Self.clientTTLRange.contains(requested) else {
            throw SpaceOError.badRequest(
                "controller TTL must be a finite value from "
                    + "\(Int(Self.clientTTLRange.lowerBound)) through "
                    + "\(Int(Self.clientTTLRange.upperBound)) seconds")
        }
        return requested
    }

    /// Per-session grace between abandonment and reclamation. Nil keeps the daemon default.
    func orphanGrace(requested: TimeInterval?) throws -> TimeInterval {
        guard let requested else { return gracePeriod }
        guard requested.isFinite, Self.orphanGraceRange.contains(requested) else {
            throw SpaceOError.badRequest(
                "orphan grace must be a finite value from "
                    + "\(Int(Self.orphanGraceRange.lowerBound)) through "
                    + "\(Int(Self.orphanGraceRange.upperBound)) seconds")
        }
        return requested
    }
}

struct SessionControllerSnapshot: Sendable {
    let owner: DurableSessionOwner
    let lease: DurableSessionLease
    /// Last owner-scoped mutation *or* heartbeat. Kept for wire and ledger compatibility.
    let lastActivityAt: Date
    /// Last owner-scoped mutation or read. Heartbeats deliberately do not move it, so a
    /// session whose controller only keeps its lease alive still shows how long it sat unused.
    let lastOwnerActionAt: Date
    let abandonedAt: Date?
    let ageSeconds: TimeInterval
    let idleSeconds: TimeInterval
    let abandoned: Bool
    let reclaimable: Bool
    let gracePeriod: TimeInterval
    /// When the janitor may reclaim an abandoned session; nil while it is owned.
    let reclaimableAt: Date?
    /// Seconds left before reclamation, clamped at zero; nil while it is owned.
    let graceRemainingSeconds: TimeInterval?
}

/// Result of a successful `session.claim`.
struct SessionClaimOutcome: Sendable {
    let previousOwner: DurableSessionOwner
    let snapshot: SessionControllerSnapshot
}

/// One agent's world: a tile on a (possibly shared) agent display, the apps living on it,
/// and their windows.
///
/// A session owns a *region*, not a display. Several sessions share one virtual display
/// because a display is an entire framebuffer for the WindowServer to composite — see
/// `DisplayPool`. Every tile is still part of a genuinely visible display, so the property the
/// design rests on is unchanged: windows there keep rendering.
public final class AgentSession: @unchecked Sendable {

    public let id: String
    public let generation = UUID()
    public let slot: DisplayPool.Slot
    public private(set) var apps: [LaunchedApp] = []
    public private(set) var windows: [WindowRef] = [] {
        didSet {
            guard axHistory.count > 0 else { return }
            // Prune only windows that disappeared or changed owner. Geometry/value changes
            // must retain history so agents can still diff after their own actions.
            let owners = Dictionary(windows.map { ($0.windowID, $0.pid) },
                                    uniquingKeysWith: { _, latest in latest })
            for old in oldValue where owners[old.windowID] != old.pid {
                axHistory.forget(windowID: old.windowID)
            }
        }
    }
    public let createdAt = Date()
    /// Apps the janitor reaped after they exited, most recent first, at most
    /// `maximumRecentlyExited`. Without this a crashed app is indistinguishable from one that
    /// has not opened its window yet, and agents wait on a window that can never appear.
    public private(set) var recentlyExited: [ExitedAppInfo] = []
    static let maximumRecentlyExited = 8

    /// The display this session lives on. Shared with its neighbours.
    public var stage: Stage { slot.stage }
    /// The region of that display this session may use. Agent windows go here.
    public var frame: CGRect { slot.frame }
    public var hasExclusiveDisplay: Bool { slot.isExclusive }
    /// True when cleanup is terminal for new work but retained resources still need a retry.
    public var teardownPending: Bool {
        lifecycle.currentState != .active && (!apps.isEmpty || captureWork.cleanupPending)
    }

    /// The most recent AX walk, kept so `click --element N` can resolve an index the caller
    /// obtained from a previous `ax` call. The cache also binds that walk to the exact window,
    /// process identity, and session generation that produced it.
    private var axSnapshotCache = AXSnapshotCache()
    public var lastSnapshot: AXSnapshot? { axSnapshotCache.snapshot }

    /// DevTools bridges for Chromium browsers this session launched, keyed by pid.
    private var bridges: [pid_t: ChromiumBridge] = [:]
    /// Semantic renderer bridges for VS Code-family Electron apps, keyed by exact owned pid.
    private var electronEditorBridges: [pid_t: ElectronEditorBridge] = [:]

    /// Watchers that pull late-appearing windows (dialogs, prompts, extra documents) into our
    /// tile. Without these an app's second window lands on the user's screen.
    private var watchers: [pid_t: WindowWatcher] = [:]
    /// Why an owned app has no watcher, keyed by pid.
    ///
    /// Assigning a failed construction straight into `watchers` removes the key rather than
    /// inserting one, so a watcher that cannot be built used to leave *no* trace anywhere: no
    /// audit finding, no periodic sweep, no containment counters. The app looked perfect
    /// precisely because nothing was watching it. The reason lives here instead, so `audit()`
    /// can say it out loud and `runJanitorPass()` knows whose containment it has to take over.
    public private(set) var watcherCreationFailures: [pid_t: String] = [:]
    private let makeWatcher: WindowWatcherFactory
    /// Prevent teardown from overtaking async work that is still registering resources.
    private let lifecycle = SessionLifecycle()
    private let captureWork = SessionCaptureWork()
    /// Serializes the initial destroy with later cleanup retries.
    private let teardownLock = NSLock()
    private let teardownDriver: SessionAppTeardownDriver
    private let windowDriver: SessionWindowDriver
    private let capturesInputRouteDuringTeardown: Bool
    private let controllerLock = NSLock()
    private var controllerRuntime: ControllerRuntime?
    private let agentInputLock = NSLock()
    private var agentInputPaused = false
    /// A pause the human operator set outranks the agent's own lease: the agent that was
    /// paused must not be able to resume itself.
    private var agentInputPausedByOperator = false
    private var lastAgentInputAction: String?
    private var lastAgentInputAt: Date?
    private var lastAgentInputPoint: CGPoint?
    private var lastAgentInputWindowID: CGWindowID?
    private var lastAgentInputOutcome: String?
    private var lastAgentInputTarget: String?
    private var agentPauseReason: String?
    private var operatorControlSince: Date?
    private var operatorControlWindowIDs: Set<CGWindowID> = []
    private var sessionTitle: String?
    private var sessionColorTag: String?
    /// Per-session clipboard broker (SPAO-143): never the user's pasteboard.
    public let clipboard = SessionClipboard()
    /// Recent snapshots for `read_screen since:` diffs (SPAO-207).
    public let axHistory = AXSnapshotHistory()
    /// Keys pressed with `action: down` and not yet released, with the time they went down, so
    /// the watchdog can release what a crashed agent left behind.
    private var heldKeys: [String: (combo: KeyCombo, since: Date, pid: pid_t)] = [:]
    private var pendingOperatorHandoff: OperatorHandoff?
    private var recordingMode: String?
    /// Set once the session's display failed revalidation after wake or reconfiguration.
    private var displayLostAt: Date?

    /// Where lifecycle events raised off the manager actor (watcher callbacks) are published.
    /// Set by the manager at creation; nil for sessions built directly by library callers.
    private let lifecycleEventLock = NSLock()
    private var lifecycleEventSink: (@Sendable (_ kind: String, _ detail: [String: String]) -> Void)?
    /// Escapes not yet told to the controller, delivered once on its next covered response.
    private var pendingEscapes: [(windowID: CGWindowID, pid: pid_t, title: String)] = []
    static let maximumPendingEscapes = 8
    /// Accumulated across teardown attempts so a retried destroy still reports the whole story.
    private var teardownQuit: [ProcessIdentity: String] = [:]
    private var teardownForced: [ProcessIdentity: String] = [:]
    private var teardownReleased: [ProcessIdentity: String] = [:]
    private var teardownProfilesRemoved = 0
    private var teardownClipboardCleared = false

    /// What teardown actually did to this session's apps, for `DestroySummary`.
    struct TeardownOutcome: Equatable, Sendable {
        var quitApps: [String]
        var forcedApps: [String]
        var releasedApps: [String]
        var profilesRemoved: Int
        var clipboardCleared: Bool
    }

    /// Last focused-window answer per owned pid. Read by `primaryWindow` without another AX
    /// round trip; refreshed whenever a command resolves its default window or lists windows.
    private var focusObservations: [pid_t: FocusedWindowObservation] = [:]
    /// Where the agent's last click landed, so typing that omits `web` can follow it into page
    /// content instead of the browser's own UI. See `InputRouter.keystrokeRoute`.
    public private(set) var lastPointerFocus: PointerFocusMemory?

    public struct AgentInputSnapshot: Equatable, Sendable {
        public let paused: Bool
        public let lastAction: String?
        public let lastActionAt: Date?
        public var lastActionPoint: CGPoint? = nil
        public var lastActionWindowID: CGWindowID? = nil
        public var lastActionOutcome: String? = nil
        public var lastActionTarget: String? = nil
        public var pauseReason: String? = nil
        public var pausedByOperator: Bool = false
        public var operatorControlSince: Date? = nil
    }

    /// Human-facing metadata and the once-delivered operator handoff.
    public struct AnnotationSnapshot: Equatable, Sendable {
        public var title: String?
        public var colorTag: String?
        public var pendingHandoff: OperatorHandoff?
        public var recording: String?
    }

    private struct ControllerRuntime {
        var owner: DurableSessionOwner
        var lease: DurableSessionLease
        var duration: TimeInterval
        var lastActivityAt: Date
        var lastOwnerActionAt: Date
        var abandonedAt: Date?
        var policy: SessionReclamationPolicy
        var allowsLeaseOmission: Bool
        /// Per-session orphan grace; `policy.gracePeriod` unless the creator asked for more.
        var gracePeriod: TimeInterval
        /// The lease expiry `lease.expiring` was already announced for, so each unrenewed lease
        /// produces one event rather than one per janitor tick.
        var expiringAnnouncedFor: Date?
    }

    /// Whatever the user had frontmost when this session began.
    ///
    /// The fallback for handing focus back. Without it, a teardown that starts while one of our
    /// own apps happens to be frontmost has nothing to restore to, and the user is left wherever
    /// the dying app dumped them.
    private let ownerAtCreation: NSRunningApplication?

    public init(id: String, slot: DisplayPool.Slot) {
        self.id = id
        self.slot = slot
        self.teardownDriver = .live
        self.windowDriver = .live
        self.makeWatcher = liveWindowWatcherFactory
        self.capturesInputRouteDuringTeardown = true
        self.ownerAtCreation = NSWorkspace.shared.frontmostApplication
    }

    /// Test-only construction of a real session ledger around injected process behavior.
    init(
        id: String,
        slot: DisplayPool.Slot,
        teardownDriver: SessionAppTeardownDriver,
        windowDriver: SessionWindowDriver,
        watcherFactory: @escaping WindowWatcherFactory = liveWindowWatcherFactory,
        initialApps: [LaunchedApp]
    ) throws {
        self.id = id
        self.slot = slot
        self.teardownDriver = teardownDriver
        self.windowDriver = windowDriver
        self.makeWatcher = watcherFactory
        self.capturesInputRouteDuringTeardown = false
        self.ownerAtCreation = nil
        var claimed: [LaunchedApp] = []
        do {
            for app in initialApps {
                try ProcessOwnership.claim(app.identity, owner: id)
                AgentActivity.claim(pid: app.pid)
                claimed.append(app)
            }
        } catch {
            for app in claimed {
                ProcessOwnership.release(app.identity)
                AgentActivity.release(pid: app.pid)
            }
            throw error
        }
        self.apps = initialApps
    }

    /// Register capture work while ordinary lifecycle admission still fences teardown.
    func beginCaptureWork() throws -> SessionCaptureWork.Lease {
        let operation = try beginOperation()
        defer { operation.finish() }
        return captureWork.begin()
    }

    /// A manager command holds this lease until its response is fully assembled. Direct destroy
    /// calls then wait too, rather than racing the manager merely because they bypass its actor.
    func beginOperation() throws -> SessionLifecycle.Lease {
        try stage.requireAllocationReady()
        guard let lease = lifecycle.beginOperation() else {
            throw SpaceOError.unknownSession(id)
        }
        return lease
    }

    // MARK: - Controller lease

    func configureController(
        owner: DurableSessionOwner,
        daemonInstanceID: UUID,
        leaseID: UUID,
        duration: TimeInterval,
        policy: SessionReclamationPolicy,
        allowsLeaseOmission: Bool,
        gracePeriod: TimeInterval? = nil
    ) {
        let now = policy.now()
        controllerLock.withLock {
            controllerRuntime = ControllerRuntime(
                owner: owner,
                lease: DurableSessionLease(
                    daemonInstanceID: daemonInstanceID,
                    leaseID: leaseID,
                    generation: 1,
                    acquiredAt: now,
                    lastHeartbeatAt: now,
                    expiresAt: now.addingTimeInterval(duration)),
                duration: duration,
                lastActivityAt: now,
                lastOwnerActionAt: now,
                abandonedAt: nil,
                policy: policy,
                allowsLeaseOmission: allowsLeaseOmission,
                gracePeriod: gracePeriod ?? policy.gracePeriod,
                expiringAnnouncedFor: nil)
        }
    }

    /// Hand an abandoned session to a new controller (`session.claim`).
    ///
    /// Only abandonment makes a session claimable: its old lease can never renew again, so
    /// issuing a fresh one takes nothing from a live controller. A session whose controller is
    /// still alive and within its lease is refused with who holds it and how recently it acted.
    /// This is coordination between same-user clients, not a security boundary — any local
    /// client could equally destroy the session with operator scope.
    func claimController(
        owner: DurableSessionOwner,
        daemonInstanceID: UUID,
        leaseID: UUID,
        duration: TimeInterval?,
        gracePeriod: TimeInterval?
    ) throws -> SessionClaimOutcome {
        try controllerLock.withLock {
            guard var runtime = controllerRuntime else {
                throw SpaceOError.badRequest("session '\(id)' has no controller to claim")
            }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            controllerRuntime = runtime
            guard runtime.abandonedAt != nil else {
                let active = Int(max(0, now.timeIntervalSince(runtime.lastActivityAt)).rounded())
                throw SpaceOError.badRequest(
                    "session '\(id)' is owned by \(runtime.owner.label), active \(active)s ago; "
                        + "only an abandoned session (its controller exited or its lease "
                        + "expired) can be claimed")
            }
            let previous = runtime.owner
            let generation = runtime.lease.generation < UInt64.max
                ? runtime.lease.generation + 1 : runtime.lease.generation
            let leaseDuration = duration ?? runtime.duration
            let acquiredAt = max(now, runtime.lease.lastHeartbeatAt, runtime.lastActivityAt)
            runtime.owner = owner
            runtime.lease = DurableSessionLease(
                daemonInstanceID: daemonInstanceID,
                leaseID: leaseID,
                generation: generation,
                acquiredAt: acquiredAt,
                lastHeartbeatAt: acquiredAt,
                expiresAt: acquiredAt.addingTimeInterval(leaseDuration))
            runtime.duration = leaseDuration
            runtime.lastActivityAt = acquiredAt
            runtime.lastOwnerActionAt = max(acquiredAt, runtime.lastOwnerActionAt)
            runtime.abandonedAt = nil
            runtime.allowsLeaseOmission = false
            runtime.expiringAnnouncedFor = nil
            if let gracePeriod { runtime.gracePeriod = gracePeriod }
            controllerRuntime = runtime
            return SessionClaimOutcome(
                previousOwner: previous,
                snapshot: Self.snapshot(runtime, at: acquiredAt))
        }
    }

    /// Note an owner-scoped read. Unlike a heartbeat this is the controller *using* the
    /// session, so it counts against idle time; it does not renew the lease.
    func recordOwnerAction() {
        controllerLock.withLock {
            guard var runtime = controllerRuntime else { return }
            runtime.lastOwnerActionAt = max(runtime.policy.now(), runtime.lastOwnerActionAt)
            controllerRuntime = runtime
        }
    }

    /// Seconds left on a lease that has run 80% of its TTL without renewal, reported once per
    /// lease expiry. Nil when the lease is healthy, already announced, or already abandoned.
    func leaseExpiringNotice() -> (remaining: TimeInterval, ttl: TimeInterval)? {
        controllerLock.withLock {
            guard var runtime = controllerRuntime else { return nil }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            defer { controllerRuntime = runtime }
            guard runtime.abandonedAt == nil,
                  runtime.expiringAnnouncedFor != runtime.lease.expiresAt else { return nil }
            let remaining = runtime.lease.expiresAt.timeIntervalSince(now)
            guard remaining > 0, remaining <= runtime.duration * 0.2 else { return nil }
            runtime.expiringAnnouncedFor = runtime.lease.expiresAt
            return (remaining, runtime.duration)
        }
    }

    func controllerSnapshot() -> SessionControllerSnapshot? {
        controllerLock.withLock {
            guard var runtime = controllerRuntime else { return nil }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            controllerRuntime = runtime
            return Self.snapshot(runtime, at: now)
        }
    }

    /// Validate that an owner-scoped mutation may start. Explicit controllers must supply the
    /// current lease; omission remains available only to the legacy in-process API.
    func authorizeControllerMutation(leaseID: UUID?) throws {
        try controllerLock.withLock {
            guard var runtime = controllerRuntime else { return }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            controllerRuntime = runtime
            guard let abandonedAt = runtime.abandonedAt else {
                if leaseID == nil, !runtime.allowsLeaseOmission {
                    throw SpaceOError.badRequest(
                        "controller lease is required for session '\(id)'")
                }
                if let leaseID, leaseID != runtime.lease.leaseID {
                    throw SpaceOError.badRequest(
                        "controller lease does not match session '\(id)'")
                }
                return
            }
            let reclaimableAt = abandonedAt.addingTimeInterval(runtime.gracePeriod)
            let remaining = reclaimableAt.timeIntervalSince(now)
            let due = remaining > 0
                ? "automatic reclamation in \(Int(remaining.rounded(.up))) s"
                : "automatic reclamation is due"
            throw SpaceOError.badRequest(
                "session '\(id)' is abandoned and awaiting reclamation (\(due)); "
                    + "take it over with its apps via `spaceo session claim --session \(id)` "
                    + "(spaceo_session_claim), or free it now with "
                    + "`spaceo session destroy --session \(id) --operator`")
        }
    }

    /// Validate that an owner-scoped read — windows, AX outline, pixels, audit — may proceed.
    /// Same lease rule as a mutation, but an abandoned session stays readable by its last
    /// lease holder: the owner diagnosing why its session was abandoned is exactly who this
    /// read exists for, and nothing here renews or mutates controller state.
    func authorizeControllerRead(leaseID: UUID?) throws {
        try controllerLock.withLock {
            guard var runtime = controllerRuntime else { return }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            controllerRuntime = runtime
            if leaseID == nil, !runtime.allowsLeaseOmission {
                throw SpaceOError.badRequest(
                    "controller lease is required to read session '\(id)'")
            }
            if let leaseID, leaseID != runtime.lease.leaseID {
                throw SpaceOError.badRequest(
                    "controller lease does not match session '\(id)'")
            }
        }
    }

    /// Whether `leaseID` identifies this session's current controller. Legacy in-process
    /// sessions without an explicit controller are covered by every caller.
    func controllerLeaseCovers(_ leaseID: UUID?) -> Bool {
        controllerLock.withLock {
            guard let runtime = controllerRuntime else { return true }
            if runtime.allowsLeaseOmission { return true }
            return leaseID == runtime.lease.leaseID
        }
    }

    /// Renew only after an owner-scoped mutation has completed successfully.
    func recordSuccessfulControllerMutation(leaseID: UUID?) throws {
        try controllerLock.withLock {
            guard var runtime = controllerRuntime else { return }
            let now = runtime.policy.now()
            // Authorization happened before the mutation under SessionManager's global gate.
            // Crossing the wall-clock expiry while that authorized mutation is in flight must
            // not turn a completed effect into a reported failure or abandon it retroactively.
            guard runtime.abandonedAt == nil else {
                throw SpaceOError.badRequest(
                    "session '\(id)' became abandoned before its lease could renew")
            }
            if leaseID == nil, !runtime.allowsLeaseOmission {
                throw SpaceOError.badRequest(
                    "controller lease is required for session '\(id)'")
            }
            if let leaseID, leaseID != runtime.lease.leaseID {
                throw SpaceOError.badRequest(
                    "controller lease does not match session '\(id)'")
            }
            let heartbeatAt = max(
                now,
                runtime.lastActivityAt,
                runtime.lease.acquiredAt,
                runtime.lease.lastHeartbeatAt)
            runtime.lastActivityAt = heartbeatAt
            runtime.lastOwnerActionAt = max(heartbeatAt, runtime.lastOwnerActionAt)
            runtime.lease.lastHeartbeatAt = heartbeatAt
            runtime.lease.expiresAt =
                heartbeatAt.addingTimeInterval(runtime.duration)
            controllerRuntime = runtime
        }
    }

    @discardableResult
    func heartbeatController(leaseID: UUID) throws -> SessionControllerSnapshot {
        try controllerLock.withLock {
            guard var runtime = controllerRuntime else {
                throw SpaceOError.badRequest(
                    "session '\(id)' has no controller lease")
            }
            let now = runtime.policy.now()
            Self.refreshControllerState(&runtime, at: now)
            guard runtime.abandonedAt == nil else {
                controllerRuntime = runtime
                throw SpaceOError.badRequest(
                    "session '\(id)' is abandoned and cannot renew its old lease")
            }
            guard leaseID == runtime.lease.leaseID else {
                throw SpaceOError.badRequest(
                    "controller lease does not match session '\(id)'")
            }
            let heartbeatAt = max(
                now,
                runtime.lastActivityAt,
                runtime.lease.acquiredAt,
                runtime.lease.lastHeartbeatAt)
            runtime.lastActivityAt = heartbeatAt
            runtime.lease.lastHeartbeatAt = heartbeatAt
            runtime.lease.expiresAt =
                heartbeatAt.addingTimeInterval(runtime.duration)
            controllerRuntime = runtime
            return Self.snapshot(runtime, at: max(now, heartbeatAt))
        }
    }

    private static func refreshControllerState(
        _ runtime: inout ControllerRuntime,
        at now: Date
    ) {
        guard runtime.abandonedAt == nil else { return }
        if now >= runtime.lease.expiresAt {
            // Expiry is known exactly, so the grace interval starts there rather than at the
            // next periodic janitor observation.
            runtime.abandonedAt = runtime.lease.expiresAt
        } else if !runtime.policy.ownerIsAlive(runtime.owner) {
            // Process death has no timestamp in the kernel API used here. The first exact-
            // identity observation is the earliest honest abandonment time.
            runtime.abandonedAt = max(
                now,
                runtime.lastActivityAt,
                runtime.lease.acquiredAt)
        }
    }

    private static func snapshot(
        _ runtime: ControllerRuntime,
        at now: Date
    ) -> SessionControllerSnapshot {
        let abandoned = runtime.abandonedAt != nil
        let reclaimableAt = runtime.abandonedAt.map {
            $0.addingTimeInterval(runtime.gracePeriod)
        }
        let reclaimable = reclaimableAt.map { now >= $0 } ?? false
        return SessionControllerSnapshot(
            owner: runtime.owner,
            lease: runtime.lease,
            lastActivityAt: runtime.lastActivityAt,
            lastOwnerActionAt: runtime.lastOwnerActionAt,
            abandonedAt: runtime.abandonedAt,
            ageSeconds: max(0, now.timeIntervalSince(runtime.lease.acquiredAt)),
            idleSeconds: max(0, now.timeIntervalSince(runtime.lastOwnerActionAt)),
            abandoned: abandoned,
            reclaimable: reclaimable,
            gracePeriod: runtime.gracePeriod,
            reclaimableAt: reclaimableAt,
            graceRemainingSeconds: reclaimableAt.map { max(0, $0.timeIntervalSince(now)) })
    }

    // MARK: - Apps

    /// Set when a launched app grabbed focus and we had to hand it back to the user.
    public private(set) var lastLaunchRestoredFocus: String?

    @discardableResult
    public nonisolated(nonsending) func launch(
        app appURL: URL,
        opening files: [URL] = [],
        timeout: Double = 15,
        allowNoWindows: Bool = false,
        arguments: [String] = [],
        muteAudio: Bool = false,
        onMaterialized: (LaunchedApp) async throws -> Void = { _ in }
    ) async throws -> LaunchedApp {
        let lifecycleLease = try beginOperation()
        defer { lifecycleLease.finish() }

        // Application self-activation is reported by the manager. Restoring a saved app here
        // can override a newer user choice and hide evidence of the original breach.
        lastLaunchRestoredFocus = nil

        let (app, placed) = try await AppLauncher.launch(
            appURL: appURL,
            opening: files,
            into: frame,
            timeout: timeout,
            allowNoWindows: allowNoWindows,
            arguments: arguments,
            muteAudio: muteAudio,
            onMaterialized: { materialized in
                do {
                    try self.registerMaterializedApp(materialized)
                } catch {
                    // We started this process, so a claim conflict means another live session
                    // already accounts for the exact identity. Ask it to exit rather than leave
                    // a newly spawned, unowned invisible process behind.
                    AppLauncher.quit(materialized, force: true)
                    AppLauncher.cleanupTemporaryProfileEventually(for: materialized)
                    throw error
                }
                try await onMaterialized(materialized)
            })

        register(app: app, windows: placed)
        if let port = app.devToolsPort {
            let bridge = ChromiumBridge(port: port)
            // Retain the bridge even when initial binding is ambiguous or startup is late. A
            // browser with multiple tabs must expose those targets so the caller can select one;
            // dropping the bridge here made every later web action silently fall back to an
            // ineffective native route.
            bridges[app.pid] = bridge
            if await bridge.waitUntilReady() {
                _ = try? await bridge.attachToLaunchedTarget()
            }
        }
        if let endpoint = app.electronControl {
            let bridge = ElectronEditorBridge(endpoint: endpoint)
            // Retain the bridge even if startup misses this readiness window. Falling back to a
            // synthetic wheel would reintroduce false-success behavior for a renderer we know
            // needs the semantic channel; a later action can either connect after startup or
            // fail closed with the socket error.
            let ready = await bridge.waitUntilReady()
            if !files.isEmpty {
                guard ready else {
                    throw SpaceOError.unsupportedTarget(
                        "the Electron controller did not become ready to open the requested "
                            + "document")
                }
                for file in files {
                    try await bridge.openDocument(file)
                }
                // `showTextDocument` can replace an agent/home surface with an editor window.
                // Refresh after it settles so the window ids exposed to the caller describe the
                // document UI the request created, not a transient launch surface.
                try? await Task.sleep(nanoseconds: 150_000_000)
                refreshWindows()
            }
            electronEditorBridges[app.pid] = bridge
        }
        return app
    }

    /// Claim and register the exact process at the durable materialization boundary, before
    /// launch waits or placement. Internal for deterministic crash-boundary tests.
    func registerMaterializedApp(_ app: LaunchedApp) throws {
        try ProcessOwnership.claim(app.identity, owner: id)
        removeStaleRegistrationSharingPID(with: app)
        invalidateAXSnapshot()
        if let index = apps.firstIndex(where: { $0.identity == app.identity }) {
            apps[index] = app
        } else {
            apps.append(app)
        }
        // Keep this boundary deliberately minimal. Stage Space discovery, watcher creation, and
        // AX/window enumeration can block; the daemon must persist the exact process first.
        AgentActivity.claim(pid: app.pid)
    }

    // MARK: - Human/agent input arbitration

    /// Pause or resume agent input. `byOperator` marks the human operator's authority (the
    /// Viewer, or `--operator`); a controller acting on its own lease cannot clear a pause the
    /// operator set, because that pause exists to take priority over exactly that controller.
    public func setAgentInputPaused(_ paused: Bool, byOperator: Bool = true) throws {
        try setAgentInputPaused(paused, byOperator: byOperator, reason: nil, handoffNote: nil)
    }

    /// Pause or resume with the coordination detail the Viewer and agents exchange: an agent's
    /// `reason` for stopping, or the operator's `handoffNote` on release. The handoff is stored
    /// once and delivered to the agent's next command exactly once.
    public func setAgentInputPaused(
        _ paused: Bool,
        byOperator: Bool,
        reason: String?,
        handoffNote: String?,
        now: Date = Date()
    ) throws {
        try agentInputLock.withLock {
            if paused {
                agentInputPaused = true
                agentInputPausedByOperator = agentInputPausedByOperator || byOperator
                if byOperator {
                    if operatorControlSince == nil {
                        operatorControlSince = now
                        operatorControlWindowIDs = Set(windows.map(\.windowID))
                    }
                } else if let reason {
                    agentPauseReason = String(reason.prefix(Self.maximumPauseReasonCharacters))
                }
                return
            }
            guard byOperator || !agentInputPausedByOperator else {
                throw SpaceOError.sessionPaused(
                    "session '\(id)' was paused by the human operator; only the operator "
                        + "(the Viewer, or `session resume --operator`) can resume it")
            }
            if byOperator, let since = operatorControlSince {
                let current = Set(windows.map(\.windowID))
                pendingOperatorHandoff = OperatorHandoff(
                    note: handoffNote.map { String($0.prefix(Self.maximumHandoffNoteCharacters)) },
                    controlDurationSeconds: max(0, now.timeIntervalSince(since)),
                    windowsChanged: current != operatorControlWindowIDs,
                    releasedAt: now)
            } else if byOperator, let handoffNote, !handoffNote.isEmpty {
                pendingOperatorHandoff = OperatorHandoff(
                    note: String(handoffNote.prefix(Self.maximumHandoffNoteCharacters)),
                    controlDurationSeconds: 0,
                    windowsChanged: false,
                    releasedAt: now)
            }
            operatorControlSince = nil
            operatorControlWindowIDs = []
            agentPauseReason = nil
            agentInputPaused = false
            agentInputPausedByOperator = false
        }
    }

    public func requireAgentInputAllowed(action: String) throws {
        let (paused, byOperator, reason) = agentInputLock.withLock {
            (agentInputPaused, agentInputPausedByOperator, agentPauseReason)
        }
        guard !paused else {
            if byOperator {
                throw SpaceOError.sessionPaused(
                    "session '\(id)' is paused by the human operator; wait for Resume before "
                        + "attempting \(action) again")
            }
            throw SpaceOError.sessionPaused(
                "session '\(id)' is paused by its controller"
                    + (reason.map { " (\($0))" } ?? "")
                    + "; call spaceo_session_resume before attempting \(action) again")
        }
    }

    public func recordAgentInputAction(_ action: String, at date: Date = Date()) {
        recordAgentInputAction(action, at: date, point: nil, windowID: nil, outcome: nil, target: nil)
    }

    /// Full-detail record for the Viewer's canvas overlay and the event stream. `outcome` uses
    /// the receipt vocabulary: confirmed, unconfirmed, refused.
    public func recordAgentInputAction(
        _ action: String,
        at date: Date = Date(),
        point: CGPoint?,
        windowID: CGWindowID?,
        outcome: String?,
        target: String?
    ) {
        agentInputLock.withLock {
            lastAgentInputAction = action
            lastAgentInputAt = date
            lastAgentInputPoint = point
            lastAgentInputWindowID = windowID
            lastAgentInputOutcome = outcome
            lastAgentInputTarget = target
        }
    }

    public func agentInputSnapshot() -> AgentInputSnapshot {
        agentInputLock.withLock {
            AgentInputSnapshot(
                paused: agentInputPaused,
                lastAction: lastAgentInputAction,
                lastActionAt: lastAgentInputAt,
                lastActionPoint: lastAgentInputPoint,
                lastActionWindowID: lastAgentInputWindowID,
                lastActionOutcome: lastAgentInputOutcome,
                lastActionTarget: lastAgentInputTarget,
                pauseReason: agentPauseReason,
                pausedByOperator: agentInputPausedByOperator,
                operatorControlSince: operatorControlSince)
        }
    }

    // MARK: - Human-facing annotation and handoff

    public func annotationSnapshot() -> AnnotationSnapshot {
        agentInputLock.withLock {
            AnnotationSnapshot(
                title: sessionTitle,
                colorTag: sessionColorTag,
                pendingHandoff: pendingOperatorHandoff,
                recording: recordingMode)
        }
    }

    public static let colorTags: Set<String> = ["red", "orange", "yellow", "green", "blue", "purple", "gray"]
    public static let maximumTitleCharacters = 120
    /// The agent's reason for pausing, shown to the operator.
    public static let maximumPauseReasonCharacters = 240
    /// The operator's note handed back to the agent on resume.
    public static let maximumHandoffNoteCharacters = 480

    /// Rename or colour-tag the session. Empty strings clear the field; nil leaves it alone.
    public func annotate(title: String?, colorTag: String?) throws {
        if let title {
            guard title.count <= Self.maximumTitleCharacters, title.utf8.count <= Self.maximumTitleCharacters * 4,
                  title.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
                throw SpaceOError.badRequest("title must be at most \(Self.maximumTitleCharacters) control-free characters")
            }
        }
        if let colorTag, !colorTag.isEmpty, colorTag != "none", !Self.colorTags.contains(colorTag) {
            throw SpaceOError.badRequest(
                "colorTag must be one of " + Self.colorTags.sorted().joined(separator: ", "))
        }
        agentInputLock.withLock {
            if let title { sessionTitle = title.isEmpty ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let colorTag { sessionColorTag = (colorTag.isEmpty || colorTag == "none") ? nil : colorTag }
        }
    }

    public func setRecordingMode(_ mode: String?) {
        agentInputLock.withLock { recordingMode = mode }
    }

    // MARK: - Held keys (SPAO-140 down/up)

    public static let heldKeyWatchdogSeconds: TimeInterval = 10

    public func noteKeyDown(_ combo: KeyCombo, name: String, pid: pid_t, at date: Date = Date()) {
        agentInputLock.withLock { heldKeys[name] = (combo, date, pid) }
    }

    public func noteKeyUp(name: String) {
        agentInputLock.withLock { _ = heldKeys.removeValue(forKey: name) }
    }

    public var heldKeyNames: [String] {
        agentInputLock.withLock { heldKeys.keys.sorted() }
    }

    /// Release keys held longer than the watchdog allows, returning their names. Called from
    /// every key command and from the janitor, and unconditionally (`force`) on teardown.
    @discardableResult
    public func releaseStaleHeldKeys(now: Date = Date(), force: Bool = false) -> [String] {
        let stale: [(String, KeyCombo, pid_t)] = agentInputLock.withLock {
            heldKeys.compactMap { name, entry in
                force || now.timeIntervalSince(entry.since) >= Self.heldKeyWatchdogSeconds
                    ? (name, entry.combo, entry.pid) : nil
            }
        }
        var released: [String] = []
        for (name, combo, pid) in stale {
            if (try? InputRouter.keyEvent(combo, down: false, to: pid)) != nil || force {
                released.append(name)
            }
            agentInputLock.withLock { _ = heldKeys.removeValue(forKey: name) }
        }
        return released.sorted()
    }

    /// Take the pending handoff, clearing it so it is delivered exactly once.
    public func consumeOperatorHandoff() -> OperatorHandoff? {
        agentInputLock.withLock {
            defer { pendingOperatorHandoff = nil }
            return pendingOperatorHandoff
        }
    }

    // MARK: - Lifecycle events and ambient notes

    /// Route off-actor lifecycle events (watcher escapes and re-parks) to the daemon's bus.
    func setLifecycleEventSink(
        _ sink: (@Sendable (_ kind: String, _ detail: [String: String]) -> Void)?
    ) {
        lifecycleEventLock.withLock { lifecycleEventSink = sink }
    }

    /// Called from a watcher sweep, on whatever thread that sweep runs. Touches nothing but
    /// lock-guarded state, and publishes outside the lock.
    func noteContainment(_ event: WindowWatcher.ContainmentEvent) {
        let kind: String
        let window: WindowRef
        switch event {
        case .escaped(let escaped):
            kind = "window.escaped"
            window = escaped
        case .reparked(let reparked):
            kind = "window.reparked"
            window = reparked
        }
        let sink: (@Sendable (String, [String: String]) -> Void)? = lifecycleEventLock.withLock {
            if case .escaped = event,
               !pendingEscapes.contains(where: { $0.windowID == window.windowID }) {
                if pendingEscapes.count >= Self.maximumPendingEscapes {
                    pendingEscapes.removeFirst()
                }
                pendingEscapes.append((window.windowID, window.pid, window.title))
            }
            return lifecycleEventSink
        }
        var detail = ["window": String(window.windowID), "pid": String(window.pid)]
        if !window.title.isEmpty { detail["title"] = window.title }
        sink?(kind, detail)
    }

    /// One-shot notes for the controller's next covered response: windows that escaped the tile
    /// and refused placement since it last heard. Titles come from the session's window list,
    /// because the watcher's own discovery skips titles to stay cheap.
    func consumeAmbientNotes() -> [String] {
        let escapes: [(windowID: CGWindowID, pid: pid_t, title: String)] = lifecycleEventLock.withLock {
            defer { pendingEscapes.removeAll() }
            return pendingEscapes
        }
        return escapes.map { escape in
            let known = windows.first { $0.windowID == escape.windowID }?.title ?? ""
            let title = known.isEmpty ? escape.title : known
            let name = title.isEmpty ? "window \(escape.windowID)" : "window '\(title.prefix(80))'"
            // Renderers prefix `note:`; the CLI already prints every ambient line that way.
            return "\(name) escaped your tile and refused placement"
        }
    }

    /// Mark the session's display as gone and pause agent input. Returns true only the first
    /// time, so the caller announces it once.
    @discardableResult
    func markDisplayLost(at date: Date = Date()) -> Bool {
        let first = agentInputLock.withLock { () -> Bool in
            guard displayLostAt == nil else { return false }
            displayLostAt = date
            return true
        }
        guard first else { return false }
        try? setAgentInputPaused(true, byOperator: false,
                                 reason: "display lost after wake/reconfiguration",
                                 handoffNote: nil, now: date)
        return true
    }

    public var isDisplayLost: Bool { agentInputLock.withLock { displayLostAt != nil } }

    // MARK: - Web content
    //
    // Chromium web content cannot be driven with synthetic input at all — see ChromiumBridge.
    // These route through DevTools instead, and are only available for browsers we launched.

    public func webBridge(for pid: pid_t? = nil) -> ChromiumBridge? {
        if let pid { return bridges[pid] }
        if let only = bridges.first, bridges.count == 1 { return only.value }
        if let primary = primaryWindow { return bridges[primary.pid] }
        return nil
    }

    public var hasWebBridge: Bool { !bridges.isEmpty }

    /// Return an Electron editor bridge only when the target process has one represented window.
    ///
    /// VS Code runs one extension host per window. The private adapter deliberately binds one
    /// socket, so routing a multi-window process by pid could scroll a different document. Fail
    /// closed until a window-specific registration protocol exists.
    public func electronEditorBridge(for window: WindowRef) -> ElectronEditorBridge? {
        guard windows.filter({ $0.pid == window.pid }).count == 1 else { return nil }
        return electronEditorBridges[window.pid]
    }

    /// Adopt a process the user points us at.
    ///
    /// Ownership is claimed before the first window moves, so a PID already spoken for by
    /// another session is refused without this session having disturbed anything.
    @discardableResult
    public func adopt(pid: pid_t, allowNoWindows: Bool = false) throws -> LaunchedApp {
        try WindowPlacement.requireAccessibility()
        let app = try AppLauncher.describe(pid: pid)
        guard !apps.contains(where: { $0.identity == app.identity }) else {
            throw SpaceOError.badRequest(
                "session '\(id)' already owns pid \(pid)")
        }
        try ProcessOwnership.claim(app.identity, owner: id)
        do {
            let placed: [WindowRef]
            if allowNoWindows, try !WindowPlacement.hasWindows(of: pid) { placed = [] }
            else { placed = try AppLauncher.place(app, into: frame) }
            register(app: app, windows: placed)
            return app
        } catch {
            ProcessOwnership.release(app.identity)
            throw error
        }
    }

    /// Internal rather than private so a test can drive the real registration path — including
    /// watcher installation — without launching an app.
    func register(app: LaunchedApp, windows placed: [WindowRef]) {
        invalidateAXSnapshot()
        removeStaleRegistrationSharingPID(with: app)
        if let index = apps.firstIndex(where: { $0.identity == app.identity }) {
            apps[index] = app
        } else {
            apps.append(app)
        }
        // Registering what belongs to the agent is what lets IsolationSnapshot tell a breach
        // ("an agent app grabbed focus") from the user simply switching windows.
        AgentActivity.claim(pid: app.pid)
        AgentActivity.claim(spaces: stage.spaces)
        for window in placed where !windows.contains(where: { $0.windowID == window.windowID }) {
            windows.append(window)
        }
        if watchers[app.pid] == nil { installWatcher(pid: app.pid) }
        refreshWindows()
    }

    /// Build the watcher for an owned pid, recording *why* when it cannot be built.
    ///
    /// The recording is the whole point. A watcher is both of the containment mechanisms
    /// ARCHITECTURE.md §3.2 promises — the AX notification and the periodic sweep behind it — so
    /// its absence has to be visible somewhere outside itself or nothing is left to notice.
    private func installWatcher(pid: pid_t) {
        do {
            let watcher = try makeWatcher(pid, { [weak self] in self?.frame ?? .zero })
            watcher.setContainmentHandler { [weak self] event in
                self?.noteContainment(event)
            }
            watchers[pid] = watcher
            watcherCreationFailures.removeValue(forKey: pid)
        } catch {
            watchers.removeValue(forKey: pid)?.stop()
            watcherCreationFailures[pid] = "\(error)"
        }
    }

    /// Replace dead/recycled bookkeeping before a newly materialized exact identity reuses its
    /// PID. A PID-only duplicate check would silently retain and persist the old process instead.
    private func removeStaleRegistrationSharingPID(with app: LaunchedApp) {
        let stale = apps.filter {
            $0.pid == app.pid && $0.identity != app.identity
        }
        guard !stale.isEmpty else { return }

        watchers.removeValue(forKey: app.pid)?.stop()
        watcherCreationFailures.removeValue(forKey: app.pid)
        if let bridge = bridges.removeValue(forKey: app.pid) {
            Task { await bridge.detach() }
        }
        electronEditorBridges.removeValue(forKey: app.pid)
        for old in stale {
            ProcessOwnership.release(old.identity)
            AppLauncher.cleanupTemporaryProfileEventually(for: old)
        }
        apps.removeAll {
            $0.pid == app.pid && $0.identity != app.identity
        }
        windows.removeAll { $0.pid == app.pid }
        AgentActivity.release(pid: app.pid)
    }

    private func unregister(pid: pid_t) {
        watchers.removeValue(forKey: pid)?.stop()
        watcherCreationFailures.removeValue(forKey: pid)
        if let bridge = bridges.removeValue(forKey: pid) {
            Task { await bridge.detach() }
        }
        electronEditorBridges.removeValue(forKey: pid)
        for app in apps where app.pid == pid { ProcessOwnership.release(app.identity) }
        apps.removeAll { $0.pid == pid }
        windows.removeAll { $0.pid == pid }
        AgentActivity.release(pid: pid)
        invalidateAXSnapshot()
    }

    /// Undo a resource registration whose first durable post-effect save failed.
    ///
    /// Launched apps are terminated by exact identity; adopted apps are evacuated and released
    /// without termination. A false result keeps the app in this session's in-memory ledger so a
    /// later persistence or teardown retry still owns it.
    func rollbackUndurableApp(_ app: LaunchedApp) -> Bool {
        guard apps.contains(where: { $0.identity == app.identity }) else { return true }
        if let watcher = watchers[app.pid] {
            return watcher.withQuiescentSuspension { rollbackUndurableAppResources(app) }
        }
        return rollbackUndurableAppResources(app)
    }

    private func rollbackUndurableAppResources(_ app: LaunchedApp) -> Bool {
        if app.startedByUs {
            if teardownDriver.isAlive(app.identity) {
                teardownDriver.quit(app, false)
            }
            var pending = teardownDriver.waitForExit([app], 2)
            if !pending.isEmpty {
                pending.forEach { teardownDriver.quit($0, true) }
                pending = teardownDriver.waitForExit(pending, 1)
            }
            guard !teardownDriver.isAlive(app.identity), pending.isEmpty else {
                return false
            }
            teardownDriver.cleanupTemporaryProfile(app)
            unregister(pid: app.pid)
            return true
        }

        let hadWindows: Bool
        do {
            hadWindows = try withMovementDiscovery(forPIDs: [app.pid]) { movements in
                let adoptedWindows = windows.filter { $0.pid == app.pid }
                guard !adoptedWindows.isEmpty else { return false }
                guard let userDisplay = windowDriver.userDisplayBounds(),
                      (try? WindowPlacement.validate(frame: userDisplay)) != nil,
                      let movement = movements[app.pid] else {
                    throw AXWindowDiscovery.incomplete("rollback movement is unavailable")
                }
                for (index, window) in adoptedWindows.enumerated() {
                    guard app.identity.isAlive,
                          windowDriver.liveOwnerPID(window.windowID) == app.pid else {
                        throw AXWindowDiscovery.incomplete("rollback window owner changed")
                    }
                    let target = WindowPlacement.cascadeFrame(in: userDisplay, index: index)
                    try? movement.move(window, target)
                }
                return true
            }
        } catch { return false }
        if hadWindows {
            // A returned move is only an attempt. Rediscover after all moves so a new dialog,
            // earlier refusal, or resize back onto the display prevents ownership release.
            guard (try? refreshWindowsChecked()) != nil else { return false }
            for window in windows where window.pid == app.pid {
                guard case .evacuated = evacuationState(of: window) else { return false }
            }
        }
        unregister(pid: app.pid)
        return true
    }

    private enum EvacuationState {
        case evacuated
        case stranded(CGRect)
        case unknown
    }

    /// Share the same live proof across rollback and full teardown. Missing bounds are not
    /// closure while the server still identifies an owner; invalid geometry is also unknown.
    private func evacuationState(of window: WindowRef) -> EvacuationState {
        guard let bounds = windowDriver.liveBounds(window.windowID) else {
            return windowDriver.liveOwnerPID(window.windowID) == nil ? .evacuated : .unknown
        }
        guard (try? WindowPlacement.validate(frame: bounds)) != nil else { return .unknown }
        return bounds.intersects(stage.bounds) ? .stranded(bounds) : .evacuated
    }

    /// Drop apps whose process has exited, releasing their PID, ownership claim, and watcher.
    ///
    /// Without this the session holds a claim on a dead process indefinitely, and the janitor
    /// keeps observing an app that will never emit another notification. Returns how many it
    /// reaped, so a caller can report the sweep honestly.
    @discardableResult
    public func reapExitedApps() -> Int {
        let dead = apps.filter { !$0.identity.isAlive }
        let now = Date()
        for app in dead {
            recordExit(of: app, at: now)
            unregister(pid: app.pid)
            AppLauncher.cleanupTemporaryProfileEventually(for: app)
        }
        return dead.count
    }

    /// Exit status stays nil: SpaceO launches through LaunchServices, so it is never the parent
    /// and no public API reports another process's status after it is gone.
    private func recordExit(of app: LaunchedApp, at time: Date) {
        recentlyExited.removeAll { $0.pid == app.pid }
        recentlyExited.insert(
            ExitedAppInfo(name: app.name, pid: app.pid, exitedAt: time, startedByUs: app.startedByUs),
            at: 0)
        if recentlyExited.count > Self.maximumRecentlyExited {
            recentlyExited.removeLast(recentlyExited.count - Self.maximumRecentlyExited)
        }
    }

    /// Exited apps, most recent first: dead apps the janitor has not reaped yet (observed now),
    /// then the reaped history.
    func exitedApps(now: Date = Date()) -> [ExitedAppInfo] {
        let unreaped = apps.filter { !$0.identity.isAlive }.map {
            ExitedAppInfo(name: $0.name, pid: $0.pid, exitedAt: now, startedByUs: $0.startedByUs)
        }
        return Array((unreaped + recentlyExited).prefix(Self.maximumRecentlyExited))
    }

    /// Why no window can be resolved, told truthfully: an app that is still starting is worth
    /// waiting for, a crashed one or an empty session is not.
    func missingWindowError() -> SpaceOError {
        if apps.contains(where: { $0.identity.isAlive }) {
            return .windowNotFound("session '\(id)' has no windows yet")
        }
        if let latest = exitedApps().first {
            return .applicationExited(Self.exitSentence(latest, session: id))
        }
        return .noApplication(
            "no app is attached to session '\(id)'; open one with spaceo_open_app / spaceo run")
    }

    static func exitSentence(_ app: ExitedAppInfo, session: String) -> String {
        let status = app.status.map { " (\($0))" } ?? ""
        return "\(app.name) (pid \(app.pid)) exited\(status) at \(app.exitedAt.ISO8601Format()); "
            + "session '\(session)' has no running app, so no window will appear. "
            + "Open the app again to continue"
    }

    public var containment: (placed: Int, refused: Int) {
        watchers.values.reduce(into: (0, 0)) { total, watcher in
            total.0 += watcher.placedCount
            total.1 += watcher.refusedCount
        }
    }

    /// Notifications the AX observers refused to register, per app. Containment for these apps
    /// depends on the periodic sweep alone, so the audit reports it rather than letting a
    /// half-deaf watcher look healthy.
    public var watcherRegistrationFailures: [String] {
        watchers.compactMap { pid, watcher in
            guard !watcher.registrationFailures.isEmpty else { return nil }
            let name = apps.first { $0.pid == pid }?.name ?? "pid \(pid)"
            return "\(name): \(watcher.registrationFailures.joined(separator: ", "))"
        }
    }

    /// A bounded discovery/sweep failure is unknown containment, not evidence of no windows.
    public var watcherSweepFailures: [String] {
        watchers.keys.sorted().compactMap { pid in
            guard let failure = watchers[pid]?.sweepFailure else { return nil }
            let name = apps.first { $0.pid == pid }?.name ?? "pid \(pid)"
            return "\(name): \(failure)"
        }
    }

    /// Owned apps with no watcher at all, and why, sorted by pid so the audit reads the same
    /// way twice.
    ///
    /// Derived from `apps` against `watchers` rather than from `watcherCreationFailures` alone:
    /// *any* path that leaves an owned app unwatched has to surface here, not only the one that
    /// remembered to file a reason. An entry means both containment mechanisms are missing for
    /// that app, which is strictly worse than the partial registration
    /// `watcherRegistrationFailures` reports.
    public var unwatchedApps: [String] {
        apps.filter { watchers[$0.pid] == nil }
            .sorted { $0.pid < $1.pid }
            .map { app in
                let why = watcherCreationFailures[app.pid] ?? "no window observer was installed"
                return "\(app.name) (pid \(app.pid)): \(why)"
            }
    }

    /// Run every watcher now. Cheap, and useful as a belt-and-braces sweep before a screenshot.
    public func sweepStrayWindows() {
        for watcher in watchers.values { watcher.sweep() }
    }

    /// Try again for owned apps whose watcher is missing.
    ///
    /// The realistic causes of a failed `AXObserverCreate` — Accessibility toggled off, or a pid
    /// adopted before its process was AX-registered — both clear up on their own, so a session
    /// that gave up once would stay degraded for its whole life over a transient refusal. One AX
    /// call per unwatched app per pass, and a live watcher is strictly better than the janitor
    /// fallback that covers for it.
    private func reinstallMissingWatchers() {
        for app in apps where watchers[app.pid] == nil && app.identity.isAlive {
            installWatcher(pid: app.pid)
        }
    }

    /// Containment of last resort for apps with no watcher. Returns how many windows it moved.
    ///
    /// An unwatched app has neither the AX notification nor the watcher's own periodic sweep, so
    /// `sweepStrayWindows()` is a no-op for it — the loop iterates the very dictionary the app is
    /// missing from. The janitor does that work directly instead, rather than reporting a clean
    /// pass while a dialog sits on the user's screen.
    @discardableResult
    public func reparkUnwatchedWindows() -> Int {
        let unwatched = Set(apps.map(\.pid).filter { watchers[$0] == nil })
        guard !unwatched.isEmpty else { return 0 }
        return reparkEscapedWindows(ofPIDs: unwatched)
    }

    /// One janitor pass: reap exited apps, then contain whatever is left.
    ///
    /// Reaping first matters — sweeping an app that has already exited is a pointless
    /// WindowServer round trip, and its watcher would otherwise live until the session is
    /// destroyed. Returns how many apps were reaped.
    ///
    /// The last two steps exist because the first is not enough on its own: `sweepStrayWindows()`
    /// can only reach apps that *have* a watcher, so an app whose watcher failed to build would
    /// otherwise be swept by nothing at all.
    @discardableResult
    public func runJanitorPass() -> Int {
        let reaped = reapExitedApps()
        reinstallMissingWatchers()
        sweepStrayWindows()
        reparkUnwatchedWindows()
        return reaped
    }

    // MARK: - Windows

    /// Latest incomplete refresh, bounded for diagnostics. A failed refresh preserves known windows.
    public private(set) var windowRefreshFailure: String?

    /// Compatibility read for library callers: incomplete discovery preserves the last known list.
    /// Inspect `windowRefreshFailure`; commands and mutations use the throwing refresh below.
    @discardableResult
    public func refreshWindows() -> [WindowRef] {
        (try? refreshWindowsChecked()) ?? windows
    }

    @discardableResult
    func refreshWindowsChecked(remaining: TimeInterval? = nil) throws -> [WindowRef] {
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: remaining),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        _ = try refreshWindows(budget: budget, collectObserved: false)
        return windows
    }

    /// Transactional discovery for waits: a failed/partial enumeration cannot erase known
    /// windows or lend stale titles/indices to an observation. All apps share one budget.
    @discardableResult
    func refreshWindows(forWait budget: AXTraversalBudget) throws -> [WindowRef] {
        try refreshWindows(budget: budget, collectObserved: true)
    }

    private func refreshWindows(budget: AXTraversalBudget, collectObserved: Bool,
                                discoverApp: ((LaunchedApp, AXTraversalBudget) throws -> [WindowRef])? = nil
    ) throws -> [WindowRef] {
        do {
            let observed = try discoverWindows(budget: budget, collectObserved: collectObserved,
                                               discoverApp: discoverApp)
            windowRefreshFailure = nil
            return observed
        } catch {
            windowRefreshFailure = BoundedDiagnosticText.prefix(error.localizedDescription, maximumBytes: 512)
            throw error
        }
    }

    /// Discovery and movement finish in this scope; native handles are released before any
    /// post-move refresh, process wait, or subsequent session operation.
    private func withMovementDiscovery<T>(forPIDs pids: Set<pid_t>?,
        _ operation: ([pid_t: SessionWindowMovement]) throws -> T
    ) throws -> T {
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        var movements: [pid_t: SessionWindowMovement] = [:]
        _ = try refreshWindows(budget: budget, collectObserved: false, discoverApp: { app, budget in
            guard pids?.contains(app.pid) ?? true else {
                return try self.windowDriver.checkedWindows(app.pid, budget, true)
            }
            let movement = try self.windowDriver.movement(app.identity, budget)
            try budget.consumeAllocation(MemoryLayout<pid_t>.stride + 64)
            movements[app.pid] = movement
            return movement.windows
        })
        return try operation(movements)
    }

    private func discoverWindows(budget: AXTraversalBudget, collectObserved: Bool,
                                 discoverApp: ((LaunchedApp, AXTraversalBudget) throws -> [WindowRef])?
    ) throws -> [WindowRef] {
        var live: [WindowRef] = []
        var observed: [WindowRef] = []
        for app in apps {
            try budget.check()
            guard app.identity.isAlive else { continue }
            let enumerated = try discoverApp?(app, budget)
                ?? windowDriver.checkedWindows(app.pid, budget, true)
            guard app.identity.isAlive else {
                throw SpaceOError.windowNotFound("the process changed during window discovery")
            }
            if collectObserved { observed.append(contentsOf: enumerated) }
            live.append(contentsOf: enumerated)
            let ids = Set(enumerated.lazy.map(\.windowID))
            for window in windows where window.pid == app.pid && !ids.contains(window.windowID) {
                try budget.check()
                let owner = windowDriver.liveOwnerPID(window.windowID)
                if let owner, owner != app.pid { continue } // Proven recycled identity.
                try budget.check()
                guard let bounds = windowDriver.liveBounds(window.windowID) else {
                    guard owner == nil else {
                        throw AXWindowDiscovery.incomplete("known window geometry is unavailable")
                    }
                    continue // Both owner and bounds have disappeared.
                }
                guard owner == app.pid else {
                    throw AXWindowDiscovery.incomplete("known window owner is unavailable")
                }
                try budget.consumeNode()
                try budget.consumeAllocation(window.title.utf8.count)
                try budget.consumeAllocation(256)
                live.append(WindowRef(windowID: window.windowID, pid: window.pid,
                                      title: window.title, frame: bounds))
            }
            guard app.identity.isAlive else {
                throw SpaceOError.windowNotFound("the process changed during retained-window discovery")
            }
        }
        try budget.check()
        if Self.sortedWindows(live) != Self.sortedWindows(windows) { invalidateAXSnapshot() }
        windows = live
        // Retention proves live ownership/geometry, not that the cached title was re-observed.
        return observed
    }

    /// Window identities for another session's capture privacy boundary.
    ///
    /// This retains last-known identities when AX enumeration transiently returns nothing.
    /// A stale overlapping identity can make one capture fail closed;
    /// forgetting it could expose that window's pixels. Newly enumerated geometry wins when it is
    /// available, and ScreenCaptureKit independently verifies the identity before exclusion.
    /// All neighbours share a budget; incomplete discovery throws before any capture. Titles
    /// are omitted because exclusion planning only needs identities and geometry.
    func captureWindowIdentities(budget: AXTraversalBudget) throws -> [WindowRef] {
        var ownedPIDs = Set<pid_t>()
        var refreshed: [CGWindowID: WindowRef] = [:]
        for app in apps {
            try budget.consumeAllocation(MemoryLayout<pid_t>.stride)
            ownedPIDs.insert(app.pid)
            guard app.identity.isAlive else { continue }
            let found = try windowDriver.checkedWindows(app.pid, budget, false)
            guard app.identity.isAlive else {
                throw SpaceOError.captureFailed("foreign process changed during window discovery")
            }
            for window in found {
                refreshed[window.windowID] = WindowRef(windowID: window.windowID, pid: window.pid,
                                                     title: "", frame: window.frame)
            }
        }
        // Retain known windows through the narrow process-exit/compositor-removal transition.
        // Live pids are the only ones re-enumerated, but a still-shareable cached window remains
        // foreign content until the janitor removes its app from the session ledger.
        for window in windows {
            try budget.check()
            guard ownedPIDs.contains(window.pid), refreshed[window.windowID] == nil else { continue }
            try budget.consumeNode()
            try budget.consumeAllocation(256)
            refreshed[window.windowID] = WindowRef(windowID: window.windowID, pid: window.pid,
                                                 title: "", frame: window.frame)
        }
        try budget.check()
        return Self.sortedWindows(Array(refreshed.values))
    }

    private static func sortedWindows(_ windows: [WindowRef]) -> [WindowRef] {
        windows.sorted {
            if $0.windowID != $1.windowID { return $0.windowID < $1.windowID }
            return $0.pid < $1.pid
        }
    }

    public func window(id: CGWindowID) -> WindowRef? {
        windows.first { $0.windowID == id }
    }

    /// The window an agent means when it does not say which: the window the owning application
    /// reports as focused — an alert or sheet when one is up — or else the largest in our tile.
    ///
    /// The largest window used to win outright, so with a modal alert open `read_screen`
    /// described the blocked document and `press_key return` was refused because the app's keys
    /// go to the alert. This reads the last observation; `resolveDiscoveredWindow` refreshes it.
    public var primaryWindow: WindowRef? {
        Self.defaultTarget(windows: windows, region: frame) { self.focusObservations[$0]?.windowID }
    }

    /// Pure default-target rule, kept apart from the AX read so every branch is testable.
    ///
    /// The largest in-region window (or largest overall when none is in region) names the
    /// owning application. That application's focused window wins only when it is one of this
    /// session's windows owned by the same process: a focus answer naming anything else — or
    /// nothing — is not evidence about our windows, so the largest window stands.
    static func defaultTarget(
        windows: [WindowRef],
        region: CGRect,
        focusedWindowID: (pid_t) -> CGWindowID?
    ) -> WindowRef? {
        let mine = windows.filter { WindowPlacement.isInRegion($0, region) }
        let candidates = mine.isEmpty ? windows : mine
        guard let largest = candidates.max(by: {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        }) else { return nil }
        guard let focused = focusedWindowID(largest.pid), focused != 0,
              let window = windows.first(where: { $0.windowID == focused && $0.pid == largest.pid })
        else { return largest }
        return window
    }

    /// Ask the owning applications (at most 16) which window holds their focus. One bounded
    /// AX read per pid; an app that will not answer loses any stale observation.
    func refreshFocusObservations(pids requested: Set<pid_t>? = nil) {
        let owned = Set(windows.map(\.pid))
        let pids = requested.map { $0.intersection(owned) } ?? owned
        for pid in pids.sorted().prefix(16) {
            focusObservations[pid] = windowDriver.focusedWindow(pid)
        }
        for pid in focusObservations.keys where !owned.contains(pid) {
            focusObservations.removeValue(forKey: pid)
        }
    }

    /// `focused` and `modal` are nil when the owning app's focus was never observed; `modal` is
    /// only known for the focused window itself.
    public func focusMarkers(for window: WindowRef) -> (focused: Bool?, modal: Bool?, defaultTarget: Bool) {
        let cached = cachedFocusMarkers(for: window)
        return (cached.focused, cached.modal, primaryWindow?.windowID == window.windowID)
    }

    /// Focus and modality from the last observation alone; choosing the default target would
    /// read live geometry for every window.
    func cachedFocusMarkers(for window: WindowRef) -> (focused: Bool?, modal: Bool?) {
        let observation = focusObservations[window.pid]
        let focused = observation.map { $0.windowID == window.windowID }
        return (focused, focused == true ? observation?.modal : nil)
    }

    func notePointerFocus(windowID: CGWindowID, pid: pid_t, web: Bool) {
        lastPointerFocus = PointerFocusMemory(windowID: windowID, pid: pid, web: web)
    }

    public func resolveWindow(_ explicit: CGWindowID?) throws -> WindowRef {
        try refreshWindowsChecked()
        return try resolveDiscoveredWindow(explicit)
    }

    /// Validate an already discovered capture target without asking every application's AX
    /// provider to enumerate its windows. ScreenCaptureKit also checks the owner in the snapshot
    /// used for its independent-window filter; neither check admits an unknown window.
    func validateCaptureWindow(_ window: WindowRef) throws {
        guard windows.contains(where: { $0.windowID == window.windowID && $0.pid == window.pid }),
              let app = apps.first(where: { $0.pid == window.pid }),
              app.identity.isPrecise, ProcessIdentity.current(of: app.pid) == app.identity,
              windowDriver.liveOwnerPID(window.windowID) == app.pid,
              let bounds = windowDriver.liveBounds(window.windowID),
              windowDriver.liveOwnerPID(window.windowID) == app.pid,
              ProcessIdentity.current(of: app.pid) == app.identity else {
            throw SpaceOError.windowNotFound("capture window ownership changed or is unavailable; discover the window again")
        }
        guard bounds == window.frame else {
            throw SpaceOError.staleGeometry("window changed during capture; refresh windows and capture again")
        }
    }

    /// Only after the caller has successfully refreshed under its own observation budget.
    func resolveDiscoveredWindow(_ explicit: CGWindowID?) throws -> WindowRef {
        if let explicit {
            guard let found = window(id: explicit) else {
                throw SpaceOError.windowNotFound("window \(explicit) is not in session '\(id)'")
            }
            return found
        }
        // Ask only the owning app of the largest window: that is the app whose focus decides.
        if let largest = Self.defaultTarget(windows: windows, region: frame, focusedWindowID: { _ in nil }) {
            refreshFocusObservations(pids: [largest.pid])
        }
        guard let primary = primaryWindow else { throw missingWindowError() }
        return primary
    }

    // MARK: - Accessibility

    @discardableResult
    public func snapshotAX(window: WindowRef? = nil) throws -> AXSnapshot {
        try snapshotAX(window: window, limits: AXTraversalLimits())
    }

    /// Wait observations shorten the existing traversal envelope without moving native work
    /// outside the session's operation/lifecycle leases or changing snapshot attribution.
    @discardableResult
    func snapshotAX(window: WindowRef?, limits: AXTraversalLimits) throws -> AXSnapshot {
        let target = try window ?? resolveWindow(nil)
        let identity = try liveProcessIdentity(for: target)
        axSnapshotCache.invalidate()
        let generation = axSnapshotCache.generation
        let snapshot = try AXTree.snapshot(
            pid: target.pid,
            window: target,
            limits: limits,
            generation: generation)
        guard snapshot.processIdentity == identity else {
            throw SpaceOError.windowNotFound(
                "the process behind window \(target.windowID) changed during "
                    + "accessibility traversal")
        }
        try axSnapshotCache.store(snapshot)
        return snapshot
    }

    /// Resolve an element index only when it belongs to the explicitly requested live window.
    public func element(at index: Int, for window: WindowRef) throws -> AXUIElement {
        try axSnapshotCache.element(
            at: index,
            for: window,
            processIdentity: liveProcessIdentity(for: window))
    }

    /// Compatibility path for direct library callers. Command handling always passes its
    /// already-resolved target explicitly, and this path still refuses a cache from any other
    /// current primary window.
    public func element(at index: Int) throws -> AXUIElement {
        try element(at: index, for: resolveWindow(nil))
    }

    /// Any operation that may change the window hierarchy expires all previously published
    /// indices. A UUID generation also keeps an in-flight traversal from repopulating the cache.
    func invalidateAXSnapshot() {
        axSnapshotCache.invalidate()
    }

    private func liveProcessIdentity(for window: WindowRef) throws -> ProcessIdentity {
        guard let identity = apps.first(where: {
            $0.pid == window.pid && $0.identity.isAlive
        })?.identity else {
            if let exited = exitedApps().first(where: { $0.pid == window.pid }) {
                throw SpaceOError.applicationExited(Self.exitSentence(exited, session: id))
            }
            throw SpaceOError.windowNotFound(
                "window \(window.windowID) is no longer backed by a live process "
                    + "owned by session '\(id)'")
        }
        return identity
    }

    // MARK: - Janitor

    /// Problems worth reporting: windows that wandered out of our tile, apps that died,
    /// a display that lost its Space.
    public func audit() -> [String] {
        var findings: [String] = []
        if !stage.isValid { findings.append("agent display is no longer valid") }
        if stage.spaces.isEmpty { findings.append("agent display reports no Space of its own") }

        refreshWindows()
        if let windowRefreshFailure {
            findings.append("window discovery is incomplete: \(windowRefreshFailure)")
        }
        for window in windows where WindowPlacement.hasEscaped(window, from: frame) {
            let where_ = hasExclusiveDisplay
                ? "extends outside the exclusive display"
                : "extends outside the assigned session tile"
            findings.append("window \(window.windowID) (\(window.title)) \(where_)")
        }
        for app in apps where !app.identity.isAlive {
            findings.append("app \(app.name) (pid \(app.pid)) exited")
        }
        for failure in watcherRegistrationFailures {
            findings.append("window notifications are not fully registered for \(failure); "
                          + "late windows rely on the periodic sweep alone")
        }
        for failure in watcherSweepFailures {
            findings.append("window containment sweep is incomplete for \(failure)")
        }
        // Reported separately from, and more loudly than, a partial registration: this app has
        // no observer *and* no sweep of its own, so only the janitor's fallback is holding it.
        for unwatched in unwatchedApps {
            findings.append("no window watcher could be installed for \(unwatched); late windows "
                          + "are contained only by the janitor's periodic re-park")
        }
        let contained = containment
        if contained.refused > 0 {
            findings.append("\(contained.refused) window(s) refused to move into the tile "
                          + "(usually app-modal sheets, which stay attached to their parent)")
        }
        return findings
    }

    @discardableResult
    public func reparkEscapedWindows() -> Int {
        reparkEscapedWindows(ofPIDs: nil)
    }

    /// - Parameter pids: nil re-parks every owned window; a set restricts the pass to those apps,
    ///   which is what the janitor's unwatched-app fallback wants — apps that still have a
    ///   working watcher are already sweeping themselves.
    private func reparkEscapedWindows(ofPIDs pids: Set<pid_t>?) -> Int {
        let moved = (try? withMovementDiscovery(forPIDs: pids) { movements in
            var moved = 0
            for window in windows {
                guard let movement = movements[window.pid] else { continue }
                // A window the WindowServer has forgotten is closed, not escaped.
                guard let bounds = windowDriver.liveBounds(window.windowID),
                      !WindowPlacement.isFullyInside(bounds, frame) else { continue }
                try? movement.move(window, WindowPlacement.targetFrame(for: bounds, in: frame))
                // Count what the WindowServer confirms, not a completed movement attempt.
                guard let landed = windowDriver.liveBounds(window.windowID),
                      WindowPlacement.isFullyInside(landed, frame) else { continue }
                moved += 1
            }
            return moved
        }) ?? 0
        if moved > 0 { refreshWindows() }
        return moved
    }

    // MARK: - Teardown

    /// What every teardown pass so far did, names sorted for stable output.
    func teardownOutcome() -> TeardownOutcome {
        teardownLock.withLock {
            TeardownOutcome(
                quitApps: teardownQuit.values.sorted(),
                forcedApps: teardownForced.values.sorted(),
                releasedApps: teardownReleased.values.sorted(),
                profilesRemoved: teardownProfilesRemoved,
                clipboardCleared: teardownClipboardCleared)
        }
    }

    /// Fence this session synchronously before its potentially long cleanup leaves the manager
    /// actor. Existing operations may finish; new operations fail closed immediately.
    func prepareForDestroy() {
        _ = releaseStaleHeldKeys(force: true)
        lifecycle.prepareForDestroy()
    }

    /// Release the session's apps and windows.
    ///
    /// Order is load-bearing. The WindowServer will not retire a virtual display while windows
    /// still live on it, so the tile must be emptied *before* `DisplayPool` releases the slot:
    ///
    ///   1. evacuate windows belonging to apps we are not quitting back to the user's display,
    ///   2. quit the apps we started and wait for them to actually exit,
    ///   3. re-read live bounds and report every window still on the agent display,
    ///   4. the pool then frees the tile, and retires the display if we were the last tenant.
    ///
    /// Skipping step 2 leaves a phantom monitor attached until the process dies. Skipping step 3
    /// is worse: the report claims success, the caller recycles the tile, and the next session's
    /// capture of that tile contains the previous agent's windows.
    ///
    /// - Parameter force: after `timeout`, force-terminate apps *we started* that refuse to quit
    ///   (a modal save sheet is the usual reason). Apps we merely adopted are never force-killed.
    @discardableResult
    public func destroy(
        quitApps: Bool = true,
        force: Bool = true,
        timeout: TimeInterval = 6
    ) -> TeardownReport {
        guard (try? stage.requireHostHealth()) != nil else {
            return TeardownReport(stillAttachedDisplayIDs: [stage.displayID], pendingSessionIDs: [id])
        }
        teardownLock.lock()
        defer { teardownLock.unlock() }

        var firstReport: TeardownReport?
        let performedInitialCleanup = lifecycle.destroy {
            firstReport = destroyResources(
                quitApps: quitApps,
                force: force,
                timeout: timeout)
        }
        if performedInitialCleanup, let firstReport { return firstReport }

        // The lifecycle remains terminal, but its retained resource ledger is intentionally
        // retryable. No new operation can start while this pass attempts the cleanup again.
        return destroyResources(quitApps: quitApps, force: force, timeout: timeout)
    }

    private func destroyResources(
        quitApps: Bool,
        force: Bool,
        timeout: TimeInterval
    ) -> TeardownReport {
        // No watcher may pull an evacuated window back onto a tile we are releasing. Stop
        // admission first, then require every already-entered sweep to return. Never wait here:
        // destroy can be called reentrantly from a placement callback or on the main run loop.
        // Retain the complete resource ledger and let the caller retry after native work ends.
        // Timed-out capture callbacks also retain tickets until all pixel/native work returns.
        for watcher in watchers.values { watcher.stop() }
        guard captureWork.prepareForTeardown(), watchers.values.allSatisfy(\.isQuiescent) else {
            return TeardownReport(stillAttachedDisplayIDs: [stage.displayID],
                                  pendingSessionIDs: [id])
        }
        let safeTimeout = timeout.isFinite ? min(max(timeout, 0), 30) : 6
        let ourPIDs = Set(apps.filter(\.startedByUs).map(\.pid))

        // Quitting an app pulls focus just as launching one does — a document with unsaved
        // changes gets brought forward to show its save sheet before it dies. Remember where
        // the user was so we can put them back.
        let userRoute = capturesInputRouteDuringTeardown
            ? try? InputRouter.captureUserInputRoute(excluding: ourPIDs)
            : nil

        // 1. Never evacuate an incomplete list. Explicit quitting of apps we launched can
        // still recover an unresponsive AX provider, but the full ledger stays owned for retry.
        let evacuatingPIDs = Set(apps.lazy.filter { !quitApps || !$0.startedByUs }.map(\.pid))
        var discoveryComplete = (try? withMovementDiscovery(forPIDs: evacuatingPIDs) { movements -> Void in
            let survivors = windows.filter { !quitApps || !ourPIDs.contains($0.pid) }
            if !survivors.isEmpty, let userDisplay = windowDriver.userDisplayBounds() {
                for (index, window) in survivors.enumerated() {
                    let target = WindowPlacement.cascadeFrame(in: userDisplay, index: index)
                    // Best effort — verified against authoritative bounds below, never assumed.
                    try? movements[window.pid]?.move(window, target)
                }
            }
        }) != nil

        // 2. Quit ours, then confirm they are really gone. Liveness is by identity throughout:
        // a PID that reappears mid-teardown belongs to someone else and must not be waited on,
        // let alone force-terminated.
        var pending: [LaunchedApp] = []
        var quitRequested: [LaunchedApp] = []
        var forceRequested: [LaunchedApp] = []
        if quitApps {
            for app in apps
            where app.startedByUs && teardownDriver.isAlive(app.identity) {
                teardownDriver.quit(app, false)
                quitRequested.append(app)
            }
            pending = teardownDriver.waitForExit(
                apps.filter(\.startedByUs),
                safeTimeout)
            if force {
                for app in pending { teardownDriver.quit(app, true) }
                forceRequested = pending
                pending = teardownDriver.waitForExit(pending, 3)
            }
            pending = pending.filter { teardownDriver.isAlive($0.identity) }
        }
        let survivingIdentities = Set(pending.map(\.identity))
        // Record only what the process table confirms: a quit request that left the process
        // alive is a survivor, not a quit app.
        for app in quitRequested where !survivingIdentities.contains(app.identity) {
            teardownQuit[app.identity] = app.name
        }
        for app in forceRequested where !survivingIdentities.contains(app.identity) {
            teardownQuit[app.identity] = app.name
            teardownForced[app.identity] = app.name
        }

        // Include dialogs opened during evacuation or quit. A failed second read retains the
        // whole ledger rather than turning the earlier snapshot into proof of current absence.
        if discoveryComplete { discoveryComplete = (try? refreshWindowsChecked()) != nil }
        let verifiedSurvivors = discoveryComplete
            ? windows.filter { !quitApps || !ourPIDs.contains($0.pid) } : []

        // 3. Prove the tile is actually empty. Evacuation is best effort — an app-modal save
        // sheet stays attached to its parent and refuses to move (§3.2) — and every path that
        // trusted it instead recycled the tile under live windows, putting the previous agent's
        // screen inside the next agent's capture (§3.0). Authoritative bounds, re-read now, are
        // the only acceptable evidence.
        var strandedWindows: [StrandedWindowInfo] = []
        for window in verifiedSurvivors {
            switch evacuationState(of: window) {
            case .evacuated: break
            case .stranded(let bounds):
                strandedWindows.append(StrandedWindowInfo(window: window, inTile: bounds.intersects(frame)))
            case .unknown:
                discoveryComplete = false
                windowRefreshFailure = "window geometry is unavailable during evacuation verification"
            }
        }
        let strandedPIDs = Set(strandedWindows.map(\.pid))

        // Hand focus back only if teardown left an agent route behind. If the user switched to
        // another ordinary app while cleanup was waiting, that newer choice takes precedence.
        let currentFrontmostPID =
            NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if let userRoute,
           ourPIDs.contains(currentFrontmostPID) {
            _ = InputRouter.restoreUserInputRoute(userRoute)
        } else if let owner = ownerAtCreation,
                  ourPIDs.contains(currentFrontmostPID),
                  NSRunningApplication(processIdentifier: owner.processIdentifier) != nil {
            // The session may have started while one of its apps was already frontmost, leaving
            // no complete route snapshot. Public activation is a last-resort visual recovery.
            _ = owner.activate()
        }

        guard discoveryComplete else {
            return TeardownReport(survivingProcesses: pending.map(SurvivingProcessInfo.init),
                stillAttachedDisplayIDs: [stage.displayID], pendingSessionIDs: [id],
                windowDiscoveryFailures: ["\(id): \(windowRefreshFailure ?? "discovery did not complete")"])
        }

        // An app whose window is still on the agent display stays in the ledger even under
        // `--keep-apps`. Releasing it would let the very next destroy retry find an empty app
        // list, report success, and free the tile the window never left.
        let retained = apps.filter {
            survivingIdentities.contains($0.identity) || strandedPIDs.contains($0.pid)
        }
        let retainedIdentities = Set(retained.map(\.identity))
        let completedApps = apps.filter {
            !retainedIdentities.contains($0.identity)
        }
        for app in completedApps {
            AgentActivity.release(pid: app.pid)
            ProcessOwnership.release(app.identity)
            // `--keep-apps` releases a live launched process. Its temporary browser profile is
            // still in use and belongs with that surviving process, not with session cleanup.
            if !app.startedByUs
                || quitApps
                || !teardownDriver.isAlive(app.identity) {
                teardownDriver.cleanupTemporaryProfile(app)
                if app.temporaryProfile != nil || app.temporaryControlRoot != nil {
                    teardownProfilesRemoved += 1
                }
            }
            if !app.startedByUs || !quitApps, teardownQuit[app.identity] == nil {
                teardownReleased[app.identity] = app.name
            }
            watchers.removeValue(forKey: app.pid)?.stop()
            watcherCreationFailures.removeValue(forKey: app.pid)
            if let bridge = bridges.removeValue(forKey: app.pid) {
                Task { await bridge.detach() }
            }
            electronEditorBridges.removeValue(forKey: app.pid)
        }
        apps = retained
        let retainedPIDs = Set(retained.map(\.pid))
        windows.removeAll { !retainedPIDs.contains($0.pid) }
        invalidateAXSnapshot()

        if retained.isEmpty {
            // The brokered clipboard is session content; it must not outlive the session.
            if !clipboard.isEmpty {
                clipboard.clear()
                teardownClipboardCleared = true
            }
            // Belt and braces: a completed teardown must not leave an unrepresented stale claim.
            ProcessOwnership.releaseAll(owner: id)
            for watcher in watchers.values { watcher.stop() }
            watchers.removeAll()
            watcherCreationFailures.removeAll()
            for bridge in bridges.values { Task { await bridge.detach() } }
            bridges.removeAll()
            electronEditorBridges.removeAll()
            windows.removeAll()
        }

        // A stranded window always retains the app that owns it, so `retained` is the single
        // source of truth for whether this session still holds its display and tile.
        return TeardownReport(
            survivingProcesses: pending.map(SurvivingProcessInfo.init),
            strandedWindows: strandedWindows,
            stillAttachedDisplayIDs: retained.isEmpty ? [] : [stage.displayID],
            pendingSessionIDs: retained.isEmpty ? [] : [id])
    }
}
