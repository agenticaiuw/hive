import Foundation
import Darwin

/// Low-overhead process counters sampled around one daemon request.
///
/// `residentBytes` is current mapped resident memory, `physicalFootprintBytes` is the kernel's
/// pressure-accounted footprint, and `peakResidentBytes` is the process lifetime high-water mark.
/// CPU counters are cumulative so the logger can emit a request-local delta.
public struct ProcessMetricsSnapshot: Sendable, Equatable {
    public let residentBytes: UInt64
    public let physicalFootprintBytes: UInt64
    public let peakResidentBytes: UInt64
    public let userCPUSeconds: Double
    public let systemCPUSeconds: Double

    public static func capture() -> ProcessMetricsSnapshot {
        var task = task_vm_info_data_t()
        var taskCount = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let taskResult = withUnsafeMutablePointer(to: &task) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(taskCount)) {
                task_info(
                    mach_task_self_,
                    task_flavor_t(TASK_VM_INFO),
                    $0,
                    &taskCount)
            }
        }

        var usage = rusage()
        let usageResult = getrusage(RUSAGE_SELF, &usage)
        func seconds(_ value: timeval) -> Double {
            Double(value.tv_sec) + Double(value.tv_usec) / 1_000_000
        }
        return ProcessMetricsSnapshot(
            residentBytes: taskResult == KERN_SUCCESS ? task.resident_size : 0,
            physicalFootprintBytes: taskResult == KERN_SUCCESS ? task.phys_footprint : 0,
            peakResidentBytes: usageResult == 0 ? UInt64(max(0, usage.ru_maxrss)) : 0,
            userCPUSeconds: usageResult == 0 ? seconds(usage.ru_utime) : 0,
            systemCPUSeconds: usageResult == 0 ? seconds(usage.ru_stime) : 0)
    }
}

/// Append-only failure log for the shared daemon, so a failed launch, teardown, or reclamation
/// can be investigated after the fact instead of vanishing with the client that saw it.
///
/// One NDJSON object per line, timestamped, written best-effort: logging must never turn a
/// working request into a failing one, so every write error is swallowed after a single stderr
/// note. The credential rule is absolute — controller lease IDs never reach the log. The file is
/// owner-only as defense in depth, but a lease is still a mutation capability and must not be
/// retained even in an owner-readable diagnostic artifact.
///
/// Unconfigured (every process except the daemon) the shared instance is a no-op, which keeps
/// call sites in SpaceOKit unconditional.
public final class DaemonLog: @unchecked Sendable {

    public static let shared = DaemonLog()

    /// Where the daemon logs unless `SPACEO_LOG_FILE` overrides it.
    public static func defaultLogURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["SPACEO_LOG_FILE"],
           !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/SpaceO/daemon.log", isDirectory: false)
    }

    private let lock = NSLock()
    private var fileURL: URL?
    private var rotationLimitBytes: Int
    private var logEveryRequest: Bool
    private var reportedWriteFailure = false
    /// When set, `spaceo logging enable|disable` reaches the running daemon without a restart.
    private var settingsMonitor: LoggingSettingsMonitor?
    private let timestamp: () -> Date
    private let runID: String?

    static let maximumFieldCharacters = 4_096
    static let maximumFieldBytes = 16_384
    static let maximumFieldCount = 32
    static let maximumKeyBytes = 64
    static let maximumKindBytes = 128

    /// The shared instance starts unconfigured; `configure` is the daemon's opt-in.
    public init(
        rotationLimitBytes: Int = 5_000_000,
        timestamp: @escaping () -> Date = { Date() }
    ) {
        self.rotationLimitBytes = rotationLimitBytes
        self.logEveryRequest =
            ProcessInfo.processInfo.environment["SPACEO_LOG_DEBUG"] == "1"
            || ProcessInfo.processInfo.environment["SPACEO_LOG_METRICS"] == "1"
        self.timestamp = timestamp
        self.runID = ProcessInfo.processInfo.environment["SPACEO_RUN_ID"]
            .flatMap { value in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : BoundedDiagnosticText.prefix(
                    trimmed, maximumBytes: Self.maximumFieldBytes, maximumCharacters: Self.maximumFieldCharacters)
            }
    }

    /// Start writing to `fileURL`, creating its directory. Throws only from here — after a
    /// successful configure, failures degrade to a one-time stderr note.
    public func configure(fileURL: URL) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(
                atPath: fileURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600])
        }
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: fileURL.path)
        lock.withLock { self.fileURL = fileURL }
    }

    /// Follow the host's logging settings: per-request records and the larger rotation size
    /// apply while `requestMetrics` is on, and stop applying once it is turned off.
    public func follow(_ monitor: LoggingSettingsMonitor) {
        lock.withLock { settingsMonitor = monitor }
    }

    private var followedSettings: LoggingSettings? {
        lock.withLock { settingsMonitor }?.current
    }

    public var isConfigured: Bool { lock.withLock { fileURL != nil } }
    public var location: URL? { lock.withLock { fileURL } }

    /// Append one event. `fields` values are free text; keys should be stable identifiers.
    public func event(_ kind: String, _ fields: [String: String] = [:]) {
        guard isConfigured else { return }
        // Supplied clocks may inspect logger state. Never invoke client code under the
        // write lock; keep the large formatting/serialization buffers inside that lock.
        let date = timestamp()
        lock.withLock {
            guard let fileURL else { return }
            var object: [String: String] = [:]
            for key in BoundedDiagnosticText.smallestKeys(fields.keys, limit: Self.maximumFieldCount,
                                                         maximumBytes: Self.maximumKeyBytes) {
                object[key] = BoundedDiagnosticText.prefix(
                    fields[key] ?? "", maximumBytes: Self.maximumFieldBytes, maximumCharacters: Self.maximumFieldCharacters)
            }
            object["ts"] = Self.iso8601.string(from: date)
            object["kind"] = BoundedDiagnosticText.prefix(kind, maximumBytes: Self.maximumKindBytes)
            if object["run"] == nil, let runID { object["run"] = runID }
            guard var data = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys]) else { return }
            data.append(0x0A)
            do {
                try rotateIfNeededLocked(fileURL)
                let handle = try FileHandle(forWritingTo: fileURL)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } catch {
                guard !reportedWriteFailure else { return }
                reportedWriteFailure = true
                FileHandle.standardError.write(Data(
                    "warning: daemon log unwritable at \(fileURL.path): \(error)\n".utf8))
            }
        }
    }

    /// Record one handled request. Failures always log; successes only under
    /// `SPACEO_LOG_DEBUG=1`, because the failure log must stay small enough to read whole.
    /// The request summary deliberately omits the controller lease and every input payload
    /// beyond identifiers — text being typed into an agent's app is the agent's business.
    public func record(
        request: Request,
        response: Response,
        seconds: TimeInterval,
        metricsStarted: ProcessMetricsSnapshot? = nil
    ) {
        let failed = !response.ok
        let everyRequest = logEveryRequest || followedSettings?.requestMetrics == true
        guard failed || everyRequest || request.diagnosticMetrics == true,
              isConfigured else { return }
        let metricsFinished = ProcessMetricsSnapshot.capture()
        var fields: [String: String] = [
            "cmd": request.cmd,
            "ms": Self.milliseconds(seconds, clampNegative: false),
            "rss_bytes": String(metricsFinished.residentBytes),
            "physical_footprint_bytes": String(metricsFinished.physicalFootprintBytes),
            "peak_rss_bytes": String(metricsFinished.peakResidentBytes),
        ]
        if let trace = request.diagnosticTraceID { fields["trace"] = trace }
        if let run = request.diagnosticRunID { fields["run"] = run }
        if let session = request.session { fields["session"] = session }
        if let app = request.app { fields["app"] = app }
        if let window = request.window { fields["window"] = String(window) }
        if request.operatorScope == true { fields["operator"] = "true" }
        if let owner = request.controllerOwner {
            fields["controller"] = "\(owner.kind.rawValue):\(owner.id)"
        }
        // The shape of the request, never its payload: an improvement loop needs to see that a
        // click addressed element 7 or a coordinate, not what text an agent typed.
        if let client = request.diagnosticClient { fields["client"] = client }
        if let element = request.element { fields["element"] = element }
        if request.x != nil || request.y != nil { fields["point"] = "true" }
        if let label = request.label { fields["label_chars"] = String(label.count) }
        if let text = request.text { fields["text_chars"] = String(text.count) }
        if let key = request.key { fields["key"] = key }
        if let condition = request.waitCondition { fields["wait_condition"] = condition }
        if request.since != nil { fields["since"] = "true" }
        if request.web == true { fields["web"] = "true" }
        if let path = request.menuPath, !path.isEmpty { fields["menu_depth"] = String(path.count) }
        if let steps = request.steps { fields["steps"] = String(steps.count) }
        if let action = response.action {
            fields["route"] = action.route
            if let outcome = action.outcome { fields["action_outcome"] = outcome }
        }
        if let summary = response.destroySummary { fields["destroy_reason"] = summary.reason }
        if let metricsStarted {
            fields["rss_delta_bytes"] = Self.byteDelta(
                metricsFinished.residentBytes, metricsStarted.residentBytes)
            fields["physical_footprint_delta_bytes"] = Self.byteDelta(
                metricsFinished.physicalFootprintBytes, metricsStarted.physicalFootprintBytes)
            fields["cpu_user_ms"] = Self.milliseconds(
                metricsFinished.userCPUSeconds - metricsStarted.userCPUSeconds)
            fields["cpu_system_ms"] = Self.milliseconds(
                metricsFinished.systemCPUSeconds - metricsStarted.systemCPUSeconds)
        }
        if let warnings = response.warnings { fields["warning_count"] = String(warnings.count) }
        if let truncated = response.truncated { fields["truncated"] = String(truncated) }
        if let isolation = response.isolation {
            fields["isolation_verdict"] = isolation.verdict.rawValue
        }
        if let usage = response.usage {
            fields["sessions"] = String(usage.sessions)
            fields["displays"] = String(usage.displays)
            fields["framebuffer_bytes"] = String(usage.bytes)
        }
        if failed {
            fields["error"] = response.error ?? "unknown failure"
            if let code = response.errorCode { fields["error_code"] = code }
            if let recovery = response.recovery { fields["recovery_tool"] = recovery.tool }
            if let next = response.nextAction { fields["next_action"] = next }
            if let teardown = response.teardown {
                fields["teardown"] = teardown.recoveryDescription
            }
        }
        event(failed ? "request.failed" : "request.ok", fields)
    }

    private static func milliseconds(_ seconds: Double, clampNegative: Bool = true) -> String {
        guard seconds.isFinite else { return "unavailable" }
        let value = clampNegative ? max(0, seconds) : seconds
        guard let milliseconds = Int64(exactly: (value * 1_000).rounded()) else { return "unavailable" }
        return String(milliseconds)
    }

    private static func byteDelta(_ current: UInt64, _ initial: UInt64) -> String {
        current >= initial ? String(current - initial) : "-" + String(initial - current)
    }

    private func rotateIfNeededLocked(_ fileURL: URL) throws {
        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        // Per-request logging fills the default 5 MB in a few thousand calls; while it is on,
        // keep the larger history the operator asked for (still one predecessor, still bounded).
        var limit = rotationLimitBytes
        if let settings = settingsMonitor?.current, settings.requestMetrics {
            limit = max(limit, settings.maxFileBytes)
        }
        guard size >= limit else { return }
        let rotated = fileURL.appendingPathExtension("1")
        // Atomically replace the predecessor. Failure preserves both files, and a regular
        // log cannot replace a directory (unlike removeItem, this never deletes a tree).
        if rename(fileURL.path, rotated.path) != 0 {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        guard FileManager.default.createFile(
            atPath: fileURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: fileURL.path)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
