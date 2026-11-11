import Foundation

public enum DetachedSessionRecoveryStatus: String, Codable, Sendable, Equatable {
    case gracePending
    case reclaimable
    case blocked
    case cleanupOnly
    case cleanupPending
    case cleanupComplete
}

/// Structured effects and decisions from one detached-record transition.
public struct DetachedSessionRecoveryOutcome: Codable, Sendable, Equatable {
    public var status: DetachedSessionRecoveryStatus
    public var processingDaemonInstanceID: UUID
    public var fencedDaemonInstanceID: UUID?
    public var fencedLeaseID: UUID?
    public var graceEndsAt: Date
    public var droppedDead: [ProcessIdentity]
    public var droppedRecycled: [ProcessIdentity]
    public var preservedAdopted: [ProcessIdentity]
    public var gracefulQuitRequested: [ProcessIdentity]
    public var forceQuitRequested: [ProcessIdentity]
    public var terminatedLaunched: [ProcessIdentity]
    public var survivingLaunched: [ProcessIdentity]
    public var blockers: [DurableRecoveryBlocker]
    public var recordMayBeRemoved: Bool

    public init(
        status: DetachedSessionRecoveryStatus,
        processingDaemonInstanceID: UUID,
        fencedDaemonInstanceID: UUID? = nil,
        fencedLeaseID: UUID? = nil,
        graceEndsAt: Date,
        droppedDead: [ProcessIdentity] = [],
        droppedRecycled: [ProcessIdentity] = [],
        preservedAdopted: [ProcessIdentity] = [],
        gracefulQuitRequested: [ProcessIdentity] = [],
        forceQuitRequested: [ProcessIdentity] = [],
        terminatedLaunched: [ProcessIdentity] = [],
        survivingLaunched: [ProcessIdentity] = [],
        blockers: [DurableRecoveryBlocker] = [],
        recordMayBeRemoved: Bool = false
    ) {
        self.status = status
        self.processingDaemonInstanceID = processingDaemonInstanceID
        self.fencedDaemonInstanceID = fencedDaemonInstanceID
        self.fencedLeaseID = fencedLeaseID
        self.graceEndsAt = graceEndsAt
        self.droppedDead = droppedDead
        self.droppedRecycled = droppedRecycled
        self.preservedAdopted = preservedAdopted
        self.gracefulQuitRequested = gracefulQuitRequested
        self.forceQuitRequested = forceQuitRequested
        self.terminatedLaunched = terminatedLaunched
        self.survivingLaunched = survivingLaunched
        self.blockers = blockers
        self.recordMayBeRemoved = recordMayBeRemoved
    }
}

public struct DetachedSessionRecoveryResult: Codable, Sendable, Equatable {
    public var record: DurableSessionRecord
    public var outcome: DetachedSessionRecoveryOutcome

    public init(record: DurableSessionRecord, outcome: DetachedSessionRecoveryOutcome) {
        self.record = record
        self.outcome = outcome
    }
}

public struct DetachedSessionRecoveryPolicy: Sendable, Equatable {
    public var gracePeriod: TimeInterval
    public var gracefulQuitTimeout: TimeInterval
    public var forceQuitTimeout: TimeInterval

    public init(
        gracePeriod: TimeInterval = 30,
        gracefulQuitTimeout: TimeInterval = 2,
        forceQuitTimeout: TimeInterval = 1
    ) throws {
        guard gracePeriod.isFinite, gracePeriod >= 0,
              gracefulQuitTimeout.isFinite, gracefulQuitTimeout >= 0,
              forceQuitTimeout.isFinite, forceQuitTimeout >= 0 else {
            throw DetachedSessionRecoveryError.invalidPolicy
        }
        self.gracePeriod = gracePeriod
        self.gracefulQuitTimeout = gracefulQuitTimeout
        self.forceQuitTimeout = forceQuitTimeout
    }
}

public enum DetachedSessionRecoveryError: Error, LocalizedError, Equatable {
    case invalidPolicy
    case revisionExhausted(String)

    public var errorDescription: String? {
        switch self {
        case .invalidPolicy:
            return "detached-session recovery durations must be finite and non-negative"
        case .revisionExhausted(let id):
            return "durable revision space is exhausted for session '\(id)'"
        }
    }
}

/// Fences and safely resolves session records loaded by a new daemon.
///
/// This type has no display, WindowServer, or DevTools capability. Persisted placement and browser
/// metadata remain diagnostic only. Its quit adapter must repeat the exact `ProcessIdentity`
/// check immediately before delivering any termination signal.
public struct DetachedSessionRecovery: Sendable {
    public typealias Clock = @Sendable () -> Date
    public typealias CurrentIdentity = @Sendable (_ pid: pid_t) -> ProcessIdentity?
    public typealias Quit = @Sendable (_ app: DurableSessionApp, _ force: Bool) -> Void
    public typealias WaitForExit =
        @Sendable (_ apps: [DurableSessionApp], _ timeout: TimeInterval) -> [ProcessIdentity]
    public typealias CleanupTemporaryProfile = @Sendable (_ app: DurableSessionApp) -> Void

    public let daemonInstanceID: UUID
    public let policy: DetachedSessionRecoveryPolicy
    private let now: Clock
    private let currentIdentity: CurrentIdentity
    private let quit: Quit
    private let waitForExit: WaitForExit
    private let cleanupTemporaryProfile: CleanupTemporaryProfile

    public init(
        daemonInstanceID: UUID,
        policy: DetachedSessionRecoveryPolicy,
        now: @escaping Clock,
        currentIdentity: @escaping CurrentIdentity,
        quit: @escaping Quit,
        waitForExit: @escaping WaitForExit,
        cleanupTemporaryProfile: @escaping CleanupTemporaryProfile = { _ in }
    ) {
        self.daemonInstanceID = daemonInstanceID
        self.policy = policy
        self.now = now
        self.currentIdentity = currentIdentity
        self.quit = quit
        self.waitForExit = waitForExit
        self.cleanupTemporaryProfile = cleanupTemporaryProfile
    }

    /// Production adapter with exact process-identity rechecks immediately before every signal.
    ///
    /// Persisted display, Space, window, and DevTools values are intentionally absent from this
    /// adapter. A prior daemon's numeric handles are diagnostic data, never live authority.
    public static func live(
        daemonInstanceID: UUID,
        policy: DetachedSessionRecoveryPolicy? = nil,
        now: @escaping Clock = { Date() }
    ) throws -> DetachedSessionRecovery {
        let resolvedPolicy = try policy ?? DetachedSessionRecoveryPolicy()
        return DetachedSessionRecovery(
            daemonInstanceID: daemonInstanceID,
            policy: resolvedPolicy,
            now: now,
            currentIdentity: { ProcessIdentity.current(of: $0) },
            quit: { app, force in
                guard app.provenance == .launched,
                      app.identity.isPrecise,
                      ProcessIdentity.current(of: app.identity.pid) == app.identity else {
                    return
                }
                AppLauncher.quit(Self.runtimeApp(from: app), force: force)
            },
            waitForExit: { apps, timeout in
                ProcessExitWait.wait(apps, timeout: timeout) {
                    ProcessIdentity.current(of: $0.identity.pid) == $0.identity
                }.map(\.identity)
            },
            cleanupTemporaryProfile: { app in
                guard app.provenance == .launched else { return }
                AppLauncher.cleanupTemporaryProfileEventually(
                    for: Self.runtimeApp(from: app))
            })
    }

    /// Fence a record loaded by a new daemon. The old lease is cleared, while its ids are returned
    /// in the outcome for audit. Repeated daemon starts preserve an already-established boundary.
    public func fenceLoadedRecord(
        _ original: DurableSessionRecord
    ) throws -> DetachedSessionRecoveryResult {
        let timestamp = now()
        var record = original
        let oldLease = record.lease
        if record.lastActivityAt == nil {
            record.lastActivityAt = oldLease?.lastHeartbeatAt ?? record.updatedAt
        }
        let boundary: Date
        if let abandonedAt = record.abandonedAt,
           let reclaimableAfter = record.reclaimableAfter {
            boundary = max(abandonedAt, reclaimableAfter)
        } else {
            record.abandonedAt = timestamp
            boundary = timestamp.addingTimeInterval(policy.gracePeriod)
            record.reclaimableAfter = boundary
        }
        record.ownershipState = .abandoned
        record.runtimeState = .detached
        record.lease = nil

        let gate = gateState(for: record, at: timestamp, boundary: boundary)
        apply(gate, to: &record)
        record = try finalized(record, from: original, at: timestamp)
        var outcome = outcome(for: gate, boundary: boundary)
        outcome.fencedDaemonInstanceID = oldLease?.daemonInstanceID
        outcome.fencedLeaseID = oldLease?.leaseID
        return DetachedSessionRecoveryResult(record: record, outcome: outcome)
    }

    /// Reassess whether an abandoned detached record may be explicitly reclaimed.
    ///
    /// Dead and recycled identities are pruned. No process is signalled.
    ///
    /// Pruning a launched app erases the only record of its private profile and control root, so
    /// those directories are reclaimed here rather than left for `cleanup` to notice. `cleanup`
    /// reads the ledger after this method has already rewritten it, and would see no apps at all.
    public func assessForReclaim(
        _ original: DurableSessionRecord
    ) throws -> DetachedSessionRecoveryResult {
        let timestamp = now()
        let boundary = graceBoundary(for: original, at: timestamp)
        let initialGate = gateState(for: original, at: timestamp, boundary: boundary)
        if initialGate.status == .gracePending {
            var record = original
            apply(initialGate, to: &record)
            record = try finalized(record, from: original, at: timestamp)
            return DetachedSessionRecoveryResult(
                record: record,
                outcome: outcome(for: initialGate, boundary: boundary))
        }

        var record = original
        var droppedDead: [ProcessIdentity] = []
        var droppedRecycled: [ProcessIdentity] = []
        var blockers = operationalBlockers(for: record)
        record.apps = record.apps.filter { app in
            switch processState(for: app.identity) {
            case .dead:
                droppedDead.append(app.identity)
                return false
            case .recycled:
                droppedRecycled.append(app.identity)
                return false
            case .imprecise:
                blockers.append(impreciseBlocker(app.identity))
                return true
            case .live:
                return true
            }
        }
        let cleanupCandidates = original.apps.filter { app in
            app.provenance == .launched
                && (droppedDead.contains(app.identity)
                    || droppedRecycled.contains(app.identity))
        }
        cleanupCandidates.forEach(cleanupTemporaryProfile)

        let status: DetachedSessionRecoveryStatus
        if record.operationState == .cleanupComplete {
            status = .cleanupComplete
        } else if record.operationState == .cleanupPending
                    || record.operationState == .mutationPending {
            status = .cleanupOnly
        } else if blockers.isEmpty {
            status = .reclaimable
        } else {
            status = .blocked
        }
        let gate = Gate(status: status, blockers: blockers)
        apply(gate, to: &record)
        record = try finalized(record, from: original, at: timestamp)
        var resultOutcome = outcome(for: gate, boundary: boundary)
        resultOutcome.droppedDead = sorted(droppedDead)
        resultOutcome.droppedRecycled = sorted(droppedRecycled)
        resultOutcome.recordMayBeRemoved = status == .cleanupComplete
        return DetachedSessionRecoveryResult(record: record, outcome: resultOutcome)
    }

    /// Explicitly clean up a detached record after its grace boundary.
    ///
    /// Adopted apps are released from the ledger without termination. Only exact, currently live
    /// launched identities reach the injected quit driver. Survivors and imprecise launched apps
    /// stay recorded for a later retry.
    public func cleanup(
        _ original: DurableSessionRecord
    ) throws -> DetachedSessionRecoveryResult {
        let timestamp = now()
        let boundary = graceBoundary(for: original, at: timestamp)
        let initialGate = gateState(for: original, at: timestamp, boundary: boundary)
        if original.operationState == .cleanupComplete {
            let gate = Gate(status: .cleanupComplete, blockers: [cleanupCompleteBlocker()])
            var record = original
            apply(gate, to: &record)
            record = try finalized(record, from: original, at: timestamp)
            var complete = outcome(for: gate, boundary: boundary)
            complete.recordMayBeRemoved = true
            return DetachedSessionRecoveryResult(record: record, outcome: complete)
        }
        if timestamp < boundary {
            var record = original
            apply(initialGate, to: &record)
            record = try finalized(record, from: original, at: timestamp)
            return DetachedSessionRecoveryResult(
                record: record,
                outcome: outcome(for: initialGate, boundary: boundary))
        }

        var droppedDead: [ProcessIdentity] = []
        var droppedRecycled: [ProcessIdentity] = []
        var preservedAdopted: [ProcessIdentity] = []
        var impreciseLaunched: [DurableSessionApp] = []
        var launched: [DurableSessionApp] = []
        let releaseApps =
            original.id == "personal-agent-workspace" || original.cleanupDisposition == .releaseApps

        for app in original.apps {
            switch processState(for: app.identity) {
            case .dead:
                droppedDead.append(app.identity)
            case .recycled:
                droppedRecycled.append(app.identity)
            case .imprecise:
                if app.provenance == .launched, !releaseApps {
                    impreciseLaunched.append(app)
                } else {
                    preservedAdopted.append(app.identity)
                }
            case .live:
                if app.provenance == .launched, !releaseApps {
                    launched.append(app)
                } else {
                    preservedAdopted.append(app.identity)
                }
            }
        }

        launched.forEach { quit($0, false) }
        let gracefulSurvivorIDs = Set(waitForExit(launched, policy.gracefulQuitTimeout))
            .intersection(launched.map(\.identity))
        let gracefulSurvivors = launched.filter {
            gracefulSurvivorIDs.contains($0.identity)
        }
        gracefulSurvivors.forEach { quit($0, true) }
        let forceSurvivorIDs = Set(
            waitForExit(gracefulSurvivors, policy.forceQuitTimeout)
        ).intersection(gracefulSurvivors.map(\.identity))
        let finalSurvivors = gracefulSurvivors.filter {
            forceSurvivorIDs.contains($0.identity)
        }
        let terminated = launched.filter {
            !forceSurvivorIDs.contains($0.identity)
        }
        let cleanupCandidates = original.apps.filter { app in
            app.provenance == .launched
                && (droppedDead.contains(app.identity)
                    || droppedRecycled.contains(app.identity)
                    || terminated.contains(where: { $0.identity == app.identity }))
        }
        cleanupCandidates.forEach(cleanupTemporaryProfile)

        var record = original
        record.apps = impreciseLaunched + finalSurvivors
        var blockers = impreciseLaunched.map { impreciseBlocker($0.identity) }
        blockers += finalSurvivors.map { survivingBlocker($0.identity) }
        let status: DetachedSessionRecoveryStatus
        if record.apps.isEmpty {
            record.operationState = .cleanupComplete
            status = .cleanupComplete
            blockers = [cleanupCompleteBlocker()]
        } else {
            record.operationState = .cleanupPending
            status = .cleanupPending
        }
        let gate = Gate(status: status, blockers: blockers)
        apply(gate, to: &record)
        record = try finalized(record, from: original, at: timestamp)

        var resultOutcome = outcome(for: gate, boundary: boundary)
        resultOutcome.droppedDead = sorted(droppedDead)
        resultOutcome.droppedRecycled = sorted(droppedRecycled)
        resultOutcome.preservedAdopted = sorted(preservedAdopted)
        resultOutcome.gracefulQuitRequested = sorted(launched.map(\.identity))
        resultOutcome.forceQuitRequested = sorted(gracefulSurvivors.map(\.identity))
        resultOutcome.terminatedLaunched = sorted(terminated.map(\.identity))
        resultOutcome.survivingLaunched = sorted(record.apps.map(\.identity))
        resultOutcome.recordMayBeRemoved = record.operationState == .cleanupComplete
        return DetachedSessionRecoveryResult(record: record, outcome: resultOutcome)
    }

    private enum ProcessState {
        case dead
        case recycled
        case imprecise
        case live
    }

    private struct Gate {
        var status: DetachedSessionRecoveryStatus
        var blockers: [DurableRecoveryBlocker]
    }

    private func processState(for recorded: ProcessIdentity) -> ProcessState {
        guard recorded.isPrecise else { return .imprecise }
        guard let current = currentIdentity(recorded.pid) else { return .dead }
        guard current.isPrecise else { return .imprecise }
        return current == recorded ? .live : .recycled
    }

    private func graceBoundary(for record: DurableSessionRecord, at timestamp: Date) -> Date {
        if let boundary = record.reclaimableAfter { return boundary }
        return (record.abandonedAt ?? timestamp).addingTimeInterval(policy.gracePeriod)
    }

    private func gateState(
        for record: DurableSessionRecord,
        at timestamp: Date,
        boundary: Date
    ) -> Gate {
        if timestamp < boundary {
            var blockers = [graceBlocker()]
            blockers += operationalBlockers(for: record)
            let status: DetachedSessionRecoveryStatus =
                record.operationState == .cleanupPending
                    || record.operationState == .cleanupComplete
                    || record.operationState == .mutationPending
                ? .cleanupOnly
                : .gracePending
            return Gate(status: status, blockers: blockers)
        }
        let blockers = operationalBlockers(for: record)
        if record.operationState == .cleanupComplete {
            return Gate(status: .cleanupComplete, blockers: blockers)
        }
        if !blockers.isEmpty {
            return Gate(status: .cleanupOnly, blockers: blockers)
        }
        return Gate(status: .reclaimable, blockers: [])
    }

    private func operationalBlockers(
        for record: DurableSessionRecord
    ) -> [DurableRecoveryBlocker] {
        switch record.operationState {
        case .ready:
            return []
        case .mutationPending:
            return [DurableRecoveryBlocker(
                code: "interrupted_mutation",
                message: "An interrupted mutation requires cleanup before reuse.")]
        case .cleanupPending:
            return [DurableRecoveryBlocker(
                code: "cleanup_only",
                message: "Cleanup-pending sessions cannot be reclaimed for new work.")]
        case .cleanupComplete:
            return [cleanupCompleteBlocker()]
        }
    }

    private func graceBlocker() -> DurableRecoveryBlocker {
        DurableRecoveryBlocker(
            code: "restart_grace_not_elapsed",
            message: "The daemon-restart grace boundary has not elapsed.")
    }

    private func impreciseBlocker(_ identity: ProcessIdentity) -> DurableRecoveryBlocker {
        DurableRecoveryBlocker(
            code: "imprecise_process_identity",
            message: "Destructive cleanup requires an exact process start time.",
            processIdentity: identity)
    }

    private func survivingBlocker(_ identity: ProcessIdentity) -> DurableRecoveryBlocker {
        DurableRecoveryBlocker(
            code: "launched_process_survived",
            message: "The exact launched process survived cleanup and must be retried.",
            processIdentity: identity)
    }

    private func cleanupCompleteBlocker() -> DurableRecoveryBlocker {
        DurableRecoveryBlocker(
            code: "cleanup_complete",
            message: "Cleanup completed; the durable record may be removed.")
    }

    private func apply(_ gate: Gate, to record: inout DurableSessionRecord) {
        switch gate.status {
        case .reclaimable:
            record.recoveryState = .reclaimable
            record.recoveryBlockers = []
        case .gracePending, .blocked, .cleanupOnly, .cleanupPending, .cleanupComplete:
            record.recoveryState = .blocked
            record.recoveryBlockers = gate.blockers
        }
    }

    private func outcome(
        for gate: Gate,
        boundary: Date
    ) -> DetachedSessionRecoveryOutcome {
        DetachedSessionRecoveryOutcome(
            status: gate.status,
            processingDaemonInstanceID: daemonInstanceID,
            graceEndsAt: boundary,
            blockers: gate.blockers)
    }

    private func finalized(
        _ candidate: DurableSessionRecord,
        from original: DurableSessionRecord,
        at timestamp: Date
    ) throws -> DurableSessionRecord {
        guard candidate != original else { return candidate }
        guard original.revision < UInt64.max else {
            throw DetachedSessionRecoveryError.revisionExhausted(original.id)
        }
        var result = candidate
        result.revision = original.revision + 1
        result.updatedAt = max(original.updatedAt, timestamp)
        return result
    }

    private func sorted(_ identities: [ProcessIdentity]) -> [ProcessIdentity] {
        identities.sorted {
            ($0.pid, $0.startedAtMicroseconds) < ($1.pid, $1.startedAtMicroseconds)
        }
    }

    private static func runtimeApp(from durable: DurableSessionApp) -> LaunchedApp {
        LaunchedApp(
            pid: durable.identity.pid,
            identity: durable.identity,
            bundleIdentifier: durable.bundleIdentifier,
            name: durable.name,
            url: durable.url,
            startedByUs: durable.provenance == .launched,
            devToolsPort: durable.devToolsPort,
            temporaryProfile: durable.temporaryProfile,
            temporaryControlRoot: durable.temporaryControlRoot)
    }
}
