import SpaceOKit
import SwiftUI

/// The Session menu: everything a person does to one session, reachable from the keyboard.
///
/// Shortcuts avoid the Viewer's existing ones (⌘⇧N New Session, ⌘⇧C Copy from Session,
/// ⌘0/⌘1/⌘+/⌘- zoom, ⌘⌥I Inspector, ⌘⌥M Mini Monitor). None of them reaches the menu while
/// Control is on: the captured surface forwards every chord to the remote app except the local
/// exit, which is why Release keeps Control-Command-Escape.
///
/// Navigation order comes from `ViewerSessionNavigation`, so ⌘] and ⌃1–⌃9 follow the sidebar.
struct ViewerSessionCommands: View {
    let model: ViewerModel

    var body: some View {
        Button(model.interactionEnabled ? "Release Control" : "Take Control") {
            if model.interactionEnabled {
                model.endHumanControl()
            } else if let id = model.selectedSessionID, model.canvasMode == .session {
                model.takeControl(for: id)
            } else {
                model.beginHumanControl()
            }
        }
        .keyboardShortcut(
            model.interactionEnabled ? .escape : KeyEquivalent("i"),
            modifiers: model.interactionEnabled ? [.command, .control] : [.command, .shift]
        )
        .disabled(
            !(model.controlTargetAvailable && model.streamRunning)
                && !model.interactionEnabled
        )

        Button(model.selectedSessionInputPaused ? "Resume Agent" : "Pause Agent") {
            model.toggleSelectedAgentPause()
        }
        .keyboardShortcut("p", modifiers: [.command, .shift])
        .disabled(model.selectedSession == nil || !model.canChangeAgentPause)

        Divider()

        Button("Next Session") { model.selectAdjacentSession(1) }
            .keyboardShortcut("]", modifiers: .command)
            .disabled(model.navigationOrder.isEmpty)
        Button("Previous Session") { model.selectAdjacentSession(-1) }
            .keyboardShortcut("[", modifiers: .command)
            .disabled(model.navigationOrder.isEmpty)
        Button(attentionTitle) { model.goToSessionNeedingAttention() }
            .keyboardShortcut("a", modifiers: [.command, .shift])
            .disabled(model.sessionNeedingAttention == nil)

        let order = Array(model.navigationOrder.prefix(9))
        if !order.isEmpty {
            Divider()
            ForEach(Array(order.enumerated()), id: \.element) { index, id in
                Button(title(for: id)) { model.selectSession(atShortcut: index + 1) }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .control)
            }
        }

        Divider()

        Button("Save Screenshot…") { model.saveScreenshot() }
            .keyboardShortcut("s", modifiers: [.command, .shift])
            .disabled(model.selected == nil)
        Button("Reload") { model.refresh() }
            .keyboardShortcut("r", modifiers: .command)

        Divider()

        Button("End Session…") { model.requestDestroySelectedSession() }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(model.selectedSession == nil || model.interactionEnabled)
    }

    private var attentionTitle: String {
        let waiting = ViewerAttention.waitingCount(model.attachedSessions)
        return waiting > 0
            ? "Go to Session Needing You (\(waiting))"
            : "Go to Session Needing Attention"
    }

    private func title(for id: String) -> String {
        guard let session = model.sessions.first(where: { $0.id == id }) else { return id }
        let title = ViewerSessionGrouping.displayTitle(session)
        return ViewerAttention.needsHuman(session) ? "\(title) — needs you" : title
    }
}
