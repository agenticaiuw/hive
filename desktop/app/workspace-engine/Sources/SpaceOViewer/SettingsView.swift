import AppKit
import SpaceOKit
import SwiftUI

/// Settings, as a place in the main window rather than a separate panel: the sidebar lists the
/// panes and the detail shows one. Everything about SpaceO itself — the daemon, permissions,
/// displays, connected agents — lives here, so the console stays about sessions.
struct SettingsView: View {
    @Environment(ViewerModel.self) private var model
    let pane: ViewerSettingsPane

    var body: some View {
        Group {
            switch pane {
            case .general: GeneralSettingsPane()
            case .agents: AgentsSettingsPane()
            case .permissions: PermissionsSettingsPane()
            case .spaceo: ServiceSettingsPane()
            case .displays: DisplaysSettingsPane()
            case .notifications: NotificationsSettingsPane()
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// The white-on-colour glyph that marks each pane, as System Settings does.
struct SettingsPaneIcon: View {
    let pane: ViewerSettingsPane
    var size: CGFloat = 22

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(color.gradient)
            .overlay {
                Image(systemName: pane.systemImage)
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch pane {
        case .general: .gray
        case .agents: .purple
        case .permissions: .blue
        case .spaceo: .green
        case .displays: .indigo
        case .notifications: .red
        }
    }
}

private struct PaneHeader: View {
    let pane: ViewerSettingsPane
    let summary: String

    var body: some View {
        Section {
            HStack(spacing: 14) {
                SettingsPaneIcon(pane: pane, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(pane.title).font(.title2.weight(.semibold))
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

// MARK: - General

private struct GeneralSettingsPane: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        Form {
            PaneHeader(pane: .general, summary: "How the Viewer looks and where it lives.")
            Section("Console") {
                Toggle(isOn: Binding(
                    get: { model.showAgentActions },
                    set: { model.setShowAgentActions($0) })) {
                    Text("Show agent clicks on screen")
                    Text("A ripple marks each click, green when SpaceO confirmed it landed.")
                }
            }
            Section("Mini Monitor") {
                Toggle(isOn: Binding(
                    get: { model.miniMonitorVisible },
                    set: { MiniMonitorController.shared.setVisible($0, model: model) })) {
                    Text("Show Mini Monitor")
                    Text("A small always-on-top view of the selected session. ⌥⌘M")
                }
                Toggle(isOn: Binding(
                    get: { model.preferences.miniMonitorClickThrough },
                    set: { model.setMiniMonitorClickThrough($0) })) {
                    Text("Clicks pass through it")
                    Text("Lets you work under it. Hide it from the menu bar or with ⌥⌘M.")
                }
            }
            Section("Menu Bar") {
                Toggle(isOn: Binding(
                    get: { model.preferences.launchAsMenuBarItemOnly },
                    set: { value in model.updatePreferences { $0.launchAsMenuBarItemOnly = value } })) {
                    Text("Start in the menu bar only")
                    Text("No window or Dock icon at launch; open the Viewer from the menu bar. "
                         + "Applies from the next launch.")
                }
            }
            Section("Getting Started") {
                LabeledContent {
                    Button("Show Guide") { model.presentWalkthrough() }
                } label: {
                    Text("Setup guide")
                    Text("Permissions, connecting an agent, and a first session.")
                }
            }
            Section("About") {
                LabeledContent("Version", value: SpaceOVersion.current)
                LabeledContent {
                    Button("Open") {
                        let logs = FileManager.default.homeDirectoryForCurrentUser
                            .appendingPathComponent("Library/Logs/SpaceO", isDirectory: true)
                        NSWorkspace.shared.open(logs)
                    }
                } label: {
                    Text("Logs")
                    Text("~/Library/Logs/SpaceO")
                }
            }
        }
    }
}

// MARK: - Agents

private struct AgentsSettingsPane: View {
    var body: some View {
        Form {
            PaneHeader(pane: .agents,
                       summary: "Connect your AI tools to SpaceO, so each agent gets a screen "
                           + "of its own instead of yours.")
            Section {
                AgentConnectionsList()
            } footer: {
                Text("Connecting adds a “spaceo” entry to that tool's MCP settings and keeps "
                     + "everything else. Restart the tool afterwards.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                ManualAgentSetup()
            }
        }
    }
}

struct AgentConnectionsList: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        let connections = model.agentConnections
        ForEach(MCPClient.allCases, id: \.self) { client in
            AgentConnectionRow(client: client,
                               state: connections.states[client] ?? .checking,
                               busy: connections.busy.contains(client),
                               message: connections.messages[client]) {
                connections.connect(client)
            }
        }
        .onAppear { connections.refresh() }
    }
}

private struct AgentConnectionRow: View {
    let client: MCPClient
    let state: ViewerAgentConnectionState
    let busy: Bool
    let message: (text: String, isError: Bool)?
    let connect: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ClientIcon(client: client)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.displayName).font(.body.weight(.medium))
                Text(message?.text ?? statusText)
                    .font(.caption)
                    .foregroundStyle(message?.isError == true ? AnyShapeStyle(.red)
                                     : state.isConnected ? AnyShapeStyle(.green)
                                     : AnyShapeStyle(.secondary))
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var trailing: some View {
        if busy {
            ProgressView().controlSize(.small)
        } else {
            switch state {
            case .checking:
                ProgressView().controlSize(.small)
            case .connected(_, current: true):
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.green)
                    .font(.title3)
                    .help("Connected to this Viewer's SpaceO")
            case .connected:
                Button("Use This Viewer") { connect() }
                    .help("It points at another SpaceO install that works. Switch it to the one "
                          + "bundled with this Viewer.")
            case .broken:
                Button("Repair") { connect() }.buttonStyle(.borderedProminent)
            case .notConnected:
                Button("Connect") { connect() }.buttonStyle(.borderedProminent)
            case .notInstalled:
                Button("Connect") { connect() }
                    .help("\(client.displayName) doesn't look installed. Connecting still writes "
                          + "its settings for when it is.")
            }
        }
    }

    private var statusText: String {
        switch state {
        case .checking: "Checking…"
        case .notInstalled: "Not installed"
        case .notConnected: "Not connected"
        case .connected(_, current: true): "Connected"
        case let .connected(path, _): "Connected to \(path)"
        case let .broken(path): "Points at \(path), which is missing"
        }
    }
}

private struct ClientIcon: View {
    let client: MCPClient

    var body: some View {
        Group {
            if let image = Self.icon(for: client) {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.black.gradient)
                    .overlay {
                        Image(systemName: "terminal.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                    }
            }
        }
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
    }

    private static func icon(for client: MCPClient) -> NSImage? {
        let bundleID: String? = switch client {
        case .claudeCode: nil
        case .codex: "com.openai.codex"
        case .cursor: "com.todesktop.230313mzl4w4u92"
        case .claudeDesktop: "com.anthropic.claudefordesktop"
        }
        guard let bundleID,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
        else { return nil }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}

/// The copy-and-paste fallback, for tools the one-click path cannot reach.
struct ManualAgentSetup: View {
    @State private var client: ViewerAgentClient = .claudeCode
    @State private var expanded = false
    private let spaceoPath = ViewerAgentClient.resolvedSpaceOPath()

    var body: some View {
        DisclosureGroup("Set up by hand", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Tool", selection: $client) {
                    ForEach(ViewerAgentClient.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Text(client.instruction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(alignment: .top, spacing: 8) {
                    Text(client.registrationCommand(spaceoPath: spaceoPath))
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(nsColor: .textBackgroundColor),
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    CopyButton(text: client.registrationCommand(spaceoPath: spaceoPath))
                        .id(client)
                }
            }
            .padding(.top, 6)
        }
    }
}

// MARK: - Permissions

private struct PermissionsSettingsPane: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        Form {
            PaneHeader(pane: .permissions,
                       summary: "macOS asks before any app can see or control others. SpaceO "
                           + "needs both, for the Viewer and for its daemon.")
            Section("SpaceO Viewer") {
                PermissionRow(kind: .screenRecording)
                PermissionRow(kind: .accessibility)
            }
            Section {
                if model.infrastructure.daemon == nil {
                    Text("Start SpaceO to check what its daemon can do.")
                        .foregroundStyle(.secondary)
                } else {
                    PermissionRow(kind: .daemonAccessibility)
                    PermissionRow(kind: .daemonScreenRecording)
                }
            } header: {
                Text("SpaceO Daemon")
            } footer: {
                if model.infrastructure.daemon != nil {
                    Text("These belong to \(model.grantee(for: .daemonAccessibility)), the app "
                         + "that started the daemon.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct PermissionRow: View {
    @Environment(ViewerModel.self) private var model
    let kind: ViewerPermissionKind

    var body: some View {
        let granted = model.isGranted(kind)
        HStack(spacing: 12) {
            Image(systemName: kind.systemImage)
                .font(.title3)
                .foregroundStyle(granted ? Color.green : Color.orange)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(kind.settingName).font(.body.weight(.medium))
                Text(kind.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.green)
            } else {
                Button("Allow…") { model.guidePermission(kind) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Service

private struct ServiceSettingsPane: View {
    @Environment(ViewerModel.self) private var model
    @State private var confirmsStop = false

    var body: some View {
        Form {
            PaneHeader(pane: .spaceo,
                       summary: "The background service that creates virtual displays and runs "
                           + "agents' apps on them.")
            Section {
                HStack(spacing: 12) {
                    Circle()
                        .fill(ViewerStyle.connectivityColor(model.connectivity))
                        .frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusTitle).font(.body.weight(.medium))
                        if let runtime = model.infrastructure.daemon {
                            Text("Version \(runtime.version) · running since "
                                 + runtime.startedAt.formatted(date: .omitted, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if let error = model.daemonError {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                    Spacer()
                    if model.connectivity == .connected {
                        Button("Stop…") { confirmsStop = true }
                    } else {
                        Button("Start") { model.startDaemon() }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.vertical, 2)
            }
            Section("Health") {
                if model.issues.isEmpty {
                    Label("Everything is working", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                } else {
                    ForEach(model.issues) { alert in
                        HealthIssueRow(alert: alert)
                    }
                }
            }
        }
        .confirmationDialog("Stop SpaceO?", isPresented: $confirmsStop, titleVisibility: .visible) {
            Button("Stop SpaceO and End All Sessions", role: .destructive) { model.stopDaemon() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The daemon quits the apps it launched and removes its virtual displays. "
                 + "The Viewer stays open.")
        }
    }

    private var statusTitle: String {
        switch model.connectivity {
        case .connected: "Running"
        case .connecting: "Connecting…"
        case .degraded: "Not responding"
        case .disconnected: "Not running"
        }
    }
}

struct HealthIssueRow: View {
    @Environment(ViewerModel.self) private var model
    let alert: ViewerHealthAlert

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: ViewerStyle.severitySymbol(alert.severity))
                .foregroundStyle(ViewerStyle.severityColor(alert.severity))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(alert.title).font(.body.weight(.medium))
                Text(alert.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 8)
            if let title = alert.actionTitle, let action = alert.action {
                // End and Clean Up both quit apps; `request` asks first.
                Button(title) { model.request(action) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Displays

private struct DisplaysSettingsPane: View {
    @Environment(ViewerModel.self) private var model
    @State private var requestedDensity = 1

    var body: some View {
        let displays = model.infrastructure.displays
        Form {
            PaneHeader(pane: .displays,
                       summary: "Screens that exist only for agents. Nothing on them reaches "
                           + "yours.")
            Section("Displays") {
                if displays.isEmpty {
                    Text("None right now. SpaceO creates one when an agent starts a session.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(displays.enumerated()), id: \.element.displayID) { index, display in
                        HStack(spacing: 12) {
                            Image(systemName: "display")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                                .frame(width: 26)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Virtual Display \(index + 1)").font(.body.weight(.medium))
                                Text(ViewerStyle.resolution(display.width, display.height)
                                     + " · \(display.used) of \(display.capacity) session"
                                     + (display.capacity == 1 ? "" : "s"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Show") {
                                model.closeSettings()
                                model.selectDisplay(display.displayID)
                            }
                            .disabled(!model.displays.contains { $0.id == display.displayID })
                            Button("Remove…", role: .destructive) {
                                model.request(.removeDisplay(display.displayID))
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            Section {
                Stepper(value: $requestedDensity, in: 1...16) {
                    LabeledContent("Sessions per display", value: "\(requestedDensity)")
                }
                if requestedDensity != model.infrastructure.configuredDensity {
                    Button("Apply to New Displays") {
                        model.configureSessionsPerDisplay(requestedDensity)
                    }
                    .disabled(model.connectivity != .connected)
                }
            } header: {
                Text("Sharing")
            } footer: {
                Text("How many sessions share one virtual display. One gives every agent a full "
                     + "screen; more saves memory. Existing displays keep their layout.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            requestedDensity = model.preferences.lastDensity ?? model.infrastructure.configuredDensity
        }
        .onChange(of: model.infrastructure.configuredDensity) {
            requestedDensity = model.infrastructure.configuredDensity
        }
    }
}

// MARK: - Notifications

private struct NotificationsSettingsPane: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        Form {
            PaneHeader(pane: .notifications,
                       summary: "When SpaceO should interrupt you. Routine agent actions never do.")
            Section {
                ForEach(ViewerNotificationClass.allCases) { notificationClass in
                    Toggle(isOn: Binding(
                        get: { notificationClass.isEnabled(in: model.preferences.notifications) },
                        set: { model.setNotificationClass(notificationClass, enabled: $0) }
                    )) {
                        Text(notificationClass.title)
                        Text(notificationClass.detail)
                    }
                }
            } footer: {
                Text("macOS asks for notification permission the first time one is due or you "
                     + "switch one on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
