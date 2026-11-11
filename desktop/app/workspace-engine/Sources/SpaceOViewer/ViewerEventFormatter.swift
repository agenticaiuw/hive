import Foundation
import SpaceOKit

/// Daemon events as sentences for the Events inspector.
///
/// The feed used to print every event as sorted `key=value` pairs and mark every verdict and
/// every pause as a warning, so an intact isolation check looked like a problem and the one
/// pause that mattered read the same as routine noise. Each kind the daemon emits gets its own
/// wording and a severity that follows what actually happened. Unknown kinds still render,
/// readably, so a newer daemon never produces a blank row.
enum ViewerEventFormatter {

    struct Formatted: Equatable, Sendable {
        let title: String
        let detail: String
        let severity: ViewerEventSeverity
        /// Agent actions are capped separately so a burst of clicks cannot evict pauses,
        /// breaches, and session changes from the feed.
        let isAgentAction: Bool
    }

    static let maximumDetailLength = 240

    static func format(_ event: DaemonEvent) -> Formatted {
        if event.redacted == true {
            return Formatted(
                title: title(forKind: event.kind),
                detail: "Details hidden: another controller's session.",
                severity: .info,
                isAgentAction: event.kind == "agent.action")
        }
        let detail = event.detail
        func value(_ key: String) -> String? {
            guard let raw = detail[key] else { return nil }
            let line = raw.replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return line.isEmpty ? nil : String(line.prefix(maximumDetailLength))
        }

        switch event.kind {
        case "agent.action":
            return agentAction(value)

        case "isolation.verdict":
            switch value("verdict") {
            case "intact":
                return Formatted(title: "Isolation intact",
                                 detail: "The last check found no effect on your desktop.",
                                 severity: .info, isAgentAction: false)
            case "breached":
                var parts: [String] = []
                if let action = value("action") { parts.append("After the agent's \(action).") }
                if let failures = value("failures") { parts.append(failures) }
                if parts.isEmpty { parts.append("The session reached your desktop, focus, or pointer.") }
                return Formatted(title: "Isolation breached", detail: parts.joined(separator: " "),
                                 severity: .critical, isAgentAction: false)
            case let other:
                return Formatted(
                    title: "Isolation not confirmed",
                    detail: "Verdict: \(other ?? "unknown"). Missing evidence is not a pass.",
                    severity: .warning, isAgentAction: false)
            }

        case "input.paused":
            if value("byOperator") == "true" {
                return Formatted(title: "Agent paused by you",
                                 detail: "Agent input commands are refused until you resume.",
                                 severity: .info, isAgentAction: false)
            }
            if let reason = value("reason") {
                return Formatted(title: "Agent needs you", detail: reason,
                                 severity: .warning, isAgentAction: false)
            }
            return Formatted(title: "Agent paused itself", detail: "No reason given.",
                             severity: .info, isAgentAction: false)

        case "input.resumed":
            let note = value("handoffNote") == "present"
                ? "Agent input accepted again; your hand-back note goes with its next command."
                : "Agent input accepted again."
            return Formatted(title: "Agent resumed", detail: note,
                             severity: .info, isAgentAction: false)

        case "session.created":
            var parts: [String] = []
            if let title = value("title") { parts.append("“\(title)”") }
            if let owner = value("owner") { parts.append("by \(owner)") }
            if let display = value("display") { parts.append("on display \(display)") }
            return Formatted(title: "Session created",
                             detail: parts.isEmpty ? "A new session started." : parts.joined(separator: " "),
                             severity: .info, isAgentAction: false)

        case "session.destroyed":
            let complete = value("complete") == "true"
            return Formatted(
                title: "Session ended",
                detail: complete ? "Its apps were quit and its tile freed."
                    : "Cleanup did not finish; check Health.",
                severity: complete ? .info : .warning, isAgentAction: false)

        case "app.launched":
            let name = value("app") ?? "An app"
            let pid = value("pid").map { " (pid \($0))" } ?? ""
            let failed = value("ok") == "false"
            return Formatted(title: failed ? "App launch failed" : "App launched",
                             detail: "\(name)\(pid)",
                             severity: failed ? .warning : .info, isAgentAction: false)

        case "app.exited":
            let names = value("names")?.split(separator: ",").joined(separator: ", ")
            return Formatted(title: "App quit",
                             detail: names.map { "\($0) is no longer running." }
                                ?? "An app in this session quit.",
                             severity: .warning, isAgentAction: false)

        case "daemon.draining":
            let deadline = value("deadlineSeconds").map { " within \($0)s" } ?? ""
            return Formatted(title: "Daemon draining",
                             detail: "The daemon will restart\(deadline); new sessions are refused.",
                             severity: .warning, isAgentAction: false)

        case "session.annotated":
            let title = value("title").map { "Title “\($0)”" }
            let colour = value("colorTag").map { "colour \($0)" }
            let parts = [title, colour].compactMap { $0 }
            return Formatted(title: "Session renamed",
                             detail: parts.isEmpty ? "Title and colour cleared." : parts.joined(separator: ", "),
                             severity: .info, isAgentAction: false)

        case "operator.action":
            let action = value("action") ?? value("cmd") ?? "input"
            return Formatted(title: "You sent input", detail: action,
                             severity: .info, isAgentAction: false)

        case "recording.stopped":
            return Formatted(title: "Recording stopped",
                             detail: value("reason") ?? "The session recording ended.",
                             severity: .info, isAgentAction: false)

        default:
            let pairs = detail.keys.sorted().compactMap { key in
                value(key).map { "\(humanize(key)): \($0)" }
            }
            return Formatted(
                title: title(forKind: event.kind),
                detail: pairs.isEmpty ? "No details." : String(pairs.joined(separator: " · ")
                    .prefix(maximumDetailLength)),
                severity: .info, isAgentAction: false)
        }
    }

    private static func agentAction(_ value: (String) -> String?) -> Formatted {
        let command = value("cmd") ?? "action"
        let outcome = AgentActionOutcome(wire: value("outcome"))
        var parts: [String] = []
        switch command {
        case "type":
            let count = value("characters") ?? "some"
            parts.append("Typed \(count) character\(count == "1" ? "" : "s")")
        case "key":
            parts.append("Pressed \(value("action") ?? "a key")")
        case "open.url":
            parts.append("Opened \(value("url") ?? "a URL")")
        default:
            var sentence = command.prefix(1).uppercased() + command.dropFirst()
            if let target = value("target") {
                sentence += " “\(target)”"
            } else if let x = value("x"), let y = value("y") {
                sentence += " at \(x), \(y)"
            }
            parts.append(sentence)
        }
        if let outcomeText = value("outcome") { parts.append(outcomeText) }
        return Formatted(
            title: "Agent \(command)",
            detail: parts.joined(separator: " · "),
            severity: outcome == .refused ? .warning : .info,
            isAgentAction: true)
    }

    static func title(forKind kind: String) -> String {
        kind.split(separator: ".").map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// `deadlineSeconds` → "deadline seconds", `windowID` → "window ID".
    private static func humanize(_ key: String) -> String {
        var words: [String] = []
        var current = ""
        var previousWasLowercase = false
        for character in key {
            if character.isUppercase, previousWasLowercase, !current.isEmpty {
                words.append(current)
                current = ""
            }
            current.append(character)
            previousWasLowercase = character.isLowercase
        }
        if !current.isEmpty { words.append(current) }
        return words.map { word in
            // Acronyms keep their case; a capitalised ordinary word does not.
            word.dropFirst().allSatisfy(\.isLowercase) ? word.lowercased() : word
        }.joined(separator: " ")
    }
}

/// "This session / All" in the Events inspector.
enum ViewerEventFilter: String, CaseIterable, Identifiable, Sendable {
    case selectedSession
    case all

    var id: String { rawValue }
    var title: String {
        switch self {
        case .selectedSession: "This Session"
        case .all: "All"
        }
    }

    /// Daemon-wide events (connectivity, density) have no session and stay visible in both
    /// views: they explain what happened to every session, including this one.
    static func apply(_ filter: ViewerEventFilter, to events: [ViewerEvent],
                      selectedSessionID: String?) -> [ViewerEvent] {
        guard filter == .selectedSession, let selectedSessionID else { return events }
        return events.filter { $0.sessionID == nil || $0.sessionID == selectedSessionID }
    }
}
