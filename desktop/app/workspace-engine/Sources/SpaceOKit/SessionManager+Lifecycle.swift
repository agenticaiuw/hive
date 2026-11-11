import Foundation
import CoreGraphics

/// Thrown when the janitor's reclaim decision went stale before it could act — the session was
/// claimed or otherwise revived between the scan and the destroy.
struct JanitorReclaimSkipped: Error {}

/// How a recent session ended, kept so later questions about it get an answer.
struct EndedSession: Sendable, Equatable {
    let id: String
    let reason: String
    let at: Date
    let summaryLine: String
}

/// Session survival and endings (the 2026-09-23 lifecycle round): claiming an abandoned
/// session, idle accounting, destroy summaries, and display revalidation after wake.
///
/// Leases here coordinate same-user clients; they are not a security boundary. Every client on
/// the socket runs as the same macOS user and could equally end any session with operator scope.
extension SessionManager {

    static let maximumRememberedEndings = 64

    // MARK: - Claim

    /// `session.claim`: hand an abandoned session, with its apps and windows, to the caller.
    ///
    /// Exists for the ordinary accident of an MCP client restarting: its stdio server exits at
    /// EOF, the janitor sees the controller process gone, and without this the session's apps
    /// are quit a grace period later while the restarted conversation watches. Requires an
    /// explicit session id — guessing which abandoned session to take is how two agents end up
    /// driving the same apps.
    func claimSession(_ request: Request) throws -> Response {
        guard let requested = request.session else {
            throw SpaceOError.badRequest(
                "session.claim needs an explicit session id; it never picks one for you")
        }
        let id = try Self.canonicalSessionID(requested)
        guard let claimant = request.controllerOwner else {
            throw SpaceOError.badRequest(
                "session.claim needs controllerOwner (the CLI and MCP server send one automatically)")
        }
        guard let session = sessions[id] else {
            if let ended = recentlyEndedSessions.last(where: { $0.id == id }) {
                let ago = Int(max(0, reclamationPolicy.now().timeIntervalSince(ended.at)).rounded())
                throw SpaceOError.badRequest(
                    "session '\(id)' was already ended \(ago)s ago (\(ended.reason): "
                        + "\(ended.summaryLine)); create a new session")
            }
            if let recoveryCoordinator,
               try recoveryCoordinator.detachedRecords().contains(where: { $0.id == id }) {
                throw SpaceOError.sessionDetached(
                    "session '\(id)' belongs to a previous daemon and is detached: no display or "
                        + "window handle survived the restart, so it cannot be claimed. Let "
                        + "recovery clean it up, or run `spaceo session destroy --session \(id)`")
            }
            throw SpaceOError.unknownSession(id)
        }
        guard !destroyingSessionIDs.contains(id), !session.teardownPending else {
            throw SpaceOError.badRequest(
                "session '\(id)' is already being reclaimed; its apps are being quit. "
                    + "Create a new session")
        }
        let owner = try validatedControllerOwner(claimant, sessionID: id)
        let duration = try request.controllerTTLSeconds.map {
            try reclamationPolicy.duration(requested: $0)
        }
        let grace = try request.orphanGraceSeconds.map {
            try reclamationPolicy.orphanGrace(requested: $0)
        }
        let outcome = try session.claimController(
            owner: owner,
            daemonInstanceID: daemonInstanceID,
            leaseID: UUID(),
            duration: duration,
            gracePeriod: grace)
        let leaseID = outcome.snapshot.lease.leaseID
        if let lifecycleLease = try? session.beginOperation() {
            _ = try? session.refreshWindowsChecked()
            lifecycleLease.finish()
        }

        // A note, not a warning: `warnings` means an effect could not be confirmed, and the
        // claim itself is confirmed. The agent still needs to know whose session it took.
        var notes: [String] = []
        if outcome.previousOwner.id != owner.id {
            notes.append(
                "session '\(id)' was previously held by \(outcome.previousOwner.label) "
                    + "(\(outcome.previousOwner.kind.rawValue)); it is now yours. Re-read the "
                    + "screen before acting: its windows may have changed while unowned")
        }
        do {
            try persistSession(session, operationState: .ready)
        } catch {
            // The claim already took effect in memory. Returning the lease with the failure is
            // what lets the caller keep controlling the session it now holds.
            var failure = Response.failure(error)
            failure.session = SessionInfo(session)
            failure.controllerLeaseID = leaseID
            failure.error = "claimed '\(id)' (keep its lease), but recording the claim failed: "
                + (failure.error ?? "unknown failure")
            return failure
        }
        emit("session.claimed", session: id, [
            "owner": owner.label,
            "previousOwner": outcome.previousOwner.label,
        ])
        DaemonLog.shared.event("session.claimed", [
            "session": id,
            "owner": "\(owner.kind.rawValue):\(owner.id)",
            "previousOwner": "\(outcome.previousOwner.kind.rawValue):\(outcome.previousOwner.id)",
        ])
        var response = Response(ok: true)
        response.session = SessionInfo(session)
        response.controllerLeaseID = leaseID
        response.message = "claimed '\(id)' from \(outcome.previousOwner.label) with "
            + "\(session.apps.count) app(s) and \(session.windows.count) window(s) kept"
        response.ambient = notes.isEmpty ? nil : notes
        return response
    }

    // MARK: - Idle accounting

    /// Owner-scoped mutations and reads count as the controller using its session; heartbeats
    /// and operator actions do not. Recorded after the request so a slow command's own duration
    /// is not counted as idle.
    func noteOwnerActivity(for request: Request) {
        guard request.operatorScope != true, request.cmd != "session.heartbeat",
              DaemonCommand.ownerScopedMutations.contains(request.cmd)
                || DaemonCommand.ownerScopedReads.contains(request.cmd) else { return }
        let target: AgentSession?
        if let requested = request.session {
            target = (try? Self.canonicalSessionID(requested)).flatMap { sessions[$0] }
        } else {
            target = sessions.count == 1 ? sessions.values.first : nil
        }
        guard let target, target.controllerLeaseCovers(request.controllerLeaseID) else { return }
        target.recordOwnerAction()
    }

    // MARK: - Destroy summaries

    /// Gather what a completed teardown did. Called after the session left `sessions`, so the
    /// recorder finish error — previously swallowed — lands in the summary instead of nowhere.
    func concludeDestroy(_ session: AgentSession, reason: String, started: Date) -> DestroySummary {
        let outcome = session.teardownOutcome()
        var recordingPath: String?
        var recordingError: String?
        var actionCount: Int?
        if let recorder = recorders.removeValue(forKey: session.id) {
            actionCount = recorder.actionCount
            recordingPath = recorder.directory.path
            do {
                try recorder.finish(reason: "session destroyed")
            } catch {
                recordingError = BoundedDiagnosticText.prefix(
                    error.localizedDescription, maximumBytes: 512)
            }
        }
        return DestroySummary(
            reason: reason,
            quitApps: outcome.quitApps,
            forcedApps: outcome.forcedApps,
            releasedApps: outcome.releasedApps,
            durationSeconds: max(0, Date().timeIntervalSince(started)),
            actionCount: actionCount,
            recordingPath: recordingPath,
            recordingError: recordingError,
            clipboardCleared: outcome.clipboardCleared,
            profilesRemoved: outcome.profilesRemoved)
    }

    func announceDestroyed(_ id: String, summary: DestroySummary) {
        emit("session.destroyed", session: id, [
            "complete": "true",
            "reason": summary.reason,
            "quit": summary.quitApps.joined(separator: ","),
            "forced": summary.forcedApps.joined(separator: ","),
            "released": summary.releasedApps.joined(separator: ","),
            "durationMs": String(Int((summary.durationSeconds * 1_000).rounded())),
        ])
        var fields = [
            "session": id,
            "reason": summary.reason,
            "summary": summary.summaryLine,
        ]
        if let error = summary.recordingError { fields["recordingError"] = error }
        DaemonLog.shared.event("session.destroyed", fields)
        rememberEnded(id, summary: summary)
    }

    func rememberEnded(_ id: String, summary: DestroySummary) {
        recentlyEndedSessions.removeAll { $0.id == id }
        recentlyEndedSessions.append(EndedSession(
            id: id, reason: summary.reason, at: reclamationPolicy.now(),
            summaryLine: summary.summaryLine))
        if recentlyEndedSessions.count > Self.maximumRememberedEndings {
            recentlyEndedSessions.removeFirst(
                recentlyEndedSessions.count - Self.maximumRememberedEndings)
        }
    }

    // MARK: - Wake and display reconfiguration

    /// Start watching for wake and display reconfiguration. The daemon calls this once; tests
    /// drive `revalidateDisplays` directly instead.
    public func startDisplayEnvironmentObservation() {
        guard displayEnvironmentObserver == nil, !isShuttingDown else { return }
        let observer = DisplayEnvironmentObserver { [weak self] change in
            Task { await self?.revalidateDisplays(reason: change.rawValue) }
        }
        observer.start()
        displayEnvironmentObserver = observer
    }

    /// Re-check every live session's display after wake or reconfiguration.
    ///
    /// A virtual display can vanish across sleep; nothing else would notice until an agent's
    /// next action failed in some unrelated-looking way. A session whose display is gone is
    /// marked `display_lost`, its agent input is paused with the reason, and the loss is
    /// announced once. Every other session gets a containment sweep, because reconfiguration
    /// is exactly when macOS moves windows between displays. Bounded by the session count and
    /// run under the command gate like the janitor, never on the request path.
    @discardableResult
    func revalidateDisplays(reason: String) async -> [String] {
        guard let commandLease = try? await operationGate.enter() else { return [] }
        defer { commandLease.finish() }
        guard !isShuttingDown else { return [] }
        guard (try? hostHealthCheck()) != nil else { return [] }
        guard !pool.stages.contains(where: \.hasLifecycleFailure) else { return [] }
        let online = Set(onlineDisplayIDs())
        var lost: [String] = []
        var swept = 0
        for id in sessions.keys.sorted() {
            guard let session = sessions[id], !destroyingSessionIDs.contains(id),
                  !session.isDisplayLost else { continue }
            if !session.stage.isValid || !online.contains(session.stage.displayID) {
                guard session.markDisplayLost() else { continue }
                lost.append(id)
                emit("session.display_lost", session: id, [
                    "reason": reason,
                    "display": String(session.stage.displayID),
                ])
                emit("input.paused", session: id, [
                    "byOperator": "false",
                    "reason": "display lost after wake/reconfiguration",
                ])
                continue
            }
            guard let lifecycleLease = try? session.beginOperation() else { continue }
            session.sweepStrayWindows()
            session.reparkUnwatchedWindows()
            lifecycleLease.finish()
            swept += 1
        }
        DaemonLog.shared.event("display.revalidated", [
            "reason": reason,
            "swept": String(swept),
            "lost": lost.joined(separator: ","),
        ])
        return lost
    }
}
