import Foundation
import SpaceOKit
import SwiftUI

/// SPAO-217. One dot per session for the menu bar: red for a breach (a recorded verify
/// failure, or a pause the daemon attributes to one), a raised hand for an agent that paused
/// itself and asked for a person, amber for paused, abandoned or cleaning up, green for a live
/// session taking agent input.
///
/// Declaration order is severity order (`Comparable`): a help request outranks amber because it
/// is the one state in which an agent is blocked on the person looking at this menu, and it
/// stays below a breach, which is a safety signal rather than a request.
enum ViewerSessionStatusDot: Equatable, Comparable, Sendable {
    case green
    case amber
    case needsHuman
    case red

    static func dot(for session: SessionInfo, breached: Bool) -> ViewerSessionStatusDot {
        if breached || session.lifecycleReason?.lowercased().contains("breach") == true {
            return .red
        }
        if ViewerAttention.needsHuman(session) {
            return .needsHuman
        }
        if session.inputPaused == true || session.abandoned == true || session.teardownPending {
            return .amber
        }
        return .green
    }

    var color: Color {
        switch self {
        case .red: .red
        case .needsHuman: .purple
        case .amber: .orange
        case .green: .green
        }
    }

    /// Colour alone never carries the state: the help request also changes the symbol.
    var systemImage: String {
        switch self {
        case .needsHuman: "hand.raised.fill"
        case .red, .amber, .green: "circle.fill"
        }
    }

    var title: String {
        switch self {
        case .red: "breach"
        case .needsHuman: "waiting for you"
        case .amber: "paused or needs attention"
        case .green: "live"
        }
    }
}

/// What the menu bar extra shows without opening the window.
struct ViewerStatusAggregate: Equatable, Sendable {
    var red = 0
    var amber = 0
    var green = 0
    /// Agents that paused themselves and asked for a person (`agentPauseReason`).
    var needsHuman = 0

    var total: Int { red + needsHuman + amber + green }

    var worst: ViewerSessionStatusDot? {
        if red > 0 { return .red }
        if needsHuman > 0 { return .needsHuman }
        if amber > 0 { return .amber }
        if green > 0 { return .green }
        return nil
    }

    /// Only attached sessions count; a detached diagnostic record is not an agent at work.
    static func aggregate(sessions: [SessionInfo], breaches: Set<String>) -> ViewerStatusAggregate {
        var result = ViewerStatusAggregate()
        for session in sessions where session.runtimeAttached != false {
            switch ViewerSessionStatusDot.dot(for: session, breached: breaches.contains(session.id)) {
            case .red: result.red += 1
            case .needsHuman: result.needsHuman += 1
            case .amber: result.amber += 1
            case .green: result.green += 1
            }
        }
        return result
    }

    var badgeText: String { "\(total)" }

    /// The menu bar label leads with the number of agents waiting for the person, because that
    /// is the count that changes what they should do next; the total follows it.
    var labelText: String {
        needsHuman > 0 ? "\(needsHuman)/\(total)" : badgeText
    }

    var accessibilityDescription: String {
        guard total > 0 else { return "SpaceO: no sessions" }
        var parts: [String] = ["SpaceO: \(total) session\(total == 1 ? "" : "s")"]
        if red > 0 { parts.append("\(red) breach\(red == 1 ? "" : "es")") }
        if needsHuman > 0 {
            parts.append("\(needsHuman) waiting for you")
        }
        if amber > 0 { parts.append("\(amber) paused or needing attention") }
        if green > 0 { parts.append("\(green) live") }
        return parts.joined(separator: ", ")
    }
}

extension ViewerModel {
    var statusAggregate: ViewerStatusAggregate {
        .aggregate(sessions: attachedSessions, breaches: isolationBreaches)
    }

    func statusDot(for session: SessionInfo) -> ViewerSessionStatusDot {
        .dot(for: session, breached: isolationBreaches.contains(session.id))
    }
}
