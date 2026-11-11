import Foundation
import AppKit
import CoreGraphics

/// The agent-ergonomics commands added in the 2026-09 UX round (SPAO-140, 143, 144, 146, 151,
/// 153, 204, 207–214, 218–220).
///
/// Kept in an extension so `SessionManager.swift` stays the lifecycle file. Everything here
/// runs under the same operation gate, lease checks and isolation brackets as the original
/// commands. Waits release the gate between probes; batches release it between steps and during
/// waits, so another agent's command is never queued behind an entire batch or idle pause.
extension SessionManager {

    // MARK: - Events

    /// One line to the daemon-wide event bus. Detail values are bounded by the bus.
    func emit(_ kind: String, session: String?, _ detail: [String: String] = [:]) {
        EventBus.shared.publish(kind: kind, session: session, detail: detail)
    }

    /// Return activation to the person when an agent application takes it outside any agent
    /// action, such as a popup opened by a page timer (#53). Action paths repair their own
    /// receipts; this covers the moments nothing is in flight. Daemon only: it needs the main
    /// run loop for activation notifications.
    public func startActivationGuard() {
        focusGuard.start { [weak self] outcome in
            switch outcome {
            case let .restored(app, agentPID, agentName, session):
                DaemonLog.shared.event("isolation.activation_restored", [
                    "agent": agentName, "restored": app, "session": session ?? "",
                ])
                // Application names are session content: never publish them daemon-wide.
                guard let session else { return }
                Task {
                    await self?.publishActivationRestored(session: session, agentPID: agentPID,
                                                          agent: agentName, restored: app)
                }
            case let .unavailable(reason, agentPID, session):
                DaemonLog.shared.event("isolation.activation_unrestored", [
                    "reason": reason, "session": session ?? "",
                ])
                guard let session else { return }
                Task {
                    await self?.pauseAfterUnrestoredActivation(session: session, agentPID: agentPID, reason: reason)
                }
            case .notNeeded:
                break
            }
        }
    }

    /// An agent application holds activation and could not be sent back: this is a breach with
    /// no action in flight to report it, so pause the session and tell its subscribers now.
    /// The session must still own exactly that process: a session created later under a reused
    /// name is not the one whose application took activation. Ownership is read from the locked
    /// registry, never from a ledger a detached teardown may be rewriting.
    private func sessionStillOwning(_ id: String, agentPID: pid_t) -> AgentSession? {
        guard !destroyingSessionIDs.contains(id), let session = sessions[id],
              let identity = ProcessIdentity.current(of: agentPID),
              ProcessOwnership.owner(of: identity) == id else { return nil }
        return session
    }

    func publishActivationRestored(session id: String, agentPID: pid_t, agent: String, restored: String) {
        guard sessionStillOwning(id, agentPID: agentPID) != nil else { return }
        emit("isolation.activation_restored", session: id, ["agent": agent, "restored": restored])
    }

    func pauseAfterUnrestoredActivation(session id: String, agentPID: pid_t, reason: String) {
        guard let session = sessionStillOwning(id, agentPID: agentPID) else { return }
        try? session.setAgentInputPaused(true, byOperator: false)
        emit("isolation.verdict", session: id, [
            "verdict": "breached",
            "failures": "an agent application took activation and SpaceO could not return it: " + reason,
        ])
    }

    /// Sessions whose events a subscriber may see in full, mirroring `session.list` redaction.
    public func coveredSessionIDs(for request: Request) -> Set<String> {
        var covered = Set<String>()
        let ownerID = request.controllerOwner?.id
        for (id, session) in sessions
        where session.controllerLeaseCovers(request.controllerLeaseID)
            || (ownerID != nil && session.controllerSnapshot()?.owner.id == ownerID) {
            covered.insert(id)
        }
        return covered
    }

    // MARK: - Drain (SPAO-204)

    public var isDrainingNow: Bool { isDraining }

    public func setDrainCompletionHandler(_ handler: @escaping @Sendable () -> Void) {
        onDrainComplete = handler
    }

    func beginDrain(deadlineSeconds: TimeInterval) {
        guard !isDraining else { return }
        isDraining = true
        drainDeadline = Date().addingTimeInterval(deadlineSeconds)
        emit("daemon.draining", session: nil, ["deadlineSeconds": String(Int(deadlineSeconds))])
        DaemonLog.shared.event("daemon.draining", ["sessions": String(sessions.count)])
        drainWatcher?.cancel()
        drainWatcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                if await self.drainShouldComplete() {
                    await self.completeDrain()
                    return
                }
            }
        }
    }

    private func drainShouldComplete() -> Bool {
        guard isDraining else { return false }
        if sessions.isEmpty { return true }
        if let drainDeadline, Date() >= drainDeadline { return true }
        return false
    }

    private func completeDrain() async {
        var stop = Request(cmd: "daemon.stop")
        stop.operatorScope = true
        stop.leaveDetachedRecords = true
        let response = await handle(stop)
        DaemonLog.shared.event("daemon.drain.completed", [
            "ok": String(response.ok),
            "error": response.error ?? "",
        ])
        guard response.ok else {
            // A failed stop leaves apps alive; keep serving and let the operator retry.
            isDraining = false
            drainDeadline = nil
            return
        }
        onDrainComplete?()
    }

    // MARK: - Point resolution (SPAO-209)

    struct ResolvedPointer {
        var point: CGPoint
        var destination: CGPoint?
        var receipt: ResolvedPoint
        /// True when `point` is already a CSS viewport coordinate (web element reference).
        var viewportCoordinates: Bool
    }

    /// Turn `element`/`from_element`/`to_element` or raw coordinates into window-local points.
    /// Exactly one of the two forms must be supplied; a stale snapshot is refused exactly as it
    /// is for click.
    func resolvePointer(
        _ request: Request,
        session: AgentSession,
        window: WindowRef,
        needsDestination: Bool
    ) async throws -> ResolvedPointer {
        let startReference = request.element ?? request.fromElement
        let hasCoordinates = request.x != nil || request.y != nil
        if let startReference {
            guard !hasCoordinates else {
                throw SpaceOError.badRequest("supply either an element reference or x/y coordinates, not both")
            }
            let start = try await resolveElementPoint(startReference, session: session, window: window)
            var destination: CGPoint?
            if needsDestination {
                if let toReference = request.toElement {
                    let end = try await resolveElementPoint(toReference, session: session, window: window)
                    guard end.viewport == start.viewport else {
                        throw SpaceOError.badRequest("from_element and to_element must both be native or both be web references")
                    }
                    destination = end.point
                } else if let toX = request.toX, let toY = request.toY {
                    destination = CGPoint(x: toX, y: toY)
                } else {
                    throw SpaceOError.badRequest("drag needs to_element or to_x/to_y")
                }
            }
            return ResolvedPointer(
                point: start.point,
                destination: destination,
                receipt: ResolvedPoint(
                    x: Double(start.point.x), y: Double(start.point.y), source: "element", element: startReference,
                    toX: destination.map { Double($0.x) }, toY: destination.map { Double($0.y) }),
                viewportCoordinates: start.viewport)
        }
        guard let x = request.x, let y = request.y, x.isFinite, y.isFinite else {
            throw SpaceOError.badRequest("\(request.cmd) needs x and y coordinates, or an element reference")
        }
        var destination: CGPoint?
        if needsDestination {
            if let toReference = request.toElement {
                let end = try await resolveElementPoint(toReference, session: session, window: window)
                guard !end.viewport || request.web == true else {
                    throw SpaceOError.badRequest("to_element is a web reference; pass web=true so x/y are viewport coordinates too")
                }
                destination = end.point
            } else if let toX = request.toX, let toY = request.toY {
                destination = CGPoint(x: toX, y: toY)
            } else {
                throw SpaceOError.badRequest("drag needs destination coordinates (to_x and to_y), or a destination element")
            }
        }
        return ResolvedPointer(
            point: CGPoint(x: x, y: y),
            destination: destination,
            receipt: ResolvedPoint(x: x, y: y, source: "coordinates", toX: destination.map { Double($0.x) }, toY: destination.map { Double($0.y) }),
            viewportCoordinates: request.web == true)
    }

    private func resolveElementPoint(
        _ reference: String,
        session: AgentSession,
        window: WindowRef
    ) async throws -> (point: CGPoint, viewport: Bool) {
        guard reference.utf8.count <= 128, reference.count <= 32 else {
            throw SpaceOError.badRequest("element reference must be at most 32 characters")
        }
        if reference.hasPrefix("w") {
            guard let index = Int(reference.dropFirst()), index >= 0 else {
                throw SpaceOError.badRequest("'\(reference)' is not a web element reference")
            }
            guard let bridge = session.webBridge(for: window.pid) else {
                throw SpaceOError.badRequest("this session has no DevTools element map for window \(window.windowID)")
            }
            return (try await bridge.elementCenter(index: index), true)
        }
        guard let index = Int(reference), index >= 0 else {
            throw SpaceOError.badRequest("'\(reference)' is not an element index")
        }
        // Validates snapshot generation, window, process identity and liveness before we trust
        // the cached frame — the same refusal path click takes.
        _ = try session.element(at: index, for: window)
        guard let node = session.lastSnapshot?.node(at: index), let frame = node.frame else {
            throw SpaceOError.badRequest("element [\(index)] has no on-screen frame; click it by index or use coordinates")
        }
        let bounds = try WindowPlacement.liveBounds(of: window.windowID)
        return (CGPoint(x: frame.midX - bounds.minX, y: frame.midY - bounds.minY), false)
    }

    /// Role and label of an addressed element, for the action telemetry and the canvas overlay.
    func describeTarget(_ reference: String?, session: AgentSession) -> String? {
        guard let reference, let index = Int(reference),
              let node = session.lastSnapshot?.node(at: index) else { return reference }
        let role = node.role.replacingOccurrences(of: "AX", with: "")
        return node.label.isEmpty ? role : "\(role) — \(node.label.prefix(80))"
    }

    // MARK: - Extended dispatch

    /// Commands added by the ergonomics round. Called from `execute`'s default branch.
    func executeExtended(_ request: Request) async throws -> Response {
        switch request.cmd {
        case "daemon.drain":
            try requireOperatorScope(request, action: "daemon.drain")
            let deadline = min(max(request.timeout ?? 900, 1), 3_600)
            beginDrain(deadlineSeconds: deadline)
            return Response.success(
                sessions.isEmpty
                    ? "draining: no live sessions; the daemon exits now"
                    : "draining: \(sessions.count) live session(s) keep working, new sessions are refused; "
                        + "the daemon exits when the last one is destroyed or after \(Int(deadline))s")

        case "events.poll":
            let replay = EventBus.shared.replay(since: request.sinceSeq ?? 0, limit: 500)
            let covered = coveredSessionIDs(for: request)
            let operatorScope = request.operatorScope == true
            var response = Response(ok: true)
            response.events = replay.events.map {
                EventBus.redacting($0, coveredSessions: covered, operatorScope: operatorScope)
            }
            response.nextSeq = replay.nextSeq
            response.resyncRequired = replay.resyncRequired ? true : nil
            response.message = "\(replay.events.count) event(s); next sequence \(replay.nextSeq)"
                + (replay.resyncRequired ? "; gap detected, run session.list to resync" : "")
            return response

        case "session.annotate":
            let session: AgentSession
            if request.operatorScope == true {
                session = try resolve(request.session)
            } else {
                session = try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            }
            try session.annotate(title: request.title, colorTag: request.colorTag)
            try persistSession(session, operationState: session.teardownPending ? .cleanupPending : .ready)
            emit("session.annotated", session: session.id, [
                "title": session.annotationSnapshot().title ?? "",
                "colorTag": session.annotationSnapshot().colorTag ?? "",
            ])
            var response = Response.success("annotated '\(session.id)'")
            response.session = SessionInfo(session)
            return response

        case "clipboard.set":
            guard let text = request.text else { throw SpaceOError.badRequest("clipboard.set needs text") }
            // The Viewer's ⌘V under Control stages the human's clipboard with operator scope.
            let session = request.operatorScope == true
                ? try resolve(request.session)
                : try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
            try session.clipboard.set(text)
            var response = Response.success("session clipboard holds \(text.utf8.count) byte(s); ⌘V in this session pastes it")
            response.clipboardBytes = text.utf8.count
            return response

        case "clipboard.get":
            let session: AgentSession
            if request.operatorScope == true {
                session = try resolve(request.session)
            } else {
                session = try resolveForRead(request.session, leaseID: request.controllerLeaseID)
            }
            var response = Response(ok: true)
            response.value = session.clipboard.get()
            response.clipboardBytes = session.clipboard.byteCount
            response.message = session.clipboard.isEmpty
                ? "session clipboard is empty"
                : "session clipboard holds \(session.clipboard.byteCount) byte(s)"
            return response

        case "ax.find":
            // Authorise before validating arguments: a foreign client learns "lease required",
            // never what a well-formed query looks like against someone else's session.
            let session = try resolveForRead(request.session, leaseID: request.controllerLeaseID)
            guard let query = request.query else { throw SpaceOError.badRequest("ax.find needs a query") }
            guard query.utf8.count <= AXLabelMatcher.maximumTextBytes,
                  query.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
                throw SpaceOError.badRequest("query must be at most \(AXLabelMatcher.maximumTextBytes) control-free bytes")
            }
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            let snapshot = try session.snapshotAX(window: window)
            session.axHistory.remember(
                snapshotID: snapshot.generation.uuidString.lowercased(),
                windowID: window.windowID, nodes: snapshot.nodes)
            let bounds = try WindowPlacement.liveBounds(of: window.windowID)
            let found = snapshot.find(query, role: request.role, limit: 26)
            let hits = found.prefix(25)
            var lines = hits.map { node -> String in
                var line = snapshot.line(for: node)
                if let center = node.renderedCenter(relativeTo: CGPoint(x: bounds.minX, y: bounds.minY)) {
                    line += "  at \(center)"
                }
                return line
            }
            var total = hits.count
            var pageUnavailable = false
            var pageTruncation: TruncationReport?
            if request.role == nil, let bridge = session.webBridge(for: window.pid) {
                do {
                    let web = try await bridge.findElementsReport(query: query, limit: 25)
                    pageTruncation = web.truncation
                    total += web.truncation.shown
                    if web.truncation.shown > 0 || web.truncation.truncated {
                        lines.append("page content (viewport coordinates; click by element index wN):")
                        lines.append(web.outline)
                    }
                } catch {
                    pageUnavailable = true
                    lines.append("(page search unavailable: \(error))")
                }
            }
            var response = Response(ok: true)
            response.snapshotID = snapshot.generation.uuidString.lowercased()
            response.outline = lines.isEmpty ? "(no elements match '\(query)')" : lines.joined(separator: "\n")
            response.message = "\(total) match(es) for '\(query)' in window \(window.windowID); native indices are bound to this snapshot; wN indices use current page order"
            var truncation = snapshot.truncationReport(shown: total)
            if found.count > 25 {
                truncation.truncated = true
                truncation.reason = truncation.reason.map { $0 + "+find_cap" } ?? "find_cap"
                truncation.hint = "narrow the query or add a role"
            }
            if let pageTruncation, pageTruncation.truncated {
                truncation.truncated = true
                if let reason = pageTruncation.reason {
                    truncation.reason = truncation.reason.map { $0 + "+" + reason } ?? reason
                }
                truncation.hint = pageTruncation.hint
            }
            if pageUnavailable {
                truncation.truncated = true
                truncation.reason = truncation.reason.map { $0 + "+web_unavailable" } ?? "web_unavailable"
                truncation.hint = "page search failed; retry before treating missing page controls as absent"
            }
            response.truncation = truncation
            if truncation.truncated { response.truncated = true }
            return response

        case "ax.text":
            let session = try resolveForRead(request.session, leaseID: request.controllerLeaseID)
            let lifecycleLease = try session.beginOperation()
            defer { lifecycleLease.finish() }
            let window = try session.resolveWindow(request.window)
            let range = AXTree.textCharacterRange
            let limit = min(max(request.maxChars ?? range.upperBound, range.lowerBound), range.upperBound)
            var response = Response(ok: true)
            if let reference = request.element {
                guard let index = Int(reference), index >= 0 else {
                    throw SpaceOError.badRequest("ax.text takes a native element index")
                }
                let element = try session.element(at: index, for: window)
                let read = try AXTree.valueText(of: element, maxChars: limit)
                response.value = read.text
                response.truncated = read.truncated ? true : nil
                response.source = "accessibility"
                response.message = "element [\(index)] value, \(response.value?.count ?? 0) character(s)"
            } else if let bridge = session.webBridge(for: window.pid), request.web != false {
                let page = try await bridge.pageText(limit: limit)
                response.value = page.text
                response.truncated = page.truncated ? true : nil
                response.source = "devtools"
                let selection = try? await bridge.selectionPreview()
                response.message = "page text, \(page.text.count) character(s)"
                    + (page.truncated ? " (truncated at \(limit))" : "")
                    + (selection.flatMap { $0 }.map { "; selection: \($0)" } ?? "")
            } else {
                let read = try AXTree.allText(in: window, maxChars: limit)
                response.value = read.text
                response.truncated = read.truncated ? true : nil
                response.source = "accessibility"
                let selection = try? AXTree.selectedTextPreview(pid: window.pid, inWindow: window.windowID)
                response.message = "window \(window.windowID) text, \(read.text.count) character(s)"
                    + (read.truncated ? " (truncated at \(limit))" : "")
                    + (selection.map { "; selection: \($0)" } ?? "")
            }
            return response

        case "open.url":
            return try await openURL(request)

        case "menu":
            return try await executeMenu(request)

        case "clean":
            try requireOperatorScope(request, action: "clean")
            return try cleanDiskResponse(dryRun: request.dryRun == true)

        default:
            throw SpaceOError.badRequest("unknown command '\(request.cmd)'")
        }
    }

    // MARK: - open.url (SPAO-146)

    static let managedBrowserCandidates = [
        "Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge", "Arc", "Vivaldi",
    ]

    private func openURL(_ request: Request) async throws -> Response {
        guard let raw = request.url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              raw.utf8.count <= 8_192, let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), ["http", "https", "file", "about"].contains(scheme) else {
            throw SpaceOError.badRequest("open.url needs an http(s), file or about URL of at most 8192 bytes")
        }
        let session = try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
        try session.requireAgentInputAllowed(action: "open.url")
        try requireNoKnownIsolationBreach(session)

        var reused = true
        var bridge: ChromiumBridge? = request.window.flatMap { session.window(id: $0) }
            .flatMap { session.webBridge(for: $0.pid) } ?? session.webBridge()
        var launchMessage: String?
        if bridge == nil {
            // No managed browser in this session yet: launch the first one installed, through
            // the ordinary run path so ownership, persistence and isolation brackets apply.
            guard let appName = Self.managedBrowserCandidates.first(where: { AppLauncher.resolve($0) != nil }) else {
                throw SpaceOError.launchFailed("no Chromium-family browser is installed; open.url needs one (Google Chrome, Chromium, Brave, Edge, Arc or Vivaldi)")
            }
            var run = Request(cmd: "run")
            run.session = session.id
            run.controllerLeaseID = request.controllerLeaseID
            run.controllerOwner = request.controllerOwner
            run.app = appName
            run.timeout = request.timeout
            run.muteAudio = request.muteAudio
            run.diagnosticTraceID = request.diagnosticTraceID
            run.diagnosticRunID = request.diagnosticRunID
            let launched = await executeCommandWithEvidence(run, nested: true)
            guard launched.ok else {
                var failure = launched
                failure.error = "could not launch \(appName) for open.url: \(launched.error ?? "unknown failure")"
                return failure
            }
            launchMessage = launched.message
            reused = false
            bridge = session.webBridge()
        }
        guard let bridge else {
            throw SpaceOError.unsupportedTarget("the session's browser exposes no DevTools bridge; open.url needs a SpaceO-managed Chromium launch")
        }
        let lifecycleLease = try session.beginOperation()
        defer { lifecycleLease.finish() }
        defer { session.invalidateAXSnapshot() }
        let before = IsolationSnapshot.capture()
        if await bridge.boundTargetID == nil {
            do {
                _ = try await bridge.attachToLaunchedTarget()
            } catch let error as SpaceOError {
                throw SpaceOError.webTargetAmbiguous(error.description)
            }
        }
        let outcome: (target: ChromiumBridge.Target, load: String)
        if request.newTab == true {
            let target = try await bridge.openInNewTab(url)
            outcome = (target, "complete")
        } else {
            outcome = try await bridge.navigate(to: url, timeout: min(request.timeout ?? 15, 60))
        }
        var response = Response(ok: true)
        response.navigation = NavigationReceipt(
            title: Self.singleLine(outcome.target.title),
            finalURL: Self.singleLine(outcome.target.url),
            targetID: outcome.target.id,
            load: outcome.load,
            reusedBrowser: reused)
        response.reused = reused
        var message = "navigated target \(outcome.target.id) to \(Self.singleLine(outcome.target.url)) — "
            + (outcome.target.title.isEmpty ? "(untitled)" : Self.singleLine(outcome.target.title))
            + "; load: \(outcome.load)"
        if outcome.load == "timeout" {
            message += " (the document had not finished loading; read the screen or wait_for a selector before acting)"
        }
        if let launchMessage { message = launchMessage + "\n" + message }
        response.message = message
        let now = IsolationSnapshot.capture()
        response.isolation = now.report(comparedTo: before)
        response.drift = response.isolation?.legacyDrift
        response.ambient = now.ambientChanges(from: before)
        response.action = ActionReceipt(command: "open.url", windowID: session.primaryWindow?.windowID,
            route: "chromium-devtools",
            completion: outcome.load == "complete" ? "operation_completed_postcondition_not_asserted" : "operation_completed_load_unconfirmed",
            elapsedSeconds: 0)
        failOnIsolationBreach(&response, action: "open.url", before: before)
        response.action?.outcome = response.ok
            ? (outcome.load == "complete" ? "confirmed" : "unconfirmed") : "refused"
        if response.ok {
            session.recordAgentInputAction("open.url", point: nil, windowID: session.primaryWindow?.windowID,
                outcome: outcome.load == "complete" ? "confirmed" : "unconfirmed",
                target: Self.singleLine(outcome.target.url).prefix(120).description)
            emit("agent.action", session: session.id, ["cmd": "open.url", "outcome": outcome.load, "url": Self.singleLine(outcome.target.url)])
            try renewAfterSuccessfulMutation(session, leaseID: request.controllerLeaseID)
            response.session = SessionInfo(session)
        }
        return response
    }

    // MARK: - steps.run (SPAO-208)

    static let maximumBatchSteps = 16
    static let maximumBatchSeconds: TimeInterval = 60
    private struct BatchDeadlineExceeded: Error {}
    static let batchStepCommands: Set<String> = ["click", "type", "key", "scroll", "move", "drag", "wait", "ax.find"]

    func runSteps(_ request: Request) async throws -> Response {
        let started = waitRuntime.now()
        // Malformed timeouts still receive normal preflight validation after bounded admission.
        let requestedTimeout = request.timeout ?? Self.maximumBatchSeconds
        let admissionBudget = requestedTimeout.isFinite && (0.5...120).contains(requestedTimeout)
            ? min(requestedTimeout, Self.maximumBatchSeconds) : Self.maximumBatchSeconds
        let deadline = started.addingTimeInterval(admissionBudget)
        guard let steps = request.steps, !steps.isEmpty else {
            throw SpaceOError.badRequest("steps.run needs 1 through \(Self.maximumBatchSteps) steps")
        }
        guard steps.count <= Self.maximumBatchSteps else {
            throw SpaceOError.badRequest("steps.run accepts at most \(Self.maximumBatchSteps) steps")
        }
        let typedBytes = steps.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) }
        guard typedBytes <= 32_000 else {
            throw SpaceOError.badRequest("a batch may type at most 32000 UTF-8 bytes in total")
        }
        for (index, step) in steps.enumerated() {
            guard Self.batchStepCommands.contains(step.cmd) else {
                throw SpaceOError.badRequest(
                    "step \(index) uses '\(step.cmd)'; batches accept " + Self.batchStepCommands.sorted().joined(separator: ", "))
            }
            guard step.steps == nil else { throw SpaceOError.badRequest("steps cannot nest") }
        }
        let initialGate: SessionOperationGate.Lease
        do { initialGate = try await operationGate.enter(timeout: max(0, deadline.timeIntervalSince(waitRuntime.now()))) }
        catch is SessionOperationGate.TimedOut { throw SpaceOError.batchQueueTimeout("initial admission; no steps executed") }
        defer { initialGate.finish() }
        if isShuttingDown { throw SpaceOError.daemonStopping }
        try preflightEvidence(request)
        // Bind the batch to one session generation, then reauthorise at every step boundary.
        let session = try resolveForMutation(request.session, leaseID: request.controllerLeaseID)
        try session.requireAgentInputAllowed(action: "steps.run")
        let stopOnFailure = request.stopOnFailure ?? true
        initialGate.finish()

        var receipts: [StepReceipt] = []
        var warnings: [String] = []
        var firstFailure: Int?
        var budgetExpired = false
        for (index, supplied) in steps.enumerated() {
            if let firstFailure, stopOnFailure || Task.isCancelled || budgetExpired {
                receipts.append(StepReceipt(index: index, cmd: supplied.cmd, ok: false, executed: false,
                    error: "not executed: step \(firstFailure) failed", errorCode: "not_executed"))
                continue
            }
            var step = supplied
            step.session = session.id
            step.controllerLeaseID = request.controllerLeaseID
            step.controllerOwner = request.controllerOwner
            step.diagnosticTraceID = request.diagnosticTraceID
            step.diagnosticRunID = request.diagnosticRunID
            if request.strictIsolation == true { step.strictIsolation = true }
            if let required = request.requiredIsolation {
                step.requiredIsolation = IsolationDimension.allCases.filter {
                    required.contains($0) || (supplied.requiredIsolation ?? []).contains($0)
                }
            }
            var response: Response
            var executed = true
            do {
                response = try await executeBatchStep(step, generation: session.generation, deadline: deadline)
            } catch let refusal as BatchStepNotExecuted {
                executed = false
                response = failureResponse(refusal.underlying, request: step)
            } catch is BatchDeadlineExceeded {
                budgetExpired = true
                executed = false
                response = Response(ok: false)
                response.errorCode = "batch_timeout"
                response.error = "batch time budget exhausted; this and later steps were not executed"
            } catch {
                response = failureResponse(error, request: step)
            }
            if let outcome = response.wait?.outcome, outcome != "met" {
                response.ok = false
                response.error = response.message ?? "wait condition was not met"
                response.errorCode = "wait_" + outcome
            }
            for warning in response.warnings ?? [] where !warnings.contains(warning) { warnings.append(warning) }
            receipts.append(StepReceipt(index: index, cmd: supplied.cmd, response: response, executed: executed))
            if !response.ok, firstFailure == nil { firstFailure = index }
        }
        var response = Response(ok: firstFailure == nil)
        response.steps = receipts
        response.warnings = warnings.isEmpty ? nil : warnings
        response.firstFailureIndex = firstFailure
        let executed = receipts.filter(\.executed).count
        response.message = firstFailure == nil
            ? "ran \(executed) step(s); all succeeded"
            : "ran \(executed) step(s); step \(firstFailure!) failed" + (stopOnFailure ? "; later steps were not executed" : "")
        if let firstFailure {
            response.error = receipts[firstFailure].error
            response.errorCode = receipts[firstFailure].errorCode
        }
        if Task.isCancelled { return response }
        let finalGate: SessionOperationGate.Lease
        do { finalGate = try await operationGate.enter(timeout: max(0, deadline.timeIntervalSince(waitRuntime.now()))) }
        catch is CancellationError { return response }
        catch is SessionOperationGate.TimedOut {
            // Preserve historical receipts: replacing them with a generic failure could cause
            // a caller to replay input that already ran. Fresh metadata needs authorization.
            let error = SpaceOError.batchQueueTimeout("final authorization")
            response.ok = false
            if firstFailure == nil {
                response.error = error.description
                response.errorCode = error.code
            }
            response.recovery = error.recovery
            response.nextAction = error.nextAction
            response.warnings = (response.warnings ?? []) + [
                "Batch final authorization exceeded the queue budget; fresh session/isolation evidence is unavailable. Review step receipts before further input; do not replay completed steps."
            ]
            return response
        }
        defer { finalGate.finish() }
        // Reauthorise before attaching fresh metadata, including after a lease handoff.
        guard let current = try? resolveForRead(session.id, leaseID: request.controllerLeaseID),
              current.generation == session.generation else { return response }
        response.isolation = isolationPreflight()
        if response.isolation?.verdict == .breached {
            try? session.setAgentInputPaused(true, byOperator: false)
            failOnIsolationBreach(&response, action: "steps.run")
        }
        response.session = SessionInfo(session)
        enrich(&response, request: request, elapsed: waitRuntime.now().timeIntervalSince(started))
        return response
    }

    private struct BatchStepNotExecuted: Error {
        let underlying: Error
    }

    private func executeBatchStep(_ supplied: Request, generation: UUID, deadline: Date) async throws -> Response {
        var step = supplied
        let remainingBeforeAdmission = deadline.timeIntervalSince(waitRuntime.now())
        guard remainingBeforeAdmission >= (step.cmd == "wait" ? 0.5 : 0.001) else { throw BatchDeadlineExceeded() }
        let gate: SessionOperationGate.Lease
        do { gate = try await operationGate.enter(timeout: remainingBeforeAdmission) }
        catch is SessionOperationGate.TimedOut { throw BatchDeadlineExceeded() }
        catch { throw BatchStepNotExecuted(underlying: error) }
        defer { gate.finish() }
        do {
            if isShuttingDown { throw SpaceOError.daemonStopping }
            let session = try resolveForMutation(step.session, leaseID: step.controllerLeaseID)
            guard session.generation == generation else {
                throw SpaceOError.applicationExited("the batch's session was destroyed or replaced")
            }
            try session.requireAgentInputAllowed(action: "steps.run")
        } catch {
            throw BatchStepNotExecuted(underlying: error)
        }
        let remaining = deadline.timeIntervalSince(waitRuntime.now())
        guard remaining >= (step.cmd == "wait" ? 0.5 : 0.001) else { throw BatchDeadlineExceeded() }
        if step.cmd == "wait" {
            try preflightEvidence(step)
            // Validate the requested deadline before shortening it to the batch's remainder.
            _ = try WaitPolicy(deadline: step.timeout ?? 15)
            step.timeout = min(step.timeout ?? 15, remaining)
            gate.finish()
            return try await executeWait(step, expectedGeneration: generation, nested: true)
        }
        return await executeCommandWithEvidence(step, nested: true)
    }

    // MARK: - wait (SPAO-140)

    /// Evaluator that enters the operation gate for each probe, so a long wait never blocks
    /// another session's commands.
    private struct GatedWaitEvaluator: WaitEvaluating {
        let manager: SessionManager
        let request: Request
        let generation: UUID
        let deadline: Date

        func probe(_ condition: WaitCondition) async throws -> WaitProbeResult {
            let remaining = deadline.timeIntervalSince(manager.waitRuntime.now())
            guard remaining > 0 else { throw WaitProbeDeadlineExceeded() }
            let lease: SessionOperationGate.Lease
            do { lease = try await manager.operationGate.enter(timeout: remaining) }
            catch is SessionOperationGate.TimedOut { throw WaitProbeDeadlineExceeded() }
            defer { lease.finish() }
            return try await manager.probeNow(condition, request: request, generation: generation, deadline: deadline)
        }
    }

    private func authorizeWait(_ request: Request, generation: UUID?) throws -> AgentSession {
        if isShuttingDown { throw SpaceOError.daemonStopping }
        let session = try resolveForRead(request.session, leaseID: request.controllerLeaseID)
        if let generation, session.generation != generation {
            throw SpaceOError.applicationExited("the waiting session was destroyed or replaced")
        }
        try preflightEvidence(request)
        return session
    }

    private func enterWaitGate(deadline: Date, phase: String) async throws -> SessionOperationGate.Lease {
        do { return try await operationGate.enter(timeout: max(0, deadline.timeIntervalSince(waitRuntime.now()))) }
        catch is SessionOperationGate.TimedOut { throw SpaceOError.waitQueueTimeout(phase) }
    }

    func executeWait(_ supplied: Request, expectedGeneration: UUID? = nil, nested: Bool = false) async throws -> Response {
        let started = waitRuntime.now()
        let requestedTimeout = supplied.timeout ?? 15
        // Admission itself must be bounded even for malformed input, but preserve the existing
        // lease-first refusal before revealing command validation details.
        let admissionBudget = requestedTimeout.isFinite && (0.5...60).contains(requestedTimeout)
            ? requestedTimeout : 15
        let deadline = started.addingTimeInterval(admissionBudget)
        let initialGate = try await enterWaitGate(deadline: deadline, phase: "initial admission")
        defer { initialGate.finish() }
        let session = try authorizeWait(supplied, generation: expectedGeneration)
        guard let kind = supplied.waitCondition else {
            throw SpaceOError.badRequest("wait needs a condition (" + WaitCondition.knownKinds.joined(separator: ", ") + ")")
        }
        let condition = try WaitCondition.parse(kind: kind, value: supplied.waitValue)
        // Validate label matching once, before the loop, so a bad mode is an error rather
        // than a wait that can never be met.
        switch condition {
        case .elementLabel(let text), .elementGone(let text):
            _ = try AXLabelMatcher.parse(text: text, match: supplied.match, role: supplied.role)
        default:
            guard supplied.match == nil, supplied.role == nil else {
                throw SpaceOError.badRequest("match and role apply to element_label and element_gone")
            }
        }
        let policy = try WaitPolicy(deadline: requestedTimeout, condition: condition)
        var request = supplied
        request.session = session.id
        initialGate.finish()
        let receipt = try await WaitLoop.run(
            condition,
            policy: policy,
            evaluator: GatedWaitEvaluator(manager: self, request: request, generation: session.generation,
                deadline: deadline),
            now: waitRuntime.now,
            sleep: waitRuntime.sleep, startedAt: started)
        var response = Response(ok: true)
        response.wait = receipt
        response.snapshotID = receipt.snapshotID
        switch receipt.outcome {
        case "met":
            response.message = "wait met: \(receipt.condition)"
                + (receipt.value.map { " '\($0)'" } ?? "")
                + " after \(String(format: "%.1f", receipt.elapsedSeconds))s"
                + (receipt.matchedIndex.map { "; element index \($0)" } ?? "")
                + (receipt.matchedTitle.map { "; title \"\($0)\"" } ?? "")
                + (receipt.matchedWindowID.map { "; window \($0)" } ?? "")
                + (receipt.handoffNote.map { "; operator note: \($0)" } ?? "")
        case "timeout":
            response.message = "wait timed out after \(String(format: "%.1f", receipt.elapsedSeconds))s (\(receipt.probes) probes): \(receipt.condition) not met; read the screen to see what is there instead"
        default:
            response.message = "wait cancelled after \(String(format: "%.1f", receipt.elapsedSeconds))s"
        }
        if !Task.isCancelled {
            let finalGate = try await enterWaitGate(deadline: deadline, phase: "final authorization")
            defer { finalGate.finish() }
            _ = try authorizeWait(request, generation: session.generation)
            if request.strictIsolation == true || request.requiredIsolation != nil {
                response.isolation = isolationPreflight()
                response.drift = response.isolation?.legacyDrift
            }
            // Authorization and final metadata share one gate entry. Nested waits leave the
            // handoff note and discarded session metadata for the outer batch response.
            enrich(&response, request: request, elapsed: receipt.elapsedSeconds,
                   includeSessionMetadata: !nested)
        }
        return response
    }

    /// One probe, on the actor with the gate held by the caller.
    func probeNow(_ condition: WaitCondition, request: Request, generation: UUID? = nil,
                  deadline: Date? = nil) async throws -> WaitProbeResult {
        if let deadline, waitRuntime.now() >= deadline { throw WaitProbeDeadlineExceeded() }
        let session = try authorizeWait(request, generation: generation)
        guard let lifecycleLease = try? session.beginOperation() else {
            throw SpaceOError.applicationExited("session '\(session.id)' is tearing down")
        }
        defer { lifecycleLease.finish() }
        var observedWindows: [WindowRef] = []
        switch condition {
        case .ms, .stableMs, .sessionResumed: break
        default:
            let limits = try AXWindowDiscovery.limits(
                remaining: deadline.map { $0.timeIntervalSince(waitRuntime.now()) })
            let budget = try AXTraversalBudget(limits: limits,
                now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
            do { observedWindows = try session.refreshWindows(forWait: budget) }
            catch let stopped as AXTraversalStopped where stopped.reason == .deadline { return .notYet(nil) }
        }
        switch condition {
        case .ms:
            return .met(WaitProbe())
        case .sessionResumed:
            // Allowed while paused by design — this is how an agent waits for the human. The
            // hand-back note is peeked, not consumed; the response still delivers it once.
            guard !session.agentInputSnapshot().paused else { return .notYet(nil) }
            return .met(WaitProbe(handoffNote: session.annotationSnapshot().pendingHandoff?.note))
        case .windowTitleContains(let fragment):
            let needle = fragment.lowercased()
            if let window = observedWindows.first(where: { $0.title.lowercased().contains(needle) }) {
                return .met(WaitProbe(matchedTitle: window.title, matchedWindowID: window.windowID))
            }
            return .notYet(nil)
        case .elementLabel(let text), .elementGone(let text):
            let matcher = try AXLabelMatcher.parse(text: text, match: request.match, role: request.role)
            let window = try session.resolveDiscoveredWindow(request.window)
            let limits = try WaitPolicy.axTraversalLimits(
                remaining: deadline.map { $0.timeIntervalSince(waitRuntime.now()) })
            do {
                let snapshot = try session.snapshotAX(window: window, limits: limits)
                return snapshot.waitProbe(condition, matcher: matcher)
            } catch let stopped as AXTraversalStopped where stopped.reason == .deadline {
                // Resolving the AX root can exhaust its budget before there is a partial
                // snapshot. This proves neither presence nor absence; the loop may retry if
                // its overall deadline still permits another probe.
                return .notYet(nil)
            }
        case .webSelector(let selector):
            let window = try session.resolveDiscoveredWindow(request.window)
            guard let bridge = session.webBridge(for: window.pid) else {
                throw SpaceOError.unsupportedTarget("web_selector needs a SpaceO-managed Chromium window")
            }
            if let deadline, waitRuntime.now() >= deadline { throw WaitProbeDeadlineExceeded() }
            do {
                let budget = try deadline.map {
                    try DevToolsDeadline(timeout: $0.timeIntervalSince(waitRuntime.now()))
                }
                return try await bridge.selectorExists(selector, budget: budget) ? .met(WaitProbe()) : .notYet(nil)
            } catch is DevToolsDeadline.Exceeded { throw WaitProbeDeadlineExceeded() }
        case .webTitleContains(let fragment):
            let window = try session.resolveDiscoveredWindow(request.window)
            guard let bridge = session.webBridge(for: window.pid) else {
                throw SpaceOError.unsupportedTarget("web_title_contains needs a SpaceO-managed Chromium window")
            }
            if let deadline, waitRuntime.now() >= deadline { throw WaitProbeDeadlineExceeded() }
            do {
                let budget = try deadline.map {
                    try DevToolsDeadline(timeout: $0.timeIntervalSince(waitRuntime.now()))
                }
                let target = try await bridge.currentTarget(budget: budget)
                return target.title.lowercased().contains(fragment.lowercased())
                    ? .met(WaitProbe(matchedTitle: target.title)) : .notYet(nil)
            } catch is DevToolsDeadline.Exceeded { throw WaitProbeDeadlineExceeded() }
        case .stableMs:
            guard waitFrameCapture.isQuiescent else { return .notYet(nil) }
            let foreign: Capture.ForeignContent
            do {
                foreign = try foreignCaptureContent(for: session,
                    remaining: deadline.map { $0.timeIntervalSince(waitRuntime.now()) })
            } catch let stopped as AXTraversalStopped where stopped.reason == .deadline { return .notYet(nil) }
            if let deadline, waitRuntime.now() >= deadline { throw WaitProbeDeadlineExceeded() }
            do {
                let hash = try await waitFrameCapture.hash(
                    stage: session.stage, rect: session.frame, foreign: foreign,
                    timeout: deadline.map { $0.timeIntervalSince(waitRuntime.now()) } ?? WaitPolicy.maximumDeadline,
                    lease: session.beginCaptureWork())
                return .notYet(WaitProbe(frameHash: hash))
            } catch WaitFrameCapture.Failure.timeout { throw WaitProbeDeadlineExceeded() }
            catch WaitFrameCapture.Failure.busy { return .notYet(nil) }
            catch WaitFrameCapture.Failure.invalidImage {
                throw SpaceOError.captureFailed("stability capture did not return the complete requested tile")
            }
        }
    }

    // MARK: - clean (SPAO-153)

    func cleanDisk(dryRun: Bool) throws -> DiskHygieneReport {
        var referenced = Set<String>()
        for session in sessions.values {
            for app in session.apps {
                if let profile = app.temporaryProfile { referenced.insert(profile.path) }
                if let root = app.temporaryControlRoot { referenced.insert(root.path) }
            }
        }
        if let recoveryCoordinator {
            for record in try recoveryCoordinator.detachedRecords() {
                for app in record.apps {
                    if let profile = app.temporaryProfile { referenced.insert(profile.path) }
                    if let root = app.temporaryControlRoot { referenced.insert(root.path) }
                }
            }
        }
        var candidates: [URL] = []
        let roots = Set([FileManager.default.temporaryDirectory.path, "/tmp"]).map { URL(fileURLWithPath: $0, isDirectory: true) }
        for root in roots {
            candidates.append(contentsOf: try DiskHygiene.orphanCandidates(in: root, referenced: referenced, now: Date()))
        }
        let report = DiskHygiene.clean(candidates: candidates, dryRun: dryRun)
        DaemonLog.shared.event("disk.clean", [
            "dryRun": String(dryRun),
            "removed": String(report.removedPaths.count),
            "reclaimedBytes": String(report.reclaimedBytes),
        ])
        return report
    }

    private func cleanDiskResponse(dryRun: Bool) throws -> Response {
        let report = try cleanDisk(dryRun: dryRun)
        var response = Response.success(DiskHygiene.summaryLine(report))
        response.reclaimedBytes = report.reclaimedBytes
        response.removedPaths = report.removedPaths
        response.quarantinedPaths = report.quarantinedPaths.isEmpty ? nil : report.quarantinedPaths
        return response
    }

    // MARK: - Clipboard interception (SPAO-143)

    /// Handle ⌘C / ⌘X / ⌘V through the session broker instead of refusing them. Returns nil when
    /// the combo is not a clipboard shortcut. Never reads or writes `NSPasteboard.general`.
    func brokeredClipboardAction(
        _ combo: KeyCombo,
        request: Request,
        session: AgentSession,
        window: WindowRef
    ) async throws -> (receipt: PasteReceipt, message: String)? {
        guard let intercept = ClipboardRoute.intercept(for: combo) else { return nil }
        let bridge = request.web == true || session.webBridge(for: window.pid) != nil
            ? session.webBridge(for: window.pid) : nil
        switch intercept {
        case .paste:
            guard let text = session.clipboard.get() else {
                throw SpaceOError.badRequest("the session clipboard is empty; call clipboard.set (spaceo_clipboard_set) first. The user's own pasteboard is never read.")
            }
            if let bridge {
                try await bridge.insertText(text)
                return (PasteReceipt(insertedVia: "devtools", bytes: text.utf8.count), "pasted \(text.utf8.count) byte(s) into the page through DevTools")
            }
            _ = try requireKeystrokeTarget(window, in: session, action: "paste into")
            if text.utf8.count <= 32_000, text.count <= 8_000,
               (try? InputRouter.validateTyping(text)) != nil {
                try InputRouter.prepareForInput(window)
                try InputRouter.type(text, to: window.pid)
                return (PasteReceipt(insertedVia: "typing", bytes: text.utf8.count), "pasted \(text.utf8.count) byte(s) by typing into window \(window.windowID)")
            }
            if let element = AXTree.settableFocusedElement(pid: window.pid, inWindow: window.windowID) {
                let current = try AXTree.completeText(of: element, attribute: kAXValueAttribute as String,
                                                      maximumBytes: 32_000, requireValue: true)
                try InputRouter.setValue(element, current + text)
                return (PasteReceipt(insertedVia: "accessibility", bytes: text.utf8.count, note: "appended to the focused field's value; the caret position could not be honoured"),
                        "pasted \(text.utf8.count) byte(s) by setting the focused field's value")
            }
            return (PasteReceipt(insertedVia: "refused", bytes: text.utf8.count, note: "text too long to type and no settable focused field"),
                    "paste refused: \(text.utf8.count) bytes is too long to type and the focused element accepts no value")
        case .copy, .cut:
            let selected: String?
            if let bridge {
                selected = try await bridge.selectionText()
            } else {
                selected = try AXTree.completeSelectedText(pid: window.pid, inWindow: window.windowID)
            }
            guard let selected, !selected.isEmpty else {
                return (PasteReceipt(insertedVia: "refused", bytes: 0, note: "no selection attributable to window \(window.windowID)"),
                        "\(intercept == .copy ? "copy" : "cut") refused: nothing is selected in window \(window.windowID) (rich content and files are out of scope)")
            }
            try session.clipboard.set(selected)
            var message = "copied \(selected.utf8.count) byte(s) of selected text into the session clipboard"
            var note: String?
            if intercept == .cut {
                let deleteCombo = KeyCombo(keyCode: 51, flags: [])
                if let bridge {
                    try await bridge.key(deleteCombo)
                } else {
                    try InputRouter.key(deleteCombo, to: window.pid)
                }
                // A collapsed/changed selection alone cannot prove document deletion.
                // Keep the successful copy receipt even if this follow-up read fails.
                do {
                    let after: String?
                    if let bridge { after = try await bridge.selectionText() }
                    else { after = try AXTree.completeSelectedText(pid: window.pid, inWindow: window.windowID) }
                    note = after == selected ? "deletion not observed; the selection is unchanged"
                        : "selection changed or unavailable; deletion unconfirmed"
                } catch {
                    note = "selection could not be read after delete; deletion unconfirmed"
                }
                message += "; delete sent; \(note ?? "deletion unconfirmed")"
            }
            return (PasteReceipt(insertedVia: bridge == nil ? "accessibility" : "devtools", bytes: selected.utf8.count, note: note), message)
        }
    }
}
