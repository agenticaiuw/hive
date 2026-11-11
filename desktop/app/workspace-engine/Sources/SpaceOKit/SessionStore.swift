import Foundation
import Darwin

/// Whether SpaceO created an application process or adopted one that was already running.
///
/// This distinction is durable because it controls teardown after a daemon restart: a launched
/// app may be asked to quit, while an adopted app must never be terminated by SpaceO.
public enum DurableAppProvenance: String, Codable, Sendable, Equatable {
    case launched
    case adopted
}

/// The kind of controller that most recently held a session lease.
public enum DurableSessionOwnerKind: String, Codable, Sendable, Equatable {
    case cli
    case mcp
    case viewer
    case other
}

/// Durable, diagnostic identity for the controller of a session.
///
/// This is coordination metadata, not an authorization boundary. SpaceO's trust boundary remains
/// the local macOS user. `processIdentity` lets the runtime notice a controller that has exited
/// without relying on a recyclable PID.
public struct DurableSessionOwner: Codable, Sendable, Equatable {
    public var id: String
    public var kind: DurableSessionOwnerKind
    public var label: String
    public var processIdentity: ProcessIdentity?

    public init(
        id: String,
        kind: DurableSessionOwnerKind,
        label: String,
        processIdentity: ProcessIdentity? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.processIdentity = processIdentity
    }
}

/// The last controller lease written by a daemon.
///
/// A daemon restart must fence this lease by comparing `daemonInstanceID` with its new instance
/// id. Persisting the old lease is useful for audit and recovery decisions, but never makes it
/// valid in a later daemon.
public struct DurableSessionLease: Codable, Sendable, Equatable {
    public var daemonInstanceID: UUID
    public var leaseID: UUID
    public var generation: UInt64
    public var acquiredAt: Date
    public var lastHeartbeatAt: Date
    public var expiresAt: Date

    public init(
        daemonInstanceID: UUID,
        leaseID: UUID,
        generation: UInt64,
        acquiredAt: Date,
        lastHeartbeatAt: Date,
        expiresAt: Date
    ) {
        self.daemonInstanceID = daemonInstanceID
        self.leaseID = leaseID
        self.generation = generation
        self.acquiredAt = acquiredAt
        self.lastHeartbeatAt = lastHeartbeatAt
        self.expiresAt = expiresAt
    }
}

/// Last known tile placement. It is diagnostic after restart, not authority to reattach to or
/// retire a display with the same numeric id.
public struct DurableSessionPlacement: Codable, Sendable, Equatable {
    public var displayID: UInt32
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var tileIndex: Int
    public var tileCapacity: Int
    public var exclusiveDisplay: Bool

    public init(
        displayID: UInt32,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        tileIndex: Int,
        tileCapacity: Int,
        exclusiveDisplay: Bool
    ) {
        self.displayID = displayID
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.tileIndex = tileIndex
        self.tileCapacity = tileCapacity
        self.exclusiveDisplay = exclusiveDisplay
    }
}

public enum DurableSessionOwnershipState: String, Codable, Sendable, Equatable {
    case owned
    case abandoned
}

public enum DurableSessionRuntimeState: String, Codable, Sendable, Equatable {
    case attached
    case detached
}

/// Durable operational state. Transient manager locking remains an in-memory concern.
public enum DurableSessionOperationState: String, Codable, Sendable, Equatable {
    case ready
    /// A daemon exited between preparing and committing an app/session mutation.
    case mutationPending
    /// Teardown is terminal for new work but retained resources still require a retry.
    case cleanupPending
    /// Cleanup completed and the manager may remove the durable record.
    case cleanupComplete
}

/// What restart recovery may do with application processes while finishing teardown.
///
/// This intent is persisted before teardown starts. In particular, `releaseApps` makes
/// `session destroy --keep-apps` crash-safe: a replacement daemon may forget those apps, but it
/// must never reinterpret them as processes it is allowed to terminate.
public enum DurableSessionCleanupDisposition: String, Codable, Sendable, Equatable {
    case terminateLaunchedApps
    case releaseApps
}

/// Whether an abandoned record can currently be reclaimed.
///
/// This is stored as the last assessment. The runtime must derive it again from current process,
/// display, and ownership state after loading the ledger.
public enum DurableSessionRecoveryState: String, Codable, Sendable, Equatable {
    case notNeeded
    case reclaimable
    case blocked
}

public struct DurableRecoveryBlocker: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var processIdentity: ProcessIdentity?

    public init(code: String, message: String, processIdentity: ProcessIdentity? = nil) {
        self.code = code
        self.message = message
        self.processIdentity = processIdentity
    }
}

/// Durable application ledger entry.
///
/// `identity` is always the complete `ProcessIdentity`, never a bare PID. An imprecise identity
/// may still be represented so the runtime can report why recovery is blocked.
public struct DurableSessionApp: Codable, Sendable, Equatable {
    public var identity: ProcessIdentity
    public var provenance: DurableAppProvenance
    public var bundleIdentifier: String?
    public var name: String
    public var url: URL
    public var devToolsPort: Int?
    public var temporaryProfile: URL?
    public var temporaryControlRoot: URL?

    public init(
        identity: ProcessIdentity,
        provenance: DurableAppProvenance,
        bundleIdentifier: String?,
        name: String,
        url: URL,
        devToolsPort: Int? = nil,
        temporaryProfile: URL? = nil,
        temporaryControlRoot: URL? = nil
    ) {
        self.identity = identity
        self.provenance = provenance
        self.bundleIdentifier = bundleIdentifier
        self.name = name
        self.url = url
        self.devToolsPort = devToolsPort
        self.temporaryProfile = temporaryProfile
        self.temporaryControlRoot = temporaryControlRoot
    }
}

/// One durable session record, independent of the non-Codable WindowServer objects held by
/// `AgentSession`.
public struct DurableSessionRecord: Codable, Sendable, Equatable {
    public var id: String
    public var revision: UInt64
    public var createdAt: Date
    public var updatedAt: Date
    public var ownershipState: DurableSessionOwnershipState
    public var runtimeState: DurableSessionRuntimeState
    public var operationState: DurableSessionOperationState
    public var recoveryState: DurableSessionRecoveryState
    public var recoveryBlockers: [DurableRecoveryBlocker]
    /// When controller ownership was first abandoned. Preserved across repeated daemon starts.
    public var abandonedAt: Date?
    /// Earliest time at which explicit reclaim or destructive cleanup may proceed.
    public var reclaimableAfter: Date?
    /// Most recent successful controller heartbeat or owner-scoped mutation.
    ///
    /// Kept independently because a daemon restart fences and clears the old lease credential.
    public var lastActivityAt: Date?
    /// Retained when a session becomes abandoned so recovery UIs can describe the prior owner.
    public var owner: DurableSessionOwner?
    /// The last lease. A new daemon must invalidate it using its daemon instance id.
    public var lease: DurableSessionLease?
    public var lastKnownPlacement: DurableSessionPlacement?
    public var apps: [DurableSessionApp]
    /// Nil is the backwards-compatible spelling of `terminateLaunchedApps`.
    public var cleanupDisposition: DurableSessionCleanupDisposition?
    /// Human-facing metadata (SPAO-218). Additive: older ledgers decode with nil.
    public var title: String?
    public var colorTag: String?

    public init(
        id: String,
        revision: UInt64,
        createdAt: Date,
        updatedAt: Date,
        ownershipState: DurableSessionOwnershipState,
        runtimeState: DurableSessionRuntimeState,
        operationState: DurableSessionOperationState,
        recoveryState: DurableSessionRecoveryState,
        recoveryBlockers: [DurableRecoveryBlocker] = [],
        abandonedAt: Date? = nil,
        reclaimableAfter: Date? = nil,
        lastActivityAt: Date? = nil,
        owner: DurableSessionOwner? = nil,
        lease: DurableSessionLease? = nil,
        lastKnownPlacement: DurableSessionPlacement? = nil,
        apps: [DurableSessionApp] = [],
        cleanupDisposition: DurableSessionCleanupDisposition? = nil,
        title: String? = nil,
        colorTag: String? = nil
    ) {
        self.id = id
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.ownershipState = ownershipState
        self.runtimeState = runtimeState
        self.operationState = operationState
        self.recoveryState = recoveryState
        self.recoveryBlockers = recoveryBlockers
        self.abandonedAt = abandonedAt
        self.reclaimableAfter = reclaimableAfter
        self.lastActivityAt = lastActivityAt
        self.owner = owner
        self.lease = lease
        self.lastKnownPlacement = lastKnownPlacement
        self.apps = apps
        self.cleanupDisposition = cleanupDisposition
        self.title = title
        self.colorTag = colorTag
    }
}

/// Versioned top-level durable state.
public struct SessionLedger: Codable, Sendable, Equatable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var storeRevision: UInt64
    public var writerDaemonInstanceID: UUID
    public var updatedAt: Date
    /// Number to use for the next automatically named `agent-N` session.
    public var nextAutomaticSessionNumber: Int
    public var sessions: [DurableSessionRecord]

    public init(
        schemaVersion: Int = SessionLedger.currentSchemaVersion,
        storeRevision: UInt64,
        writerDaemonInstanceID: UUID,
        updatedAt: Date,
        nextAutomaticSessionNumber: Int,
        sessions: [DurableSessionRecord]
    ) {
        self.schemaVersion = schemaVersion
        self.storeRevision = storeRevision
        self.writerDaemonInstanceID = writerDaemonInstanceID
        self.updatedAt = updatedAt
        self.nextAutomaticSessionNumber = nextAutomaticSessionNumber
        self.sessions = sessions
    }
}

/// Fail-closed errors from the durable session ledger.
public enum SessionStoreError: Error, LocalizedError, CustomStringConvertible, Equatable {
    case invalidNamespace(String)
    case unsafePath(String)
    case readFailed(String)
    case writeFailed(String)
    case corruptLedger(String)
    case unsupportedSchema(found: Int, supported: Int)
    case invalidLedger(String)

    public var description: String {
        switch self {
        case .invalidNamespace(let reason):
            return "invalid session-store namespace: \(reason)"
        case .unsafePath(let reason):
            return "unsafe session-store path: \(reason)"
        case .readFailed(let reason):
            return "could not read the session ledger: \(reason)"
        case .writeFailed(let reason):
            return "could not write the session ledger: \(reason)"
        case .corruptLedger(let reason):
            return "the session ledger is corrupt: \(reason)"
        case .unsupportedSchema(let found, let supported):
            return "session ledger schema \(found) is unsupported; this build supports \(supported)"
        case .invalidLedger(let reason):
            return "invalid session ledger: \(reason)"
        }
    }

    public var errorDescription: String? { description }
}

/// Durable, socket-namespaced session storage.
///
/// `SessionStore` performs synchronous file I/O. Its lock prevents callers from interleaving
/// operations on one instance; the daemon's single-instance socket contract is still responsible
/// for ensuring two store instances do not write the same namespace concurrently.
public final class SessionStore: @unchecked Sendable {
    public static let maximumLedgerBytes = 16 * 1_024 * 1_024

    public let rootDirectory: URL
    public let namespace: String
    public let ledgerURL: URL

    private let lock = NSLock()
    private let beforeReplace: @Sendable (_ temporaryURL: URL, _ destinationURL: URL) throws -> Void
    private let afterReplace: @Sendable (_ destinationURL: URL) throws -> Void

    /// Use an explicitly named namespace. Names are restricted to safe filename characters.
    public convenience init(rootDirectory: URL, namespace: String) throws {
        try self.init(
            rootDirectory: rootDirectory,
            namespace: namespace,
            beforeReplace: { _, _ in },
            afterReplace: { _ in })
    }

    public convenience init(socketPath: String, rootDirectory: URL? = nil) throws {
        guard !socketPath.isEmpty, !socketPath.utf8.contains(0) else {
            throw SessionStoreError.invalidNamespace("socket path is empty or contains a NUL byte")
        }
        let root = try rootDirectory ?? Self.defaultRootDirectory()
        try self.init(
            rootDirectory: root,
            namespace: Self.namespace(forSocketPath: socketPath),
            beforeReplace: { _, _ in },
            afterReplace: { _ in })
    }

    /// Failure-injection seam for deterministic atomic-replacement tests.
    init(
        rootDirectory: URL,
        namespace: String,
        beforeReplace: @escaping @Sendable (URL, URL) throws -> Void,
        afterReplace: @escaping @Sendable (URL) throws -> Void = { _ in }
    ) throws {
        guard rootDirectory.isFileURL else {
            throw SessionStoreError.unsafePath("the root directory must be a file URL")
        }
        let root = rootDirectory.standardizedFileURL
        let rootPath = root.path
        let broadPaths = [
            "/",
            URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL.path,
            FileManager.default.temporaryDirectory.standardizedFileURL.path,
        ]
        guard !broadPaths.contains(rootPath) else {
            throw SessionStoreError.unsafePath(
                "refusing to use broad directory '\(rootPath)' as the ledger parent")
        }
        try Self.validate(namespace: namespace)
        self.rootDirectory = root
        self.namespace = namespace
        self.ledgerURL = root.appendingPathComponent(
            "sessions-\(namespace).json",
            isDirectory: false)
        self.beforeReplace = beforeReplace
        self.afterReplace = afterReplace
    }

    public static func defaultRootDirectory() throws -> URL {
        guard let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw SessionStoreError.unsafePath(
                "the user Application Support directory is unavailable")
        }
        return applicationSupport
            .appendingPathComponent("SpaceO", isDirectory: true)
            .appendingPathComponent("SessionState", isDirectory: true)
    }

    /// Stable, non-secret namespace for a socket path. The exact path is not exposed in a
    /// filename, and explicit namespace validation prevents path traversal.
    public static func namespace(forSocketPath socketPath: String) -> String {
        let normalized = URL(fileURLWithPath: socketPath).standardizedFileURL.path
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in normalized.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "socket-" + String(format: "%016llx", CUnsignedLongLong(hash))
    }

    /// Load the ledger, or return nil when this namespace has never been written.
    ///
    /// Corrupt and unsupported state throws. It is never treated as an empty ledger.
    public func load() throws -> SessionLedger? {
        try lock.withLock {
            try ensureRootDirectory()
            guard let data = try readLedgerData() else { return nil }

            let decoder = Self.makeDecoder()
            let probe: SchemaProbe
            do {
                probe = try decoder.decode(SchemaProbe.self, from: data)
            } catch {
                throw SessionStoreError.corruptLedger(
                    "missing or invalid schemaVersion: \(error.localizedDescription)")
            }
            guard probe.schemaVersion == SessionLedger.currentSchemaVersion else {
                throw SessionStoreError.unsupportedSchema(
                    found: probe.schemaVersion,
                    supported: SessionLedger.currentSchemaVersion)
            }

            let ledger: SessionLedger
            do {
                ledger = try decoder.decode(SessionLedger.self, from: data)
            } catch {
                throw SessionStoreError.corruptLedger(error.localizedDescription)
            }
            do {
                try Self.validate(ledger)
            } catch let error as SessionStoreError {
                throw SessionStoreError.corruptLedger(error.localizedDescription)
            } catch {
                throw SessionStoreError.corruptLedger(error.localizedDescription)
            }
            return ledger
        }
    }

    /// Atomically replace the current ledger.
    ///
    /// The temporary file is created in the ledger directory, written completely, fsynced, and
    /// renamed over the destination. The directory is then fsynced so the rename is durable.
    public func save(_ ledger: SessionLedger) throws {
        try lock.withLock {
            guard ledger.schemaVersion == SessionLedger.currentSchemaVersion else {
                throw SessionStoreError.unsupportedSchema(
                    found: ledger.schemaVersion,
                    supported: SessionLedger.currentSchemaVersion)
            }
            try Self.validate(ledger)
            try ensureRootDirectory()

            let data: Data
            do {
                data = try Self.makeEncoder().encode(ledger)
            } catch {
                throw SessionStoreError.writeFailed(
                    "encode failed: \(error.localizedDescription)")
            }
            guard Self.encodedLedgerFits(byteCount: data.count) else {
                throw SessionStoreError.invalidLedger(
                    "encoded ledger plus its newline exceeds "
                        + "\(Self.maximumLedgerBytes) bytes")
            }
            try writeAtomically(data)
        }
    }

    static func encodedLedgerFits(byteCount: Int) -> Bool {
        byteCount >= 0 && byteCount < maximumLedgerBytes
    }

    private struct SchemaProbe: Decodable {
        let schemaVersion: Int
    }

    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func validate(namespace: String) throws {
        guard !namespace.isEmpty, namespace.utf8.count <= 128 else {
            throw SessionStoreError.invalidNamespace(
                "it must contain from 1 through 128 UTF-8 bytes")
        }
        let allowed = CharacterSet(
            charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        guard namespace.unicodeScalars.allSatisfy(allowed.contains) else {
            throw SessionStoreError.invalidNamespace(
                "only letters, digits, '.', '_', and '-' are allowed")
        }
    }

    private static func validate(_ ledger: SessionLedger) throws {
        guard ledger.schemaVersion == SessionLedger.currentSchemaVersion else {
            throw SessionStoreError.unsupportedSchema(
                found: ledger.schemaVersion,
                supported: SessionLedger.currentSchemaVersion)
        }
        guard ledger.storeRevision > 0 else {
            throw SessionStoreError.invalidLedger("storeRevision must be positive")
        }
        guard ledger.nextAutomaticSessionNumber >= 0 else {
            throw SessionStoreError.invalidLedger(
                "nextAutomaticSessionNumber must not be negative")
        }

        var sessionIDs = Set<String>()
        var processIdentities = Set<ProcessIdentity>()
        for session in ledger.sessions {
            let id = session.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty,
                  id == session.id,
                  !id.contains("/"),
                  !id.contains("\\"),
                  id.unicodeScalars.allSatisfy({
                      !CharacterSet.controlCharacters.contains($0)
                  }) else {
                throw SessionStoreError.invalidLedger(
                    "session id '\(session.id)' is not canonical")
            }
            guard sessionIDs.insert(id).inserted else {
                throw SessionStoreError.invalidLedger("duplicate session id '\(id)'")
            }
            guard session.revision > 0 else {
                throw SessionStoreError.invalidLedger(
                    "session '\(id)' has a non-positive revision")
            }
            guard session.updatedAt >= session.createdAt else {
                throw SessionStoreError.invalidLedger(
                    "session '\(id)' was updated before it was created")
            }
            guard ledger.updatedAt >= session.updatedAt else {
                throw SessionStoreError.invalidLedger(
                    "ledger timestamp predates session '\(id)'")
            }

            if session.ownershipState == .owned {
                guard session.owner != nil, session.lease != nil else {
                    throw SessionStoreError.invalidLedger(
                        "owned session '\(id)' requires an owner and lease")
                }
            }
            if session.lease != nil, session.owner == nil {
                throw SessionStoreError.invalidLedger(
                    "session '\(id)' has a lease without an owner")
            }
            if let owner = session.owner {
                guard !owner.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !owner.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has an empty owner id or label")
                }
            }
            if let lease = session.lease {
                guard lease.generation > 0 else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has a non-positive lease generation")
                }
                guard lease.acquiredAt <= lease.lastHeartbeatAt,
                      lease.lastHeartbeatAt <= lease.expiresAt else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has inconsistent lease timestamps")
                }
            }
            if (session.abandonedAt == nil) != (session.reclaimableAfter == nil) {
                throw SessionStoreError.invalidLedger(
                    "session '\(id)' must store both abandonment timestamps or neither")
            }
            if let abandonedAt = session.abandonedAt,
               let reclaimableAfter = session.reclaimableAfter {
                guard session.ownershipState == .abandoned else {
                    throw SessionStoreError.invalidLedger(
                        "owned session '\(id)' cannot carry abandonment timestamps")
                }
                guard reclaimableAfter >= abandonedAt else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' is reclaimable before it was abandoned")
                }
            }
            if session.operationState == .cleanupComplete, !session.apps.isEmpty {
                throw SessionStoreError.invalidLedger(
                    "cleanup-complete session '\(id)' still contains app records")
            }

            switch session.recoveryState {
            case .blocked:
                guard !session.recoveryBlockers.isEmpty else {
                    throw SessionStoreError.invalidLedger(
                        "blocked session '\(id)' has no recovery blocker")
                }
            case .notNeeded, .reclaimable:
                guard session.recoveryBlockers.isEmpty else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has blockers but is not marked blocked")
                }
            }
            for blocker in session.recoveryBlockers {
                guard !blocker.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !blocker.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has an empty recovery blocker")
                }
            }

            if let placement = session.lastKnownPlacement {
                guard placement.displayID > 0,
                      placement.x.isFinite,
                      placement.y.isFinite,
                      placement.width.isFinite,
                      placement.height.isFinite,
                      placement.width > 0,
                      placement.height > 0,
                      placement.tileCapacity > 0,
                      placement.tileIndex >= 0,
                      placement.tileIndex < placement.tileCapacity else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' has invalid last-known placement")
                }
            }

            for app in session.apps {
                guard app.identity.pid > 0 else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' contains a non-positive app PID")
                }
                guard processIdentities.insert(app.identity).inserted else {
                    throw SessionStoreError.invalidLedger(
                        "process \(app.identity) appears in more than one app record")
                }
                guard !app.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      app.url.isFileURL else {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' contains an app without a name or file URL")
                }
                if let port = app.devToolsPort, !(1...65_535).contains(port) {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' contains an invalid DevTools port")
                }
                if let profile = app.temporaryProfile, !profile.isFileURL {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' contains a non-file temporary profile URL")
                }
                if let root = app.temporaryControlRoot, !root.isFileURL {
                    throw SessionStoreError.invalidLedger(
                        "session '\(id)' contains a non-file temporary control root URL")
                }
                if app.provenance == .adopted,
                   app.devToolsPort != nil
                    || app.temporaryProfile != nil
                    || app.temporaryControlRoot != nil {
                    throw SessionStoreError.invalidLedger(
                        "adopted app \(app.identity) cannot own launch-only private state")
                }
            }
        }
    }

    private func ensureRootDirectory() throws {
        let path = rootDirectory.path
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT else {
                throw SessionStoreError.unsafePath(
                    "could not inspect '\(path)': errno \(errno)")
            }
            do {
                try FileManager.default.createDirectory(
                    at: rootDirectory,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
            } catch {
                throw SessionStoreError.writeFailed(
                    "could not create '\(path)': \(error.localizedDescription)")
            }
            guard chmod(path, 0o700) == 0 else {
                throw SessionStoreError.writeFailed(
                    "could not set mode 0700 on '\(path)': errno \(errno)")
            }
            guard lstat(path, &info) == 0 else {
                throw SessionStoreError.unsafePath(
                    "could not inspect created directory '\(path)': errno \(errno)")
            }
        }

        guard info.st_mode & S_IFMT == S_IFDIR else {
            throw SessionStoreError.unsafePath("'\(path)' is not a directory")
        }
        guard info.st_uid == geteuid() else {
            throw SessionStoreError.unsafePath(
                "'\(path)' is not owned by the current user")
        }
        let permissions = info.st_mode & 0o777
        guard permissions == 0o700 else {
            throw SessionStoreError.unsafePath(
                "'\(path)' must have mode 0700, found \(String(permissions, radix: 8))")
        }
    }

    private func readLedgerData() throws -> Data? {
        let path = ledgerURL.path
        let fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else {
            if errno == ENOENT { return nil }
            throw SessionStoreError.readFailed("open '\(path)': errno \(errno)")
        }
        defer { close(fd) }

        var info = stat()
        guard fstat(fd, &info) == 0 else {
            throw SessionStoreError.readFailed("inspect '\(path)': errno \(errno)")
        }
        guard info.st_mode & S_IFMT == S_IFREG else {
            throw SessionStoreError.unsafePath("'\(path)' is not a regular file")
        }
        guard info.st_uid == geteuid() else {
            throw SessionStoreError.unsafePath(
                "'\(path)' is not owned by the current user")
        }
        let permissions = info.st_mode & 0o777
        guard permissions == 0o600 else {
            throw SessionStoreError.unsafePath(
                "'\(path)' must have mode 0600, found \(String(permissions, radix: 8))")
        }
        guard info.st_size >= 0, info.st_size <= off_t(Self.maximumLedgerBytes) else {
            throw SessionStoreError.corruptLedger(
                "file size is outside the 0...\(Self.maximumLedgerBytes) byte limit")
        }

        var data = Data(count: Int(info.st_size))
        try data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, base.advanced(by: offset), buffer.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else {
                    if count == 0 {
                        throw SessionStoreError.readFailed(
                            "unexpected end of file in '\(path)'")
                    }
                    throw SessionStoreError.readFailed(
                        "read '\(path)': errno \(errno)")
                }
                offset += count
            }
        }
        return data
    }

    private func writeAtomically(_ encoded: Data) throws {
        var data = encoded
        data.append(0x0A)
        let temporaryURL = rootDirectory.appendingPathComponent(
            ".sessions-\(namespace)-\(UUID().uuidString).tmp",
            isDirectory: false)
        let temporaryPath = temporaryURL.path
        let destinationPath = ledgerURL.path
        let fd = open(
            temporaryPath,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            mode_t(0o600))
        guard fd >= 0 else {
            throw SessionStoreError.writeFailed(
                "create temporary ledger: errno \(errno)")
        }

        var renamed = false
        defer {
            close(fd)
            if !renamed { unlink(temporaryPath) }
        }

        do {
            guard fchmod(fd, 0o600) == 0 else {
                throw SessionStoreError.writeFailed(
                    "set temporary ledger mode 0600: errno \(errno)")
            }
            try data.withUnsafeBytes { buffer in
                guard let base = buffer.baseAddress else { return }
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(
                        fd,
                        base.advanced(by: offset),
                        buffer.count - offset)
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else {
                        throw SessionStoreError.writeFailed(
                            "write temporary ledger: errno \(errno)")
                    }
                    offset += count
                }
            }
            guard fsync(fd) == 0 else {
                throw SessionStoreError.writeFailed(
                    "fsync temporary ledger: errno \(errno)")
            }
            try beforeReplace(temporaryURL, ledgerURL)
            guard rename(temporaryPath, destinationPath) == 0 else {
                throw SessionStoreError.writeFailed(
                    "atomically replace ledger: errno \(errno)")
            }
            renamed = true
            try afterReplace(ledgerURL)

            let directoryFD = open(rootDirectory.path, O_RDONLY | O_CLOEXEC | O_DIRECTORY)
            guard directoryFD >= 0 else {
                throw SessionStoreError.writeFailed(
                    "open ledger directory for fsync: errno \(errno)")
            }
            defer { close(directoryFD) }
            guard fsync(directoryFD) == 0 else {
                throw SessionStoreError.writeFailed(
                    "fsync ledger directory: errno \(errno)")
            }
        } catch let error as SessionStoreError {
            throw error
        } catch {
            throw SessionStoreError.writeFailed(error.localizedDescription)
        }
    }
}
