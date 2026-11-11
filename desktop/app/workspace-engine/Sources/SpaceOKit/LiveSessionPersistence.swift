import Foundation

/// Fail-closed errors produced while advancing live-session durable state.
public enum LiveSessionPersistenceError: Error, LocalizedError, Equatable {
    case storeRevisionExhausted
    case recordRevisionExhausted(String)
    /// A materialized process could neither be recorded durably nor rolled back within the
    /// reconciliation bounds. In-memory ownership is retained; the durable record stays in its
    /// pre-effect `mutationPending` state, which restart recovery already treats as cleanup-only.
    case postEffectUnreconciled(reason: String, underlying: String)

    public var errorDescription: String? {
        switch self {
        case .storeRevisionExhausted:
            return "the session-ledger revision space is exhausted"
        case .recordRevisionExhausted(let id):
            return "the durable revision space for session '\(id)' is exhausted"
        case .postEffectUnreconciled(let reason, let underlying):
            return """
            the process was registered but its identity could not be recorded durably \
            (\(underlying)), and it could not be rolled back; reconciliation stopped because \
            \(reason). The session keeps in-memory ownership of the process: no handle was \
            leaked, and restart recovery still sees this session as cleanup-only. Clear the \
            condition blocking the session ledger, then destroy or retry the session.
            """
        }
    }
}

/// A load-modify-save boundary shared by live-session writers.
///
/// `SessionStore` makes each individual load and save atomic. This type additionally keeps the
/// read/modify/write sequence indivisible inside the daemon, so a live-session transition cannot
/// replace a detached-session transition that was written from the same process.
public final class LiveSessionPersistence: @unchecked Sendable {
    public typealias Load = @Sendable () throws -> SessionLedger?
    public typealias Save = @Sendable (SessionLedger) throws -> Void

    private let transactionLock: NSLock
    private let loadLedger: Load
    private let saveLedger: Save

    public init(store: SessionStore) {
        transactionLock = Self.transactionLock(for: store)
        loadLedger = { try store.load() }
        saveLedger = { try store.save($0) }
    }

    /// The process-wide transaction lock shared by every live/recovery writer for this ledger.
    static func transactionLock(for store: SessionStore) -> NSLock {
        LiveSessionPersistenceLockRegistry.shared.lock(
            for: store.ledgerURL.standardizedFileURL.path)
    }

    /// Failure-injection seam for focused persistence tests.
    init(
        transactionLock: NSLock = NSLock(),
        load: @escaping Load,
        save: @escaping Save
    ) {
        self.transactionLock = transactionLock
        loadLedger = load
        saveLedger = save
    }

    public func load() throws -> SessionLedger? {
        try transactionLock.withLock {
            try loadLedger()
        }
    }

    /// Reload the newest ledger and save exactly one monotonic revision after applying `update`.
    ///
    /// Callers must mutate only the records they own. Unrelated live or detached records remain
    /// sourced from the just-loaded ledger and are therefore preserved.
    @discardableResult
    public func update(
        writerDaemonInstanceID: UUID,
        at timestamp: Date,
        nextAutomaticSessionNumberAtLeast minimumNextAutomaticSessionNumber: Int,
        _ update: (inout SessionLedger) throws -> Void
    ) throws -> SessionLedger {
        try transactionLock.withLock {
            let loaded = try loadLedger()
            var ledger = loaded ?? SessionLedger(
                storeRevision: 0,
                writerDaemonInstanceID: writerDaemonInstanceID,
                updatedAt: timestamp,
                nextAutomaticSessionNumber: max(1, minimumNextAutomaticSessionNumber),
                sessions: [])

            try update(&ledger)
            guard ledger.storeRevision < UInt64.max else {
                throw LiveSessionPersistenceError.storeRevisionExhausted
            }
            ledger.schemaVersion = SessionLedger.currentSchemaVersion
            ledger.storeRevision += 1
            ledger.writerDaemonInstanceID = writerDaemonInstanceID
            ledger.nextAutomaticSessionNumber = max(
                ledger.nextAutomaticSessionNumber,
                max(1, minimumNextAutomaticSessionNumber))
            ledger.updatedAt = max(
                ledger.updatedAt,
                timestamp,
                ledger.sessions.map(\.updatedAt).max() ?? timestamp)
            do {
                try saveLedger(ledger)
            } catch {
                let saveError = error
                // `rename(2)` installs the new ledger before directory fsync. If that later
                // durability check fails, save throws even though readers already observe the
                // intended revision. Treat that exact state as committed so callers never roll
                // back live ownership while leaving a phantom attached record behind.
                guard let observed = try? loadLedger(),
                      Self.sameCommittedRevision(observed, as: ledger) else {
                    throw saveError
                }
            }
            return ledger
        }
    }

    /// Ledger dates are serialized through the store's stable on-disk representation, which can
    /// round sub-second values. A post-rename read must therefore compare the identity of the
    /// committed revision rather than requiring byte-for-byte `Date` equality with the in-memory
    /// value that was just encoded.
    private static func sameCommittedRevision(
        _ observed: SessionLedger,
        as intended: SessionLedger
    ) -> Bool {
        guard observed.schemaVersion == intended.schemaVersion,
              observed.storeRevision == intended.storeRevision,
              observed.writerDaemonInstanceID == intended.writerDaemonInstanceID,
              observed.nextAutomaticSessionNumber == intended.nextAutomaticSessionNumber,
              observed.sessions.count == intended.sessions.count else {
            return false
        }

        return zip(observed.sessions, intended.sessions).allSatisfy { observed, intended in
            observed.id == intended.id && observed.revision == intended.revision
        }
    }
}

final class LiveSessionPersistenceLockRegistry: @unchecked Sendable {
    static let shared = LiveSessionPersistenceLockRegistry()

    private let registryLock = NSLock()
    private var locks: [String: NSLock] = [:]

    func lock(for path: String) -> NSLock {
        registryLock.withLock {
            if let lock = locks[path] {
                return lock
            }
            let lock = NSLock()
            locks[path] = lock
            return lock
        }
    }
}

/// Safety-over-availability reconciliation for an effect whose first durable identity write
/// failed. The call keeps retrying while the effect both survives and remains unrecorded.
///
/// Retrying is *bounded*. Both exit conditions have permanent-failure modes — rollback returns
/// `false` forever for a window that refuses to move, and the commit throws forever on a full or
/// unwritable ledger — and the caller runs this on the `SessionManager` actor while holding the
/// process-wide operation gate. An unbounded loop there wedges every later request, including the
/// signal-handler path that stops the daemon. So the loop honours an attempt budget, a monotonic
/// deadline, and task cancellation, and surfaces `postEffectUnreconciled` on exhaustion instead of
/// spinning. That result keeps in-memory ownership: nothing is rolled back and the prepared marker
/// stays, so restart recovery still treats the session as cleanup-only.
enum DurablePostEffectReconciliation {
    /// Bounds on the retry loop. Both apply; whichever is reached first ends the loop.
    struct Limits: Equatable {
        /// Commit attempts allowed *after* the first durable write already failed.
        var commitRetries: Int
        /// Monotonic ceiling on the whole retry loop, measured from the first failure.
        var timeout: TimeInterval

        static let `default` = Limits(commitRetries: 20, timeout: 2)
    }

    static nonisolated(nonsending) func run(
        limits: Limits = .default,
        now: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
        commitPendingIdentity: () throws -> Void,
        rollbackEffect: () -> Bool,
        clearPreparedMarker: () throws -> Void,
        pauseBeforeRetry: () async throws -> Void = {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    ) async throws {
        do {
            try commitPendingIdentity()
            return
        } catch {
            let originalError = error
            let start = now()
            let budgetNanoseconds = UInt64(
                max(0, min(limits.timeout, 3_600)) * 1_000_000_000)
            var remainingRetries = max(1, limits.commitRetries)
            var lastCommitError = originalError

            while true {
                if rollbackEffect() {
                    // The resource effect is gone. Failure to clear the empty prepared marker is
                    // safe: restart recovery treats it as cleanup-only and finds no process.
                    try? clearPreparedMarker()
                    throw originalError
                }
                var committed = false
                do {
                    try commitPendingIdentity()
                    committed = true
                } catch {
                    lastCommitError = error
                }
                if committed {
                    // The caller still receives the original persistence failure, but restart
                    // cleanup now has the exact surviving identity.
                    throw originalError
                }

                remainingRetries -= 1
                if remainingRetries <= 0 {
                    throw exhausted(
                        "the \(max(1, limits.commitRetries))-attempt retry budget ran out",
                        lastCommitError)
                }
                if now() &- start >= budgetNanoseconds {
                    throw exhausted(
                        "the \(limits.timeout)-second monotonic deadline expired",
                        lastCommitError)
                }
                if Task.isCancelled {
                    throw exhausted("the operation was cancelled", lastCommitError)
                }
                do {
                    try await pauseBeforeRetry()
                } catch {
                    // The only failure a pause reports is cancellation of the enclosing task.
                    throw exhausted("the operation was cancelled", lastCommitError)
                }
            }
        }
    }

    private static func exhausted(
        _ reason: String,
        _ underlying: Error
    ) -> LiveSessionPersistenceError {
        .postEffectUnreconciled(
            reason: reason,
            underlying: underlying.localizedDescription)
    }
}
