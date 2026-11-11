import AppKit
import Foundation
import SpaceOKit

/// Getting the person to the session that needs them, and telling them where their input goes
/// once they are there: help requests, the Dock badge, notification deep links, keyboard
/// navigation, the daemon banner, and the key destination.
extension ViewerModel {

    // MARK: - Help requests

    /// The Dock badge and the VoiceOver announcement for help requests. Runs on every
    /// control-plane update; both are idempotent against the previous state. Posted
    /// notifications are the policy's job and have their own opt-out; these two are in-app
    /// signals that cost nothing when nobody is waiting.
    func updateAttentionSignals(previous: [SessionInfo]) {
        let waiting = attachedSessions.filter(ViewerAttention.needsHuman)
        let badge = waiting.isEmpty ? nil : "\(waiting.count)"
        if badge != lastDockBadgeValue {
            lastDockBadgeValue = badge
            setDockBadge(badge)
        }
        var current: Set<String> = []
        for session in waiting {
            let key = "\(session.id)|\(ViewerAttention.reason(session) ?? "")"
            current.insert(key)
            guard !announcedHelpRequestKeys.contains(key) else { continue }
            accessibilityAnnouncement(ViewerAttention.headline(session))
            appendEvent(severity: .warning, title: "Agent needs you",
                        detail: ViewerAttention.reason(session) ?? "",
                        sessionID: session.id)
        }
        // Forget requests that ended, so the same reason asked again later is announced again.
        announcedHelpRequestKeys = current
    }

    /// Whether a Take Control button for this session (its tile, banner, menu bar row) can
    /// do anything. A session that is not on the canvas yet qualifies: it is selected first.
    func canTakeControl(of sessionID: String) -> Bool {
        guard !interactionEnabled, pendingHandoff == nil,
              permissions.screenRecording, permissions.accessibility,
              sessions.contains(where: { $0.id == sessionID && $0.runtimeAttached != false })
        else { return false }
        if selectedSessionID == sessionID, canvasMode == .session {
            return controlAvailable || streamState == .starting
        }
        return true
    }

    // MARK: - Resume All

    var resumeAllPlan: ViewerAttention.ResumeAllPlan {
        ViewerAttention.resumeAllPlan(attachedSessions)
    }

    // MARK: - Notification deep links

    /// A notification was clicked. Selects its session, opens the section, and asks for a
    /// window — a menu-bar-only launch has none, and without one the click did nothing visible.
    /// A help request's own "Take Control" button also takes Control, through the ordinary
    /// deferred path (after the stream for that session is live).
    func handleNotificationAction(_ action: ViewerNotificationAction) {
        let attached = sessions.contains { $0.id == action.sessionID && $0.runtimeAttached != false }
        if attached {
            settingsPane = nil
            selectSession(action.sessionID)
        }
        showInspector(action.section)
        windowRequested = true
        if attached, action.takeControl {
            takeControl(for: action.sessionID)
        }
    }

    func handleNotificationAction(session: String, section: ViewerInspectorSection) {
        handleNotificationAction(ViewerNotificationAction(sessionID: session, section: section))
    }

    /// The window opener calls this once it has put a console window on screen.
    func acknowledgeWindowRequest() {
        windowRequested = false
    }

    // MARK: - Keyboard navigation (Session menu)

    var navigationOrder: [String] { ViewerSessionNavigation.order(attachedSessions) }

    func selectAdjacentSession(_ offset: Int) {
        settingsPane = nil
        guard let id = ViewerSessionNavigation.step(
            from: canvasMode == .session ? selectedSessionID : nil,
            by: offset, in: navigationOrder) else { return }
        selectSession(id)
    }

    func selectSession(atShortcut number: Int) {
        settingsPane = nil
        guard let id = ViewerSessionNavigation.session(atShortcut: number, in: navigationOrder) else {
            return
        }
        selectSession(id)
    }

    var sessionNeedingAttention: String? {
        ViewerSessionNavigation.attentionTarget(
            attachedSessions, breaches: isolationBreaches, current: selectedSessionID)
    }

    func goToSessionNeedingAttention() {
        guard let id = sessionNeedingAttention else { return }
        settingsPane = nil
        selectSession(id)
    }

    func toggleSelectedAgentPause() {
        guard let session = selectedSession else { return }
        setSessionPaused(session.id, paused: session.inputPaused != true)
    }

    func requestDestroySelectedSession() {
        guard let session = selectedSession else { return }
        request(.destroySession(session.id))
    }

    // MARK: - Daemon banner

    var workspaceBanners: [ViewerWorkspaceBanner] {
        ViewerWorkspaceBanner.banners(
            connectivity: connectivity,
            daemon: infrastructure.daemon,
            daemonRestarted: daemonRestarted)
    }

    func dismissDaemonRestartBanner() {
        clearDaemonRestarted()
    }

    // MARK: - Key destination

    /// Resolve where keys go the moment Control starts, before the person has clicked anything:
    /// the input controller falls back to the stage's front window, so that is the answer.
    func resolveKeyDestination() {
        guard interactionEnabled, let provider = frontWindowProviderForDestination,
              let bounds = interactionDisplay?.bounds else { return }
        guard let window = provider(bounds) else {
            keyDestination = nil
            return
        }
        keyTargetChanged(window)
    }

    /// The input controller moved the key target (a click in another window, or its fallback
    /// after a window closed).
    func keyTargetChanged(_ window: WindowRef) {
        guard interactionEnabled else { return }
        let candidates = canvasMode == .session
            ? selectedSession.map { [$0] } ?? []
            : sessionsOnSelectedDisplay
        let destination = ViewerKeyDestination.resolve(
            window: window, sessions: candidates, appName: appNameForDestination)
        guard destination != keyDestination else { return }
        let previous = keyDestination
        keyDestination = destination
        if !destination.isSessionApp, previous?.pid != destination.pid {
            let warning = "Keys now go to \(destination.title), which is not one of this "
                + "session's apps."
            note = InputNote(text: warning, isWarning: true)
            accessibilityAnnouncement(warning)
        }
    }

    // MARK: - Sheets

    /// The one sheet the console shows. SwiftUI presents a single sheet per view; separate
    /// `.sheet` modifiers competed and one could be silently dropped. Priority: the hand-back
    /// (agents are paused behind it) first, then a file drop, then the walkthrough.
    enum ActiveSheet: Identifiable, Equatable {
        case handoff(PendingHandoff)
        case fileDrop(PendingFileDrop)
        case permissionGuide(ViewerPermissionKind)
        case walkthrough

        var id: String {
            switch self {
            case let .handoff(value): "handoff-\(value.id)"
            case let .fileDrop(value): "drop-\(value.id)"
            case let .permissionGuide(kind): "permission-\(kind.rawValue)"
            case .walkthrough: "walkthrough"
            }
        }
    }

    var activeSheet: ActiveSheet? {
        if let pendingHandoff { return .handoff(pendingHandoff) }
        if let pendingFileDrop { return .fileDrop(pendingFileDrop) }
        if let permissionGuide { return .permissionGuide(permissionGuide) }
        if walkthroughPresented { return .walkthrough }
        return nil
    }

    /// The sheet went away without an answer (Escape, window close). A hand-back is a skip:
    /// agents must never stay paused behind a sheet nobody answered.
    func dismissSheet(_ sheet: ActiveSheet) {
        switch sheet {
        case .handoff: completeHandoff(note: nil)
        case .fileDrop: cancelOpenFiles()
        case .permissionGuide: permissionGuide = nil
        case .walkthrough: walkthroughPresented = false
        }
    }

    // MARK: - Production seams

    /// The stage's front window, as the input controller would pick it.
    static let productionFrontWindow: FrontWindowProvider = { bounds in
        MirrorInput.frontWindow(on: bounds, excluding: MirrorInput.selfExcludedPIDs)
    }

    static let productionDockBadge: (String?) -> Void = { label in
        NSApp?.dockTile.badgeLabel = label
    }
}
