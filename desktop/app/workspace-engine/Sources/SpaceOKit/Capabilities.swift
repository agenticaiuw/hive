import Foundation
import ApplicationServices
import CoreGraphics
import SpaceOPrivate

/// Runtime gate over everything private SpaceO depends on, plus the two TCC grants.
///
/// This is the "Apple changed something" chokepoint for runtime availability. The unsafe private
/// focus getters are deliberately absent from the inventory; mutation behavior is verified by
/// the higher-level display lifecycle and public AppKit route checks.
public struct Capabilities: Sendable {

    public struct Item: Sendable, Equatable {
        public let name: String
        public let available: Bool
        public let detail: String
        public let unavailableReason: String?
    }

    public let items: [Item]
    public let missingSymbols: [String]

    public init() {
        var found: [Item] = []

        let privateCaps: [(SPOCapability, String)] = [
            (.virtualDisplay,     "CGVirtualDisplay classes"),
            (.focusWithoutRaise,  "removed incompatible private focus-record path"),
            (.spaceQuery,         "SkyLight space graph and window geometry calls"),
            (.perPIDEvents,       "per-process events (CGEventPostToPid)"),
            (.axWindowID,         "AX element -> window id (_AXUIElementGetWindow)"),
        ]
        for (cap, detail) in privateCaps {
            let available = SPOCapabilityAvailable(cap)
            found.append(Item(name: SPOCapabilityName(cap),
                              available: available,
                              detail: detail,
                              unavailableReason: available
                                  ? nil
                                  : SPOCapabilityUnavailableReason(cap)))
        }

        found.append(Item(name: "accessibility",
                          available: AXIsProcessTrusted(),
                          detail: "required for window placement and AX-driven input",
                          unavailableReason: nil))
        found.append(Item(name: "screen-recording",
                          available: CGPreflightScreenCaptureAccess(),
                          detail: "required for capture only",
                          unavailableReason: nil))

        self.items = found
        self.missingSymbols = SPOMissingSymbols()
    }

    /// True when SpaceO can create and drive a session (capture excluded).
    ///
    /// Private focus priming is optional: `InputRouter.prepareForInput` can use direct per-PID
    /// delivery when the focus-record API is unavailable.
    public var canDrive: Bool {
        builtWithARC
            && required.allSatisfy { name in
                items.first { $0.name == name }?.available == true
            }
    }

    public var canCapture: Bool {
        items.first { $0.name == "virtual-display" }?.available == true
            && items.first { $0.name == "screen-recording" }?.available == true
    }

    private var required: [String] {
        ["virtual-display", "space-query", "per-pid-events", "ax-window-id", "accessibility"]
    }

    /// Whether the private-API shim was built with ARC. If this is ever false, virtual
    /// display teardown leaks a phantom monitor, so it belongs in the report rather than
    /// in a comment.
    public var builtWithARC: Bool { SPOBuiltWithARC() }

    /// Human-readable report used by `spaceo doctor`.
    public var report: String {
        var lines: [String] = []
        for item in items {
            lines.append("  \(item.available ? "ok  " : "MISS") \(item.name.padding(toLength: 22, withPad: " ", startingAt: 0)) \(item.detail)")
            if let reason = item.unavailableReason {
                lines.append("       \(reason)")
            }
        }
        if !missingSymbols.isEmpty {
            lines.append("")
            lines.append("  unresolved symbols: \(missingSymbols.joined(separator: ", "))")
        }
        lines.append("")
        lines.append("  can drive sessions : \(canDrive ? "yes" : "no")")
        lines.append("  can capture        : \(canCapture ? "yes" : "no")")
        lines.append("  shim built with ARC: \(builtWithARC ? "yes" : "NO — display teardown would leak")")
        return lines.joined(separator: "\n")
    }
}
