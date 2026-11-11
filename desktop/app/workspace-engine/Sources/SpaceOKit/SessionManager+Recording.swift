import Foundation

extension SessionManager {
    /// The caller already holds the operation gate. Nested actions use the same evidence
    /// boundary as ordinary commands without recursively acquiring that non-reentrant gate.
    func executeCommandWithEvidence(_ request: Request, nested: Bool = false) async -> Response {
        let started = Date()
        var before = RecordingFrameEvidence.notAttempted
        var frameSession: AgentSession?
        var preflight = true
        do {
            try preflightEvidence(request)
            preflight = false
            if Self.recordedCommands.contains(request.cmd), request.cmd != "steps.run",
               let session = try? resolveForRead(request.session, leaseID: request.controllerLeaseID),
               recorders[session.id]?.mode == .actionsAndFrames,
               (try? session.requireAgentInputAllowed(action: request.cmd)) != nil {
                frameSession = session
                before = await captureRecordingFrame(session)
            }
            var response = try await execute(request)
            let after = await recordingAfterFrame(frameSession, request: request)
            enrich(&response, request: request, elapsed: Date().timeIntervalSince(started),
                   includeSessionMetadata: !nested, recordingFrames: RecordingFrames(before: before, after: after))
            return response
        } catch {
            var response = failureResponse(Self.preDispatchHealthFailure(error, isPreflight: preflight), request: request)
            if let session = try? resolveForRead(request.session, leaseID: request.controllerLeaseID) {
                let after = await recordingAfterFrame(frameSession, request: request)
                recordCommandResult(&response, request: request, session: session,
                                    frames: RecordingFrames(before: before, after: after))
            }
            return response
        }
    }

    /// This receipt is emitted only by the preflight boundary, before execute() runs.
    /// A similar health failure later in an action is not proof it had no effect.
    static func preDispatchHealthFailure(_ error: Error, isPreflight: Bool) -> Error {
        guard isPreflight, case .stageCreationFailed(let detail)? = error as? SpaceOError,
              detail.hasPrefix("host health refused: memory_pressure; ") ||
              detail.hasPrefix("host health refused: swap_activity; ") else { return error }
        return SpaceOError.stageCreationFailed("pre_dispatch_transient_host_health: " + detail)
    }

    private func recordingAfterFrame(_ original: AgentSession?, request: Request) async -> RecordingFrameEvidence {
        guard let original, let current = sessions[original.id],
              current.generation == original.generation,
              current.controllerLeaseCovers(request.controllerLeaseID),
              recorders[current.id]?.mode == .actionsAndFrames else { return .notAttempted }
        return await captureRecordingFrame(current)
    }

    private func captureRecordingFrame(_ session: AgentSession) async -> RecordingFrameEvidence {
        do {
            try hostHealthCheck()
            try Task.checkCancellation()
            // Evidence collection must not itself mutate pause state or the command outcome.
            guard isolationPreflight()?.verdict != .breached else {
                return RecordingFrameEvidence(bytes: nil, status: "capture_unavailable")
            }
            guard session.stage.isValid else {
                return RecordingFrameEvidence(bytes: nil, status: "stale_geometry")
            }
            let lease = try session.beginOperation()
            defer { lease.finish() }
            let rect = session.frame
            let foreign = try foreignCaptureContent(for: session)
            let bytes = try await recordingFrameCapture.capture(stage: session.stage, rect: rect,
                foreign: foreign, lease: session.beginCaptureWork())
            guard session.frame == rect, session.stage.isValid else {
                return RecordingFrameEvidence(bytes: nil, status: "stale_geometry")
            }
            return RecordingFrameEvidence(bytes: bytes, status: "captured")
        } catch {
            let status: String
            switch error {
            case RecordingFrameCapture.Failure.busy: status = "capture_busy"
            case RecordingFrameCapture.Failure.timeout: status = "capture_timeout"
            case is CancellationError: status = "cancelled"
            default: status = "capture_unavailable"
            }
            return RecordingFrameEvidence(bytes: nil, status: status)
        }
    }

    private static let recordedCommands = DaemonCommand.actions.union(["steps.run"])

    /// Called under the operation gate after result metadata is final, or on an ordinary
    /// command's error path. Never changes the action outcome because evidence writing failed.
    func recordCommandResult(_ response: inout Response, request: Request, session: AgentSession, frames: RecordingFrames? = nil) {
        guard session.controllerLeaseCovers(request.controllerLeaseID) else { return }
        if let recorder = recorders[session.id], Self.recordedCommands.contains(request.cmd) {
            // Error/message prose can echo a rejected payload. Text and key receipts keep
            // byte length and structured outcome only; the payload must never reach disk.
            let sensitive = request.cmd == "type" || request.cmd == "key"
                || (request.cmd == "steps.run" && request.steps?.contains {
                    $0.cmd == "type" || $0.cmd == "key"
                } == true)
            func bounded(_ value: String?, bytes: Int) -> String? {
                value.map { BoundedDiagnosticText.prefix($0, maximumBytes: bytes) }
            }
            let x = (response.resolvedPoint?.x ?? request.x).flatMap { $0.isFinite ? $0 : nil }
            let y = (response.resolvedPoint?.y ?? request.y).flatMap { $0.isFinite ? $0 : nil }
            let payload = request.cmd == "key" ? request.key : request.text
            let frameEvidence: RecordingFrames?
            if recorder.mode == .actionsAndFrames {
                let fallback: RecordingFrameEvidence = request.cmd == "steps.run" ? .stepEvidence : .notAttempted
                frameEvidence = frames ?? RecordingFrames(before: fallback, after: fallback)
            } else { frameEvidence = nil }
            do {
                let recorded = try recorder.record(RecordedAction(
                    seq: recorder.actionCount + 1, at: Date(), cmd: request.cmd, ok: response.ok,
                    route: bounded(response.action?.route, bytes: 256),
                    completion: bounded(response.action?.completion, bytes: 256)
                        ?? (response.ok ? "operation_completed_postcondition_not_asserted" : "failed"),
                    message: sensitive ? nil : response.message.map {
                        BoundedDiagnosticText.prefix($0.prefix(400), maximumBytes: 1_600)
                    },
                    error: sensitive ? nil : bounded(response.error, bytes: 4_096),
                    errorCode: bounded(response.errorCode, bytes: 256), x: x, y: y,
                    windowID: response.action?.windowID ?? request.window,
                    payloadLength: payload?.utf8.count,
                    beforeFrameStatus: frameEvidence?.before.status,
                    afterFrameStatus: frameEvidence?.after.status),
                    beforeFrame: frameEvidence?.before.bytes, afterFrame: frameEvidence?.after.bytes)
                let statuses = [recorded.beforeFrameStatus, recorded.afterFrameStatus].compactMap { $0 }
                if statuses.contains(where: { !["captured", "not_attempted", "step_evidence"].contains($0) }) {
                    response.warnings = (response.warnings ?? []) + [
                        "Recording frame unavailable (before=\(recorded.beforeFrameStatus ?? "not_requested"), after=\(recorded.afterFrameStatus ?? "not_requested")); action outcome is unchanged."]
                }
            } catch {
                let reason: String
                if case SessionRecorderError.capacityExhausted = error { reason = "capacity_exhausted" }
                else { reason = "write_failed" }
                recorders.removeValue(forKey: session.id)
                session.setRecordingMode(nil)
                recordingFailureWarnings[session.id] =
                    "Recording stopped (\(reason)); subsequent actions are not recorded. "
                    + "Use this response's command outcome to decide whether the action succeeded."
                try? recorder.finish(reason: "recording stopped: \(reason)")
                emit("recording.stopped", session: session.id, ["reason": reason])
            }
        }
        if let warning = recordingFailureWarnings[session.id] {
            if !(response.warnings ?? []).contains(warning) {
                response.warnings = (response.warnings ?? []) + [warning]
            }
            // An earlier SessionInfo may still claim recording was active.
            if response.session?.id == session.id { response.session?.recording = nil }
        }
    }
}
