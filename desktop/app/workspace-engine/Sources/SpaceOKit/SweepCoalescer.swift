import Foundation

/// Serialises sweeps without dropping the notifications that arrive during one.
///
/// The failure this replaces: the janitor took a `try()` lock and returned immediately when it
/// was already held. An `AXWindowCreated` notification that landed while a sweep was in flight
/// was therefore thrown away — and because a sweep enumerates the windows it can see *at the
/// moment it starts*, a window created a millisecond later is in neither the running sweep nor
/// any future one. The dialog stays on the user's display until something else happens to
/// trigger a sweep, which may be never.
///
/// Coalescing, not queueing, is the right shape: a sweep is a full reconciliation, so ten
/// notifications during one sweep need exactly one more sweep, not ten.
public final class SweepCoalescer {

    private let lock = NSLock()
    private var running = false
    private var pending = false

    public init() {}

    /// True when the caller became the sweeper. False means a sweep is already running and this
    /// request has been recorded for it to pick up.
    public func beginOrCoalesce() -> Bool {
        lock.withLock {
            guard !running else {
                pending = true
                return false
            }
            running = true
            pending = false
            return true
        }
    }

    /// Finish a sweep. True means work arrived while it ran and the caller must sweep again.
    ///
    /// Ownership stays with the caller across a repeat so a third notification cannot start a
    /// concurrent sweep in the gap.
    public func endOrRepeat() -> Bool {
        lock.withLock {
            guard pending else {
                running = false
                return false
            }
            pending = false
            return true
        }
    }

    /// Whether a sweep is in flight. Diagnostics only.
    public var isSweeping: Bool { lock.withLock { running } }

    /// Abandon ownership without honouring a pending request — for shutdown, where the next
    /// sweep will never come and pretending otherwise would deadlock a caller's repeat loop.
    public func cancel() {
        lock.withLock {
            running = false
            pending = false
        }
    }
}
