import Foundation

public struct SessionRecoveryTransition: Codable, Sendable, Equatable {
    public var sessionID: String
    public var outcome: DetachedSessionRecoveryOutcome
    public var pruned: Bool

    public init(
        sessionID: String,
        outcome: DetachedSessionRecoveryOutcome,
        pruned: Bool
    ) {
        self.sessionID = sessionID
        self.outcome = outcome
        self.pruned = pruned
    }
}

public struct SessionRecoveryBlockedRecord: Codable, Sendable, Equatable {
    public var sessionID: String
    public var blockers: [DurableRecoveryBlocker]

    public init(sessionID: String, blockers: [DurableRecoveryBlocker]) {
        self.sessionID = sessionID
        self.blockers = blockers
    }
}

public struct SessionRecoveryStartupResult: Codable, Sendable, Equatable {
    public var ledger: SessionLedger
    public var transitions: [SessionRecoveryTransition]
    public var blockedRecords: [SessionRecoveryBlockedRecord]

    public init(
        ledger: SessionLedger,
        transitions: [SessionRecoveryTransition],
        blockedRecords: [SessionRecoveryBlockedRecord]
    ) {
        self.ledger = ledger
        self.transitions = transitions
        self.blockedRecords = blockedRecords
    }
}

public struct SessionRecoveryCoordinatorResult: Codable, Sendable, Equatable {
    public var ledger: SessionLedger
    /// Nil after a durably completed record has been pruned.
    public var record: DurableSessionRecord?
    public var transition: SessionRecoveryTransition
    /// What cleanup did, by app name, once the record's cleanup completed. Nil when cleanup
    /// did not run (grace pending) or left survivors behind.
    public var summary: DestroySummary?

    public init(
        ledger: SessionLedger,
        record: DurableSessionRecord?,
        transition: SessionRecoveryTransition,
        summary: DestroySummary? = nil
    ) {
        self.ledger = ledger
        self.record = record
        self.transition = transition
        self.summary = summary
    }
}

public struct SessionRecoveryPassResult: Codable, Sendable, Equatable {
    public var ledger: SessionLedger
    /// At most one transition per record present at the beginning of the pass.
    public var transitions: [SessionRecoveryTransition]
    public var blockedRecords: [SessionRecoveryBlockedRecord]

    public init(
        ledger: SessionLedger,
        transitions: [SessionRecoveryTransition],
        blockedRecords: [SessionRecoveryBlockedRecord]
    ) {
        self.ledger = ledger
        self.transitions = transitions
        self.blockedRecords = blockedRecords
    }
}

public enum SessionRecoveryCoordinatorError: Error, LocalizedError, Equatable {
    case unknownDetachedSession(String)
    case sessionIsAttached(String)
    case storeRevisionExhausted
    case startupRequired
    case daemonInstanceMismatch
    case ledgerMismatch

    public var errorDescription: String? {
        switch self {
        case .unknownDetachedSession(let id):
            return "no detached session named '\(id)'"
        case .sessionIsAttached(let id):
            return "session '\(id)' is attached to the live daemon; detached recovery refused it"
        case .storeRevisionExhausted:
            return "the session-ledger revision space is exhausted"
        case .startupRequired:
            return "detached-session recovery startup must complete before the live manager starts"
        case .daemonInstanceMismatch:
            return "the recovery coordinator and live manager use different daemon instance ids"
        case .ledgerMismatch:
            return "the recovery coordinator and live manager use different session ledgers"
        }
    }
}

/// Store-serialized startup and retry orchestration for detached session records.
///
/// The coordinator intentionally has no display, Space, window, or DevTools API. It never reads
/// persisted placement as live authority. Every record transition is saved before the next one;
/// successful cleanup is saved as `.cleanupComplete` before a second save prunes the record.
public final class SessionRecoveryCoordinator: @unchecked Sendable {
    public typealias Clock = @Sendable () -> Date

    private let store: SessionStore
    private let recovery: DetachedSessionRecovery
    private let now: Clock
    private let lock: NSLock
    private var startupDaemonInstanceID: UUID?
    /// Detached cleanup quits apps with nobody on the other end of a socket; these are the only
    /// record that it happened. Injectable so tests read their own log and bus.
    private let log: DaemonLog
    private let events: EventBus

    public init(
        store: SessionStore,
        recovery: DetachedSessionRecovery,
        now: @escaping Clock = { Date() },
        log: DaemonLog = .shared,
        events: EventBus = .shared
    ) {
        self.store = store
        self.recovery = recovery
        self.now = now
        self.lock = LiveSessionPersistence.transactionLock(for: store)
        self.log = log
        self.events = events
    }

    /// Load fail-closed, fence every prior-daemon lease, and persist each record separately.
    ///
    /// Call this before the daemon starts accepting socket requests.
    public func startup() throws -> SessionRecoveryStartupResult {
        try lock.withLock {
            var ledger: SessionLedger
            if let loaded = try store.load() {
                ledger = loaded
            } else {
                ledger = SessionLedger(
                    storeRevision: 1,
                    writerDaemonInstanceID: recovery.daemonInstanceID,
                    updatedAt: now(),
                    nextAutomaticSessionNumber: 1,
                    sessions: [])
                try store.save(ledger)
                startupDaemonInstanceID = recovery.daemonInstanceID
                return SessionRecoveryStartupResult(
                    ledger: ledger,
                    transitions: [],
                    blockedRecords: [])
            }

            var transitions: [SessionRecoveryTransition] = []
            let sessionIDs = ledger.sessions.map(\.id)
            for id in sessionIDs {
                guard let record = ledger.sessions.first(where: { $0.id == id }) else {
                    continue
                }
                let result = try recovery.fenceLoadedRecord(record)
                if result.record != record {
                    try persist(result.record, in: &ledger)
                }
                var pruned = false
                if result.record.operationState == .cleanupComplete {
                    try pruneCompleted(id, from: &ledger)
                    pruned = true
                }
                transitions.append(SessionRecoveryTransition(
                    sessionID: id,
                    outcome: result.outcome,
                    pruned: pruned))
            }

            if ledger.writerDaemonInstanceID != recovery.daemonInstanceID {
                try persistMetadata(in: &ledger)
            }
            startupDaemonInstanceID = recovery.daemonInstanceID
            return SessionRecoveryStartupResult(
                ledger: ledger,
                transitions: transitions,
                blockedRecords: Self.blockedRecords(
                    transitions: transitions,
                    ledger: ledger))
        }
    }

    /// Reassess one record for explicit reclaim without signalling a process.
    public func assessForReclaim(
        sessionID: String
    ) throws -> SessionRecoveryCoordinatorResult {
        try lock.withLock {
            var ledger = try requiredLedger()
            let original = try record(sessionID, in: ledger)
            let result = try recovery.assessForReclaim(original)
            if result.record != original {
                try persist(result.record, in: &ledger)
            }
            var pruned = false
            if result.record.operationState == .cleanupComplete {
                try pruneCompleted(sessionID, from: &ledger)
                pruned = true
            }
            return SessionRecoveryCoordinatorResult(
                ledger: ledger,
                record: pruned ? nil : result.record,
                transition: SessionRecoveryTransition(
                    sessionID: sessionID,
                    outcome: result.outcome,
                    pruned: pruned))
        }
    }

    public func retryCleanup(
        sessionID: String
    ) throws -> SessionRecoveryCoordinatorResult {
        try lock.withLock {
            var ledger = try requiredLedger()
            return try retryCleanupLocked(sessionID: sessionID, ledger: &ledger)
        }
    }

    /// One bounded janitor pass: each record present at pass start is assessed once, and cleanup is
    /// invoked at most once only when its persisted grace boundary has elapsed.
    public func runRecoveryPass() throws -> SessionRecoveryPassResult {
        try lock.withLock {
            var ledger = try requiredLedger()
            // The same ledger also contains sessions owned by this live daemon. Recovery has
            // deliberately weaker authority than SessionManager and must never assess, rewrite,
            // or clean an attached record.
            let sessionIDs = ledger.sessions
                .filter { $0.runtimeState == .detached }
                .map(\.id)
            var transitions: [SessionRecoveryTransition] = []
            for id in sessionIDs {
                guard let original = ledger.sessions.first(where: { $0.id == id }) else {
                    continue
                }
                if original.operationState == .cleanupComplete {
                    let cleanup = try retryCleanupLocked(
                        sessionID: id,
                        ledger: &ledger)
                    transitions.append(cleanup.transition)
                    continue
                }
                let assessment = try recovery.assessForReclaim(original)
                if assessment.record != original {
                    try persist(assessment.record, in: &ledger)
                }
                if now() >= assessment.outcome.graceEndsAt {
                    let cleanup = try retryCleanupLocked(sessionID: id, ledger: &ledger)
                    transitions.append(cleanup.transition)
                } else {
                    transitions.append(SessionRecoveryTransition(
                        sessionID: id,
                        outcome: assessment.outcome,
                        pruned: false))
                }
            }
            return SessionRecoveryPassResult(
                ledger: ledger,
                transitions: transitions,
                blockedRecords: Self.blockedRecords(
                    transitions: transitions,
                    ledger: ledger))
        }
    }

    /// Current durable state for `session.list`. Corrupt state continues to fail closed.
    public func currentLedger() throws -> SessionLedger? {
        try lock.withLock { try store.load() }
    }

    public func detachedRecords() throws -> [DurableSessionRecord] {
        try lock.withLock {
            try store.load()?.sessions.filter { $0.runtimeState == .detached } ?? []
        }
    }

    /// Prevent construction of a live writer around an unfenced or differently owned ledger.
    func assertReady(
        for daemonInstanceID: UUID,
        store candidateStore: SessionStore
    ) throws {
        try lock.withLock {
            guard let startupDaemonInstanceID else {
                throw SessionRecoveryCoordinatorError.startupRequired
            }
            guard startupDaemonInstanceID == daemonInstanceID else {
                throw SessionRecoveryCoordinatorError.daemonInstanceMismatch
            }
            guard store.ledgerURL.standardizedFileURL
                    == candidateStore.ledgerURL.standardizedFileURL else {
                throw SessionRecoveryCoordinatorError.ledgerMismatch
            }
        }
    }

    private func retryCleanupLocked(
        sessionID: String,
        ledger: inout SessionLedger
    ) throws -> SessionRecoveryCoordinatorResult {
        let original = try record(sessionID, in: ledger)
        let started = Date()
        let result = try recovery.cleanup(original)
        if result.record != original {
            // This save is the durable proof of cleanup completion or pending survivors.
            try persist(result.record, in: &ledger)
        }
        var pruned = false
        if result.record.operationState == .cleanupComplete {
            // Pruning is deliberately a distinct, later atomic replacement.
            try pruneCompleted(sessionID, from: &ledger)
            pruned = true
        }
        let summary = pruned
            ? Self.summary(of: original, outcome: result.outcome,
                           duration: Date().timeIntervalSince(started))
            : nil
        // Log transitions, not ticks: a record still waiting for its grace boundary, or a
        // survivor that is unchanged since the last pass, would otherwise log every 3 s.
        if pruned || result.record != original {
            announce(original: original, outcome: result.outcome, pruned: pruned, summary: summary)
        }
        return SessionRecoveryCoordinatorResult(
            ledger: ledger,
            record: pruned ? nil : result.record,
            transition: SessionRecoveryTransition(
                sessionID: sessionID,
                outcome: result.outcome,
                pruned: pruned),
            summary: summary)
    }

    /// Name what detached cleanup did. Identities are resolved to the names the prior daemon
    /// recorded, because a bare pid in a log is useless once the process is gone.
    static func summary(
        of original: DurableSessionRecord,
        outcome: DetachedSessionRecoveryOutcome,
        duration: TimeInterval
    ) -> DestroySummary {
        func names(_ identities: [ProcessIdentity]) -> [String] {
            let wanted = Set(identities)
            return original.apps.filter { wanted.contains($0.identity) }.map(\.name).sorted()
        }
        let terminated = Set(outcome.terminatedLaunched)
        let forced = outcome.forceQuitRequested.filter { terminated.contains($0) }
        let reclaimed = terminated
            .union(outcome.droppedDead)
            .union(outcome.droppedRecycled)
        let profiles = original.apps.filter {
            $0.provenance == .launched
                && reclaimed.contains($0.identity)
                && ($0.temporaryProfile != nil || $0.temporaryControlRoot != nil)
        }.count
        return DestroySummary(
            reason: "detached_recovery",
            quitApps: names(outcome.terminatedLaunched),
            forcedApps: names(forced),
            releasedApps: names(outcome.preservedAdopted),
            durationSeconds: max(0, duration),
            profilesRemoved: profiles)
    }

    private func announce(
        original: DurableSessionRecord,
        outcome: DetachedSessionRecoveryOutcome,
        pruned: Bool,
        summary: DestroySummary?
    ) {
        func names(_ identities: [ProcessIdentity]) -> String {
            let wanted = Set(identities)
            return original.apps.filter { wanted.contains($0.identity) }
                .map(\.name).sorted().joined(separator: ",")
        }
        log.event("recovery.cleaned", [
            "session": original.id,
            "outcome": outcome.status.rawValue,
            "pruned": String(pruned),
            "terminated": names(outcome.terminatedLaunched),
            "forced": names(outcome.forceQuitRequested),
            "released": names(outcome.preservedAdopted),
            "alreadyExited": names(outcome.droppedDead + outcome.droppedRecycled),
            "survivors": names(outcome.survivingLaunched),
            "blockers": outcome.blockers.map(\.code).joined(separator: ","),
        ])
        guard pruned, let summary else { return }
        events.publish(kind: "session.destroyed", session: original.id, detail: [
            "complete": "true",
            "reason": summary.reason,
            "quit": summary.quitApps.joined(separator: ","),
            "forced": summary.forcedApps.joined(separator: ","),
            "released": summary.releasedApps.joined(separator: ","),
        ])
    }

    private func requiredLedger() throws -> SessionLedger {
        guard let ledger = try store.load() else {
            throw SessionRecoveryCoordinatorError.unknownDetachedSession("")
        }
        return ledger
    }

    private func record(
        _ id: String,
        in ledger: SessionLedger
    ) throws -> DurableSessionRecord {
        guard let record = ledger.sessions.first(where: { $0.id == id }) else {
            throw SessionRecoveryCoordinatorError.unknownDetachedSession(id)
        }
        guard record.runtimeState == .detached else {
            throw SessionRecoveryCoordinatorError.sessionIsAttached(id)
        }
        return record
    }

    private func persist(
        _ record: DurableSessionRecord,
        in ledger: inout SessionLedger
    ) throws {
        guard let index = ledger.sessions.firstIndex(where: { $0.id == record.id }) else {
            throw SessionRecoveryCoordinatorError.unknownDetachedSession(record.id)
        }
        ledger.sessions[index] = record
        try advanceAndSave(&ledger)
    }

    private func pruneCompleted(
        _ id: String,
        from ledger: inout SessionLedger
    ) throws {
        guard let index = ledger.sessions.firstIndex(where: { $0.id == id }) else { return }
        guard ledger.sessions[index].operationState == .cleanupComplete else { return }
        ledger.sessions.remove(at: index)
        try advanceAndSave(&ledger)
    }

    private func persistMetadata(in ledger: inout SessionLedger) throws {
        try advanceAndSave(&ledger)
    }

    private func advanceAndSave(_ ledger: inout SessionLedger) throws {
        guard ledger.storeRevision < UInt64.max else {
            throw SessionRecoveryCoordinatorError.storeRevisionExhausted
        }
        ledger.storeRevision += 1
        ledger.writerDaemonInstanceID = recovery.daemonInstanceID
        ledger.updatedAt = max(
            now(),
            ledger.sessions.map(\.updatedAt).max() ?? ledger.updatedAt)
        try store.save(ledger)
    }

    private static func blockedRecords(
        transitions: [SessionRecoveryTransition],
        ledger: SessionLedger
    ) -> [SessionRecoveryBlockedRecord] {
        let liveIDs = Set(ledger.sessions.map(\.id))
        return transitions.compactMap { transition in
            guard liveIDs.contains(transition.sessionID),
                  !transition.outcome.blockers.isEmpty else {
                return nil
            }
            return SessionRecoveryBlockedRecord(
                sessionID: transition.sessionID,
                blockers: transition.outcome.blockers)
        }
    }
}
