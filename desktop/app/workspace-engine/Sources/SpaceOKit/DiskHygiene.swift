import Foundation

/// What one `spaceo clean` pass did, or would do under `dryRun`.
public struct DiskHygieneReport: Codable, Equatable, Sendable {
    public var scanned: Int
    /// Directories removed, or under `dryRun` the directories that would be removed.
    public var removedPaths: [String]
    public var quarantinedPaths: [String]
    /// Candidates left in place because they were no longer safe to remove or removal failed.
    public var keptPaths: [String]
    public var reclaimedBytes: Int
    public var dryRun: Bool

    public init(scanned: Int = 0,
                removedPaths: [String] = [],
                quarantinedPaths: [String] = [],
                keptPaths: [String] = [],
                reclaimedBytes: Int = 0,
                dryRun: Bool = false) {
        self.scanned = scanned
        self.removedPaths = removedPaths
        self.quarantinedPaths = quarantinedPaths
        self.keptPaths = keptPaths
        self.reclaimedBytes = reclaimedBytes
        self.dryRun = dryRun
    }
}

/// Garbage collection for SpaceO's on-disk leftovers (SPAO-153).
///
/// Browser profiles, Electron control roots, and setup self-test directories are created per
/// launch and normally removed on teardown. A crashed daemon or a killed CLI leaves them behind,
/// and a long-lived host accumulates gigabytes. Everything here is conservative on purpose:
/// only known prefixes, only directories old enough that no live launch could still be
/// populating them, never anything a live or detached record still references, never through a
/// symlink, and never outside the directory being scanned. Ledgers are quarantined rather than
/// deleted because a ledger is the only record of sessions a future daemon might recover.
public enum DiskHygiene {
    /// A launch that is still populating a profile is minutes old at most; a day leaves room for
    /// suspended laptops and clock skew.
    public static let minimumAge: TimeInterval = 24 * 3600

    /// Ledgers for other socket paths are quarantined only after a week without a write, so a
    /// daemon that is merely restarted on a different socket keeps its history.
    public static let orphanLedgerAge: TimeInterval = 7 * 24 * 3600

    /// Directory names SpaceO creates under a temporary directory. `spaceo-e-` is the prefix
    /// `AppLauncher.prepareElectronControl` actually uses under `/tmp`.
    public static let defaultPrefixes = [
        "spaceo-browser-",
        "spaceo-e-",
        "spaceo-electron-control-",
        "spaceo-setup-selftest-",
    ]

    public static let maximumDirectoryEntries = 100_000
    public static let maximumSizeWalkEntries = 200_000
    public static let quarantineDirectoryName = "quarantine"
    public static let whyFileName = "WHY.txt"

    static let ledgerPrefix = "sessions-"
    static let ledgerSuffix = ".json"

    /// Directories directly under `temporaryDirectory` that SpaceO created, nobody references,
    /// and that are older than `minimumAge`. Returned sorted by path so reports are stable.
    public static func orphanCandidates(
        in temporaryDirectory: URL,
        prefixes: [String] = defaultPrefixes,
        referenced: Set<String>,
        now: Date,
        fileManager: FileManager = .default
    ) throws -> [URL] {
        let root = temporaryDirectory.standardizedFileURL
        let resolvedRoot = root.resolvingSymlinksInPath().path
        let rootPrefix = resolvedRoot.hasSuffix("/") ? resolvedRoot : resolvedRoot + "/"

        // Records may hold either the literal path or a resolved one; match both spellings.
        var protected = Set<String>()
        for path in referenced {
            let url = URL(fileURLWithPath: path)
            protected.insert(url.standardizedFileURL.path)
            protected.insert(url.resolvingSymlinksInPath().path)
        }

        let entries = try fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [
                .isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey,
            ],
            options: [.skipsSubdirectoryDescendants])

        var candidates: [URL] = []
        for entry in entries.prefix(maximumDirectoryEntries) {
            let name = entry.lastPathComponent
            guard prefixes.contains(where: { name.hasPrefix($0) }) else { continue }
            guard let values = try? entry.resourceValues(forKeys: [
                .isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey,
            ]) else { continue }
            guard values.isSymbolicLink != true, values.isDirectory == true else { continue }

            let standardized = entry.standardizedFileURL
            let resolved = standardized.resolvingSymlinksInPath().path
            guard resolved.hasPrefix(rootPrefix) else { continue }
            guard !protected.contains(standardized.path), !protected.contains(resolved) else {
                continue
            }
            guard let modified = values.contentModificationDate,
                  now.timeIntervalSince(modified) >= minimumAge else { continue }
            candidates.append(standardized)
        }
        return candidates.sorted { $0.path < $1.path }
    }

    /// Bytes allocated to regular files below `url`. Symbolic links are counted as themselves and
    /// never followed; the walk stops after `maximumSizeWalkEntries` so a hostile tree cannot
    /// stall the daemon.
    public static func directorySize(_ url: URL, fileManager: FileManager = .default) -> Int {
        let keys: Set<URLResourceKey> = [
            .isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey,
        ]
        guard let enumerator = fileManager.enumerator(
            at: url,
            includingPropertiesForKeys: Array(keys),
            options: [],
            errorHandler: { _, _ in true }
        ) else { return 0 }

        var total = 0
        var visited = 0
        while let entry = enumerator.nextObject() as? URL {
            visited += 1
            if visited > maximumSizeWalkEntries { break }
            guard let values = try? entry.resourceValues(forKeys: keys),
                  values.isRegularFile == true else { continue }
            total += values.totalFileAllocatedSize ?? values.fileSize ?? 0
        }
        return total
    }

    /// Remove `candidates`, or under `dryRun` report what removal would do without touching
    /// anything. Each candidate is re-checked immediately before removal so a path that became a
    /// symlink after scanning is kept rather than followed.
    public static func clean(candidates: [URL],
                             dryRun: Bool,
                             fileManager: FileManager = .default) -> DiskHygieneReport {
        var report = DiskHygieneReport(scanned: candidates.count, dryRun: dryRun)
        for candidate in candidates.sorted(by: { $0.path < $1.path }) {
            let path = candidate.standardizedFileURL.path
            guard let values = try? candidate.resourceValues(forKeys: [
                .isDirectoryKey, .isSymbolicLinkKey,
            ]), values.isSymbolicLink != true, values.isDirectory == true else {
                report.keptPaths.append(path)
                continue
            }
            let size = directorySize(candidate, fileManager: fileManager)
            if dryRun {
                report.removedPaths.append(path)
                report.reclaimedBytes += size
                continue
            }
            do {
                try fileManager.removeItem(at: candidate)
                report.removedPaths.append(path)
                report.reclaimedBytes += size
            } catch {
                report.keptPaths.append(path)
            }
        }
        return report
    }

    /// Move ledgers for other socket namespaces that have not been written in `orphanLedgerAge`
    /// into `rootDirectory/quarantine/<namespace>-<yyyyMMddHHmmss>/`. Returns the quarantine
    /// directories created.
    ///
    /// `SessionStore` keeps one flat file per namespace, `sessions-<namespace>.json`, directly
    /// under its root; there are no per-namespace directories.
    public static func quarantineOrphanLedgers(rootDirectory: URL,
                                               liveNamespace: String,
                                               now: Date,
                                               fileManager: FileManager = .default) throws -> [URL] {
        let root = rootDirectory.standardizedFileURL
        let entries = try fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [
                .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey,
            ],
            options: [.skipsSubdirectoryDescendants])

        var quarantined: [URL] = []
        for entry in entries.prefix(maximumDirectoryEntries).sorted(by: { $0.path < $1.path }) {
            guard let namespace = ledgerNamespace(fromFileName: entry.lastPathComponent),
                  namespace != liveNamespace else { continue }
            guard let values = try? entry.resourceValues(forKeys: [
                .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey,
            ]), values.isSymbolicLink != true, values.isRegularFile == true,
                let modified = values.contentModificationDate,
                now.timeIntervalSince(modified) >= orphanLedgerAge else { continue }

            let age = Int(now.timeIntervalSince(modified) / 86_400)
            let destination = try quarantine(
                file: entry, label: namespace, rootDirectory: root, now: now,
                reason: "ledger for namespace '\(namespace)' was last written \(age) day(s) ago "
                    + "and no daemon on that socket path is live",
                fileManager: fileManager)
            quarantined.append(destination)
        }
        return quarantined
    }

    /// Set aside a ledger the running build cannot read (for example a newer schema) so the
    /// daemon can start with an empty ledger without destroying the newer daemon's state.
    public static func quarantineUnsupportedLedger(at url: URL,
                                                   rootDirectory: URL,
                                                   reason: String,
                                                   now: Date = Date(),
                                                   fileManager: FileManager = .default) throws -> URL {
        let root = rootDirectory.standardizedFileURL
        let file = url.standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard file.path.hasPrefix(rootPrefix) else {
            throw SpaceOError.badRequest(
                "refusing to quarantine '\(file.path)': it is outside the ledger root")
        }
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isSymbolicLink != true, values.isRegularFile == true else {
            throw SpaceOError.badRequest(
                "refusing to quarantine '\(file.path)': it is not a regular file")
        }
        let label = ledgerNamespace(fromFileName: file.lastPathComponent)
            ?? file.deletingPathExtension().lastPathComponent
        return try quarantine(file: file, label: label, rootDirectory: root, now: now,
                              reason: reason, fileManager: fileManager)
    }

    /// One line for the CLI, e.g.
    /// "reclaimed 419 MB from 12 orphaned directories (3 kept, 1 quarantined)".
    public static func summaryLine(_ report: DiskHygieneReport) -> String {
        let count = report.removedPaths.count
        let noun = count == 1 ? "directory" : "directories"
        let body = "\(formatBytes(report.reclaimedBytes)) from \(count) orphaned \(noun) "
            + "(\(report.keptPaths.count) kept, \(report.quarantinedPaths.count) quarantined)"
        return report.dryRun ? "dry run: would reclaim " + body : "reclaimed " + body
    }

    // MARK: - Internals

    /// The namespace encoded in a ledger file name, or nil when the name is not a ledger or
    /// contains characters SessionStore would never have written.
    static func ledgerNamespace(fromFileName name: String) -> String? {
        guard name.hasPrefix(ledgerPrefix), name.hasSuffix(ledgerSuffix),
              name.count > ledgerPrefix.count + ledgerSuffix.count else { return nil }
        let namespace = String(name.dropFirst(ledgerPrefix.count).dropLast(ledgerSuffix.count))
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard namespace.unicodeScalars.allSatisfy(allowed.contains),
              namespace.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains) else {
            return nil
        }
        return namespace
    }

    private static func quarantine(file: URL,
                                   label: String,
                                   rootDirectory: URL,
                                   now: Date,
                                   reason: String,
                                   fileManager: FileManager) throws -> URL {
        let quarantineRoot = rootDirectory.appendingPathComponent(
            quarantineDirectoryName, isDirectory: true)
        let stamp = timestamp(now)
        var destination = quarantineRoot.appendingPathComponent("\(label)-\(stamp)", isDirectory: true)
        var attempt = 1
        while fileManager.fileExists(atPath: destination.path) {
            attempt += 1
            guard attempt <= 100 else {
                throw SpaceOError.badRequest(
                    "too many quarantine directories already exist for '\(label)' at \(stamp)")
            }
            destination = quarantineRoot.appendingPathComponent(
                "\(label)-\(stamp)-\(attempt)", isDirectory: true)
        }
        try fileManager.createDirectory(
            at: destination,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try fileManager.moveItem(
            at: file, to: destination.appendingPathComponent(file.lastPathComponent))

        let why = """
        SpaceO moved this file into quarantine instead of deleting it.
        Moved: \(ISO8601DateFormatter().string(from: now))
        Original path: \(file.path)
        Reason: \(reason)
        It is safe to delete this directory once you are sure no SpaceO daemon still needs it.

        """
        try why.write(to: destination.appendingPathComponent(whyFileName),
                      atomically: true, encoding: .utf8)
        return destination
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMddHHmmss"
        return formatter.string(from: date)
    }

    static func formatBytes(_ bytes: Int) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = max(0, bytes)
        var index = 0
        var unit = 1
        while index < units.count - 1, value >= unit * 1_024 {
            unit *= 1_024
            index += 1
        }
        value = (value + unit / 2) / unit
        return "\(value) \(units[index])"
    }
}
