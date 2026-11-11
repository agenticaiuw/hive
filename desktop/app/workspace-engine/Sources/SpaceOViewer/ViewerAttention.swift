import AppKit
import Foundation
import SpaceOKit

/// "An agent needs you" is the one agent state that blocks on the person. Every surface that
/// ranks, counts, or resumes sessions asks this type, so the navigator order, the menu bar
/// count, the Dock badge, and Resume All cannot disagree about which agents are waiting.
enum ViewerAttention {

    /// An attached agent that paused itself and said why (`agentPauseReason`). A pause the
    /// operator placed by hand carries no reason and is not a request for help.
    static func needsHuman(_ session: SessionInfo) -> Bool {
        guard session.runtimeAttached != false, !session.teardownPending,
              let reason = session.agentPauseReason else { return false }
        return !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The reason as one bounded line for rows, banners, and notifications.
    static func reason(_ session: SessionInfo) -> String? {
        guard needsHuman(session), let reason = session.agentPauseReason else { return nil }
        let line = reason.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(line.prefix(160))
    }

    static func waitingCount(_ sessions: [SessionInfo]) -> Int {
        sessions.filter(needsHuman).count
    }

    /// "Checkout needs you: needs 2FA code"
    static func headline(_ session: SessionInfo) -> String {
        let title = ViewerSessionGrouping.displayTitle(session)
        guard let reason = reason(session) else { return title }
        return "\(title) needs you: \(reason)"
    }

    // MARK: - Resume All

    /// Resume All must not resume an agent that stopped to wait for a person: doing so clears
    /// its reason and lets it carry on past the thing it asked a human to do (a 2FA code, a
    /// CAPTCHA). Those are left paused and counted in the label instead.
    struct ResumeAllPlan: Equatable {
        let resumable: [String]
        let waiting: Int

        var isEmpty: Bool { resumable.isEmpty }

        var title: String {
            guard !resumable.isEmpty else {
                return waiting > 0 ? "Resume All Agents · \(waiting) waiting for you"
                    : "Resume All Agents"
            }
            let count = resumable.count
            let base = "Resume \(count) Agent\(count == 1 ? "" : "s")"
            return waiting > 0 ? "\(base) · \(waiting) waiting for you" : base
        }
    }

    static func resumeAllPlan(_ sessions: [SessionInfo]) -> ResumeAllPlan {
        let attached = sessions.filter { $0.runtimeAttached != false }
        let paused = attached.filter { $0.inputPaused == true }
        return ResumeAllPlan(
            resumable: paused.filter { !needsHuman($0) }.map(\.id).sorted(),
            waiting: paused.filter(needsHuman).count)
    }
}

extension ViewerControlPolicy {
    /// Which sessions Take Control has to pause itself.
    ///
    /// A running agent obviously. An agent that paused *itself* too: its pause is its own, and
    /// the daemon lets it lift that pause at any moment — including while the person is typing
    /// the 2FA code it asked for. An operator pause over it takes priority, keeps its reason, and
    /// is only lifted by the hand-back. The one pause left alone is one the operator placed by
    /// hand (paused, no reason): it is already the operator's, and it was not placed for this
    /// Control, so releasing Control must not undo it.
    static func pausesForControl(_ session: SessionInfo) -> Bool {
        session.inputPaused != true || session.agentPauseReason != nil
    }

    /// Whether the console window losing key status should end Control.
    ///
    /// Losing key normally means the person went somewhere else and must get their Mac back.
    /// A prompt the Viewer itself raised in response to the person's own chord (the inline paste
    /// confirmation) is not "somewhere else": ending Control under it would drop the very input
    /// the prompt is waiting for. App deactivation still releases unconditionally.
    static func releasesOnResignKey(pendingPrompt: Bool) -> Bool {
        !pendingPrompt
    }
}

extension ViewerAccessibility {
    /// What VoiceOver reads for a session row or tile: the title a person gave it (not only the
    /// id), whether it is waiting for them or paused, recent activity, then ownership.
    static func sessionLabel(
        _ session: SessionInfo,
        breached: Bool = false,
        recentActions: Int = 0,
        now: Date = Date()
    ) -> String {
        var parts: [String] = []
        let title = ViewerSessionGrouping.displayTitle(session)
        parts.append(ViewerSessionGrouping.showsIdentifier(session)
            ? "\(title), session \(session.id)." : "Session \(session.id).")
        if breached {
            parts.append("Isolation breach reported.")
        }
        if let reason = ViewerAttention.reason(session) {
            parts.append("Agent needs you: \(reason).")
        } else if session.inputPaused == true {
            parts.append("Agent input paused.")
        }
        if recentActions > 0 {
            parts.append("\(recentActions) agent action\(recentActions == 1 ? "" : "s") in the "
                + "last minute.")
        }
        let presentation = ViewerSessionPresentation(session: session, now: now)
        if let badge = presentation.badge { parts.append("Status: \(badge.title).") }
        if let owner = presentation.ownerText { parts.append("\(owner).") }
        if let timing = presentation.timingText { parts.append("\(timing).") }
        return parts.joined(separator: " ")
    }

    /// Said when the session on the canvas ends underneath the person.
    static func selectionEndedAnnouncement(endedTitle: String, replacementTitle: String?) -> String {
        if let replacementTitle {
            return "\(endedTitle) ended. Now showing \(replacementTitle)."
        }
        return "\(endedTitle) ended. No session selected."
    }

    static func recentActionCount(_ timestamps: [Date], now: Date = Date()) -> Int {
        timestamps.filter { now.timeIntervalSince($0) <= 60 && $0 <= now }.count
    }
}

/// Keyboard navigation between sessions (Session menu). Pure so the order, the wrap-around and
/// the attention pick are pinned by tests rather than by what the navigator happens to render.
enum ViewerSessionNavigation {

    /// Navigator order: the same grouping and in-group order the sidebar shows, detached
    /// recovery records excluded (they cannot be selected as a canvas).
    static func order(_ sessions: [SessionInfo]) -> [String] {
        ViewerSessionGrouping.groups(sessions.filter { $0.runtimeAttached != false })
            .flatMap { $0.sessions.map(\.id) }
    }

    /// The session `offset` steps from `current`, wrapping. With nothing selected, forward
    /// starts at the first session and backward at the last.
    static func step(from current: String?, by offset: Int, in order: [String]) -> String? {
        guard !order.isEmpty else { return nil }
        guard let current, let index = order.firstIndex(of: current) else {
            return offset >= 0 ? order.first : order.last
        }
        let count = order.count
        let next = ((index + offset) % count + count) % count
        return order[next]
    }

    /// ⌃1–⌃9. One-based; nil past the end.
    static func session(atShortcut number: Int, in order: [String]) -> String? {
        guard (1...9).contains(number), number <= order.count else { return nil }
        return order[number - 1]
    }

    /// Go to Session Needing Attention: a help request first, then anything else that is not
    /// plainly live (breach, abandoned, cleanup, paused). Within the best tier the pick moves
    /// on from the current selection, so pressing it again cycles instead of sticking.
    static func attentionTarget(
        _ sessions: [SessionInfo],
        breaches: Set<String>,
        current: String?
    ) -> String? {
        let order = order(sessions)
        let byID = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func tier(_ id: String) -> Int? {
            guard let session = byID[id] else { return nil }
            switch ViewerSessionStatusDot.dot(for: session, breached: breaches.contains(id)) {
            case .needsHuman: return 0
            case .red: return 1
            case .amber: return 2
            case .green: return nil
            }
        }
        guard let best = order.compactMap(tier).min() else { return nil }
        let candidates = order.filter { tier($0) == best }
        guard let current, let index = order.firstIndex(of: current) else {
            return candidates.first
        }
        let rotated = order[(index + 1)...] + order[...index]
        return rotated.first { candidates.contains($0) }
    }
}
