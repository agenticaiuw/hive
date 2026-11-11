import AppKit
import Foundation
import Observation
import SpaceOKit

/// Whether one MCP client can reach SpaceO, from the person's point of view.
enum ViewerAgentConnectionState: Equatable, Sendable {
    case checking
    case notInstalled
    case notConnected
    /// Registered, launching `path`. `current` is false when that is not this Viewer's `spaceo`
    /// and no longer runs; a registration pointing at a working install still counts.
    case connected(path: String, current: Bool)
    /// Registered, but the command it launches is missing or not executable.
    case broken(path: String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// The clients the Viewer can connect in one click, and their state. Detection reads config
/// files and looks for executables; it never launches a client. Connecting writes exactly the
/// `spaceo` entry through `MCPClientConfig` (other entries are preserved) or runs
/// `claude mcp add`, the same paths as `spaceo setup --client`.
@MainActor
@Observable
final class ViewerAgentConnections {
    private(set) var states: [MCPClient: ViewerAgentConnectionState] =
        Dictionary(uniqueKeysWithValues: MCPClient.allCases.map { ($0, .checking) })
    private(set) var busy: Set<MCPClient> = []
    /// The last outcome per client: "Restart Cursor to pick it up", or an error.
    private(set) var messages: [MCPClient: (text: String, isError: Bool)] = [:]
    @ObservationIgnored private var refreshing = false
    /// Preview scenarios pin the states instead of reading this Mac's configuration.
    @ObservationIgnored var pinnedStates: [MCPClient: ViewerAgentConnectionState]?

    /// The `spaceo` the Viewer registers: its bundled helper, else the sibling or bare command.
    nonisolated static var spaceoPath: String { ViewerAgentClient.resolvedSpaceOPath() }

    func refresh() {
        if let pinnedStates {
            states = pinnedStates
            return
        }
        guard !refreshing else { return }
        refreshing = true
        Task.detached(priority: .utility) {
            let detected = Self.detect()
            await MainActor.run {
                self.states = detected
                self.refreshing = false
            }
        }
    }

    func connect(_ client: MCPClient) {
        guard !busy.contains(client), pinnedStates == nil else { return }
        busy.insert(client)
        messages[client] = nil
        let path = Self.spaceoPath
        Task.detached(priority: .userInitiated) {
            let result: Result<String, Error> = Result { try Self.register(client, spaceoPath: path) }
            let detected = Self.detect()
            await MainActor.run {
                self.busy.remove(client)
                self.states = detected
                switch result {
                case let .success(message): self.messages[client] = (message, false)
                case let .failure(error): self.messages[client] = (error.localizedDescription, true)
                }
            }
        }
    }

    // MARK: - Detection

    nonisolated static func detect() -> [MCPClient: ViewerAgentConnectionState] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let registrations = MCPClientInspection.registrations(home: home)
        let path = loginShellPATH()
        var result: [MCPClient: ViewerAgentConnectionState] = [:]
        for client in MCPClient.allCases {
            result[client] = state(
                for: client,
                registrations: registrations,
                installed: isInstalled(client, home: home, pathVariable: path),
                spaceoPath: spaceoPath,
                isExecutable: FileManager.default.isExecutableFile(atPath:))
        }
        return result
    }

    /// Pure: the state for one client from what detection found. A user-scope or config entry is
    /// what counts; a Claude Code entry scoped to one project reaches SpaceO only there.
    nonisolated static func state(
        for client: MCPClient,
        registrations: [MCPClientRegistration],
        installed: Bool,
        spaceoPath: String,
        isExecutable: (String) -> Bool
    ) -> ViewerAgentConnectionState {
        let entries = registrations.filter { $0.client == client }
        let entry = entries.first { $0.scope == "user" || $0.scope == "config" } ?? entries.first
        guard let entry else { return installed ? .notConnected : .notInstalled }
        let command = MCPClientConfig.expandTilde(entry.command)
        guard command.hasPrefix("/") ? isExecutable(command) : true else {
            return .broken(path: command)
        }
        return .connected(path: command, current: command == spaceoPath)
    }

    nonisolated static func isInstalled(_ client: MCPClient, home: URL,
                                        pathVariable: String?) -> Bool {
        let fileManager = FileManager.default
        func exists(_ relative: String) -> Bool {
            fileManager.fileExists(atPath: home.appendingPathComponent(relative).path)
        }
        func app(_ bundleID: String) -> Bool {
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
        }
        switch client {
        case .claudeCode:
            return ClaudeCodeRegistration.resolveExecutable(
                pathVariable: pathVariable, home: home.path,
                isExecutable: fileManager.isExecutableFile(atPath:)) != nil
        case .codex:
            return MCPClientInspection.resolve(
                command: "codex", pathVariable: pathVariable,
                isExecutable: fileManager.isExecutableFile(atPath:)) != nil
                || exists(".codex") || app("com.openai.codex")
        case .cursor:
            return app("com.todesktop.230313mzl4w4u92") || exists(".cursor")
        case .claudeDesktop:
            return app("com.anthropic.claudefordesktop")
                || exists("Library/Application Support/Claude")
        }
    }

    /// An app started from Finder inherits launchd's short PATH, not the one the person's shell
    /// sets up — which is where `claude` and `codex` usually live. Ask a login shell once.
    nonisolated static func loginShellPATH() -> String? {
        cachedPATH.withLock { cached in
            if let cached { return cached }
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            let process = Process()
            process.executableURL = URL(fileURLWithPath: shell)
            process.arguments = ["-lc", "printf %s \"$PATH\""]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            var found = ProcessInfo.processInfo.environment["PATH"]
            if (try? process.run()) != nil {
                let deadline = Date().addingTimeInterval(3)
                while process.isRunning, Date() < deadline { usleep(20_000) }
                if process.isRunning {
                    process.terminate()
                } else if process.terminationStatus == 0 {
                    let data = pipe.fileHandleForReading.readData(ofLength: 16_384)
                    let value = String(decoding: data, as: UTF8.self)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !value.isEmpty {
                        found = [value, found].compactMap { $0 }.joined(separator: ":")
                    }
                }
            }
            cached = found
            return found
        }
    }

    private nonisolated static let cachedPATH = ViewerLockedBox<String?>(nil)

    // MARK: - Registration

    enum RegistrationError: LocalizedError {
        case claudeNotFound(String)
        case commandFailed(String, Int32)
        case noConfigLocation

        var errorDescription: String? {
            switch self {
            case let .claudeNotFound(command):
                "Couldn't find the `claude` command. Run this in a terminal instead: \(command)"
            case let .commandFailed(command, status):
                "`\(command)` exited with status \(status)."
            case .noConfigLocation:
                "This client has no configuration file to write."
            }
        }
    }

    /// Register `spaceoPath` with `client`. Returns the sentence to show on success.
    nonisolated static func register(_ client: MCPClient, spaceoPath: String) throws -> String {
        try MCPClientConfig.validateExecutablePath(spaceoPath)
        let home = FileManager.default.homeDirectoryForCurrentUser
        switch client {
        case .claudeCode:
            let existing = MCPClientInspection.registrations(home: home)
                .contains { $0.client == .claudeCode && $0.scope == "user" }
            let commands = ClaudeCodeRegistration.commands(
                executablePath: spaceoPath, existingUserEntry: existing)
            guard let claude = ClaudeCodeRegistration.resolveExecutable(
                pathVariable: loginShellPATH(), home: home.path,
                isExecutable: FileManager.default.isExecutableFile(atPath:)) else {
                throw RegistrationError.claudeNotFound(
                    ClaudeCodeRegistration.shellLine(commands.last ?? []))
            }
            for command in commands {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: claude)
                process.arguments = Array(command.dropFirst())
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                process.standardInput = FileHandle.nullDevice
                var environment = ProcessInfo.processInfo.environment
                if let path = loginShellPATH() { environment["PATH"] = path }
                process.environment = environment
                try process.run()
                let deadline = Date().addingTimeInterval(30)
                while process.isRunning, Date() < deadline { usleep(50_000) }
                if process.isRunning { process.terminate() }
                guard process.terminationStatus == 0 else {
                    throw RegistrationError.commandFailed(
                        ClaudeCodeRegistration.shellLine(command), process.terminationStatus)
                }
            }
            return "Connected. Start a new Claude Code session (or run /mcp) to use SpaceO."
        case .codex, .cursor, .claudeDesktop:
            guard let url = MCPClientConfig.configFileURL(for: client, home: home) else {
                throw RegistrationError.noConfigLocation
            }
            let existing = try? String(contentsOf: url, encoding: .utf8)
            let merged = try MCPClientConfig.merged(
                existing: existing, client: client, executablePath: spaceoPath)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try merged.write(to: url, atomically: true, encoding: .utf8)
            return "Connected. Restart \(client.displayName) to pick up SpaceO."
        }
    }
}

/// A value behind a lock, for caches read from detached tasks.
final class ViewerLockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
