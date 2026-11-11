import Foundation
import ApplicationServices

/// Session-local binding between an indexed accessibility walk and the exact live window state
/// that produced it.
///
/// An element index is not a durable identifier. It is valid only for one process identity, one
/// window, and one session generation. A mismatch is always refused rather than silently taking
/// a fresh walk where the same integer could name a different control.
struct AXSnapshotCache {
    private(set) var generation = UUID()
    private(set) var snapshot: AXSnapshot?

    mutating func store(_ snapshot: AXSnapshot) throws {
        guard snapshot.generation == generation else {
            throw SpaceOError.badRequest(
                "accessibility snapshot completed for a stale window generation; "
                + "read the screen again")
        }
        self.snapshot = snapshot
    }

    mutating func invalidate() {
        generation = UUID()
        snapshot = nil
    }

    func element(
        at index: Int,
        for window: WindowRef,
        processIdentity: ProcessIdentity
    ) throws -> AXUIElement {
        guard let snapshot else {
            throw staleReferenceError(
                "there is no current accessibility snapshot for window \(window.windowID)")
        }
        guard snapshot.generation == generation else {
            throw staleReferenceError("the accessibility snapshot generation has expired")
        }
        guard snapshot.windowID == window.windowID else {
            throw staleReferenceError(
                "element [\(index)] belongs to window \(snapshot.windowID), "
                    + "not requested window \(window.windowID)")
        }
        guard snapshot.pid == window.pid,
              snapshot.processIdentity == processIdentity else {
            throw staleReferenceError(
                "the process behind window \(window.windowID) has changed")
        }
        guard processIdentity.isAlive else {
            throw staleReferenceError(
                "the process behind window \(window.windowID) is no longer alive")
        }
        guard let element = snapshot.element(at: index) else {
            // Recoverable, not a malformed call: name the valid range so the agent can correct a
            // misread index without another round trip, and point at a re-read otherwise.
            let range = snapshot.actionableCount > 0 ? "0–\(snapshot.actionableCount - 1)" : "none"
            throw SpaceOError.staleSnapshot(
                "no element [\(index)] in the current snapshot (valid indices: \(range)); "
                    + "use an index from the latest read, or read the screen again")
        }
        return element
    }

    private func staleReferenceError(_ reason: String) -> SpaceOError {
        .staleSnapshot("\(reason); refusing the stale index — read the screen again")
    }
}
