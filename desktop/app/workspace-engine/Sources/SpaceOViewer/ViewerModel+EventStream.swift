import Foundation
import SpaceOKit

/// The Viewer's subscription to the daemon event stream (SPAO-214).
///
/// Polling every two seconds stays in place as the fallback; the stream exists so an agent's
/// click, a pause, or a breach reaches the human as it happens rather than up to two seconds
/// later. Every event both lands in the feed and nudges a control-plane refresh, so the session
/// rows (and the canvas overlay they drive) update immediately.
extension ViewerModel {

    static let eventStreamMaximumReconnectDelay: TimeInterval = 30

    /// Invalidate both queued main-actor work and the old socket reader before replacement.
    func prepareEventStream() -> (mailbox: ViewerEventMailbox, generation: UInt64) {
        eventStreamGeneration &+= 1
        eventStreamReconnectTask?.cancel()
        eventStreamReconnectTask = nil
        eventStreamMailbox?.stop()
        eventSubscription?.cancel()
        eventSubscription = nil
        let mailbox = ViewerEventMailbox()
        eventStreamMailbox = mailbox
        return (mailbox, eventStreamGeneration)
    }

    func startEventStream() {
        // A preview is fixtures only; the real daemon's events must not reach it.
        guard ViewerPreviewScenario.current == nil else { return }
        let (mailbox, generation) = prepareEventStream()
        let schedule: @Sendable () -> Void = { [weak self] in
            Task { @MainActor [weak self] in
                self?.consumeEventStream(mailbox, generation: generation)
            }
        }
        var request = Request(cmd: "events.subscribe")
        request.operatorScope = true
        request.sinceSeq = 0
        eventSubscription = Transport.subscribe(
            to: Wire.socketPath(), sinceSeq: 0, request: request,
            onResponse: { response in mailbox.offer(response, schedule: schedule) },
            onClose: { _ in mailbox.finish(schedule: schedule) })
    }

    func consumeEventStream(_ mailbox: ViewerEventMailbox, generation: UInt64) {
        guard generation == eventStreamGeneration, mailbox === eventStreamMailbox else {
            mailbox.stop()
            return
        }
        guard let batch = mailbox.take() else { return }
        if batch.receivedOK {
            eventStreamConnected = true
            var response = Response(ok: true)
            response.events = batch.events
            response.resyncRequired = batch.resyncRequired
            ingest(response)
        }
        if batch.closed { scheduleEventStreamReconnect(generation: generation) }
    }

    func scheduleEventStreamReconnect(generation: UInt64) {
        guard generation == eventStreamGeneration else { return }
        // From here until the next batch, the poll delta is the only source of agent actions.
        eventStreamConnected = false
        eventSubscription = nil
        eventStreamReconnectAttempts = min(eventStreamReconnectAttempts, 4) + 1
        let delay = min(Self.eventStreamMaximumReconnectDelay,
                        pow(2, Double(eventStreamReconnectAttempts)))
        eventStreamReconnectTask?.cancel()
        eventStreamReconnectTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            catch { return }
            guard let self, generation == self.eventStreamGeneration,
                  self.eventSubscription == nil else { return }
            self.eventStreamReconnectTask = nil
            self.startEventStream()
        }
    }

    func ingest(_ response: Response) {
        guard response.ok else { return }
        eventStreamReconnectAttempts = 0
        var needsRefresh = response.resyncRequired == true
        for event in response.events ?? [] {
            ingest(event)
            if event.kind != "operator.action" { needsRefresh = true }
        }
        if response.resyncRequired == true {
            appendEvent(severity: .warning, title: "Event history incomplete",
                        detail: "Some event history is unavailable. Refreshing session state; isolation has not been reverified.")
        }
        if needsRefresh {
            refreshControlPlane()
        }
    }

    /// One event into the feed and the notification policy. Redacted events keep their kind
    /// and session so activity still registers without disclosing another controller's detail.
    func ingest(_ event: DaemonEvent) {
        if event.kind == "isolation.verdict", event.redacted != true, let session = event.session {
            switch event.detail["verdict"] {
            case "breached": recordIsolationVerdict(sessionID: session, breached: true)
            case "intact": recordIsolationVerdict(sessionID: session, breached: false)
            default: break // Missing/partial evidence must not clear an observed breach.
            }
        }
        // A help request is listed by `updateAttentionSignals` when the refresh this event
        // triggers shows the paused session; listing the raw event too would say it twice.
        if event.kind == "input.paused", event.redacted != true,
           event.detail["byOperator"] != "true",
           !(event.detail["reason"] ?? "").isEmpty {
            return
        }
        let formatted = ViewerEventFormatter.format(event)
        appendEvent(severity: formatted.severity, title: formatted.title,
                    detail: formatted.detail, sessionID: event.session,
                    isAgentAction: formatted.isAgentAction)
    }
}
