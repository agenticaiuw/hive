import Foundation
import AppKit
import Darwin

/// A process identity that survives PID reuse.
///
/// A bare `pid_t` is a recycled integer. Storing one as "the app this session owns" means that
/// after the app exits and the kernel hands its number to something unrelated, the session still
/// believes it may capture, drive, and force-terminate that process. Pairing the number with the
/// kernel's start timestamp makes the identity unique for as long as it matters: two processes
/// can share a PID, but not a PID *and* a start time.
public struct ProcessIdentity: Codable, Hashable, Sendable, CustomStringConvertible {

    public let pid: pid_t
    /// Kernel start time, microseconds since the epoch. Zero only when the platform refused to
    /// report one — see `isPrecise`.
    public let startedAtMicroseconds: UInt64

    public init(pid: pid_t, startedAtMicroseconds: UInt64) {
        self.pid = pid
        self.startedAtMicroseconds = startedAtMicroseconds
    }

    /// False when the identity is a bare PID because no start time could be read. Callers that
    /// are about to do something irreversible (force-terminate) must refuse on an imprecise
    /// identity rather than act on a number that may since have been recycled.
    public var isPrecise: Bool { startedAtMicroseconds > 0 }

    public var description: String {
        isPrecise ? "pid \(pid)@\(startedAtMicroseconds)" : "pid \(pid) (start time unavailable)"
    }

    public static func current(of pid: pid_t) -> ProcessIdentity? {
        guard pid > 0 else { return nil }
        if let micros = kernelStartTimeMicroseconds(of: pid) {
            return ProcessIdentity(pid: pid, startedAtMicroseconds: micros)
        }
        // The kernel refused (it does for processes outside our credentials). Fall back to
        // AppKit's launch date, which is coarser but still discriminates a recycled PID, and
        // finally to an imprecise identity so ownership bookkeeping still functions.
        guard let running = NSRunningApplication(processIdentifier: pid) else { return nil }
        if let launched = running.launchDate {
            return ProcessIdentity(
                pid: pid,
                startedAtMicroseconds: UInt64(max(0, launched.timeIntervalSince1970 * 1_000_000)))
        }
        return ProcessIdentity(pid: pid, startedAtMicroseconds: 0)
    }

    /// True when the process behind this identity is still the one we recorded.
    ///
    /// The check that stops a stale session from driving — or killing — a stranger that inherited
    /// its PID.
    public var isAlive: Bool {
        guard let now = Self.current(of: pid) else { return false }
        guard isPrecise, now.isPrecise else {
            // Without a trustworthy timestamp on either side, liveness degrades to "a process
            // with this number exists". Say so honestly rather than implying more.
            return true
        }
        return now.startedAtMicroseconds == startedAtMicroseconds
    }

    static func kernelStartTimeMicroseconds(of pid: pid_t) -> UInt64? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        let seconds = UInt64(info.pbi_start_tvsec)
        let micros = UInt64(info.pbi_start_tvusec)
        guard seconds > 0 else { return nil }
        return seconds &* 1_000_000 &+ micros
    }
}

/// Which session owns which process.
///
/// Two sessions adopting the same PID used to be silently allowed, and destroying either one
/// would tear down input routing, capture, and termination authority the other still believed it
/// held. Ownership is exclusive and claimed *before* anything is mutated, so a duplicate adoption
/// fails without having moved a window.
public enum ProcessOwnership {

    /// The dictionary never escapes this holder and every access is serialized by `lock`.
    /// Keeping one immutable holder makes the synchronization boundary visible to Swift 6.
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var owners: [ProcessIdentity: String] = [:]
    }

    private static let state = State()

    /// - Throws: `SpaceOError.badRequest` when another session already owns the process.
    public static func claim(_ identity: ProcessIdentity, owner: String) throws {
        try state.lock.withLock {
            pruneLocked()
            // A different identity with the same PID is a dead process whose number was reused;
            // it holds no claim on the live one.
            if let existing = state.owners[identity] {
                guard existing == owner else {
                    throw SpaceOError.badRequest(
                        "process \(identity.pid) is already owned by session '\(existing)'; "
                        + "adopt it there, or destroy that session first")
                }
                return
            }
            state.owners[identity] = owner
        }
    }

    public static func release(_ identity: ProcessIdentity) {
        state.lock.withLock { _ = state.owners.removeValue(forKey: identity) }
    }

    /// Drop every claim held by one session. Used on teardown so a failed or partial destroy
    /// cannot strand ownership and lock the process out of every future session.
    public static func releaseAll(owner: String) {
        state.lock.withLock {
            state.owners = state.owners.filter { $0.value != owner }
        }
    }

    public static func owner(of identity: ProcessIdentity) -> String? {
        state.lock.withLock {
            pruneLocked()
            return state.owners[identity]
        }
    }

    /// Forget claims whose process has exited. Without this, a long-lived daemon accumulates
    /// dead identities and eventually refuses adoption of a recycled PID for no reason.
    private static func pruneLocked() {
        state.owners = state.owners.filter { $0.key.isAlive }
    }

    /// Test seam.
    static func reset() {
        state.lock.withLock { state.owners.removeAll() }
    }
}
