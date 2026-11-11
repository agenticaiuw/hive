import Foundation

/// A single pending value, shared between a producer and a scheduled consumer. Frames replace
/// one another while the main actor is busy instead of retaining an unbounded queue of surfaces.
/// Give each stream generation its own mailbox so an old producer cannot replace a new frame.
final class ViewerLatestValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: Value?

    /// True only when the caller must schedule a delivery. Further offers replace its payload.
    func offer(_ value: Value) -> Bool {
        lock.withLock {
            let needsDelivery = pending == nil
            pending = value
            return needsDelivery
        }
    }

    /// Atomically re-arms scheduling before delivery so a concurrent offer cannot be lost.
    func take() -> Value? {
        lock.withLock {
            defer { pending = nil }
            return pending
        }
    }
}
