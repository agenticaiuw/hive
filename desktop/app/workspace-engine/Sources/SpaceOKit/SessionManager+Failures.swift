import Foundation

/// Failure wording and failure metadata: every refusal says what actually happened and what the
/// caller can do next, in words that work for an MCP agent and a CLI user alike.
extension SessionManager {

    // MARK: - Failure responses

    /// `Response.failure` plus what only the manager knows: the session and window the request
    /// named (so the recovery hint is runnable as is) and, for a full pool, who holds it.
    ///
    /// Thrown errors never reach `enrich`, which is where successful and soft-failed responses
    /// get their hint bound. Without this a stale index returned `spaceo_read_screen` with no
    /// session, which is not runnable once two sessions exist.
    func failureResponse(_ error: Error, request: Request) -> Response {
        var failure = error
        var holders: [PoolHolder]?
        if case .resourceLimit(let kind, let detail, let retryAfter)? = error as? SpaceOError {
            let now = reclamationPolicy.now()
            let computed = kind == .creationRate ? retryAfter : capacityRetryAfter(now: now)
            failure = SpaceOError.resourceLimit(kind: kind, detail: detail, retryAfter: computed)
            holders = poolHolders(now: now)
        }
        var response = Response.failure(failure)
        if case .resourceLimit(_, _, let retryAfter)? = failure as? SpaceOError {
            response.retryAfterSeconds = retryAfter.map { Double(SpaceOError.wholeSeconds($0)) }
            response.holders = holders
        }
        if let recovery = response.recovery,
           let session = recoverySessionID(for: request) {
            response.recovery = recovery.bound(session: session, window: request.window)
        } else if let recovery = response.recovery {
            response.recovery = recovery.bound(session: nil, window: request.window)
        }
        return response
    }

    /// The session a failed request was about: the one it named, else the one its lease (or the
    /// daemon's only session) implies. Never a session the caller's lease does not cover.
    private func recoverySessionID(for request: Request) -> String? {
        if let named = request.session {
            let trimmed = named.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        let covered = sessions.values.filter { $0.controllerLeaseCovers(request.controllerLeaseID) }
        return covered.count == 1 ? covered.first?.id : nil
    }

    // MARK: - Pool capacity

    /// Everyone holding a tile, for a `resource_limit` failure. Session id, owner label, and
    /// timing only — the same fields `session.list` shows every client, never app or window
    /// content. Bounded like the pool itself.
    func poolHolders(now: Date = Date()) -> [PoolHolder] {
        let grace = reclamationPolicy.gracePeriod
        return sessions.values
            .sorted { $0.createdAt < $1.createdAt }
            .prefix(64)
            .map { session in
                let controller = session.controllerSnapshot()
                let reclaimIn = controller?.abandonedAt.map {
                    max(0, $0.addingTimeInterval(grace).timeIntervalSince(now))
                }
                return PoolHolder(
                    session: session.id,
                    owner: controller?.owner.label,
                    ageSeconds: (controller?.ageSeconds
                        ?? max(0, Date().timeIntervalSince(session.createdAt))).rounded(),
                    idleSeconds: controller.map { max(0, now.timeIntervalSince($0.lastActivityAt)).rounded() },
                    abandoned: controller?.abandoned ?? false,
                    reclaimableInSeconds: reclaimIn?.rounded(.up))
            }
    }

    /// When the earliest abandoned session's tile is freed by the janitor, if any is abandoned.
    /// A live owner's session has no known release time, so a pool of those reports nil.
    func capacityRetryAfter(now: Date = Date()) -> Double? {
        let grace = reclamationPolicy.gracePeriod
        return sessions.values
            .compactMap { $0.controllerSnapshot()?.abandonedAt }
            .map { max(0, $0.addingTimeInterval(grace).timeIntervalSince(now)) }
            .min()
    }

    // MARK: - Session naming

    /// `unknown_session`, unless a previous daemon left a detached record under that id — then
    /// the agent learns its session is gone for good and why, instead of "no session named".
    func missingSessionError(_ canonical: String) -> SpaceOError {
        guard let record = (try? recoveryCoordinator?.detachedRecords())?
            .first(where: { $0.id == canonical }) else {
            return .unknownSession(canonical)
        }
        let detachedAt = (record.abandonedAt ?? record.updatedAt).ISO8601Format()
        var sentence = "session '\(canonical)' was detached by a daemon restart at \(detachedAt); "
        if let grace = record.reclaimableAfter {
            sentence += "its apps are quit after the recovery grace (ends \(grace.ISO8601Format())). "
        } else {
            sentence += "its apps are quit after the recovery grace. "
        }
        if let blocker = Self.realBlocker(record) {
            sentence += "Cleanup is blocked (\(blocker.code)). "
        }
        return .sessionDetached(sentence + "Nothing in it can be driven again; create a new session.")
    }

    /// The error for a create whose name is taken: who holds it and in what state, so the caller
    /// can tell "that is mine already" from "someone else's" from "a restart left it behind".
    func sessionExistsError(
        _ id: String,
        ledger: SessionLedger?,
        requester: DurableSessionOwner?
    ) -> SpaceOError {
        let hint = "omit the name to get a fresh id, or choose another name"
        if let session = sessions[id] {
            let controller = session.controllerSnapshot()
            var state: String
            if session.teardownPending {
                state = "being destroyed"
            } else if let abandonedAt = controller?.abandonedAt {
                let due = abandonedAt.addingTimeInterval(reclamationPolicy.gracePeriod)
                    .timeIntervalSince(reclamationPolicy.now())
                state = due > 0
                    ? "abandoned (reclaimed in \(SpaceOError.wholeSeconds(due)) s)"
                    : "abandoned (reclamation due)"
            } else {
                state = "live"
            }
            let ownerLabel = controller.map { "'\($0.owner.label)'" } ?? "another controller"
            if let requester, let owner = controller?.owner, owner.id == requester.id,
               controller?.abandoned != true {
                return .badRequest(
                    "session '\(id)' already exists and is yours (\(state), held by \(ownerLabel)); "
                        + "keep using it, or \(hint)")
            }
            return .badRequest(
                "session '\(id)' already exists: \(state), held by \(ownerLabel); \(hint)")
        }
        if let record = ledger?.sessions.first(where: { $0.id == id }) {
            let owner = record.owner.map { "'\($0.label)'" } ?? "an unknown controller"
            let state = record.runtimeState == .detached
                ? "detached by a daemon restart"
                : "recorded by this daemon"
            let blocker = Self.realBlocker(record).map { ", cleanup blocked by \($0.code)" } ?? ""
            return .badRequest(
                "session '\(id)' already exists: \(state) (last held by \(owner)\(blocker)); \(hint)")
        }
        return .badRequest("session '\(id)' already exists; \(hint)")
    }

    /// The first recovery blocker that is more than the restart grace itself, which the
    /// messages already state as a time.
    private static func realBlocker(_ record: DurableSessionRecord) -> DurableRecoveryBlocker? {
        record.recoveryBlockers.first { $0.code != "restart_grace_not_elapsed" }
    }

    /// The only session a request's lease covers, when the caller named none. A client holding
    /// exactly one session's lease has already said which session it means.
    func leaseImpliedSession(_ leaseID: UUID?) -> AgentSession? {
        guard let leaseID else { return nil }
        let covered = sessions.values.filter { $0.controllerLeaseCovers(leaseID) }
        return covered.count == 1 ? covered.first : nil
    }

    /// "could not find" plus up to three installed near-misses, and the exact spellings that
    /// always work. The requested name is echoed bounded: it is caller input.
    static func appNotFoundMessage(_ name: String, suggestions: [String]) -> String {
        let shown = name.count > 80 ? String(name.prefix(80)) + "…" : name
        var message = "could not find an application named '\(shown)'"
        if !suggestions.isEmpty {
            message += "; did you mean " + suggestions.prefix(3).map { "'\($0)'" }.joined(separator: ", ") + "?"
        }
        return message + " An app's full .app path or bundle identifier also works."
    }

    /// Refusal for an unnamed request that could mean any of several sessions. Names them
    /// (bounded) so the caller can pick without a second round trip.
    func ambiguousSessionError() -> SpaceOError {
        let ids = sessions.keys.sorted()
        let shown = ids.prefix(8).joined(separator: ", ")
        let more = ids.count > 8 ? " and \(ids.count - 8) more" : ""
        return .badRequest(
            "\(ids.count) sessions exist (\(shown)\(more)); name one with the session argument "
                + "(--session on the CLI)")
    }
}
