import Foundation

/// The applications and Spaces that belong to agents.
///
/// Needed because an isolation check that only diffs before/after state cannot tell
/// "the agent grabbed the pointer" from "the user moved their mouse while the command ran".
/// Attributing the latter to SpaceO produces false alarms, and an alarm that cries wolf is
/// worse than no alarm.
public enum AgentActivity {

    /// The single instance is immutable global state; every mutable field inside it is accessed
    /// under `lock`. The unchecked conformance describes that lock invariant, rather than
    /// declaring each mutable static independently concurrency-safe.
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var agentPIDs: Set<pid_t> = []
        var agentSpaces: Set<UInt64> = []
    }

    private static let state = State()

    // MARK: - What belongs to an agent
    //
    // "The frontmost app changed" is only SpaceO's fault if it changed *to one of the agent's
    // apps*. A user switching between their own windows while a command runs is not a breach,
    // and reporting it as one is how a safety check turns into noise everyone learns to ignore.

    public static var ownedPIDs: Set<pid_t> {
        state.lock.withLock { state.agentPIDs }
    }
    public static var ownedSpaces: Set<UInt64> {
        state.lock.withLock { state.agentSpaces }
    }

    public static func claim(pid: pid_t) {
        state.lock.withLock { _ = state.agentPIDs.insert(pid) }
    }
    public static func release(pid: pid_t) {
        state.lock.withLock { _ = state.agentPIDs.remove(pid) }
    }
    public static func claim(spaces: [UInt64]) {
        state.lock.withLock { state.agentSpaces.formUnion(spaces) }
    }
    public static func release(spaces: [UInt64]) {
        state.lock.withLock { state.agentSpaces.subtract(spaces) }
    }

    /// Test seam.
    static func reset() {
        state.lock.withLock {
            state.agentPIDs = []
            state.agentSpaces = []
        }
    }
}
