import AppKit
import Foundation
import SpaceOKit

/// The Settings route's panes, in sidebar order.
enum ViewerSettingsPane: String, CaseIterable, Identifiable, Sendable {
    case general
    case agents
    case permissions
    case spaceo
    case displays
    case notifications

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "General"
        case .agents: "Agents"
        case .permissions: "Permissions"
        case .spaceo: "SpaceO Service"
        case .displays: "Virtual Displays"
        case .notifications: "Notifications"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .agents: "sparkles"
        case .permissions: "lock.shield"
        case .spaceo: "server.rack"
        case .displays: "display.2"
        case .notifications: "bell.badge"
        }
    }
}

/// A permission SpaceO needs, and everything the guide says about granting it. Each problem that
/// comes down to a missing grant — a black canvas, a refused Control, an agent that cannot
/// click — leads here, so the person is always told which switch, where, and for which app.
enum ViewerPermissionKind: String, CaseIterable, Identifiable, Sendable {
    case screenRecording
    case accessibility
    case daemonAccessibility
    case daemonScreenRecording

    var id: String { rawValue }

    /// The Viewer's own grants, as opposed to the daemon's.
    var isViewerPermission: Bool {
        self == .screenRecording || self == .accessibility
    }

    var settingName: String {
        switch self {
        case .screenRecording, .daemonScreenRecording: "Screen & System Audio Recording"
        case .accessibility, .daemonAccessibility: "Accessibility"
        }
    }

    var title: String {
        switch self {
        case .screenRecording: "Let the Viewer see sessions"
        case .accessibility: "Let yourself take control"
        case .daemonAccessibility: "Let agents use their apps"
        case .daemonScreenRecording: "Let agents see their screen"
        }
    }

    var reason: String {
        switch self {
        case .screenRecording:
            "macOS only shows an app another app's windows with Screen Recording permission. "
                + "Without it every session is a black rectangle."
        case .accessibility:
            "Taking control sends your mouse and keyboard to the agent's apps. macOS allows that "
                + "only for apps with Accessibility permission."
        case .daemonAccessibility:
            "The SpaceO daemon clicks and types for agents through Accessibility. Without it, "
                + "agents can look but not act."
        case .daemonScreenRecording:
            "The SpaceO daemon takes the screenshots agents read. Without Screen Recording "
                + "permission those come back empty."
        }
    }

    var systemImage: String {
        switch self {
        case .screenRecording, .daemonScreenRecording: "rectangle.dashed.badge.record"
        case .accessibility, .daemonAccessibility: "accessibility"
        }
    }

    /// The Privacy & Security pane anchor.
    var settingsAnchor: String {
        switch self {
        case .screenRecording, .daemonScreenRecording: "Privacy_ScreenCapture"
        case .accessibility, .daemonAccessibility: "Privacy_Accessibility"
        }
    }

    /// Screen Recording applies to a process from its next launch.
    var needsRelaunch: Bool { self == .screenRecording }
}

// MARK: - Routes and guided grants

extension ViewerModel {

    func showSettings(_ pane: ViewerSettingsPane = .general) {
        settingsPane = pane
        windowRequested = true
    }

    func closeSettings() {
        settingsPane = nil
    }

    /// Whether `kind` is granted right now, from what the Viewer and the daemon last reported.
    /// A daemon that has not said counts as granted: absence is not a denial.
    func isGranted(_ kind: ViewerPermissionKind) -> Bool {
        switch kind {
        case .screenRecording: permissions.screenRecording
        case .accessibility: permissions.accessibility
        case .daemonAccessibility: infrastructure.daemon?.accessibilityGranted != false
        case .daemonScreenRecording: infrastructure.daemon?.screenRecordingGranted != false
        }
    }

    /// The app macOS must list for `kind`: the Viewer itself, or whatever started the daemon.
    func grantee(for kind: ViewerPermissionKind) -> String {
        if kind.isViewerPermission {
            return Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? "SpaceO Viewer"
        }
        if let responsible = infrastructure.daemon?.responsibleProcess, !responsible.isEmpty {
            return responsible
        }
        return "the app that started the SpaceO daemon"
    }

    /// Ask macOS first — its one-time prompt is the fastest path while it has never been
    /// answered — and open the guide either way, since after a denial the prompt never returns.
    func guidePermission(_ kind: ViewerPermissionKind) {
        if kind.isViewerPermission, !isGranted(kind) {
            var only = PermissionState(screenRecording: true, accessibility: true)
            if kind == .screenRecording { only.screenRecording = false }
            if kind == .accessibility { only.accessibility = false }
            permissionPrompt(only)
        }
        permissionGuide = kind
    }

    func openSettings(for kind: ViewerPermissionKind) {
        openPrivacySettings(pane: kind.settingsAnchor)
    }

    /// Screen Recording applies from the next launch; this is that launch.
    func relaunchViewer() {
        guard !SpaceOViewerApp.isBackgroundLaunch else { return }
        flushPreferences()
        let reopen = Process()
        reopen.executableURL = URL(fileURLWithPath: "/bin/sh")
        reopen.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
        try? reopen.run()
        NSApp.terminate(nil)
    }

    // MARK: - Virtual displays

    /// End every session on `displayID` and remove the display. Reached through `request`,
    /// which asks first.
    func removeDisplay(_ displayID: UInt32) {
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var request = Request(cmd: "pool.remove")
                request.display = displayID
                request.operatorScope = true
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "pool.remove failed")
                }
                await MainActor.run { [weak self] in
                    self?.appendEvent(
                        severity: .warning,
                        title: "Virtual display removed",
                        detail: response.message ?? "Display \(displayID) was removed.")
                    self?.refresh()
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure("Display removal failed", error: error)
                }
            }
        }
    }

    func sessionCount(onDisplay displayID: UInt32) -> Int {
        sessions.filter { $0.displayID == displayID && $0.runtimeAttached != false }.count
    }
}
