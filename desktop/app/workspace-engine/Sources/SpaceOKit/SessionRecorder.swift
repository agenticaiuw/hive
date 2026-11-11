import Foundation
import CoreGraphics
import Darwin

// SPAO-220: daemon-side action recording.
//
// When an agent run goes wrong the developer has a daemon log with no pixels and a chat
// transcript with no timing. A recording is the missing artefact: one receipt per action, with
// an optional bounded low-resolution frame before and after it, on local disk under a hard
// byte cap. Recording is opt-in, never bundled into support archives automatically, and never
// stores text/key payloads in receipts. Opt-in frames can contain visible typed text.

/// What a session recording captures. Parsed from the `record` argument of session creation.
public enum RecordingMode: String, Codable, Sendable, CaseIterable {
    /// One receipt per action, no pixels.
    case actions
    /// Receipts plus a downscaled frame before and after each action.
    case actionsAndFrames = "actions+frames"

    /// `nil` means "not requested"; an unknown string is a caller error rather than a silent
    /// downgrade to no recording, because an agent that asked for evidence must not be told
    /// later that none exists.
    public static func parse(_ raw: String?) throws -> RecordingMode? {
        guard let raw else { return nil }
        guard let mode = RecordingMode(rawValue: raw) else {
            throw SpaceOError.badRequest(
                "record must be \"actions\" or \"actions+frames\", not \"\(raw)\"")
        }
        return mode
    }
}

/// One line of `actions.jsonl`.
///
/// There is deliberately no field for typed text or key combinations. Transcripts redact typed
/// payloads because they routinely contain credentials; a recording that lives on disk for days
/// must not be the place they leak. Callers store the command name and `payloadLength` only.
public struct RecordedAction: Codable, Equatable, Sendable {
    public var seq: Int
    public var at: Date
    public var cmd: String
    public var ok: Bool
    public var route: String?
    public var completion: String?
    public var message: String?
    public var error: String?
    public var errorCode: String?
    public var x: Double?
    public var y: Double?
    public var windowID: UInt32?
    /// UTF-8 length of the typed text or key chord, never its content.
    public var payloadLength: Int?
    /// Path relative to the recording directory, e.g. `frames/3-before.png`.
    public var beforeFrame: String?
    public var afterFrame: String?
    /// Capture or omission status; absent in older recordings.
    public var beforeFrameStatus: String?
    public var afterFrameStatus: String?

    public init(seq: Int,
                at: Date,
                cmd: String,
                ok: Bool,
                route: String? = nil,
                completion: String? = nil,
                message: String? = nil,
                error: String? = nil,
                errorCode: String? = nil,
                x: Double? = nil,
                y: Double? = nil,
                windowID: UInt32? = nil,
                payloadLength: Int? = nil,
                beforeFrame: String? = nil,
                afterFrame: String? = nil,
                beforeFrameStatus: String? = nil,
                afterFrameStatus: String? = nil) {
        self.seq = seq
        self.at = at
        self.cmd = cmd
        self.ok = ok
        self.route = route
        self.completion = completion
        self.message = message
        self.error = error
        self.errorCode = errorCode
        self.x = x
        self.y = y
        self.windowID = windowID
        self.payloadLength = payloadLength
        self.beforeFrame = beforeFrame
        self.afterFrame = afterFrame
        self.beforeFrameStatus = beforeFrameStatus
        self.afterFrameStatus = afterFrameStatus
    }
}

/// `manifest.json`, written once when the recording finishes. Its absence marks a recording
/// that was still open when the daemon stopped.
public struct RecordingManifest: Codable, Equatable, Sendable {
    public var sessionID: String
    public var mode: RecordingMode
    public var startedAt: Date
    public var finishedAt: Date?
    public var reason: String?
    public var actionCount: Int
    public var bytes: Int

    public init(sessionID: String,
                mode: RecordingMode,
                startedAt: Date,
                finishedAt: Date? = nil,
                reason: String? = nil,
                actionCount: Int,
                bytes: Int) {
        self.sessionID = sessionID
        self.mode = mode
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.reason = reason
        self.actionCount = actionCount
        self.bytes = bytes
    }
}

public enum SessionRecorderError: Error, Equatable, LocalizedError {
    /// Live recordings have exhausted the byte budget; pruning finished recordings cannot help.
    case capacityExhausted(bytes: Int, capacity: Int)
    case invalidRecording(String)

    public var errorDescription: String? {
        switch self {
        case .capacityExhausted(let bytes, let capacity):
            return "recording stopped at \(bytes) bytes; the cap is \(capacity) bytes"
        case .invalidRecording(let why):
            return "invalid recording: \(why)"
        }
    }
}

/// Appends action receipts and optional frames for one session under a byte cap.
///
/// The recorder never captures. The daemon hands it PNG bytes it already produced so the
/// recorder cannot become a second, unaudited path to the screen. Writes are serialised with a
/// lock because receipts arrive from whichever task completed the action.
public final class SessionRecorder: @unchecked Sendable {

    /// 500 MiB, the cap named in the SPAO-220 proposal.
    public static let defaultCapacityBytes = 500 * 1_048_576
    public static let actionsFileName = "actions.jsonl"
    public static let manifestFileName = "manifest.json"
    public static let framesDirectoryName = "frames"
    public static let recordingsDirectoryName = "recordings"

    public let sessionID: String
    public let mode: RecordingMode
    public let directory: URL
    public let capacityBytes: Int

    private let recordingsRoot: URL
    private let fileManager: FileManager
    private let now: @Sendable () -> Date
    private let startedAt: Date
    private let lock = NSLock()
    private var handle: FileHandle?
    private var count = 0
    private var bytes = 0
    private var finished = false
    private var finishFailure: Error?
    private var registered = false

    // Same-process live recorders own their directories. Keep only paths and byte counts here,
    // never the recorder itself; pruning can account for growing recordings without walking
    // every frame after every action or deleting another session's active receipt stream.
    private static let activeLock = NSLock()
    private static let pruneLock = NSLock()
    private static var activeBytes: [String: Int] = [:]
    private var directoryKey: String { directory.standardizedFileURL.path }

    public var actionCount: Int { lock.withLock { count } }
    public var bytesWritten: Int { lock.withLock { bytes } }

    /// Creates `rootDirectory/recordings/<sessionID>-<yyyyMMdd-HHmmss>/` with an empty
    /// `actions.jsonl` and `frames/`.
    public init(sessionID: String,
                mode: RecordingMode,
                rootDirectory: URL,
                capacityBytes: Int = SessionRecorder.defaultCapacityBytes,
                now: @escaping @Sendable () -> Date = { Date() },
                fileManager: FileManager = .default) throws {
        guard capacityBytes > 0 else {
            throw SpaceOError.badRequest("recording capacity must be positive")
        }
        self.sessionID = sessionID
        self.mode = mode
        self.capacityBytes = capacityBytes
        self.now = now
        self.fileManager = fileManager
        self.startedAt = now()
        self.recordingsRoot = rootDirectory.appendingPathComponent(
            Self.recordingsDirectoryName, isDirectory: true)
        try fileManager.createDirectory(
            at: recordingsRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])

        Self.activeLock.lock()
        defer { Self.activeLock.unlock() }
        // A recording named after its session and start time is browsable without tooling.
        // The suffix loop covers two recordings of one session within a second.
        let base = "\(Self.sanitizedComponent(sessionID))-\(Self.directoryStamp(startedAt))"
        var chosen: URL?
        for attempt in 0..<64 {
            let name = attempt == 0 ? base : "\(base)-\(attempt + 1)"
            let candidate = recordingsRoot.appendingPathComponent(name, isDirectory: true)
            if !fileManager.fileExists(atPath: candidate.path),
               Self.activeBytes[candidate.standardizedFileURL.path] == nil {
                chosen = candidate
                break
            }
        }
        guard let directory = chosen else {
            throw SpaceOError.badRequest("too many recordings for session \(sessionID) started this second")
        }
        self.directory = directory
        try fileManager.createDirectory(
            at: directory.appendingPathComponent(Self.framesDirectoryName, isDirectory: true),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])

        let actionsURL = directory.appendingPathComponent(Self.actionsFileName)
        guard fileManager.createFile(atPath: actionsURL.path, contents: Data(),
                                     attributes: [.posixPermissions: 0o600]) else {
            throw SpaceOError.badRequest("could not create \(actionsURL.path)")
        }
        self.handle = try FileHandle(forWritingTo: actionsURL)
        Self.activeBytes[directoryKey] = 0
        registered = true
    }

    deinit {
        try? handle?.close()
        if registered {
            _ = Self.activeLock.withLock { Self.activeBytes.removeValue(forKey: directoryKey) }
        }
    }

    // MARK: - Recording

    /// Writes any frames, appends the receipt line, then prunes older recordings.
    ///
    /// Frames are written before the line so a receipt never references a file that does not
    /// exist. When this recording alone is near the cap, frames are dropped before receipts:
    /// the timeline of what happened is worth more than any single picture of it.
    @discardableResult
    public func record(_ action: RecordedAction,
                       beforeFrame: Data? = nil,
                       afterFrame: Data? = nil) throws -> RecordedAction {
        let beforeFrame = mode == .actionsAndFrames ? beforeFrame : nil
        let afterFrame = mode == .actionsAndFrames ? afterFrame : nil
        let recorded = try lock.withLock { () throws -> RecordedAction in
            guard !finished, let handle else {
                throw SessionRecorderError.invalidRecording("recording already finished")
            }
            Self.activeLock.lock()
            defer { Self.activeLock.unlock() }
            defer { Self.activeBytes[directoryKey] = bytes }
            var stored = action
            stored.beforeFrame = nil
            stored.afterFrame = nil
            if mode == .actions {
                stored.beforeFrameStatus = nil
                stored.afterFrameStatus = nil
            } else {
                if beforeFrame != nil, stored.beforeFrameStatus != nil { stored.beforeFrameStatus = "capacity_exhausted" }
                if afterFrame != nil, stored.afterFrameStatus != nil { stored.afterFrameStatus = "capacity_exhausted" }
            }

            // Reserve the actual encoded receipt (including frame paths) before writing frames.
            // Otherwise frames can fit alone, strand files, and cause the more valuable receipt
            // to be refused. Encode before any writes so invalid actions cannot leave files.
            var line = try Self.encoder.encode(stored)
            line.append(0x0A)
            let remaining = remainingLiveCapacity()
            guard line.count <= remaining else {
                throw SessionRecorderError.capacityExhausted(bytes: capacityBytes - remaining, capacity: capacityBytes)
            }
            let (frameBytes, overflow) = (beforeFrame?.count ?? 0)
                .addingReportingOverflow(afterFrame?.count ?? 0)
            if !overflow, frameBytes > 0, frameBytes <= remaining - line.count {
                var framed = stored
                if beforeFrame != nil { framed.beforeFrame = Self.framePath(seq: action.seq, suffix: "before") }
                if afterFrame != nil { framed.afterFrame = Self.framePath(seq: action.seq, suffix: "after") }
                if beforeFrame != nil, framed.beforeFrameStatus != nil { framed.beforeFrameStatus = "captured" }
                if afterFrame != nil, framed.afterFrameStatus != nil { framed.afterFrameStatus = "captured" }
                var framedLine = try Self.encoder.encode(framed)
                framedLine.append(0x0A)
                if framedLine.count <= remaining - frameBytes {
                    stored = framed
                    line = framedLine
                }
            }
            if stored.beforeFrame != nil || stored.afterFrame != nil {
                if let beforeFrame {
                    stored.beforeFrame = try writeFrame(beforeFrame, seq: action.seq, suffix: "before")
                }
                if let afterFrame {
                    stored.afterFrame = try writeFrame(afterFrame, seq: action.seq, suffix: "after")
                }
            }

            try handle.write(contentsOf: line)
            bytes += line.count
            count += 1
            return stored
        }
        _ = try Self.prune(
            recordingsRoot: recordingsRoot,
            capacityBytes: capacityBytes,
            protecting: directory,
            fileManager: fileManager)
        return recorded
    }

    /// Writes `manifest.json` and closes the receipt stream. Idempotent so a teardown that
    /// runs twice does not overwrite the first, truthful reason.
    public func finish(reason: String) throws {
        try lock.withLock {
            guard !finished else {
                if let finishFailure { throw finishFailure }
                return
            }
            finished = true
            do {
                Self.activeLock.lock()
                defer { Self.activeLock.unlock() }
                defer {
                    Self.activeBytes.removeValue(forKey: directoryKey)
                    registered = false
                }
                try handle?.close()
                handle = nil
                let manifest = RecordingManifest(
                    sessionID: sessionID,
                    mode: mode,
                    startedAt: startedAt,
                    finishedAt: now(),
                    reason: reason,
                    actionCount: count,
                    bytes: bytes)
                let data = try Self.encoder.encode(manifest)
                let remaining = remainingLiveCapacity()
                guard data.count <= remaining else {
                    throw SessionRecorderError.capacityExhausted(bytes: capacityBytes - remaining, capacity: capacityBytes)
                }
                let url = directory.appendingPathComponent(Self.manifestFileName)
                try data.write(to: url, options: .atomic)
                bytes += data.count
            } catch {
                finishFailure = error
                throw error
            }
        }
        _ = try Self.prune(recordingsRoot: recordingsRoot, capacityBytes: capacityBytes,
                           protecting: directory, fileManager: fileManager)
    }

    private func writeFrame(_ png: Data, seq: Int, suffix: String) throws -> String {
        let relative = Self.framePath(seq: seq, suffix: suffix)
        let url = directory.appendingPathComponent(relative)
        try png.write(to: url, options: .atomic)
        bytes += png.count
        return relative
    }

    private static func framePath(seq: Int, suffix: String) -> String {
        "\(framesDirectoryName)/\(seq)-\(suffix).png"
    }

    /// Called only with activeLock held. Reserve space across this root's live writers;
    /// completed recordings can be pruned, but deleting a live writer is never an eviction plan.
    private func remainingLiveCapacity() -> Int {
        let prefix = recordingsRoot.standardizedFileURL.path + "/"
        let used = Self.activeBytes.reduce(0) { total, entry in
            entry.key.hasPrefix(prefix) ? Self.saturatedSum(total, entry.value) : total
        }
        return max(0, capacityBytes - used)
    }

    // MARK: - Pruning

    /// Removes whole recording directories oldest-first until the tree fits `capacityBytes`.
    ///
    /// Whole directories, not individual frames, so a surviving recording is always internally
    /// consistent. `protecting` is the directory currently being written; deleting it under a
    /// live recorder would turn every later receipt into a write failure. All live recorders in
    /// this process are also protected and use tracked byte counts for their own writes.
    @discardableResult
    public static func prune(recordingsRoot: URL,
                             capacityBytes: Int,
                             protecting: URL? = nil,
                             fileManager: FileManager = .default) throws -> [URL] {
        pruneLock.lock()
        defer { pruneLock.unlock() }
        // Socket/actor tasks can live for many commands; release Foundation listing metadata
        // at this boundary rather than waiting for the caller's ambient autorelease pool.
        return try autoreleasepool {
            guard fileManager.fileExists(atPath: recordingsRoot.path) else { return [] }
            let children = try fileManager.contentsOfDirectory(
                at: recordingsRoot,
                includingPropertiesForKeys: [.isDirectoryKey, .creationDateKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles])

            struct Entry {
                var url: URL
                var startedAt: Date
                var bytes: Int
            }
            var entries: [Entry] = []
            var total = 0
            let protectedPath = protecting?.standardizedFileURL.path
            for child in children {
                let values = try child.resourceValues(forKeys: [.isDirectoryKey, .creationDateKey, .contentModificationDateKey])
                guard values.isDirectory == true else { continue }
                let path = child.standardizedFileURL.path
                let liveBytes = activeLock.withLock { activeBytes[path] }
                let size = try liveBytes ?? directorySize(child)
                total = saturatedSum(total, size)
                if path == protectedPath || liveBytes != nil { continue }
                let started = values.creationDate ?? values.contentModificationDate ?? .distantPast
                entries.append(Entry(url: child, startedAt: started, bytes: size))
            }
            guard total > capacityBytes else { return [] }
            for index in entries.indices {
                entries[index].startedAt = manifestStart(entries[index].url) ?? entries[index].startedAt
            }
            entries.sort { lhs, rhs in
                lhs.startedAt != rhs.startedAt
                    ? lhs.startedAt < rhs.startedAt
                    : lhs.url.lastPathComponent < rhs.url.lastPathComponent
            }

            var removed: [URL] = []
            for entry in entries where total > capacityBytes {
                try activeLock.withLock {
                    guard activeBytes[entry.url.standardizedFileURL.path] == nil else { return }
                    try fileManager.removeItem(at: entry.url)
                    total -= entry.bytes
                    removed.append(entry.url)
                }
            }
            return removed
        }
    }

    private static func manifestStart(_ directory: URL) -> Date? {
        let url = directory.appendingPathComponent(manifestFileName)
        guard let data = try? readBoundedFile(url, maximumBytes: 64 * 1024),
              let manifest = try? decoder.decode(RecordingManifest.self, from: data) else {
            return nil
        }
        return manifest.startedAt
    }

    /// Count current regular-file sizes without creating a URL and Foundation resource-value
    /// dictionary per frame. A physical walk never follows symlinks or changes process cwd.
    /// Keep the existing hidden-file exclusion; fail closed if any visible subtree is unreadable.
    static func directorySize(_ directory: URL) throws -> Int {
        try directory.withUnsafeFileSystemRepresentation { path in
            guard let path, let ownedPath = strdup(path) else {
                throw SessionRecorderError.invalidRecording("cannot inspect recording directory")
            }
            defer { free(ownedPath) }
            var paths: [UnsafeMutablePointer<CChar>?] = [ownedPath, nil]
            return try paths.withUnsafeMutableBufferPointer { paths in
                guard let tree = fts_open(paths.baseAddress, FTS_PHYSICAL | FTS_NOCHDIR, nil) else {
                    throw SessionRecorderError.invalidRecording("cannot enumerate recording directory")
                }
                defer { fts_close(tree) }
                var total = 0
                while true {
                    errno = 0
                    guard let entry = fts_read(tree) else {
                        guard errno == 0 else {
                            throw SessionRecorderError.invalidRecording("recording directory enumeration failed")
                        }
                        break
                    }
                    let hiddenFlag = entry.pointee.fts_statp.map { $0.pointee.st_flags & UInt32(UF_HIDDEN) != 0 } ?? false
                    let hidden = entry.pointee.fts_level > 0 && (entry.pointee.fts_name == 46 || hiddenFlag)
                    if hidden {
                        guard fts_set(tree, entry, FTS_SKIP) == 0 else {
                            throw SessionRecorderError.invalidRecording("cannot skip hidden recording entry")
                        }
                        continue
                    }
                    switch Int32(entry.pointee.fts_info) {
                    case FTS_F:
                        guard let info = entry.pointee.fts_statp, info.pointee.st_size >= 0,
                              let size = Int(exactly: info.pointee.st_size) else {
                            throw SessionRecorderError.invalidRecording("invalid recording file size")
                        }
                        total = saturatedSum(total, size)
                    case FTS_DNR, FTS_ERR, FTS_NS:
                        throw SessionRecorderError.invalidRecording("cannot inspect recording entry")
                    default:
                        break
                    }
                }
                return total
            }
        }
    }

    private static func saturatedSum(_ lhs: Int, _ rhs: Int) -> Int {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? Int.max : sum
    }

    /// Check the opened descriptor, then enforce the limit while reading too: a stat before an
    /// unbounded Data(contentsOf:) does not bound allocation if the file grows or is replaced.
    static func readBoundedFile(_ url: URL, maximumBytes: Int) throws -> Data {
        var result = Data()
        _ = try readBoundedChunks(url, maximumBytes: maximumBytes) { chunk in
            if let base = chunk.baseAddress {
                result.append(base.assumingMemoryBound(to: UInt8.self), count: chunk.count)
            }
        }
        return result
    }

    /// The callback's bytes are valid only during that callback. Bounds apply to the complete
    /// stream, including a file that grows after fstat, not just the reusable read buffer.
    @discardableResult
    static func readBoundedChunks(_ url: URL, maximumBytes: Int,
                                  receive: (UnsafeRawBufferPointer) throws -> Void) throws -> Int {
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else {
            if errno == ENOENT { throw CocoaError(.fileReadNoSuchFile) }
            throw SessionRecorderError.invalidRecording("cannot open \(url.lastPathComponent)")
        }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_size >= 0, info.st_size <= maximumBytes else {
            throw SessionRecorderError.invalidRecording(
                "\(url.lastPathComponent) must be a regular file of at most \(maximumBytes) bytes")
        }
        var total = 0
        var chunk = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = Darwin.read(descriptor, &chunk, chunk.count)
            if count == 0 { return total }
            if count < 0 {
                if errno == EINTR { continue }
                throw SessionRecorderError.invalidRecording("cannot read \(url.lastPathComponent)")
            }
            guard count <= maximumBytes - total else {
                throw SessionRecorderError.invalidRecording(
                    "\(url.lastPathComponent) exceeds \(maximumBytes) bytes")
            }
            total += count
            try chunk.withUnsafeBytes { buffer in
                try receive(UnsafeRawBufferPointer(rebasing: buffer.prefix(count)))
            }
        }
    }

    // MARK: - Frame preparation

    /// Encodes a frame at most `maxEdge` pixels on its longer side.
    ///
    /// Two full-resolution frames per action would exhaust the cap in minutes on a Retina tile.
    /// A 480-pixel thumbnail still shows which dialog was open and roughly where the click went,
    /// which is what a post-mortem needs.
    public static func downscaledPNG(_ image: CGImage, maxEdge: Int = 480) throws -> Data {
        guard maxEdge > 0 else {
            throw SpaceOError.badRequest("maxEdge must be positive")
        }
        let longest = max(image.width, image.height)
        guard longest > maxEdge, longest > 0 else {
            return try Capture.pngData(image)
        }
        let scale = Double(maxEdge) / Double(longest)
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw SpaceOError.captureFailed("could not allocate a \(width)x\(height) thumbnail")
        }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else {
            throw SpaceOError.captureFailed("thumbnail rendering failed")
        }
        return try Capture.pngData(scaled)
    }

    // MARK: - Encoding

    /// Sorted keys and fractional ISO 8601 dates keep the sidecar diffable and readable by
    /// `jq` without a schema.
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(isoFormatter.string(from: date))
        }
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = isoFormatter.date(from: raw) ?? isoFallbackFormatter.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: decoder.codingPath, debugDescription: "unrecognised date \(raw)"))
        }
        return decoder
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoFallbackFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// UTC so two hosts reviewing the same recording agree on its name, and so the name is
    /// stable across the daylight-saving change.
    private static func directoryStamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }

    /// Session IDs are caller-chosen; only a conservative character set may reach a path.
    static func sanitizedComponent(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        var out = String(raw.prefix(64).map { allowed.contains($0) ? $0 : "_" })
        while out.hasPrefix(".") { out.removeFirst() }
        return out.isEmpty ? "session" : out
    }
}

// MARK: - Report

/// Renders a recording as one self-contained HTML page.
///
/// No script, no external resources, no absolute paths: the page is meant to be attached to a
/// bug report after the user has looked at it, so it must not phone home and must not reveal
/// where on disk the recording lived.
public enum SessionReport {

    /// Upper bound on `actions.jsonl` consumed for one page, including growth during reading.
    public static let maximumActionsBytes = 64 * 1_048_576

    public static func render(directory: URL, fileManager: FileManager = .default) throws -> String {
        let actionsURL = directory.appendingPathComponent(SessionRecorder.actionsFileName)
        let manifestURL = directory.appendingPathComponent(SessionRecorder.manifestFileName)
        var manifest: RecordingManifest?
        do {
            let data = try SessionRecorder.readBoundedFile(manifestURL, maximumBytes: 64 * 1024)
            manifest = try SessionRecorder.decoder.decode(RecordingManifest.self, from: data)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // Infer unfinished metadata from the same pass that renders the rows.
        }

        var html = ""
        var firstActionAt: Date?
        var hasFrames = false
        var actionCount = 0
        var failures = 0
        var malformed = 0
        var pending = Data()
        func consumeLine() {
            guard !pending.isEmpty else { return }
            autoreleasepool {
                if let action = try? SessionRecorder.decoder.decode(RecordedAction.self, from: pending) {
                    if firstActionAt == nil { firstActionAt = action.at }
                    actionCount += 1
                    if !action.ok { failures += 1 }
                    if action.beforeFrame != nil || action.afterFrame != nil
                        || action.beforeFrameStatus != nil || action.afterFrameStatus != nil { hasFrames = true }
                    html += row(action, origin: manifest?.startedAt ?? firstActionAt ?? .distantPast)
                } else {
                    malformed += 1
                }
            }
            pending.removeAll(keepingCapacity: pending.count <= 65_536)
        }
        let bytes = try SessionRecorder.readBoundedChunks(actionsURL, maximumBytes: maximumActionsBytes) { chunk in
            var start = 0
            for index in chunk.indices where chunk[index] == 0x0A {
                pending.append(contentsOf: chunk[start..<index])
                consumeLine()
                start = index + 1
            }
            pending.append(contentsOf: chunk[start..<chunk.count])
        }
        consumeLine() // A valid final line need not have a terminating newline.
        let metadata = manifest ?? RecordingManifest(
            sessionID: directory.lastPathComponent,
            mode: hasFrames ? .actionsAndFrames : .actions,
            startedAt: firstActionAt ?? .distantPast,
            finishedAt: nil, reason: "unfinished", actionCount: actionCount, bytes: bytes)
        finishHTML(&html, manifest: metadata, actionCount: actionCount,
                   failures: failures, malformedLines: malformed)
        return html
    }

    /// The pure core: no filesystem, deterministic for a given input.
    public static func render(manifest: RecordingManifest, actions: [RecordedAction]) -> String {
        render(manifest: manifest, actions: actions, malformedLines: 0)
    }

    static func render(manifest: RecordingManifest, actions: [RecordedAction], malformedLines: Int) -> String {
        var html = ""
        var failures = 0
        for action in actions {
            if !action.ok { failures += 1 }
            autoreleasepool { html += row(action, origin: manifest.startedAt) }
        }
        finishHTML(&html, manifest: manifest, actionCount: actions.count,
                   failures: failures, malformedLines: malformedLines)
        return html
    }

    private static func finishHTML(_ html: inout String, manifest: RecordingManifest,
                                   actionCount: Int, failures: Int, malformedLines: Int) {
        var header = ""
        header += "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        header += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        header += "<title>SpaceO recording \(escape(manifest.sessionID))</title>\n"
        header += "<style>\n\(stylesheet)</style>\n</head>\n<body>\n"
        header += "<header>\n<h1>SpaceO session recording</h1>\n<dl class=\"meta\">\n"
        header += metaRow("Session", manifest.sessionID)
        header += metaRow("Mode", manifest.mode.rawValue)
        header += metaRow("Started", timestamp(manifest.startedAt))
        header += metaRow("Finished", manifest.finishedAt.map(timestamp) ?? "not finished")
        header += metaRow("Reason", manifest.reason ?? "—")
        header += metaRow("Actions", String(actionCount))
        header += metaRow("Bytes", String(manifest.bytes))
        header += "</dl>\n</header>\n"

        header += "<p class=\"summary\">\(actionCount) action\(actionCount == 1 ? "" : "s"), "
        header += "\(failures) failed"
        if malformedLines > 0 {
            header += ", \(malformedLines) unreadable line\(malformedLines == 1 ? "" : "s") skipped"
        }
        header += ".</p>\n"

        header += "<table class=\"timeline\">\n<thead>\n<tr>"
        header += "<th>#</th><th>t+</th><th>Command</th><th>Outcome</th><th>Route</th><th>Detail</th><th>Before</th><th>After</th>"
        header += "</tr>\n</thead>\n<tbody>\n"
        html.insert(contentsOf: header, at: html.startIndex)
        html += "</tbody>\n</table>\n"
        html += "<footer>Text/key payloads are omitted from receipts. Opt-in frames may contain visible screen content, including typed text.</footer>\n"
        html += "</body>\n</html>\n"
    }

    private static func row(_ action: RecordedAction, origin: Date) -> String {
        var cells = ""
        cells += "<td class=\"seq\">\(action.seq)</td>"
        cells += "<td class=\"time\">\(escape(offset(action.at, from: origin)))</td>"
        cells += "<td class=\"cmd\"><code>\(escape(action.cmd))</code>"
        if let length = action.payloadLength {
            cells += " <span class=\"len\">payload \(length) byte\(length == 1 ? "" : "s")</span>"
        }
        cells += "</td>"
        let badgeClass = action.ok ? "ok" : "error"
        let badgeText = action.ok ? "ok" : (action.errorCode ?? "error")
        cells += "<td><span class=\"badge \(badgeClass)\">\(escape(badgeText))</span>"
        if let completion = action.completion {
            cells += " <span class=\"completion\">\(escape(completion))</span>"
        }
        cells += "</td>"
        cells += "<td class=\"route\">\(escape(action.route ?? ""))</td>"

        var detail: [String] = []
        if let message = action.message, !message.isEmpty { detail.append(escape(message)) }
        if let error = action.error, !error.isEmpty {
            detail.append("<span class=\"errtext\">\(escape(error))</span>")
        }
        var target: [String] = []
        if let x = action.x, let y = action.y { target.append("at \(format(x)), \(format(y))") }
        if let windowID = action.windowID { target.append("window \(windowID)") }
        if !target.isEmpty { detail.append("<span class=\"target\">\(escape(target.joined(separator: " · ")))</span>") }
        cells += "<td class=\"detail\">\(detail.joined(separator: "<br>"))</td>"

        cells += "<td class=\"frame\">\(thumbnail(action.beforeFrame, alt: "before \(action.seq)", status: action.beforeFrameStatus))</td>"
        cells += "<td class=\"frame\">\(thumbnail(action.afterFrame, alt: "after \(action.seq)", status: action.afterFrameStatus))</td>"
        return "<tr class=\"\(badgeClass)\">\(cells)</tr>\n"
    }

    /// Only a plain relative `frames/<name>.png` is allowed through. A tampered sidecar must
    /// not be able to make the page load an arbitrary local file or a remote URL.
    private static func thumbnail(_ relative: String?, alt: String, status: String?) -> String {
        guard let relative, isSafeFramePath(relative) else { return status.map(escape) ?? "" }
        return "<a href=\"\(escape(relative))\"><img src=\"\(escape(relative))\" alt=\"\(escape(alt))\" loading=\"lazy\"></a>"
    }

    static func isSafeFramePath(_ path: String) -> Bool {
        let prefix = SessionRecorder.framesDirectoryName + "/"
        guard path.hasPrefix(prefix), path.hasSuffix(".png") else { return false }
        let name = path.dropFirst(prefix.count)
        guard !name.isEmpty, name.utf8.count <= 128 else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        return name.allSatisfy { allowed.contains($0) } && !name.contains("..")
    }

    private static func metaRow(_ label: String, _ value: String) -> String {
        "<dt>\(escape(label))</dt><dd>\(escape(value))</dd>\n"
    }

    /// Escapes every character HTML could interpret, in attribute or text position.
    static func escape(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.utf8.count)
        for scalar in raw.unicodeScalars {
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    private static func offset(_ date: Date, from origin: Date) -> String {
        let seconds = date.timeIntervalSince(origin)
        guard seconds.isFinite else { return "?" }
        return String(format: "%@%.3fs", seconds < 0 ? "-" : "+", abs(seconds))
    }

    private static func format(_ value: Double) -> String {
        guard value.isFinite else { return "?" }
        if let integer = Int(exactly: value) { return String(integer) }
        return String(format: "%.1f", value)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static let stylesheet = """
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    body { margin: 2rem auto; max-width: 1200px; padding: 0 1rem; line-height: 1.4; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0 0 1rem; }
    dl.meta dt { font-weight: 600; opacity: 0.7; }
    dl.meta dd { margin: 0; font-family: ui-monospace, Menlo, monospace; }
    p.summary { margin: 0 0 1rem; }
    table.timeline { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    table.timeline th, table.timeline td { border-top: 1px solid rgba(127,127,127,0.35); padding: 0.4rem 0.5rem; text-align: left; vertical-align: top; }
    table.timeline th { font-weight: 600; opacity: 0.7; }
    td.seq, td.time { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
    td.cmd code { font-family: ui-monospace, Menlo, monospace; }
    span.len, span.completion, span.target { opacity: 0.7; font-size: 0.85em; }
    span.badge { display: inline-block; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.8em; font-weight: 600; }
    span.badge.ok { background: rgba(52,199,89,0.2); color: #1f8a3b; }
    span.badge.error { background: rgba(255,59,48,0.2); color: #c0281f; }
    tr.error td { background: rgba(255,59,48,0.06); }
    span.errtext { color: #c0281f; }
    td.frame img { max-width: 160px; max-height: 120px; border: 1px solid rgba(127,127,127,0.35); border-radius: 4px; }
    footer { margin-top: 1.5rem; font-size: 0.8rem; opacity: 0.7; }

    """
}
