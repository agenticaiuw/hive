// Offline policy prototype only. It is not connected to the workspace engine or macOS APIs.
// The caller must independently establish the provenance of every observation.
import Foundation

struct ScopeProcess: Equatable {
    let pid: Int
    let start: UInt64
}
struct ScopeWindow: Equatable {
    let id: UInt32
    let incarnation: String // A synthetic stable identity, not an established macOS capability.
    let process: ScopeProcess
    let creationReceipt: String?
}
struct ScopeSnapshot {
    let process: ScopeProcess
    let complete: Bool
    let windows: [ScopeWindow]
}
struct ScopedWindow {
    let process: ScopeProcess
    let window: ScopeWindow
}

enum WindowScopePolicy {
    private static func valid(_ s: ScopeSnapshot) -> Bool {
        s.complete && s.process.pid > 0 && s.process.start > 0 &&
        s.windows.allSatisfy { $0.id != 0 && !$0.incarnation.isEmpty && $0.process == s.process } &&
        Set(s.windows.map(\.id)).count == s.windows.count
    }

    // A receipt is an injected assertion, not itself evidence of creation on macOS.
    static func select(before: ScopeSnapshot, after: ScopeSnapshot,
                       requestedID: UInt32, receipt: String) -> ScopedWindow? {
        guard valid(before), valid(after), before.process == after.process,
              !receipt.isEmpty else { return nil }
        let old = Dictionary(uniqueKeysWithValues: before.windows.map { ($0.id, $0) })
        let now = Dictionary(uniqueKeysWithValues: after.windows.map { ($0.id, $0) })
        guard old.allSatisfy({ now[$0.key] == $0.value }) else { return nil }
        let added = after.windows.filter { old[$0.id] == nil }
        guard added.count == 1, let target = added.first,
              target.id == requestedID, target.creationReceipt == receipt else { return nil }
        return ScopedWindow(process: after.process, window: target)
    }

    // Caller-supplied isolation and focus observations are intentionally required,
    // including for a single owned window in a process with other windows.
    static func permits(_ scope: ScopedWindow, snapshot: ScopeSnapshot,
                        isolationProven: Bool, forInput: Bool,
                        focusedWindowID: UInt32?) -> Bool {
        guard isolationProven, valid(snapshot), snapshot.process == scope.process,
              snapshot.windows.filter({ $0.id == scope.window.id }).first == scope.window
        else { return false }
        return !forInput || focusedWindowID == scope.window.id
    }
}
