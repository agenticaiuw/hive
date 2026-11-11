import AppKit
import SwiftUI
import SpaceOKit

/// A VM-style console onto SpaceO's virtual displays: watch an agent's screen live and, when
/// you flip the Control toggle, drive it with your own mouse and keyboard — delivered per-PID,
/// so the real cursor, keyboard focus, and frontmost app never change hands.
struct SpaceOViewerApp: App {
    static let mainWindowID = "viewer"

    /// `--background`: a preview launch that must leave the person's desktop alone — for an
    /// agent checking the Viewer inside a SpaceO session, or any launch that is not the person
    /// opening the app. It never activates, adds no menu bar item, posts no notifications,
    /// sets no Dock badge, and neither reads nor writes the saved preferences.
    static let isBackgroundLaunch = CommandLine.arguments.contains("--background")
        || ViewerPreviewScenario.current != nil

    @NSApplicationDelegateAdaptor(ViewerAppDelegate.self) private var delegate
    @State private var model: ViewerModel

    init() {
        // `scripts/viewer-snapshots.sh` asks which preview scenarios this build has.
        if CommandLine.arguments.contains("--list-previews") {
            print(ViewerPreviewScenario.allCases.map(\.rawValue).joined(separator: "\n"))
            exit(0)
        }
        // The daemon log attributes each request to the surface that sent it.
        Transport.setClientLabel("viewer")
        let background = Self.isBackgroundLaunch
        let model = ViewerPreviewScenario.current.map(ViewerPreview.makeModel) ?? ViewerModel(
            preferencesStore: background ? nil : .shared,
            notificationPoster: background ? nil : UserNotificationBridge.shared,
            frontWindowProvider: ViewerModel.productionFrontWindow,
            dockBadge: background ? { _ in } : ViewerModel.productionDockBadge)
        _model = State(initialValue: model)
        ViewerPerformanceMetrics.startIfRequested(model: model)
        // Wired here, at the app level, rather than by a window: a menu-bar-only launch has no
        // window, and a notification click used to bring back the Dock icon and nothing else.
        UserNotificationBridge.shared.onAction = { [weak model] action in
            model?.handleNotificationAction(action)
        }
    }

    var body: some Scene {
        // ⌘N stays enabled: every console window registers its own frame sink with the shared
        // model, so a second window streams alongside the first instead of blanking it. Both
        // windows follow the one selection; the stream itself is shared.
        WindowGroup("SpaceO Viewer", id: Self.mainWindowID) {
            ContentView()
                .environment(model)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 1_280, height: 800)
        .windowToolbarStyle(.unified)
        .commands { viewerCommands }

        // SPAO-217. The glance without the window. Menu style so every row is a real menu
        // item for VoiceOver and keyboard navigation.
        MenuBarExtra(isInserted: .constant(!Self.isBackgroundLaunch)) {
            MenuBarExtraView()
                .environment(model)
        } label: {
            MenuBarExtraLabel()
                .environment(model)
        }
        .menuBarExtraStyle(.menu)

    }

    @CommandsBuilder
    private var viewerCommands: some Commands {
        // Settings is a route in the console window, not a separate panel.
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.showSettings(model.settingsPane ?? .general) }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(after: .newItem) {
            Menu("New Session") {
                NewSessionMenuItems(ownsShortcut: true).environment(model)
            }
            .disabled(model.connectivity != .connected)
        }
        CommandGroup(after: .pasteboard) {
            Button("Copy from Session") { model.copyFromSession() }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(model.selectedSession == nil || model.connectivity != .connected)
        }
        CommandGroup(after: .sidebar) {
            Button("Fit to Window") { model.zoomToFit() }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(model.selected == nil)
            Button("Actual Size") { model.zoomToActualSize() }
                .keyboardShortcut("1", modifiers: .command)
                .disabled(model.selected == nil)
            Button("Zoom In") { model.zoomIn() }
                .keyboardShortcut("+", modifiers: .command)
                .disabled(!model.canZoomIn)
            Button("Zoom Out") { model.zoomOut() }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(!model.canZoomOut)
            Divider()
            Button(model.inspectorVisible ? "Hide Details" : "Show Details") {
                model.toggleInspector()
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            Toggle("Show Agent Clicks on Screen", isOn: Binding(
                get: { model.showAgentActions },
                set: { model.setShowAgentActions($0) }
            ))
        }
        CommandGroup(after: .windowArrangement) {
            Button(model.miniMonitorVisible ? "Hide Mini Monitor" : "Show Mini Monitor") {
                MiniMonitorController.shared.setVisible(!model.miniMonitorVisible, model: model)
            }
            .keyboardShortcut("m", modifiers: [.command, .option])
            Toggle("Mini Monitor Ignores Clicks", isOn: Binding(
                get: { model.preferences.miniMonitorClickThrough },
                set: { model.setMiniMonitorClickThrough($0) }
            ))
        }
        CommandGroup(after: .help) {
            Button("Setup Guide…") { model.presentWalkthrough() }
            Button("Connect an Agent…") { model.showSettings(.agents) }
        }
        CommandMenu("Session") {
            ViewerSessionCommands(model: model)
        }
    }
}

final class ViewerAppDelegate: NSObject, NSApplicationDelegate {
    private var launchedAsMenuBarItem = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A SwiftPM executable launches as an accessory process; without a regular activation
        // policy it would have no Dock icon and its window could not become key.
        //
        // SPAO-217. "Launch as a menu bar item only" would normally be `LSUIElement` in
        // Info.plist, but that key is fixed at bundle time and a Swift Package build cannot
        // toggle it per user. The equivalent at runtime is to stay an accessory process, so the
        // preference is read here — before any window can become key — and Open Viewer from the
        // menu bar extra switches back to `.regular`.
        launchedAsMenuBarItem = !SpaceOViewerApp.isBackgroundLaunch
            && ViewerPreferencesStore.shared.load().launchAsMenuBarItemOnly
        if SpaceOViewerApp.isBackgroundLaunch {
            // A regular app, so its window can be driven, but never brought forward.
            NSApp.setActivationPolicy(.regular)
        } else if launchedAsMenuBarItem {
            NSApp.setActivationPolicy(.accessory)
            // SwiftUI restores the WindowGroup's window a moment after launch; close it so only
            // the menu bar extra remains. The model keeps polling either way.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                for window in NSApp.windows where !(window is NSPanel) && window.isVisible {
                    window.close()
                }
            }
        } else {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }

        // Repair first, arm second. A previous run that was force-quit while holding Control
        // left this Mac with a hidden cursor, a mouse decoupled from that cursor, and Spotlight
        // and Mission Control switched off; nothing else in the system undoes any of it.
        if HostInputGuard.repairAbandonedCapture() {
            NSLog("SpaceO Viewer: restored host input state abandoned by a previous run")
        }
        HostInputGuard.installTerminationHandlers()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Quit, logout, and SIGTERM end the process without unwinding the view hierarchy, so
        // the surface's own capture teardown never runs on any of them.
        HostInputGuard.restoreIfCaptureActive()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // A menu-bar-only launch lives in the extra; closing the console is not quitting.
        !launchedAsMenuBarItem
    }
}
