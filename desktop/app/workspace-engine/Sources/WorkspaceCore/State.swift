// Where the workspace engine keeps its state, and the session record. The background process that
// owns the display keeps the record current, so if that process dies, the next one knows which
// apps the old session had left behind and can tidy them away.
import Darwin
import Foundation

public enum Paths {
    /// Hive's state folder: `AGENT_STATE_DIR`, else the older "Personal Agent" folder while it
    /// exists, else ~/Library/Application Support/Hive.
    public static func stateDir(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let custom = environment["AGENT_STATE_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let legacy = home.appendingPathComponent("Library/Application Support/Personal Agent", isDirectory: true)
        if FileManager.default.fileExists(atPath: legacy.path) { return legacy }
        return home.appendingPathComponent("Library/Application Support/Hive", isDirectory: true)
    }

    /// The engine's own folder inside the state folder.
    public static func engineDir(state: URL) -> URL {
        state.appendingPathComponent("workspace-engine", isDirectory: true)
    }
}

public enum JSONFile {
    public static func read(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object
    }

    /// Writes through a temporary file and a rename, so a reader never sees half a file.
    public static func write(_ object: Any, to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        try (data + Data("\n".utf8)).write(to: temporary)
        chmod(temporary.path, 0o600)
        if rename(temporary.path, url.path) != 0 {
            try? FileManager.default.removeItem(at: temporary)
            throw WorkspaceError("io", "could not write \(url.lastPathComponent)")
        }
    }

    public static func string(_ object: Any, pretty: Bool = true) -> String {
        let options: JSONSerialization.WritingOptions = pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: options) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// An exclusive advisory lock on a file, held until `release` or until the process ends.
public final class FileLock {
    private var descriptor: Int32

    public init(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        descriptor = open(url.path, O_RDWR | O_CREAT, 0o600)
        guard descriptor >= 0 else { throw WorkspaceError("io", "could not open \(url.lastPathComponent)") }
        while flock(descriptor, LOCK_EX) != 0 {
            if errno != EINTR {
                close(descriptor)
                throw WorkspaceError("io", "could not lock \(url.lastPathComponent)")
            }
        }
    }

    public func release() {
        if descriptor >= 0 {
            flock(descriptor, LOCK_UN)
            close(descriptor)
            descriptor = -1
        }
    }

    deinit { release() }
}

/// An app the session launched, or a managed browser it started.
public struct SessionApp: Codable, Equatable {
    public var name: String
    public var bundleID: String
    public var pid: Int32
    public var managedBrowser: Bool

    public init(name: String, bundleID: String, pid: Int32, managedBrowser: Bool = false) {
        self.name = name
        self.bundleID = bundleID
        self.pid = pid
        self.managedBrowser = managedBrowser
    }
}

/// The one workspace session, as every engine process sees it.
public struct SessionRecord: Codable, Equatable {
    public var version = 1
    public var id: String
    public var title: String
    public var preset: String
    public var displayID: UInt32
    public var width: Int
    public var height: Int
    /// The background process holding the display; the display ends with it.
    public var ownerPID: Int32
    public var createdAt: Double
    public var orphanGraceSeconds: Double
    public var ttlSeconds: Double
    /// The daemon run that made the display (its instance id).
    public var ownerInstance: String = ""
    /// When the client holding the session went away, if none holds it now.
    public var orphanedAt: Double?
    public var lastActivity: Double
    public var inputPaused = false
    /// "operator" while the user holds control, or the agent's own reason.
    public var pauseReason: String?
    public var apps: [SessionApp] = []
    public var browserPort: Int?
    public var attachedTarget: String?

    public init(id: String, title: String, preset: String, displayID: UInt32, width: Int, height: Int,
                ownerPID: Int32, orphanGraceSeconds: Double, ttlSeconds: Double, now: Double) {
        self.id = id
        self.title = title
        self.preset = preset
        self.displayID = displayID
        self.width = width
        self.height = height
        self.ownerPID = ownerPID
        self.createdAt = now
        self.orphanGraceSeconds = orphanGraceSeconds
        self.ttlSeconds = ttlSeconds
        self.lastActivity = now
    }
}

public func processAlive(_ pid: Int32) -> Bool {
    pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
}

public func now() -> Double { Date().timeIntervalSince1970 }

/// The session record file and its lock.
public final class SessionStore {
    public let directory: URL
    public var recordURL: URL { directory.appendingPathComponent("session.json") }
    var lockURL: URL { directory.appendingPathComponent("session.lock") }

    public init(state: URL) {
        directory = Paths.engineDir(state: state)
    }

    public func load() -> SessionRecord? {
        guard let data = try? Data(contentsOf: recordURL) else { return nil }
        return try? JSONDecoder().decode(SessionRecord.self, from: data)
    }

    public func save(_ record: SessionRecord) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(record)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        try JSONFile.write(object, to: recordURL)
    }

    public func remove() {
        try? FileManager.default.removeItem(at: recordURL)
    }

    /// Runs `body` with the lock held; whatever it returns as the record is saved (nil removes it).
    @discardableResult
    public func update<T>(_ body: (inout SessionRecord?) throws -> T) throws -> T {
        let lock = try FileLock(lockURL)
        defer { lock.release() }
        var record = load()
        let before = record
        let result = try body(&record)
        if record != before {
            if let record { try save(record) } else { remove() }
        }
        return result
    }
}
