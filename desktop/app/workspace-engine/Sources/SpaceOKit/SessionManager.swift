import Foundation
import AppKit
import CoreGraphics
import SpaceOPrivate

/// Owns every live session and executes commands against them.
///
/// An actor because sessions touch the WindowServer and AX, and interleaving two agents'
/// window moves would produce exactly the kind of flakiness that is miserable to debug.
public actor SessionManager {

    typealias SessionFactory =
        @Sendable (_ id: String, _ slot: DisplayPool.Slot) throws -> AgentSession
    typealias MaterializedAppHandler = (_ app: LaunchedApp) async throws -> Void

    protocol SessionLaunching {
        nonisolated(nonsending) func launch(
            session: AgentSession,
            appURL: URL,
            files: [URL],
            timeout: Double,
            allowNoWindows: Bool,
            arguments: [String],
            muteAudio: Bool,
            onMaterialized: MaterializedAppHandler
        ) async throws -> LaunchedApp
    }

    private struct LiveSessionLauncher: SessionLaunching {
        nonisolated(nonsending) func launch(
            session: AgentSession,
            appURL: URL,
            files: [URL],
            timeout: Double,
            allowNoWindows: Bool,
            arguments: [String],
            muteAudio: Bool,
            onMaterialized: MaterializedAppHandler
        ) async throws -> LaunchedApp {
            try await session.launch(
                app: appURL,
                opening: files,
                timeout: timeout,
                allowNoWindows: allowNoWindows,
                arguments: arguments,
                muteAudio: muteAudio,
                onMaterialized: onMaterialized)
        }
    }

    var sessions: [String: AgentSession] = [:]
    var counter = 0
    let pool: DisplayPool
    private let sessionFactory: SessionFactory
    let sessionLauncher: any SessionLaunching
    let daemonInstanceID: UUID
    let isolationPreflight: @Sendable () -> IsolationReport?
    let drivingAvailable: @Sendable () -> Bool?
    let reclamationPolicy: SessionReclamationPolicy
    private let successfulMutationHook: @Sendable () -> Void
    let livePersistence: LiveSessionPersistence?
    let recoveryCoordinator: SessionRecoveryCoordinator?
    /// Actor isolation does not serialize across `await`; this gate deliberately does. It is
    /// process-wide rather than per-session because display allocation, user input routing, and
    /// shutdown all mutate shared host resources, so ordering only same-session commands would
    /// still allow cross-session lifecycle races.
    let operationGate: SessionOperationGate
    let waitRuntime: WaitRuntime
    var isShuttingDown = false
    private var idleDisplayRetirement: Task<Void, Never>?
    /// Keep one reusable idle framebuffer; retire excess idle displays after a short grace.
    /// Explicit operator cleanup still retires every empty display.
    private let retainedIdleDisplayCount: Int
    let hostHealthCheck: @Sendable () throws -> Void
    let transientHealthCheck: @Sendable () -> Bool
    private let idleDisplayGraceNanoseconds: UInt64
    private static let defaultIdleDisplayGraceNanoseconds: UInt64 = 15_000_000_000
    private var displayLifecycleFailures: Set<CGDirectDisplayID> = []
    /// The live display inventory recorded failures are pruned against. Injectable so teardown
    /// verification can be tested without a real framebuffer on the host.
    let onlineDisplayIDs: @Sendable () -> [CGDirectDisplayID]
    private var janitor: Task<Void, Never>?
    /// Returns activation to the person when an agent application takes it (#53).
    let focusGuard = AgentFocusGuard.shared
    private let janitorEnabled: Bool
    private let janitorIntervalNanoseconds: UInt64 = 3_000_000_000
    /// A named live teardown leaves the actor while it waits for processes. Reject a duplicate
    /// request instead of letting two callers independently finalize the same durable record.
    var destroyingSessionIDs: Set<String> = []
    /// Immutable pre-worker rows keep `session.list` truthful without racing the teardown ledger.
    var destroyingSessionSnapshots: [String: SessionInfo] = [:]
    /// `daemon.drain` (SPAO-204): refuse new sessions, keep serving existing ones, and hand the
    /// process to `onDrainComplete` once the last session is gone or the deadline passes.
    var isDraining = false
    var drainDeadline: Date?
    var drainWatcher: Task<Void, Never>?
    var onDrainComplete: (@Sendable () -> Void)?
    /// The last durable projection written per session, so an idle janitor tick that would
    /// rewrite an identical record writes nothing (SPAO-151).
    var lastPersistedDigest: [String: Data] = [:]
    var idleWritesSkipped = 0
    /// Recorders for sessions created with `record:` (SPAO-220); keyed by session id.
    var recorders: [String: SessionRecorder] = [:]
    var recordingFailureWarnings: [String: String] = [:]
    /// Bounded memory of how recent sessions ended, so `session.claim` can say "already
    /// reclaimed by the janitor 40 s ago" instead of an unexplained "no session named".
    var recentlyEndedSessions: [EndedSession] = []
    /// Watches for wake and display reconfiguration once the daemon asks for it.
    var displayEnvironmentObserver: DisplayEnvironmentObserver?
    private let recordingRootDirectory: URL?
    let recordingFrameCapture: RecordingFrameCapture
    let waitFrameCapture: WaitFrameCapture
    let screenshotCapture: ScreenshotCapture

    public init(pool: DisplayPool = DisplayPool(), runJanitor: Bool = true) {
        self.pool = pool
        self.sessionFactory = { AgentSession(id: $0, slot: $1) }
        self.sessionLauncher = LiveSessionLauncher()
        self.recordingRootDirectory = nil
        self.recordingFrameCapture = RecordingFrameCapture()
        self.waitFrameCapture = WaitFrameCapture()
        self.screenshotCapture = ScreenshotCapture()
        self.isolationPreflight = { IsolationSnapshot.capture().currentReport() }
        self.drivingAvailable = { Capabilities().canDrive }
        self.operationGate = SessionOperationGate()
        self.waitRuntime = .live
        self.daemonInstanceID = UUID()
        self.reclamationPolicy = SessionReclamationPolicy()
        self.successfulMutationHook = {}
        self.livePersistence = nil
        self.recoveryCoordinator = nil
        self.onlineDisplayIDs = { Stage.onlineDisplayIDs() }
        self.retainedIdleDisplayCount = 1
        self.hostHealthCheck = { try Stage.checkActiveHostHealth() }
        self.transientHealthCheck = { Stage.isRecoveringTransientResources() }
        self.idleDisplayGraceNanoseconds = Self.defaultIdleDisplayGraceNanoseconds
        self.janitorEnabled = runJanitor
        guard runJanitor else { return }
        Task { [weak self] in await self?.startJanitor() }
    }

    /// Build a manager whose successful live-session mutations are backed by durable state.
    ///
    /// The store is loaded before the manager begins accepting work. The required coordinator
    /// must have completed `startup()` first, so every prior-daemon record is already fenced.
    /// Corrupt or unreadable state fails construction instead of being treated as empty.
    public init(
        pool: DisplayPool = DisplayPool(),
        runJanitor: Bool = true,
        sessionStore: SessionStore,
        recoveryCoordinator: SessionRecoveryCoordinator,
        daemonInstanceID: UUID = UUID()
    ) throws {
        try recoveryCoordinator.assertReady(
            for: daemonInstanceID,
            store: sessionStore)
        let persistence = LiveSessionPersistence(store: sessionStore)
        let ledger = try persistence.load()
        self.pool = pool
        self.sessionFactory = { AgentSession(id: $0, slot: $1) }
        self.sessionLauncher = LiveSessionLauncher()
        self.recordingRootDirectory = nil
        self.recordingFrameCapture = RecordingFrameCapture()
        self.waitFrameCapture = WaitFrameCapture()
        self.screenshotCapture = ScreenshotCapture()
        self.isolationPreflight = { IsolationSnapshot.capture().currentReport() }
        self.drivingAvailable = { Capabilities().canDrive }
        self.operationGate = SessionOperationGate()
        self.waitRuntime = .live
        self.daemonInstanceID = daemonInstanceID
        self.reclamationPolicy = SessionReclamationPolicy()
        self.successfulMutationHook = {}
        self.livePersistence = persistence
        self.recoveryCoordinator = recoveryCoordinator
        self.counter = max(0, (ledger?.nextAutomaticSessionNumber ?? 1) - 1)
        self.onlineDisplayIDs = { Stage.onlineDisplayIDs() }
        self.retainedIdleDisplayCount = 1
        self.hostHealthCheck = { try Stage.checkActiveHostHealth() }
        self.transientHealthCheck = { Stage.isRecoveringTransientResources() }
        self.idleDisplayGraceNanoseconds = Self.defaultIdleDisplayGraceNanoseconds
        self.janitorEnabled = runJanitor
        guard runJanitor else { return }
        Task { [weak self] in await self?.startJanitor() }
    }

    init(
        pool: DisplayPool,
        runJanitor: Bool,
        operationGate: SessionOperationGate = SessionOperationGate(),
        waitRuntime: WaitRuntime = .live,
        daemonInstanceID: UUID = UUID(),
        reclamationPolicy: SessionReclamationPolicy = SessionReclamationPolicy(),
        successfulMutationHook: @escaping @Sendable () -> Void = {},
        onlineDisplayIDs: @escaping @Sendable () -> [CGDirectDisplayID] = {
            Stage.onlineDisplayIDs()
        },
        idleDisplayGraceNanoseconds: UInt64 = SessionManager.defaultIdleDisplayGraceNanoseconds,
        retainedIdleDisplayCount: Int = 1,
        hostHealthCheck: @escaping @Sendable () throws -> Void = {},
        transientHealthCheck: @escaping @Sendable () -> Bool = { false },
        sessionLauncher: any SessionLaunching = LiveSessionLauncher(),
        recordingRootDirectory: URL? = nil,
        recordingFrameCapture: RecordingFrameCapture = RecordingFrameCapture(),
        waitFrameCapture: WaitFrameCapture = WaitFrameCapture(),
        screenshotCapture: ScreenshotCapture = ScreenshotCapture(),
        isolationPreflight: @escaping @Sendable () -> IsolationReport? = { nil },
        sessionFactory: @escaping SessionFactory
    ) {
        self.pool = pool
        self.sessionFactory = sessionFactory
        self.sessionLauncher = sessionLauncher
        self.recordingRootDirectory = recordingRootDirectory
        self.recordingFrameCapture = recordingFrameCapture
        self.waitFrameCapture = waitFrameCapture
        self.screenshotCapture = screenshotCapture
        self.isolationPreflight = isolationPreflight
        self.drivingAvailable = { nil }
        self.operationGate = operationGate
        self.waitRuntime = waitRuntime
        self.daemonInstanceID = daemonInstanceID
        self.reclamationPolicy = reclamationPolicy
        self.successfulMutationHook = successfulMutationHook
        self.livePersistence = nil
        self.recoveryCoordinator = nil
        self.onlineDisplayIDs = onlineDisplayIDs
        self.idleDisplayGraceNanoseconds = idleDisplayGraceNanoseconds
        self.retainedIdleDisplayCount = max(0, min(retainedIdleDisplayCount, 1))
        self.hostHealthCheck = hostHealthCheck
        self.transientHealthCheck = transientHealthCheck
        self.janitorEnabled = runJanitor
        guard runJanitor else { return }
        Task { [weak self] in await self?.startJanitor() }
    }

    /// Persistence-enabled test construction with the same injectable runtime seams as the
    /// in-memory manager.
    init(
        pool: DisplayPool,
        runJanitor: Bool,
        operationGate: SessionOperationGate = SessionOperationGate(),
        waitRuntime: WaitRuntime = .live,
        daemonInstanceID: UUID = UUID(),
        reclamationPolicy: SessionReclamationPolicy = SessionReclamationPolicy(),
        successfulMutationHook: @escaping @Sendable () -> Void = {},
        onlineDisplayIDs: @escaping @Sendable () -> [CGDirectDisplayID] = {
            Stage.onlineDisplayIDs()
        },
        idleDisplayGraceNanoseconds: UInt64 = SessionManager.defaultIdleDisplayGraceNanoseconds,
        retainedIdleDisplayCount: Int = 1,
        hostHealthCheck: @escaping @Sendable () throws -> Void = {},
        transientHealthCheck: @escaping @Sendable () -> Bool = { false },
        livePersistence: LiveSessionPersistence,
        recoveryCoordinator: SessionRecoveryCoordinator? = nil,
        sessionLauncher: any SessionLaunching = LiveSessionLauncher(),
        recordingRootDirectory: URL? = nil,
        recordingFrameCapture: RecordingFrameCapture = RecordingFrameCapture(),
        waitFrameCapture: WaitFrameCapture = WaitFrameCapture(),
        screenshotCapture: ScreenshotCapture = ScreenshotCapture(),
        isolationPreflight: @escaping @Sendable () -> IsolationReport? = { nil },
        sessionFactory: @escaping SessionFactory
    ) throws {
        let ledger = try livePersistence.load()
        self.pool = pool
        self.sessionFactory = sessionFactory
        self.sessionLauncher = sessionLauncher
        self.recordingRootDirectory = recordingRootDirectory
        self.recordingFrameCapture = recordingFrameCapture
        self.waitFrameCapture = waitFrameCapture
        self.screenshotCapture = screenshotCapture
        self.isolationPreflight = isolationPreflight
        self.drivingAvailable = { nil }
        self.operationGate = operationGate
        self.waitRuntime = waitRuntime
        self.daemonInstanceID = daemonInstanceID
        self.reclamationPolicy = reclamationPolicy
        self.successfulMutationHook = successfulMutationHook
        self.livePersistence = livePersistence
        self.recoveryCoordinator = recoveryCoordinator
        self.counter = max(0, (ledger?.nextAutomaticSessionNumber ?? 1) - 1)
        self.onlineDisplayIDs = onlineDisplayIDs
        self.idleDisplayGraceNanoseconds = idleDisplayGraceNanoseconds
        self.retainedIdleDisplayCount = max(0, min(retainedIdleDisplayCount, 1))
        self.hostHealthCheck = hostHealthCheck
        self.transientHealthCheck = transientHealthCheck
        self.janitorEnabled = runJanitor
        guard runJanitor else { return }
        Task { [weak self] in await self?.startJanitor() }
    }

    // MARK: - Janitor

    /// The runtime janitor the architecture always promised.
    ///
    /// Per-app `WindowWatcher`s handle containment; this loop covers what they structurally
    /// cannot — an app that exited (nothing left to notify us), and a session whose watchers
    /// all failed to register. It is bounded (one pass per interval, no concurrency) and
    /// cancellable, so daemon shutdown leaves no task behind.
    func startJanitor() {
        janitor?.cancel()
        janitor = nil
        // A committed shutdown is the one state that must never grow a new background task,
        // including from the start hop `init` scheduled before the stop arrived.
        guard !isShuttingDown else { return }
        let interval = janitorIntervalNanoseconds
        janitor = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: interval)
                } catch {
                    return
                }
                guard let self else { return }
                guard await self.admitJanitorPass() else {
                    if Task.isCancelled { return }
                    continue
                }
                do {
                    _ = try await self.runJanitorPass()
                } catch {
                    // The janitor has no caller to report to; swallowing here used to make
                    // reclamation failures invisible, which is the opposite of recoverable.
                    DaemonLog.shared.event("janitor.failed", [
                        "error": error.localizedDescription,
                    ])
                }
            }
        }
    }

    /// A sticky health refusal cannot be repaired by another timed sweep. Keep the owner
    /// and passive diagnostics available, but stop the background retry loop.
    func admitJanitorPass() -> Bool {
        // Mirror the scan: without a display there is no health admission to refuse, and
        // detached-record recovery must keep running.
        guard pool.displayCount > 0 else { return true }
        do {
            try hostHealthCheck()
            return true
        } catch {
            // The sampler continues independently during known pressure, so keep the
            // janitor alive but do not run a pass until health has recovered.
            if transientHealthCheck() { return false }
            // Pressure may have cleared between the refusal and the classification.
            if (try? hostHealthCheck()) != nil { return true }
            DaemonLog.shared.event("janitor.paused-host-health", [
                "error": error.localizedDescription,
            ])
            stopJanitor()
            return false
        }
    }

    /// One pass over every session. Exposed so a test can drive the janitor deterministically
    /// instead of sleeping on a timer.
    @discardableResult
    public func runJanitorPass() async throws -> Int {
        let commandLease = try await operationGate.enter()
        guard !isShuttingDown else {
            commandLease.finish()
            return 0
        }
        // A teardown in flight fences only its own session. Reaping exited apps and
        // recovering detached records for everyone else must not pause for it: a slow
        // process-exit wait would otherwise starve every other session of health signals.
        let scan: (reapedApps: Int, reclaimableSessionIDs: [String])
        do {
            scan = try runJanitorScanNow()
        } catch {
            commandLease.finish()
            throw error
        }
        commandLease.finish()

        // Reclamation is ordinary single-session teardown. Run each one through the same
        // responsive path as an operator request so its process waits never stall other agents.
        for id in scan.reclaimableSessionIDs {
            var request = Request(cmd: "session.destroy")
            request.session = id
            request.operatorScope = true
            do {
                let response = try await executeResponsiveDestroy(
                    request, reason: "janitor_abandoned", requireReclaimable: true)
                DaemonLog.shared.event("janitor.reclaimed", [
                    "session": id,
                    "complete": "true",
                    "summary": response.destroySummary?.summaryLine ?? "",
                ])
            } catch is JanitorReclaimSkipped {
                // Claimed (or otherwise revived) between the scan and this destroy. The scan's
                // verdict is stale; the session now has a controller again.
                DaemonLog.shared.event("janitor.reclaim.skipped", [
                    "session": id,
                    "reason": "no longer reclaimable",
                ])
            } catch let SpaceOError.teardownIncomplete(report) {
                DaemonLog.shared.event("janitor.reclaimed", [
                    "session": id,
                    "complete": "false",
                    "teardown": report.recoveryDescription,
                ])
            } catch {
                // An operator destroy that raced this pass, or a session that vanished between
                // the scan and the loop, must not abort reclamation of the remaining sessions.
                DaemonLog.shared.event("janitor.reclaimed", [
                    "session": id,
                    "complete": "false",
                    "error": error.localizedDescription,
                ])
            }
        }
        return scan.reapedApps
    }

    private func runJanitorScanNow() throws -> (
        reapedApps: Int,
        reclaimableSessionIDs: [String]
    ) {
        if pool.displayCount > 0 { try hostHealthCheck() }
        var reapedApps = 0
        var reclaimableSessionIDs: [String] = []
        // Detached records have no WindowServer authority. Their separate recovery engine only
        // reasons about exact process identities and is serialized with every live ledger write.
        _ = try recoveryCoordinator?.runRecoveryPass()
        for id in sessions.keys.sorted() {
            guard let session = sessions[id] else { continue }
            // A session whose teardown worker is running is already fenced, and its durable
            // record already says cleanup-pending with the caller's disposition. Rewriting it
            // as `.ready` from here would make crash recovery forget the teardown intent.
            guard !destroyingSessionIDs.contains(id) else { continue }
            try persistSession(
                session,
                operationState: session.teardownPending ? .cleanupPending : .ready)
            if session.controllerSnapshot()?.reclaimable == true {
                reclaimableSessionIDs.append(id)
                continue
            }
            if let notice = session.leaseExpiringNotice() {
                emit("lease.expiring", session: id, [
                    "secondsRemaining": String(Int(notice.remaining.rounded(.down))),
                    "ttlSeconds": String(Int(notice.ttl.rounded())),
                ])
            }
            do {
                let lifecycleLease = try session.beginOperation()
                defer { lifecycleLease.finish() }
                // Snapshot before the pass: the janitor removes an exited app from the ledger,
                // and the count it returns is the only thing that survives it.
                let before = session.apps
                _ = session.releaseStaleHeldKeys()
                let reaped = session.runJanitorPass()
                reapedApps += reaped
                if reaped > 0 {
                    // An owned app dying is a lifecycle event with no other trace. The session
                    // silently goes from "1 app, 1 window" to empty: no failed request to log,
                    // no findings unless someone calls `verify` in the window before the ledger
                    // forgets, and nothing at all afterwards. Reclaiming a whole session is
                    // already recorded above; reclaiming the apps inside one was not.
                    let survivors = Set(session.apps.map(\.pid))
                    let gone = before.filter { !survivors.contains($0.pid) }
                    DaemonLog.shared.event("janitor.reaped", [
                        "session": id,
                        "apps": String(reaped),
                        "names": gone.map(\.name).sorted().joined(separator: ","),
                    ])
                    emit("app.exited", session: id, ["names": gone.map(\.name).sorted().joined(separator: ",")])
                    try persistSession(session, operationState: .ready)
                }
            } catch {
                if session.teardownPending {
                    try persistSession(session, operationState: .cleanupPending)
                    continue
                }
                throw error
            }
        }
        return (reapedApps, reclaimableSessionIDs)
    }

    public func stopJanitor() {
        janitor?.cancel()
        janitor = nil
    }

    var janitorIsRunning: Bool { janitor != nil }

    public var isEmpty: Bool { sessions.isEmpty }
    public var count: Int { sessions.count }
    public var displayCount: Int { pool.displayCount }
    public var sessionsPerDisplay: Int { pool.sessionsPerDisplay }

    public func setSessionsPerDisplay(_ value: Int) throws {
        try pool.setSessionsPerDisplay(value)
    }

    // MARK: - Lifecycle

    @discardableResult
    public func create(name: String?) async throws -> AgentSession {
        let commandLease = try await operationGate.enter()
        defer { commandLease.finish() }
        guard !isShuttingDown else {
            throw SpaceOError.daemonStopping
        }
        return try createNow(
            name: name,
            controllerOwner: nil,
            controllerLeaseID: nil,
            controllerTTLSeconds: nil)
    }

    func createNow(
        name: String?,
        controllerOwner: DurableSessionOwner?,
        controllerLeaseID: UUID?,
        controllerTTLSeconds: TimeInterval?,
        orphanGraceSeconds: TimeInterval? = nil,
        exclusive: CGSize?? = nil
    ) throws -> AgentSession {
        try hostHealthCheck()
        let latestLedger = try livePersistence?.load()
        let durableSessionIDs = Set(latestLedger?.sessions.map(\.id) ?? [])
        let namedID: String?
        if let name {
            let trimmed = try Self.canonicalSessionID(name)
            guard sessions[trimmed] == nil, !durableSessionIDs.contains(trimmed) else {
                throw sessionExistsError(trimmed, ledger: latestLedger, requester: controllerOwner)
            }
            namedID = trimmed
        } else {
            namedID = nil
        }
        var nextCounter: Int?
        let id: String
        if let namedID {
            id = namedID
        } else {
            var candidateNumber = max(
                counter,
                (latestLedger?.nextAutomaticSessionNumber ?? 1) - 1)
            var candidateID: String
            repeat {
                guard candidateNumber < Int.max else {
                    throw SpaceOError.badRequest("automatic session id space is exhausted")
                }
                candidateNumber += 1
                candidateID = "agent-\(candidateNumber)"
            } while sessions[candidateID] != nil
                || durableSessionIDs.contains(candidateID)
            guard candidateNumber < Int.max else {
                throw SpaceOError.badRequest("automatic session id space is exhausted")
            }
            id = candidateID
            nextCounter = candidateNumber
        }
        let allowsLeaseOmission = controllerOwner == nil
        let owner = try validatedControllerOwner(controllerOwner, sessionID: id)
        let duration = try reclamationPolicy.duration(requested: controllerTTLSeconds)
        let orphanGrace = try reclamationPolicy.orphanGrace(requested: orphanGraceSeconds)
        // The pool reuses a display that still has a free tile, and only builds a new one
        // when they are all full.
        let slot: DisplayPool.Slot
        if let exclusive {
            slot = try pool.allocateExclusive(size: exclusive)
        } else {
            slot = try pool.allocate()
        }
        let session: AgentSession
        do {
            session = try sessionFactory(id, slot)
        } catch {
            _ = pool.release(slot)
            throw error
        }
        session.configureController(
            owner: owner,
            daemonInstanceID: daemonInstanceID,
            leaseID: controllerLeaseID ?? UUID(),
            duration: duration,
            policy: reclamationPolicy,
            allowsLeaseOmission: allowsLeaseOmission,
            gracePeriod: orphanGrace)
        session.setLifecycleEventSink { kind, detail in
            EventBus.shared.publish(kind: kind, session: id, detail: detail)
        }
        sessions[id] = session
        do {
            try persistSession(
                session,
                operationState: .ready,
                nextAutomaticSessionNumberAtLeast: (nextCounter ?? counter) + 1,
                requireNewRecord: true)
        } catch {
            // The new session was never reported as durable. Reclaim everything that can be
            // reclaimed locally, but retain an incomplete teardown in memory for retry.
            let report = session.destroy(quitApps: true)
            if report.isComplete {
                _ = pool.release(session.slot, retainEmpty: true)
                sessions.removeValue(forKey: id)
                scheduleIdleDisplayRetirement()
            }
            throw error
        }
        if let nextCounter { counter = nextCounter }
        return session
    }

    func validatedControllerOwner(
        _ requested: DurableSessionOwner?,
        sessionID: String
    ) throws -> DurableSessionOwner {
        let owner = requested ?? DurableSessionOwner(
            id: "legacy-\(sessionID)",
            kind: .other,
            label: "legacy local controller",
            processIdentity: ProcessIdentity.current(of: getpid()))
        let id = owner.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = owner.label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, id == owner.id,
              !label.isEmpty, label == owner.label,
              id.utf8.count <= 256, label.utf8.count <= 256,
              id.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }),
              label.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw SpaceOError.badRequest(
                "controller owner id and label must be trimmed, non-empty, "
                    + "control-free, and at most 256 UTF-8 bytes")
        }
        return owner
    }

    /// Session ids appear in every log line, durable record, and response that names the
    /// session, so an unbounded one is an unbounded write amplifier for the whole daemon.
    public static let maximumSessionIDCharacters = 128
    public static let maximumSessionIDBytes = 512

    static func canonicalSessionID(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, name.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }),
              !trimmed.contains("/"), !trimmed.contains("\\") else {
            throw SpaceOError.badRequest(
                "session id must not be empty or contain control characters "
                + "or path separators")
        }
        guard trimmed.utf8.count <= Self.maximumSessionIDBytes,
              trimmed.count <= Self.maximumSessionIDCharacters else {
            throw SpaceOError.badRequest(
                "session id must be at most \(Self.maximumSessionIDCharacters) characters "
                + "and \(Self.maximumSessionIDBytes) UTF-8 bytes")
        }
        return trimmed
    }

    public func session(_ id: String) throws -> AgentSession {
        let canonical = try Self.canonicalSessionID(id)
        guard let session = sessions[canonical] else {
            throw missingSessionError(canonical)
        }
        return session
    }

    /// The session to act on when the caller did not name one — valid only when exactly
    /// one exists, or when the caller's lease covers exactly one, so a multi-agent setup can
    /// never be ambiguous by accident.
    public func resolve(_ id: String?, leaseID: UUID? = nil) throws -> AgentSession {
        if let id { return try session(id) }
        guard sessions.count == 1, let only = sessions.values.first else {
            if sessions.isEmpty {
                throw SpaceOError.badRequest("no sessions exist; create a session first")
            }
            if let implied = leaseImpliedSession(leaseID) { return implied }
            throw ambiguousSessionError()
        }
        return only
    }

    func resolveForMutation(
        _ id: String?,
        leaseID: UUID?
    ) throws -> AgentSession {
        let session = try resolve(id, leaseID: leaseID)
        do {
            try session.authorizeControllerMutation(leaseID: leaseID)
        } catch {
            // Authorization refreshes expiry/liveness state. If that abandoned the session, the
            // rejection itself must not leave the durable record claiming it is still owned.
            try persistSession(
                session,
                operationState: session.teardownPending ? .cleanupPending : .ready)
            throw error
        }
        return session
    }

    func resolveForRead(
        _ id: String?,
        leaseID: UUID?
    ) throws -> AgentSession {
        let session = try resolve(id, leaseID: leaseID)
        try session.authorizeControllerRead(leaseID: leaseID)
        return session
    }

    /// Gate an operation whose blast radius crosses controller boundaries. It proceeds when
    /// the caller explicitly claims operator scope, or when every live session is already
    /// covered by the caller's lease — a client tearing down only its own work needs no flag.
    func requireOperatorScope(_ request: Request, action: String) throws {
        guard request.operatorScope != true else { return }
        let foreign = sessions.values
            .filter { !$0.controllerLeaseCovers(request.controllerLeaseID) }
            .map(\.id)
            .sorted()
        guard foreign.isEmpty else {
            throw SpaceOError.badRequest(
                "\(action) affects session(s) \(foreign.joined(separator: ", ")) held by "
                    + "other controllers; destroy your own sessions by name, or pass "
                    + "--operator to confirm acting for every controller on this machine")
        }
    }

    func renewAfterSuccessfulMutation(
        _ session: AgentSession,
        leaseID: UUID?
    ) throws {
        successfulMutationHook()
        try session.recordSuccessfulControllerMutation(leaseID: leaseID)
        try persistSession(
            session,
            operationState: session.teardownPending ? .cleanupPending : .ready)
    }

    // MARK: - Durable live-session state

    func persistSession(
        _ session: AgentSession,
        operationState: DurableSessionOperationState,
        cleanupComplete: Bool = false,
        cleanupDisposition: DurableSessionCleanupDisposition? = nil,
        nextAutomaticSessionNumberAtLeast requestedNextNumber: Int? = nil,
        requireNewRecord: Bool = false
    ) throws {
        guard let livePersistence else { return }
        let timestamp = max(reclamationPolicy.now(), session.createdAt)
        let minimumNextNumber = requestedNextNumber ?? max(1, counter + 1)
        // Idle ticks must be silent: compare the projection we would write (minus the fields
        // that change on every write) with the one we last wrote, and skip identical rewrites.
        // Intent-bearing writes (new record, cleanup transitions, explicit counters) always go
        // through, because their purpose is the durability itself.
        if !requireNewRecord, !cleanupComplete, requestedNextNumber == nil,
           cleanupDisposition == nil,
           let previous = lastPersistedDigest[session.id],
           let digest = try? persistenceDigest(for: session, operationState: operationState),
           digest == previous {
            idleWritesSkipped += 1
            return
        }
        try livePersistence.update(
            writerDaemonInstanceID: daemonInstanceID,
            at: timestamp,
            nextAutomaticSessionNumberAtLeast: minimumNextNumber
        ) { ledger in
            let index = ledger.sessions.firstIndex(where: { $0.id == session.id })
            let existing = index.map { ledger.sessions[$0] }
            if requireNewRecord, existing != nil {
                throw SpaceOError.badRequest(
                    "session '\(session.id)' already exists in durable state")
            }
            let record = try self.durableRecord(
                for: session,
                replacing: existing,
                operationState: operationState,
                cleanupComplete: cleanupComplete,
                cleanupDisposition: cleanupDisposition,
                at: timestamp)
            if let index {
                ledger.sessions[index] = record
            } else {
                ledger.sessions.append(record)
            }
            ledger.sessions.sort { $0.id < $1.id }
        }
        if cleanupComplete {
            lastPersistedDigest.removeValue(forKey: session.id)
        } else {
            lastPersistedDigest[session.id] =
                try? persistenceDigest(for: session, operationState: operationState)
        }
    }

    /// The change-detection key for `persistSession`: the record as it would be written, with
    /// revision and timestamps neutralised.
    private func persistenceDigest(
        for session: AgentSession,
        operationState: DurableSessionOperationState
    ) throws -> Data {
        var record = try durableRecord(
            for: session,
            replacing: nil,
            operationState: operationState,
            cleanupComplete: false,
            cleanupDisposition: nil,
            at: session.createdAt)
        record.revision = 0
        record.updatedAt = session.createdAt
        record.createdAt = session.createdAt
        // JSONEncoder does not order keys deterministically between encodes; a digest built
        // from it would differ for identical records and defeat the whole comparison.
        return try Self.digestEncoder.encode(record)
    }

    private static let digestEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    func durableRecord(
        for session: AgentSession,
        replacing existing: DurableSessionRecord?,
        operationState: DurableSessionOperationState,
        cleanupComplete: Bool,
        cleanupDisposition requestedDisposition: DurableSessionCleanupDisposition?,
        at timestamp: Date
    ) throws -> DurableSessionRecord {
        // Only a destroy states an intent. Every other rewrite of the record (a poll, a
        // heartbeat, a janitor pass) must keep the intent already on file, or a `--keep-apps`
        // teardown followed by a daemon crash would terminate the apps the caller kept.
        let cleanupDisposition = requestedDisposition
            ?? existing?.cleanupDisposition
            ?? .terminateLaunchedApps
        guard let controller = session.controllerSnapshot() else {
            throw SessionStoreError.invalidLedger(
                "live session '\(session.id)' has no controller lease")
        }
        let revision: UInt64
        if let existing {
            guard existing.revision < UInt64.max else {
                throw LiveSessionPersistenceError.recordRevisionExhausted(session.id)
            }
            revision = existing.revision + 1
        } else {
            revision = 1
        }

        let abandonedAt: Date?
        let reclaimableAfter: Date?
        if cleanupComplete {
            let boundary = existing?.abandonedAt ?? controller.abandonedAt ?? timestamp
            abandonedAt = boundary
            reclaimableAfter = existing?.reclaimableAfter
                ?? boundary.addingTimeInterval(controller.gracePeriod)
        } else {
            abandonedAt = controller.abandonedAt
            reclaimableAfter = controller.reclaimableAt
        }

        let durableApps: [DurableSessionApp]
        if cleanupComplete {
            durableApps = []
        } else {
            durableApps = session.apps
                .map { app in
                    DurableSessionApp(
                        identity: app.identity,
                        provenance: app.startedByUs ? .launched : .adopted,
                        bundleIdentifier: app.bundleIdentifier,
                        name: app.name,
                        url: app.url,
                        devToolsPort: app.devToolsPort,
                        temporaryProfile: app.temporaryProfile,
                        temporaryControlRoot: app.temporaryControlRoot)
                }
                .sorted {
                    if $0.identity.pid != $1.identity.pid {
                        return $0.identity.pid < $1.identity.pid
                    }
                    return $0.name < $1.name
                }
        }

        let placement = DurableSessionPlacement(
            displayID: session.stage.displayID,
            x: Double(session.frame.origin.x),
            y: Double(session.frame.origin.y),
            width: Double(session.frame.width),
            height: Double(session.frame.height),
            tileIndex: session.slot.index,
            tileCapacity: session.slot.capacity,
            exclusiveDisplay: session.hasExclusiveDisplay)
        return DurableSessionRecord(
            id: session.id,
            revision: revision,
            createdAt: existing?.createdAt ?? session.createdAt,
            updatedAt: max(
                timestamp,
                existing?.updatedAt ?? existing?.createdAt ?? session.createdAt),
            ownershipState: abandonedAt == nil ? .owned : .abandoned,
            runtimeState: cleanupComplete ? .detached : .attached,
            operationState: operationState,
            recoveryState: cleanupComplete
                ? .notNeeded
                : (controller.reclaimable ? .reclaimable : .notNeeded),
            recoveryBlockers: [],
            abandonedAt: abandonedAt,
            reclaimableAfter: reclaimableAfter,
            lastActivityAt: controller.lastActivityAt,
            owner: controller.owner,
            lease: controller.lease,
            lastKnownPlacement: placement,
            apps: durableApps,
            cleanupDisposition: cleanupDisposition,
            title: session.annotationSnapshot().title,
            colorTag: session.annotationSnapshot().colorTag)
    }

    private func pruneDurableSession(_ id: String) throws {
        guard let livePersistence else { return }
        try livePersistence.update(
            writerDaemonInstanceID: daemonInstanceID,
            at: reclamationPolicy.now(),
            nextAutomaticSessionNumberAtLeast: max(1, counter + 1)
        ) { ledger in
            guard let index = ledger.sessions.firstIndex(where: { $0.id == id }) else {
                return
            }
            guard ledger.sessions[index].operationState == .cleanupComplete else {
                throw SessionStoreError.invalidLedger(
                    "session '\(id)' cannot be pruned before cleanup completes")
            }
            ledger.sessions.remove(at: index)
        }
    }

    /// Record a newly materialized process identity before any later response work. If that first
    /// post-effect write fails, undo the registration where possible; otherwise retain in-memory
    /// ownership and retry the pending record so restart cleanup has the exact identity.
    ///
    /// Reconciliation is bounded and cancellation-aware. This runs with the operation gate held,
    /// so a rollback and a commit that both fail permanently must surface an error rather than
    /// retry forever and starve every later request, including daemon shutdown.
    func recordPostEffectOrRollback(
        session: AgentSession,
        app: LaunchedApp
    ) async throws {
        try await DurablePostEffectReconciliation.run(
            commitPendingIdentity: {
                try self.persistSession(session, operationState: .mutationPending)
            },
            rollbackEffect: {
                session.rollbackUndurableApp(app)
            },
            clearPreparedMarker: {
                try self.persistSession(session, operationState: .ready)
            })
    }

    /// A prior daemon's exact process ledger remains exclusive during restart grace. Otherwise a
    /// new session could adopt that process and the detached janitor would later terminate it
    /// under its original launched provenance.
    func ensureNotReservedForDetachedRecovery(pid: pid_t) throws {
        guard let recoveryCoordinator,
              let current = ProcessIdentity.current(of: pid) else {
            return
        }
        for record in try recoveryCoordinator.detachedRecords() {
            guard let reserved = record.apps.first(where: {
                $0.identity.pid == pid
                    && (!$0.identity.isPrecise
                        || !current.isPrecise
                        || $0.identity == current)
            }) else {
                continue
            }
            let ownership = reserved.provenance == .launched
                ? "launched"
                : "adopted"
            throw SpaceOError.badRequest(
                "process \(current) remains reserved by detached session "
                    + "'\(record.id)' as a \(ownership) app; wait for its recovery grace "
                    + "or destroy session '\(record.id)' "
                    + "(spaceo_session_destroy / spaceo session destroy --session \(record.id))")
        }
    }

    static func detachedRecoveryGuidance(
        records: [DurableSessionRecord]
    ) -> String {
        var lines = [
            "detached session cleanup is not complete; no persisted display or window handle "
                + "was reused."
        ]
        for record in records.sorted(by: { $0.id < $1.id }) {
            var detail = "  \(record.id): \(record.recoveryState.rawValue)"
            if let boundary = record.reclaimableAfter {
                detail += ", grace ends \(boundary.ISO8601Format())"
            }
            lines.append(detail)
            for blocker in record.recoveryBlockers {
                lines.append("    - \(blocker.code): \(blocker.message)")
            }
        }
        lines.append(
            "Wait for the recorded grace boundary, then retry the named destroy command. "
                + "SpaceO will terminate only exact launched process identities; adopted apps "
                + "are released without termination.")
        return lines.joined(separator: "\n")
    }

    public func destroy(_ id: String, quitApps: Bool) async throws -> TeardownReport {
        var request = Request(cmd: "session.destroy")
        request.session = id
        request.quitApps = quitApps
        request.operatorScope = true
        _ = try await executeResponsiveDestroy(request)
        return TeardownReport()
    }

    /// The summary is nil exactly when the report is incomplete: nothing ended yet.
    private func destroyNow(
        _ id: String,
        quitApps: Bool,
        reason: String
    ) throws -> (report: TeardownReport, summary: DestroySummary?) {
        try hostHealthCheck()
        let started = Date()
        let canonical = try Self.canonicalSessionID(id)
        guard let session = sessions[canonical] else {
            throw SpaceOError.unknownSession(canonical)
        }
        let effectiveQuitApps = canonical == "personal-agent-workspace" ? false : quitApps
        // Persist intent before signalling or evacuating any process. A crash after this point is
        // recoverable as cleanup work, never mistaken for a ready attached session.
        let cleanupDisposition: DurableSessionCleanupDisposition = effectiveQuitApps
            ? .terminateLaunchedApps
            : .releaseApps
        try persistSession(
            session,
            operationState: .cleanupPending,
            cleanupDisposition: cleanupDisposition)
        var report = session.destroy(quitApps: effectiveQuitApps)
        guard report.isComplete else {
            report.stillAttachedDisplayIDs = Array(
                Set(report.stillAttachedDisplayIDs + [session.stage.displayID])
            ).sorted()
            try persistSession(
                session,
                operationState: .cleanupPending,
                cleanupDisposition: cleanupDisposition)
            return (report, nil)
        }

        // Commit proof of an empty app ledger before releasing the manager's live ownership.
        // Pruning is a distinct later atomic replacement so a failed prune leaves a safe
        // cleanup-complete tombstone for restart.
        try persistSession(
            session,
            operationState: .cleanupComplete,
            cleanupComplete: true,
            cleanupDisposition: cleanupDisposition)
        _ = pool.release(session.slot, retainEmpty: true)
        sessions.removeValue(forKey: canonical)
        lastPersistedDigest.removeValue(forKey: canonical)
        recordingFailureWarnings.removeValue(forKey: canonical)
        let summary = concludeDestroy(session, reason: reason, started: started)
        scheduleIdleDisplayRetirement()
        try pruneDurableSession(canonical)
        announceDestroyed(canonical, summary: summary)
        return (report, summary)
    }

    @discardableResult
    public func destroyAll(quitApps: Bool) async throws -> TeardownReport {
        let commandLease = try await operationGate.enter()
        defer { commandLease.finish() }
        try await waitForInFlightTeardowns(before: "destroyAll")
        return try destroyAllNow(quitApps: quitApps)
    }

    /// Wait for named teardown workers to finalize before a whole-daemon operation.
    ///
    /// Workers finalize on the actor without taking the command gate, so a caller that holds
    /// the gate can wait here: every sleep is a suspension point at which a returning worker's
    /// continuation runs. `destroyAllNow` cannot simply include such a session — it would block
    /// on the session's teardown lock and then finalize a slot the worker also finalizes.
    /// Bounded so a wedged worker leaves the operator with an error rather than a hang.
    static let inFlightTeardownWaitLimit: Duration = .seconds(45)

    func waitForInFlightTeardowns(before action: String) async throws {
        let deadline = ContinuousClock.now + Self.inFlightTeardownWaitLimit
        while !destroyingSessionIDs.isEmpty {
            guard ContinuousClock.now < deadline else {
                throw SpaceOError.badRequest(
                    "session teardown is still in progress for "
                        + destroyingSessionIDs.sorted().joined(separator: ", ")
                        + "; retry \(action) after it finishes")
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func destroyAllNow(quitApps: Bool, reason: String = "operator") throws -> TeardownReport {
        if pool.displayCount > 0 { try hostHealthCheck() }
        idleDisplayRetirement?.cancel()
        idleDisplayRetirement = nil
        var report = TeardownReport()
        for id in sessions.keys.sorted() {
            guard sessions[id] != nil else { continue }
            let sessionReport = try destroyNow(id, quitApps: id == "personal-agent-workspace" ? false : quitApps, reason: reason).report
            report.merge(sessionReport)
        }
        // Sessions with surviving processes still own their slots. Only empty displays may be
        // retired; direct `DisplayPool.releaseAll()` deliberately has stronger force-release
        // semantics for callers that have already destroyed their own session objects.
        let attachedDisplayIDs = pool.retireEmptyDisplays()
        report.stillAttachedDisplayIDs = Array(
            Set(report.stillAttachedDisplayIDs).union(attachedDisplayIDs)
                .union(Stage.runtimeDisplaySafetyStatus()?.deferredRetirementDisplayIDs ?? [])
        ).sorted()
        displayLifecycleFailures.formUnion(attachedDisplayIDs)
        return report
    }

    func scheduleIdleDisplayRetirement() {
        idleDisplayRetirement?.cancel()
        let delay = idleDisplayGraceNanoseconds
        idleDisplayRetirement = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.retireIdleDisplays()
        }
    }

    private func retireIdleDisplays() {
        // A failed health check retains owners instead of triggering more graph changes.
        guard (try? hostHealthCheck()) != nil else { return }
        displayLifecycleFailures.formUnion(pool.retireEmptyDisplays(keeping: retainedIdleDisplayCount))
        idleDisplayRetirement = nil
    }

    /// Recorded teardown failures, pruned against the live display inventory. A teardown that
    /// timed out may still have completed later; keep reporting and refusing only while the
    /// display is genuinely attached, because claiming a detached display "remains attached"
    /// forever would be false. Every reader must come through here so they agree.
    private func liveDisplayLifecycleFailures() -> Set<CGDirectDisplayID> {
        guard !displayLifecycleFailures.isEmpty else { return [] }
        // A Stage deadline already established that the server cannot be trusted. Re-querying
        // synchronously here would immediately undo containment and could erase unknown IDs.
        guard !pool.stages.contains(where: \.hasLifecycleFailure) else {
            return displayLifecycleFailures
        }
        displayLifecycleFailures.formIntersection(onlineDisplayIDs())
        return displayLifecycleFailures
    }

    public func infos() async throws -> [SessionInfo] {
        let commandLease = try await operationGate.enter()
        defer { commandLease.finish() }
        return try infosNow()
    }

    /// One listing refreshes every session under this shared budget, so an accessibility outage
    /// across many sessions cannot hold the operation gate for each session's discovery timeout.
    /// Each refresh gets a fair share of what remains, so a slow early session cannot starve
    /// the ones after it on every listing.
    static let sessionListRefreshBudget: TimeInterval = 4

    private func infosNow() throws -> [SessionInfo] {
        var infos: [SessionInfo] = []
        let healthy = (try? hostHealthCheck()) != nil
        let refreshDeadline = waitRuntime.now().addingTimeInterval(Self.sessionListRefreshBudget)
        let ordered = sessions.values.sorted(by: { $0.createdAt < $1.createdAt })
        for (position, session) in ordered.enumerated() {
            if !healthy {
                if let snapshot = destroyingSessionSnapshots[session.id] {
                    infos.append(snapshot)
                } else if !destroyingSessionIDs.contains(session.id) {
                    var info = SessionInfo(session, includeLiveGeometry: false)
                    info.lifecycleReason = "host_health_blocked"
                    infos.append(info)
                }
                continue
            }
            // A destroying session is already represented by its durable cleanup-pending
            // record. Do not race its mutable app/window ledger merely to include a transient
            // live row while teardown runs on a worker.
            guard let lifecycleLease = try? session.beginOperation() else {
                if let snapshot = destroyingSessionSnapshots[session.id] {
                    infos.append(snapshot)
                    continue
                }
                // Once an incomplete worker has returned, its terminal lifecycle is stable and
                // the retained ledger must stay visible so an operator can retry cleanup.
                guard !destroyingSessionIDs.contains(session.id) else { continue }
                let info = SessionInfo(session)
                try persistSession(session, operationState: .cleanupPending)
                infos.append(info)
                continue
            }
            do {
                // One app's incomplete discovery must not fail every client's listing (#47).
                // The failed refresh preserved the last-known ledger, and the row reports why
                // it is not a fresh observation; commands still refuse on the throwing refresh.
                // A skipped refresh never reaches discovery's own cancellation checks.
                if Task.isCancelled { throw CancellationError() }
                let remaining = refreshDeadline.timeIntervalSince(waitRuntime.now())
                let share = remaining / Double(ordered.count - position)
                let refreshed = share >= 0.01
                if refreshed {
                    do { _ = try session.refreshWindowsChecked(remaining: share) }
                    catch let stopped as AXTraversalStopped where stopped.reason == .cancelled { throw stopped }
                    catch is CancellationError { throw CancellationError() }
                    catch { /* Reported on the row; the ledger kept its last-known windows. */ }
                }
                var info = SessionInfo(session, lastKnownWindows: !refreshed)
                if !refreshed, info.windowDiscoveryFailure == nil {
                    info.windowDiscoveryFailure = "not refreshed: this listing's shared discovery budget was exhausted"
                }
                try persistSession(
                    session,
                    operationState: session.teardownPending ? .cleanupPending : .ready)
                infos.append(info)
            } catch {
                lifecycleLease.finish()
                throw error
            }
            lifecycleLease.finish()
        }
        if let recoveryCoordinator {
            infos.append(contentsOf: try recoveryCoordinator.detachedRecords().map {
                SessionInfo($0)
            })
        }
        return infos.sorted {
            if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
            return $0.id < $1.id
        }
    }

    // MARK: - Command dispatch

    public func handle(_ request: Request) async -> Response {
        let response = await handleNow(request)
        noteOwnerActivity(for: request)
        return response
    }

    private func handleNow(_ request: Request) async -> Response {
        do {
            if request.cmd == "session.destroy", request.full != true {
                return try await executeResponsiveDestroy(request)
            }
            if request.cmd == "steps.run" {
                return try await runSteps(request)
            }
            if request.cmd == "wait" {
                // Probes and finalization enter the gate independently; sleeping never holds it.
                return try await executeWait(request)
            }
            let commandLease = try await operationGate.enter()
            defer { commandLease.finish() }
            if isShuttingDown, request.cmd != "daemon.stop" {
                throw SpaceOError.daemonStopping
            }
            return await executeCommandWithEvidence(request)
        } catch {
            return failureResponse(error, request: request)
        }
    }

    func requireHostHealth(for request: Request) throws {
        let passive: Set<String> = ["ping", "pool", "session.list", "logging.status", "logging.enable", "logging.disable"]
        if passive.contains(request.cmd) { return }
        if request.cmd == "daemon.stop", pool.displayCount == 0 { return }
        try hostHealthCheck()
    }

    func preflightEvidence(_ request: Request) throws {
        try requireHostHealth(for: request)
        if request.cmd == "screenshot", request.memory == true, request.output != nil {
            throw SpaceOError.badRequest("memory capture and output export are mutually exclusive")
        }
        if let timeout = request.timeout {
            // A drain deadline is an operator's patience, not a command timeout: it may run to
            // an hour while agents finish. Every other command keeps the two-minute bound.
            let upper: Double = request.cmd == "daemon.drain" ? 3_600 : 120
            guard timeout.isFinite, (0.5...upper).contains(timeout) else {
                throw SpaceOError.badRequest("timeout must be from 0.5 through \(Int(upper)) seconds")
            }
        }
        if let duration = request.duration {
            guard request.cmd == "drag", duration.isFinite, (0.05...30).contains(duration) else {
                throw SpaceOError.badRequest("duration is supported for drag, from 0.05 through 30 seconds")
            }
        }
        if let required = request.requiredIsolation, required.isEmpty || required.count > 6 {
            throw SpaceOError.badRequest("require-isolation needs 1 through 6 dimensions")
        }
        guard request.strictIsolation == true || request.requiredIsolation != nil || request.snapshotID != nil || request.geometryToken != nil else { return }
        let session = try resolveForRead(request.session, leaseID: request.controllerLeaseID)
        if request.strictIsolation == true || request.requiredIsolation != nil, request.cmd != "verify" {
            let required = request.strictIsolation == true ? IsolationDimension.allCases : request.requiredIsolation ?? []
            guard VerificationAssertion(required: required, report: isolationPreflight()).satisfied else {
                throw SpaceOError.isolationUnverified("required isolation dimensions lack observed passing evidence; no action was attempted")
            }
        }
        if let snapshot = request.snapshotID {
            guard request.cmd == "click", request.element != nil,
                  session.lastSnapshot?.generation.uuidString.lowercased() == snapshot.lowercased() else {
                throw SpaceOError.staleSnapshot("snapshot changed or is unavailable; read the screen again")
            }
        }
        if let token = request.geometryToken {
            let window = try session.resolveWindow(request.window)
            guard geometry(session, window: window).token == token else {
                throw SpaceOError.staleGeometry("window/display geometry changed; refresh windows or screenshot before input")
            }
        }
    }

    func requireNoKnownIsolationBreach(_ session: AgentSession) throws {
        if isolationPreflight()?.verdict == .breached {
            try session.setAgentInputPaused(true, byOperator: false)
            throw SpaceOError.isolationBreached("known global focus/Space breach; input paused before action; resolve the breach and explicitly resume")
        }
    }

    func geometry(_ session: AgentSession, window: WindowRef) -> GeometryReceipt {
        GeometryReceipt(sessionGeneration: session.generation, displayID: session.stage.displayID,
                        displayBounds: session.frame, window: window,
                        process: session.apps.first { $0.pid == window.pid }?.identity, backingScale: session.stage.backingScale)
    }

    func actionRoute(_ request: Request, session: AgentSession, target: WindowRef? = nil) -> String {
        if request.cmd == "run" { return "NSWorkspace" }
        if ["adopt", "place", "repark"].contains(request.cmd) { return "accessibility-placement" }
        if request.cmd == "click", request.label != nil { return "accessibility-action" }
        if request.cmd == "click", let element = request.element, !element.hasPrefix("w") { return "accessibility-action" }
        let window = target ?? session.windows.first { $0.windowID == request.window } ?? session.primaryWindow
        if let window, session.webBridge(for: window.pid) != nil { return "chromium-devtools" }
        if let window, session.electronEditorBridge(for: window) != nil,
           ["type", "key", "select", "scroll"].contains(request.cmd) { return "electron-semantic-controller" }
        return "per-pid-events"
    }

    /// The route a keystroke actually took. `actionRoute` answers "chromium-devtools" for any
    /// browser window, which mislabelled native typing into the browser's own UI.
    func keystrokeReceiptRoute(_ route: InputRouter.KeystrokeRoute,
                               session: AgentSession, window: WindowRef) -> String {
        if let devTools = route.receiptRoute { return devTools }
        if session.electronEditorBridge(for: window) != nil { return "electron-semantic-controller" }
        return "per-pid-events"
    }

    /// Apps rewrite typed text — auto-capitalisation, smart quotes and dashes — and the field
    /// then no longer holds what the agent typed. Report it only when the rewrite is evidently
    /// that kind (the text is present once case and typographic substitutions are ignored);
    /// any other mismatch may be a different field, and saying nothing beats a wrong claim.
    static func typedTextAlterationNote(typed: String, fieldValue: String?) -> String? {
        guard let fieldValue, !typed.isEmpty, typed.count <= 2_000, fieldValue.count <= 100_000,
              !fieldValue.contains(typed) else { return nil }
        func folded(_ text: String) -> String {
            var result = text.lowercased()
            for (smart, plain) in [("\u{2018}", "'"), ("\u{2019}", "'"), ("\u{201C}", "\""),
                                   ("\u{201D}", "\""), ("\u{2013}", "-"), ("\u{2014}", "--"),
                                   ("\u{2026}", "...")] {
                result = result.replacingOccurrences(of: smart, with: plain)
            }
            return result
        }
        guard folded(fieldValue).contains(folded(typed)) else { return nil }
        let preview = { (text: String) in text.count > 40 ? String(text.prefix(40)) + "…" : text }
        return "the app changed the typed text (auto-capitalisation or smart substitution): "
            + "typed \"\(preview(typed))\"; verify the field before relying on its exact contents"
    }

    static func automaticWebRouteNote(_ action: String) -> String {
        "\(action) into page content through DevTools because your last click went to a page "
            + "element in this window; pass web=false to address the browser's own UI instead"
    }

    func enrich(_ response: inout Response, request: Request, elapsed: Double,
                includeSessionMetadata: Bool = true, recordingFrames: RecordingFrames? = nil) {
        guard (try? hostHealthCheck()) != nil else { return }
        let candidate = (response.session?.id ?? request.session).flatMap { sessions[$0] }
            ?? (sessions.count == 1 ? sessions.values.first : nil)
            ?? (request.session == nil ? leaseImpliedSession(request.controllerLeaseID) : nil)
        guard let session = candidate,
              session.controllerLeaseCovers(request.controllerLeaseID) || response.controllerLeaseID != nil else { return }
        if let comparison = response.isolation, let current = isolationPreflight() {
            response.isolation = comparison.includingCurrentFailures(current)
            response.drift = response.isolation?.legacyDrift
        }
        if request.strictIsolation == true || request.requiredIsolation != nil {
            let assertion = VerificationAssertion(required: request.strictIsolation == true ? IsolationDimension.allCases : request.requiredIsolation ?? [], report: response.isolation)
            response.verificationAssertion = assertion
            if !assertion.satisfied {
                response.ok = false
                response.errorCode = "isolation_requirements_unmet"
                response.error = "required observed isolation evidence is unavailable: " + assertion.unmetDimensions.map(\.rawValue).joined(separator: ", ")
            }
        }
        if response.isolation?.verdict == .breached {
            response.ok = false
            response.error = response.error ?? "current isolation breach: " + (response.isolation?.failures ?? []).joined(separator: "; ")
            try? session.setAgentInputPaused(true, byOperator: false)
            response.errorCode = "isolation_breached"
            response.nextAction = "resolve_focus_or_placement_then_explicitly_resume"
            response.recovery = SpaceOError.isolationBreached("").recovery?.bound(session: session.id)
            emit("isolation.verdict", session: session.id, ["verdict": "breached", "failures": (response.isolation?.failures ?? []).joined(separator: "; ")])
        }
        if let recovery = response.recovery, recovery.arguments["session"] == nil {
            response.recovery = recovery.bound(session: session.id, window: request.window)
        }
        // Nested receipts omit this metadata; preserve handoff delivery for the outer response.
        if includeSessionMetadata {
            response.displayTarget = DisplayTargetReceipt(identity: session.stage.identity,
                displayID: session.stage.displayID, logicalBounds: session.stage.bounds,
                backingScale: session.stage.backingScale)
            response.geometries = session.windows.map { geometry(session, window: $0) }
            response.readiness = ReadinessReport(applicationCount: session.apps.filter { $0.identity.isAlive }.count,
                windowCount: session.windows.count, attached: !session.teardownPending,
                paused: session.agentInputSnapshot().paused, canDrive: drivingAvailable())
            if let window = session.windows.first(where: { $0.windowID == request.window }) ?? session.primaryWindow {
                response.geometry = geometry(session, window: window)
            }
            if request.cmd == "ax" { response.snapshotID = session.lastSnapshot?.generation.uuidString.lowercased() }
            // The operator's hand-back note rides on the agent's next covered command, exactly once.
            let agentCommands: Set<String> = [
                "ax", "ax.find", "ax.text", "screenshot", "windows", "click", "scroll", "move", "drag",
                "type", "key", "select", "wait", "steps.run", "open.url", "run", "targets", "verify",
                "menu",
            ]
            if request.operatorScope != true, agentCommands.contains(request.cmd),
               let handoff = session.consumeOperatorHandoff() {
                response.handoff = handoff
            }
            // Watcher escapes happen between commands; tell the controller once, on the next
            // response its lease covers, rather than leaving them to an event it may not follow.
            if request.operatorScope != true {
                let notes = session.consumeAmbientNotes()
                if !notes.isEmpty { response.ambient = (response.ambient ?? []) + notes }
            }
        }
        if DaemonCommand.actions.contains(request.cmd) || (request.cmd == "menu" && response.action != nil) {
            // A transport/delivery acknowledgement is not a verified application postcondition.
            // The handler's delivery verdict survives; a response that failed here (isolation
            // requirements, a breach) is refused whatever the handler saw.
            let outcome = Self.receiptOutcome(ok: response.ok, handler: response.action?.outcome,
                                              warnings: response.warnings)
            response.action = ActionReceipt(command: request.cmd, windowID: response.action?.windowID,
                route: response.action?.route ?? actionRoute(request, session: session),
                completion: response.ok ? "operation_completed_postcondition_not_asserted" : "failed",
                requestedDuration: request.duration, elapsedSeconds: elapsed, outcome: outcome)
        }
        recordCommandResult(&response, request: request, session: session, frames: recordingFrames)
    }

    /// The receipt's honest verdict, in the event-stream vocabulary. A failed response is
    /// `refused`; otherwise the handler's own verdict stands, and a handler that gave none is
    /// `confirmed` only when it attached no warning that qualifies delivery.
    static func receiptOutcome(ok: Bool, handler: String?, warnings: [String]?) -> String {
        guard ok else { return "refused" }
        if let handler { return handler }
        return (warnings ?? []).isEmpty ? "confirmed" : "unconfirmed"
    }

    /// Fence one live session under the global gate, then release that gate before any blocking
    /// process-exit wait. The actor is reentrant while awaiting the worker, so another session's
    /// commands retain their normal latency throughout teardown.
    private func executeResponsiveDestroy(
        _ request: Request,
        reason: String? = nil,
        requireReclaimable: Bool = false
    ) async throws -> Response {
        let started = Date()
        let commandLease = try await operationGate.enter()
        defer { commandLease.finish() }
        if isShuttingDown {
            commandLease.finish()
            throw SpaceOError.daemonStopping
        }

        try requireHostHealth(for: request)

        // Detached-record cleanup has its own serialized recovery coordinator. Keep that less
        // common path on the existing command boundary; this fast path is for a live session.
        let candidate: AgentSession?
        if let requestedID = request.session {
            let canonicalID = try Self.canonicalSessionID(requestedID)
            candidate = sessions[canonicalID]
        } else if sessions.count == 1 {
            candidate = sessions.values.first
        } else {
            candidate = nil
        }
        guard let session = candidate else {
            if requireReclaimable { throw JanitorReclaimSkipped() }
            return try await execute(request)
        }
        // The janitor decided from a scan taken before it released the gate; a claim may have
        // handed the session to a new controller since. Re-check under the gate.
        if requireReclaimable, session.controllerSnapshot()?.reclaimable != true {
            throw JanitorReclaimSkipped()
        }

        if request.operatorScope != true {
            _ = try resolveForMutation(
                session.id,
                leaseID: request.controllerLeaseID)
        }
        let id = session.id
        guard destroyingSessionIDs.insert(id).inserted else {
            commandLease.finish()
            throw SpaceOError.badRequest("session '\(id)' destruction is already in progress")
        }
        let quitApps = id == "personal-agent-workspace" ? false : (request.quitApps ?? true)
        let cleanupDisposition: DurableSessionCleanupDisposition = quitApps
            ? .terminateLaunchedApps
            : .releaseApps
        do {
            // Crash recovery must learn the cleanup intent before the session becomes terminal.
            try persistSession(
                session,
                operationState: .cleanupPending,
                cleanupDisposition: cleanupDisposition)
            session.prepareForDestroy()
            destroyingSessionSnapshots[id] = SessionInfo(session)
        } catch {
            destroyingSessionIDs.remove(id)
            destroyingSessionSnapshots.removeValue(forKey: id)
            commandLease.finish()
            throw error
        }
        commandLease.finish()

        let report = await Task.detached(priority: nil) {
            session.destroy(quitApps: quitApps)
        }.value
        destroyingSessionIDs.remove(id)
        destroyingSessionSnapshots.removeValue(forKey: id)

        var finalized = report
        guard report.isComplete else {
            finalized.stillAttachedDisplayIDs = Array(
                Set(report.stillAttachedDisplayIDs + [session.stage.displayID])
            ).sorted()
            try persistSession(
                session,
                operationState: .cleanupPending,
                cleanupDisposition: cleanupDisposition)
            throw SpaceOError.teardownIncomplete(finalized)
        }

        try persistSession(
            session,
            operationState: .cleanupComplete,
            cleanupComplete: true,
            cleanupDisposition: cleanupDisposition)
        _ = pool.release(session.slot, retainEmpty: true)
        sessions.removeValue(forKey: id)
        lastPersistedDigest.removeValue(forKey: id)
        recordingFailureWarnings.removeValue(forKey: id)
        let summary = concludeDestroy(
            session,
            reason: reason ?? (request.operatorScope == true ? "operator" : "owner"),
            started: started)
        scheduleIdleDisplayRetirement()
        try pruneDurableSession(id)
        announceDestroyed(id, summary: summary)
        var response = Response.success("destroyed '\(id)'")
        response.destroySummary = summary
        return response
    }

    func execute(_ request: Request) async throws -> Response {
        switch request.cmd {

        case "ping":
            let failures = liveDisplayLifecycleFailures()
            let detachedCount = try recoveryCoordinator?.detachedRecords().count ?? 0
            let suffix = failures.isEmpty
                ? ""
                : ", failed display teardown: \(failures.sorted())"
            return .success(
                "spaceo daemon alive, \(sessions.count) live session(s), "
                    + "\(detachedCount) detached recovery record(s)\(suffix)")

        case "daemon.stop":
            try requireOperatorScope(request, action: "daemon.stop")
            // A named teardown already running finalizes on its own; wait for it rather than
            // refusing. A refused stop is what turns an operator's SIGTERM into a SIGKILL.
            try await waitForInFlightTeardowns(before: "daemon stop")
            var retainedDetachedIDs: [String] = []
            if let recoveryCoordinator {
                let recovery = try recoveryCoordinator.runRecoveryPass()
                let detached = recovery.ledger.sessions.filter {
                    $0.runtimeState == .detached
                }
                if !detached.isEmpty {
                    // An interactive `spaceo daemon stop` is told to wait for the recovery
                    // grace so orphaned apps are reaped now. A process signal cannot wait: the
                    // records are durable and the next daemon recovers them, so the signal
                    // path asks to leave them behind instead of being ignored.
                    guard request.leaveDetachedRecords == true else {
                        throw SpaceOError.badRequest(
                            Self.detachedRecoveryGuidance(records: detached))
                    }
                    retainedDetachedIDs = detached.map(\.id).sorted()
                    DaemonLog.shared.event("daemon.stop.detached-retained", [
                        "sessions": retainedDetachedIDs.joined(separator: ","),
                    ])
                }
            }
            // Quiesce first so nothing races the teardown, but treat that quiescence as
            // provisional: a stop that fails leaves apps and displays alive, so the daemon
            // that still owns them has to keep serving `ping`, `session.list`, and cleanup
            // retries instead of refusing every command until someone `kill -9`s it.
            isShuttingDown = true
            stopJanitor()
            do {
                let report = try destroyAllNow(quitApps: true)
                guard report.isComplete else {
                    throw SpaceOError.teardownIncomplete(report)
                }
            } catch {
                isShuttingDown = false
                if janitorEnabled { startJanitor() }
                throw error
            }
            guard retainedDetachedIDs.isEmpty else {
                return .success(
                    "stopping SpaceO daemon; \(retainedDetachedIDs.count) detached recovery "
                        + "record(s) remain for the next daemon to clean up: "
                        + retainedDetachedIDs.joined(separator: ", "))
            }
            return .success("stopping SpaceO daemon")

        case "session.create":
            // A teardown in flight does not block creation: the destroying session keeps its
            // name in `sessions` and its tile in the pool until its worker finalizes, so a
            // same-name create is refused as "already exists" and any other name allocates a
            // separate tile. Refusing every create for the length of a process-exit wait would
            // stall every other agent on the machine for one agent's slow app.
            // The lease-omitting legacy path is in-process only. A socket client that skips
            // the owner would mint a session every other client may mutate lease-free —
            // silently disabling the coordination fence for everyone sharing the daemon.
            guard request.controllerOwner != nil else {
                throw SpaceOError.badRequest(
                    "session.create needs controllerOwner; pass --controller-id/--controller-"
                        + "label (the CLI and MCP server send one automatically)")
            }
            guard !isDraining else { throw SpaceOError.daemonDraining }
            let preset = request.preset ?? "shared"
            let presetSize = try DisplayPool.presetSize(preset)
            let recordingMode = try RecordingMode.parse(request.record)
            let session = try createNow(
                name: request.session,
                controllerOwner: request.controllerOwner,
                controllerLeaseID: request.controllerLeaseID,
                controllerTTLSeconds: request.controllerTTLSeconds,
                orphanGraceSeconds: request.orphanGraceSeconds,
                exclusive: preset != "shared" ? presetSize : nil)
            do {
                if let title = request.title {
                    try session.annotate(title: title, colorTag: nil)
                }
                if let recordingMode {
                    let root = recordingRootDirectory
                        ?? (try? SessionStore.defaultRootDirectory().deletingLastPathComponent())
                        ?? FileManager.default.temporaryDirectory
                    let recorder = try SessionRecorder(sessionID: session.id, mode: recordingMode, rootDirectory: root)
                    recorders[session.id] = recorder
                    session.setRecordingMode(recordingMode.rawValue)
                }
            } catch {
                var failure = Response.failure(error)
                failure.session = SessionInfo(session)
                failure.controllerLeaseID = session.controllerSnapshot()?.lease.leaseID
                failure.error = "session '\(session.id)' was created (keep its lease), but setup failed: "
                    + (failure.error ?? "unknown failure")
                return failure
            }
            emit("session.created", session: session.id, [
                "display": String(session.stage.displayID),
                "owner": request.controllerOwner?.label ?? "",
                "title": request.title ?? "",
            ])
            var response = Response(ok: true)
            response.session = SessionInfo(session)
            response.controllerLeaseID = session.controllerSnapshot()?.lease.leaseID
            response.message = session.hasExclusiveDisplay
                ? "created '\(session.id)' with exclusive display \(session.stage.displayID)"
                : "created '\(session.id)' on display \(session.stage.displayID), tile \(session.slot.index + 1)/\(session.slot.capacity)"
            if let recordingMode {
                response.message! += "; recording \(recordingMode.rawValue) under \(recorders[session.id]?.directory.path ?? "?")"
            }
            // Create-and-open: the launch runs as its own command so its receipts, isolation
            // bracket and durability are exactly those of a separate `run` call.
            if let app = request.app {
                var run = Request(cmd: "run")
                run.session = session.id
                run.controllerLeaseID = session.controllerSnapshot()?.lease.leaseID
                run.controllerOwner = request.controllerOwner
                run.app = app
                run.files = request.files
                run.timeout = request.timeout
                run.allowNoWindows = request.allowNoWindows
                run.muteAudio = request.muteAudio
                run.diagnosticTraceID = request.diagnosticTraceID
                run.diagnosticRunID = request.diagnosticRunID
                let launched = await executeCommandWithEvidence(run, nested: true)
                response.session = SessionInfo(session)
                response.isolation = launched.isolation
                response.drift = launched.drift
                response.warnings = launched.warnings
                response.action = launched.action
                if launched.ok {
                    response.message! += "\n" + (launched.message ?? "launched \(app)")
                } else {
                    response.ok = false
                    response.errorCode = launched.errorCode ?? "launch_failed"
                    response.error = "session '\(session.id)' was created (keep its lease), but launching \(app) failed: "
                        + (launched.error ?? "unknown failure")
                    response.nextAction = launched.nextAction
                    response.recovery = launched.recovery
                }
            }
            return response

        case "session.list":
            var response = Response(ok: true)
            var infos = try infosNow()
            // Inventory stays open — every client may see what exists and where it is — but
            // another controller's *content* (its apps and window titles) is redacted unless
            // the caller holds that session's lease or explicit operator scope.
            if request.operatorScope != true {
                // Covered by lease, or by declared owner identity — one wire request can
                // carry only one lease, but a connection may hold several sessions under
                // one owner. Spoofable like the operator flag, and equally deliberate.
                let ownerID = request.controllerOwner?.id
                var covered = Set<String>()
                for (id, session) in sessions
                where session.controllerLeaseCovers(request.controllerLeaseID)
                    || (ownerID != nil
                        && session.controllerSnapshot()?.owner.id == ownerID) {
                    covered.insert(id)
                }
                if let recoveryCoordinator {
                    for record in try recoveryCoordinator.detachedRecords()
                    where (record.lease != nil
                            && record.lease?.leaseID == request.controllerLeaseID)
                        || (ownerID != nil && record.owner?.id == ownerID) {
                        covered.insert(record.id)
                    }
                }
                infos = infos.map { info in
                    guard !covered.contains(info.id) else { return info }
                    var redacted = info
                    redacted.apps = []
                    redacted.windows = []
                    redacted.windowDiscoveryFailure = nil
                    redacted.redacted = true
                    return redacted
                }
            }
            response.sessions = infos
            return response

        case "session.heartbeat":
            guard let leaseID = request.controllerLeaseID else {
                throw SpaceOError.badRequest(
                    "session.heartbeat needs controllerLeaseID")
            }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            _ = try session.heartbeatController(leaseID: leaseID)
            try persistSession(session, operationState: .ready)
            var response = Response(ok: true)
            response.session = SessionInfo(session)
            response.controllerLeaseID = leaseID
            response.message = "renewed controller lease for '\(session.id)'"
            return response

        case "session.claim":
            return try claimSession(request)

        case "session.control":
            guard let paused = request.paused else {
                throw SpaceOError.badRequest("session.control needs paused=true or paused=false")
            }
            let session: AgentSession
            if request.operatorScope == true {
                session = try resolve(request.session)
            } else {
                session = try resolveForMutation(
                    request.session,
                    leaseID: request.controllerLeaseID)
            }
            try session.setAgentInputPaused(
                paused,
                byOperator: request.operatorScope == true,
                reason: request.reason,
                handoffNote: request.handoffNote)
            if request.operatorScope != true {
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            }
            emit(paused ? "input.paused" : "input.resumed", session: session.id, [
                "byOperator": String(request.operatorScope == true),
                "reason": request.reason ?? "",
                "handoffNote": request.handoffNote == nil ? "" : "present",
            ])
            var response = Response.success(
                "\(paused ? "paused" : "resumed") agent input for '\(session.id)'"
                    + (paused && request.reason != nil ? " (\(request.reason!))" : "")
                    + (!paused && request.handoffNote != nil ? "; the note will reach the agent on its next command" : ""))
            response.session = SessionInfo(session)
            return response

        case "session.destroy":
            if request.session == nil && (request.full ?? false) {
                try requireOperatorScope(request, action: "session.destroy --all")
                try await waitForInFlightTeardowns(before: "destroy --all")
                let quitApps = request.quitApps ?? true
                if !quitApps, let recoveryCoordinator {
                    let detached = try recoveryCoordinator.detachedRecords()
                    guard detached.isEmpty else {
                        throw SpaceOError.badRequest(
                            "`--keep-apps` cannot be applied to detached recovery records; "
                                + "no prior-daemon window authority remains. Retry named "
                                + "cleanup without `--keep-apps`, or wait for automatic recovery.")
                    }
                }
                let report = try destroyAllNow(
                    quitApps: quitApps,
                    reason: request.operatorScope == true ? "operator" : "owner")
                guard report.isComplete else {
                    throw SpaceOError.teardownIncomplete(report)
                }
                if let recoveryCoordinator {
                    let recovery = try recoveryCoordinator.runRecoveryPass()
                    guard recovery.ledger.sessions.allSatisfy({
                        $0.runtimeState != .detached
                    }) else {
                        throw SpaceOError.badRequest(
                            Self.detachedRecoveryGuidance(
                                records: recovery.ledger.sessions.filter {
                                    $0.runtimeState == .detached
                                }))
                    }
                }
                return .success("destroyed all sessions")
            }
            if let requestedID = request.session,
               let canonicalID = Optional(try Self.canonicalSessionID(requestedID)),
               sessions[canonicalID] == nil,
               let recoveryCoordinator {
                guard request.quitApps ?? true else {
                    throw SpaceOError.badRequest(
                        "`--keep-apps` cannot be applied to detached session "
                            + "'\(canonicalID)'; no prior-daemon window authority remains")
                }
                let result: SessionRecoveryCoordinatorResult
                do {
                    result = try recoveryCoordinator.retryCleanup(sessionID: canonicalID)
                } catch SessionRecoveryCoordinatorError.unknownDetachedSession {
                    // Neither live nor detached. "No detached session" would send the caller
                    // looking for a recovery problem that does not exist.
                    throw SpaceOError.unknownSession(canonicalID)
                }
                guard result.record == nil else {
                    throw SpaceOError.badRequest(
                        Self.detachedRecoveryGuidance(records: [result.record!]))
                }
                if let summary = result.summary {
                    rememberEnded(canonicalID, summary: summary)
                }
                var response = Response.success("cleaned detached session '\(canonicalID)'")
                response.destroySummary = result.summary
                return response
            } else {
                // Operator scope is cross-controller resource reclamation — the same semantics
                // the janitor applies once a session's grace period lapses, and strictly less
                // than `session.destroy --all` already grants the flag. It must not require the
                // (possibly dead) owner's lease, or an abandoned session would be immortal for
                // exactly the person the flag exists for.
                let session: AgentSession
                if request.operatorScope == true {
                    session = try resolve(request.session)
                } else {
                    session = try resolveForMutation(
                        request.session,
                        leaseID: request.controllerLeaseID)
                }
                let id = session.id
                let (report, summary) = try destroyNow(
                    id,
                    quitApps: request.quitApps ?? true,
                    reason: request.operatorScope == true ? "operator" : "owner")
                guard report.isComplete else {
                    throw SpaceOError.teardownIncomplete(report)
                }
                var response = Response.success("destroyed '\(id)'")
                response.destroySummary = summary
                return response
            }

        case "run":
            guard let appName = request.app else { throw SpaceOError.badRequest("run needs an app") }
            let trimmedAppName = appName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedAppName.isEmpty, appName.utf8.count <= 16_384,
                  appName.count <= 4_096 else {
                throw SpaceOError.badRequest(
                    "app must be 1 through 4096 characters and at most 16384 UTF-8 bytes")
            }
            let filePaths = request.files ?? []
            guard filePaths.count <= 256 else {
                throw SpaceOError.badRequest("run accepts at most 256 file paths")
            }
            guard filePaths.allSatisfy({
                $0.utf8.count <= 16_384 && $0.count <= 4_096
            }) else {
                throw SpaceOError.badRequest(
                    "every file path must be at most 4096 characters and 16384 UTF-8 bytes")
            }
            let operatorDriven = request.operatorScope == true
            let session = operatorDriven
                ? try resolve(request.session)
                : try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            // Launching places a new window on the tile a person may be working in — unless the
            // person is the one asking (the Viewer's drop-to-open carries operator scope).
            if !operatorDriven { try session.requireAgentInputAllowed(action: "run") }
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            guard let appURL = AppLauncher.resolve(trimmedAppName) else {
                throw SpaceOError.launchFailed(
                    Self.appNotFoundMessage(trimmedAppName, suggestions: AppLauncher.suggestions(for: trimmedAppName)))
            }
            try LaunchOptions.validate(arguments: request.arguments ?? [], timeout: request.timeout ?? 15)
            if let remote = filePaths.first(where: { $0.hasPrefix("http://") || $0.hasPrefix("https://") }) {
                throw SpaceOError.badRequest(
                    "'\(remote.prefix(80))' is a URL, not a file; use open.url (spaceo_open_url) to navigate the session's browser")
            }
            let files = filePaths.map {
                URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath)
            }
            // Agents retry after errors. A second `open_app` for an app this session already
            // owns must not spawn a second private-profile instance into the same tile.
            if request.newInstance != true,
               let existing = session.apps.first(where: { $0.url.standardizedFileURL == appURL.standardizedFileURL && $0.identity.isAlive }) {
                var response = Response(ok: true)
                response.reused = true
                var message = "\(existing.name) (pid \(existing.pid)) is already running in '\(session.id)'; reused it"
                if !files.isEmpty {
                    if let port = try AppLauncher.reusedBrowserPort(
                        appURL: existing.url, devToolsPort: existing.devToolsPort) {
                        // Use a separate browser-level connection so the retained page binding
                        // is unchanged. Failure is explicit and never falls back to activation.
                        let browser = ChromiumBridge(port: port)
                        do {
                            try await browser.createBackgroundPages(
                                files: files, region: session.frame, timeout: request.timeout ?? 15,
                                reportPartialCompletion: true,
                                validate: {
                                    guard existing.identity.isAlive else {
                                        throw SpaceOError.applicationExited("reused browser exited")
                                    }
                                })
                            message += " and opened \(files.count) background page(s)"
                        } catch {
                            throw AppLauncher.launchFailure(error, application: existing.name)
                        }
                    } else {
                        let configuration = NSWorkspace.OpenConfiguration()
                        configuration.activates = false
                        configuration.addsToRecentItems = false
                        configuration.promptsUserIfNeeded = false
                        do {
                            _ = try await NSWorkspace.shared.open(files, withApplicationAt: appURL, configuration: configuration)
                            message += " and asked it to open \(files.count) file(s)"
                        } catch {
                            response.warnings = ["the running instance did not confirm opening the files: \(error.localizedDescription)"]
                        }
                    }
                }
                message += "; pass new_instance=true to launch another instance"
                session.refreshWindows()
                if let failure = session.windowRefreshFailure {
                    response.warnings = (response.warnings ?? []) + ["window discovery is incomplete: \(failure)"]
                }
                response.message = message
                response.session = SessionInfo(session)
                response.windows = session.windows.filter { $0.pid == existing.pid }.map { WindowInfo($0, session: session) }
                if !operatorDriven { try renewAfterSuccessfulMutation(session, leaseID: request.controllerLeaseID) }
                return response
            }
            // Durable prepare precedes process launch. The materialization callback below then
            // commits the exact identity before DevTools discovery or window placement waits.
            try persistSession(session, operationState: .mutationPending)
            let before = IsolationSnapshot.capture()
            let appsBeforeLaunch = Set(session.apps.map(\.identity))
            let app: LaunchedApp
            do {
                app = try await sessionLauncher.launch(
                    session: session,
                    appURL: appURL,
                    files: files,
                    timeout: request.timeout ?? 15,
                    allowNoWindows: request.allowNoWindows ?? false,
                    arguments: request.arguments ?? [],
                    muteAudio: request.muteAudio ?? false,
                    onMaterialized: { materialized in
                        try await self.recordPostEffectOrRollback(
                            session: session,
                            app: materialized)
                    })
            } catch {
                let mutationError = error
                _ = session.reapExitedApps()
                let hasMaterializedSurvivor = session.apps.contains {
                    !appsBeforeLaunch.contains($0.identity)
                }
                // A pre-materialization failure has no effect and may clear the prepare. Once an
                // identity was registered, keep cleanup-only state until the survivor is gone.
                try persistSession(
                    session,
                    operationState: hasMaterializedSurvivor
                        ? .mutationPending
                        : .ready)
                throw mutationError
            }
            let after = IsolationSnapshot.capture()

            var response = Response(ok: true)
            response.isolation = after.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = after.ambientChanges(from: before)
            var message = "launched \(app.name) (pid \(app.pid)) onto '\(session.id)'"
            if let restored = session.lastLaunchRestoredFocus {
                message += "\n  note: \(app.name) grabbed focus on startup; handed it back to \(restored)"
            }
            response.message = message
            failOnIsolationBreach(&response, action: "launch", before: before)
            emit("app.launched", session: session.id, [
                "app": app.name, "pid": String(app.pid), "ok": String(response.ok),
            ])
            if response.ok {
                if !operatorDriven {
                    try renewAfterSuccessfulMutation(session, leaseID: request.controllerLeaseID)
                } else {
                    try persistSession(session, operationState: .ready)
                }
                response.session = SessionInfo(session)
            } else {
                // Isolation failure changes the command result, not the fact that an app was
                // launched and is now owned by this session.
                try persistSession(session, operationState: .ready)
            }
            return response

        case "adopt":
            guard let pid = request.pid, pid > 0 else {
                throw SpaceOError.badRequest("adopt needs a positive --pid")
            }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: "adopt")
            try requireNoKnownIsolationBreach(session)
            try ensureNotReservedForDetachedRecovery(pid: pid)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            try persistSession(session, operationState: .mutationPending)
            let before = IsolationSnapshot.capture()
            let app: LaunchedApp
            do {
                app = try session.adopt(pid: pid, allowNoWindows: request.allowNoWindows ?? false)
            } catch {
                let mutationError = error
                try persistSession(session, operationState: .ready)
                throw mutationError
            }
            try await recordPostEffectOrRollback(session: session, app: app)
            try renewAfterSuccessfulMutation(
                session,
                leaseID: request.controllerLeaseID)
            var response = Response(ok: true)
            response.session = SessionInfo(session)
            response.message = "adopted \(app.name) (pid \(pid))"
            response.isolation = IsolationSnapshot.capture().report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            failOnIsolationBreach(&response, action: "adopt", before: before)
            return response

        case "place":
            let session = try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: "place")
            try requireNoKnownIsolationBreach(session)
            guard let policy = WindowPlacement.Policy(rawValue: request.placement ?? "preserve") else {
                throw SpaceOError.badRequest("placement must be preserve, fit or cover")
            }
            guard policy != .cover || session.hasExclusiveDisplay else {
                throw SpaceOError.badRequest("cover requires an exclusive display")
            }
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            let target = WindowPlacement.targetFrame(for: window.frame, in: session.frame, policy: policy)
            let before = IsolationSnapshot.capture()
            _ = try WindowPlacement.move(window, to: target)
            let actual = try WindowPlacement.liveBounds(of: window.windowID)
            let edges = WindowPlacement.overflowEdges(actual, outside: session.frame)
            let exact = abs(target.minX - actual.minX) <= 2 && abs(target.minY - actual.minY) <= 2
                && abs(target.width - actual.width) <= 2 && abs(target.height - actual.height) <= 2
            var response = Response(ok: edges.isEmpty && (policy != .cover || exact))
            response.placement = PlacementReceipt(policy: policy.rawValue, requested: target,
                observed: actual, overflowEdges: edges, exactFrameMatched: exact)
            if !response.ok {
                response.errorCode = "placement_rejected"
                response.error = "application did not accept the requested frame; inspect placement receipt"
            }
            response.isolation = IsolationSnapshot.capture().report(comparedTo: before)
            failOnIsolationBreach(&response, action: "place", before: before)
            session.refreshWindows()
            if let failure = session.windowRefreshFailure {
                response.warnings = (response.warnings ?? []) + ["window discovery is incomplete: \(failure)"]
            }
            if response.ok { try renewAfterSuccessfulMutation(session, leaseID: request.controllerLeaseID) }
            return response

        case "windows":
            let session = try resolveForRead(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            if let pid = request.pid {
                guard pid > 0, session.apps.contains(where: { $0.pid == pid }) else {
                    throw SpaceOError.badRequest("window wait pid must belong to this session")
                }
            }
            func matches(_ window: WindowRef) -> Bool { request.pid == nil || window.pid == request.pid }
            let found: [WindowRef]
            if let timeout = request.timeout {
                guard let ready: [WindowRef] = try await WindowReadiness.wait(
                    timeout: timeout, pollNanoseconds: 100_000_000, runtime: waitRuntime,
                    validate: {
                        guard session.apps.contains(where: {
                            $0.identity.isAlive && (request.pid == nil || $0.pid == request.pid)
                        }) else {
                            // Name what exited (or that nothing was ever attached) rather than
                            // a generic refusal the agent cannot act on.
                            if request.pid == nil { throw session.missingWindowError() }
                            throw SpaceOError.applicationExited("no live attached process remains; launch or adopt an app")
                        }
                    }, probe: { remaining in
                        let windows = try session.refreshWindowsChecked(remaining: remaining)
                        return windows.contains(where: matches) ? windows : nil
                    }) else {
                    throw SpaceOError.windowNotReady("no matching window was confirmed before the window-wait deadline; retry the bounded wait")
                }
                found = ready
            } else {
                found = try session.refreshWindowsChecked()
            }
            // One bounded focus read per owning app, so the listing marks which window takes
            // keystrokes, which one is a blocking dialog, and which one `window`-less commands use.
            session.refreshFocusObservations()
            var response = Response(ok: true)
            response.windows = found.filter(matches).map { WindowInfo($0, session: session) }
            return response

        case "pool":
            var response = Response(ok: true)
            response.displays = pool.report()
            response.sessionsPerDisplay = pool.sessionsPerDisplay
            let usage = pool.usage()
            response.usage = usage
            response.limits = ResourceLimitsReport(pool.budget)
            response.message = Self.poolSummary(displays: pool.displayCount,
                                                sessions: pool.sessionCount,
                                                perDisplay: pool.sessionsPerDisplay,
                                                usage: usage,
                                                budget: pool.budget)
            return response

        case "pool.trim":
            guard request.operatorScope == true else {
                throw SpaceOError.badRequest("pool.trim changes the shared display pool; pass --operator")
            }
            let failed = pool.retireEmptyDisplays()
            displayLifecycleFailures.formUnion(failed)
            guard failed.isEmpty else {
                throw SpaceOError.stageCreationFailed("idle display removal was not confirmed; retain the daemon and inspect display safety")
            }
            var response = Response.success("retired idle displays; active sessions retained")
            response.displays = pool.report()
            response.usage = pool.usage()
            return response

        case "pool.configure":
            // Density is one shared knob for every controller's future displays; only the
            // operator changes it, whether or not sessions currently exist.
            guard request.operatorScope == true else {
                throw SpaceOError.badRequest(
                    "pool.configure changes the shared display layout for every controller; "
                        + "pass --operator to confirm operator scope")
            }
            guard let value = request.count else {
                throw SpaceOError.badRequest("pool.configure needs a session count")
            }
            try setSessionsPerDisplay(value)
            var response = Response(ok: true)
            response.message = "new displays will host \(value) session(s) each"
            response.displays = pool.report()
            response.sessionsPerDisplay = pool.sessionsPerDisplay
            response.usage = pool.usage()
            response.limits = ResourceLimitsReport(pool.budget)
            return response

        case "pool.remove":
            // Removing a display ends every session on it, whoever runs them: the same
            // cross-controller reach as `session.destroy --all`, so it needs the same scope.
            guard request.operatorScope == true else {
                throw SpaceOError.badRequest(
                    "pool.remove ends every session on the display for every controller; "
                        + "pass --operator to confirm operator scope")
            }
            guard let displayID = request.display else {
                throw SpaceOError.badRequest(
                    "pool.remove needs a display id; `spaceo pool` lists them")
            }
            guard pool.report().contains(where: { $0.displayID == displayID }) else {
                throw SpaceOError.badRequest(
                    "display \(displayID) is not a SpaceO virtual display; `spaceo pool` lists them")
            }
            try await waitForInFlightTeardowns(before: "pool.remove")
            let tenants = sessions.values
                .filter { $0.stage.displayID == displayID }
                .map(\.id)
                .sorted()
            var report = TeardownReport()
            for id in tenants where sessions[id] != nil {
                report.merge(try destroyNow(
                    id, quitApps: request.quitApps ?? true, reason: "operator").report)
            }
            guard report.isComplete else {
                throw SpaceOError.teardownIncomplete(report)
            }
            guard pool.retireDisplay(displayID) != false else {
                displayLifecycleFailures.insert(displayID)
                throw SpaceOError.badRequest(
                    "display \(displayID) did not detach; its sessions ended. Retry "
                        + "`spaceo pool remove \(displayID) --operator`, or `spaceo daemon stop`.")
            }
            var response = Response.success(
                "removed display \(displayID)"
                    + (tenants.isEmpty ? "" : "; ended \(tenants.joined(separator: ", "))"))
            response.displays = pool.report()
            response.sessionsPerDisplay = pool.sessionsPerDisplay
            response.usage = pool.usage()
            return response

        case "targets":
            let session = try resolveForRead(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            guard let bridge = session.webBridge(for: window.pid) else {
                throw SpaceOError.unsupportedTarget(
                    "window \(window.windowID) has no SpaceO-managed Chromium DevTools bridge")
            }
            let targets = try await bridge.targets()
            let bound = await bridge.boundTargetID
            var response = Response(ok: true)
            response.message = "\(targets.count) Chromium page target(s) for window \(window.windowID)"
            response.outline = targets.isEmpty
                ? "no page targets"
                : targets.map { target in
                    let marker = target.id == bound ? "*" : " "
                    let title = Self.singleLine(target.title.isEmpty ? "(untitled)" : target.title)
                    let url = Self.singleLine(target.url)
                    return "\(marker) \(target.id) — \(title) — \(url)"
                }.joined(separator: "\n")
            return response

        case "target.attach":
            guard let targetID = request.target else {
                throw SpaceOError.badRequest("target.attach needs a target id")
            }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            guard let bridge = session.webBridge(for: window.pid) else {
                throw SpaceOError.unsupportedTarget(
                    "window \(window.windowID) has no SpaceO-managed Chromium DevTools bridge")
            }
            let target = try await bridge.attach(toTargetID: targetID)
            try renewAfterSuccessfulMutation(
                session,
                leaseID: request.controllerLeaseID)
            return .success(
                "attached Chromium window \(window.windowID) to target \(target.id): "
                    + Self.singleLine(target.title.isEmpty ? target.url : target.title))

        case "ax":
            let session = try resolveForRead(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            let snapshot = try session.snapshotAX(window: window)
            let snapshotID = snapshot.generation.uuidString.lowercased()
            var outline = ""
            var message = "\(snapshot.actionableCount) actionable element(s) in window \(window.windowID)"
            var response = Response(ok: true)

            // Incremental read (SPAO-207): diff against the snapshot the caller named. Indices
            // are re-issued with every walk, so the diff carries the *new* indices and says so.
            if let since = request.since?.lowercased() {
                if let base = session.axHistory.nodes(for: since, windowID: window.windowID) {
                    let diff = AXSnapshotDiff.diff(base: base, current: snapshot.nodes, baseSnapshotID: since)
                    response.diff = diff
                    var lines: [String] = []
                    if !diff.added.isEmpty { lines.append("added (\(diff.added.count)):"); lines += diff.added.map { "  + " + $0 } }
                    if !diff.removed.isEmpty { lines.append("removed (\(diff.removed.count)):"); lines += diff.removed.map { "  - " + $0 } }
                    if !diff.changed.isEmpty { lines.append("changed (\(diff.changed.count)):"); lines += diff.changed.map { "  ~ " + $0 } }
                    if lines.isEmpty { lines.append("(no changes since snapshot \(since.prefix(8)))") }
                    lines.append("\(diff.unchangedCount) element(s) unchanged. Indices above are from the NEW snapshot; older indices are stale.")
                    outline = lines.joined(separator: "\n")
                    message += "; diff against \(since.prefix(8))"
                } else {
                    response.diff = ScreenDiff(baseSnapshotID: since, added: [], removed: [], changed: [], unchangedCount: 0, baseMissing: true)
                    message += "; diff_base_missing: snapshot \(since.prefix(8)) is no longer cached, returning the full read"
                }
            }
            if response.diff == nil || response.diff?.baseMissing == true {
                outline = snapshot.outline(includeNonActionable: request.full ?? false)
            }
            session.axHistory.remember(snapshotID: snapshotID, windowID: window.windowID, nodes: snapshot.nodes)

            var truncation = snapshot.truncationReport(outline: outline)
            // For a browser we launched, the AX tree only covers the browser's own chrome.
            // The page itself has to come from DevTools, so append it under its own indices.
            if let bridge = session.webBridge(for: window.pid) {
                do {
                    let target = try await bridge.currentTarget()
                    let page = try await bridge.interactiveElementsReport()
                    outline += "\n\npage content for target \(target.id) — "
                        + Self.singleLine(target.title.isEmpty ? target.url : target.title)
                        + " (click these by element index wN):\n" + page.outline
                    message += ", plus \(page.count) page element(s) from target \(target.id)"
                    truncation.shown += page.count
                    if page.truncated {
                        truncation.truncated = true
                        truncation.reason = truncation.reason.map { $0 + "+web_cap" } ?? "web_cap"
                        truncation.hint = "the page has more than 200 interactive elements; use spaceo_find to search it, or scroll"
                    }
                } catch {
                    // Silence here would read as "the page has no elements", which is a lie.
                    outline += "\n\n(page content unavailable: \(error))"
                    truncation.truncated = true
                    truncation.reason = truncation.reason.map { $0 + "+web_unavailable" } ?? "web_unavailable"
                    truncation.hint = "page content could not be read; retry before treating missing page controls as absent"
                }
            }
            response.outline = outline
            response.truncation = truncation
            if truncation.truncated {
                response.truncated = true
                message += "\n  note: this read is INCOMPLETE (\(truncation.reason ?? "truncated")). "
                    + (truncation.hint ?? "")
            }
            message += "\n  " + truncation.footer
            response.message = message
            return response

        case "click":
            if let label = request.label {
                guard !label.isEmpty, label.utf8.count <= AXLabelMatcher.maximumTextBytes,
                      request.element == nil, request.x == nil, request.y == nil,
                      request.web != true, request.snapshotID == nil else {
                    throw SpaceOError.badRequest("label must be an exact accessible name, at most \(AXLabelMatcher.maximumTextBytes) bytes, used without element, snapshot, web or coordinates")
                }
            } else if request.match != nil {
                throw SpaceOError.badRequest("match applies to click by label")
            }
            let labelMatcher = try request.label.map {
                try AXLabelMatcher.parse(text: $0, match: request.match, role: request.role)
            }
            let clickCount = request.count ?? 1
            guard (1...3).contains(clickCount) else {
                throw SpaceOError.badRequest("click count must be from 1 through 3")
            }
            let button = try MouseButton.parse(request.button)
            let modifiers = try ModifierKeys.parse(request.modifiers)
            if let x = request.x, !x.isFinite {
                throw SpaceOError.badRequest("x must be a finite number")
            }
            if let y = request.y, !y.isFinite {
                throw SpaceOError.badRequest("y must be a finite number")
            }
            if let element = request.element,
               element.utf8.count > 128 || element.count > 32 {
                throw SpaceOError.badRequest(
                    "element reference must be at most 32 characters and 128 UTF-8 bytes")
            }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: "click")
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let before = IsolationSnapshot.capture()
            let window = try session.resolveWindow(request.window)
            // Anything that may have reached the app expires the indices. A refusal before
            // delivery (a mistyped index) leaves them valid: expiring them turned one typo into
            // a second, `stale_snapshot`, failure and a forced re-read (seen in the agent journal).
            var nothingDelivered = false
            defer { if !nothingDelivered { session.invalidateAXSnapshot() } }
            var clickWarnings: [String] = []

            if let labelMatcher {
                guard button == .left, clickCount == 1, modifiers.isEmpty else {
                    throw SpaceOError.badRequest("label selection performs a plain Accessibility press")
                }
                let snapshot = try session.snapshotAX(window: window)
                let index = try snapshot.uniqueIndex(matching: labelMatcher)
                let element = try session.element(at: index, for: window)
                try InputRouter.press(element)
            } else if let reference = request.element, reference.hasPrefix("w") {
                // Page element: only DevTools can dispatch a real DOM click.
                guard let index = Int(reference.dropFirst()) else {
                    throw SpaceOError.badRequest("'\(reference)' is not a web element reference")
                }
                guard index >= 0 else {
                    throw SpaceOError.badRequest("web element indices cannot be negative")
                }
                guard modifiers.isEmpty else {
                    throw SpaceOError.badRequest(
                        "modifier-held clicks are not available on web element references; "
                        + "click the element's coordinates instead")
                }
                guard let bridge = session.webBridge(for: window.pid) else {
                    throw SpaceOError.badRequest(
                        "this session has no DevTools element map; click by native element "
                        + "or coordinates instead")
                }
                try await bridge.clickElement(index: index, button: button,
                                              clickCount: clickCount)
            } else if let reference = request.element {
                guard let index = Int(reference) else {
                    throw SpaceOError.badRequest("'\(reference)' is not an element index")
                }
                guard index >= 0 else {
                    throw SpaceOError.badRequest("element indices cannot be negative")
                }
                // An indexed press is an accessibility action, not a pointer event: it has no
                // button, no click count and no modifier state. Accepting those and performing a
                // plain press anyway reported success for an action that never happened — the
                // agent believed it had opened a context menu or extended a selection.
                guard button == .left, clickCount == 1, modifiers.isEmpty else {
                    throw SpaceOError.badRequest(
                        "an element index performs an accessibility press, which cannot carry a "
                        + "button, click count, or modifiers. Read the element's coordinates from "
                        + "a screenshot and click by coordinates for that.")
                }
                let element: AXUIElement
                do {
                    element = try session.element(at: index, for: window)
                } catch {
                    nothingDelivered = true
                    throw error
                }
                try InputRouter.press(element)
            } else if let x = request.x, let y = request.y {
                if let bridge = session.webBridge(for: window.pid) {
                    // Coordinates inside a browser window belong to the page, and synthetic
                    // mouse events never arrive there. Translate into viewport space and let
                    // DevTools dispatch it.
                    // `web` means x/y are already CSS viewport coordinates, matching what
                    // read_screen prints beside each wN element. Previously this flag was
                    // accepted here and silently ignored.
                    let page: CGPoint
                    if request.web == true {
                        page = CGPoint(x: x, y: y)
                    } else {
                        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
                        page = try await bridge.viewportPoint(
                            windowLocal: CGPoint(x: x, y: y), windowOrigin: bounds.origin)
                    }
                    try await bridge.click(x: page.x, y: page.y,
                                           button: button, clickCount: clickCount,
                                           modifiers: modifiers)
                } else {
                    guard request.web != true else {
                        throw SpaceOError.unsupportedTarget(
                            "web clicking requires a SpaceO-managed Chromium DevTools bridge; "
                                + "native per-process input cannot drive Chromium page content")
                    }
                    let delivery = try InputRouter.click(
                        window, at: CGPoint(x: x, y: y),
                        button: button, clickCount: clickCount,
                        modifiers: modifiers)
                    if !delivery.isConfirmed {
                        clickWarnings.append(InputRouter.unverifiedDeliveryNote("click"))
                    }
                }
            } else {
                throw SpaceOError.badRequest("click needs an element index (N, or wN for page elements) or x and y coordinates")
            }
            var response = Response(ok: true)
            response.action = ActionReceipt(command: request.cmd, windowID: window.windowID,
                route: actionRoute(request, session: session, target: window),
                completion: "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
            response.warnings = clickWarnings.isEmpty ? nil : clickWarnings
            let now = IsolationSnapshot.capture()
            response.isolation = now.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = now.ambientChanges(from: before)
            failOnIsolationBreach(&response, action: "click", before: before)
            response.action?.outcome = response.ok
                ? (clickWarnings.isEmpty ? "confirmed" : "unconfirmed") : "refused"
            if response.ok {
                let point: CGPoint? = (request.x != nil && request.y != nil) ? CGPoint(x: request.x!, y: request.y!) : nil
                let outcome = clickWarnings.isEmpty ? "confirmed" : "unconfirmed"
                // A page element, or page coordinates DevTools delivered, now holds focus.
                let pageClick = request.element?.hasPrefix("w") == true
                    || (request.element == nil && request.label == nil
                        && session.webBridge(for: window.pid) != nil)
                session.notePointerFocus(windowID: window.windowID, pid: window.pid, web: pageClick)
                session.recordAgentInputAction(
                    "click", point: point, windowID: window.windowID, outcome: outcome,
                    target: request.label ?? describeTarget(request.element, session: session))
                emit("agent.action", session: session.id, [
                    "cmd": "click", "outcome": outcome, "window": String(window.windowID),
                    "x": point.map { String(Int($0.x)) } ?? "", "y": point.map { String(Int($0.y)) } ?? "",
                    "target": request.label ?? request.element ?? "",
                ])
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            } else {
                session.recordAgentInputAction("click", point: nil, windowID: window.windowID, outcome: "refused", target: request.element)
                emit("isolation.verdict", session: session.id, ["verdict": "breached", "action": "click"])
            }
            return response

        case "scroll", "move", "drag":
            // The three pointer actions share every step except the events they post: same
            // lease, same lifecycle barrier, same window resolution, same isolation bracket.
            let modifiers = try ModifierKeys.parse(request.modifiers)
            let button = try MouseButton.parse(request.button)
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: request.cmd)
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            defer { session.invalidateAXSnapshot() }
            // An element reference resolves to its frame's centre (SPAO-209); a web reference
            // resolves to viewport coordinates, which is what `web` would have meant.
            let resolved = try await resolvePointer(request, session: session, window: window, needsDestination: request.cmd == "drag")
            var request = request
            if resolved.viewportCoordinates { request.web = true }
            if resolved.receipt.source == "element" {
                request.x = Double(resolved.point.x)
                request.y = Double(resolved.point.y)
                request.toX = resolved.destination.map { Double($0.x) }
                request.toY = resolved.destination.map { Double($0.y) }
            }
            let before = IsolationSnapshot.capture()
            let at = resolved.point
            var pointerWarnings: [String] = []

            // A point inside a browser window belongs to the page, and nothing synthetic reaches
            // web content — the renderer drops events the WindowServer did not vouch for, and a
            // page's scroller is not an accessibility scroll bar either. DevTools is the only
            // channel that works, exactly as it already is for clicks.
            if let bridge = session.webBridge(for: window.pid) {
                guard modifiers.isEmpty else {
                    throw SpaceOError.badRequest(
                        "modifier-held pointer actions are not yet dispatched through DevTools; "
                        + "this browser window cannot receive them")
                }
                // `web` means the caller is already speaking CSS viewport coordinates — which is
                // what `read_screen` prints next to every `wN` element. Without this an agent
                // that reads `[w0] button at (70,37)` and passes those numbers straight back
                // lands roughly a browser-chrome's height above what it aimed at.
                let page: CGPoint
                if request.web == true {
                    page = at
                } else {
                    let bounds = try WindowPlacement.liveBounds(of: window.windowID)
                    page = try await bridge.viewportPoint(
                        windowLocal: at, windowOrigin: bounds.origin)
                }
                switch request.cmd {
                case "scroll":
                    // Same validated delta the native path takes, converted to DOM wheel signs
                    // by the type that owns the convention — a page and a native window in one
                    // session must not disagree about which way `--dx 600` goes.
                    let delta = try ScrollDelta(
                        dx: request.dx ?? 0, dy: request.dy ?? 0, ticks: request.ticks ?? 1)
                    try await bridge.scroll(
                        x: page.x, y: page.y,
                        deltaX: delta.domDeltaX, deltaY: delta.domDeltaY,
                        ticks: delta.ticks)
                case "move":
                    try await bridge.move(x: page.x, y: page.y)
                default:
                    guard let toX = request.toX, let toY = request.toY else {
                        throw SpaceOError.badRequest("drag needs destination coordinates (to_x and to_y), or a destination element")
                    }
                    let destination: CGPoint
                    if request.web == true {
                        destination = CGPoint(x: toX, y: toY)
                    } else {
                        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
                        destination = try await bridge.viewportPoint(
                            windowLocal: CGPoint(x: toX, y: toY), windowOrigin: bounds.origin)
                    }
                    try await bridge.drag(
                        fromX: page.x, fromY: page.y,
                        toX: destination.x, toY: destination.y, button: button, duration: request.duration)
                }
            } else {
                switch request.cmd {
                case "scroll":
                    let delta = try ScrollDelta(
                        dx: request.dx ?? 0, dy: request.dy ?? 0, ticks: request.ticks ?? 1)
                    if let editorBridge = session.electronEditorBridge(for: window) {
                        guard modifiers.isEmpty else {
                            throw SpaceOError.badRequest(
                                "modifier-held Electron editor scrolling is unsupported: the "
                                    + "editor's own scroll command carries no modifier state, and "
                                    + "a synthetic modifier-held wheel does not reach this "
                                    + "renderer. Scroll without modifiers, or drive the editor's "
                                    + "own shortcut with press_key.")
                        }
                        guard delta.dx == 0 || delta.dy == 0 else {
                            throw SpaceOError.badRequest(
                                "the semantic Electron editor channel moves one axis at a time; "
                                    + "send the horizontal and vertical parts as separate scrolls")
                        }
                        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
                        let global = try InputRouter.globalPoint(
                            at, in: window, bounds: bounds, what: "scroll")
                        guard AX.textEditor(
                            at: global,
                            in: window.pid,
                            windowID: window.windowID) != nil else {
                            throw SpaceOError.unsupportedTarget(
                                "the Electron control point is not inside the active text editor")
                        }
                        // `editorScroll` acts on whichever pane holds focus, so a split window
                        // has to be addressed by view column. Accessibility supplies the pane
                        // frames; their order supplies the column.
                        let column = try ElectronEditorRouter.column(
                            forPoint: global, pid: window.pid, windowID: window.windowID)
                        if delta.dx != 0 {
                            let reveal = try await editorBridge.revealHorizontally(
                                deltaX: Int(delta.dx), pages: delta.ticks, column: column)
                            pointerWarnings.append(
                                "the editor was asked to reveal column \(reveal.character) of its "
                                    + "longest visible line, but VS Code exposes no horizontal "
                                    + "viewport offset, so SpaceO cannot confirm the view actually "
                                    + "moved. Verify with a screenshot.")
                        } else {
                            try await editorBridge.scroll(
                                deltaY: Int(delta.dy), pages: delta.ticks, column: column)
                        }
                    } else {
                        guard request.web != true else {
                            throw SpaceOError.unsupportedTarget(
                                "web scroll requires a SpaceO-managed Chromium DevTools bridge; "
                                    + "native per-process input cannot drive Chromium page content")
                        }
                        try InputRouter.scroll(
                            window,
                            at: at,
                            delta: delta,
                            modifiers: modifiers)
                    }
                case "move":
                    guard request.web != true else {
                        throw SpaceOError.unsupportedTarget(
                            "web move requires a SpaceO-managed Chromium DevTools bridge; "
                                + "native per-process input cannot drive Chromium page content")
                    }
                    try InputRouter.move(window, to: at, modifiers: modifiers)
                    pointerWarnings.append(InputRouter.unverifiedMotionDeliveryNote("move"))
                default:
                    guard request.web != true else {
                        throw SpaceOError.unsupportedTarget(
                            "web drag requires a SpaceO-managed Chromium DevTools bridge; "
                                + "native per-process input cannot drive Chromium page content")
                    }
                    guard let toX = request.toX, let toY = request.toY else {
                        throw SpaceOError.badRequest("drag needs destination coordinates (to_x and to_y), or a destination element")
                    }
                    try InputRouter.drag(window, from: at, to: CGPoint(x: toX, y: toY),
                                         button: button, modifiers: modifiers, duration: request.duration)
                    pointerWarnings.append(InputRouter.unverifiedMotionDeliveryNote("drag"))
                }
            }

            var response = Response(ok: true)
            response.action = ActionReceipt(command: request.cmd, windowID: window.windowID,
                route: actionRoute(request, session: session, target: window),
                completion: "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
            response.warnings = pointerWarnings.isEmpty ? nil : pointerWarnings
            response.resolvedPoint = resolved.receipt
            let now = IsolationSnapshot.capture()
            response.isolation = now.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = now.ambientChanges(from: before)
            failOnIsolationBreach(&response, action: request.cmd, before: before)
            response.action?.outcome = response.ok
                ? (pointerWarnings.isEmpty ? "confirmed" : "unconfirmed") : "refused"
            if response.ok {
                let outcome = pointerWarnings.isEmpty ? "confirmed" : "unconfirmed"
                if request.cmd == "drag" {
                    // A drag presses and releases, so it moves focus the way a click does.
                    session.notePointerFocus(windowID: window.windowID, pid: window.pid,
                                             web: session.webBridge(for: window.pid) != nil)
                }
                session.recordAgentInputAction(
                    request.cmd, point: resolved.viewportCoordinates ? nil : at, windowID: window.windowID,
                    outcome: outcome, target: describeTarget(resolved.receipt.element, session: session))
                emit("agent.action", session: session.id, [
                    "cmd": request.cmd, "outcome": outcome, "window": String(window.windowID),
                    "x": String(Int(at.x)), "y": String(Int(at.y)),
                ])
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            } else {
                emit("isolation.verdict", session: session.id, ["verdict": "breached", "action": request.cmd])
            }
            return response

        case "type":
            guard let text = request.text else { throw SpaceOError.badRequest("type needs text") }
            // Every Character contains at least one scalar; the scalar cap also bounds characters.
            guard text.utf8.count <= 32_000, text.unicodeScalars.count <= 8_000 else {
                throw SpaceOError.badRequest(
                    "text is too long (maximum 8000 characters/scalars "
                    + "and 32000 UTF-8 bytes)")
            }
            if request.web != true { try InputRouter.validateTyping(text) }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: "type")
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            defer { session.invalidateAXSnapshot() }
            let before = IsolationSnapshot.capture()
            let editorBridge = session.electronEditorBridge(for: window)
            let editorStateBefore = await ElectronEffectConfirmation.before(editorBridge)
            var targetingNote: String?
            var semanticTyping = false
            let selectAll = KeyCombo(keyCode: 0, flags: .maskCommand)
            let returnKey = KeyCombo(keyCode: 36, flags: [])
            let typingRoute = InputRouter.keystrokeRoute(
                web: request.web, windowID: window.windowID, pid: window.pid,
                hasBridge: session.webBridge(for: window.pid) != nil,
                lastPointer: session.lastPointerFocus)
            if typingRoute != .native {
                guard let bridge = session.webBridge(for: window.pid) else {
                    throw SpaceOError.unsupportedTarget(
                        "web typing requires a SpaceO-managed Chromium DevTools bridge; "
                            + "native per-process input cannot drive Chromium page content")
                }
                if request.replace == true { try await bridge.key(selectAll) }
                try await bridge.type(text)
                if request.submit == true { try await bridge.key(returnKey) }
            } else {
                // Refuses before a single keystroke leaves the process when the application
                // would route it to a different one of its windows.
                targetingNote = try requireKeystrokeTarget(window, in: session, action: "type")
                // A declined semantic edit re-proves the same focused target before returning,
                // so the keystroke fallback below is never aimed at a field that moved.
                if editorBridge == nil, let driver = try NativeTextInput.driver(for: window) {
                    semanticTyping = try NativeTextInput.type(text, replace: request.replace == true, driver: driver)
                } else if request.replace == true {
                    throw SpaceOError.unsupportedTarget("replace requires a text selection attributable to the requested window; nothing typed")
                }
                if !semanticTyping {
                    try InputRouter.prepareForInput(window)
                    try InputRouter.type(text, to: window.pid)
                }
                if request.submit == true {
                    if semanticTyping { try InputRouter.prepareForInput(window) }
                    try InputRouter.key(returnKey, to: window.pid)
                }
            }
            // A VS Code-family renderer can swallow synthetic keys without a word. Ask its
            // semantic channel whether the document or selection actually moved.
            let typingNote = await ElectronEffectConfirmation.confirm(
                editorBridge, before: editorStateBefore, action: "typing")
            var response = Response(ok: true)
            response.action = ActionReceipt(command: request.cmd, windowID: window.windowID,
                route: semanticTyping ? "accessibility-text" : keystrokeReceiptRoute(typingRoute, session: session, window: window),
                completion: semanticTyping && request.submit != true ? "postcondition_verified" : "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
            response.warnings = [targetingNote, typingNote].compactMap { $0 }.nilWhenEmpty
            let now = IsolationSnapshot.capture()
            response.isolation = now.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = now.ambientChanges(from: before)
            // Read back the window the caller named, not whatever the application currently
            // considers focused. `resolveWindow` has already pinned the target, and typing is
            // delivered per-pid after a best-effort focus this host cannot verify — so the
            // unqualified app-wide read confirms `type --window A` by printing window B's text
            // whenever the focus attempt did not take, with nothing in the response to say so.
            // The focused element is still the precise answer when the app agrees that our
            // window has focus; when it does not, fall back to reading our own window.
            response.value = AXTree.focusedValue(pid: window.pid, inWindow: window.windowID)
                ?? AXTree.text(in: window)
            response.replaced = request.replace == true ? true : nil
            response.submitted = request.submit == true ? true : nil
            if let altered = Self.typedTextAlterationNote(typed: text, fieldValue: response.value) {
                response.ambient = (response.ambient ?? []) + [altered]
            }
            if typingRoute == .devTools(automatic: true) {
                response.message = Self.automaticWebRouteNote("typed")
            }
            failOnIsolationBreach(&response, action: "typing", before: before)
            response.action?.outcome = Self.receiptOutcome(ok: response.ok, handler: nil,
                                                           warnings: response.warnings)
            if response.ok {
                let outcome = (response.warnings?.isEmpty ?? true) ? "confirmed" : "unconfirmed"
                session.recordAgentInputAction(
                    "type", point: nil, windowID: window.windowID, outcome: outcome,
                    target: "\(text.count) character(s)" + (request.submit == true ? " + Return" : ""))
                emit("agent.action", session: session.id, [
                    "cmd": "type", "outcome": outcome, "window": String(window.windowID),
                    "characters": String(text.count),
                ])
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            }
            return response

        case "key":
            guard let combo = request.key else { throw SpaceOError.badRequest("key needs a combo") }
            guard !combo.isEmpty, combo.utf8.count <= 256, combo.count <= 64 else {
                throw SpaceOError.badRequest(
                    "key combo must be 1 through 64 characters and at most 256 UTF-8 bytes")
            }
            // Operator scope is the Viewer pasting or pressing on the human's behalf while it
            // holds Control: no lease, and the agent-input pause does not apply to the human.
            let operatorDriven = request.operatorScope == true
            let session = operatorDriven
                ? try resolve(request.session)
                : try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            if !operatorDriven { try session.requireAgentInputAllowed(action: "key") }
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            defer { session.invalidateAXSnapshot() }
            // Parse once before choosing native versus DevTools delivery. In particular this
            // keeps Command-C/X recognition identical on both guarded production routes.
            let parsedCombo = try KeyCombo.parse(combo)
            let keyAction = request.keyAction ?? "tap"
            guard KeyCombo.actions.contains(keyAction) else {
                throw SpaceOError.badRequest("key action must be " + alternatives(KeyCombo.actions))
            }
            let holdMs = request.holdMs ?? 0
            guard KeyCombo.holdMillisecondsRange.contains(holdMs) else {
                throw SpaceOError.badRequest("hold_ms must be from \(KeyCombo.holdMillisecondsRange.lowerBound) through \(KeyCombo.holdMillisecondsRange.upperBound)")
            }
            guard keyAction == "tap" || holdMs == 0 else {
                throw SpaceOError.badRequest("hold_ms applies to a tap; use action down/up for an open-ended hold")
            }
            // A crashed agent must not leave a key stuck: release anything held past the watchdog.
            let releasedHeldKeys = session.releaseStaleHeldKeys()
            let before = IsolationSnapshot.capture()
            let editorBridge = session.electronEditorBridge(for: window)
            let editorStateBefore = await ElectronEffectConfirmation.before(editorBridge)
            var targetingNote: String?
            var pasteReceipt: PasteReceipt?
            var semanticSelection = false
            var brokerMessage: String?
            // Operator keys are the human's and go where the human put them; DevTools carries
            // only taps, so a hold or separate down/up keeps the native route.
            let keyRoute = InputRouter.keystrokeRoute(
                web: operatorDriven ? (request.web ?? false) : request.web,
                windowID: window.windowID, pid: window.pid,
                hasBridge: session.webBridge(for: window.pid) != nil,
                lastPointer: session.lastPointerFocus,
                devToolsCanCarry: keyAction == "tap" && holdMs == 0)
            if let brokered = try await brokeredClipboardAction(parsedCombo, request: request, session: session, window: window) {
                // ⌘C / ⌘X / ⌘V go through the per-session broker (SPAO-143); the user's
                // pasteboard is never touched on any route.
                pasteReceipt = brokered.receipt
                brokerMessage = brokered.message
            } else if keyRoute != .native {
                guard let bridge = session.webBridge(for: window.pid) else {
                    throw SpaceOError.unsupportedTarget(
                        "web key delivery requires a SpaceO-managed Chromium DevTools bridge; "
                            + "native per-process input cannot drive Chromium page content")
                }
                guard keyAction == "tap", holdMs == 0 else {
                    throw SpaceOError.unsupportedTarget("held keys and separate down/up are delivered natively only; the DevTools route taps")
                }
                try await bridge.key(parsedCombo)
            } else {
                // Same hazard as `type`, and worse: a misrouted `cmd+s` saves the wrong document.
                targetingNote = try requireKeystrokeTarget(window, in: session, action: "press a key in")
                try InputRouter.prepareForInput(window)
                switch keyAction {
                case "down":
                    try InputRouter.keyEvent(parsedCombo, down: true, to: window.pid)
                    session.noteKeyDown(parsedCombo, name: combo.lowercased(), pid: window.pid)
                case "up":
                    try InputRouter.keyEvent(parsedCombo, down: false, to: window.pid)
                    session.noteKeyUp(name: combo.lowercased())
                default:
                    if holdMs > 0 {
                        try InputRouter.keyEvent(parsedCombo, down: true, to: window.pid)
                        try? await Task.sleep(nanoseconds: UInt64(holdMs) * 1_000_000)
                        try InputRouter.keyEvent(parsedCombo, down: false, to: window.pid)
                    } else if editorBridge == nil, NativeTextInput.isSelectAll(parsedCombo),
                              let driver = try NativeTextInput.driver(for: window),
                              try NativeTextInput.selectAll(driver) {
                        semanticSelection = true
                    } else {
                        try InputRouter.key(parsedCombo, to: window.pid)
                    }
                }
            }
            let keyNote = await ElectronEffectConfirmation.confirm(
                editorBridge, before: editorStateBefore, action: "key press")
            var response = Response(ok: true)
            response.paste = pasteReceipt
            response.releasedHeldKeys = releasedHeldKeys.isEmpty ? nil : releasedHeldKeys
            if let brokerMessage { response.message = brokerMessage }
            else if keyAction != "tap" { response.message = "key \(combo) \(keyAction); held: \(session.heldKeyNames.joined(separator: ", "))" }
            else if holdMs > 0 { response.message = "held \(combo) for \(holdMs) ms" }
            else if keyRoute == .devTools(automatic: true) { response.message = Self.automaticWebRouteNote("pressed \(combo)") }
            if !releasedHeldKeys.isEmpty {
                response.message = (response.message ?? "") + "\n  note: released stale held key(s) \(releasedHeldKeys.joined(separator: ", ")) (watchdog)"
            }
            if pasteReceipt?.insertedVia == "refused" {
                response.ok = false
                response.errorCode = "clipboard_refused"
                response.error = brokerMessage
            }
            response.action = ActionReceipt(command: request.cmd, windowID: window.windowID,
                route: semanticSelection ? "accessibility-text" : pasteReceipt != nil
                    ? actionRoute(request, session: session, target: window)
                    : keystrokeReceiptRoute(keyRoute, session: session, window: window),
                completion: semanticSelection ? "postcondition_verified" : "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
            response.warnings = [targetingNote, keyNote].compactMap { $0 }.nilWhenEmpty
            let now = IsolationSnapshot.capture()
            response.isolation = now.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = now.ambientChanges(from: before)
            failOnIsolationBreach(&response, action: "key press", before: before)
            response.action?.outcome = Self.receiptOutcome(ok: response.ok, handler: nil,
                                                           warnings: response.warnings)
            if response.ok, operatorDriven {
                emit("operator.action", session: session.id, ["cmd": "key", "action": keyAction])
            } else if response.ok {
                let outcome = (response.warnings?.isEmpty ?? true) ? "confirmed" : "unconfirmed"
                session.recordAgentInputAction(
                    "key", point: nil, windowID: window.windowID, outcome: outcome,
                    target: combo + (keyAction == "tap" ? "" : " (\(keyAction))"))
                emit("agent.action", session: session.id, [
                    "cmd": "key", "outcome": outcome, "window": String(window.windowID),
                    "action": keyAction,
                ])
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            }
            return response

        case "select":
            // Selecting text is the confirmable stand-in for a drag. VS Code-family renderers
            // drop synthetic drags, but the editor adopts a selection and reports back what it
            // adopted, which is stronger evidence than the gesture would have produced.
            guard let x = request.x, let y = request.y else {
                throw SpaceOError.badRequest("select needs x and y coordinates to identify the editor")
            }
            guard let anchorLine = request.anchorLine,
                  let anchorCharacter = request.anchorCharacter,
                  let activeLine = request.activeLine,
                  let activeCharacter = request.activeCharacter else {
                throw SpaceOError.badRequest(
                    "select needs an anchor and an active position: anchor line and character, "
                        + "active line and character")
            }
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            try session.requireAgentInputAllowed(action: "select")
            try requireNoKnownIsolationBreach(session)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            defer { session.invalidateAXSnapshot() }
            guard let editorBridge = session.electronEditorBridge(for: window) else {
                throw SpaceOError.unsupportedTarget(
                    "semantic text selection is available for VS Code-family editors SpaceO "
                        + "launched. For other targets, select by dragging with spaceo_drag.")
            }
            let before = IsolationSnapshot.capture()
            let bounds = try WindowPlacement.liveBounds(of: window.windowID)
            let global = try InputRouter.globalPoint(
                CGPoint(x: x, y: y), in: window, bounds: bounds, what: "select")
            guard AX.textEditor(
                at: global, in: window.pid, windowID: window.windowID) != nil else {
                throw SpaceOError.unsupportedTarget(
                    "the Electron control point is not inside the active text editor")
            }
            let column = try ElectronEditorRouter.column(
                forPoint: global, pid: window.pid, windowID: window.windowID)
            let selection = try await editorBridge.select(
                anchorLine: anchorLine,
                anchorCharacter: anchorCharacter,
                activeLine: activeLine,
                activeCharacter: activeCharacter,
                column: column)
            var response = Response(ok: true)
            response.action = ActionReceipt(command: request.cmd, windowID: window.windowID,
                route: actionRoute(request, session: session, target: window),
                completion: "operation_completed_postcondition_not_asserted", elapsedSeconds: 0)
            response.value = selection.selectedText
            response.message = selection.selectedText.isEmpty
                ? "selected an empty range in \(selection.document)"
                : "selected \(selection.selectedText.count) character(s) in \(selection.document)"
            let now = IsolationSnapshot.capture()
            response.isolation = now.report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            response.ambient = now.ambientChanges(from: before)
            failOnIsolationBreach(&response, action: "select", before: before)
            // The editor reported the selection it adopted, which is the confirmation.
            response.action?.outcome = response.ok ? "confirmed" : "refused"
            if response.ok {
                session.recordAgentInputAction("select")
                try renewAfterSuccessfulMutation(
                    session,
                    leaseID: request.controllerLeaseID)
            }
            return response

        case "screenshot":
            if let output = request.output,
               output.utf8.count > 16_384 || output.count > 4_096 {
                throw SpaceOError.badRequest(
                    "screenshot output path must be at most 4096 characters "
                    + "and 16384 UTF-8 bytes")
            }
            let session = try resolveForRead(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let budget = screenshotCapture.makeBudget()
            guard screenshotCapture.isQuiescent else {
                throw SpaceOError.captureFailed("a previous screenshot is still running; retry after it completes")
            }
            let scale = try Capture.validatedScale(request.scale)
            // A sub-region is expressed against the session's tile, so an agent zooming into a
            // detail never needs the window's global origin to ask for it.
            var subRect: CGRect?
            if request.x != nil || request.y != nil
                || request.width != nil || request.height != nil {
                guard let x = request.x, let y = request.y,
                      let width = request.width, let height = request.height else {
                    throw SpaceOError.badRequest(
                        "a screenshot region needs x, y, width and height together")
                }
                guard x.isFinite, y.isFinite, width >= 1, height >= 1 else {
                    throw SpaceOError.badRequest("region x and y must be finite; width and height must be positive")
                }
                subRect = CGRect(x: x, y: y, width: Double(width), height: Double(height))
            }
            let initialDisplayBounds = session.frame
            let initialBackingScale = session.stage.backingScale
            let source: ScreenshotCapture.Source
            let label: String
            if let windowID = request.window, subRect == nil {
                // Known targets need only their own live identity/geometry. An unknown target
                // must still be discovered under the same screenshot deadline.
                if session.window(id: windowID) == nil {
                    let limits = try AXWindowDiscovery.limits(remaining: budget.remaining())
                    let discovery = try AXTraversalBudget(limits: limits,
                        now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
                    _ = try session.refreshWindows(forWait: discovery)
                }
                let window = try session.resolveDiscoveredWindow(windowID)
                source = .window(window, scale: scale)
                label = "window \(windowID)"
            } else if subRect != nil {
                let foreignContent = try foreignCaptureContent(for: session, remaining: budget.remaining())
                source = .region(
                    session.stage,
                    session.frame,
                    subRect: subRect,
                    scale: scale,
                    foreign: foreignContent)
                label = "region of tile on display \(session.stage.displayID)"
            } else if request.full ?? false {
                // "the whole screen" means this session's tile — never a neighbour's.
                let foreignContent = try foreignCaptureContent(for: session, remaining: budget.remaining())
                source = .region(
                    session.stage,
                    session.frame,
                    subRect: nil,
                    scale: scale,
                    foreign: foreignContent)
                label = session.hasExclusiveDisplay
                    ? "display \(session.stage.displayID)"
                    : "tile \(session.slot.index + 1)/\(session.slot.capacity) of display \(session.stage.displayID)"
            } else if let window = session.primaryWindow {
                source = .window(window, scale: scale)
                label = "window \(window.windowID)"
            } else {
                let foreignContent = try foreignCaptureContent(for: session, remaining: budget.remaining())
                source = .region(
                    session.stage,
                    session.frame,
                    subRect: nil,
                    scale: scale,
                    foreign: foreignContent)
                label = "tile of display \(session.stage.displayID)"
            }
            if request.annotate == true, case .region = source {
                throw SpaceOError.badRequest("annotate works on a window capture; drop full/region or name a window")
            }
            func validateGeometry() throws {
                try budget.check()
                guard session.frame == initialDisplayBounds,
                      session.stage.backingScale == initialBackingScale else {
                    throw SpaceOError.staleGeometry("display topology changed during capture; capture again")
                }
                if case .window(let window, _) = source {
                    try session.validateCaptureWindow(window)
                }
                try budget.check()
            }
            try validateGeometry()
            let captured = try await screenshotCapture.capture(source, budget: budget, lease: session.beginCaptureWork())
            try validateGeometry()
            let image = captured.image
            var annotationTags: [AnnotationTag]?
            var response = Response(ok: true)
            var legend: String?
            if request.annotate == true {
                // Set-of-marks (SPAO-213): indices and pixels come from the same gate entry, so
                // the numbers drawn are the numbers `read_screen` would return right now.
                guard let windowID = captured.geometry.windowID, let target = session.window(id: windowID) else {
                    throw SpaceOError.badRequest("annotate works on a window capture; drop full/region or name a window")
                }
                let snapshot = try session.snapshotAX(window: target, limits: budget.axLimits())
                session.axHistory.remember(
                    snapshotID: snapshot.generation.uuidString.lowercased(),
                    windowID: target.windowID, nodes: snapshot.nodes)
                let tags = CaptureAnnotation.tags(
                    from: snapshot.nodes,
                    windowOrigin: CGPoint(x: captured.geometry.originX, y: captured.geometry.originY),
                    scale: captured.geometry.scale,
                    imageSize: CGSize(width: image.width, height: image.height))
                annotationTags = tags.tags
                legend = CaptureAnnotation.legend(tags.tags, partial: tags.partial)
                response.snapshotID = snapshot.generation.uuidString.lowercased()
                response.outline = snapshot.outline()
                response.truncation = snapshot.truncationReport(outline: response.outline)
            }
            let prepared = try await screenshotCapture.prepare(image, tags: annotationTags,
                memory: request.memory == true, budget: budget, lease: session.beginCaptureWork())
            try validateGeometry()
            switch prepared.payload {
            case .memory(let base64): response.imageBase64 = base64
            case .file(let data):
                let path = request.output ?? NSTemporaryDirectory() + "spaceo-\(UUID().uuidString).png"
                // Publish only a timely result. Workers never write requested output paths.
                let destination = URL(fileURLWithPath: path)
                let parent = destination.deletingLastPathComponent()
                do {
                    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                } catch {
                    throw SpaceOError.captureFailed("could not create screenshot directory \(parent.path): \(error.localizedDescription)")
                }
                try data.write(to: destination, options: .atomic)
                response.path = path
            }
            response.image = captured.geometry
            response.capture = CaptureReceipt(capturedAt: captured.capturedAt,
                displayID: captured.geometry.windowID == nil ? session.stage.displayID : nil,
                destinationDisplayID: session.stage.displayID,
                windowID: captured.geometry.windowID,
                sourceKind: captured.geometry.windowID == nil ? "display-region" : "independent-window",
                persistence: request.memory == true ? "memory" : "file")
            response.message = "captured \(label) (\(image.width)x\(image.height), "
                + "rendered=\(prepared.rendered))\n  \(captured.geometry.advice)"
                + (legend.map { "\n  " + $0 } ?? "")
            return response

        case "verify":
            let session = try resolveForRead(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let snapshot = IsolationSnapshot.capture()
            var response = Response(ok: true)
            response.findings = session.audit()
            response.session = SessionInfo(session)
            // A point-in-time audit exposes current covered state without inventing historical
            // input-route evidence that macOS did not make observable.
            response.isolation = snapshot.currentReport()
            response.drift = response.isolation?.legacyDrift
            var auditFailures = response.findings! + (response.isolation?.failures ?? [])
            if request.requireWindow == true && (session.apps.isEmpty || session.windows.isEmpty) {
                auditFailures.append("required application window is not ready")
            }
            if request.strictIsolation == true && response.isolation?.verdict != .intact {
                auditFailures.append("required complete isolation coverage is unavailable")
            }
            if auditFailures.isEmpty {
                response.message = response.isolation?.verdict == .partial
                    ? "session '\(session.id)' has no covered audit failures; "
                        + "isolation coverage is partial, so unknown checks (named below) were "
                        + "not tested and their disturbances are not ruled out"
                    : "session '\(session.id)' passed its covered isolation audit"
            } else {
                response.message = "\(auditFailures.count) issue(s)"
            }
            if !auditFailures.isEmpty {
                response.ok = false
                response.error = "session '\(session.id)' failed its isolation audit:\n  - "
                    + auditFailures.joined(separator: "\n  - ")
            }
            return response

        case "repark":
            let session = try resolveForMutation(
                request.session,
                leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            try session.requireAgentInputAllowed(action: "repark")
            try requireNoKnownIsolationBreach(session)
            let before = IsolationSnapshot.capture()
            let moved = session.reparkEscapedWindows()
            if let failure = session.windowRefreshFailure, moved == 0 {
                throw AXWindowDiscovery.incomplete(failure)
            }
            try renewAfterSuccessfulMutation(
                session,
                leaseID: request.controllerLeaseID)
            var response = Response.success("re-parked \(moved) window(s); this does not restore global focus")
            if let failure = session.windowRefreshFailure {
                response.warnings = ["post-move window discovery is incomplete: \(failure)"]
            }
            response.isolation = IsolationSnapshot.capture().report(comparedTo: before)
            response.drift = response.isolation?.legacyDrift
            failOnIsolationBreach(&response, action: "repark", before: before)
            return response

        default:
            return try await executeExtended(request)
        }
    }

    /// Snapshot the identities that a tile capture must protect against. The process-wide gate
    /// serializes manager commands, while a lifecycle lease makes the read safe even from a
    /// direct `AgentSession.destroy()` racing outside the manager. A neighbour already tearing
    /// down is an ambiguous boundary, so capture fails closed until that teardown resolves.
    func foreignCaptureContent(for target: AgentSession, remaining: TimeInterval? = nil) throws -> Capture.ForeignContent {
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: remaining),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        var windows: [Capture.ForeignWindow] = []
        var processIDs: Set<pid_t> = []

        for session in sessions.values
        where session.id != target.id && session.stage.displayID == target.stage.displayID {
            try budget.check()
            guard let lifecycleLease = try? session.beginOperation() else {
                // The neighbour is tearing down on a worker. Its pre-worker snapshot is
                // immutable, and excluding every window and process it recorded is the
                // conservative direction: an evacuated window that has already left the tile
                // costs nothing to exclude, while a missed one is another agent's pixels.
                if let snapshot = destroyingSessionSnapshots[session.id] {
                    for app in snapshot.apps {
                        try budget.consumeAllocation(MemoryLayout<pid_t>.stride)
                        processIDs.insert(app.pid)
                    }
                    for window in snapshot.windows {
                        try budget.check()
                        guard window.windowID != 0 else { continue }
                        try budget.consumeNode()
                        try budget.consumeAllocation(256)
                        windows.append(Capture.ForeignWindow(
                            sessionID: session.id,
                            windowID: window.windowID,
                            pid: window.pid,
                            frame: CGRect(
                                x: window.x, y: window.y,
                                width: window.width, height: window.height)))
                    }
                    continue
                }
                throw SpaceOError.captureFailed(
                    "could not establish capture exclusions while session "
                        + "'\(session.id)' is tearing down")
            }
            defer { lifecycleLease.finish() }
            var ownedProcessIDs = Set<pid_t>()
            for app in session.apps {
                try budget.consumeAllocation(MemoryLayout<pid_t>.stride)
                ownedProcessIDs.insert(app.pid)
                if app.identity.isAlive { processIDs.insert(app.pid) }
            }
            let knownWindows = try session.captureWindowIdentities(budget: budget)
            windows.append(contentsOf: knownWindows.compactMap { window in
                guard window.windowID != 0, ownedProcessIDs.contains(window.pid) else { return nil }
                return Capture.ForeignWindow(
                    sessionID: session.id,
                    windowID: window.windowID,
                    pid: window.pid,
                    frame: window.frame)
            })
        }

        try budget.check()
        return Capture.ForeignContent(windows: windows, processIDs: processIDs)
    }

    /// Keep browser-supplied titles and URLs from injecting terminal control/newline output.
    static func singleLine(_ value: String) -> String {
        String(value.unicodeScalars.map { scalar in
            CharacterSet.controlCharacters.contains(scalar) ? " " : String(scalar)
        }.joined()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func poolSummary(displays: Int,
                            sessions: Int,
                            perDisplay: Int,
                            usage: ResourceBudget.Usage,
                            budget: ResourceBudget) -> String {
        var lines = ["\(displays) display(s), \(sessions) session(s), \(perDisplay) per display"]
        _ = budget
        let parts = [
            "sessions \(usage.sessions)",
            "displays \(usage.displays)",
            "pixels \(usage.pixels)",
            "new displays this minute \(usage.creationsInLastMinute)",
        ]
        lines.append("  usage: " + parts.joined(separator: ", "))
        return lines.joined(separator: "\n")
    }

    /// Make the requested window the one that will receive per-pid keystrokes, or refuse.
    ///
    /// `CGEventPostToPid` addresses a *process*; the process routes the event to its own key
    /// window. `InputRouter.prepareForInput` is the step that was supposed to make that window
    /// ours, and it returns immediately — doing nothing — when the host has no focus-without-raise
    /// record, which is every host on which that private path is absent (`spaceo doctor` reports
    /// it as MISS). So `type --window A` on a two-document TextEdit typed into document B,
    /// returned `ok`, and left the caller no way to tell.
    ///
    /// Measured on 2026-08-29: `spaceo type "MARKER-INTO-ALPHA " --window 15506` (DOC-ALPHA) left
    /// DOC-ALPHA byte-for-byte unchanged and prepended the marker to DOC-BETA in window 15505.
    /// Writing an agent's text into a document it did not name is data loss in someone else's
    /// file, so this is the one place the delivery paths are allowed to refuse before sending.
    ///
    /// Order matters: ask the application to focus the window through public Accessibility first
    /// — that is the only lever left when the private route is gone — and only then read back
    /// where focus actually is. `InputRouter.keystrokeTargeting` holds the decision itself,
    /// including the one case where an unreadable focus is still safe to send into.
    func requireKeystrokeTarget(
        _ window: WindowRef,
        in session: AgentSession,
        action: String
    ) throws -> String? {
        if AXTree.focusedWindowID(pid: window.pid) != window.windowID {
            AXTree.focusWindow(window)
        }
        let focusedWindowID = AXTree.focusedWindowID(pid: window.pid)
        switch InputRouter.keystrokeTargeting(
            requestedWindowID: window.windowID,
            focusedWindowID: focusedWindowID,
            windowsOwnedByTarget: session.windows.filter({ $0.pid == window.pid }).count,
            action: action
        ) {
        case .deliver:
            return nil
        case let .deliverUnverified(note):
            return note
        case let .refuse(message):
            throw InputRouter.keystrokeRefusalError(
                message, requestedWindowID: window.windowID, focusedWindowID: focusedWindowID)
        }
    }

    /// Isolation checks that an agent application taking activation explains on its own.
    static let activationDimensions: Set<IsolationDimension> = [
        .menuBarOwner, .windowServerFrontProcess, .keyInputRoute, .textInputRoute, .activeSpace,
    ]

    /// A breach that an agent application taking activation explains entirely; a moved pointer
    /// or any other failure is never repaired by handing activation back.
    static func isActivationOnlyBreach(_ report: IsolationReport) -> Bool {
        guard report.verdict == .breached else { return false }
        let failed = Set(report.checks.filter { $0.status == .failed }.map(\.dimension))
        return !failed.isEmpty && failed.isSubset(of: activationDimensions)
    }

    /// An agent application that activated itself during the action — Chromium showing a page's
    /// popup window does (#53) — is sent back at once, and the receipt is re-checked against the
    /// same baseline. A repaired receipt says what happened; a breach that remains, or one that
    /// also involves the pointer, is reported exactly as before.
    func repairActivationBreach(_ response: inout Response, action: String, before: IsolationSnapshot) {
        guard let report = response.isolation, Self.isActivationOnlyBreach(report) else { return }
        let warning: String
        switch focusGuard.restoreIfAgentFront(preferring: before.frontmostIdentity) {
        case let .restored(app, _, agentName, _):
            warning = "\(agentName) took activation during \(action); SpaceO returned it to \(app) at once. "
                + "Keystrokes typed in that moment may have reached \(agentName)."
            DaemonLog.shared.event("isolation.activation_restored", [
                "action": action, "agent": agentName, "restored": app,
            ])
        case .notNeeded:
            // The background guard may already have returned activation after this receipt's
            // capture; only a fresh comparison against the same baseline can say so.
            warning = "An agent application took activation during \(action); it was already returned. "
                + "Keystrokes typed in that moment may have reached it."
        case let .unavailable(reason, _, _):
            response.warnings = (response.warnings ?? []) + ["SpaceO could not return activation: \(reason)"]
            return
        }
        // Only an observed recovery replaces the breach (see `AgentFocusGuard.routeRecovered`).
        let repaired = IsolationSnapshot.capture().report(comparedTo: before)
        guard AgentFocusGuard.routeRecovered(repaired) else { return }
        response.isolation = repaired
        response.drift = repaired.legacyDrift
        response.warnings = (response.warnings ?? []) + [warning]
    }

    func failOnIsolationBreach(_ response: inout Response, action: String,
                               before: IsolationSnapshot? = nil) {
        if let before { repairActivationBreach(&response, action: action, before: before) }
        let failures = response.isolation?.failures ?? response.drift ?? []
        guard !failures.isEmpty else { return }
        response.ok = false
        response.error = "isolation breach during \(action): "
            + failures.joined(separator: "; ")
    }
}

private extension Array {
    /// `warnings` is `nil` when there is nothing to say and non-empty when there is; an empty
    /// array would render as a warning-shaped hole in every response that carries none.
    var nilWhenEmpty: [Element]? { isEmpty ? nil : self }
}
