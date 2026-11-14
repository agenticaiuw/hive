// The texts the agent and Hive read back. Hive's bridge parses some of them
// (crates/hive/hive-workspace/src/bridge.rs), so their wording is part of the interface:
//   "[yours] session 'NAME' on whole display N, WxH" and "  input: UNPAUSED | PAUSED (...)"
//   "Isolation: intact|partial|breached" and "- dimension: passed|failed|unknown [observed|inferred|unknown]"
import Foundation

/// A session as the listing shows it.
public struct SessionView: Equatable {
    public var id: String
    public var title: String
    public var displayID: UInt32
    public var width: Int
    public var height: Int
    /// Whether the asking client holds the session.
    public var yours: Bool
    public var inputPaused: Bool
    public var pauseReason: String?
    public var apps: [SessionApp]
    public var idleSeconds: Int
    public var orphanGraceSeconds: Int
    public var ttlSeconds: Int
    public var held: Bool

    public init(id: String, title: String, displayID: UInt32, width: Int, height: Int, yours: Bool,
                inputPaused: Bool, pauseReason: String?, apps: [SessionApp], idleSeconds: Int,
                orphanGraceSeconds: Int, ttlSeconds: Int, held: Bool) {
        self.id = id
        self.title = title
        self.displayID = displayID
        self.width = width
        self.height = height
        self.yours = yours
        self.inputPaused = inputPaused
        self.pauseReason = pauseReason
        self.apps = apps
        self.idleSeconds = idleSeconds
        self.orphanGraceSeconds = orphanGraceSeconds
        self.ttlSeconds = ttlSeconds
        self.held = held
    }
}

/// One line of an isolation audit.
public struct IsolationCheck: Equatable {
    public enum Result: String { case passed, failed, unknown }
    public enum Evidence: String { case observed, inferred, unknown }

    public var name: String
    public var result: Result
    public var evidence: Evidence
    public var note: String

    public init(_ name: String, _ result: Result, _ evidence: Evidence, _ note: String) {
        self.name = name
        self.result = result
        self.evidence = evidence
        self.note = note
    }
}

public enum Reports {
    /// The six things an isolation audit looks at, in the order Hive lists them.
    public static let isolationDimensions = [
        "menu_bar_owner", "window_server_front_process", "key_input_route",
        "text_input_route", "cursor_location", "active_space",
    ]

    public static func inputLine(paused: Bool, reason: String?) -> String {
        guard paused else { return "UNPAUSED" }
        if reason == nil || reason == "operator" { return "PAUSED (operator has Control)" }
        let oneLine = reason!.replacingOccurrences(of: "\n", with: " ").prefix(120)
        return "PAUSED (agent: \(oneLine))"
    }

    public static func listing(_ sessions: [SessionView]) -> String {
        guard !sessions.isEmpty else { return "No workspace sessions." }
        return sessions.map { session in
            var lines = [
                "\(session.yours ? "[yours] " : "")session '\(session.id)' on whole display \(session.displayID), \(session.width)x\(session.height)",
                "  title: \(session.title)",
                "  input: \(inputLine(paused: session.inputPaused, reason: session.pauseReason))",
            ]
            if session.apps.isEmpty {
                lines.append("  apps: none yet (workspace_launch_app or workspace_visit_url opens one)")
            } else {
                lines.append("  apps: " + session.apps.map {
                    "\($0.name)\($0.managedBrowser ? " [managed browser]" : "") (pid \($0.pid))"
                }.joined(separator: ", "))
            }
            let holder = session.yours ? "held by you" : (session.held ? "held by another client" : "not held (claimable)")
            lines.append("  \(holder); idle \(session.idleSeconds)s; ends \(session.orphanGraceSeconds)s after its last client leaves")
            return lines.joined(separator: "\n")
        }.joined(separator: "\n")
    }

    /// intact when every check passed on observed evidence, breached when any failed, else partial.
    public static func verdict(_ checks: [IsolationCheck]) -> String {
        if checks.contains(where: { $0.result == .failed }) { return "breached" }
        if !checks.isEmpty && checks.allSatisfy({ $0.result == .passed && $0.evidence == .observed }) { return "intact" }
        return "partial"
    }

    public static func isolation(_ checks: [IsolationCheck]) -> String {
        var lines = ["Isolation: \(verdict(checks))"]
        for check in checks {
            lines.append("- \(check.name): \(check.result.rawValue) [\(check.evidence.rawValue)] \(check.note)")
        }
        return lines.joined(separator: "\n")
    }
}
