import Foundation

// The CLI's machine contract: exit statuses, the one-object JSON envelope, version drift, and the
// environment defaults scripts rely on. It lives in SpaceOKit rather than next to `main.swift`
// because the executable target is top-level code the test bundle cannot import, and every rule
// here is one a script depends on without reading prose.

// MARK: - Exit codes

/// Exit status by failure class, so `spaceo wait … && spaceo click …` and retry loops can branch
/// without parsing text.
///
/// Before these classes every failure exited 1 and `spaceo wait` exited 0 on a timed-out
/// condition, so `wait … && click` clicked anyway. The classes are coarse on purpose: a script
/// needs to know "retry later", "fix the invocation", "get a lease", or "stop", not which of
/// thirty codes the daemon used.
public enum CLIExitCode: Int32, CaseIterable, Sendable {
    case success = 0
    /// The command ran and failed for a reason no narrower class covers.
    case failure = 1
    /// The invocation itself is wrong: unknown command or option, missing or malformed value.
    case usage = 2
    /// No daemon answered, it is busy or stopping, or it predates the requested command.
    case daemonUnavailable = 3
    /// A controller lease is missing or wrong, or the session belongs to someone else.
    case leaseOrOwnership = 4
    /// Isolation could not be verified, or was breached.
    case isolation = 5
    /// A wait condition was not met before its timeout.
    case waitNotMet = 6

    public var meaning: String {
        switch self {
        case .success: return "success"
        case .failure: return "the command failed"
        case .usage: return "usage error (unknown command or option, bad value)"
        case .daemonUnavailable: return "daemon unavailable, busy, stopping, or outdated"
        case .leaseOrOwnership: return "controller lease missing or wrong, or session owned elsewhere"
        case .isolation: return "isolation not verified, or breached"
        case .waitNotMet: return "wait condition not met before the timeout"
        }
    }

    /// Error codes that mean the daemon itself is the problem, not the request.
    public static let daemonCodes: Set<String> = [
        "daemon_not_running", "daemon_busy", "daemon_outdated", "daemon_stopping",
        "daemon_draining", "daemon_unresponsive",
    ]
    /// Lease and ownership codes, including the ones other components introduce.
    public static let leaseCodes: Set<String> = [
        "lease_required", "lease_mismatch", "lease_expired", "session_detached",
        "session_abandoned", "session_owned",
    ]
    public static let isolationCodes: Set<String> = [
        "isolation_requirements_unmet", "isolation_breached",
    ]
    /// `steps` reports a failed wait step as `wait_<outcome>`. `wait_queue_timeout` is a queue
    /// admission failure, not a condition outcome, so it is deliberately absent.
    public static let waitCodes: Set<String> = ["wait_timeout", "wait_cancelled"]
    public static let usageCodes: Set<String> = ["usage_error"]

    /// The exit status for one daemon response to CLI command `command` (the CLISpec key, e.g.
    /// `wait` or `session.create`).
    public static func classify(_ response: Response, command: String) -> CLIExitCode {
        if response.ok {
            // A condition timeout is a normal daemon outcome (ok: true), but a script chaining
            // `wait … && click` must not proceed on it.
            if command == "wait", let wait = response.wait, wait.outcome != "met" {
                return .waitNotMet
            }
            return .success
        }
        let code = response.errorCode ?? ""
        if usageCodes.contains(code) { return .usage }
        if daemonCodes.contains(code) { return .daemonUnavailable }
        if leaseCodes.contains(code) { return .leaseOrOwnership }
        if isolationCodes.contains(code) { return .isolation }
        if waitCodes.contains(code) { return .waitNotMet }
        // Lease refusals currently travel as `bad_request` with a fixed sentence; classify by
        // that sentence until they carry their own code.
        if code == "bad_request" || code.isEmpty, let error = response.error,
           error.contains("controller lease") || error.contains("is abandoned and awaiting reclamation") {
            return .leaseOrOwnership
        }
        return .failure
    }

    /// Long form, one clause per class.
    public static var summary: String {
        allCases.map { "\($0.rawValue) \($0.meaning)" }.joined(separator: "; ")
    }

    /// One line for per-command help.
    public static let compactSummary = "0 ok, 1 failed, 2 usage, 3 daemon unavailable or outdated, "
        + "4 lease or ownership, 5 isolation, 6 wait condition not met"
}

// MARK: - JSON envelope

/// One JSON object per invocation, keys sorted, so `spaceo … --json | jq` never sees prose.
public enum CLIJSON {
    /// `Wire.encoder` plus sorted keys: the same dates and slashes the daemon writes, with a
    /// stable key order scripts and golden tests can rely on.
    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    /// The daemon's response as the envelope. Encoding a `Response` cannot fail in practice;
    /// if it ever does, the caller still gets a well-formed failure object rather than nothing.
    public static func encode(_ response: Response) -> String {
        if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
            return text
        }
        return error(message: "could not encode the daemon response", code: "operation_failed",
                     nextAction: nil)
    }

    /// A dictionary payload as the envelope. Non-JSON values are a programming error; they are
    /// reported as a failure object rather than trapping.
    public static func object(_ payload: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(
                withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            return error(message: "could not encode the command result", code: "operation_failed",
                         nextAction: nil)
        }
        return text
    }

    /// The envelope for a failure the CLI detected itself. Never carries the usage text: an
    /// agent that asked for JSON gets one sentence and a next step, not 130 lines of prose.
    public static func error(message: String, code: String, nextAction: String?) -> String {
        var payload: [String: Any] = ["ok": false, "error": message, "errorCode": code]
        if let nextAction { payload["nextAction"] = nextAction }
        guard let data = try? JSONSerialization.data(
                withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            return #"{"error":"could not encode the error","errorCode":"operation_failed","ok":false}"#
        }
        return text
    }
}

// MARK: - Version drift

/// Detects the upgrade trap where a freshly installed CLI talks to a daemon still running the
/// previous build: new commands come back as `unknown command 'find'`, indistinguishable from a
/// typo, and nothing says the fix is a restart.
public enum DaemonVersionDrift {
    public static let restartCommand = "spaceo daemon restart --operator"

    /// One stderr line when the answering daemon is not this CLI's version, nil when it is.
    public static func warning(daemon: DaemonRuntimeInfo?, cliVersion: String = SpaceOVersion.current)
        -> String?
    {
        guard let daemon, daemon.version != cliVersion else { return nil }
        return "the running daemon is \(daemon.version) (pid \(daemon.pid)); this CLI is "
            + "\(cliVersion) — run `\(restartCommand)`"
    }

    /// `X` from the daemon's `unknown command 'X'` refusal, bounded so a hostile or corrupt
    /// response cannot inflate the rewritten message.
    public static func unknownCommand(in error: String?) -> String? {
        guard let error,
              let start = error.range(of: "unknown command '") else { return nil }
        let rest = error[start.upperBound...]
        guard let end = rest.firstIndex(of: "'") else { return nil }
        let name = String(rest[..<end])
        guard !name.isEmpty, name.utf8.count <= 64,
              name.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
        return name
    }

    /// True when the daemon refused `command` because it does not know it — the signature of an
    /// older daemon, never of a malformed request.
    public static func isUnknownCommand(_ response: Response, command: String) -> Bool {
        !response.ok && unknownCommand(in: response.error) == command
    }

    /// Rewrites an `unknown command` refusal from a daemon of another version into
    /// `daemon_outdated`, with the restart as the next action. A daemon that omits its runtime
    /// info predates provenance reporting, so it is older than any CLI that could ask.
    /// `cliCommand` is the CLISpec key the user ran (`find`), named alongside the wire command
    /// (`ax.find`) so the sentence matches what they typed.
    public static func rewritingOutdated(_ response: Response,
                                         cliCommand: String? = nil,
                                         cliVersion: String = SpaceOVersion.current) -> Response {
        guard !response.ok, let command = unknownCommand(in: response.error) else { return response }
        let daemonVersion = response.daemon?.version
        guard daemonVersion != cliVersion else { return response }
        var rewritten = response
        let described = daemonVersion.map { "(\($0))" } ?? "(an unknown older version)"
        let typed = cliCommand.map { "spaceo " + $0.replacingOccurrences(of: ".", with: " ") }
        let named = typed.map { $0 == "spaceo \(command)" ? "`\($0)`" : "`\($0)` (daemon command `\(command)`)" }
            ?? "`\(command)`"
        rewritten.errorCode = "daemon_outdated"
        rewritten.error = "the running daemon \(described) predates \(named); this CLI is "
            + "\(cliVersion). Restart the daemon to use it: `\(restartCommand)`"
        rewritten.nextAction = restartCommand
        rewritten.recovery = nil
        return rewritten
    }
}

// MARK: - Global flags and environment defaults

public enum CLIGlobalFlags {
    /// Flags that may precede the command word (`spaceo --json session list`), and whether each
    /// takes a value.
    public static let leading: [String: Bool] = [
        "json": false, "socket": true, "session": true, "lease": true, "operator": false,
    ]

    /// Moves leading global flags after the command word, so the per-command parser and allowlist
    /// see one shape. Stops at the first token that is not a leading global; argv that is only
    /// globals is returned unchanged and fails as an unknown command.
    public static func normalize(_ argv: [String]) -> [String] {
        var moved: [String] = []
        var index = 0
        while index < argv.count {
            let token = argv[index]
            guard token.hasPrefix("--") else { break }
            let body = token.dropFirst(2)
            let name = String(body.prefix { $0 != "=" })
            guard let takesValue = leading[name] else { break }
            moved.append(token)
            index += 1
            if takesValue, !body.contains("="), index < argv.count {
                moved.append(argv[index])
                index += 1
            }
        }
        guard !moved.isEmpty, index < argv.count else { return argv }
        return [argv[index]] + moved + Array(argv[(index + 1)...])
    }
}

/// `SPACEO_SESSION` and `SPACEO_LEASE` as defaults for `--session` and `--lease`, so a shell that
/// ran `eval "$(spaceo session create --export)"` does not repeat them on every command.
public enum CLIEnvironment {
    public static let sessionVariable = "SPACEO_SESSION"
    public static let leaseVariable = "SPACEO_LEASE"
    /// `session create --session` names a new session; defaulting it from the environment would
    /// collide with the session that environment already describes. Host-wide commands (stop,
    /// clean) treat a lease as "only my sessions are affected"; that claim must be made on the
    /// command line, not inherited from a shell that happens to hold one session's lease.
    public static let commandsIgnoringEnvironment: Set<String> = [
        "session.create", "daemon.stop", "daemon.restart", "clean",
    ]
    static let maximumValueBytes = 256

    /// The environment default for `flag` on `command`, or nil. Flags always win; the caller
    /// consults this only when the flag was not supplied. Values that are empty, oversized, or
    /// contain control characters are ignored rather than forwarded.
    public static func defaultValue(flag: String, command: String,
                                    environment: [String: String]) -> String? {
        guard !commandsIgnoringEnvironment.contains(command),
              CLISpec.allowedFlags[command]?.contains(flag) == true else { return nil }
        let variable: String
        switch flag {
        case "session": variable = sessionVariable
        case "lease": variable = leaseVariable
        default: return nil
        }
        guard let raw = environment[variable] else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= maximumValueBytes,
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
        return value
    }
}

/// `session create --export`: shell text for `eval`.
public enum SessionExport {
    /// POSIX single quotes: nothing inside is expanded, and an embedded quote is closed,
    /// escaped, and reopened.
    public static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func line(session: String, lease: UUID) -> String {
        "export \(CLIEnvironment.sessionVariable)=\(shellQuote(session)) "
            + "\(CLIEnvironment.leaseVariable)=\(lease.uuidString.lowercased())"
    }

    /// A shell comment, so the whole output stays `eval`-safe, naming when the lease lapses.
    public static func expiryComment(expiresAt: Date?, now: Date = Date()) -> String {
        guard let expiresAt else {
            return "# lease expiry not reported; renew with `spaceo session heartbeat`"
        }
        let seconds = Int(max(0, expiresAt.timeIntervalSince(now)).rounded())
        return "# lease expires at \(expiresAt.ISO8601Format()) (in \(seconds)s) unless renewed "
            + "by activity or `spaceo session heartbeat`"
    }
}
