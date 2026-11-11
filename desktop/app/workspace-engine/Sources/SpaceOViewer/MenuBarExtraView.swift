import AppKit
import SpaceOKit
import SwiftUI

/// SPAO-217. The glance: how many agents, is anything waiting, paused or breached, and one
/// click to look. Take Control goes through `takeControl(for:)`, which selects the session,
/// waits for its stream, pauses agents, announces itself, and refuses when the stream or
/// permissions are not there — the menu adds no shortcut past it.
struct MenuBarExtraView: View {
    @Environment(ViewerModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if model.attachedSessions.isEmpty {
            Text(model.connectivity == .connected ? "No sessions" : model.connectivity.title)
        } else {
            ForEach(menuSessions, id: \.id) { session in
                Button {
                    openViewer()
                    model.selectSession(session.id)
                } label: {
                    Label {
                        Text(rowTitle(session))
                    } icon: {
                        Image(systemName: model.statusDot(for: session).systemImage)
                            .foregroundStyle(model.statusDot(for: session).color)
                    }
                }
                .accessibilityLabel(
                    "\(ViewerSessionGrouping.displayTitle(session)), \(model.statusDot(for: session).title)")
            }
        }
        Divider()
        Button("Open Viewer") { openViewer() }
        Button("Pause All Agents") { model.setAllSessionsPaused(true) }
            .disabled(!model.canChangeAgentPause || model.attachedSessions.allSatisfy { $0.inputPaused == true })
        // Agents waiting for a person are not resumed in bulk; the label says how many.
        Button(model.resumeAllPlan.title) { model.setAllSessionsPaused(false) }
            .disabled(!model.canChangeAgentPause || model.resumeAllPlan.isEmpty)
        if !model.attachedSessions.isEmpty {
            Divider()
            ForEach(menuSessions, id: \.id) { session in
                Button("Take Control of \(ViewerSessionGrouping.displayTitle(session))") {
                    // The window has to be up to capture input; Control itself is the same
                    // arbitration path the toolbar uses, deferred until the stream is live.
                    openViewer()
                    model.takeControl(for: session.id)
                }
                .disabled(!model.canTakeControl(of: session.id))
            }
        }
        Divider()
        Button(model.miniMonitorVisible ? "Hide Mini Monitor" : "Show Mini Monitor") {
            MiniMonitorController.shared.setVisible(!model.miniMonitorVisible, model: model)
        }
        Button("Settings…") {
            openViewer()
            model.showSettings(model.settingsPane ?? .general)
        }
        Divider()
        Button("Quit SpaceO Viewer") { NSApp.terminate(nil) }
    }

    private var menuSessions: [SessionInfo] {
        let order = model.navigationOrder
        return model.attachedSessions.sorted { lhs, rhs in
            let lhsWaiting = ViewerAttention.needsHuman(lhs)
            if lhsWaiting != ViewerAttention.needsHuman(rhs) { return lhsWaiting }
            return (order.firstIndex(of: lhs.id) ?? .max) < (order.firstIndex(of: rhs.id) ?? .max)
        }
    }

    private func rowTitle(_ session: SessionInfo) -> String {
        let title = ViewerSessionGrouping.displayTitle(session)
        if let reason = ViewerAttention.reason(session) {
            return "\(title) — needs you: \(reason)"
        }
        var suffix: [String] = []
        if session.inputPaused == true { suffix.append("paused") }
        if session.abandoned == true { suffix.append("abandoned") }
        if session.teardownPending { suffix.append("cleaning up") }
        return suffix.isEmpty ? title : "\(title) — \(suffix.joined(separator: ", "))"
    }

    private func openViewer() {
        ViewerWindowOpener.open(openWindow)
    }
}

/// Bringing the console back, from the menu or from a notification click.
enum ViewerWindowOpener {
    @MainActor
    static func open(_ openWindow: OpenWindowAction) {
        // Launched as a menu bar item, the process is an accessory; opening the console makes
        // it a regular app again so the window can become key.
        NSApp.setActivationPolicy(.regular)
        if let existing = NSApp.windows.first(where: {
            $0.identifier?.rawValue.hasPrefix(SpaceOViewerApp.mainWindowID) == true && $0.isVisible
        }) {
            existing.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: SpaceOViewerApp.mainWindowID)
        }
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// The menu bar label: brand mark, the waiting count (when any agent needs the person) and
/// the session count. Also the one view that exists for the whole life of the app, so it is
/// where a window request from outside any window — a notification click in a menu-bar-only
/// launch — is turned into an open window.
struct MenuBarExtraLabel: View {
    @Environment(ViewerModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let aggregate = model.statusAggregate
        HStack(spacing: 3) {
            Image(nsImage: SpaceOBrandMark.menuBarImage)
            if aggregate.needsHuman > 0 {
                Image(systemName: ViewerSessionStatusDot.needsHuman.systemImage)
            }
            if aggregate.total > 0 {
                Text(aggregate.labelText)
                    .font(.caption.monospacedDigit().weight(.semibold))
            }
            if let worst = aggregate.worst, worst != .green, worst != .needsHuman {
                Image(systemName: "circle.fill")
                    .font(.system(size: 6))
                    .foregroundStyle(worst.color)
            }
        }
        .accessibilityLabel(aggregate.accessibilityDescription)
        .onChange(of: model.windowRequested) { _, requested in
            guard requested else { return }
            ViewerWindowOpener.open(openWindow)
            model.acknowledgeWindowRequest()
        }
    }
}
