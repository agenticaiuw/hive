import Foundation

/// Local operator recovery for an idle unknown-health, pressure, swap or older WindowServer-report
/// latch. This never resets a pending display mutation, a system incident, or a journal locked by a
/// display owner.
public enum DisplaySafetyRecovery {
    private static let worker = DisplayLifecycleCoordinator()
    /// One abort at a time: a stalled abort cannot grow a thread pool; later aborts report unknown.
    private static let abortQueue = DispatchQueue(label: "spaceo.display-safety-recovery-abort")

    public static func clearHostHealthLatch() throws -> String {
        let validatedHealth = Locked<DisplayHostHealth?>(nil)
        return try clearHostHealthLatch(path: nil, worker: worker, timeout: 20,
                                       validateStillHealthy: {
            try validatedHealth.value?.requireStillSettledForReconfiguration()
        }) { operation in
            let original = try Stage.checkedOnlineDisplayIDs()
            guard !original.contains(where: Stage.isSpaceODisplay) else {
                throw SpaceOError.stageCreationFailed("SpaceO displays remain online; host-health recovery refused")
            }
            let health = DisplayHostHealth()
            try health.requireSettledForReconfiguration(timeout: 15)
            validatedHealth.value = health
            let final = try Stage.checkedOnlineDisplayIDs()
            guard Set(original) == Set(final), !final.contains(where: Stage.isSpaceODisplay),
                  health.isSettledForReconfiguration else {
                throw SpaceOError.stageCreationFailed("display topology or host health changed during recovery")
            }
            try operation.check()
        }
    }

    private enum Progress { case queued, running, failed, committed(String) }
    private final class Locked<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Value
        init(_ value: Value) { stored = value }
        var value: Value {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }

    /// The caller never reports a deadline failure while the worker could still commit: it first
    /// claims the recovery's decision path, which a late commit cannot then overwrite. When that
    /// claim itself does not finish within `abortTimeout`, the outcome is reported as unknown.
    static func clearHostHealthLatch(
        path: String?, worker: DisplayLifecycleCoordinator, timeout: TimeInterval, abortTimeout: TimeInterval = 2,
        interpose: @escaping DisplayLifecycleLease.HostHealthRecoveryInterposer = DisplayLifecycleLease.directRecoveryStep,
        validateStillHealthy: @escaping @Sendable () throws -> Void = {},
        validateHost: @escaping @Sendable (DisplayLifecycleCoordinator.Operation) throws -> Void
    ) throws -> String {
        let token = UUID().uuidString
        let progress = Locked(Progress.queued)
        do {
            return try worker.perform(timeout: timeout, onlyWhenIdle: true) { operation in
                progress.value = .running
                do {
                    let archive = try DisplayLifecycleLease.clearHostHealthLatch(
                        path: path ?? DisplayLifecycleLease.defaultPath, token: token,
                        checkDeadline: {
                            try operation.check()
                            try validateStillHealthy()
                        }, interpose: interpose) { try validateHost(operation) }
                    progress.value = .committed(archive)
                    return archive
                } catch {
                    progress.value = .failed
                    throw error
                }
            }
        } catch {
            switch progress.value {
            // A queued body never starts after a refusal or a tripped deadline; a failed body
            // returned before its commit point.
            case .queued, .failed: throw error
            case .committed(let archive):
                throw SpaceOError.stageCreationFailed("host-health recovery committed after its caller deadline; "
                    + "the latch is cleared (archive: \(archive)); run `spaceo doctor` before display work")
            case .running: break
            }
            let claimed = DispatchSemaphore(value: 0)
            let outcome = Locked(DisplayLifecycleLease.HostHealthRecoveryAbort.unconfirmed)
            abortQueue.async {
                outcome.value = DisplayLifecycleLease.abortHostHealthRecovery(
                    path: path ?? DisplayLifecycleLease.defaultPath, token: token, interpose: interpose)
                claimed.signal()
            }
            let seconds = abortTimeout.isFinite ? min(max(abortTimeout, 0.1), 5) : 2
            switch claimed.wait(timeout: .now() + seconds) == .success ? outcome.value : .unconfirmed {
            case .aborted:
                throw SpaceOError.stageCreationFailed("host-health recovery exceeded its deadline and was aborted; "
                    + "the latch is retained (recovery \(token))")
            case .committed:
                throw SpaceOError.stageCreationFailed("host-health recovery committed before its deadline abort; "
                    + "the latch is cleared; run `spaceo doctor` before display work")
            case .unconfirmed:
                // The worker may still be inside an uncancellable filesystem call, so neither a
                // blocked nor a cleared latch can be claimed; only a later read is authoritative.
                throw SpaceOError.stageCreationFailed("host-health recovery exceeded its deadline and its abort was "
                    + "not confirmed; the outcome of recovery \(token) is unknown and a stalled step may still commit. "
                    + "Run `spaceo doctor` after this safety process has fully exited; only that result is final")
            }
        }
    }
}
