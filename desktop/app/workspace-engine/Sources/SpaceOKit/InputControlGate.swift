import Foundation
import CoreGraphics

/// Decides whether a queued input event is still allowed to be delivered.
///
/// The viewer validates input when it *enqueues* an event on the main thread, then delivers it
/// later on a background queue. Everything can change in between: the user can switch Control
/// off, or select a different display. Delivery re-checked neither, so a click could execute
/// after Control was disabled, or land on the display that was selected a moment ago. Because
/// the cleanup that disables routing is itself queued, it also waited behind exactly the stale
/// events it was meant to cancel.
///
/// A monotonic epoch fixes both. Every admitted event carries the epoch it was admitted under;
/// disabling or switching displays bumps the epoch *synchronously*, so queued work is invalid
/// before the cleanup block is even scheduled and drains as no-ops.
///
/// Lives in SpaceOKit rather than the viewer so it can be tested without a UI: the viewer is an
/// executable target, and a rule this load-bearing should not be exercised only by hand.
public final class InputControlGate {

    /// Permission to deliver one event, stamped with the state it was granted under.
    public struct Ticket: Equatable, Sendable {
        public let epoch: UInt64
        public let displayID: CGDirectDisplayID
    }

    private let lock = NSLock()
    private var epoch: UInt64 = 0
    private var enabled = false
    private var displayID: CGDirectDisplayID?

    public init() {}

    public var currentEpoch: UInt64 { lock.withLock { epoch } }
    public var isEnabled: Bool { lock.withLock { enabled } }
    public var currentDisplayID: CGDirectDisplayID? { lock.withLock { displayID } }

    /// Turn control on for a display. Always bumps the epoch, including when re-enabling the
    /// same display: events admitted before the gap must not survive it.
    public func enable(displayID: CGDirectDisplayID) {
        lock.withLock {
            epoch &+= 1
            enabled = true
            self.displayID = displayID
        }
    }

    @discardableResult
    public func disable() -> UInt64 {
        lock.withLock {
            epoch &+= 1
            enabled = false
            displayID = nil
            return epoch
        }
    }

    /// Point control at a different display. Separate from `enable` so a switch while disabled
    /// stays disabled — selecting a display is not consent to drive it.
    public func select(displayID: CGDirectDisplayID?) {
        lock.withLock {
            epoch &+= 1
            self.displayID = displayID
            if displayID == nil { enabled = false }
        }
    }

    /// Admit one event, or refuse when control is off or no display is selected.
    ///
    /// Called on the main thread as the event arrives; the returned ticket travels with it.
    public func admit() -> Ticket? {
        lock.withLock {
            guard enabled, let displayID else { return nil }
            return Ticket(epoch: epoch, displayID: displayID)
        }
    }

    /// Is this ticket still good? Checked at the delivery boundary, after the queue hop.
    ///
    /// The epoch comparison is the whole point: a ticket from before a disable or a display
    /// switch is stale even though its display id may still match.
    public func isCurrent(_ ticket: Ticket) -> Bool {
        lock.withLock {
            enabled && ticket.epoch == epoch && ticket.displayID == displayID
        }
    }
}
