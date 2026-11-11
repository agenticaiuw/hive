import Foundation

// Per-command help, shell completions, and command-line validation, all derived from `CLISpec`
// so a command added to the flag table is covered by every one of them without a second edit.

extension CLISpec {
    /// One line per flag for `spaceo <command> --help` and shell completions. A flag whose meaning
    /// depends on the command gets an entry in `CLIHelp.flagHelpOverrides` instead of a vaguer
    /// sentence here. `CLIHelpTests` fails when a classified flag has no line.
    public static let flagHelp: [String: String] = [
        // Global
        "json": "print exactly one JSON object on stdout (progress goes to stderr)",
        "socket": "daemon socket path (default: $SPACEO_SOCKET or the per-user socket)",
        "session": "target session id (default: $SPACEO_SESSION)",
        "lease": "controller lease UUID from session create/heartbeat (default: $SPACEO_LEASE)",
        "operator": "act across every controller's sessions; coordinate with their owners first",
        "help": "show this help",
        "h": "show this help",
        "timeout": "bounded wait in seconds",
        "yes": "do not prompt; assume yes",
        "print": "print what would be written or run, and change nothing",
        "apply": "make the change instead of listing it (requires sudo where noted)",
        // Session lifecycle
        "name": "alias for --session",
        "controller-id": "stable controller identity for this session's owner",
        "controller-label": "human-readable owner label shown in session list and the Viewer",
        "controller-kind": "owner kind: cli, mcp, viewer, or other",
        "controller-ttl": "lease lifetime without activity, \(Int(SessionReclamationPolicy.clientTTLRange.lowerBound)) through \(Int(SessionReclamationPolicy.clientTTLRange.upperBound)) seconds",
        "app": "application name or path to launch",
        "preset": "display preset: " + DisplayPool.presets.joined(separator: ", "),
        "title": "session title shown in the Viewer",
        "color": "session color tag: red, orange, yellow, green, blue, purple, or gray",
        "record": "record the session: actions, or actions+frames",
        "mute-audio": "launch managed Chromium muted",
        "export": "print `export SPACEO_SESSION=… SPACEO_LEASE=…` for eval",
        "all": "every session, not just one",
        "keep-apps": "leave the session's apps running",
        "reason": "why the agent paused, shown to the operator",
        "note": "note handed back to the agent on resume",
        // Launch and windows
        "allow-no-windows": "own a running menu-bar app whose first window is still pending",
        "arguments-json": "launch arguments as a JSON array of strings",
        "new-instance": "launch a new instance even if one is already running",
        "press": "press the named menu item instead of listing it",
        "match": "label matching: exact (default) or contains, against the accessible name",
        "orphan-grace": "seconds an abandoned session keeps its apps for `session claim` (\(Int(SessionReclamationPolicy.orphanGraceRange.lowerBound))-\(Int(SessionReclamationPolicy.orphanGraceRange.upperBound)))",
        "new-tab": "open the URL in a new tab",
        "pid": "process id",
        "window": "target window id (from `spaceo windows`)",
        "placement": "window placement: preserve, fit, or cover",
        "target": "Chromium page target id (from `spaceo targets`)",
        // Reading
        "full": "the whole tree or display, not just the target window",
        "since": "return only the changes since this snapshot id",
        "role": "only elements with this accessibility role, e.g. Button",
        "max-chars": "cap the returned text at this many characters",
        "snapshot": "bind an element click to this snapshot id",
        "label": "select one enabled control by exact accessible label",
        // Input
        "element": "accessibility index N, or page element wN",
        "web": "coordinates and text target the managed Chromium page (CSS viewport points)",
        "x": "window-local x in points",
        "y": "window-local y in points",
        "button": "mouse button: left, right, or middle",
        "count": "click count, e.g. 2 for a double-click",
        "modifiers": "held modifiers, comma separated: cmd,shift,option,control",
        "dx": "horizontal scroll delta; positive scrolls content left",
        "dy": "vertical scroll delta; positive scrolls content up",
        "ticks": "number of wheel ticks",
        "from-element": "drag start element index",
        "to-element": "drag end element index",
        "to-x": "drag end x in window-local points",
        "to-y": "drag end y in window-local points",
        "duration": "drag hold time, 0.05 through 30 seconds",
        "geometry": "bind coordinates to this window geometry token",
        "anchor-line": "selection anchor line",
        "anchor-character": "selection anchor character",
        "active-line": "selection active (caret) line",
        "active-character": "selection active (caret) character",
        "replace": "replace existing text; native fields require confirmed Accessibility selection and readback",
        "submit": "press Return after typing",
        "hold-ms": "hold the key down this many milliseconds",
        "action": "key action: tap, down, or up",
        "steps-json": "JSON array of step requests, each with a cmd",
        "continue-on-failure": "run later steps after a failed one",
        // Capture and isolation
        "output": "write the file here",
        "o": "alias for --output",
        "scale": "capture scale: 1, 2, 3, or 4",
        "width": "region width in points",
        "height": "region height in points",
        "memory": "return the PNG as base64 in the JSON (needs --json)",
        "annotate": "draw element indices onto the capture",
        "strict": "require complete isolation coverage",
        "require-isolation": "comma-separated isolation dimensions that must be observed",
        "require-window": "require a live app window",
        // Daemon and host
        "display-size": "virtual display size WxH, e.g. 2560x1440",
        "sessions-per-display": "sessions packed onto each new display",
        "now": "stop immediately instead of waiting for sessions to finish",
        "fix": "offer the safe remediations doctor found, each behind a prompt",
        "interactive": "also require interactive readiness (daemon grants match this app)",
        "probe-client-versions": "execute configured client commands with the version argument (may have side effects)",
        "no-prompt": "never open a permission prompt or System Settings",
        "no-self-test": "skip the live session self-test",
        "client": "MCP client: claude-code, codex, cursor, or claude-desktop",
        "dry-run": "report what would be removed, and remove nothing",
        "level": "journal detail: full (result text agents read) or metadata (no screen content)",
        "retention-days": "delete journal day folders older than this (1-90)",
        "max-mb": "cap each journal file and the daemon log's rotation size (1-500 MB)",
        "follow": "keep streaming new events until interrupted",
        "since-seq": "start after this event sequence number",
        // Demo
        "keep": "leave the demo session running",
        "no-capture": "skip the demo screenshot",
        "sessions": "number of demo sessions",
    ]
}

/// Help text, examples, and completions built from `CLISpec` and the printed usage.
public enum CLIHelp {
    /// Command keys deliberately absent from the top-level usage. Empty today; a key added here
    /// must still have per-command help. `CLIHelpTests` requires every other key to appear.
    public static let hiddenCommands: Set<String> = []

    /// Flag meanings that differ by command, keyed `command:flag`.
    public static let flagHelpOverrides: [String: String] = [
        "session.create:session": "name for the new session",
        "session.create:lease": "reuse this lease UUID for the new session",
        "daemon.stop:lease": "stop only if this lease covers every live session (never read from $SPACEO_LEASE)",
        "daemon.restart:lease": "accepted for symmetry with daemon stop; restart always needs --operator",
        "clean:lease": "clean only if this lease covers every live session (never read from $SPACEO_LEASE)",
        "session.create:timeout": "bounded wait for --app's first window, at most 120 seconds",
        "daemon.restart:timeout": "how long to wait for sessions to finish, 1 through 3600 seconds (default 900)",
        "daemon.stop:timeout": "how long to wait for the old daemon to exit, 0.5 through 120 seconds",
        "daemon.wait:timeout": "how long to wait for a daemon to answer, 0.5 through 120 seconds",
        "daemon.drain:timeout": "drain deadline in seconds",
        "wait:timeout": "give up after this many seconds (the command then exits 6)",
        "windows:timeout": "poll this many seconds for a window, at most 120",
        "demo:app": "application the demo drives (default TextEdit)",
        "report:output": "write the HTML here instead of stdout",
        "doctor:yes": "apply every offered remediation without prompting",
        "setup:print": "print the registration command or merged config, and write nothing",
    ]

    /// One sentence per command, shown under its usage block.
    public static let summaries: [String: String] = [
        "schema": "Print the versioned command and flag vocabulary as JSON, without contacting a daemon.",
        "version": "Print this CLI's version.",
        "help": "Show help for one command, or the command list.",
        "completions": "Print a shell completion script generated from the command table.",
        "setup": "Guided first run: permission grants, daemon, self-test, and MCP registration.",
        "safety": "Operator recovery for a false host-health admission latch, and cleanup of ColorSync state left by older display identities.",
        "safety.clear-host-health": "Clear an idle unknown-health, memory-pressure, swap or older WindowServer-report latch only after verified owner exclusion and settled healthy host observations.",
        "safety.clean-display-identities": "List the ColorSync device registrations and display profiles that SpaceO 1.0.8 and earlier left behind; with --apply under sudo, back them up and remove them.",
        "doctor": "Check host capabilities, permissions, the daemon, MCP clients, the Viewer, and disk use.",
        "skill": "Print the SKILL.md playbook for agents.",
        "logging.status": "Show local diagnostic logging: the MCP agent journal and daemon request records.",
        "logging.enable": "Journal every MCP tool call and log every daemon request, for an improvement loop.",
        "logging.disable": "Return to failures-only logging; existing journal files are kept until retention removes them.",
        "mcp": "Run the MCP server over stdio; MCP clients launch this.",
        "daemon": "Run the session host in the foreground.",
        "daemon.stop": "Stop the shared daemon and clean up its sessions.",
        "daemon.restart": "Replace the running daemon with this build, waiting for live sessions unless --now.",
        "daemon.drain": "Ask the daemon to refuse new sessions and exit once the last one ends.",
        "daemon.wait": "Wait until a daemon answers on the socket.",
        "daemon.install": "Install the daemon as a LaunchAgent with its own stable permission identity.",
        "daemon.uninstall": "Remove the LaunchAgent and stop the supervised daemon.",
        "daemon.status": "Show whether the LaunchAgent is installed and running.",
        "clean": "Remove orphaned browser profiles and control roots no session references.",
        "events": "Read the daemon event stream: agent actions, pauses, verdicts.",
        "report": "Render a recorded session as an HTML timeline.",
        "session.create": "Take a display tile and receive its controller lease.",
        "session.annotate": "Set a session's title or color tag.",
        "session.list": "List sessions; other controllers' app and window detail is redacted.",
        "session.heartbeat": "Renew a session's controller lease.",
        "session.claim": "Take over an abandoned session (its controller exited) and keep its apps.",
        "session.pause": "Pause agent input to a session.",
        "session.resume": "Resume agent input to a session.",
        "session.destroy": "Destroy a session and quit the apps it launched.",
        "pool": "Show displays, capacity, and occupancy; `pool set N` changes density; `pool trim` retires idle displays; `pool remove ID` ends its sessions and removes it. Mutations require --operator.",
        "run": "Launch an app onto the session without activating it.",
        "open-url": "Navigate the session's managed Chromium.",
        "wait": "Wait for a condition; exits 6 if it is not met before the timeout.",
        "find": "Search the window's accessibility elements and return fresh indices.",
        "text": "Read the window's text in reading order, or one element's text.",
        "steps": "Run up to 16 actions as one batch.",
        "clipboard.get": "Read the session's private clipboard.",
        "clipboard.set": "Write the session's private clipboard.",
        "adopt": "Move an already-running app onto the session.",
        "place": "Re-apply window placement for one window.",
        "windows": "List the session's windows.",
        "ax": "Print the indexed accessibility tree, or its diff since a snapshot.",
        "targets": "List Chromium page targets and the current binding.",
        "attach-target": "Bind web actions to one Chromium page target.",
        "click": "Click an element or window-local point without raising the app.",
        "menu": "List or press the session app's menu-bar items without activating it.",
        "move": "Hover without pressing, to reveal hover-only UI.",
        "drag": "Drag between two elements or points.",
        "scroll": "Scroll at an element or point.",
        "select": "Select editor text by line and character.",
        "type": "Type text into the focused element.",
        "key": "Press a key combination.",
        "screenshot": "Capture the session's window, a region, or the whole tile.",
        "verify": "Audit the session's isolation.",
        "repark": "Pull escaped windows back onto the session's display.",
        "demo": "Self-contained end-to-end proof; needs no daemon.",
    ]

    /// One or two runnable lines per command.
    public static let examples: [String: [String]] = [
        "schema": ["spaceo schema --json"],
        "version": ["spaceo version --json"],
        "help": ["spaceo help click"],
        "completions": ["eval \"$(spaceo completions zsh)\"", "spaceo completions fish > ~/.config/fish/completions/spaceo.fish"],
        "setup": ["spaceo setup", "spaceo setup --client claude-code --print"],
        "safety": ["spaceo safety clear-host-health --operator",
                   "spaceo safety clean-display-identities --operator"],
        "safety.clear-host-health": ["spaceo safety clear-host-health --operator"],
        "safety.clean-display-identities": ["spaceo safety clean-display-identities --operator",
                                            "sudo spaceo safety clean-display-identities --apply --operator"],
        "doctor": ["spaceo doctor", "spaceo doctor --fix"],
        "skill": ["spaceo skill > SKILL.md"],
        "logging.status": ["spaceo logging status"],
        "logging.enable": ["spaceo logging enable", "spaceo logging enable --level metadata --retention-days 30"],
        "logging.disable": ["spaceo logging disable"],
        "mcp": ["claude mcp add -s user spaceo -- \"$HOME/.local/bin/spaceo\" mcp"],
        "daemon": ["spaceo daemon", "spaceo daemon --sessions-per-display 4"],
        "daemon.stop": ["spaceo daemon stop --operator"],
        "daemon.restart": ["spaceo daemon restart --operator", "spaceo daemon restart --operator --now"],
        "daemon.drain": ["spaceo daemon drain --operator"],
        "daemon.wait": ["spaceo daemon wait --timeout 30"],
        "daemon.install": ["spaceo daemon install"],
        "daemon.uninstall": ["spaceo daemon uninstall --yes"],
        "daemon.status": ["spaceo daemon status --json"],
        "clean": ["spaceo clean --dry-run", "spaceo clean --operator"],
        "events": ["spaceo events --follow"],
        "report": ["spaceo report ./recording -o timeline.html"],
        "session.create": ["eval \"$(spaceo session create --export)\"", "spaceo session create --session research --app TextEdit --json"],
        "session.annotate": ["spaceo session annotate --title \"invoice run\" --color blue"],
        "session.list": ["spaceo session list --json"],
        "session.heartbeat": ["spaceo session heartbeat --session research --lease UUID"],
        "session.claim": ["spaceo session claim --session research"],
        "session.pause": ["spaceo session pause --reason \"needs 2FA\""],
        "session.resume": ["spaceo session resume --note \"logged you in\""],
        "session.destroy": ["spaceo session destroy", "spaceo session destroy --all --operator"],
        "pool": ["spaceo pool", "spaceo pool set 4 --operator", "spaceo pool trim --operator", "spaceo pool remove 5 --operator"],
        "run": ["spaceo run TextEdit", "spaceo run \"Google Chrome\" --json"],
        "open-url": ["spaceo open-url https://example.com"],
        "wait": ["spaceo wait element_label Save --timeout 10 && spaceo click --label Save"],
        "find": ["spaceo find Save --role Button"],
        "text": ["spaceo text --max-chars 2000"],
        "steps": ["spaceo steps --steps-json '[{\"cmd\":\"click\",\"element\":\"3\"}]'"],
        "clipboard.get": ["spaceo clipboard get"],
        "clipboard.set": ["spaceo clipboard set \"hello\""],
        "adopt": ["spaceo adopt --pid 4242"],
        "place": ["spaceo place --window 812 --placement cover"],
        "windows": ["spaceo windows --timeout 10"],
        "ax": ["spaceo ax", "spaceo ax --since SNAPSHOT"],
        "targets": ["spaceo targets"],
        "attach-target": ["spaceo attach-target 9A1F…"],
        "click": ["spaceo click --element 3", "spaceo click --x 120 --y 44 --button right"],
        "menu": ["spaceo menu File", "spaceo menu File \"Export as PDF…\" --press"],
        "move": ["spaceo move --element 7"],
        "drag": ["spaceo drag --from-element 3 --to-element 9"],
        "scroll": ["spaceo scroll --element 4 --dy -600"],
        "select": ["spaceo select --x 200 --y 120 --anchor-line 3 --anchor-character 0 --active-line 3 --active-character 12"],
        "type": ["spaceo type \"hello\" --submit"],
        "key": ["spaceo key cmd+s"],
        "screenshot": ["spaceo screenshot -o shot.png", "spaceo screenshot --full --scale 2 -o tile.png"],
        "verify": ["spaceo verify --strict"],
        "repark": ["spaceo repark"],
        "demo": ["spaceo demo --app TextEdit"],
    ]

    // MARK: Keys

    /// The CLISpec key an invocation addresses: `session create` → `session.create`, `click` →
    /// `click`, `pool set 4` → `pool` (set is a positional, not its own key).
    public static func key(command: String, positional: [String]) -> String {
        if let sub = positional.first, CLISpec.allowedFlags["\(command).\(sub)"] != nil {
            return "\(command).\(sub)"
        }
        return command
    }

    /// Subcommand keys under one command word, e.g. `session` → `session.create`, … . Empty for
    /// a command word with no subcommand keys.
    public static func subcommandKeys(of command: String) -> [String] {
        CLISpec.allowedFlags.keys.filter { $0.hasPrefix(command + ".") }.sorted()
    }

    /// Every command word, for completions and "did you mean".
    public static var commandWords: [String] {
        Array(Set(CLISpec.allowedFlags.keys.map { String($0.split(separator: ".")[0]) })).sorted()
    }

    // MARK: Usage blocks

    /// The alternatives a usage line offers after `spaceo <command>`: `install|uninstall|status`
    /// and `get | set` both yield their words.
    static func subcommandWords(after tokens: ArraySlice<String>) -> [String] {
        var words: [String] = []
        var expectWord = true
        for token in tokens {
            if token == "|" { expectWord = true; continue }
            guard expectWord, let first = token.first, first.isLetter, first.isLowercase else { break }
            let parts = token.split(separator: "|").map(String.init)
            guard parts.allSatisfy({ $0.allSatisfy { $0.isLetter || $0 == "-" } }) else { break }
            words += parts
            expectWord = token.hasSuffix("|")
        }
        return words
    }

    static func line(_ tokens: [String], documents key: String) -> Bool {
        guard tokens.count > 1, tokens[0] == "spaceo" else { return false }
        let parts = key.split(separator: ".").map(String.init)
        guard tokens[1] == parts[0] else { return false }
        let words = subcommandWords(after: tokens.dropFirst(2))
        if parts.count == 2 { return words.contains(parts[1]) }
        guard let first = words.first else { return true }
        return CLISpec.allowedFlags["\(parts[0]).\(first)"] == nil
    }

    /// The usage lines that document `key`, continuation lines included, with the common
    /// indentation removed. Nil when usage does not mention the key.
    public static func usageBlock(for key: String, in usage: String) -> String? {
        var blocks: [[String]] = []
        var current: [String]?
        for raw in usage.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let tokens = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            let indented = line.hasPrefix(" ")
            if indented, tokens.first == "spaceo" {
                if let open = current { blocks.append(open) }
                current = self.line(tokens, documents: key) ? [line] : nil
            } else if indented, !tokens.isEmpty, current != nil {
                current?.append(line)
            } else {
                if let open = current { blocks.append(open) }
                current = nil
            }
        }
        if let open = current { blocks.append(open) }
        let lines = blocks.flatMap { $0 }
        guard !lines.isEmpty else { return nil }
        let indent = lines.map { $0.prefix { $0 == " " }.count }.min() ?? 0
        return lines.map { String($0.dropFirst(indent)) }.joined(separator: "\n")
    }

    // MARK: Rendering

    public static func flagDescription(_ flag: String, command: String) -> String {
        flagHelpOverrides["\(command):\(flag)"] ?? CLISpec.flagHelp[flag] ?? ""
    }

    /// `spaceo <command> --help` and `spaceo help <command>`: that command's usage block, one
    /// line per flag, and examples. Nil when `key` names nothing the CLI knows.
    public static func render(key: String, usage: String) -> String? {
        let subkeys = subcommandKeys(of: key)
        guard let flags = CLISpec.allowedFlags[key] else {
            // A command word that only has subcommands (`session`, `clipboard`): list them.
            guard !subkeys.isEmpty else { return nil }
            var lines = ["spaceo \(key) <subcommand>", ""]
            for subkey in subkeys {
                let words = subkey.replacingOccurrences(of: ".", with: " ")
                lines.append("  spaceo \(words)".padding(toLength: 34, withPad: " ", startingAt: 0)
                             + " " + (summaries[subkey] ?? ""))
            }
            lines += ["", "Run `spaceo \(key) <subcommand> --help` for its options."]
            return lines.joined(separator: "\n")
        }
        var lines: [String] = []
        let words = key.replacingOccurrences(of: ".", with: " ")
        lines.append(usageBlock(for: key, in: usage) ?? "spaceo \(words)")
        if let summary = summaries[key] { lines += ["", summary] }
        let documented = flags.subtracting(["help", "h"]).sorted()
        if !documented.isEmpty {
            lines += ["", "Options:"]
            let width = min(32, (documented.map { flagLabel($0).count }.max() ?? 0) + 2)
            for flag in documented {
                let label = flagLabel(flag)
                lines.append("  " + label.padding(toLength: max(width, label.count + 1),
                                                   withPad: " ", startingAt: 0)
                             + flagDescription(flag, command: key))
            }
        }
        if !subkeys.isEmpty {
            lines += ["", "Subcommands: " + subkeys.map { $0.split(separator: ".")[1] }.joined(separator: ", ")
                      + " (see `spaceo \(words) <subcommand> --help`)"]
        }
        if let examples = examples[key], !examples.isEmpty {
            lines += ["", "Examples:"] + examples.map { "  " + $0 }
        }
        lines += ["", "Exit codes: " + CLIExitCode.compactSummary + "."]
        return lines.joined(separator: "\n")
    }

    static func flagLabel(_ flag: String) -> String {
        let dash = CLISpec.shortFlags.contains(flag) ? "-" : "--"
        return dash + flag + (CLISpec.valueFlags.contains(flag) ? " VALUE" : "")
    }

    /// Closest command words to a mistyped one, for "did you mean".
    public static func suggestions(for word: String, limit: Int = 3) -> [String] {
        let bounded = String(word.prefix(64))
        let threshold = max(1, bounded.count / 3)
        var scored: [(word: String, distance: Int)] = []
        for candidate in commandWords {
            let distance = editDistance(bounded, candidate)
            if distance <= threshold { scored.append((candidate, distance)) }
        }
        scored.sort { $0.distance == $1.distance ? $0.word < $1.word : $0.distance < $1.distance }
        return scored.prefix(limit).map { $0.word }
    }

    static func editDistance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty else { return b.count }
        guard !b.isEmpty else { return a.count }
        var previous = Array(0...b.count)
        for i in 1...a.count {
            var current = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1,
                                 previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            previous = current
        }
        return previous[b.count]
    }
}

// MARK: - Command-line validation

extension CLISpec {
    /// Single-dash spellings (`-o`, `-h`). Every other flag is `--name`, one letter or not.
    public static let shortFlags: Set<String> = ["o", "h"]

    /// Pairs of spellings for one flag. Supplying both used to drop one silently.
    public static let aliasPairs: [(String, String)] = [("session", "name"), ("output", "o")]

    /// Why `commandLine` (e.g. "spaceo daemon restart --operator") would be rejected, or nil when
    /// it parses against the flag table. Used to pin every command the CLI prints as advice.
    /// Placeholders (`UUID`, `ID`, `<x>`) are fine as values; trailing `&` is ignored.
    public static func problem(with commandLine: String) -> String? {
        var tokens = commandLine.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if tokens.last == "&" { tokens.removeLast() }
        guard tokens.first == "spaceo" else { return "does not start with `spaceo`" }
        tokens.removeFirst()
        tokens = CLIGlobalFlags.normalize(tokens)
        guard let command = tokens.first else { return "names no command" }
        let args = CLIArguments(Array(tokens.dropFirst()))
        let key = CLIHelp.key(command: command, positional: args.positional)
        guard let allowed = allowedFlags[key] else {
            return "`\(command)` is not a command"
        }
        if key == command, !CLIHelp.subcommandKeys(of: command).isEmpty,
           let sub = args.positional.first, command != "pool" || !["set", "remove"].contains(sub) {
            return "`\(command) \(sub)` is not a subcommand"
        }
        let unknown = args.suppliedNames.subtracting(allowed)
        if !unknown.isEmpty {
            return "`\(key)` rejects " + unknown.sorted().map { "--\($0)" }.joined(separator: ", ")
        }
        for name in args.suppliedNames where valueFlags.contains(name) && args.string(name) == nil {
            return "--\(name) needs a value"
        }
        return nil
    }

    public static func backtickedCommands(in text: String) -> [String] {
        let parts = text.components(separatedBy: "`")
        return stride(from: 1, to: parts.count, by: 2).map { parts[$0] }
            .filter { $0.hasPrefix("spaceo ") || $0 == "spaceo" }
    }
}

extension CLIArguments {
    public var conflictingAliases: [(String, String)] {
        CLISpec.aliasPairs.filter { wasSupplied($0.0) && wasSupplied($0.1) }
    }
}

// MARK: - Shell completions

/// Completion scripts for zsh, bash, and fish, generated from `CLISpec` so they cannot drift.
public enum CLICompletions {
    public static let shells = ["zsh", "bash", "fish"]

    public static func script(for shell: String) -> String? {
        switch shell {
        case "zsh": return zsh()
        case "bash": return bash()
        case "fish": return fish()
        default: return nil
        }
    }

    /// The word-level shape: command words, their subcommand words, and the flags each key takes.
    struct Table {
        var commands: [String]
        var subcommands: [String: [String]]
        var flags: [String: [String]]
    }

    static func table() -> Table {
        var subcommands: [String: [String]] = [:]
        var flags: [String: [String]] = [:]
        for (key, allowed) in CLISpec.allowedFlags {
            let parts = key.split(separator: ".").map(String.init)
            if parts.count == 2 { subcommands[parts[0], default: []].append(parts[1]) }
            flags[key] = allowed.subtracting(["h"]).sorted().map { CLISpec.shortFlags.contains($0) ? "-\($0)" : "--\($0)" }
        }
        subcommands["pool", default: []].append(contentsOf: ["set", "remove"])
        for key in subcommands.keys { subcommands[key]?.sort() }
        let commands = (CLIHelp.commandWords + ["help"]).reduce(into: [String]()) {
            if !$0.contains($1) { $0.append($1) }
        }.sorted()
        return Table(commands: commands, subcommands: subcommands, flags: flags)
    }

    static func zsh() -> String {
        let table = table()
        var lines = [
            "#compdef spaceo",
            "# Generated by `spaceo completions zsh`. Load with: eval \"$(spaceo completions zsh)\"",
            "_spaceo() {",
            "  local key",
            "  if (( CURRENT == 2 )); then",
            "    compadd -- \(table.commands.joined(separator: " "))",
            "    return",
            "  fi",
            "  key=$words[2]",
            "  case $words[2] in",
        ]
        for command in table.subcommands.keys.sorted() {
            let subs = table.subcommands[command] ?? []
            lines.append("    \(command))")
            lines.append("      if (( CURRENT == 3 )); then compadd -- \(subs.joined(separator: " ")); return; fi")
            lines.append("      if [[ -n ${words[3]} && ${words[3]} != -* ]]; then key=\"$words[2].$words[3]\"; fi")
            lines.append("      ;;")
        }
        lines.append("    help) compadd -- \(table.commands.joined(separator: " ")); return ;;")
        lines.append("  esac")
        lines.append("  case $key in")
        for key in table.flags.keys.sorted() {
            lines.append("    \(key)) compadd -- \((table.flags[key] ?? []).joined(separator: " ")) ;;")
        }
        lines += ["  esac", "}", "compdef _spaceo spaceo", ""]
        return lines.joined(separator: "\n")
    }

    static func bash() -> String {
        let table = table()
        var lines = [
            "# Generated by `spaceo completions bash`. Load with: eval \"$(spaceo completions bash)\"",
            "_spaceo() {",
            "  local cur=\"${COMP_WORDS[COMP_CWORD]}\" key=\"${COMP_WORDS[1]}\" words=\"\"",
            "  if [ \"$COMP_CWORD\" -eq 1 ]; then",
            "    COMPREPLY=($(compgen -W \"\(table.commands.joined(separator: " "))\" -- \"$cur\"))",
            "    return",
            "  fi",
            "  case \"${COMP_WORDS[1]}\" in",
        ]
        for command in table.subcommands.keys.sorted() {
            let subs = table.subcommands[command] ?? []
            lines.append("    \(command))")
            lines.append("      if [ \"$COMP_CWORD\" -eq 2 ]; then COMPREPLY=($(compgen -W \"\(subs.joined(separator: " "))\" -- \"$cur\")); return; fi")
            lines.append("      case \"${COMP_WORDS[2]}\" in -*|\"\") ;; *) key=\"${COMP_WORDS[1]}.${COMP_WORDS[2]}\" ;; esac")
            lines.append("      ;;")
        }
        lines.append("    help) COMPREPLY=($(compgen -W \"\(table.commands.joined(separator: " "))\" -- \"$cur\")); return ;;")
        lines.append("  esac")
        lines.append("  case \"$key\" in")
        for key in table.flags.keys.sorted() {
            lines.append("    \(key)) words=\"\((table.flags[key] ?? []).joined(separator: " "))\" ;;")
        }
        lines += [
            "  esac",
            "  COMPREPLY=($(compgen -W \"$words\" -- \"$cur\"))",
            "}",
            "complete -F _spaceo spaceo",
            "",
        ]
        return lines.joined(separator: "\n")
    }

    static func fish() -> String {
        let table = table()
        var lines = [
            "# Generated by `spaceo completions fish`. Save as ~/.config/fish/completions/spaceo.fish",
            "complete -c spaceo -f",
        ]
        for command in table.commands {
            let summary = CLIHelp.summaries[command].map { " -d \(fishQuote($0))" } ?? ""
            lines.append("complete -c spaceo -n __fish_use_subcommand -a \(command)\(summary)")
        }
        for command in table.subcommands.keys.sorted() {
            let subs = table.subcommands[command] ?? []
            lines.append("complete -c spaceo -n \"__fish_seen_subcommand_from \(command); and not "
                         + "__fish_seen_subcommand_from \(subs.joined(separator: " "))\" -a \(fishQuote(subs.joined(separator: " ")))")
        }
        for key in table.flags.keys.sorted() {
            let parts = key.split(separator: ".").map(String.init)
            var condition = "__fish_seen_subcommand_from \(parts[0])"
            if parts.count == 2 {
                condition += "; and __fish_seen_subcommand_from \(parts[1])"
            } else if let subs = table.subcommands[parts[0]], !subs.isEmpty {
                condition += "; and not __fish_seen_subcommand_from \(subs.joined(separator: " "))"
            }
            for flag in (CLISpec.allowedFlags[key] ?? []).subtracting(["h"]).sorted() {
                let option = CLISpec.shortFlags.contains(flag) ? "-s \(flag)" : "-l \(flag)"
                let requires = CLISpec.valueFlags.contains(flag) ? " -r" : ""
                let description = CLIHelp.flagDescription(flag, command: key)
                lines.append("complete -c spaceo -n \(fishQuote(condition)) \(option)\(requires)"
                             + (description.isEmpty ? "" : " -d \(fishQuote(description))"))
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func fishQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'") + "'"
    }
}
