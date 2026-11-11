import Foundation
import CryptoKit
import SpaceOKit

/// The agent journal: one JSON line per MCP tool call, written by the MCP server, so an
/// improvement loop can see what agents actually experienced — which tool, with which
/// (redacted) arguments, what they were told back, how long it took, what it cost in tokens,
/// and what they did next.
///
/// Layout: `<journal dir>/<yyyy-MM-dd>/mcp-<pid>-<connection>.jsonl`, one file per MCP
/// connection so concurrent agents never interleave writes. Files and directories are
/// owner-only; each file stops at the configured cap with a final `journal.capped` record, and
/// day directories past the retention window are removed when a connection first writes.
///
/// Redaction is unconditional: typed and clipboard text are replaced by their length and a
/// fingerprint keyed with a per-connection secret (equal text is recognisable within one
/// connection, never across connections or by guessing), URL queries and fragments are dropped,
/// and screenshots are counted, never stored. `full` adds the rendered result text the agent
/// read, which can include what an app displayed.
final class MCPJournal: @unchecked Sendable {
    static let schemaVersion = 1
    static let maximumResultTextBytes = 32_768
    static let maximumErrorBytes = 2_048

    private let lock = NSLock()
    private let monitor: LoggingSettingsMonitor
    private let directory: URL
    private let now: () -> Date
    private let pid: Int32
    let connectionID: String
    private let key = SymmetricKey(size: .bits256)

    private var handle: FileHandle?
    private(set) var fileURL: URL?
    private var bytesWritten = 0
    private var capped = false
    private var client: [String: String] = [:]
    private let startedAt: Date
    private var sequence = 0
    private var previous: (tool: String, fingerprint: String, failed: Bool, endedAt: Date)?
    private var outcomes: [String: Int] = [:]
    /// What this connection typed or put on the clipboard, held in memory only. Apps echo it
    /// back ("window text now: …", a later screen read), so every text the journal writes is
    /// scrubbed of it; the file never contains it, only its keyed fingerprint.
    private var typed: [String] = []
    static let maximumRememberedTypedTexts = 64

    init(monitor: LoggingSettingsMonitor = LoggingSettingsMonitor(),
         directory: URL = LoggingSettings.journalDirectory(),
         now: @escaping () -> Date = { Date() },
         pid: Int32 = getpid()) {
        self.monitor = monitor
        self.directory = directory
        self.now = now
        self.pid = pid
        self.startedAt = now()
        self.connectionID = String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(8))
    }

    var level: LoggingSettings.JournalLevel { monitor.current.journal }

    // MARK: Events

    func connectionStarted(clientName: String?, clientVersion: String?, protocolVersion: String?) {
        lock.withLock {
            client = [:]
            if let clientName { client["name"] = Self.bounded(clientName, 128) }
            if let clientVersion { client["version"] = Self.bounded(clientVersion, 64) }
        }
        var record: [String: Any] = ["kind": "connection.start", "pid": Int(pid)]
        if let protocolVersion { record["protocol"] = Self.bounded(protocolVersion, 32) }
        record["attributed_to"] = ResponsibleProcess.describeCurrent().map { Self.bounded($0, 256) } ?? NSNull()
        write(record)
    }

    /// Non-tool MCP requests (lists, resource and prompt reads, parse failures).
    func method(_ name: String, ok: Bool, detail: String? = nil) {
        var record: [String: Any] = ["kind": "mcp.method", "method": Self.bounded(name, 64), "ok": ok]
        if let detail { record["detail"] = Self.bounded(detail, 256) }
        write(record)
    }

    func toolCall(_ call: MCPJournalCall) {
        let level = self.level
        guard level != .off else { return }
        let fingerprint = self.fingerprint(of: call.arguments)
        let failed = !["ok", "warning"].contains(call.outcome)
        remember(MCPJournalRedaction.secrets(in: call.arguments))
        var record: [String: Any] = [
            "kind": "tool_call",
            "tool": Self.bounded(call.tool, 64),
            "trace": call.trace,
            "outcome": call.outcome,
            "ms": call.milliseconds,
            "args": MCPJournalRedaction.arguments(call.arguments, level: level,
                                                  fingerprint: { self.fingerprint(of: $0) }),
            "args_fp": fingerprint,
        ]
        lock.withLock {
            sequence += 1
            record["seq"] = sequence
            outcomes[call.outcome, default: 0] += 1
            if let previous {
                record["prev_tool"] = previous.tool
                record["gap_ms"] = max(0, Int((call.startedAt.timeIntervalSince(previous.endedAt) * 1_000).rounded()))
                if previous.tool == call.tool && previous.fingerprint == fingerprint { record["repeat"] = true }
                if previous.failed { record["after_error"] = true }
            }
            previous = (call.tool, fingerprint, failed, now())
        }
        if let request = call.request {
            record["cmd"] = request.cmd
            if let session = request.session { record["session"] = Self.bounded(session, 128) }
            if let window = request.window { record["window"] = Int(window) }
        }
        if let response = call.response {
            if let action = response.action {
                var action_: [String: Any] = ["route": action.route, "completion": action.completion]
                if let outcome = action.outcome { action_["outcome"] = outcome }
                record["action"] = action_
            }
            if let isolation = response.isolation { record["isolation"] = isolation.verdict.rawValue }
            if let warnings = response.warnings, !warnings.isEmpty {
                record["warnings"] = warnings.prefix(8).map { scrub(Self.bounded($0, 512)) }
            }
            if let truncation = response.truncation, truncation.truncated {
                record["truncated"] = truncation.reason ?? "true"
            }
            if let snapshot = response.snapshotID { record["snapshot"] = snapshot }
            if let summary = response.destroySummary { record["destroy_reason"] = summary.reason }
            if let wait = response.wait { record["wait"] = ["condition": wait.condition, "outcome": wait.outcome] }
            if let session = response.session?.id, record["session"] == nil {
                record["session"] = Self.bounded(session, 128)
            }
        }
        // Record ownership facts without credentials, including a create whose later launch
        // failed and the successful subset of a bulk teardown.
        var lifecycle: [String: Any] = [:]
        if let request = call.request, let response = call.response {
            if DaemonCommand.leaseIssuing.contains(request.cmd), response.controllerLeaseID != nil,
               let session = response.session?.id {
                lifecycle["acquired"] = Self.bounded(session, 128)
            }
            if request.cmd == "session.destroy", response.ok, let session = request.session {
                lifecycle["released"] = [Self.bounded(session, 128)]
            }
        }
        if let released = call.releasedSessions {
            lifecycle["released"] = released.prefix(128).map { Self.bounded($0, 128) }
            if released.count > 128 { lifecycle["released_truncated"] = true }
        }
        if !lifecycle.isEmpty { record["session_lifecycle"] = lifecycle }
        if failed {
            record["error"] = errorRecord(call)
        }
        record["result"] = resultRecord(call.result, level: level)
        if let observe = call.observe { record["observe"] = ["mode": observe, "appended": call.observed] }
        if !call.notes.isEmpty { record["notes"] = call.notes.prefix(8).map { scrub(Self.bounded($0, 512)) } }
        write(record)
    }

    func connectionEnded(reason: String) {
        let summary: [String: Any] = lock.withLock {
            ["kind": "connection.end", "reason": reason, "calls": sequence, "outcomes": outcomes,
             "duration_s": Int(now().timeIntervalSince(startedAt).rounded())]
        }
        write(summary)
        lock.withLock {
            try? handle?.close()
            handle = nil
        }
    }

    // MARK: Record pieces

    private func errorRecord(_ call: MCPJournalCall) -> [String: Any] {
        var error: [String: Any] = [:]
        let text = Self.firstText(call.result) ?? ""
        if let response = call.response {
            if let code = response.errorCode { error["code"] = code }
            if let message = response.error { error["message"] = scrub(Self.bounded(message, Self.maximumErrorBytes)) }
            if let recovery = response.recovery {
                error["recovery_tool"] = recovery.tool
                error["recovery_then"] = Self.bounded(recovery.then, 256)
            }
            if let next = response.nextAction { error["next_action"] = Self.bounded(next, 256) }
        }
        if error["code"] == nil, text.hasPrefix("["), let close = text.firstIndex(of: "]") {
            error["code"] = String(text[text.index(after: text.startIndex)..<close])
        }
        if error["code"] == nil {
            error["code"] = call.outcome == "invalid_arguments" ? "invalid_arguments" : call.outcome
        }
        if error["message"] == nil { error["message"] = scrub(Self.bounded(text, Self.maximumErrorBytes)) }
        return error
    }

    private func resultRecord(_ result: [String: Any]?, level: LoggingSettings.JournalLevel) -> [String: Any] {
        let content = result?["content"] as? [[String: Any]] ?? []
        var texts: [String] = []
        var images = 0
        var imageBytes = 0
        for block in content {
            if block["type"] as? String == "text", let text = block["text"] as? String {
                texts.append(text)
            } else if block["type"] as? String == "image" {
                images += 1
                imageBytes += (block["data"] as? String)?.utf8.count ?? 0
            }
        }
        let text = scrub(texts.joined(separator: "\n"))
        let bytes = text.utf8.count
        var record: [String: Any] = [
            "is_error": result?["isError"] as? Bool ?? false,
            "text_bytes": bytes,
            // Roughly what the agent paid to read it; images are billed separately by the client.
            "est_tokens": (bytes + 3) / 4,
            "lines": text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count,
        ]
        if images > 0 {
            record["images"] = images
            record["image_base64_bytes"] = imageBytes
        }
        record["first_line"] = Self.bounded(String(text.prefix { $0 != "\n" }), 256)
        if level == .full {
            let clipped = MCPJournal.prefix(text, maximumBytes: Self.maximumResultTextBytes)
            record["text"] = clipped
            if clipped.utf8.count < bytes { record["text_clipped"] = true }
        }
        return record
    }

    // MARK: Writing

    private func write(_ fields: [String: Any]) {
        let settings = monitor.current
        guard settings.journal != .off else { return }
        lock.withLock {
            guard !capped, let handle = openLocked(settings) else { return }
            var record = fields
            record["v"] = Self.schemaVersion
            record["ts"] = Self.iso8601.string(from: now())
            record["conn"] = connectionID
            record["spaceo"] = SpaceOVersion.current
            record["level"] = settings.journal.rawValue
            if !client.isEmpty { record["client"] = client }
            guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
            data.append(0x0A)
            if bytesWritten + data.count > settings.maxFileBytes {
                capped = true
                let note = "{\"kind\":\"journal.capped\",\"conn\":\"\(connectionID)\",\"v\":\(Self.schemaVersion)}\n"
                try? handle.write(contentsOf: Data(note.utf8))
                return
            }
            do {
                try handle.write(contentsOf: data)
                bytesWritten += data.count
            } catch {
                capped = true
            }
        }
    }

    private func openLocked(_ settings: LoggingSettings) -> FileHandle? {
        if let handle { return handle }
        let day = Self.day.string(from: now())
        let folder = directory.appendingPathComponent(day, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            pruneLocked(retentionDays: settings.retentionDays)
            let url = folder.appendingPathComponent("mcp-\(pid)-\(connectionID).jsonl", isDirectory: false)
            if !FileManager.default.fileExists(atPath: url.path) {
                guard FileManager.default.createFile(atPath: url.path, contents: nil,
                                                     attributes: [.posixPermissions: 0o600]) else { return nil }
            }
            let opened = try FileHandle(forWritingTo: url)
            try opened.seekToEnd()
            handle = opened
            fileURL = url
            return opened
        } catch {
            capped = true
            return nil
        }
    }

    /// Only directories named like a date, directly inside the journal directory, are removed.
    private func pruneLocked(retentionDays: Int) {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        let cutoff = now().addingTimeInterval(-Double(retentionDays) * 86_400)
        for name in entries.prefix(1_000) {
            guard name.count == 10, let date = Self.day.date(from: name), date < cutoff else { continue }
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name, isDirectory: true))
        }
    }

    // MARK: Helpers

    private func remember(_ secrets: [String]) {
        guard !secrets.isEmpty else { return }
        lock.withLock {
            for secret in secrets where !typed.contains(secret) {
                typed.append(secret)
            }
            if typed.count > Self.maximumRememberedTypedTexts {
                typed.removeFirst(typed.count - Self.maximumRememberedTypedTexts)
            }
        }
    }

    /// Replace every remembered typed text, ignoring case (apps auto-capitalise), longest first
    /// so a text that contains another is replaced whole.
    func scrub(_ text: String) -> String {
        let secrets = lock.withLock { typed }.sorted { $0.count > $1.count }
        var result = text
        for secret in secrets where result.range(of: secret, options: .caseInsensitive) != nil {
            result = result.replacingOccurrences(of: secret, with: "‹typed \(fingerprint(of: secret))›",
                                                 options: .caseInsensitive)
        }
        return result
    }

    /// Keyed so equal inputs match within this connection but cannot be guessed offline.
    func fingerprint(of value: Any) -> String {
        let data: Data
        if let string = value as? String {
            data = Data(string.utf8)
        } else if JSONSerialization.isValidJSONObject(value),
                  let encoded = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            data = encoded
        } else {
            data = Data(String(describing: value).utf8)
        }
        let mac = HMAC<SHA256>.authenticationCode(for: data, using: key)
        return mac.prefix(6).map { String(format: "%02x", $0) }.joined()
    }

    static func firstText(_ result: [String: Any]?) -> String? {
        (result?["content"] as? [[String: Any]])?.first { $0["type"] as? String == "text" }?["text"] as? String
    }

    static func bounded(_ text: String, _ maximumBytes: Int) -> String {
        prefix(text, maximumBytes: maximumBytes)
    }

    /// The longest whole-character prefix within `maximumBytes` of UTF-8. Newlines are kept:
    /// the journal stores result text exactly as the agent read it.
    static func prefix(_ text: String, maximumBytes: Int) -> String {
        guard text.utf8.count > maximumBytes else { return text }
        var result = ""
        var used = 0
        for character in text {
            let size = character.utf8.count
            guard used + size <= maximumBytes else { break }
            result.append(character)
            used += size
        }
        return result
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

struct MCPJournalCall {
    var tool: String
    var trace: String
    var arguments: [String: Any]
    var startedAt: Date
    var milliseconds: Int
    var outcome: String
    var request: Request?
    var response: Response?
    var result: [String: Any]?
    var observe: String?
    var observed = false
    var notes: [String] = []
    var releasedSessions: [String]?
}

enum MCPJournalRedaction {
    /// Keys whose string values are what the agent typed or put on a clipboard.
    static let secretKeys: Set<String> = ["text"]
    static let pathKeys: Set<String> = ["files", "output", "path"]
    static let maximumDepth = 4
    static let maximumEntries = 32

    /// Every typed or clipboard string in the arguments (including batched steps). Very short
    /// texts are skipped: scrubbing "a" or "OK" would mangle the journal without hiding anything.
    static func secrets(in value: Any, key: String? = nil, depth: Int = 0) -> [String] {
        guard depth <= maximumDepth else { return [] }
        if let object = value as? [String: Any] {
            return object.keys.sorted().prefix(maximumEntries).flatMap {
                secrets(in: object[$0] as Any, key: $0, depth: depth + 1)
            }
        }
        if let array = value as? [Any] {
            return array.prefix(maximumEntries).flatMap { secrets(in: $0, key: key, depth: depth + 1) }
        }
        guard let key, secretKeys.contains(key), let string = value as? String,
              string.count >= 3, string.count <= 20_000 else { return [] }
        return [string]
    }

    static func arguments(_ arguments: [String: Any], level: LoggingSettings.JournalLevel,
                          fingerprint: (String) -> String) -> [String: Any] {
        redact(arguments, key: nil, depth: 0, level: level, fingerprint: fingerprint) as? [String: Any] ?? [:]
    }

    private static func redact(_ value: Any, key: String?, depth: Int,
                               level: LoggingSettings.JournalLevel,
                               fingerprint: (String) -> String) -> Any {
        guard depth <= maximumDepth else { return "…" }
        if let object = value as? [String: Any] {
            var result: [String: Any] = [:]
            for name in object.keys.sorted().prefix(maximumEntries) {
                result[String(name.prefix(64))] = redact(object[name] as Any, key: name, depth: depth + 1,
                                                         level: level, fingerprint: fingerprint)
            }
            if object.count > maximumEntries { result["…omitted_keys"] = object.count - maximumEntries }
            return result
        }
        if let array = value as? [Any] {
            var result = array.prefix(maximumEntries).map {
                redact($0, key: key, depth: depth + 1, level: level, fingerprint: fingerprint)
            }
            if array.count > maximumEntries { result.append("… \(array.count - maximumEntries) more") }
            return result
        }
        guard let string = value as? String else {
            // Numbers and booleans carry no content worth hiding.
            if value is NSNull { return NSNull() }
            return value
        }
        if let key, secretKeys.contains(key) {
            return ["chars": string.count, "fp": fingerprint(string)]
        }
        if key == "url" { return url(string, level: level) }
        if let key, pathKeys.contains(key), level != .full {
            return (string as NSString).lastPathComponent
        }
        return MCPJournal.prefix(string, maximumBytes: level == .full ? 1_024 : 256)
    }

    /// Queries and fragments often carry tokens; `metadata` keeps only scheme and host.
    static func url(_ raw: String, level: LoggingSettings.JournalLevel) -> String {
        guard var components = URLComponents(string: raw), components.scheme != nil else {
            return "(unparsed url, \(raw.count) chars)"
        }
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        if level != .full { components.path = "" }
        return MCPJournal.prefix(components.string ?? "(url)", maximumBytes: 512)
    }
}
