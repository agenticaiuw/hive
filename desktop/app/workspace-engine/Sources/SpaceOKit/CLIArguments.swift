import Foundation

/// Which `spaceo` flags take a value, which do not, and what each command accepts.
///
/// The parser has to be told this up front. A parser that guesses — "the next token has no
/// leading dash, so it must be my value" — makes `spaceo type --web "hello"` swallow the text
/// and makes `spaceo pool --json set 4` silently skip the `set` subcommand *and* silently drop
/// `--json`, while still exiting 0. A script reading that output for JSON gets prose and a
/// success code, which is the worst of both.
///
/// Keeping the classification and the per-command allowlists in one table is the point: a new
/// boolean flag that is added to a command but never classified is caught by
/// `CLISpecTests.testEveryAllowedFlagIsClassified` rather than by a user losing an argument.
public enum CLISpec {
    /// Flags that never consume the following token. `--flag=true` / `--flag=false` still works
    /// for scripts that want to pass the value explicitly.
    public static let booleanFlags: Set<String> = [
        "all", "full", "json", "keep", "keep-apps", "no-capture", "no-prompt",
        "no-self-test", "operator", "web", "help", "h", "memory", "allow-no-windows",
        "require-window", "strict", "interactive",
        "new-tab", "mute-audio", "new-instance", "replace", "submit", "annotate", "dry-run",
        "follow", "fix", "yes", "print", "now", "continue-on-failure", "press",
        "export", "probe-client-versions", "apply",
    ]

    /// Flags that always take a value, either as `--flag value` or `--flag=value`.
    public static let valueFlags: Set<String> = [
        "app", "button", "controller-id", "controller-kind", "controller-label",
        "controller-ttl", "count", "display-size", "dx", "dy", "element", "height",
        "lease", "modifiers", "name", "o", "output", "pid", "scale", "session", "target",
        "sessions", "sessions-per-display", "socket", "ticks", "to-x", "to-y",
        "width", "window", "x", "y",
        "anchor-line", "anchor-character", "active-line", "active-character",
        "placement", "timeout", "duration", "snapshot", "geometry", "arguments-json", "label", "require-isolation",
        "role", "max-chars", "steps-json", "title", "color", "reason", "note", "since",
        "from-element", "to-element", "hold-ms", "action", "preset", "record", "client", "since-seq",
        "orphan-grace",
        "match",
        "level", "retention-days", "max-mb",
    ]

    /// Every flag the CLI understands anywhere. Used to decide whether a dash-token following a
    /// value flag is that flag's value or the next flag: `--output --full` is a missing value,
    /// `--dy -600` is not.
    public static let knownFlags: Set<String> = booleanFlags.union(valueFlags)

    /// Allowed flags per command, keyed by `command` or `command.subcommand`.
    public static let allowedFlags: [String: Set<String>] = [
        "schema": ["json"],
        "version": ["json"],
        "daemon.wait": ["socket", "json", "timeout"],
        "daemon.restart": ["socket", "json", "operator", "now", "timeout", "lease"],
        "daemon.drain": ["socket", "json", "operator", "timeout"],
        "daemon.install": ["socket", "json", "yes"],
        "daemon.uninstall": ["socket", "json", "yes"],
        "daemon.status": ["socket", "json"],
        "place": ["socket", "json", "session", "lease", "window", "placement", "strict", "require-isolation"],
        "safety": ["json", "operator", "apply"],
        "safety.clear-host-health": ["json", "operator"],
        "safety.clean-display-identities": ["json", "operator", "apply"],
        "doctor": ["socket", "json", "interactive", "fix", "yes", "probe-client-versions"],
        "setup": ["socket", "json", "no-prompt", "no-self-test", "client", "yes", "print"],
        "skill": ["json"],
        "logging.status": ["json"],
        "logging.enable": ["json", "level", "retention-days", "max-mb"],
        "logging.disable": ["json"],
        "clean": ["socket", "json", "operator", "dry-run", "lease"],
        "events": ["socket", "json", "follow", "since-seq", "session", "lease", "operator"],
        "report": ["json", "output", "o"],
        "daemon": ["socket", "display-size", "sessions-per-display"],
        "daemon.stop": ["socket", "json", "lease", "operator", "timeout"],
        "session.create": [
            "socket", "json", "session", "name", "controller-id", "controller-label",
            "controller-kind", "controller-ttl", "lease", "orphan-grace",
            "app", "preset", "title", "record", "mute-audio", "timeout", "allow-no-windows",
            "export",
        ],
        "session.claim": [
            "socket", "json", "session", "controller-id", "controller-label",
            "controller-kind", "controller-ttl", "orphan-grace",
        ],
        "session.annotate": ["socket", "json", "session", "lease", "operator", "title", "color"],
        "session.list": ["socket", "json", "lease", "operator"],
        "session.heartbeat": ["socket", "json", "session", "lease"],
        "session.pause": ["socket", "json", "session", "lease", "operator", "reason"],
        "session.resume": ["socket", "json", "session", "lease", "operator", "note"],
        "session.destroy": ["socket", "json", "session", "all", "keep-apps", "lease", "operator"],
        "pool": ["socket", "json", "operator"],
        "run": ["socket", "json", "session", "lease", "allow-no-windows", "timeout", "arguments-json", "strict", "require-isolation", "new-instance", "mute-audio"],
        "open-url": ["socket", "json", "session", "lease", "window", "new-tab", "timeout", "mute-audio", "strict", "require-isolation"],
        "wait": ["socket", "json", "session", "lease", "window", "timeout", "match", "role"],
        "menu": ["socket", "json", "session", "lease", "window", "pid", "press", "strict", "require-isolation"],
        "find": ["socket", "json", "session", "lease", "window", "role"],
        "text": ["socket", "json", "session", "lease", "window", "element", "max-chars", "web"],
        "steps": ["socket", "json", "session", "lease", "steps-json", "continue-on-failure"],
        "clipboard.get": ["socket", "json", "session", "lease", "operator"],
        "clipboard.set": ["socket", "json", "session", "lease"],
        "adopt": ["socket", "json", "session", "pid", "lease", "allow-no-windows", "strict", "require-isolation"],
        "windows": ["socket", "json", "session", "lease", "timeout", "pid"],
        "ax": ["socket", "json", "session", "window", "full", "lease", "since"],
        "targets": ["socket", "json", "session", "window", "lease"],
        "attach-target": ["socket", "json", "session", "window", "target", "lease"],
        "click": [
            "socket", "json", "session", "window", "element", "web",
            "x", "y", "button", "count", "modifiers", "lease", "snapshot", "geometry", "strict", "require-isolation", "label",
            "match", "role",
        ],
        "select": [
            "socket", "json", "session", "window", "lease", "x", "y",
            "anchor-line", "anchor-character", "active-line", "active-character",
            "geometry", "strict", "require-isolation",
        ],
        "scroll": [
            "socket", "json", "session", "window", "element",
            "x", "y", "dx", "dy", "ticks", "modifiers", "web", "lease",
            "strict", "require-isolation",
        ],
        "move": ["socket", "json", "session", "window", "element", "x", "y", "modifiers", "web", "lease", "strict", "require-isolation"],
        "drag": [
            "socket", "json", "session", "window", "from-element", "to-element",
            "x", "y", "to-x", "to-y", "button", "modifiers", "web", "lease", "duration", "geometry", "strict", "require-isolation",
        ],
        "type": ["socket", "json", "session", "window", "web", "lease", "strict", "require-isolation", "replace", "submit"],
        "key": ["socket", "json", "session", "window", "web", "lease", "strict", "require-isolation", "hold-ms", "action"],
        "screenshot": [
            "socket", "json", "session", "window", "output", "o", "full",
            "scale", "x", "y", "width", "height", "lease", "memory", "annotate",
        ],
        "verify": ["socket", "json", "session", "lease", "require-window", "strict", "require-isolation"],
        "repark": ["socket", "json", "session", "lease", "strict", "require-isolation"],
        "mcp": ["socket"],
        "demo": ["app", "keep", "no-capture", "sessions"],
        "help": ["help", "h"],
        "completions": [],
    ]
}

/// The `spaceo` command line, parsed against `CLISpec`.
///
/// Lives in SpaceOKit rather than next to `main.swift` because the executable target is top-level
/// code and cannot be imported by the test bundle; parsing rules this easy to get subtly wrong
/// need direct unit tests.
public struct CLIArguments: Sendable {
    /// Non-flag tokens, in order. Subcommands (`session list`, `pool set 4`) arrive here.
    public private(set) var positional: [String] = []
    private var flags: [String: String] = [:]
    private var bools: Set<String> = []
    /// Boolean flags given an `=value` that is neither `true` nor `false`, e.g. `--json=1`.
    /// Reported rather than silently treated as false.
    public private(set) var malformedBooleanValues: [String] = []

    public init(
        _ argv: [String],
        booleanFlags: Set<String> = CLISpec.booleanFlags,
        valueFlags: Set<String> = CLISpec.valueFlags
    ) {
        let known = booleanFlags.union(valueFlags)

        func isKnownFlag(_ token: String) -> Bool {
            if token == "--" { return true }
            if token.hasPrefix("--") {
                let body = token.dropFirst(2)
                let name = String(body.prefix { $0 != "=" })
                return known.contains(name)
            }
            if token.hasPrefix("-"), token.count == 2 {
                return known.contains(String(token.dropFirst()))
            }
            return false
        }

        func record(name: String, value: String) {
            if booleanFlags.contains(name), value != "true", value != "false" {
                malformedBooleanValues.append(name)
            }
            flags[name] = value
        }

        var index = 0
        while index < argv.count {
            let token = argv[index]
            index += 1

            if token == "--" {
                positional.append(contentsOf: argv[index...])
                break
            }

            // A bare negative number is a value, not a flag. Without this `spaceo type -5`
            // parses "-5" as a short flag.
            if token.hasPrefix("-"), token.count > 1, Double(token) != nil {
                positional.append(token)
                continue
            }

            let name: String
            if token.hasPrefix("--") {
                let body = token.dropFirst(2)
                // `--flag=value` is the escape hatch: it forces a value even onto a flag we
                // classify as boolean, and carries values that look like flags.
                if let separator = body.firstIndex(of: "=") {
                    record(name: String(body[body.startIndex..<separator]),
                           value: String(body[body.index(after: separator)...]))
                    continue
                }
                name = String(body)
            } else if token.hasPrefix("-"), token.count == 2 {
                name = String(token.dropFirst())
            } else {
                positional.append(token)
                continue
            }

            // The fix: only a declared value flag reaches forward for the next token, and even
            // then it stops at the next flag so `--output --full` is a missing value, not a
            // silently swallowed `--full`.
            if valueFlags.contains(name), index < argv.count, !isKnownFlag(argv[index]) {
                flags[name] = argv[index]
                index += 1
                continue
            }
            bools.insert(name)
        }
    }

    public func string(_ name: String, _ alt: String? = nil) -> String? {
        flags[name] ?? alt.flatMap { flags[$0] }
    }
    public func int(_ name: String) -> Int? { flags[name].flatMap { Int($0) } }
    public func double(_ name: String) -> Double? { flags[name].flatMap { Double($0) } }
    public func bool(_ name: String) -> Bool { bools.contains(name) || flags[name] == "true" }
    public func wasSupplied(_ name: String) -> Bool {
        flags[name] != nil || bools.contains(name)
    }
    public var suppliedNames: Set<String> {
        Set(flags.keys).union(bools)
    }
    public var hasJSON: Bool { bool("json") }
}
