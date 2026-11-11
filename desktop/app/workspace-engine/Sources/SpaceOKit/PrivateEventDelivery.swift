import CoreGraphics
import SpaceOPrivate

/// The only SpaceOKit path to the per-process event symbol.
///
/// The Objective-C shim checks symbol availability again at the call boundary so every caller
/// gets the same runtime error if the current macOS build does not expose per-process delivery.
func postEventToPID(_ event: CGEvent, pid: pid_t) throws {
    guard SPOPostEventToPID(pid, event) else {
        let name = SPOCapabilityName(.perPIDEvents)
        let reason = SPOCapabilityUnavailableReason(.perPIDEvents)
        throw SpaceOError.unavailable(
            capability: reason.map { "\(name): \($0)" } ?? name
        )
    }
}
