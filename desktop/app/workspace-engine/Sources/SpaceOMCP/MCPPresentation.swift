import Foundation
import SpaceOKit

/// How much of a daemon response one tool result shows.
///
/// A successful click used to return ~1.2 KB of which one line mattered to the model: readiness,
/// a 64-hex geometry token, a display-target JSON with two opaque identifiers, and a seven-row
/// isolation table, every time. Compact rendering keeps each fact that changes what the agent
/// does next and drops the ones that only restate "nothing changed". `verbose` restores all of it.
struct MCPRenderContext {
    /// Show every receipt field, including the per-check isolation table.
    var verbose = false
    /// The daemon command the response answers. Nil (direct test calls) keeps geometry on
    /// non-action responses, the pre-compaction behaviour.
    var command: String?
    var session: String?
    var displayTargetChanged = false
    /// Sessions this connection holds leases for, marked `[yours]` in session listings.
    var ownedSessions: Set<String> = []
    /// Per-call diagnostic trace id, appended to failures so a person can find the call in logs.
    var trace: String?
    /// `menu`: the requested path, and whether the item at its end was pressed (the response
    /// then lists that item's siblings rather than its children).
    var menuPath: [String]?
    var menuPressed = false

    static let `default` = MCPRenderContext()

    /// Observations whose geometry token is an input to the agent's next call.
    static let geometryCommands: Set<String> = ["ax", "ax.find", "windows", "screenshot"]

    /// Geometry tokens stay on observations the agent may pass them back from, and leave action
    /// receipts, where nothing consumes them. Without a command, only actions omit them.
    func showsGeometry(isAction: Bool) -> Bool {
        if verbose { return true }
        guard let command else { return !isAction }
        return Self.geometryCommands.contains(command)
    }
}

/// Presentation arguments a tool call carries next to its daemon arguments. `toolRequest` has
/// already validated both, so parsing here cannot fail; it only reads what was supplied.
struct MCPCallOptions: Equatable {
    enum Observe: String, CaseIterable { case none, diff, full }

    var verbose: Bool
    var observe: Observe

    init(verbose: Bool = false, observe: Observe = .diff) {
        self.verbose = verbose
        self.observe = observe
    }

    init(arguments: [String: Any], connectionVerbose: Bool) {
        verbose = connectionVerbose || (arguments["verbose"] as? Bool ?? false)
        observe = (arguments["observe"] as? String).flatMap(Observe.init(rawValue:)) ?? .diff
    }
}

enum MCPPresentation {

    // MARK: Isolation

    /// Intact → one line. Partial → the summary, the next step, and only the checks that did not
    /// pass. Breached, or verbose → the full per-check table.
    static func isolation(_ report: IsolationReport, verbose: Bool) -> String {
        let covered = report.checks.filter { $0.coverage != .unknown && $0.status != .unknown }.count
        let header: String
        switch report.verdict {
        case .intact:
            header = "isolation: intact (\(covered)/\(report.checks.count) checks covered)"
            if !verbose { return header }
        case .partial:
            header = "isolation: partial — \(report.summarySentence) \(report.nextStepLine)"
        case .breached:
            header = "ISOLATION BREACH — \(report.summarySentence) \(report.nextStepLine)"
        }
        var lines = [header]
        let rows = verbose || report.verdict == .breached
            ? report.checks
            : report.checks.filter { $0.status != .passed }
        for check in rows {
            lines.append("- \(check.dimension.rawValue): \(check.status.rawValue) "
                + "[\(check.coverage.rawValue)] — \(check.evidence)")
            for failure in check.failures {
                lines.append("  failure: \(failure)")
            }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: Actions

    /// `click: confirmed (accessibility-action)`. The outcome leads because it is what the agent
    /// decides on; without one the daemon's completion wording is the honest fallback.
    static func actionLine(_ action: ActionReceipt) -> String {
        let outcome = action.outcome.flatMap { $0.isEmpty ? nil : $0 } ?? action.completion
        return "\(action.command): \(outcome) (\(action.route))"
    }

    // MARK: Durations

    /// `12s`, `4m12s`, `40m`, `1h5m`. Non-finite or negative input renders as `?`.
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0, seconds < 1e9 else { return "?" }
        let total = Int(seconds.rounded())
        if total < 60 { return "\(total)s" }
        if total < 3_600 {
            let minutes = total / 60, rest = total % 60
            return rest == 0 ? "\(minutes)m" : "\(minutes)m\(rest)s"
        }
        let hours = total / 3_600, minutes = (total % 3_600) / 60
        return minutes == 0 ? "\(hours)h" : "\(hours)h\(minutes)m"
    }

    // MARK: Lifecycle receipts

    static let maximumListedNames = 12

    static func names(_ values: [String]) -> String {
        let shown = values.prefix(maximumListedNames).map { MCPDiagnostic.preview($0, maximumBytes: 96) }
        let omitted = values.count - shown.count
        return shown.joined(separator: ", ") + (omitted > 0 ? " and \(omitted) more" : "")
    }

    /// `destroyed 'x' (owner): quit TextEdit, Calculator; released Safari; 4m12s, 37 actions; recording: <path>`
    static func destroySummary(_ summary: DestroySummary, session: String?, verbose: Bool) -> String {
        let subject = session.map { "'\(MCPDiagnostic.preview($0, maximumBytes: 160))'" } ?? "session"
        var parts: [String] = []
        if !summary.quitApps.isEmpty { parts.append("quit " + names(summary.quitApps)) }
        if !summary.forcedApps.isEmpty { parts.append("force-quit " + names(summary.forcedApps)) }
        if !summary.releasedApps.isEmpty { parts.append("released " + names(summary.releasedApps)) }
        if parts.isEmpty { parts.append("no apps to quit") }
        var stats = [duration(summary.durationSeconds)]
        if let count = summary.actionCount { stats.append("\(count) action\(count == 1 ? "" : "s")") }
        parts.append(stats.joined(separator: ", "))
        if let path = summary.recordingPath { parts.append("recording: \(path)") }
        if let error = summary.recordingError { parts.append("recording error: \(error)") }
        if verbose {
            parts.append("clipboard cleared: \(summary.clipboardCleared)")
            parts.append("browser profiles removed: \(summary.profilesRemoved)")
        }
        return "destroyed \(subject) (\(summary.reason)): " + parts.joined(separator: "; ")
    }

    static let maximumListedHolders = 8

    /// `retry after 12s; held by: agent-3 (Claude Code, idle 40m, abandoned — frees in 20s)`
    static func capacity(retryAfter: Double?, holders: [PoolHolder]?) -> String? {
        var parts: [String] = []
        if let retryAfter { parts.append("retry after \(duration(retryAfter))") }
        if let holders, !holders.isEmpty {
            let shown = holders.prefix(maximumListedHolders).map { holder -> String in
                var facts: [String] = []
                if let owner = holder.owner, !owner.isEmpty { facts.append(MCPDiagnostic.preview(owner, maximumBytes: 96)) }
                if let idle = holder.idleSeconds { facts.append("idle \(duration(idle))") }
                else if let age = holder.ageSeconds { facts.append("age \(duration(age))") }
                if holder.abandoned {
                    facts.append("abandoned" + (holder.reclaimableInSeconds.map { " — frees in \(duration($0))" } ?? ""))
                }
                let name = MCPDiagnostic.preview(holder.session, maximumBytes: 160)
                return facts.isEmpty ? name : "\(name) (\(facts.joined(separator: ", ")))"
            }
            let omitted = holders.count - shown.count
            parts.append("held by: " + shown.joined(separator: "; ") + (omitted > 0 ? "; and \(omitted) more" : ""))
        }
        return parts.isEmpty ? nil : parts.joined(separator: "; ")
    }

    static let maximumMenuItems = 200

    /// `[File] New ⌘N` under a path, `[File]` for a top-level menu; `✓` marks a checked item,
    /// `▸` a submenu, and `(disabled)` an item that cannot be pressed now.
    static func menu(_ items: [MenuItemInfo], path: [String]?) -> [String] {
        if items.isEmpty { return ["(no menu items)"] }
        let parent = (path ?? []).prefix(8).map { MCPDiagnostic.preview($0, maximumBytes: 96) }
            .joined(separator: " > ")
        var lines = items.prefix(maximumMenuItems).map { item -> String in
            let title = MCPDiagnostic.preview(item.title, maximumBytes: 160)
            var text = parent.isEmpty ? "[\(title)]" : "[\(parent)] " + (item.checked ? "✓ " : "") + title
            if let shortcut = item.shortcut, !shortcut.isEmpty { text += " \(shortcut)" }
            if item.hasSubmenu { text += " ▸" }
            if !item.enabled { text += " (disabled)" }
            return text
        }
        if items.count > maximumMenuItems { lines.append("… and \(items.count - maximumMenuItems) more item(s)") }
        return lines
    }

    // MARK: CLI-to-MCP translation

    /// CLI command words → the MCP tool that does the same thing. Longest match wins, so
    /// `session list` resolves before a bare `session`.
    static let cliToTool: [(cli: String, tool: String)] = [
        ("session create", "spaceo_session_create"),
        ("session list", "spaceo_session_list"),
        ("session destroy", "spaceo_session_destroy"),
        ("session heartbeat", "spaceo_session_heartbeat"),
        ("session pause", "spaceo_session_pause"),
        ("session resume", "spaceo_session_resume"),
        ("ax find", "spaceo_find"),
        ("ax text", "spaceo_read_text"),
        ("ax", "spaceo_read_screen"),
        ("find", "spaceo_find"),
        ("text", "spaceo_read_text"),
        ("windows", "spaceo_list_windows"),
        ("verify", "spaceo_verify_isolation"),
        ("targets", "spaceo_list_targets"),
        ("target attach", "spaceo_attach_target"),
        ("attach", "spaceo_attach_target"),
        ("screenshot", "spaceo_screenshot"),
        ("click", "spaceo_click"),
        ("type", "spaceo_type"),
        ("key", "spaceo_press_key"),
        ("scroll", "spaceo_scroll"),
        ("move", "spaceo_move"),
        ("drag", "spaceo_drag"),
        ("select", "spaceo_select_text"),
        ("run", "spaceo_open_app"),
        ("open", "spaceo_open_app"),
        ("open-url", "spaceo_open_url"),
        ("wait", "spaceo_wait_for"),
        ("place", "spaceo_place_window"),
        ("adopt", "spaceo_adopt_app"),
        ("pool", "spaceo_pool_status"),
        ("events", "spaceo_events"),
        ("menu", "spaceo_menu"),
    ]

    /// CLI forms an MCP agent cannot run itself; the user has to.
    static let cliForUser: [(cli: String, advice: String)] = [
        ("daemon wait", "wait a few seconds, then retry"),
        ("daemon restart", "ask the user to run `spaceo daemon restart --operator`"),
        ("daemon", "retry once; this MCP server starts the SpaceO daemon when none is running"),
        ("doctor", "ask the user to run `spaceo doctor`"),
        ("setup", "ask the user to run `spaceo setup`"),
    ]

    /// Rewrite a daemon `nextAction` for an MCP reader: `spaceo windows --timeout 10 --help`
    /// becomes `call spaceo_list_windows (timeout: 10)`. Prose that is not a CLI form passes
    /// through with any backticked CLI fragment translated in place.
    static func translateNextAction(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("spaceo ") {
            return translateCLI(String(trimmed.dropFirst("spaceo ".count)))
        }
        return translateBacktickedCLI(in: trimmed, toolsOnly: true)
            .replacingOccurrences(of: " --help", with: "")
    }

    /// Replace `` `spaceo …` `` fragments inside prose with the tool that does the same thing.
    /// With `toolsOnly`, fragments that name no tool stay as written: they are already phrased
    /// as something the user runs, and prose reads naturally around them.
    static func translateBacktickedCLI(in text: String, toolsOnly: Bool) -> String {
        guard text.contains("`spaceo ") else { return text }
        var result = ""
        var remainder = Substring(text)
        while let open = remainder.range(of: "`spaceo ") {
            result += remainder[..<open.lowerBound]
            let after = remainder[open.upperBound...]
            guard let close = after.firstIndex(of: "`") else {
                result += remainder[open.lowerBound...]
                return result
            }
            let command = String(after[..<close])
            if let tool = toolForCLI(command) {
                result += tool.call
            } else if toolsOnly {
                result += remainder[open.lowerBound...close]
            } else {
                result += translateCLI(command)
            }
            remainder = after[after.index(after: close)...]
        }
        return result + remainder
    }

    private static func words(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
    }

    private static func toolForCLI(_ command: String) -> (tool: String, call: String)? {
        let tokens = words(command)
        var best: (tool: String, length: Int)?
        for entry in cliToTool {
            let key = words(entry.cli)
            guard tokens.count >= key.count, Array(tokens.prefix(key.count)) == key,
                  key.count > (best?.length ?? 0) else { continue }
            best = (entry.tool, key.count)
        }
        guard let best else { return nil }
        let arguments = renderFlags(Array(tokens.dropFirst(best.length)))
        return (best.tool, best.tool + (arguments.isEmpty ? "" : " (\(arguments))"))
    }

    private static func translateCLI(_ command: String) -> String {
        if let tool = toolForCLI(command) { return "call " + tool.call }
        let tokens = words(command)
        var best: (advice: String, length: Int)?
        for entry in cliForUser {
            let key = words(entry.cli)
            guard tokens.count >= key.count, Array(tokens.prefix(key.count)) == key,
                  key.count > (best?.length ?? 0) else { continue }
            best = (entry.advice, key.count)
        }
        if let best { return best.advice }
        let visible = tokens.filter { $0 != "--help" && $0 != "--json" }.joined(separator: " ")
        return "ask the user to run `spaceo \(visible)`"
    }

    /// `--timeout 10 --help (inputPaused, operatorHandoff)` → `timeout: 10; inputPaused, operatorHandoff`.
    private static func renderFlags(_ tokens: [String]) -> String {
        var arguments: [String] = []
        var prose: [String] = []
        var index = 0
        while index < tokens.count {
            let token = tokens[index]
            index += 1
            guard token.hasPrefix("--") else { prose.append(token); continue }
            let name = String(token.dropFirst(2)).replacingOccurrences(of: "-", with: "_")
            if name == "help" || name == "json" || name.isEmpty { continue }
            if index < tokens.count, !tokens[index].hasPrefix("--"), !tokens[index].hasPrefix("(") {
                arguments.append("\(name): \(tokens[index])")
                index += 1
            } else {
                arguments.append("\(name): true")
            }
        }
        var text = arguments.joined(separator: ", ")
        let note = prose.joined(separator: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: "()"))
        if !note.isEmpty { text += (text.isEmpty ? "" : "; ") + note }
        return text
    }

    // MARK: Argument forgiveness

    /// Common guesses a model makes for an argument name.
    static let argumentAliases: [String: String] = [
        "session_id": "session", "sessionid": "session", "session_name": "session", "sessionname": "session",
        "element_id": "element", "elementid": "element", "element_index": "element", "index": "element",
        "idx": "element", "ref": "element", "reference": "element",
        "text_value": "text", "textvalue": "text", "input": "text", "string": "text", "content": "text",
        "keys": "key", "key_combo": "key", "combo": "key", "shortcut": "key",
        "window_id": "window", "windowid": "window",
        "snapshot_id": "snapshot", "snapshotid": "snapshot",
        "since_snapshot": "since", "base": "since",
        "application": "app", "app_name": "app", "bundle_id": "app", "bundleid": "app",
        "link": "url", "uri": "url",
        "search": "query", "q": "query",
        "delta_y": "dy", "deltay": "dy", "delta_x": "dx", "deltax": "dx",
    ]

    static let maximumSuggestionInputs = 16
    static let maximumSuggestionBytes = 64

    /// Append `accepted: …` and, where one is close, `did you mean '…'?` to an
    /// unexpected-argument diagnostic. Bounded: at most 16 names are compared, each at most
    /// 64 bytes, so a malicious argument map cannot make this quadratic in its size.
    static func unexpectedArguments<Keys: Collection>(_ keys: Keys, allowed: Set<String>, advertised: Set<String>) -> String?
        where Keys.Element == String {
        guard let base = MCPDiagnostic.unexpected(keys, allowed: allowed) else { return nil }
        var suggestions: [String] = []
        for key in keys.lazy.filter({ !allowed.contains($0) }).prefix(maximumSuggestionInputs) {
            guard let suggestion = suggestion(for: key, allowed: advertised) else { continue }
            let line = "'\(MCPDiagnostic.name(key))' → '\(suggestion)'"
            if !suggestions.contains(line) { suggestions.append(line) }
            if suggestions.count == 3 { break }
        }
        let accepted = advertised.isEmpty ? "none (this tool takes no arguments)" : advertised.sorted().joined(separator: ", ")
        var text = base + "; accepted: " + accepted
        if !suggestions.isEmpty { text += "; did you mean " + suggestions.joined(separator: ", ") + "?" }
        return text
    }

    static func suggestion(for key: String, allowed: Set<String>) -> String? {
        guard key.utf8.count <= maximumSuggestionBytes, !allowed.isEmpty else { return nil }
        let normalized = key.lowercased()
        if let alias = argumentAliases[normalized] ?? argumentAliases[snakeCase(key)], allowed.contains(alias) {
            return alias
        }
        if allowed.contains(snakeCase(key)) { return snakeCase(key) }
        var best: (name: String, distance: Int)?
        for candidate in allowed.sorted() {
            let distance = editDistance(normalized, candidate, limit: 2)
            if distance <= 2, distance < (best?.distance ?? Int.max) { best = (candidate, distance) }
        }
        return best?.name
    }

    static func snakeCase(_ key: String) -> String {
        var result = ""
        for character in key {
            if character.isUppercase, !result.isEmpty { result += "_" }
            result += character.lowercased()
        }
        return result.replacingOccurrences(of: "-", with: "_")
    }

    static func editDistance(_ lhs: String, _ rhs: String, limit: Int) -> Int {
        let a = Array(lhs.unicodeScalars), b = Array(rhs.unicodeScalars)
        if abs(a.count - b.count) > limit { return limit + 1 }
        if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
        var previous = Array(0...b.count)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            var rowMinimum = current[0]
            for j in 1...b.count {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
                rowMinimum = min(rowMinimum, current[j])
            }
            if rowMinimum > limit { return limit + 1 }
            swap(&previous, &current)
        }
        return previous[b.count]
    }

    // MARK: Version drift

    /// The one-time line an agent sees when the daemon it talks to is a different build.
    static func daemonDriftWarning(daemonVersion: String, daemonPID: Int32, clientVersion: String) -> String {
        let daemon = MCPDiagnostic.preview(daemonVersion, maximumBytes: 64)
        let identity = daemon == clientVersion
            ? "a different build of \(daemon) (pid \(daemonPID)) than this MCP server"
            : "\(daemon) (pid \(daemonPID)) but this MCP server is \(clientVersion)"
        return "the running SpaceO daemon is \(identity); some tools will fail until the user runs "
            + "`spaceo daemon restart --operator`."
    }
}
