import Foundation
import SpaceOKit

/// What one session is doing, in the words every surface of the console uses: the sidebar row,
/// the window subtitle, the canvas footer and the inspector. One precedence, decided here, so
/// two places cannot describe the same session differently.
struct ViewerSessionStatus: Equatable, Sendable {
    enum Kind: Int, Equatable, Comparable, Sendable {
        case idle
        case working
        case paused
        case cleaningUp
        case abandoned
        case youHaveControl
        case needsYou
        case breach

        static func < (lhs: Kind, rhs: Kind) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    /// An agent action newer than this reads as "Working".
    static let workingWindow: TimeInterval = 8

    let kind: Kind
    /// A short label: "Needs you", "Working", "Paused".
    let title: String
    /// One line of context: the agent's own reason, its last action, or its apps.
    let detail: String

    static func of(
        _ session: SessionInfo,
        breached: Bool = false,
        controlled: Bool = false,
        now: Date = Date()
    ) -> ViewerSessionStatus {
        if breached || session.lifecycleReason?.lowercased().contains("breach") == true {
            return ViewerSessionStatus(
                kind: .breach, title: "Isolation breach",
                detail: "An isolation check failed for this session. Review it before continuing.")
        }
        if let reason = ViewerAttention.reason(session) {
            return ViewerSessionStatus(kind: .needsYou, title: "Needs you", detail: reason)
        }
        if controlled {
            return ViewerSessionStatus(
                kind: .youHaveControl, title: "You're in control",
                detail: "The agent is paused until you release control.")
        }
        if session.teardownPending {
            return ViewerSessionStatus(
                kind: .cleaningUp, title: "Cleaning up",
                detail: "Quitting its apps and freeing the display.")
        }
        if session.reclaimable == true || session.abandoned == true {
            return ViewerSessionStatus(
                kind: .abandoned, title: "Abandoned",
                detail: "Its agent disconnected. Clean it up or wait for the agent to return.")
        }
        if session.inputPaused == true {
            return ViewerSessionStatus(
                kind: .paused, title: "Paused", detail: "Agent input is paused.")
        }
        if let at = session.lastAgentActionAt, session.lastAgentAction != nil {
            let elapsed = now.timeIntervalSince(at)
            if elapsed >= -1, elapsed <= workingWindow {
                return ViewerSessionStatus(
                    kind: .working, title: "Working",
                    detail: actionPhrase(session))
            }
        }
        return ViewerSessionStatus(kind: .idle, title: "Idle",
                                   detail: session.windowDiscoveryFailure == nil
                                       ? appsSummary(session) : staleWindowsDetail)
    }

    /// The daemon could not refresh this session's windows; it listed the last-known ones.
    static let staleWindowsDetail = "Windows may be out of date"

    /// "Click · Save" from the last agent action, capitalised for display.
    static func actionPhrase(_ session: SessionInfo) -> String {
        let action = (session.lastAgentAction ?? "action")
            .replacingOccurrences(of: "_", with: " ")
        var parts = [action.prefix(1).uppercased() + action.dropFirst()]
        if let target = session.lastAgentActionTarget?
            .trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty {
            parts.append(String(target.prefix(60)))
        }
        return parts.joined(separator: " · ")
    }

    /// "Safari, Notes +1", the front window's title, or a plain "No apps yet".
    static func appsSummary(_ session: SessionInfo) -> String {
        let names = session.apps.prefix(2).map(\.name)
        if !names.isEmpty {
            return names.joined(separator: ", ")
                + (session.apps.count > 2 ? " +\(session.apps.count - 2)" : "")
        }
        if let window = session.windows.first, !window.title.isEmpty {
            return window.title
        }
        return "No apps yet"
    }
}
