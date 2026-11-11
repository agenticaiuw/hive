import SpaceOKit
import SwiftUI

/// The console window: sessions on the left, the selected session's live screen in the middle,
/// details on the right when asked for.
struct ContentView: View {
    @Environment(ViewerModel.self) private var model
    /// The sheet currently on screen, so a dismissal can be told apart from a model change.
    @State private var presentedSheet: ViewerModel.ActiveSheet?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $model.columnVisibility) {
            SidebarView()
        } detail: {
            DetailView()
                // Settings is a place of its own; the session inspector has nothing to say there.
                .inspector(isPresented: Binding(
                    get: { model.inspectorVisible && model.settingsPane == nil },
                    set: { model.inspectorVisible = $0 })) {
                    InspectorView()
                        .inspectorColumnWidth(min: 270, ideal: 310, max: 420)
                }
                .toolbar { ConsoleToolbar() }
                .navigationTitle(model.settingsPane?.title ?? model.canvasTitle ?? "SpaceO")
                .navigationSubtitle(model.settingsPane == nil ? subtitle : "Settings")
        }
        .onAppear {
            model.acknowledgeWindowRequest()
            if let scenario = ViewerPreviewScenario.current {
                // After the first fixture poll has landed and selected something.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    ViewerPreview.stage(scenario, on: model)
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.willTerminateNotification
        )) { _ in
            // The save is debounced; quitting inside the window must not lose the last change.
            model.flushPreferences()
        }
        // One sheet modifier for every Viewer sheet: SwiftUI shows one sheet per view, and
        // several `.sheet` modifiers on the same view competed, so one could be swallowed.
        .sheet(item: Binding(
            get: { model.activeSheet },
            set: { newValue in
                // Dismissed without an answer (Escape, window close). Only the sheet that was
                // on screen is dismissed: if the model already moved on to another one, that
                // one has not been seen yet.
                guard newValue == nil, let shown = presentedSheet,
                      model.activeSheet?.id == shown.id else { return }
                model.dismissSheet(shown)
            }
        )) { sheet in
            Group {
                switch sheet {
                case let .handoff(handoff):
                    HandoffNoteSheet(handoff: handoff) { model.completeHandoff(note: $0) }
                case let .fileDrop(drop):
                    FileDropSheet(drop: drop,
                                  onOpen: { model.confirmOpenFiles(drop, app: $0) },
                                  onCancel: { model.cancelOpenFiles() })
                case let .permissionGuide(kind):
                    PermissionGuideSheet(kind: kind) { model.permissionGuide = nil }
                case .walkthrough:
                    FirstSessionWalkthrough(presentation: .sheet) { model.dismissWalkthrough() }
                }
            }
            .onAppear { presentedSheet = sheet }
        }
        .confirmationDialog(
            model.pendingConfirmation.map(model.confirmationTitle(for:)) ?? "",
            isPresented: Binding(
                get: { model.pendingConfirmation != nil },
                set: { if !$0 { model.cancelPendingAction() } }),
            titleVisibility: .visible
        ) {
            if let action = model.pendingConfirmation {
                Button(action.confirmationButton, role: .destructive) {
                    model.confirmPendingAction()
                }
            }
            Button("Cancel", role: .cancel) { model.cancelPendingAction() }
        } message: {
            Text(model.pendingConfirmation?.confirmationMessage ?? "")
        }
    }

    private var subtitle: String {
        if model.canvasMode == .session, let session = model.selectedSession {
            let status = model.status(of: session)
            return status.kind == .idle
                ? ViewerSessionStatus.appsSummary(session)
                : "\(status.title) · \(ViewerSessionStatus.appsSummary(session))"
        }
        if model.canvasMode == .display, let display = model.selected {
            let count = model.sessionsOnSelectedDisplay.count
            return "\(count) session\(count == 1 ? "" : "s") · "
                + ViewerStyle.resolution(display.bounds.width, display.bounds.height)
        }
        return ""
    }
}

// MARK: - Detail

/// Whatever the middle of the window should be showing: the live console when something is
/// selected, otherwise the state that explains why nothing is.
private struct DetailView: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        Group {
            if let pane = model.settingsPane {
                SettingsView(pane: pane)
            } else if model.canvasTitle != nil {
                SessionWorkspace()
            } else if model.connectivity == .disconnected {
                OfflineView()
            } else if model.sessions.isEmpty,
                      model.connectivity == .connecting || model.connectivity == .degraded {
                // Not known to be down yet: the first few seconds after launch without a daemon
                // used to flash the welcome guide before "isn't running".
                ProgressView("Connecting to SpaceO…")
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.walkthroughInline {
                GeometryReader { geometry in
                    ScrollView {
                        FirstSessionWalkthrough(
                            presentation: .inline,
                            startAt: ViewerPreviewScenario.current?.onboardingPage ?? .welcome
                        ) { model.dismissWalkthrough() }
                            .padding(.horizontal, 40)
                            .padding(.vertical, 28)
                            .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                    }
                }
                .background(WelcomeBackdrop())
            } else {
                NoSessionsView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ViewerStyle.canvasBackdrop)
    }
}

private struct OfflineView: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        VStack(spacing: 14) {
            SpaceOBrandMark()
                .frame(width: 72, height: 72)
                .padding(.bottom, 4)
            Text("SpaceO isn't running")
                .font(.title2.weight(.semibold))
            Text("Start it to see your agents' sessions live and step in when they need you.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Button { model.startDaemon() } label: {
                Text("Start SpaceO").frame(minWidth: 120)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .padding(.top, 4)
            if let error = model.daemonError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .frame(maxWidth: 420)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct NoSessionsView: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label("No sessions yet", systemImage: "rectangle.on.rectangle")
        } description: {
            Text("Sessions appear here as soon as an agent starts one. You can also open one "
                 + "yourself.")
        } actions: {
            HStack {
                Menu("New Session") { NewSessionMenuItems() }
                    .fixedSize()
                    .disabled(model.connectivity != .connected)
                Button("Connect an Agent…") { model.showSettings(.agents) }
            }
        }
    }
}

// MARK: - Workspace

private struct SessionWorkspace: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            NoticeStack()
            canvas
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            CanvasFooter()
        }
    }

    /// At Fit the canvas takes the shape of the agent's screen, so its corners and shadow frame
    /// the picture itself rather than black bars around it. Zoomed in, it fills the space.
    @ViewBuilder
    private var canvas: some View {
        if model.zoomMode == .fit, let bounds = model.interactionDisplay?.bounds,
           bounds.width > 0, bounds.height > 0 {
            SessionCanvas()
                .aspectRatio(bounds.width / bounds.height, contentMode: .fit)
        } else {
            SessionCanvas()
        }
    }
}

/// Every message that should interrupt the person, in one consistent stack above the canvas.
private struct NoticeStack: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        let banners = model.workspaceBanners
        // Missing Screen Recording is explained on the canvas itself, where the picture would
        // be; the card is for the one permission the canvas cannot speak for.
        let permissionsMissing = model.permissions.screenRecording && !model.permissions.accessibility
        let helpRequest = helpRequestSession
        let streamError: String? = {
            if case let .failed(error) = model.streamState, model.permissions.screenRecording {
                return error
            }
            return nil
        }()

        if !banners.isEmpty || permissionsMissing || helpRequest != nil || streamError != nil {
            VStack(spacing: 8) {
                if let session = helpRequest, let reason = ViewerAttention.reason(session) {
                    NoticeCard(
                        tint: .purple, systemImage: "hand.raised.fill",
                        title: "The agent needs you",
                        message: reason
                    ) {
                        Button("Take Control") { model.takeControl(for: session.id) }
                            .buttonStyle(.borderedProminent)
                            .tint(.purple)
                            .disabled(!model.canTakeControl(of: session.id))
                    }
                }
                ForEach(banners) { banner in
                    NoticeCard(
                        tint: ViewerStyle.severityColor(banner.severity),
                        systemImage: ViewerStyle.severitySymbol(banner.severity),
                        title: banner.text
                    ) {
                        switch banner.kind {
                        case .offline: Button("Start SpaceO") { model.startDaemon() }
                        case .reconnecting: Button("Retry Now") { model.refreshControlPlane() }
                        case .restarted: Button("Dismiss") { model.dismissDaemonRestartBanner() }
                        case .draining, .outdated: EmptyView()
                        }
                    }
                }
                if permissionsMissing {
                    NoticeCard(
                        tint: .orange, systemImage: "lock.shield",
                        title: "Allow Accessibility to take control",
                        message: "Without it you can watch a session, but not drive it."
                    ) {
                        Button("Allow…") { model.guidePermission(.accessibility) }
                            .buttonStyle(.borderedProminent)
                    }
                }
                if let streamError {
                    NoticeCard(
                        tint: .red, systemImage: "exclamationmark.octagon.fill",
                        title: "The live view stopped", message: streamError
                    ) {
                        Button("Retry") { model.retryStream() }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .transition(.opacity)
        }
    }

    /// The selected session when it has asked for a person and the person is not already
    /// helping. Hidden while the hand-back sheet is up: the person already helped, and the card
    /// would still say the agent is waiting until the resume lands.
    private var helpRequestSession: SessionInfo? {
        guard model.canvasMode == .session, !model.interactionEnabled,
              let session = model.selectedSession, ViewerAttention.needsHuman(session),
              model.pendingHandoff?.sessionIDs.contains(session.id) != true
        else { return nil }
        return session
    }
}

// MARK: - Canvas

struct SessionCanvas: View {
    @Environment(ViewerModel.self) private var model
    @State private var hovering = false

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black
                StreamSurface()
                if model.canvasMode == .display, let display = model.selected {
                    sessionOverlay(for: display, in: geometry.size)
                }
                AgentActionOverlay(markers: model.agentActionMarkers(viewSize: geometry.size))
                placeholder
                if model.interactionEnabled || model.previewControlChrome {
                    ControlBoundary()
                }
                if let pending = model.pendingPasteConfirmation, model.interactionEnabled {
                    PastePromptOverlay(prompt: pending.prompt)
                }
                StreamStallOverlay(prominent: model.interactionEnabled)
                if !model.interactionEnabled, !model.previewControlChrome,
                   model.permissions.screenRecording,
                   let activity = model.selectedAgentActivityText {
                    CanvasPill(text: activity, systemImage: "bolt.fill", tint: .green)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(12)
                        .allowsHitTesting(false)
                }
                if let movedAt = model.tileMovedAt {
                    TileMovedNotice(movedAt: movedAt)
                }
                if let hint = hoverHint {
                    CanvasPill(text: hint, systemImage: "cursorarrow.click.2")
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 14)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
                if let result = model.screenshotResult {
                    ScreenshotToast(result: result)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .animation(.easeOut(duration: 0.15), value: hoverHint)
        }
        .onHover { hovering = $0 }
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }

    /// The click-to-control affordance. A click on the canvas already asks for Control; this
    /// is what tells the person so.
    private var hoverHint: String? {
        guard hovering, !model.interactionEnabled, model.controlAvailable,
              model.canvasMode == .session else { return nil }
        return model.viewportZoom > 1
            ? "Drag to pan · Click to take control"
            : "Click to take control"
    }

    @ViewBuilder
    private var placeholder: some View {
        if !model.permissions.screenRecording {
            VStack(spacing: 10) {
                Image(systemName: "eye.slash")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.white.opacity(0.6))
                Text("Allow Screen Recording to see this session")
                    .font(.headline)
                Text("macOS shows the Viewer an agent's screen only with Screen Recording "
                     + "permission"
                     + (model.permissions.accessibility ? "." : ", and lets you drive it only "
                        + "with Accessibility."))
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
                Button("Allow Screen Recording…") { model.guidePermission(.screenRecording) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .padding(.top, 4)
            }
            .foregroundStyle(.white)
            .padding(24)
        } else if model.streamState == .starting {
            ProgressView()
                .controlSize(.regular)
                .tint(.white)
                .padding(16)
                .background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Connecting to the session's display")
        }
    }

    private func sessionOverlay(for display: DisplayEntry, in size: CGSize) -> some View {
        let tiles = SessionOverlayLayout.tiles(
            for: model.sessionsOnSelectedDisplay,
            displayBounds: display.bounds,
            viewSize: size,
            zoom: model.viewportZoom,
            pan: model.viewportPan
        )
        return ForEach(tiles, id: \.session.id) { tile in
            let status = model.status(of: tile.session)
            Button {
                model.selectSession(tile.session.id)
            } label: {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .strokeBorder(status.kind == .idle ? Color.white.opacity(0.45)
                                                            : status.kind.color,
                                      lineWidth: 1.5)
                    HStack(spacing: 6) {
                        AppIconView(app: tile.session.apps.first, size: 14)
                        Text(ViewerSessionGrouping.displayTitle(tile.session))
                            .font(.caption.weight(.semibold))
                        if status.kind != .idle {
                            Text(status.title)
                                .font(.caption2)
                                .foregroundStyle(status.kind == .working ? .white.opacity(0.75)
                                                                          : status.kind.color)
                        }
                    }
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(.black.opacity(0.72), in: Capsule())
                    .padding(6)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show \(ViewerSessionGrouping.displayTitle(tile.session)) on its own")
            .accessibilityLabel(
                ViewerAccessibility.sessionLabel(
                    tile.session,
                    breached: model.isolationBreaches.contains(tile.session.id),
                    recentActions: ViewerAccessibility.recentActionCount(
                        model.agentActivity[tile.session.id] ?? []))
            )
            .overlay(alignment: .bottom) {
                if let reason = ViewerAttention.reason(tile.session), !model.interactionEnabled {
                    // Taking Control from another session's tile selects it first; Control
                    // begins once its stream is up (`takeControl(for:)`).
                    AgentPauseBanner(
                        sessionID: tile.session.id,
                        sessionTitle: ViewerSessionGrouping.displayTitle(tile.session),
                        reason: reason, compact: true,
                        canTakeControl: model.canTakeControl(of: tile.session.id)
                    ) { model.takeControl(for: tile.session.id) }
                    .padding(6)
                }
            }
            .frame(width: tile.frame.width, height: tile.frame.height)
            // Absolute placement. A relative offset here would be measured from this ZStack's
            // center alignment, which puts the outline and its click target off its own pixels.
            .position(tile.center)
            .allowsHitTesting(
                SessionOverlayLayout.acceptsClicks(interactionEnabled: model.interactionEnabled)
            )
        }
    }
}

/// The frame around the canvas while the person holds Control, where their keys go, and the
/// one shortcut that gives control back. The toolbar cannot be clicked while input is captured,
/// so this has to say how to leave, clearly, every time.
private struct ControlBoundary: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        let destination = model.keyDestination
        let foreign = destination.map { !$0.isSessionApp } ?? false
        let tint = foreign ? Color.orange : Color.accentColor
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(tint, lineWidth: 3)
                .shadow(color: tint.opacity(0.6), radius: 8)
            HStack(spacing: 10) {
                Image(systemName: foreign ? "exclamationmark.triangle.fill" : "cursorarrow.rays")
                    .font(.system(size: 13, weight: .bold))
                Text("You're in control")
                    .font(.system(size: 13, weight: .semibold))
                if let destination {
                    Rectangle().fill(.white.opacity(0.35)).frame(width: 1, height: 14)
                    Text(destination.isSessionApp ? "Typing into \(destination.title)"
                         : "Typing into \(destination.title) — not this session's app")
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .opacity(0.9)
                }
                Rectangle().fill(.white.opacity(0.35)).frame(width: 1, height: 14)
                Text("Release")
                    .font(.system(size: 12, weight: .medium))
                    .opacity(0.9)
                ExitShortcut(compact: true)
            }
            .foregroundStyle(.white)
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .padding(.vertical, 6)
            .background(tint.gradient, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.35), radius: 10, y: 3)
            .padding(.top, 12)
            .padding(.horizontal, 16)

            ControlIntroCard(tint: tint)
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Input captured")
        .accessibilityValue(
            (destination.map { "\($0.bannerText). " } ?? "")
                + "\(ViewerControlPolicy.localExitDescription) releases input to this Mac."
        )
    }
}

/// Control, Command and Escape as keys, labelled, so the chord reads at a glance even for
/// someone who does not know the symbols.
struct ExitShortcut: View {
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 3 : 8) {
            key("⌃", "control")
            key("⌘", "command")
            key("esc", nil)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Control Command Escape")
    }

    private func key(_ glyph: String, _ name: String?) -> some View {
        VStack(spacing: compact ? 0 : 2) {
            Text(glyph)
                .font(.system(size: compact ? 12 : 22, weight: .semibold, design: .rounded))
            if let name, !compact {
                Text(name).font(.system(size: 10, weight: .medium))
            }
        }
        .foregroundStyle(compact ? Color.primary : Color.white)
        .frame(minWidth: compact ? 22 : 64, minHeight: compact ? 20 : 52)
        .padding(.horizontal, compact ? 4 : 6)
        .background(
            RoundedRectangle(cornerRadius: compact ? 5 : 10, style: .continuous)
                .fill(compact ? AnyShapeStyle(Color.white) : AnyShapeStyle(.white.opacity(0.14)))
                .shadow(color: .black.opacity(0.25), radius: 0, y: compact ? 1 : 2))
        .overlay(
            RoundedRectangle(cornerRadius: compact ? 5 : 10, style: .continuous)
                .strokeBorder(.white.opacity(compact ? 0 : 0.3), lineWidth: 1))
        .environment(\.colorScheme, .light)
    }
}

/// Shown in the middle of the canvas for a moment when Control starts: the person's attention
/// is exactly there, and this is the one thing they must know before they need it.
private struct ControlIntroCard: View {
    @Environment(ViewerModel.self) private var model
    let tint: Color
    @State private var visible = false

    var body: some View {
        VStack(spacing: 14) {
            Text("You're in control")
                .font(.system(size: 22, weight: .bold))
            Text("Your mouse and keyboard drive this session now. The agent waits until you're done.")
                .font(.callout)
                .multilineTextAlignment(.center)
                .opacity(0.85)
                .frame(maxWidth: 340)
            ExitShortcut()
            Text("gives control back")
                .font(.caption.weight(.medium))
                .opacity(0.75)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 30)
        .padding(.vertical, 24)
        .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(tint.opacity(0.7), lineWidth: 1.5))
        .shadow(color: .black.opacity(0.4), radius: 24, y: 8)
        .scaleEffect(visible ? 1 : 0.94)
        .opacity(visible ? 1 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            withAnimation(.spring(duration: 0.3)) { visible = true }
            // A preview holds it on screen so it can be inspected.
            guard !model.previewControlChrome else { return }
            try? await Task.sleep(nanoseconds: 2_800_000_000)
            withAnimation(.easeIn(duration: 0.35)) { visible = false }
        }
    }
}

private struct WelcomeBackdrop: View {
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            RadialGradient(colors: [Color.blue.opacity(0.18), .clear],
                           center: UnitPoint(x: 0.25, y: 0.05), startRadius: 10, endRadius: 520)
            RadialGradient(colors: [Color.orange.opacity(0.12), .clear],
                           center: UnitPoint(x: 0.85, y: 0.2), startRadius: 10, endRadius: 460)
        }
        .ignoresSafeArea()
    }
}

/// Saved or failed, the screenshot result appears where the person was looking, and leaves
/// on its own.
private struct ScreenshotToast: View {
    @Environment(ViewerModel.self) private var model
    let result: ViewerScreenshotResult

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: result.isFailure ? "exclamationmark.triangle.fill" : "camera.fill")
                .foregroundStyle(result.isFailure ? .orange : .white)
            Text(result.isFailure ? result.message : "Screenshot saved")
                .lineLimit(2)
            if case .saved = result {
                Button("Show in Finder") { model.revealScreenshot() }
                    .buttonStyle(.link)
                    .foregroundStyle(.white)
            }
            Button {
                model.clearScreenshotResult()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .font(.callout.weight(.medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.black.opacity(0.8), in: Capsule())
        .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 18)
        .task(id: result) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if model.screenshotResult == result { model.clearScreenshotResult() }
        }
    }
}

/// SPAO-162. The stream is re-cropped in place when a tile moves, so instead of a black frame
/// the console shows this cue for a moment. Keyed on the move time so a second move restarts it.
private struct TileMovedNotice: View {
    let movedAt: Date
    @State private var visible = false

    var body: some View {
        CanvasPill(text: "Window area moved", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
            .opacity(visible ? 1 : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 48)
            .allowsHitTesting(false)
            .task(id: movedAt) {
                withAnimation(.easeOut(duration: 0.15)) { visible = true }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                withAnimation(.easeIn(duration: 0.4)) { visible = false }
            }
    }
}

/// The inline paste confirmation (SPAO-160 follow-up). Drawn on the canvas and never focusable:
/// a sheet here became the key window and ended the Control it was asking about. The answer is
/// the person's next ⌘V; it expires on its own otherwise.
private struct PastePromptOverlay: View {
    let prompt: String

    var body: some View {
        Label(prompt, systemImage: "doc.on.clipboard")
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 44)
            .allowsHitTesting(false)
            .accessibilityElement(children: .combine)
    }
}

/// "Stalled · last update 5s ago" on the canvas itself when the picture stops updating. While
/// the person holds Control it is prominent: they are clicking on pixels that may be stale.
private struct StreamStallOverlay: View {
    @Environment(ViewerModel.self) private var model
    let prominent: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let health = model.streamHealth(now: context.date)
            if health.isStalled {
                Label(health.statusText, systemImage: "exclamationmark.triangle.fill")
                    .font(prominent ? .callout.weight(.semibold) : .caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, prominent ? 12 : 9)
                    .padding(.vertical, prominent ? 8 : 5)
                    .background(Color.orange.opacity(prominent ? 0.95 : 0.85), in: Capsule())
                    .help(health.tooltip)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(prominent ? 44 : 12)
                    .allowsHitTesting(false)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Stream stalled")
                    .accessibilityValue(health.statusText)
            }
        }
    }
}

// MARK: - Footer

/// One quiet line under the canvas: is the picture live, who is driving, and how big it is.
private struct CanvasFooter: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            // Health is sampled once a second rather than published per frame (see
            // `ViewerModel.lastSampleAt`), so a stall shows up without a 30 Hz re-render.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let health = model.streamHealth(now: context.date)
                HStack(spacing: 5) {
                    Circle()
                        .fill(healthColor(health))
                        .frame(width: 7, height: 7)
                    Text(model.permissions.screenRecording ? health.statusText : "No access")
                }
                .help(health.tooltip)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Stream: \(health.statusText)")
                .accessibilityHint(health.tooltip)
            }
            if let note = model.note, model.permissions.screenRecording {
                Text(note.text)
                    .foregroundStyle(note.isWarning ? .orange : .secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(note.text)
            }
            Spacer(minLength: 8)
            Text(driverText)
                .help(model.interactionEnabled
                      ? "Your input has priority; the agent resumes when you release control"
                      : "")
            if showsScopePicker {
                Picker("Show", selection: Binding(
                    get: { model.canvasMode },
                    set: { model.setCanvasMode($0) }
                )) {
                    Text("Session").tag(ViewerCanvasMode.session)
                    Text("Whole Display").tag(ViewerCanvasMode.display)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
                .disabled(!model.canSwitchCanvasMode)
                .help("Show only this session, or every session sharing its display")
            }
            ZoomControl()
        }
        .lineLimit(1)
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .frame(height: 34)
    }

    private var driverText: String {
        if model.interactionEnabled || model.previewControlChrome {
            return "You're in control · agent paused"
        }
        if model.canvasMode == .session, model.selectedSessionInputPaused { return "Agent paused" }
        if model.canvasMode == .display { return "Watching" }
        return model.controlAvailable ? "Watching · click to take control" : "Watching"
    }

    /// Only worth offering when the session shares its display, or the person is already
    /// looking at the whole display.
    private var showsScopePicker: Bool {
        model.canvasMode == .display
            || (model.canSwitchCanvasMode && model.sessionsOnSelectedDisplay.count > 1)
    }

    private func healthColor(_ health: ViewerStreamHealth) -> Color {
        switch health.status {
        case .live: .green
        case .starting: .blue
        case .stalled: .orange
        case .failed: .red
        case .idle: .gray
        }
    }
}

private struct ZoomControl: View {
    @Environment(ViewerModel.self) private var model

    var body: some View {
        HStack(spacing: 2) {
            Button { model.zoomOut() } label: {
                Image(systemName: "minus").frame(width: 18, height: 18)
            }
            .disabled(!model.canZoomOut)
            .help("Zoom Out (⌘−)")
            .accessibilityLabel("Zoom Out")
            Menu {
                // ⌘0 and ⌘1 belong to the View menu; a second registration here would compete.
                Button("Fit to Window (⌘0)") { model.zoomToFit() }
                Button("Actual Size (⌘1)") { model.zoomToActualSize() }
            } label: {
                Text(model.zoomMode == .fit ? "Fit" : "\(Int(model.viewportZoom * 100))%")
                    .monospacedDigit()
                    .frame(minWidth: 34)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(model.selected == nil)
            .help("Zoom")
            Button { model.zoomIn() } label: {
                Image(systemName: "plus").frame(width: 18, height: 18)
            }
            .disabled(!model.canZoomIn)
            .help("Zoom In (⌘+)")
            .accessibilityLabel("Zoom In")
        }
        .buttonStyle(.borderless)
    }
}

// MARK: - Toolbar

private struct ConsoleToolbar: ToolbarContent {
    @Environment(ViewerModel.self) private var model

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if model.settingsPane == nil, model.canvasTitle != nil {
                controlButton
                if let session = model.selectedSession, model.canvasMode == .session {
                    pauseButton(session)
                }
                Button { model.saveScreenshot() } label: {
                    Label("Screenshot", systemImage: "camera")
                }
                .help("Save a screenshot of what the canvas shows (⇧⌘S)")
                .disabled(model.selected == nil)
                moreMenu
            }
            if model.settingsPane == nil {
                Button { model.toggleInspector() } label: {
                    Label(model.inspectorVisible ? "Hide Details" : "Show Details",
                          systemImage: "sidebar.right")
                }
                .help(model.inspectorVisible ? "Hide Details (⌥⌘I)" : "Show Details (⌥⌘I)")
            }
        }
    }

    private var controlButton: some View {
        Button {
            if model.interactionEnabled {
                model.endHumanControl()
            } else if !model.permissions.accessibility {
                model.guidePermission(.accessibility)
            } else if let id = model.selectedSessionID, model.canvasMode == .session {
                model.takeControl(for: id)
            } else {
                model.beginHumanControl()
            }
        } label: {
            Label(model.interactionEnabled ? "Release Control" : "Take Control",
                  systemImage: model.interactionEnabled ? "hand.raised.slash" : "cursorarrow.click.2")
        }
        .labelStyle(.titleAndIcon)
        .buttonStyle(.borderedProminent)
        .tint(model.interactionEnabled ? .orange : .accentColor)
        // Missing Accessibility keeps the button live: pressing it explains how to fix that.
        .disabled(!model.controlAvailable && !model.interactionEnabled
                  && model.permissions.accessibility)
        .help(controlHelp)
    }

    private func pauseButton(_ session: SessionInfo) -> some View {
        let paused = session.inputPaused == true
        return Button {
            model.setSessionPaused(session.id, paused: !paused)
        } label: {
            Label(paused ? "Resume Agent" : "Pause Agent",
                  systemImage: paused ? "play.fill" : "pause.fill")
        }
        .disabled(!model.canChangeAgentPause)
        .help(!model.canChangeAgentPause
              ? "Release control before pausing or resuming the agent"
              : paused ? "Let the agent continue (⇧⌘P)" : "Stop the agent's input for now (⇧⌘P)")
    }

    private var moreMenu: some View {
        Menu {
            if let session = model.selectedSession {
                Button("Copy Text from Session", systemImage: "doc.on.clipboard") {
                    model.copyFromSession()
                }
                .disabled(model.connectivity != .connected)
                if model.canSwitchCanvasMode {
                    Button(model.canvasMode == .session ? "Show Whole Display" : "Show Session Only",
                           systemImage: "rectangle.3.group") {
                        model.setCanvasMode(model.canvasMode == .session ? .display : .session)
                    }
                }
                Button(model.miniMonitorVisible ? "Hide Mini Monitor" : "Show Mini Monitor",
                       systemImage: "pip") {
                    MiniMonitorController.shared.setVisible(!model.miniMonitorVisible, model: model)
                }
                Divider()
                Button("End Session…", systemImage: "xmark.circle", role: .destructive) {
                    model.request(.destroySession(session.id))
                }
                .disabled(model.interactionEnabled)
            } else {
                Button(model.miniMonitorVisible ? "Hide Mini Monitor" : "Show Mini Monitor",
                       systemImage: "pip") {
                    MiniMonitorController.shared.setVisible(!model.miniMonitorVisible, model: model)
                }
            }
            Divider()
            Button("Reload", systemImage: "arrow.clockwise") { model.refresh() }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
        .help("More actions")
    }

    private var controlHelp: String {
        if model.interactionEnabled {
            return "Hand the session back to the agent. "
                + "\(ViewerControlPolicy.localExitDescription) always works."
        }
        if !model.controlAvailable {
            if !model.permissions.screenRecording || !model.permissions.accessibility {
                return "The Viewer needs Screen Recording and Accessibility permission first."
            }
            if model.selected?.isSpaceO == false {
                return "Physical displays are view-only."
            }
            if model.selected != nil && !model.controlTargetAvailable {
                return "Wait for an agent session on this display."
            }
            return "Waiting for the live view."
        }
        return "Use your own mouse and keyboard in this session. The agent pauses until you "
            + "release control (⇧⌘I)."
    }
}
