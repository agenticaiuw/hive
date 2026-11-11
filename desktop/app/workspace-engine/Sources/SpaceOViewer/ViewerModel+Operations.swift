import AppKit
import Foundation
import SpaceOKit

/// Operator-scoped session operations the console offers beyond pause, destroy and Control.
extension ViewerModel {

    // MARK: - Titles and colours (SPAO-218)

    /// Rename or re-colour a session. An empty title clears it; `colorTag` nil leaves the
    /// colour alone and `.some(nil)` is not expressible here on purpose — clearing a colour
    /// sends `"none"`, which the daemon treats as removal.
    func annotateSession(_ id: String, title: String?? = nil, colorTag: ViewerSessionColorTag?? = nil) {
        var request = Request(cmd: "session.annotate")
        request.session = id
        request.operatorScope = true
        if let title {
            request.title = title.flatMap(ViewerSessionGrouping.normalizedTitle) ?? ""
        }
        if let colorTag {
            request.colorTag = colorTag?.rawValue ?? "none"
        }
        guard request.title != nil || request.colorTag != nil else { return }
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "session.annotate failed")
                }
                await MainActor.run { [weak self] in
                    self?.appendEvent(
                        severity: .info,
                        title: "Session annotated",
                        detail: response.message ?? "Title or colour updated.",
                        sessionID: id)
                    self?.refreshControlPlane(afterMutation: true)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure(
                        "Annotation failed", error: error, sessionID: id)
                }
            }
        }
    }

    // MARK: - Walkthrough (SPAO-205)

    var walkthroughInline: Bool {
        !preferences.walkthroughDismissed && connectivity != .disconnected
    }

    func dismissWalkthrough() {
        updatePreferences { $0.walkthroughDismissed = true }
        walkthroughPresented = false
    }

    /// Help ▸ First-Session Walkthrough. Shown as a sheet so it works with sessions present.
    func presentWalkthrough() {
        walkthroughPresented = true
    }

    /// Step 2: the same operator create path as New Session, then `run` the app into the new
    /// session under the lease the create returned. The lease is retained so the poll heartbeats
    /// it, exactly like a plain New Session.
    func createSessionAndLaunch(app: String) {
        guard !walkthroughLaunchInFlight else { return }
        walkthroughLaunchInFlight = true
        let transport = daemonTransport
        let pid = getpid()
        let owner = DurableSessionOwner(
            id: "viewer-\(pid)",
            kind: .viewer,
            label: "SpaceO Viewer",
            processIdentity: ProcessIdentity.current(of: pid))
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var create = Request(cmd: "session.create")
                create.controllerOwner = owner
                let leaseID = UUID()
                create.controllerLeaseID = leaseID
                let created = try transport(create)
                guard created.ok, let session = created.session else {
                    throw SpaceOError.badRequest(created.error ?? "session.create failed")
                }
                await MainActor.run { [weak self] in
                    self?.viewerOwnedLeases[session.id] = leaseID
                    self?.refreshControlPlane(afterMutation: true)
                }
                var run = Request(cmd: "run")
                run.session = session.id
                run.controllerLeaseID = leaseID
                run.app = app
                let launched = try transport(run)
                guard launched.ok else {
                    throw SpaceOError.badRequest(launched.error ?? "run failed")
                }
                await MainActor.run { [weak self] in
                    self?.walkthroughLaunchInFlight = false
                    self?.walkthroughSessionCreated = true
                    self?.appendEvent(
                        severity: .info,
                        title: "Session created",
                        detail: launched.message ?? "Opened \(app) in a new session.",
                        sessionID: session.id)
                    self?.refreshControlPlane(afterMutation: true)
                    self?.selectSession(session.id)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.walkthroughLaunchInFlight = false
                    self?.recordControlPlaneActionFailure("Walkthrough step failed", error: error)
                }
            }
        }
    }

    // MARK: - Notifications (SPAO-215)

    func setNotificationClass(_ notificationClass: ViewerNotificationClass, enabled: Bool) {
        updatePreferences {
            switch notificationClass {
            case .agentNeedsHuman: $0.notifications.agentNeedsHuman = enabled
            case .isolationBreach: $0.notifications.isolationBreach = enabled
            case .sessionAbandoned: $0.notifications.sessionAbandoned = enabled
            case .teardownIncomplete: $0.notifications.teardownIncomplete = enabled
            case .leaseExpiring: $0.notifications.leaseExpiring = enabled
            }
        }
        // Authorization is requested only here: never at launch, never for a class that is off.
        if enabled { notificationPoster?.requestAuthorization() }
    }

    func recordIsolationVerdict(sessionID: String, breached: Bool) {
        if breached { isolationBreaches.insert(sessionID) } else { isolationBreaches.remove(sessionID) }
    }

    func postNotifications(previous: [SessionInfo], current: [SessionInfo], now: Date = Date()) {
        isolationBreaches = isolationBreaches.filter { id in current.contains { $0.id == id } }
        let fired = notificationPolicy.evaluate(
            previous: previous,
            current: current,
            isolationBreaches: isolationBreaches,
            humanHasControl: interactionEnabled,
            enabled: preferences.notifications,
            now: now)
        for notification in fired {
            notificationPoster?.post(notification)
            // Help requests reach the feed from `updateAttentionSignals` whether or not the
            // notification class is on; do not list them twice.
            guard notification.notificationClass != .agentNeedsHuman else { continue }
            appendEvent(
                severity: notification.notificationClass == .leaseExpiring ? .warning : .critical,
                title: notification.title,
                detail: notification.body,
                sessionID: notification.sessionID)
        }
    }

    func setMiniMonitorClickThrough(_ value: Bool) {
        updatePreferences { $0.miniMonitorClickThrough = value }
    }

    // MARK: - Bulk pause (SPAO-217)

    /// Pause or resume every attached session, operator-scoped. Refused while the person holds
    /// Control, like the single-session control. Resume skips agents that paused themselves to
    /// wait for a person (`ViewerAttention.resumeAllPlan`); those are resumed one at a time,
    /// deliberately, or through the hand-back after Take Control.
    func setAllSessionsPaused(_ paused: Bool) {
        guard canChangeAgentPause else {
            note = InputNote(
                text: "Release Input before changing agent pause state.", isWarning: true)
            return
        }
        let ids = paused
            ? attachedSessions.compactMap { $0.inputPaused == true ? nil : $0.id }
            : resumeAllPlan.resumable
        guard !ids.isEmpty else { return }
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            var failures: [String] = []
            for id in ids {
                var request = Request(cmd: "session.control")
                request.session = id
                request.paused = paused
                request.operatorScope = true
                do {
                    let response = try transport(request)
                    guard response.ok else {
                        throw SpaceOError.badRequest(response.error ?? "session.control failed")
                    }
                } catch {
                    failures.append("\(id): \(error.localizedDescription)")
                }
            }
            let reported = failures
            await MainActor.run { [weak self] in
                if reported.isEmpty {
                    self?.appendEvent(
                        severity: .info,
                        title: paused ? "All agents paused" : "All agents resumed",
                        detail: ids.joined(separator: ", "))
                } else {
                    self?.recordControlPlaneActionFailure(
                        paused ? "Pause All failed" : "Resume All failed",
                        error: SpaceOError.badRequest(reported.joined(separator: "; ")))
                }
                self?.refreshControlPlane(afterMutation: true)
            }
        }
    }
}
