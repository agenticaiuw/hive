import Foundation

/// MCP clients `spaceo setup` can register itself with.
public enum MCPClient: String, CaseIterable, Sendable {
    case claudeCode = "claude-code"
    case codex
    case cursor
    case claudeDesktop = "claude-desktop"
}

/// Why a client registration could not be produced. Every case names the fix because the caller
/// is a first-run flow and the user has no other context.
public enum MCPClientConfigError: Error, LocalizedError, Equatable {
    case relativePath(String)
    case controlCharacters
    case missingExecutable(String)
    case tooLarge(Int)
    case malformedJSON(String)
    case malformedTOML(String)
    case unreadable(String)

    public var errorDescription: String? {
        switch self {
        case .relativePath(let path):
            return "executable path must be absolute (got '\(path)'); MCP clients do not expand ~ or PATH"
        case .controlCharacters:
            return "executable path contains control characters"
        case .missingExecutable(let path):
            return "no executable exists at \(path)"
        case .tooLarge(let bytes):
            return "existing configuration is \(bytes) bytes; refusing to rewrite files over \(MCPClientConfig.maximumConfigBytes) bytes"
        case .malformedJSON(let why):
            return "existing configuration is not a JSON object: \(why)"
        case .malformedTOML(let why):
            return "existing TOML configuration cannot be safely edited: \(why); not overwriting it"
        case .unreadable(let path):
            return "could not read \(path) as UTF-8 text; not overwriting it. Fix or move it, then retry"
        }
    }
}

/// Produces the edited contents of each client's configuration file with a `spaceo` server entry.
///
/// Printing three snippets and asking the user to paste them is where first-run flows die, so this
/// writes the registration for them. Two rules keep that safe: the user sees a diff before any
/// write, and everything that is not the `spaceo` entry is preserved (byte-for-byte for TOML,
/// structurally for JSON, which cannot round-trip formatting through `JSONSerialization`).
public struct MCPClientConfig {
    public static let serverName = "spaceo"
    /// Client configs are small hand-edited files; anything larger is not one we should rewrite.
    public static let maximumConfigBytes = 1 << 20
    /// Above this the line diff falls back to whole-file -/+ rather than an O(n·m) table.
    static let maximumDiffLines = 4000

    /// Where the client reads its configuration. Nil for clients with a registration command.
    public static func configFileURL(
        for client: MCPClient, home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL? {
        switch client {
        case .claudeCode:
            return nil
        case .codex:
            return home.appendingPathComponent(".codex/config.toml")
        case .cursor:
            return home.appendingPathComponent(".cursor/mcp.json")
        case .claudeDesktop:
            return home.appendingPathComponent(
                "Library/Application Support/Claude/claude_desktop_config.json")
        }
    }

    /// The registration command for clients that own their config format (Claude Code).
    public static func command(for client: MCPClient, executablePath: String) -> [String]? {
        switch client {
        case .claudeCode:
            // User scope: a registration made from one project directory must not silently
            // exist only there (Claude Code's default scope is the current project).
            return ClaudeCodeRegistration.addCommand(executablePath: executablePath)
        case .codex, .cursor, .claudeDesktop:
            return nil
        }
    }

    /// The current contents of a client config: nil only when no file exists. A file that exists
    /// but cannot be read as UTF-8 throws, because treating it as absent would overwrite it.
    public static func readExisting(at url: URL, fileManager _: FileManager = .default) throws -> String? {
        do {
            let data = try BoundedRegularFile.read(url, maximumBytes: maximumConfigBytes)
            guard let text = String(data: data, encoding: .utf8) else {
                throw MCPClientConfigError.unreadable(url.path)
            }
            return text
        } catch BoundedRegularFile.ReadError.missing {
            return nil
        } catch BoundedRegularFile.ReadError.tooLarge(let bytes) {
            throw MCPClientConfigError.tooLarge(bytes)
        } catch {
            throw MCPClientConfigError.unreadable(url.path)
        }
    }

    /// New file contents with the `spaceo` entry set to `executablePath mcp`.
    public static func merged(existing: String?, client: MCPClient, executablePath: String) throws
        -> String
    {
        if let existing, existing.utf8.count > maximumConfigBytes {
            throw MCPClientConfigError.tooLarge(existing.utf8.count)
        }
        try validateExecutablePath(executablePath, requireExists: false)
        switch client {
        case .claudeCode:
            return command(for: client, executablePath: executablePath)!.joined(separator: " ")
        case .codex:
            return try mergedTOML(existing: existing ?? "", executablePath: executablePath)
        case .cursor, .claudeDesktop:
            return try mergedJSON(existing: existing, executablePath: executablePath)
        }
    }

    // MARK: - JSON

    static func mergedJSON(existing: String?, executablePath: String) throws -> String {
        var root: [String: Any] = [:]
        let trimmed = existing?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            let object: Any
            do {
                object = try JSONSerialization.jsonObject(with: Data(trimmed.utf8))
            } catch {
                throw MCPClientConfigError.malformedJSON(error.localizedDescription)
            }
            guard let dictionary = object as? [String: Any] else {
                throw MCPClientConfigError.malformedJSON("top level is not an object")
            }
            root = dictionary
        }
        if let existingServers = root["mcpServers"], !(existingServers is [String: Any]) {
            throw MCPClientConfigError.malformedJSON("mcpServers must be an object; not overwriting it")
        }
        var servers = root["mcpServers"] as? [String: Any] ?? [:]
        servers[serverName] = ["command": executablePath, "args": ["mcp"]]
        root["mcpServers"] = servers
        let data = try JSONSerialization.data(
            withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    // MARK: - TOML

    static let tomlHeader = "[mcp_servers.\(serverName)]"

    static func tomlTable(executablePath: String) -> String {
        """
        \(tomlHeader)
        command = \(tomlString(executablePath))
        args = ["mcp"]
        """
    }

    /// Replace the existing `[mcp_servers.spaceo]` table or append one. Deliberately not a TOML
    /// parser: it only needs to find table boundaries, and rewriting the user's other tables would
    /// lose comments and formatting we have no business touching.
    static func mergedTOML(existing: String, executablePath: String) throws -> String {
        let table = tomlTable(executablePath: executablePath)
        if existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return table + "\n"
        }
        var lines = existing.components(separatedBy: "\n")
        if let range = try tomlTableRange(lines: lines) {
            lines.replaceSubrange(range, with: table.components(separatedBy: "\n"))
            return lines.joined(separator: "\n")
        }
        var result = existing
        if !result.hasSuffix("\n") { result += "\n" }
        if !result.hasSuffix("\n\n") { result += "\n" }
        return result + table + "\n"
    }

    /// Lines from the spaceo header up to (not including) the next table header. Blank and comment
    /// lines that lead into the next header stay with that header, so they are preserved.
    static func tomlTableRange(lines: [String]) throws -> Range<Int>? {
        try TOMLTableScanner.spaceOTableRange(lines: lines)
    }

    /// TOML basic string. Same escapes as JSON minus the optional `\/`, so one rule set serves both.
    static func tomlString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5C: result += "\\\\"
            case 0...0x1F, 0x7F: result += String(format: "\\u%04X", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    // MARK: - Diff

    /// Line diff with ` `, `-`, `+` prefixes. Shown before writing so the user can see exactly what
    /// changes in a file they may have hand-edited.
    public static func diff(old: String?, new: String) -> String {
        let oldLines = splitLines(old ?? "")
        let newLines = splitLines(new)
        if oldLines.count > maximumDiffLines || newLines.count > maximumDiffLines {
            return (oldLines.map { "-" + $0 } + newLines.map { "+" + $0 }).joined(separator: "\n")
        }
        let n = oldLines.count, m = newLines.count
        var table = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = oldLines[i] == newLines[j]
                    ? table[i + 1][j + 1] + 1
                    : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var output: [String] = []
        var i = 0, j = 0
        while i < n || j < m {
            if i < n, j < m, oldLines[i] == newLines[j] {
                output.append(" " + oldLines[i]); i += 1; j += 1
            } else if i < n, j == m || table[i + 1][j] >= table[i][j + 1] {
                // Deletions before insertions, as `diff` prints them.
                output.append("-" + oldLines[i]); i += 1
            } else {
                output.append("+" + newLines[j]); j += 1
            }
        }
        return output.joined(separator: "\n")
    }

    private static func splitLines(_ text: String) -> [String] {
        if text.isEmpty { return [] }
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    // MARK: - Paths

    /// MCP clients exec the command directly; a literal `~` in a written config never resolves.
    public static func expandTilde(_ path: String) -> String {
        guard path == "~" || path.hasPrefix("~/") else { return path }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path == "~" ? home : home + path.dropFirst(1)
    }

    /// Absolute, present, and free of control characters (which would corrupt any config format).
    public static func validateExecutablePath(_ path: String) throws {
        try validateExecutablePath(path, requireExists: true)
    }

    static func validateExecutablePath(_ path: String, requireExists: Bool) throws {
        guard path.hasPrefix("/") else { throw MCPClientConfigError.relativePath(path) }
        if path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
            throw MCPClientConfigError.controlCharacters
        }
        if requireExists, !FileManager.default.isExecutableFile(atPath: path) {
            throw MCPClientConfigError.missingExecutable(path)
        }
    }
}
