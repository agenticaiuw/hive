import Foundation

@main struct WindowScopePolicyTests {
    static func main() {
        let p = ScopeProcess(pid: 42, start: 100)
        let sibling = ScopeWindow(id: 1, incarnation: "old", process: p, creationReceipt: nil)
        let target = ScopeWindow(id: 2, incarnation: "new", process: p, creationReceipt: "operation")
        func snap(_ ws: [ScopeWindow], _ complete: Bool = true, _ process: ScopeProcess? = nil) -> ScopeSnapshot {
            ScopeSnapshot(process: process ?? p, complete: complete, windows: ws)
        }
        let before = snap([sibling]), after = snap([sibling, target])
        func select(_ a: ScopeSnapshot, _ b: ScopeSnapshot, _ id: UInt32 = 2, _ receipt: String = "operation") -> ScopedWindow? {
            WindowScopePolicy.select(before: a, after: b, requestedID: id, receipt: receipt)
        }
        guard let scope = select(before, after) else { fatalError("expected selection") }
        var moves: [UInt32] = [], inputs: [UInt32] = []
        func act(_ snapshot: ScopeSnapshot, _ isolated: Bool, _ input: Bool, _ focus: UInt32?) {
            if WindowScopePolicy.permits(scope, snapshot: snapshot, isolationProven: isolated, forInput: input, focusedWindowID: focus) {
                if input { inputs.append(scope.window.id) } else { moves.append(scope.window.id) }
            }
        }
        act(after, false, false, nil); act(after, true, true, nil); act(after, true, true, 1)
        assert(moves.isEmpty && inputs.isEmpty, "unverified operations must not fire")
        act(after, true, false, nil); act(after, true, true, 2)
        assert(moves == [2] && inputs == [2], "sibling must never be targeted")
        let replacement = ScopeWindow(id: 2, incarnation: "reused", process: p, creationReceipt: "operation")
        act(snap([sibling, replacement]), true, false, nil)
        act(snap([sibling, target], false), true, true, 2)
        assert(moves == [2] && inputs == [2], "stale or incomplete snapshots must fail")
        assert(select(snap([sibling], false), after) == nil)
        assert(select(before, snap([sibling, target], false)) == nil)
        assert(select(before, after, 1) == nil)
        assert(select(before, after, 2, "") == nil)
        assert(select(before, after, 2, "different") == nil)
        assert(select(before, snap([sibling, target, target])) == nil)
        let extra = ScopeWindow(id: 3, incarnation: "extra", process: p, creationReceipt: nil)
        assert(select(before, snap([sibling, target, extra])) == nil)
        assert(select(before, snap([target])) == nil)
        let recycledSibling = ScopeWindow(id: 1, incarnation: "recycled", process: p, creationReceipt: nil)
        assert(select(before, snap([recycledSibling, target])) == nil)
        let newProcess = ScopeProcess(pid: 42, start: 101)
        assert(select(before, snap([], true, newProcess)) == nil)
        let foreign = ScopeWindow(id: 2, incarnation: "new", process: newProcess, creationReceipt: "operation")
        assert(select(before, snap([sibling, foreign])) == nil)
        let imprecise = ScopeProcess(pid: 42, start: 0)
        assert(select(snap([], true, imprecise), snap([], true, imprecise)) == nil)
        print("Window scope policy: synthetic selection, stale identity, sibling isolation and focus checks passed")
    }
}
