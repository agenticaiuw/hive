import Darwin
import Foundation

/// One `spaceo` server entry found in an MCP client's configuration.
public struct MCPClientRegistration: Equatable, Sendable {
    public var client: MCPClient
    /// `user`, `project <path>`, or `config` for clients with a single file.
    public var scope: String
    public var source: String
    /// The command exactly as configured; may be bare (`spaceo`) for PATH resolution.
    public var command: String
    public var arguments: [String]

    public init(client: MCPClient, scope: String, source: String, command: String,
                arguments: [String]) {
        self.client = client
        self.scope = scope
        self.source = source
        self.command = command
        self.arguments = arguments
    }
}

/// What doctor reports for one client registration, or for a client with none.
public struct MCPClientStatus: Equatable, Sendable {
    public var client: MCPClient
    public var registration: MCPClientRegistration?
    /// Absolute path the configured command resolves to, when it exists.
    public var resolvedPath: String?
    /// `spaceo version` of the configured binary; nil when it could not be run.
    public var version: String?
    /// Why the version is unknown, when it is.
    public var problem: String?
    /// nil when there is nothing to compare (not configured, or unknown version).
    public var matchesCLI: Bool?
    /// One line naming the fix, for a stale or broken registration.
    public var remedy: String?

    public init(client: MCPClient, registration: MCPClientRegistration? = nil,
                resolvedPath: String? = nil, version: String? = nil, problem: String? = nil,
                matchesCLI: Bool? = nil, remedy: String? = nil) {
        self.client = client
        self.registration = registration
        self.resolvedPath = resolvedPath
        self.version = version
        self.problem = problem
        self.matchesCLI = matchesCLI
        self.remedy = remedy
    }
}

/// Reads which `spaceo` binary each MCP client launches. Callers choose whether to execute
/// external version probes; a configured wrapper or unrelated executable may have side effects.
///
/// MCP tools come from the binary the client launches, not from the daemon, so an upgraded daemon
/// does not give a client new tools while its config still names an old copy. This is the check
/// that says so. Every read is bounded and every failure degrades to "unknown", never to a write.
public enum MCPClientInspection {
    /// `~/.claude.json` grows with project history; this bound is generous for it and still
    /// keeps doctor from reading an arbitrary large file.
    public static let maximumConfigBytes = 16 << 20
    /// Project entries reported per client; the rest are summarized by count.
    public static let maximumProjectEntries = 16
    static let maximumVersionOutputBytes = 4_096

    /// `$HOME` when it is an absolute path, else the account's home directory. Honoring `HOME`
    /// is what every other CLI does, and it lets a test point doctor at a fixture directory
    /// instead of the user's real client configs.
    public static func defaultHome(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let home = environment["HOME"], home.hasPrefix("/") {
            return URL(fileURLWithPath: home, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    public static func claudeCodeUserConfigURL(home: URL) -> URL {
        home.appendingPathComponent(".claude.json")
    }

    /// Bounded read of a regular file; nil for anything missing, oversized, or not UTF-8.
    public static func boundedRead(_ url: URL) -> String? {
        guard let data = try? BoundedRegularFile.read(url, maximumBytes: maximumConfigBytes) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Every registration across the clients `MCPClientConfig` knows, in client order.
    public static func registrations(
        home: URL = MCPClientInspection.defaultHome(),
        read: (URL) -> String? = MCPClientInspection.boundedRead
    ) -> [MCPClientRegistration] {
        var found: [MCPClientRegistration] = []
        for client in MCPClient.allCases {
            switch client {
            case .claudeCode:
                let url = claudeCodeUserConfigURL(home: home)
                if let text = read(url) {
                    found += claudeCodeRegistrations(json: text, source: url.path)
                }
            case .codex:
                if let url = MCPClientConfig.configFileURL(for: client, home: home),
                   let text = read(url),
                   let entry = tomlRegistration(toml: text, source: url.path) {
                    found.append(entry)
                }
            case .cursor, .claudeDesktop:
                if let url = MCPClientConfig.configFileURL(for: client, home: home),
                   let text = read(url),
                   let object = jsonObject(text),
                   let entry = serverEntry(in: object["mcpServers"], client: client,
                                           scope: "config", source: url.path) {
                    found.append(entry)
                }
            }
        }
        return found
    }

    /// Claude Code keeps the user-scope entry at top level and per-project entries under
    /// `projects[path]`. Both launch whatever command they name.
    static func claudeCodeRegistrations(json: String, source: String) -> [MCPClientRegistration] {
        guard let root = jsonObject(json) else { return [] }
        var found: [MCPClientRegistration] = []
        if let user = serverEntry(in: root["mcpServers"], client: .claudeCode, scope: "user",
                                  source: source) {
            found.append(user)
        }
        if let projects = root["projects"] as? [String: Any] {
            var projectEntries: [MCPClientRegistration] = []
            for path in projects.keys.sorted() {
                guard let project = projects[path] as? [String: Any],
                      let entry = serverEntry(in: project["mcpServers"], client: .claudeCode,
                                              scope: "project \(path)", source: source) else { continue }
                projectEntries.append(entry)
            }
            found += projectEntries.prefix(maximumProjectEntries)
        }
        return found
    }

    static func jsonObject(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func serverEntry(in servers: Any?, client: MCPClient, scope: String, source: String)
        -> MCPClientRegistration?
    {
        guard let servers = servers as? [String: Any],
              let entry = servers[MCPClientConfig.serverName] as? [String: Any],
              let command = entry["command"] as? String, !command.isEmpty,
              command.utf8.count <= 4_096 else { return nil }
        let arguments = (entry["args"] as? [Any])?.compactMap { $0 as? String } ?? []
        return MCPClientRegistration(client: client, scope: scope, source: source,
                                     command: command, arguments: Array(arguments.prefix(16)))
    }

    /// The `[mcp_servers.spaceo]` table's `command` and `args`. Same table finder the writer
    /// uses; only basic strings (the form the writer emits) are understood.
    static func tomlRegistration(toml: String, source: String) -> MCPClientRegistration? {
        let lines = toml.components(separatedBy: "\n")
        guard let range = try? MCPClientConfig.tomlTableRange(lines: lines),
              let assignments = try? TOMLTableScanner.assignments(lines: lines[range].dropFirst()) else { return nil }
        var command: String?
        var arguments: [String] = []
        for (key, value) in assignments {
            if key == ["command"] {
                command = tomlBasicString(value)
            } else if key == ["args"], let data = value.data(using: .utf8),
                      let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [Any] {
                // The writer emits `["mcp"]`, which is also a JSON array.
                arguments = Array(parsed.compactMap { $0 as? String }.prefix(16))
            }
        }
        guard let command, !command.isEmpty else { return nil }
        return MCPClientRegistration(client: .codex, scope: "config", source: source,
                                     command: command, arguments: arguments)
    }

    /// Decodes one leading TOML basic string, ignoring anything after its closing quote.
    static func tomlBasicString(_ text: String) -> String? {
        var scalars = Array(text.unicodeScalars)
        guard scalars.first == "\"" else { return nil }
        scalars.removeFirst()
        var value = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "\"" {
                return String(value)
            }
            if scalar == "\\" {
                guard index + 1 < scalars.count else { return nil }
                let escaped = scalars[index + 1]
                switch escaped {
                case "\"": value.append("\"")
                case "\\": value.append("\\")
                case "n": value.append("\n")
                case "t": value.append("\t")
                case "u", "U":
                    let length = escaped == "u" ? 4 : 8
                    guard index + 1 + length < scalars.count else { return nil }
                    let hex = String(String.UnicodeScalarView(scalars[(index + 2)...(index + 1 + length)]))
                    guard let code = UInt32(hex, radix: 16), let decoded = Unicode.Scalar(code) else {
                        return nil
                    }
                    value.append(decoded)
                    index += length
                default:
                    return nil
                }
                index += 2
                continue
            }
            value.append(scalar)
            index += 1
        }
        return nil
    }

    // MARK: - Status

    /// `spaceo X.Y.Z` (text) or `{"version":"X.Y.Z"}` (JSON), from any SpaceO release.
    public static func parseVersionOutput(_ output: String) -> String? {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{"), let object = jsonObject(trimmed),
           let version = object["version"] as? String {
            return validVersion(version)
        }
        let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? ""
        let fields = firstLine.split(separator: " ")
        guard fields.count == 2, fields[0] == "spaceo" else { return nil }
        return validVersion(String(fields[1]))
    }

    static func validVersion(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.count <= 64,
              raw.allSatisfy({ $0.isNumber || $0.isLetter || $0 == "." || $0 == "-" || $0 == "+" })
        else { return nil }
        return raw
    }

    /// Absolute path for a configured command: as-is when absolute, else the first executable
    /// match on `pathVariable` (what a client with the same PATH would launch).
    public static func resolve(command: String, pathVariable: String?,
                               isExecutable: (String) -> Bool) -> String? {
        let expanded = MCPClientConfig.expandTilde(command)
        if expanded.hasPrefix("/") { return isExecutable(expanded) ? expanded : nil }
        guard !expanded.contains("/") else { return nil }
        for directory in (pathVariable ?? "").split(separator: ":").prefix(64)
        where directory.hasPrefix("/") {
            let candidate = (String(directory) as NSString).appendingPathComponent(expanded)
            if isExecutable(candidate) { return candidate }
        }
        return nil
    }

    /// Status for one registration using an explicitly supplied version provider. Passive callers
    /// disable external probes and supply the loaded version for `cliPath` without executing it.
    public static func status(
        for registration: MCPClientRegistration,
        cliVersion: String,
        cliPath: String,
        resolve: (String) -> String?,
        probe: (String) -> String?,
        allowExternalVersionProbe: Bool = true
    ) -> MCPClientStatus {
        var status = MCPClientStatus(client: registration.client, registration: registration)
        let register = "`spaceo setup --client \(registration.client.rawValue)`"
        guard let path = resolve(registration.command) else {
            status.problem = "\(registration.command) does not exist or is not executable"
            status.remedy = "re-register this build with \(register), then restart "
                + registration.client.displayName
            return status
        }
        status.resolvedPath = path
        guard allowExternalVersionProbe || path == cliPath else {
            status.problem = "external command was not executed by this read-only check"
            status.remedy = "use `spaceo doctor --probe-client-versions` to execute configured commands "
                + "with `version`, or re-register this build with \(register)"
            if registration.arguments.first != "mcp" {
                status.problem = "configured arguments do not start with mcp; external command was not executed"
            }
            return status
        }
        guard let version = probe(path) else {
            status.problem = "`\(path) version` did not answer"
            status.remedy = "check \(path) runs, or re-register this build with \(register)"
            return status
        }
        status.version = version
        status.matchesCLI = version == cliVersion
        if version != cliVersion {
            status.remedy = path == cliPath
                ? "restart \(registration.client.displayName) so it relaunches \(path)"
                : "\(registration.client.displayName) launches \(path) (\(version)); update that file "
                    + "(`make install` for source builds) or re-register this build with \(register), "
                    + "then restart \(registration.client.displayName)"
        }
        if registration.arguments.first != "mcp" {
            status.problem = "configured arguments are \(registration.arguments) rather than [\"mcp\"]"
            status.remedy = status.remedy ?? "re-register with \(register)"
        }
        return status
    }

    /// Statuses for every client, one line per registration plus a not-configured line for
    /// clients with none. Probes each permitted distinct path once. The injected-provider API
    /// preserves its existing probing default; read-only doctor disables external probes.
    public static func statuses(
        registrations: [MCPClientRegistration],
        cliVersion: String,
        cliPath: String,
        resolve: (String) -> String?,
        probe: (String) -> String?,
        allowExternalVersionProbe: Bool = true
    ) -> [MCPClientStatus] {
        var cache: [String: String?] = [:]
        let cachedProbe: (String) -> String? = { path in
            if let hit = cache[path] { return hit }
            let value = probe(path)
            cache[path] = value
            return value
        }
        var result: [MCPClientStatus] = []
        for client in MCPClient.allCases {
            let entries = registrations.filter { $0.client == client }
            if entries.isEmpty {
                result.append(MCPClientStatus(client: client))
                continue
            }
            for entry in entries {
                result.append(status(for: entry, cliVersion: cliVersion, cliPath: cliPath,
                                     resolve: resolve, probe: cachedProbe,
                                     allowExternalVersionProbe: allowExternalVersionProbe))
            }
        }
        return result
    }

    /// Runs `<path> version` with a hard deadline and bounded output. Never throws; nil means
    /// "could not tell".
    public static func probeVersion(path: String, timeout: TimeInterval = 3) -> String? {
        guard timeout.isFinite, timeout > 0 else { return nil }
        let deadline = ContinuousClock.now.advanced(by: .seconds(min(timeout, 10)))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["version"]
        let pipe = Pipe()
        defer {
            try? pipe.fileHandleForReading.close()
            try? pipe.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
        }
        let descriptor = pipe.fileHandleForReading.fileDescriptor
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { return nil }
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        try? pipe.fileHandleForWriting.close()
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: maximumVersionOutputBytes + 1)
        var reachedEOF = false
        // Drain while the process runs: waiting first can fill the pipe, and a descendant
        // can retain stdout after its parent exits. Neither may bypass the same deadline.
        while ContinuousClock.now < deadline {
            if !reachedEOF {
                let count = Darwin.read(descriptor, &buffer, buffer.count)
                if count > 0 {
                    guard count <= maximumVersionOutputBytes - data.count else { return nil }
                    data.append(contentsOf: buffer.prefix(count))
                    continue
                }
                if count == 0 { reachedEOF = true }
                else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { return nil }
            }
            if reachedEOF && !process.isRunning {
                guard process.terminationStatus == 0 else { return nil }
                return parseVersionOutput(String(decoding: data, as: UTF8.self))
            }
            usleep(1_000)
        }
        return nil
    }
}

extension MCPClient {
    /// Product name for sentences.
    public var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .cursor: return "Cursor"
        case .claudeDesktop: return "Claude Desktop"
        }
    }
}

// MARK: - Claude Code registration

/// `spaceo setup --client claude-code`: find `claude`, register at user scope, and replace an
/// existing entry rather than failing on it.
public enum ClaudeCodeRegistration {
    /// Locations checked after PATH, for shells whose PATH the CLI did not inherit.
    public static func fallbackLocations(home: String) -> [String] {
        ["/usr/local/bin/claude", "/opt/homebrew/bin/claude",
         (home as NSString).appendingPathComponent(".claude/local/claude"),
         (home as NSString).appendingPathComponent(".local/bin/claude")]
    }

    /// `claude` from PATH first (where npm, nvm, and volta installs live), then the fallbacks.
    public static func resolveExecutable(pathVariable: String?, home: String,
                                         isExecutable: (String) -> Bool) -> String? {
        if let found = MCPClientInspection.resolve(command: "claude", pathVariable: pathVariable,
                                                   isExecutable: isExecutable) {
            return found
        }
        return fallbackLocations(home: home).first(where: isExecutable)
    }

    public static func addCommand(executablePath: String) -> [String] {
        ["claude", "mcp", "add", "-s", "user", MCPClientConfig.serverName, "--", executablePath, "mcp"]
    }

    public static func removeCommand() -> [String] {
        ["claude", "mcp", "remove", "-s", "user", MCPClientConfig.serverName]
    }

    /// `claude mcp add` refuses a name that already exists, so an existing user-scope entry is
    /// removed first. Both commands are shown before anything runs.
    public static func commands(executablePath: String, existingUserEntry: Bool) -> [[String]] {
        (existingUserEntry ? [removeCommand()] : []) + [addCommand(executablePath: executablePath)]
    }

    /// POSIX shell rendering of one argv, quoting only where needed.
    public static func shellLine(_ argv: [String]) -> String {
        argv.map { argument in
            let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_./=:+,@%"))
            if !argument.isEmpty, argument.unicodeScalars.allSatisfy(safe.contains) { return argument }
            return SessionExport.shellQuote(argument)
        }.joined(separator: " ")
    }

    /// A registration that names a SwiftPM build product breaks on the next clean build or
    /// branch switch. Nil when the path is fine.
    public static func buildDirectoryWarning(executablePath: String, home: String) -> String? {
        let components = executablePath.split(separator: "/")
        guard components.contains(".build") else { return nil }
        let installed = (home as NSString).appendingPathComponent(".local/bin/spaceo")
        return "\(executablePath) is inside a .build directory, which the next build or clean "
            + "replaces. Run `make install`, then register \(installed) instead: "
            + "\(installed) setup --client claude-code"
    }
}
