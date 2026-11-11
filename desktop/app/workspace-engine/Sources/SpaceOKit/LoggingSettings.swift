import Foundation
import Darwin

/// Durable, host-local diagnostic logging switches shared by the daemon, the MCP server, and the
/// CLI (`spaceo logging enable|disable|status`).
///
/// Environment variables win over the file so a single run can be instrumented without changing
/// the host: `SPACEO_JOURNAL=off|metadata|full`, and `SPACEO_LOG_METRICS=1` / `SPACEO_LOG_DEBUG=1`
/// for per-request daemon records. Everything stays on this Mac, owner-only (0600), bounded by
/// size and age; nothing is uploaded.
public struct LoggingSettings: Codable, Sendable, Equatable {

    /// How much the MCP agent journal keeps per tool call.
    public enum JournalLevel: String, Codable, Sendable, CaseIterable {
        case off
        /// Tool, redacted arguments, outcome, error code and recovery, timing, result size and
        /// the first line of the result — enough to rank friction without screen content.
        case metadata
        /// Additionally the rendered result text the agent read (bounded) and full file paths.
        /// Screen outlines can include app content; typed text and clipboard text are never kept.
        case full
    }

    public var journal: JournalLevel
    /// Record every daemon request, not only failures, in `daemon.log`.
    public var requestMetrics: Bool
    /// Journal day directories older than this are deleted when an MCP server starts.
    public var retentionDays: Int
    /// Per-file cap for one journal file and the daemon log's rotation size while enabled.
    public var maxFileMegabytes: Int

    public static let retentionRange = 1...90
    public static let fileSizeRange = 1...500

    public init(journal: JournalLevel = .off, requestMetrics: Bool = false,
                retentionDays: Int = 14, maxFileMegabytes: Int = 50) {
        self.journal = journal
        self.requestMetrics = requestMetrics
        self.retentionDays = retentionDays
        self.maxFileMegabytes = maxFileMegabytes
    }

    /// True when any per-call logging beyond the always-on failure log is enabled.
    public var isEnabled: Bool { journal != .off || requestMetrics }

    public var maxFileBytes: Int { maxFileMegabytes * 1_048_576 }

    public func validated() throws -> LoggingSettings {
        guard Self.retentionRange.contains(retentionDays) else {
            throw SpaceOError.badRequest("retention must be from 1 through 90 days")
        }
        guard Self.fileSizeRange.contains(maxFileMegabytes) else {
            throw SpaceOError.badRequest("the per-file cap must be from 1 through 500 MB")
        }
        return self
    }

    // MARK: Locations

    public static func defaultFileURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/Application Support/SpaceO/logging.json", isDirectory: false)
    }

    /// Root of the per-day, per-connection MCP journal files.
    public static func journalDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let override = environment["SPACEO_JOURNAL_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return home.appendingPathComponent("Library/Logs/SpaceO/journal", isDirectory: true)
    }

    // MARK: Loading and saving

    /// Where the effective value of each switch came from, for `spaceo logging status`.
    public struct Resolution: Sendable, Equatable {
        public var settings: LoggingSettings
        public var fileExists: Bool
        public var environmentOverrides: [String]
    }

    /// File value (or defaults), then environment overrides. An unreadable or invalid file is
    /// treated as absent: logging must never stop the daemon or an agent from working.
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileURL: URL = defaultFileURL()
    ) -> Resolution {
        var settings = LoggingSettings()
        var fileExists = false
        if let data = readSettingsData(fileURL),
           let decoded = try? JSONDecoder().decode(LoggingSettings.self, from: data),
           let valid = try? decoded.validated() {
            settings = valid
            fileExists = true
        }
        var overrides: [String] = []
        if let raw = environment["SPACEO_JOURNAL"], let level = JournalLevel(rawValue: raw.lowercased()) {
            settings.journal = level
            overrides.append("SPACEO_JOURNAL=\(level.rawValue)")
        }
        for key in ["SPACEO_LOG_METRICS", "SPACEO_LOG_DEBUG"] where environment[key] == "1" {
            settings.requestMetrics = true
            overrides.append("\(key)=1")
        }
        return Resolution(settings: settings, fileExists: fileExists, environmentOverrides: overrides)
    }

    /// Bound allocation before reading, including files that grow after fstat. Refuse special
    /// files so a malformed local setting cannot stall the request path on a pipe or device.
    static func readSettingsData(_ url: URL) -> Data? {
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var info = stat()
        let limit = 16_384
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size >= 0, info.st_size <= limit else { return nil }
        var data = Data(count: limit + 1)
        var used = 0
        let valid = data.withUnsafeMutableBytes { buffer in
            while used < buffer.count {
                let count = read(descriptor, buffer.baseAddress!.advanced(by: used), buffer.count - used)
                if count == 0 { return used <= limit }
                if count < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                used += count
            }
            return false
        }
        guard valid else { return nil }
        data.count = used
        return data
    }

    public static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileURL: URL = defaultFileURL()
    ) -> LoggingSettings {
        resolve(environment: environment, fileURL: fileURL).settings
    }

    /// Owner-only, atomic write.
    public func save(to fileURL: URL = LoggingSettings.defaultFileURL()) throws {
        let valid = try validated()
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(valid).write(to: fileURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}

/// Re-reads the settings file when it changes, at most once per `interval`, so enabling or
/// disabling logging reaches an already-running daemon or MCP server without a restart.
public final class LoggingSettingsMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private let fileURL: URL
    private let environment: [String: String]
    private let interval: TimeInterval
    private let now: () -> Date
    private var cached: LoggingSettings
    private var modified: Date?
    private var checkedAt: Date

    public init(fileURL: URL = LoggingSettings.defaultFileURL(),
                environment: [String: String] = ProcessInfo.processInfo.environment,
                interval: TimeInterval = 5, now: @escaping () -> Date = { Date() }) {
        self.fileURL = fileURL
        self.environment = environment
        self.interval = interval
        self.now = now
        self.cached = LoggingSettings.load(environment: environment, fileURL: fileURL)
        self.modified = Self.modificationDate(fileURL)
        self.checkedAt = now()
    }

    public var current: LoggingSettings {
        lock.withLock {
            let time = now()
            guard time.timeIntervalSince(checkedAt) >= interval else { return cached }
            checkedAt = time
            let stamp = Self.modificationDate(fileURL)
            if stamp != modified {
                modified = stamp
                cached = LoggingSettings.load(environment: environment, fileURL: fileURL)
            }
            return cached
        }
    }

    private static func modificationDate(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }
}

/// `spaceo logging enable|disable|status`, kept pure so the CLI stays a thin shell.
public enum LoggingCommand {
    public static let subcommands = ["status", "enable", "disable"]

    /// The settings `enable` writes. `full` is the default because the purpose is an improvement
    /// loop that needs to see what the agent read; `--level metadata` omits result text.
    public static func enabled(from current: LoggingSettings, level: String?,
                               retentionDays: Int?, maxFileMegabytes: Int?) throws -> LoggingSettings {
        var settings = current
        if let level {
            guard let parsed = LoggingSettings.JournalLevel(rawValue: level.lowercased()),
                  parsed != .off else {
                throw SpaceOError.badRequest("--level must be metadata or full")
            }
            settings.journal = parsed
        } else {
            settings.journal = .full
        }
        settings.requestMetrics = true
        if let retentionDays { settings.retentionDays = retentionDays }
        if let maxFileMegabytes { settings.maxFileMegabytes = maxFileMegabytes }
        return try settings.validated()
    }

    public static func disabled(from current: LoggingSettings) -> LoggingSettings {
        var settings = current
        settings.journal = .off
        settings.requestMetrics = false
        return settings
    }

    public static func statusLines(_ resolution: LoggingSettings.Resolution, settingsFile: URL,
                                   journalDirectory: URL, daemonLog: URL) -> [String] {
        let settings = resolution.settings
        var lines = [
            "agent journal  : \(settings.journal.rawValue)"
                + (settings.journal == .full ? " (includes the result text agents read)" : ""),
            "daemon requests: \(settings.requestMetrics ? "every request" : "failures only")",
            "retention      : \(settings.retentionDays) day(s); \(settings.maxFileMegabytes) MB per file",
            "settings file  : \(settingsFile.path)" + (resolution.fileExists ? "" : " (not written; defaults)"),
            "journal dir    : \(journalDirectory.path)",
            "daemon log     : \(daemonLog.path)",
        ]
        if !resolution.environmentOverrides.isEmpty {
            lines.append("environment    : \(resolution.environmentOverrides.joined(separator: ", ")) (overrides the file for processes that inherit it)")
        }
        lines.append("summarize with : node scripts/journal-report.mjs \(journalDirectory.path) --daemon-log \(daemonLog.path)")
        return lines
    }
}
