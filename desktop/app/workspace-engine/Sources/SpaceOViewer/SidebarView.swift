import SpaceOKit
import SwiftUI
import UniformTypeIdentifiers

/// What the sidebar can select. Recovery records are listed but never selectable: there is
/// nothing left of them to show on the canvas.
enum SidebarItem: Hashable {
    case session(String)
    case display(CGDirectDisplayID)
}

/// The left column: every agent session, the virtual displays they run on, and leftovers that
/// need cleaning up. A real `List` selection, so arrow keys, type-select and the system
/// highlight all behave like every other Mac sidebar.
struct SidebarView: View {
    @Environment(ViewerModel.self) private var model
    /// Group keys the person folded up. Per window, not persisted: a fresh launch shows all.
    @State private var collapsedGroups: Set<String> = []
    @State private var displaysExpanded = false

    var body: some View {
        if let pane = model.settingsPane {
            SettingsSidebar(pane: pane)
        } else {
            sessionsList
        }
    }

    @ViewBuilder
    private var sessionsList: some View {
        @Bindable var model = model
        let sessions = model.filteredSessions
        let groups = ViewerSessionGrouping.groups(sessions)
        let now = Date()

        List(selection: selection) {
            if sessions.isEmpty {
                emptyRow
            } else if groups.count == 1, let group = groups.first {
                Section {
                    ForEach(group.sessions, id: \.id) { sessionRow($0, now: now) }
                } header: {
                    sectionHeader(group.key == ViewerSessionGrouping.unassignedKey
                                  ? "Sessions" : group.label, count: group.sessions.count)
                }
            } else {
                ForEach(groups, id: \.key) { group in
                    Section(isExpanded: expansion(for: group.key)) {
                        ForEach(group.sessions, id: \.id) { sessionRow($0, now: now) }
                    } header: {
                        sectionHeader(group.label, count: group.sessions.count)
                    }
                }
            }

            if !model.stages.isEmpty {
                Section(isExpanded: $displaysExpanded) {
                    ForEach(model.stages) { displayRow($0) }
                } header: {
                    sectionHeader("Virtual Displays", count: model.stages.count)
                }
            }

            if !model.detachedSessions.isEmpty {
                Section {
                    ForEach(model.detachedSessions, id: \.id) { recoveryRow($0) }
                } header: {
                    sectionHeader("Needs Cleanup", count: model.detachedSessions.count)
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $model.searchText, placement: .sidebar, prompt: "Search sessions")
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
    }

    // MARK: - Selection

    private var selection: Binding<SidebarItem?> {
        Binding(
            get: {
                if model.canvasMode == .session {
                    return model.selectedSessionID.map(SidebarItem.session)
                }
                return model.selectedID.map(SidebarItem.display)
            },
            set: { item in
                model.closeSettings()
                switch item {
                case let .session(id)?: model.selectSession(id)
                case let .display(id)?: model.selectDisplay(id)
                // Clicking empty space would clear the selection; the canvas always shows
                // something while there is something to show, so that is ignored.
                case nil: break
                }
            })
    }

    private func expansion(for key: String) -> Binding<Bool> {
        Binding(
            get: { !collapsedGroups.contains(key) },
            set: { expanded in
                if expanded { collapsedGroups.remove(key) } else { collapsedGroups.insert(key) }
            })
    }

    // MARK: - Rows

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).lineLimit(1)
            Spacer()
            Text("\(count)")
                .monospacedDigit()
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(count)")
    }

    @ViewBuilder
    private var emptyRow: some View {
        if model.searchText.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("No sessions yet")
                    .font(.callout.weight(.medium))
                Text("They appear here when an agent starts one.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
            .selectionDisabled()
        } else {
            VStack(alignment: .leading, spacing: 3) {
                Text("No matches")
                    .font(.callout.weight(.medium))
                Text("Search looks at titles, owners, apps and window titles.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
            .selectionDisabled()
        }
    }

    private func sessionRow(_ session: SessionInfo, now: Date) -> some View {
        let status = model.status(of: session, now: now)
        let title = ViewerSessionGrouping.displayTitle(session)
        return HStack(spacing: 10) {
            SessionIconView(session: session, status: status, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    if let tag = ViewerSessionColorTag(wire: session.colorTag) {
                        Circle().fill(tag.color).frame(width: 7, height: 7)
                            .help(tag.title)
                    }
                }
                Text(rowDetail(session, status: status))
                    .font(.caption)
                    .foregroundStyle(status.kind.isAlerting ? AnyShapeStyle(status.kind.color)
                                                             : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
        .tag(SidebarItem.session(session.id))
        .contextMenu { SessionContextMenu(session: session) }
        .help(ViewerSessionGrouping.showsIdentifier(session) ? "\(title) — \(session.id)" : title)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ViewerAccessibility.sessionLabel(
            session,
            breached: model.isolationBreaches.contains(session.id),
            recentActions: ViewerAccessibility.recentActionCount(
                model.agentActivity[session.id] ?? [], now: now)))
        .accessibilityAction(named: "Take Control") { model.takeControl(for: session.id) }
    }

    private func rowDetail(_ session: SessionInfo, status: ViewerSessionStatus) -> String {
        switch status.kind {
        case .idle: status.detail
        case .working: "Working · \(status.detail)"
        case .needsYou: "Needs you · \(status.detail)"
        case .paused: "Paused · \(ViewerSessionStatus.appsSummary(session))"
        case .youHaveControl, .cleaningUp, .abandoned, .breach: status.title
        }
    }

    private func displayRow(_ display: DisplayEntry) -> some View {
        let count = model.sessions.filter {
            $0.displayID == display.id && $0.runtimeAttached != false
        }.count
        return HStack(spacing: 10) {
            Image(systemName: "display")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(ViewerStyle.displayTitle(display, among: model.stages))
                    .lineLimit(1)
                Text("\(count) session\(count == 1 ? "" : "s") · "
                     + ViewerStyle.resolution(display.bounds.width, display.bounds.height)
                     + (display.isActive ? "" : " · inactive"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .tag(SidebarItem.display(display.id))
        .help("Show every session on this display (display \(display.id))")
        .contextMenu {
            Button("Show Whole Display") { model.selectDisplay(display.id) }
            Divider()
            Button("Remove Display…", role: .destructive) {
                model.request(.removeDisplay(display.id))
            }
            .disabled(model.connectivity != .connected || model.interactionEnabled)
        }
    }

    private func recoveryRow(_ session: SessionInfo) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wrench.and.screwdriver")
                .foregroundStyle(.orange)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(ViewerSessionGrouping.displayTitle(session))
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Text(session.recoveryBlockers?.first?.message
                     ?? "Left behind by an earlier daemon.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                // Quits the session's apps; confirmed like End Session.
                Button(session.reclaimable == true ? "Clean Up…" : "Retry Cleanup…") {
                    model.request(.reclaimSession(session.id))
                }
                .controlSize(.small)
                .help("Quit this session's leftover apps and remove what it left behind")
            }
        }
        .padding(.vertical, 3)
        .selectionDisabled()
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            Button { model.showSettings(.spaceo) } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(ViewerStyle.connectivityColor(model.connectivity))
                        .frame(width: 7, height: 7)
                    Text(serviceText)
                        .lineLimit(1)
                    let issues = model.issues.count
                    if issues > 0 {
                        Text("· \(issues) issue\(issues == 1 ? "" : "s")")
                            .foregroundStyle(.orange)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("SpaceO status and health")
            .accessibilityLabel("SpaceO status: \(serviceText). Show details.")

            Spacer()

            Button { model.showSettings(.general) } label: {
                Image(systemName: "gearshape")
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("Settings (⌘,)")
            .accessibilityLabel("Settings")

            Menu {
                NewSessionMenuItems()
            } label: {
                Image(systemName: "plus")
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(model.connectivity != .connected)
            .help("New Session")
            .accessibilityLabel("New Session")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 7)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var serviceText: String {
        switch model.connectivity {
        case .connected: "SpaceO running"
        case .connecting: "Connecting…"
        case .degraded: "Reconnecting…"
        case .disconnected: "SpaceO offline"
        }
    }
}

/// Everything a person does to one session, from a right-click on its row. The same actions
/// as the toolbar and the Session menu, through the same model calls.
struct SessionContextMenu: View {
    @Environment(ViewerModel.self) private var model
    let session: SessionInfo

    var body: some View {
        Button("Take Control") { model.takeControl(for: session.id) }
            .disabled(!model.canTakeControl(of: session.id))
        Button(session.inputPaused == true ? "Resume Agent" : "Pause Agent") {
            model.setSessionPaused(session.id, paused: session.inputPaused != true)
        }
        .disabled(!model.canChangeAgentPause)
        Divider()
        Menu("Colour") {
            ForEach(ViewerSessionColorTag.allCases) { tag in
                Button {
                    model.annotateSession(session.id, colorTag: .some(tag))
                } label: {
                    if ViewerSessionColorTag(wire: session.colorTag) == tag {
                        Label(tag.title, systemImage: "checkmark")
                    } else {
                        Text(tag.title)
                    }
                }
            }
            Divider()
            Button("None") { model.annotateSession(session.id, colorTag: .some(nil)) }
                .disabled(ViewerSessionColorTag(wire: session.colorTag) == nil)
        }
        Button("Copy Session ID") {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(session.id, forType: .string)
        }
        Divider()
        Button("End Session…", role: .destructive) {
            model.request(.destroySession(session.id))
        }
        .disabled(model.interactionEnabled)
    }
}

private struct SettingsSidebar: View {
    @Environment(ViewerModel.self) private var model
    let pane: ViewerSettingsPane

    var body: some View {
        List(selection: Binding(
            get: { Optional(pane) },
            set: { if let pane = $0 { model.showSettings(pane) } })) {
            Button { model.closeSettings() } label: {
                Label("Sessions", systemImage: "chevron.left")
                    .font(.body.weight(.medium))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help("Back to sessions (Esc)")
            .padding(.vertical, 4)
            .selectionDisabled()

            Section("Settings") {
                ForEach(ViewerSettingsPane.allCases) { item in
                    HStack(spacing: 10) {
                        SettingsPaneIcon(pane: item)
                        Text(item.title)
                        Spacer(minLength: 0)
                        if badge(for: item) {
                            Circle().fill(.orange).frame(width: 7, height: 7)
                                .accessibilityLabel("Needs attention")
                        }
                    }
                    .padding(.vertical, 2)
                    .tag(item)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
    }

    private func badge(for item: ViewerSettingsPane) -> Bool {
        switch item {
        case .permissions: ViewerPermissionKind.allCases.contains { !model.isGranted($0) }
        case .spaceo: model.connectivity != .connected || !model.issues.isEmpty
        default: false
        }
    }
}

/// A new session is most useful with something in it: open an app into it straight away, or
/// start it empty for an agent to fill.
struct NewSessionMenuItems: View {
    @Environment(ViewerModel.self) private var model
    /// The app menu owns ⇧⌘N; the sidebar's copy of these items must not register it twice.
    var ownsShortcut = false
    static let suggestedApps = ["Safari", "TextEdit", "Notes", "Terminal"]

    var body: some View {
        Section("Open in a New Session") {
            ForEach(Self.suggestedApps, id: \.self) { app in
                Button(app) { model.createSessionAndLaunch(app: app) }
            }
            Button("Other App…") {
                let panel = NSOpenPanel()
                panel.directoryURL = URL(fileURLWithPath: "/Applications")
                panel.allowedContentTypes = [.application]
                panel.prompt = "Open in Session"
                guard panel.runModal() == .OK, let url = panel.url else { return }
                model.createSessionAndLaunch(app: url.path)
            }
        }
        Divider()
        Button("Empty Session") { model.createSession() }
            .keyboardShortcut(ownsShortcut ? KeyboardShortcut("n", modifiers: [.command, .shift]) : nil)
    }
}
