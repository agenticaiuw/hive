import Foundation
import Darwin

/// Read-only lifecycle admission state. A ready journal does not qualify the display topology.
public struct DisplaySafetyStatus: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case ready, blocked, unknown }
    public let state: State
    public let reason: String?
    /// Backings retained after a fallback settling refusal, without a sticky circuit fault.
    public var deferredRetirementDisplayIDs: [UInt32]? = nil
    /// Explicit diagnostic mode bypasses rolling creation admission, not mutation ownership.
    public var creationRateTestingOverride: Bool? = nil
    public var allowsCreation: Bool { state == .ready && (deferredRetirementDisplayIDs ?? []).isEmpty }

    public init(state: State, reason: String? = nil) {
        self.state = state
        self.reason = reason
    }
}

/// One display-owning SpaceO process per user. A persistent, small journal carries creation
/// attempts and an unfinished-mutation/failure latch across daemon and XCTest restarts.
/// This coordinates same-user clients; it is not a security boundary.
final class DisplayLifecycleLease: @unchecked Sendable {
    static let maximumCreationsPerMinute = 4
    static let maximumCreationsPerTenMinutes = 12
    static let maximumCreationsPerDay = 32
    private static let inspectionWorker = DisplayLifecycleCoordinator()
    private struct Journal: Codable {
        var attempts: [TimeInterval] = []
        var dayAttempts: [TimeInterval]?
        var pending = false
        var liveTestPending: Bool?
        var failure: String?
        /// Token of a host-health recovery whose clearing is decided by its exclusive record.
        var recovery: String?
    }

    private let lock = NSLock()
    private let statusLock = NSLock()
    private var observedStatus: DisplaySafetyStatus?
    var cachedStatus: DisplaySafetyStatus? { statusLock.withLock { observedStatus } }

    private func updateStatus() {
        var state: DisplaySafetyStatus
        if let failure = journal.failure { state = .init(state: .blocked, reason: String(failure.prefix(512))) }
        else if journal.pending || journal.liveTestPending == true {
            state = .init(state: .blocked, reason: "a display mutation or live case is pending or was interrupted")
        } else { state = .init(state: .ready) }
        state = Self.annotating(state, testingOverride: testingOverride)
        statusLock.withLock { observedStatus = state }
    }
    private let path: String
    private let testingOverride: Bool
    private var descriptor: Int32 = -1
    private var journal = Journal()
    private var ownsLiveTest = false

    static var defaultPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/SpaceO/display-safety.json").path
    }

    init(path: String = DisplayLifecycleLease.defaultPath,
         testingOverride: Bool = DisplayTestingPolicy.enabled()) {
        self.path = path
        self.testingOverride = testingOverride
    }

    deinit { if descriptor >= 0 { close(descriptor) } }

    /// Never acquire the owner's lease, create/reset a file, or wait for its mutex in doctor.
    /// A concurrent write can yield unknown, which must not be reported as healthy.
    static func status(path: String? = nil,
                       testingOverride: Bool = DisplayTestingPolicy.enabled()) -> DisplaySafetyStatus {
        annotating(inspectStatus(using: inspectionWorker) {
            // Resolve the account home on the worker too; directory services may stall.
            readStatus(path: path ?? defaultPath)
        }, testingOverride: testingOverride)
    }

    /// Diagnostic evidence records the bypass in every state and from every reader, including
    /// a read-only inspection made before any process has acquired the lease.
    static func annotating(_ status: DisplaySafetyStatus, testingOverride: Bool) -> DisplaySafetyStatus {
        var status = status
        if testingOverride { status.creationRateTestingOverride = true }
        return status
    }

    /// One bounded reader per process. A stuck read cannot grow a replacement-worker queue,
    /// and a late result cannot turn a timed-out inspection into a healthy report.
    static func inspectStatus(using worker: DisplayLifecycleCoordinator, timeout: TimeInterval = 1,
                              read: @escaping @Sendable () -> DisplaySafetyStatus) -> DisplaySafetyStatus {
        do { return try worker.perform(timeout: timeout, onlyWhenIdle: true) { _ in read() } }
        catch { return .init(state: .unknown, reason: "lifecycle journal inspection is unavailable or exceeded its deadline") }
    }

    private static func readStatus(path: String) -> DisplaySafetyStatus {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else {
            return errno == ENOENT ? .init(state: .ready)
                : .init(state: .unknown, reason: "cannot open lifecycle journal")
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0,
              info.st_size >= 0, info.st_size <= 4096 else {
            return .init(state: .unknown, reason: "lifecycle journal is not a private bounded regular file")
        }
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = pread(fd, &bytes, bytes.count, 0)
        guard count >= 0, count == info.st_size else {
            return .init(state: .unknown, reason: "cannot read a complete lifecycle journal")
        }
        if count == 0 { return .init(state: .ready) }
        guard var journal = try? JSONDecoder().decode(Journal.self, from: Data(bytes.prefix(count))),
              journal.attempts.count <= maximumCreationsPerTenMinutes,
              journal.attempts.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            return .init(state: .unknown, reason: "lifecycle journal is unreadable; inspection is required")
        }
        guard validDayHistory(journal) else {
            return .init(state: .unknown, reason: "invalid daily lifecycle history")
        }
        if let token = markedRecovery(journal) {
            var decision = RecoveryDecision.absent
            // A pending mutation or live case blocks whatever the recovery decides.
            if !journal.pending, journal.liveTestPending != true {
                // Unlocked, so a recovery worker may still be running. Its commit renames the
                // staged record onto the decision path atomically, so inspect staged FIRST: a
                // staged record already gone with no decision can never commit later, while a
                // decision entry, once present, is final because the commit rename is exclusive.
                var stagedInfo = stat()
                let staged: Bool
                if lstat(recoveryDecisionPath(path, token) + ".staged", &stagedInfo) == 0 { staged = true }
                else if errno == ENOENT { staged = false }
                else { return .init(state: .unknown, reason: "cannot inspect host-health recovery \(token)") }
                decision = inspectRecoveryDecision(path: path, token: token)
                if decision == .unreadable {
                    return .init(state: .unknown, reason: "cannot read the decision of host-health recovery \(token)")
                }
                if decision == .absent, staged {
                    return .init(state: .unknown, reason: "host-health recovery \(token) is undecided; a stalled recovery "
                        + "may still commit. If no `spaceo safety clear-host-health` process remains, rerun it")
                }
            }
            resolveRecovery(&journal, token: token, committed: decision == .committed)
        }
        if let failure = journal.failure {
            return .init(state: .blocked, reason: String(failure.prefix(512)))
        }
        if journal.pending || journal.liveTestPending == true {
            return .init(state: .blocked, reason: "a display mutation or live case is pending or was interrupted")
        }
        return .init(state: .ready)
    }


    func acquire() throws { try acquire(allowHostHealthRecovery: false) }

    private func acquire(allowHostHealthRecovery: Bool) throws {
        try lock.withLock {
            if descriptor >= 0 { try requireHealthy(); return }
            let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
            guard fd >= 0 else { throw refused("cannot open lifecycle journal") }
            var keep = false
            defer { if !keep { close(fd) } }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                  info.st_uid == getuid(), info.st_nlink == 1,
                  info.st_mode & 0o077 == 0, info.st_size <= 4096 else {
                throw refused("lifecycle journal is not a private bounded regular file")
            }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                throw refused("another SpaceO process owns the display lifecycle")
            }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = pread(fd, &bytes, bytes.count, 0)
            guard count >= 0, count == info.st_size else { throw refused("cannot read lifecycle journal") }
            if count > 0 {
                do { journal = try JSONDecoder().decode(Journal.self, from: Data(bytes.prefix(count))) }
                catch { throw refused("lifecycle journal is unreadable; inspection is required") }
                guard journal.attempts.count <= Self.maximumCreationsPerTenMinutes,
                      journal.attempts.allSatisfy({ $0.isFinite && $0 >= 0 }),
                      Self.validDayHistory(journal) else {
                    throw refused("invalid lifecycle history")
                }
                // Locked: no recovery worker is live, so only a complete commit record clears.
                if let token = Self.markedRecovery(journal) {
                    Self.resolveRecovery(&journal, token: token,
                                         committed: Self.inspectRecoveryDecision(path: path, token: token) == .committed)
                }
            }
            descriptor = fd
            keep = true
            updateStatus()
            if allowHostHealthRecovery {
                guard Self.isRecoverableHostHealthLatch(journal) else {
                    if journal.pending || journal.liveTestPending == true {
                        throw refused("host-health recovery refused: a display mutation or live case is pending")
                    }
                    throw refused("host-health recovery refused: the recorded failure is not an eligible idle health latch; "
                        + "only host_health_unknown, memory_pressure, swap_activity or recent_windowserver_diagnostic can be recovered; "
                        + "inspect docs/DISPLAY_SAFETY.md")
                }
            } else {
                try requireHealthy()
            }
        }
    }

    func begin(creation: Bool, now: Date = Date()) throws {
        try lock.withLock {
            guard descriptor >= 0 else { throw refused("lifecycle lease was not acquired") }
            try requireHealthy()
            if creation {
                let time = now.timeIntervalSince1970
                guard time.isFinite, time >= 0 else { throw refused("invalid creation time") }
                // Seed an older journal with the history it retained; never invent past evidence.
                var day = journal.dayAttempts ?? journal.attempts
                // Clock rollback cannot erase history or produce an unlimited admission window.
                guard journal.attempts.allSatisfy({ $0 <= time }), day.allSatisfy({ $0 <= time }) else {
                    throw refused("clock moved backwards; creation history must age out")
                }
                journal.attempts.removeAll { time - $0 >= 600 }
                day.removeAll { time - $0 >= 86_400 }
                day.sort()
                let minute = journal.attempts.filter { time - $0 < 60 }.sorted()
                let tenMinutes = journal.attempts.sorted()
                let minuteCap = Self.maximumCreationsPerMinute
                let tenMinuteCap = Self.maximumCreationsPerTenMinutes
                let dayCap = Self.maximumCreationsPerDay
                let minuteWait = minute.count >= minuteCap ? minute[minute.count - minuteCap] + 60 - time : 0
                let tenMinuteWait = tenMinutes.count >= tenMinuteCap ? tenMinutes[tenMinutes.count - tenMinuteCap] + 600 - time : 0
                let dayWait = day.count >= dayCap ? day[day.count - dayCap] + 86_400 - time : 0
                let retryAfter = max(minuteWait, tenMinuteWait, dayWait)
                guard testingOverride || retryAfter <= 0 else {
                    throw SpaceOError.resourceLimit(
                        kind: .creationRate,
                        detail: "display safety limit: at most \(minuteCap) creation attempts per minute "
                            + "\(tenMinuteCap) per ten minutes and \(dayCap) per day across SpaceO processes; reuse idle displays",
                        retryAfter: retryAfter)
                }
                journal.attempts.append(time)
                day.append(time)
                // The latest cap entries completely determine normal rolling admission.
                // Diagnostic runs can exceed it without growing the bounded journal or
                // erasing the history that must still constrain subsequent normal runs.
                journal.attempts = Array(journal.attempts.sorted().suffix(tenMinuteCap))
                journal.dayAttempts = Array(day.suffix(dayCap))
            }
            journal.pending = true
            try save()
        }
    }


    private static func isRecoverableHostHealthLatch(_ journal: Journal) -> Bool {
        guard !journal.pending, journal.liveTestPending != true, let failure = journal.failure else { return false }
        return isRecoverableHostHealthFailure(failure)
    }

    /// Only reversible resource refusals, the old false-unknown latch and the retired
    /// WindowServer-report refusal (`recent_windowserver_diagnostic`, no longer an admission
    /// criterion) are eligible. A ColorSync incident, timeout or unknown reason keeps its latch.
    static func isRecoverableHostHealthFailure(_ failure: String,
                                              testingOverride: Bool = DisplayTestingPolicy.enabled()) -> Bool {
        if testingOverride, failure.hasPrefix("host health: ") { return true }
        if failure == "host health: host_health_unknown" || failure.hasPrefix("host health: host_health_unknown (") {
            return true
        }
        guard failure.hasPrefix("host health: ") else { return false }
        let reasons = failure.dropFirst("host health: ".count).split(separator: ",", omittingEmptySubsequences: false)
        return !reasons.isEmpty && reasons.allSatisfy {
            $0 == "memory_pressure" || $0 == "swap_activity" || $0 == "recent_windowserver_diagnostic"
        }
    }

    /// Steps whose filesystem calls can stall past a recovery deadline. Tests interpose here.
    enum HostHealthRecoveryStep: Sendable { case journal, commit, sync, abort }
    typealias HostHealthRecoveryInterposer = @Sendable (HostHealthRecoveryStep, () throws -> Void) throws -> Void
    static let directRecoveryStep: HostHealthRecoveryInterposer = { _, step in try step() }

    /// Explicit operator recovery only. The original file remains locked and in place; rolling
    /// creation budgets survive, and pending mutations or other failure classes cannot be reset.
    ///
    /// No write can be cancelled, so clearing never depends on one finishing in time. The journal
    /// first persists a blocking marker naming `token`; the latch clears only when a complete,
    /// pre-synced record is renamed exclusively to the token's decision path. A caller whose
    /// deadline expires claims that same path first (`abortHostHealthRecovery`), after which a
    /// late commit fails instead of overwriting the deadline failure.
    static func clearHostHealthLatch(
        path: String = defaultPath, token: String = UUID().uuidString,
        checkDeadline: @escaping () throws -> Void = {}, interpose: HostHealthRecoveryInterposer = directRecoveryStep,
        validateHost: () throws -> Void
    ) throws -> String {
        let lease = DisplayLifecycleLease(path: path)
        try lease.acquire(allowHostHealthRecovery: true)
        return try lease.lock.withLock {
            guard isRecoverableHostHealthLatch(lease.journal) else {
                throw lease.refused("only an eligible idle host-health latch can be cleared")
            }
            guard UUID(uuidString: token) != nil else { throw lease.refused("invalid recovery token") }
            // The journal lock excludes every live worker, so an earlier run's staged record can
            // only be left by a killed process. Removing it lets readers resolve that run as
            // blocked even if this run fails; its archive and any decision record stay as evidence.
            if let previous = lease.journal.recovery, UUID(uuidString: previous) != nil,
               lease.journal.failure == recoveryRetainedFailure(previous) {
                unlink(recoveryDecisionPath(path, previous) + ".staged")
            }
            try checkDeadline()
            try validateHost()
            try checkDeadline()
            let archive = path + ".host-health-" + UUID().uuidString + ".json"
            try lease.writeNewPrivateFile(archive, try JSONEncoder().encode(lease.journal),
                                          failure: "could not persist host-health latch archive; latch retained")
            let decision = recoveryDecisionPath(path, token)
            let staged = decision + ".staged"
            var stagedRemains = true
            defer { if stagedRemains { unlink(staged) } }
            try lease.writeNewPrivateFile(staged, Data(recoveryCommitRecord(token).utf8),
                                          failure: "could not stage host-health recovery; latch retained")
            try checkDeadline()
            // Blocked on disk; while the staged record exists, an unlocked reader reports this
            // recovery as undecided rather than guessing either outcome.
            lease.journal.failure = recoveryMarker(token)
            lease.journal.recovery = token
            try interpose(.journal) { try lease.save() }
            try checkDeadline()
            var committed = false
            do {
                try interpose(.commit) {
                    // Recheck after any delay entering this step, immediately before the
                    // uncancellable commit syscall. A started syscall still cannot be revoked.
                    try checkDeadline()
                    guard renamex_np(staged, decision, UInt32(RENAME_EXCL)) == 0 else {
                        throw lease.refused(errno == EEXIST ? "host-health recovery was aborted before it committed; latch retained"
                                            : "could not commit host-health recovery; latch retained")
                    }
                    stagedRemains = false
                    committed = true
                }
            } catch {
                guard committed else { throw error }
            }
            // Commit point. Nothing after the rename may throw: the latch is already cleared, and
            // an error here would make the caller report (or abort) a failure that did not happen.
            // A lost directory entry after a crash reads as uncommitted: blocked, never ready.
            try? interpose(.sync) {
                let directory = open(URL(fileURLWithPath: path).deletingLastPathComponent().path,
                                     O_RDONLY | O_DIRECTORY | O_CLOEXEC)
                if directory >= 0 { _ = fsync(directory); close(directory) }
            }
            return archive
        }
    }

    enum HostHealthRecoveryAbort: Sendable, Equatable { case aborted, committed, unconfirmed }

    /// Deadline path for a recovery whose worker may still be running. Exclusive creation of the
    /// decision path either wins, so the worker's exclusive rename can never commit, or finds the
    /// decision already recorded. The call itself can stall; callers must bound their wait.
    static func abortHostHealthRecovery(path: String = defaultPath, token: String,
                                        interpose: HostHealthRecoveryInterposer = directRecoveryStep) -> HostHealthRecoveryAbort {
        guard UUID(uuidString: token) != nil else { return .unconfirmed }
        var outcome = HostHealthRecoveryAbort.unconfirmed
        try? interpose(.abort) {
            let decision = recoveryDecisionPath(path, token)
            let fd = open(decision, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            if fd >= 0 { close(fd); outcome = .aborted }
            else if errno == EEXIST {
                // Only a complete commit record clears; any other entry already refuses. An entry
                // that cannot be inspected leaves the outcome unknown.
                switch inspectRecoveryDecision(path: path, token: token) {
                case .committed: outcome = .committed
                case .refused: outcome = .aborted
                case .absent, .unreadable: outcome = .unconfirmed
                }
            }
        }
        return outcome
    }

    private static func recoveryDecisionPath(_ path: String, _ token: String) -> String {
        path + ".recovery-" + token
    }
    private static func recoveryCommitRecord(_ token: String) -> String { "commit \(token)\n" }
    private static func recoveryMarker(_ token: String) -> String {
        "host health: recovery \(token) has not committed"
    }

    private static func recoveryRetainedFailure(_ token: String) -> String {
        "host health: host_health_unknown (recovery \(token) has not committed)"
    }

    private static func markedRecovery(_ journal: Journal) -> String? {
        guard let token = journal.recovery, UUID(uuidString: token) != nil,
              journal.failure == recoveryMarker(token) else { return nil }
        return token
    }

    /// `refused` is any entry other than a complete private commit record. Because the commit
    /// rename is exclusive, any entry at the decision path is final.
    private enum RecoveryDecision { case absent, committed, refused, unreadable }

    private static func inspectRecoveryDecision(path: String, token: String) -> RecoveryDecision {
        let expected = Array(recoveryCommitRecord(token).utf8)
        let fd = open(recoveryDecisionPath(path, token), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else {
            switch errno {
            case ENOENT: return .absent
            case ELOOP: return .refused // A symbolic link is never a commit record.
            default: return .unreadable
            }
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { return .unreadable }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0, info.st_size == off_t(expected.count) else { return .refused }
        var bytes = [UInt8](repeating: 0, count: expected.count)
        guard pread(fd, &bytes, bytes.count, 0) == expected.count else { return .unreadable }
        return bytes == expected ? .committed : .refused
    }

    /// A recovery marker is ready only with its commit record. An aborted, interrupted or late
    /// recovery keeps the original latch class, so only another explicit operator run can clear it.
    private static func resolveRecovery(_ journal: inout Journal, token: String, committed: Bool) {
        if committed, !journal.pending, journal.liveTestPending != true {
            journal.failure = nil
            journal.recovery = nil
        } else {
            journal.failure = recoveryRetainedFailure(token)
        }
    }

    private func writeNewPrivateFile(_ file: String, _ data: Data, failure: String) throws {
        let fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw refused(failure) }
        defer { close(fd) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        guard written == data.count, fsync(fd) == 0 else { throw refused(failure) }
    }

    private static func validDayHistory(_ journal: Journal) -> Bool {
        guard let day = journal.dayAttempts else { return true }
        return day.count <= maximumCreationsPerDay && day.allSatisfy { $0.isFinite && $0 >= 0 }
    }

    /// Persist admission before any case can fail, including cases that never create a Stage.
    /// This is separate from a display mutation so normal lifecycle operations can still run
    /// inside the admitted case. Another process must refuse an interrupted/failed case.
    func beginLiveTest() throws {
        try lock.withLock {
            guard descriptor >= 0 else { throw refused("lifecycle lease was not acquired") }
            try requireHealthy()
            guard !ownsLiveTest else { throw refused("a live test is already in progress") }
            journal.liveTestPending = true
            try save()
            ownsLiveTest = true
        }
    }

    func finishLiveTest() throws {
        try lock.withLock {
            try requireHealthy()
            guard ownsLiveTest else { throw refused("no live test was admitted") }
            journal.liveTestPending = nil
            try save()
            ownsLiveTest = false
        }
    }

    func finish() throws {
        try lock.withLock {
            guard journal.failure == nil else { throw refused("display safety circuit is open") }
            journal.pending = false
            try save()
        }
    }

    func trip(_ reason: String) {
        lock.withLock {
            journal.failure = String(reason.prefix(512))
            updateStatus()
            // pending was persisted BEFORE mutation, so even an unsuccessful failure write
            // still refuses a new process. Never clear it on a timeout or unknown teardown.
            if descriptor >= 0 { try? save() }
        }
    }

    private func requireHealthy() throws {
        guard journal.failure == nil, !journal.pending,
              journal.liveTestPending != true || ownsLiveTest else {
            throw refused("an earlier display mutation failed or never completed; "
                + "inspect docs/DISPLAY_SAFETY.md before recovery")
        }
    }

    private func save() throws {
        statusLock.withLock {
            observedStatus = .init(state: .blocked, reason: "display lifecycle state is being persisted")
        }
        let data = try JSONEncoder().encode(journal)
        let written = data.withUnsafeBytes { pwrite(descriptor, $0.baseAddress, $0.count, 0) }
        guard written == data.count, ftruncate(descriptor, off_t(data.count)) == 0,
              fsync(descriptor) == 0 else {
            journal.failure = "could not persist lifecycle state"
            updateStatus()
            throw refused("could not persist lifecycle state")
        }
        updateStatus()
    }

    private func refused(_ detail: String) -> SpaceOError {
        .stageCreationFailed(detail)
    }
}
