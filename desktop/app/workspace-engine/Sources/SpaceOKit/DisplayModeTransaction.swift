import Foundation

/// Offline-testable transaction boundary. No live display adapter is supplied: private API
/// selection, confirmation, topology safety and rollback have not been established.
struct DisplayModeSize: Equatable {
    let width: Int
    let height: Int
}

protocol DisplayModeTransactionBacking: AnyObject {
    var identity: UInt32 { get }
    var descriptorLimit: DisplayModeSize { get }
    func currentMode() -> DisplayModeSize?
    func applyMode(_ mode: DisplayModeSize) -> Bool
}

enum DisplayModeTransactionResult: Equatable {
    case invalid, unavailable, changed, rolledBack, rollbackFailed, identityChanged
}

enum DisplayModeTransaction {
    /// Largest integral exact-aspect mode that fits both descriptor dimensions.
    static func matchingMode(view: DisplayModeSize, limit: DisplayModeSize) -> DisplayModeSize? {
        guard view.width > 0, view.height > 0, limit.width > 0, limit.height > 0 else { return nil }
        func gcd(_ a: Int, _ b: Int) -> Int { var (x, y) = (a, b); while y != 0 { (x, y) = (y, x % y) }; return x }
        let divisor = gcd(view.width, view.height)
        let w = view.width / divisor, h = view.height / divisor
        let scale = min(limit.width / w, limit.height / h)
        guard scale > 0 else { return nil }
        return DisplayModeSize(width: w * scale, height: h * scale)
    }

    static func change(_ backing: DisplayModeTransactionBacking, view: DisplayModeSize) -> DisplayModeTransactionResult {
        let id = backing.identity
        guard id != 0 else { return .unavailable }
        guard let target = matchingMode(view: view, limit: backing.descriptorLimit) else { return .invalid }
        guard let old = backing.currentMode(), old.width > 0, old.height > 0 else { return .unavailable }
        guard backing.identity == id else { return .identityChanged }
        if old == target { return .changed }
        let accepted = backing.applyMode(target)
        guard backing.identity == id else { return .identityChanged }
        if accepted && backing.currentMode() == target && backing.identity == id { return .changed }
        guard backing.identity == id else { return .identityChanged }
        let restored = backing.applyMode(old)
        guard backing.identity == id else { return .identityChanged }
        guard restored && backing.currentMode() == old && backing.identity == id else { return .rollbackFailed }
        return .rolledBack
    }
}
