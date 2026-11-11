import AppKit
import Foundation
import SpaceOKit

enum ViewerConnectivityState: Equatable, Sendable {
    case connecting
    case connected
    case degraded
    case disconnected

    var title: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .degraded: "Connection interrupted"
        case .disconnected: "Daemon offline"
        }
    }

    var systemImage: String {
        switch self {
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .connected: "checkmark.circle.fill"
        case .degraded: "bolt.horizontal.circle.fill"
        case .disconnected: "xmark.circle.fill"
        }
    }
}

enum ViewerEventSeverity: Int, Comparable, Sendable {
    case info
    case warning
    case critical

    static func < (lhs: ViewerEventSeverity, rhs: ViewerEventSeverity) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

struct ViewerEvent: Identifiable, Sendable {
    let id = UUID()
    let timestamp: Date
    let severity: ViewerEventSeverity
    let title: String
    let detail: String
    let sessionID: String?
    /// Routine agent input. Capped separately from everything else (see `appendEvent`).
    var isAgentAction = false
}

enum ViewerHealthAction: Equatable, Sendable {
    case requestPermissions
    case openScreenRecordingSettings
    case openAccessibilitySettings
    case retryStream
    case refreshDaemon
    case startDaemon
    case selectSession(String)
    case destroySession(String)
    case reclaimSession(String)
    case pauseSession(String)
    case resumeSession(String)
    /// End every session on a SpaceO virtual display and remove the display.
    case removeDisplay(UInt32)
    case guidePermission(ViewerPermissionKind)

    /// Actions that quit apps and cannot be undone. Every entry point — Health, the sidebar's
    /// recovery rows, the toolbar, the Session menu — goes through the same confirmation, so a
    /// one-click "Reclaim" can no longer do what "Destroy Session…" asks about first.
    var requiresConfirmation: Bool {
        switch self {
        case .destroySession, .reclaimSession, .removeDisplay: true
        default: false
        }
    }

    var sessionID: String? {
        switch self {
        case let .destroySession(id), let .reclaimSession(id), let .selectSession(id),
             let .pauseSession(id), let .resumeSession(id):
            id
        default:
            nil
        }
    }

    func confirmationTitle(sessionTitle: String) -> String {
        switch self {
        case .reclaimSession: "Clean up \(sessionTitle)?"
        case .removeDisplay: "Remove \(sessionTitle)?"
        default: "End \(sessionTitle)?"
        }
    }

    var confirmationButton: String {
        switch self {
        case .reclaimSession: "Clean Up Session"
        case .removeDisplay: "Remove Display"
        default: "End Session"
        }
    }

    var confirmationMessage: String {
        switch self {
        case .removeDisplay:
            "Every session on this virtual display ends, and SpaceO quits the apps it opened "
                + "for them. Unsaved work in those apps is lost. A new display is created the next "
                + "time an agent needs one."
        case .reclaimSession:
            "SpaceO will quit the apps it launched for this session, remove its leftover "
                + "windows and display state, and forget it. Unsaved work in those apps is lost. "
                + "Other sessions and the daemon keep running."
        default:
            "SpaceO quits the apps it opened for this session and frees its space on the "
                + "virtual display. Unsaved work in those apps is lost. Other sessions keep running."
        }
    }
}

/// A missing permission has two very different remedies: the one-click system prompt, which only
/// macOS can raise and only while it has never been answered, and the manual System Settings
/// walk that remains after a denial. An alert therefore carries both, primary first.
struct ViewerHealthAlert: Identifiable, Equatable, Sendable {
    let id: String
    let severity: ViewerEventSeverity
    let title: String
    let detail: String
    let actionTitle: String?
    let action: ViewerHealthAction?
    var secondaryActionTitle: String?
    var secondaryAction: ViewerHealthAction?
}

/// A toolbar screenshot ends in a file the user cannot see from the console, or in an error that
/// used to be written to a property no view read. Either way the outcome has to reach a view.
enum ViewerScreenshotResult: Equatable, Sendable {
    case saved(URL)
    case failed(String)

    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }

    var message: String {
        switch self {
        case let .saved(url): "Screenshot saved to \(url.path)"
        case let .failed(reason): "Screenshot failed: \(reason)"
        }
    }
}

enum ViewerCanvasMode: String, CaseIterable, Identifiable, Sendable {
    case session
    case display

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

enum ViewerInspectorSection: String, CaseIterable, Identifiable, Sendable {
    case overview
    case apps
    case windows
    case health
    case infrastructure
    case events

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var systemImage: String {
        switch self {
        case .overview: "sidebar.right"
        case .apps: "app.dashed"
        case .windows: "macwindow.on.rectangle"
        case .health: "cross.case"
        case .infrastructure: "server.rack"
        case .events: "list.bullet.rectangle"
        }
    }
}

struct ViewerInfrastructureSnapshot: Sendable {
    var displays: [DisplayPool.DisplayReport] = []
    var sessionsPerDisplay: Int?
    var usage: ResourceBudget.Usage?
    var limits: ResourceLimitsReport?
    var message: String?
    var daemon: DaemonRuntimeInfo?

    var configuredDensity: Int {
        sessionsPerDisplay ?? displays.first?.capacity ?? 1
    }

    var totalCapacity: Int {
        displays.reduce(0) { $0 + $1.capacity }
    }

    var usedCapacity: Int {
        displays.reduce(0) { $0 + $1.used }
    }
}

enum ViewerSessionSearch {
    static func matches(_ session: SessionInfo, query: String) -> Bool {
        let terms = query
            .split(whereSeparator: \.isWhitespace)
            .map { $0.lowercased() }
        guard !terms.isEmpty else { return true }

        let owner = session.controllerOwner.map {
            "\($0.id) \($0.label) \(String(describing: $0.kind))"
        } ?? ""
        let haystack = (
            [
                session.id,
                owner,
                session.apps.map { "\($0.name) \($0.bundleID ?? "") \($0.pid)" }
                    .joined(separator: " "),
                session.windows.map { "\($0.title) \($0.windowID) \($0.pid)" }
                    .joined(separator: " "),
                session.reclaimable == true ? "reclaimable" : "",
                session.abandoned == true ? "abandoned" : "",
                session.teardownPending ? "cleanup pending" : "",
            ].joined(separator: " ")
        ).lowercased()
        return terms.allSatisfy(haystack.contains)
    }
}

/// Locates the CLI helper for daemon lifecycle actions without assuming an installation path.
enum ViewerDaemonExecutable {
    static func resolve(
        bundle: Bundle = .main,
        executableURL: URL? = Bundle.main.executableURL
    ) -> URL? {
        let bundled = bundle.bundleURL
            .appendingPathComponent("Contents/Helpers/spaceo", isDirectory: false)
        if FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        if let executableURL {
            let sibling = executableURL.deletingLastPathComponent()
                .appendingPathComponent("spaceo", isDirectory: false)
            if FileManager.default.isExecutableFile(atPath: sibling.path) {
                return sibling
            }
        }
        return nil
    }
}
