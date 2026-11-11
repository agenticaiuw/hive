import Foundation

/// Confirming that a keystroke actually landed in a VS Code-family renderer.
///
/// Typing and key delivery reach these renderers through the ordinary per-PID path, which
/// returns without telling anyone whether the editor received anything. Reporting that as plain
/// success is the silent-success failure this project treats as worse than a refusal: the agent
/// believes it typed, and every later step reasons from a document state that never existed.
///
/// The semantic adapter already exposes an observable. `TextDocument.version` increments on every
/// edit, and the selection moves for keys that navigate rather than insert, so the pair covers
/// both kinds of keystroke.
enum ElectronEffectConfirmation {
    /// How long to wait for the extension host to publish a change. The adapter's own settle
    /// budget is the same, and a keystroke that has not surfaced within a second has not landed.
    static let settleBudget = 40
    static let settleInterval: UInt64 = 25_000_000

    /// State of the focused pane before delivery, or nil when no semantic channel is available.
    ///
    /// A nil here deliberately keeps the caller's behaviour unchanged: an unreachable adapter
    /// must not turn every keystroke into a warning, which would train readers to ignore them.
    static func before(_ bridge: ElectronEditorBridge?) async -> ElectronEditorBridge.EditorState? {
        guard let bridge else { return nil }
        return try? await bridge.state()
    }

    static func confirm(
        _ bridge: ElectronEditorBridge?,
        before: ElectronEditorBridge.EditorState?,
        action: String
    ) async -> String? {
        guard let bridge, let before else { return nil }
        for attempt in 0..<settleBudget {
            if attempt > 0 { try? await Task.sleep(nanoseconds: settleInterval) }
            guard let after = try? await bridge.state() else {
                return "the \(action) was posted, but the editor's semantic channel stopped "
                    + "answering, so SpaceO cannot confirm the keystroke landed. Verify with a "
                    + "screenshot or read_screen."
            }
            if changed(from: before, to: after) { return nil }
        }
        return "the \(action) was posted as synthetic per-PID events, but the editor reports the "
            + "same document version and selection as before, so it did not land. This renderer "
            + "ignores background synthetic keys; focus the editor's own UI first, or address the "
            + "control by element index from read_screen."
    }

    /// An edit bumps the document version; a navigation key moves the selection instead. Either
    /// one proves the keystroke arrived.
    static func changed(
        from before: ElectronEditorBridge.EditorState,
        to after: ElectronEditorBridge.EditorState
    ) -> Bool {
        after.version != before.version || after.selections != before.selections
    }
}
