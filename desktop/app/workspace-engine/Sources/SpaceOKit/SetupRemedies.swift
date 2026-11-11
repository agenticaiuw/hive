import Foundation

// MARK: - Interactive, resumable setup (SPAO-201)

/// The System Settings panes setup and doctor can open on the reader's behalf.
///
/// The URL scheme is the public one Apple's own apps use; a pane that opens directly saves the
/// developer the search that the trust audit identifies as the least-verified point in the funnel.
/// Opening a pane never grants anything: macOS still needs the user to flip the switch.
public enum SettingsPane: String, CaseIterable, Sendable {
    case accessibility
    case screenRecording
    case focus

    public var url: URL {
        let raw: String
        switch self {
        case .accessibility:
            raw = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .screenRecording:
            raw = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .focus:
            raw = "x-apple.systempreferences:com.apple.Focus-Settings.extension"
        }
        // These are constant, ASCII, and scheme-valid; a construction failure here is a
        // programming error rather than a runtime condition.
        return URL(string: raw)!
    }

    /// Wording used in countdown and remedy lines.
    public var displayName: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .screenRecording: return "Screen & System Audio Recording"
        case .focus: return "Focus"
        }
    }
}

/// Polls for a TCC grant after the matching Settings pane has been opened.
///
/// The clock and sleep are injected so the policy (one probe per interval, hard deadline, a
/// countdown for the reader) can be tested without a test ever sleeping, and so a caller on a
/// non-TTY can substitute a zero deadline. The predicate is evaluated before the first sleep so a
/// grant that already landed returns immediately.
public struct GrantWaiter: Sendable {
    public let pane: SettingsPane
    public let deadline: TimeInterval
    public let interval: TimeInterval

    public init(pane: SettingsPane, deadline: TimeInterval = 120, interval: TimeInterval = 1) {
        self.pane = pane
        // Bound both so a misconfigured caller cannot spin or wait forever.
        self.deadline = min(max(deadline, 0), 3_600)
        self.interval = min(max(interval, 0.05), 60)
    }

    /// Returns true as soon as `predicate` holds, false once the deadline passes.
    ///
    /// `onTick` receives the whole seconds remaining after each unsuccessful probe, so the caller
    /// can render "waiting for Accessibility… 118 s" without owning the arithmetic.
    public func wait(
        predicate: @escaping () -> Bool,
        now: @escaping () -> Date,
        sleep: @escaping (TimeInterval) -> Void,
        onTick: (_ remaining: Int) -> Void
    ) -> Bool {
        let start = now()
        let end = start.addingTimeInterval(deadline)
        while true {
            if predicate() { return true }
            let current = now()
            let remaining = end.timeIntervalSince(current)
            if remaining <= 0 { return false }
            onTick(Int(remaining.rounded(.down)))
            sleep(min(interval, remaining))
        }
    }
}

/// Which setup steps have already passed, and when.
///
/// Keyed by step name rather than index so that inserting a step in a later release cannot make
/// a stale file skip the wrong check.
public struct SetupProgress: Codable, Equatable, Sendable {
    public var passedSteps: [String: Date]

    public init(passedSteps: [String: Date] = [:]) {
        self.passedSteps = passedSteps
    }
}

/// File-backed setup progress, so a rerun can skip completed steps and say why.
///
/// The file is advisory: a corrupt or unreadable file is treated as "nothing passed", because a
/// bad state file must never be the reason setup itself cannot run. Writes are atomic and 0600
/// for the same reason the session ledger's are — a half-written file would otherwise be read
/// back as corrupt on the very next run.
public final class SetupProgressStore {
    public let url: URL

    /// Upper bound on the state file; it holds a handful of step names, never user content.
    static let maximumBytes = 64 * 1_024

    public init(url: URL = SetupProgressStore.defaultURL()) {
        self.url = url
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base
            .appendingPathComponent("SpaceO", isDirectory: true)
            .appendingPathComponent("setup-state.json", isDirectory: false)
    }

    public func load() -> SetupProgress {
        guard let data = try? BoundedRegularFile.read(url, maximumBytes: Self.maximumBytes) else {
            return SetupProgress()
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(SetupProgress.self, from: data)) ?? SetupProgress()
    }

    public func markPassed(_ step: String, at date: Date) throws {
        var progress = load()
        progress.passedSteps[step] = date
        try save(progress)
    }

    public func reset() throws {
        do {
            try FileManager.default.removeItem(at: url)
        } catch CocoaError.fileNoSuchFile {
            // Already reset; resetting a clean host is not an error.
        }
    }

    private func save(_ progress: SetupProgress) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        var data = try encoder.encode(progress)
        data.append(0x0A)

        let temporary = directory.appendingPathComponent(
            ".setup-state-\(UUID().uuidString).tmp", isDirectory: false)
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else {
            throw SetupProgressStoreError.writeFailed("create temporary state file: errno \(errno)")
        }
        var renamed = false
        defer {
            close(fd)
            if !renamed { unlink(temporary.path) }
        }
        guard fchmod(fd, 0o600) == 0 else {
            throw SetupProgressStoreError.writeFailed("set state file mode 0600: errno \(errno)")
        }
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else {
                    throw SetupProgressStoreError.writeFailed("write state file: errno \(errno)")
                }
                offset += count
            }
        }
        guard fsync(fd) == 0 else {
            throw SetupProgressStoreError.writeFailed("fsync state file: errno \(errno)")
        }
        guard rename(temporary.path, url.path) == 0 else {
            throw SetupProgressStoreError.writeFailed("replace state file: errno \(errno)")
        }
        renamed = true
    }
}

public enum SetupProgressStoreError: Error, Equatable, Sendable {
    case writeFailed(String)
}

/// Short, human sentences setup prints when it relies on remembered state.
public enum SetupNarration {
    /// "step accessibility passed at 14:02; skipping" — the time is what lets the reader decide
    /// whether the remembered pass is still trustworthy.
    public static func skipLine(step: String, passedAt: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        return "step \(step) passed at \(formatter.string(from: passedAt)); skipping"
    }
}

// MARK: - doctor --fix (SPAO-216)

/// The subset of a doctor report that has a remedy.
///
/// This is a value type deliberately separate from the report so that `DoctorRemedy.remedies(for:)`
/// is a pure function tests can drive without a daemon, a display, or a TCC grant.
public struct DoctorFindings: Equatable, Sendable {
    public var accessibilityGranted: Bool
    public var screenRecordingGranted: Bool
    public var daemonRunning: Bool
    /// nil when no daemon answered, or when the running build cannot be identified.
    public var daemonMatchesCLI: Bool?
    public var orphanedDisplayIDs: [UInt32]
    public var orphanLedgerNamespaces: [String]
    public var orphanProfileDirectories: [String]
    public var liveSessionCount: Int
    /// Something is listening on the socket but did not answer the probe. A slow daemon still
    /// owns its displays and profiles, so no cleanup or restart may be offered on its behalf.
    public var daemonUnresponsive: Bool

    public init(
        accessibilityGranted: Bool = true,
        screenRecordingGranted: Bool = true,
        daemonRunning: Bool = false,
        daemonMatchesCLI: Bool? = nil,
        orphanedDisplayIDs: [UInt32] = [],
        orphanLedgerNamespaces: [String] = [],
        orphanProfileDirectories: [String] = [],
        liveSessionCount: Int = 0,
        daemonUnresponsive: Bool = false
    ) {
        self.accessibilityGranted = accessibilityGranted
        self.screenRecordingGranted = screenRecordingGranted
        self.daemonRunning = daemonRunning
        self.daemonMatchesCLI = daemonMatchesCLI
        self.orphanedDisplayIDs = orphanedDisplayIDs
        self.orphanLedgerNamespaces = orphanLedgerNamespaces
        self.orphanProfileDirectories = orphanProfileDirectories
        self.liveSessionCount = liveSessionCount
        self.daemonUnresponsive = daemonUnresponsive
    }
}

/// One remediation `doctor --fix` may offer behind a y/N prompt.
///
/// Every case is either reversible, deferred until the daemon is idle, or print-only. Anything
/// that could disturb a working session (stopping the daemon now, sleeping the displays) is
/// described rather than performed, because a doctor that breaks another agent's session to fix
/// a cosmetic finding is worse than no doctor at all.
public enum DoctorRemedy: Equatable, Sendable {
    case openSettingsPane(SettingsPane)
    case restartDaemonWhenIdle
    case quarantineOrphanLedgers([String])
    case removeOrphanProfiles([String])
    case printDisplayWakeCommands([UInt32])

    /// One line shown before the y/N prompt.
    public var title: String {
        switch self {
        case .openSettingsPane(let pane):
            return "Open System Settings ▸ Privacy & Security ▸ \(pane.displayName) so you can enable the app that runs spaceo"
        case .restartDaemonWhenIdle:
            return "Restart the daemon with this build once no session is live (`spaceo daemon restart --operator`)"
        case .quarantineOrphanLedgers(let namespaces):
            return "Quarantine \(namespaces.count) orphaned session ledger\(namespaces.count == 1 ? "" : "s") "
                + "(\(namespaces.joined(separator: ", "))); nothing is deleted"
        case .removeOrphanProfiles(let directories):
            return "Remove \(directories.count) temporary browser profile director\(directories.count == 1 ? "y" : "ies") "
                + "no session references"
        case .printDisplayWakeCommands(let ids):
            return "Print the display sleep/wake commands that retire orphaned display\(ids.count == 1 ? "" : "s") "
                + ids.map(String.init).joined(separator: ", ") + " (not run for you)"
        }
    }

    /// Whether the remedy may be offered while sessions are live.
    ///
    /// Opening a pane and printing text touch nothing; the daemon restart waits for live
    /// sessions to finish (drain, or the legacy wait) and never passes `--now`; quarantine keeps
    /// the bytes; profile candidates are by definition ones no
    /// live session references. Every case is therefore safe — the property exists so a future
    /// case that is not safe has to say so explicitly.
    public var isSafeWhileSessionsAreLive: Bool {
        switch self {
        case .openSettingsPane, .printDisplayWakeCommands, .restartDaemonWhenIdle,
             .quarantineOrphanLedgers, .removeOrphanProfiles:
            return true
        }
    }

    /// For print-only remedies, the exact commands the reader runs by hand.
    ///
    /// Display sleep is never run by doctor: it blanks every display including the user's, and
    /// on an actively used desktop that is exactly the disturbance SpaceO exists to prevent.
    public var manualCommand: String? {
        switch self {
        case .printDisplayWakeCommands:
            return "pmset displaysleepnow\n"
                + "# then wake the displays: press a key or move the mouse, or run\n"
                + "caffeinate -u -t 3"
        default:
            return nil
        }
    }

    /// Pure, ordered: grants first (nothing else works without them), then a mismatched build
    /// (a stale daemon makes every later observation suspect), then disk hygiene, then displays.
    /// A report with no findings yields no remedies.
    public static func remedies(for findings: DoctorFindings) -> [DoctorRemedy] {
        var remedies: [DoctorRemedy] = []
        // A daemon that accepts connections but has not answered is busy, not gone: its grants,
        // build, displays, and profiles are all unknown, and every remedy below would act on a
        // guess. Report it and offer nothing.
        if findings.daemonUnresponsive { return [] }
        if !findings.accessibilityGranted { remedies.append(.openSettingsPane(.accessibility)) }
        if !findings.screenRecordingGranted { remedies.append(.openSettingsPane(.screenRecording)) }
        // Only a daemon that answered can be mismatched; an unknown build (nil) is also a
        // mismatch for qualification purposes, as Setup.daemonChecks already treats it.
        if findings.daemonRunning && findings.daemonMatchesCLI != true {
            remedies.append(.restartDaemonWhenIdle)
        }
        if !findings.orphanLedgerNamespaces.isEmpty {
            remedies.append(.quarantineOrphanLedgers(findings.orphanLedgerNamespaces))
        }
        if !findings.orphanProfileDirectories.isEmpty {
            remedies.append(.removeOrphanProfiles(findings.orphanProfileDirectories))
        }
        if !findings.orphanedDisplayIDs.isEmpty {
            remedies.append(.printDisplayWakeCommands(findings.orphanedDisplayIDs))
        }
        return remedies
    }
}

// MARK: - Attention mitigations guidance (SPAO-165)

/// Honest guidance for the residual attention leaks SpaceO cannot close with public APIs.
///
/// Agent apps still appear in ⌘-Tab and the Dock, still post banners, and are still audible.
/// These notes exist so setup and doctor say exactly that, and offer the one mitigation the user
/// can apply themselves (a Focus filter), instead of implying a fix that does not exist.
public enum AttentionMitigation {
    public static let stepName = "quiet agent apps"

    /// Optional, informational step. It never fails: the absence of a Focus is a user choice,
    /// not a broken host, so `.skipped` keeps `Setup.canSelfTest` unaffected.
    public static func quietAgentAppsStep(launchedAppNames: [String], focusActive: Bool?) -> SetupStep {
        let names = Array(uniqueOrdered(launchedAppNames).prefix(32))
        guard !names.isEmpty else {
            return SetupStep(
                name: stepName, status: .skipped,
                detail: "no agent apps launched yet; rerun after a session has opened an app to "
                    + "get a list you can silence in Settings ▸ Focus",
                remedy: nil)
        }
        let list = names.joined(separator: ", ")
        return SetupStep(
            name: stepName, status: .skipped,
            detail: "\(focusStatusLine(focusActive: focusActive)); apps launched so far: \(list). "
                + "Their notifications still reach your display unless a Focus silences them",
            remedy: "Open System Settings ▸ Focus, create a Focus for agent work, and allow "
                + "notifications from everything except: \(list)")
    }

    public static let dockAndCommandTabNote: String =
        "Agent apps appear in ⌘-Tab, the Dock, and Mission Control. macOS decides this per app "
        + "(LSUIElement / activation policy); SpaceO cannot hide another app's presence without "
        + "changing that app. Use the Viewer's session titles to tell agent windows apart."

    public static let audioNote: String =
        "Managed Chromium can be launched muted (`--mute-audio`, the open_app mute option). macOS "
        + "has no per-app mute for other applications, so their audio plays on the default output "
        + "device; lower the system volume or route output to an unused device while agents run."

    /// Informational only: an active Focus is reported, never required.
    public static func focusStatusLine(focusActive: Bool?) -> String {
        switch focusActive {
        case .some(true): return "a Focus is active (agent notifications may be silenced)"
        case .some(false): return "no Focus is active (agent notifications reach your display)"
        case .none: return "Focus state unknown (SpaceO cannot read it without Focus access)"
        }
    }

    private static func uniqueOrdered(_ names: [String]) -> [String] {
        var seen = Set<String>()
        return names.compactMap { name in
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return nil }
            return trimmed
        }
    }
}
