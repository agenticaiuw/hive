import SpaceOKit
import SwiftUI

/// The inspector's two tabs. The model keeps its finer-grained `ViewerInspectorSection`
/// (notifications and menus deep-link to Health, Apps, Events…); each maps onto one tab here.
/// Health lands on the session itself, where its status and any problem with it are shown;
/// SpaceO-wide health lives in Settings.
enum ViewerInspectorTab: String, CaseIterable, Identifiable {
    case session
    case activity

    var id: String { rawValue }

    var title: String {
        switch self {
        case .session: "Session"
        case .activity: "Activity"
        }
    }

    init(_ section: ViewerInspectorSection) {
        switch section {
        case .overview, .apps, .windows, .health, .infrastructure: self = .session
        case .events: self = .activity
        }
    }

    var section: ViewerInspectorSection {
        switch self {
        case .session: .overview
        case .activity: .events
        }
    }
}

struct InspectorView: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            Picker("Details", selection: Binding(
                get: { ViewerInspectorTab(model.inspectorSection) },
                set: { model.inspectorSection = $0.section }
            )) {
                ForEach(ViewerInspectorTab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            Divider()
            switch ViewerInspectorTab(model.inspectorSection) {
            case .session: SessionInspector()
            case .activity: ActivityInspector()
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - Session

private struct SessionInspector: View {
    @Environment(ViewerModel.self) private var model
    @State private var showsTechnical = false

    var body: some View {
        if model.canvasMode == .session, let session = model.selectedSession {
            sessionForm(session)
        } else if let display = model.selected {
            displayForm(display)
        } else {
            ContentUnavailableView(
                "Nothing Selected", systemImage: "sidebar.right",
                description: Text("Choose a session in the sidebar to see its apps and details."))
        }
    }

    private func sessionForm(_ session: SessionInfo) -> some View {
        let status = model.status(of: session)
        let presentation = ViewerSessionPresentation(session: session)
        return Form {
            Section {
                HStack(spacing: 12) {
                    SessionIconView(session: session, status: status, size: 38)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ViewerSessionGrouping.displayTitle(session))
                            .font(.headline)
                            .lineLimit(2)
                        StatusBadge(status: status)
                    }
                }
                .padding(.vertical, 2)
                if status.kind != .idle && status.kind != .working {
                    Text(status.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if ViewerAttention.needsHuman(session), !model.interactionEnabled {
                    Button {
                        model.takeControl(for: session.id)
                    } label: {
                        Label("Take Control", systemImage: "cursorarrow.click.2")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                    .disabled(!model.canTakeControl(of: session.id))
                }
                if let handoff = session.operatorHandoff {
                    LabeledContent("Your last note", value: handoff.note ?? "No note")
                }
            }

            Section("Name & Colour") {
                SessionAnnotationControls(session: session) { title, tag in
                    model.annotateSession(session.id, title: title, colorTag: tag)
                }
            }

            Section("Apps") {
                if let failure = session.windowDiscoveryFailure {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ViewerSessionStatus.staleWindowsDetail)
                            Text(failure)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                if session.apps.isEmpty {
                    Text("No apps open yet")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(session.apps, id: \.pid) { app in
                        appRow(app, windows: session.windows.filter { $0.pid == app.pid })
                    }
                }
            }

            Section("Agent") {
                LabeledContent("Controlled by", value: ownerText(session))
                LabeledContent("Started") {
                    Text(session.createdAt, format: .relative(presentation: .named))
                }
                if let last = session.lastAgentActionAt, session.lastAgentAction != nil {
                    LabeledContent("Last action") {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(ViewerSessionStatus.actionPhrase(session))
                                .lineLimit(2)
                                .multilineTextAlignment(.trailing)
                            Text(last, format: .relative(presentation: .named))
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                LabeledContent("Last minute") {
                    TimelineView(.periodic(from: .now, by: 5)) { context in
                        ActivitySparklineView(buckets: ViewerActivitySparkline.buckets(
                            timestamps: model.agentActivity[session.id] ?? [],
                            now: context.date))
                    }
                }
                if let badge = presentation.badge, badge != .owned {
                    LabeledContent("Lifecycle", value: badge.title)
                }
            }

            Section {
                DisclosureGroup("Technical Details", isExpanded: $showsTechnical) {
                    LabeledContent("Session ID") {
                        HStack(spacing: 6) {
                            Text(session.id)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            CopyButton(text: session.id, label: "Copy ID")
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                        }
                    }
                    ViewerStyle.value("Display", "\(session.displayID)")
                    ViewerStyle.value("Slot", "\(session.tileIndex + 1) of \(session.tileCapacity)"
                                      + (session.exclusiveDisplay ? " · exclusive" : ""))
                    ViewerStyle.value("Frame", ViewerStyle.resolution(session.width, session.height)
                                      + " at \(Int(session.x)), \(Int(session.y))")
                    ViewerStyle.value("Spaces", session.spaces.isEmpty
                                      ? "Unavailable"
                                      : session.spaces.map(String.init).joined(separator: ", "))
                }
            }

            Section {
                Button("End Session…", role: .destructive) {
                    model.request(.destroySession(session.id))
                }
                .disabled(model.interactionEnabled)
            }
        }
        .formStyle(.grouped)
    }

    private func appRow(_ app: AppInfo, windows: [WindowInfo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                AppIconView(app: app, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(app.name)
                        .font(.body.weight(.medium))
                    Text((app.startedByUs ? "Opened by SpaceO" : "Adopted")
                         + " · \(windows.count) window\(windows.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .help([app.bundleID, "PID \(app.pid)"].compactMap { $0 }.joined(separator: " · "))
            ForEach(windows, id: \.windowID) { window in
                HStack(spacing: 6) {
                    Image(systemName: "macwindow")
                        .foregroundStyle(.tertiary)
                    Text(window.title.isEmpty ? "Untitled window" : window.title)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    if !window.onStage {
                        Text("Off screen")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .padding(.leading, 36)
                .help("Window \(window.windowID) · "
                      + ViewerStyle.resolution(window.width, window.height))
            }
        }
        .padding(.vertical, 2)
    }

    private func ownerText(_ session: SessionInfo) -> String {
        guard let owner = session.controllerOwner else { return "Unknown" }
        let label = owner.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return label.isEmpty ? owner.id : label
    }

    private func displayForm(_ display: DisplayEntry) -> some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ViewerStyle.displayTitle(display, among: model.stages))
                        .font(.headline)
                    Text(display.isSpaceO ? "Virtual display" : "Physical display")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ViewerStyle.value("Resolution",
                                  ViewerStyle.resolution(display.bounds.width, display.bounds.height))
                ViewerStyle.value("State", display.isActive ? "Active" : "Inactive")
                ViewerStyle.value("Display ID", "\(display.id)")
            }
            Section("Sessions on This Display") {
                if model.sessionsOnSelectedDisplay.isEmpty {
                    Text("None").foregroundStyle(.secondary)
                } else {
                    ForEach(model.sessionsOnSelectedDisplay, id: \.id) { session in
                        let status = model.status(of: session)
                        Button {
                            model.selectSession(session.id)
                        } label: {
                            HStack(spacing: 10) {
                                SessionIconView(session: session, status: status, size: 22)
                                Text(ViewerSessionGrouping.displayTitle(session))
                                    .lineLimit(1)
                                Spacer()
                                Text(status.title)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Activity

private struct ActivityInspector: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        @Bindable var model = model
        let visible = ViewerEventFilter.apply(
            model.eventsFilter, to: model.events,
            selectedSessionID: model.canvasMode == .session ? model.selectedSessionID : nil)
        VStack(spacing: 0) {
            Picker("Show events for", selection: $model.eventsFilter) {
                ForEach(ViewerEventFilter.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .disabled(model.selectedSession == nil)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            if visible.isEmpty {
                ContentUnavailableView(
                    "No Activity Yet", systemImage: "clock",
                    description: Text("Agent actions, sessions starting and ending, and "
                                      + "connection changes show up here."))
            } else {
                List(visible) { event in
                    eventRow(event)
                }
                .listStyle(.plain)
            }
        }
    }

    private func eventRow(_ event: ViewerEvent) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: event.isAgentAction ? "bolt.fill"
                  : ViewerStyle.severitySymbol(event.severity))
                .font(.caption)
                .foregroundStyle(event.isAgentAction && event.severity == .info
                                 ? Color.secondary : ViewerStyle.severityColor(event.severity))
                .frame(width: 14)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(event.title)
                        .font(.callout.weight(.medium))
                    Spacer(minLength: 4)
                    Text(event.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if !event.detail.isEmpty {
                    Text(event.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if let sessionID = event.sessionID,
                   model.eventsFilter == .all || model.canvasMode != .session {
                    // The title a person gave the session reads better than its id; a session
                    // that has ended keeps its id, since there is nothing left to select.
                    let session = model.sessions.first { $0.id == sessionID }
                    Button(session.map(ViewerSessionGrouping.displayTitle) ?? sessionID) {
                        model.selectSession(sessionID)
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    .disabled(session == nil)
                    .help(sessionID)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}
