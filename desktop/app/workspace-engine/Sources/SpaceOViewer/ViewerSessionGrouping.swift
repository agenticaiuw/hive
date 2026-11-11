import Foundation
import SpaceOKit
import SwiftUI

/// SPAO-218. The colour a person can tag a session with in the Viewer. Stored on the session by
/// the daemon (`session.annotate`), so it survives Viewer restarts and shows up in `session list`.
enum ViewerSessionColorTag: String, CaseIterable, Identifiable, Sendable {
    case red, orange, yellow, green, blue, purple, gray

    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    var color: Color {
        switch self {
        case .red: .red
        case .orange: .orange
        case .yellow: .yellow
        case .green: .green
        case .blue: .blue
        case .purple: .purple
        case .gray: .gray
        }
    }

    /// Unknown wire values are ignored rather than trusted as a colour.
    init?(wire: String?) {
        guard let wire, let tag = ViewerSessionColorTag(rawValue: wire.lowercased()) else {
            return nil
        }
        self = tag
    }
}

enum ViewerSessionGrouping {

    /// Sessions under one controller label, in creation order.
    struct Group: Equatable {
        /// Stable key for collapse state; the label when there is one, else a sentinel.
        let key: String
        let label: String
        let sessions: [SessionInfo]

        static func == (lhs: Group, rhs: Group) -> Bool {
            lhs.key == rhs.key && lhs.label == rhs.label
                && lhs.sessions.map(\.id) == rhs.sessions.map(\.id)
        }
    }

    static let unassignedKey = "\u{0}unassigned"
    static let unassignedLabel = "No controller"

    static func displayTitle(_ session: SessionInfo) -> String {
        let trimmed = session.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? session.id : trimmed
    }

    static func showsIdentifier(_ session: SessionInfo) -> Bool {
        displayTitle(session) != session.id
    }

    static func groupLabel(_ session: SessionInfo) -> (key: String, label: String) {
        guard let owner = session.controllerOwner else {
            return (unassignedKey, unassignedLabel)
        }
        let label = owner.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = label.isEmpty ? owner.id : label
        return (shown.lowercased(), shown)
    }

    /// Groups sorted by label, the unassigned group last; sessions inside a group oldest first
    /// so a controller's tasks read in the order it started them.
    ///
    /// One exception outranks both orders: an agent that paused itself to ask for a person
    /// (`ViewerAttention.needsHuman`) sorts to the top of its group, and a group holding one
    /// sorts above the groups that do not. With several agents running, the one waiting on you
    /// is otherwise easy to scroll past.
    static func groups(_ sessions: [SessionInfo]) -> [Group] {
        var order: [String] = []
        var byKey: [String: (label: String, sessions: [SessionInfo])] = [:]
        for session in sessions {
            let (key, label) = groupLabel(session)
            if byKey[key] == nil {
                order.append(key)
                byKey[key] = (label, [])
            }
            byKey[key]?.sessions.append(session)
        }
        return order
            .map { key -> Group in
                let entry = byKey[key]!
                let sorted = entry.sessions.sorted {
                    let lhsWaiting = ViewerAttention.needsHuman($0)
                    if lhsWaiting != ViewerAttention.needsHuman($1) { return lhsWaiting }
                    if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                    return $0.id < $1.id
                }
                return Group(key: key, label: entry.label, sessions: sorted)
            }
            .sorted { lhs, rhs in
                let lhsWaiting = lhs.sessions.contains(where: ViewerAttention.needsHuman)
                if lhsWaiting != rhs.sessions.contains(where: ViewerAttention.needsHuman) {
                    return lhsWaiting
                }
                if lhs.key == unassignedKey { return false }
                if rhs.key == unassignedKey { return true }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
    }

    /// Titles are one line and bounded before they go on the wire.
    static func normalizedTitle(_ raw: String) -> String? {
        let single = raw.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !single.isEmpty else { return nil }
        return String(single.prefix(120))
    }
}
