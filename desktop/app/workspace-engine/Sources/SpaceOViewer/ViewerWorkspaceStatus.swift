import CoreGraphics
import Foundation
import SpaceOKit

// MARK: - Stream health

/// Whether the picture on the canvas is current.
///
/// `ViewerStreamState.live` only says the capture started and has not reported a stop. A
/// capture can stay "live" and deliver nothing — a wedged WindowServer, a display that went to
/// sleep — and the console used to keep saying Live over a frozen frame. Health is derived from
/// when a sample last arrived; ScreenCaptureKit's idle samples count, so a screen that simply
/// did not change is not a stall. Pure, with the clock passed in.
struct ViewerStreamHealth: Equatable, Sendable {
    /// Without a sample for this long the canvas is described as stalled.
    static let stallThreshold: TimeInterval = 3
    /// Frames counted for the rate shown in the status-bar tooltip.
    static let rateWindow: TimeInterval = 2

    enum Status: Equatable, Sendable {
        case idle
        case starting
        case live
        case stalled(secondsSinceUpdate: Int)
        case failed
    }

    let status: Status
    /// Complete frames per second over `rateWindow`; nil unless live.
    let framesPerSecond: Double?

    static func evaluate(
        state: ViewerStreamState,
        lastSampleAt: Date?,
        liveSince: Date?,
        recentFrames: [Date],
        now: Date
    ) -> ViewerStreamHealth {
        switch state {
        case .idle: return ViewerStreamHealth(status: .idle, framesPerSecond: nil)
        case .starting: return ViewerStreamHealth(status: .starting, framesPerSecond: nil)
        case .failed: return ViewerStreamHealth(status: .failed, framesPerSecond: nil)
        case .live: break
        }
        // A stream that went live and has not produced a single sample yet is measured from
        // the moment it went live.
        let reference = [lastSampleAt, liveSince].compactMap { $0 }.max()
        if let reference {
            let silence = now.timeIntervalSince(reference)
            if silence.isFinite, silence >= stallThreshold {
                return ViewerStreamHealth(
                    status: .stalled(secondsSinceUpdate: Int(silence.rounded(.down))),
                    framesPerSecond: 0)
            }
        }
        let windowStart = now.addingTimeInterval(-rateWindow)
        let counted = recentFrames.filter { $0 > windowStart && $0 <= now }.count
        return ViewerStreamHealth(status: .live,
                                  framesPerSecond: Double(counted) / rateWindow)
    }

    var isStalled: Bool {
        if case .stalled = status { return true }
        return false
    }

    var statusText: String {
        switch status {
        case .idle: "Idle"
        case .starting: "Starting"
        case .live: "Live"
        case let .stalled(seconds): "Stalled · last update \(seconds)s ago"
        case .failed: "Failed"
        }
    }

    var tooltip: String {
        switch status {
        case .live:
            let fps = Int((framesPerSecond ?? 0).rounded())
            return fps == 0
                ? "Live · the screen has not changed recently"
                : "Live · \(fps) fps"
        case let .stalled(seconds):
            return "No frame or heartbeat from the capture for \(seconds)s. The picture may be "
                + "out of date; Refresh (⌘R) restarts the stream."
        case .idle: return "No stream"
        case .starting: return "Connecting to the display"
        case .failed: return "The stream failed"
        }
    }
}

// MARK: - Workspace banner

/// One line above the canvas about the daemon itself: offline, reconnecting, draining for a
/// restart, a different version from this Viewer, or restarted underneath the Viewer. Derived
/// purely from what the control plane last said, so it cannot drift from the navigator.
struct ViewerWorkspaceBanner: Equatable, Identifiable, Sendable {
    enum Kind: String, Sendable {
        case offline, reconnecting, restarted, draining, outdated
    }

    let kind: Kind
    let severity: ViewerEventSeverity
    let text: String

    var id: String { kind.rawValue }
    var dismissible: Bool { kind == .restarted }

    static func banners(
        connectivity: ViewerConnectivityState,
        daemon: DaemonRuntimeInfo?,
        daemonRestarted: Bool,
        viewerVersion: String = SpaceOVersion.current
    ) -> [ViewerWorkspaceBanner] {
        switch connectivity {
        case .disconnected:
            return [ViewerWorkspaceBanner(
                kind: .offline, severity: .critical,
                text: "The SpaceO daemon is offline. Sessions and Control are unavailable "
                    + "until it is running again.")]
        case .degraded:
            return [ViewerWorkspaceBanner(
                kind: .reconnecting, severity: .warning,
                text: "Reconnecting to the SpaceO daemon… What you see may be out of date.")]
        case .connecting:
            return []
        case .connected:
            break
        }
        var result: [ViewerWorkspaceBanner] = []
        if daemonRestarted {
            result.append(ViewerWorkspaceBanner(
                kind: .restarted, severity: .warning,
                text: "The daemon restarted; earlier sessions ended."))
        }
        if daemon?.draining == true {
            result.append(ViewerWorkspaceBanner(
                kind: .draining, severity: .warning,
                text: "The daemon is draining for a restart: running sessions continue, new "
                    + "sessions are refused until it comes back."))
        }
        if let running = daemon?.version,
           !running.isEmpty, running != viewerVersion {
            let shown = String(running.prefix(40))
            result.append(ViewerWorkspaceBanner(
                kind: .outdated, severity: .warning,
                text: "The running SpaceO daemon is \(shown); this Viewer is \(viewerVersion) — "
                    + "restart it with `spaceo daemon restart --operator`"))
        }
        return result
    }
}

// MARK: - Key destination

/// Where the person's keystrokes go while they hold Control: the window the input controller
/// targets (the last one clicked, else the stage's front window). Shown in the captured banner
/// so a typed password cannot silently land in an app nobody meant.
struct ViewerKeyDestination: Equatable, Sendable {
    static let maximumTitleLength = 80

    let pid: pid_t
    let windowID: CGWindowID
    let appName: String
    let windowTitle: String
    /// False when the window's app is none of the apps the session reports — a system dialog,
    /// an app another controller launched, or something that wandered onto the stage.
    let isSessionApp: Bool

    var title: String {
        let full = windowTitle.isEmpty ? appName : "\(appName) — \(windowTitle)"
        guard full.count > Self.maximumTitleLength else { return full }
        return String(full.prefix(Self.maximumTitleLength - 1)) + "…"
    }

    var bannerText: String {
        isSessionApp ? "Keys → \(title)" : "Keys → \(title) (not this session's app)"
    }

    static func resolve(
        window: WindowRef,
        sessions: [SessionInfo],
        appName: (pid_t) -> String?
    ) -> ViewerKeyDestination {
        let sessionApp = sessions.lazy.flatMap(\.apps).first { $0.pid == window.pid }
        let name = sessionApp?.name ?? appName(window.pid) ?? "pid \(window.pid)"
        let singleLineTitle = window.title.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ViewerKeyDestination(
            pid: window.pid,
            windowID: window.windowID,
            appName: String(name.prefix(Self.maximumTitleLength)),
            windowTitle: String(singleLineTitle.prefix(Self.maximumTitleLength * 2)),
            isSessionApp: sessionApp != nil)
    }
}
