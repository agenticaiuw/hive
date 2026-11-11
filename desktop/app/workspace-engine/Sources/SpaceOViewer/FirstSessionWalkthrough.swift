import AppKit
import SpaceOKit
import SwiftUI

/// SPAO-205. The MCP clients the walkthrough can write a registration snippet for. The snippets
/// mirror `Setup.clientConfiguration` and docs/SETUP.md; the path is the bundled or sibling
/// `spaceo` helper when the Viewer can find one, else the bare command.
enum ViewerAgentClient: String, CaseIterable, Identifiable {
    case claudeCode = "claude-code"
    case codex
    case cursor
    case claudeDesktop = "claude-desktop"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        case .cursor: "Cursor"
        case .claudeDesktop: "Claude Desktop"
        }
    }

    var instruction: String {
        switch self {
        case .claudeCode: "Run in a terminal:"
        case .codex: "Add to ~/.codex/config.toml:"
        case .cursor: "Add to Cursor's mcp.json:"
        case .claudeDesktop: "Add to claude_desktop_config.json:"
        }
    }

    func registrationCommand(spaceoPath: String) -> String {
        switch self {
        case .claudeCode:
            return "claude mcp add -s user spaceo -- \(Self.shellQuoted(spaceoPath)) mcp"
        case .codex:
            return """
            [mcp_servers.spaceo]
            command = \(Self.jsonString(spaceoPath))
            args = ["mcp"]
            """
        case .cursor, .claudeDesktop:
            return """
            { "mcpServers": { "spaceo": {
              "command": \(Self.jsonString(spaceoPath)), "args": ["mcp"]
            } } }
            """
        }
    }

    /// Single quotes survive every shell; an embedded quote is closed, escaped, reopened.
    static func shellQuoted(_ value: String) -> String {
        guard value != "spaceo" else { return value }
        return "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    /// JSON string escapes are also valid in TOML basic strings.
    static func jsonString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5C: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x0C: result += "\\f"
            case 0x0A: result += "\\n"
            case 0x0D: result += "\\r"
            case 0x09: result += "\\t"
            case 0x00...0x1F: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    static func resolvedSpaceOPath() -> String {
        ViewerDaemonExecutable.resolve()?.path ?? "spaceo"
    }
}

/// The welcome guide: four short pages from a fresh install to an agent working on a screen of
/// its own. Permissions and agent connections are done here, with one click each, rather than
/// described. Shown in place of the empty console until finished; Settings ▸ General and the
/// Help menu bring it back as a sheet.
struct FirstSessionWalkthrough: View {
    enum Presentation { case inline, sheet }

    enum Page: Int, CaseIterable {
        case welcome, access, agents, tryIt
    }

    @Environment(ViewerModel.self) private var model
    let presentation: Presentation
    let onDismiss: () -> Void
    @State private var page: Page
    @State private var forward = true

    init(presentation: Presentation, startAt page: Page = .welcome,
         onDismiss: @escaping () -> Void) {
        self.presentation = presentation
        self.onDismiss = onDismiss
        _page = State(initialValue: page)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button(presentation == .sheet ? "Close" : "Skip Setup") { onDismiss() }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .keyboardShortcut(presentation == .sheet ? .cancelAction : nil)
            }
            .padding(.bottom, 4)

            ZStack {
                content
                    .id(page)
                    .transition(.asymmetric(
                        insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                        removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity)))
            }
            .frame(maxWidth: .infinity, minHeight: 420, alignment: .top)
            .clipped()

            footer
        }
        .padding(presentation == .sheet ? 28 : 0)
        .frame(width: presentation == .sheet ? 640 : nil)
        .frame(maxWidth: 640)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Getting started with SpaceO")
        .onAppear { model.agentConnections.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch page {
        case .welcome: welcomePage
        case .access: accessPage
        case .agents: agentsPage
        case .tryIt: tryPage
        }
    }

    // MARK: - Pages

    private var welcomePage: some View {
        VStack(spacing: 22) {
            SpaceOBrandMark()
                .frame(width: 104, height: 104)
                .shadow(color: .accentColor.opacity(0.35), radius: 28, y: 8)
                .padding(.top, 12)
            VStack(spacing: 8) {
                Text("Welcome to SpaceO")
                    .font(.system(size: 30, weight: .bold))
                Text("Your AI agents get screens of their own. You watch, and step in whenever "
                     + "they need a hand.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 460)
            }
            VStack(alignment: .leading, spacing: 16) {
                feature("rectangle.on.rectangle", .blue, "A screen for every agent",
                        "Agents work on virtual displays. Your windows, cursor and keyboard stay yours.")
                feature("eye", .purple, "Watch them live",
                        "Every session appears here the moment an agent starts it.")
                feature("hand.raised", .orange, "Step in any time",
                        "Take control with your own mouse and keyboard, then hand it back.")
            }
            .padding(.top, 6)
            .frame(maxWidth: 470)
        }
        .frame(maxWidth: .infinity)
    }

    private var accessPage: some View {
        VStack(alignment: .leading, spacing: 18) {
            pageHeader("Allow access",
                       "macOS asks before one app can see or drive another. Each switch takes a "
                           + "moment, and SpaceO walks you through it.")
            VStack(spacing: 10) {
                accessCard(.screenRecording, "Screen Recording",
                           "So the Viewer can show you what agents see.")
                accessCard(.accessibility, "Accessibility",
                           "So you can take control of a session.")
                serviceCard
            }
        }
    }

    private var agentsPage: some View {
        VStack(alignment: .leading, spacing: 18) {
            pageHeader("Connect your agent",
                       "One click adds SpaceO to the tools you use. Restart the tool afterwards, "
                           + "then ask it to use SpaceO.")
            VStack(spacing: 0) {
                AgentConnectionsList()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
            }
            .background(.background.secondary,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            ManualAgentSetup()
                .font(.callout)
        }
    }

    private var tryPage: some View {
        VStack(spacing: 20) {
            ZStack {
                Circle().fill(Color.green.opacity(0.15)).frame(width: 96, height: 96)
                Image(systemName: "checkmark")
                    .font(.system(size: 40, weight: .bold))
                    .foregroundStyle(.green)
            }
            .padding(.top, 20)
            VStack(spacing: 8) {
                Text("You're all set")
                    .font(.system(size: 28, weight: .bold))
                Text("Sessions show up in the sidebar as agents start them. To see one now, open "
                     + "TextEdit on a virtual display — nothing appears on your screen.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 470)
            }
            Button {
                model.createSessionAndLaunch(app: "TextEdit")
            } label: {
                HStack(spacing: 8) {
                    if model.walkthroughLaunchInFlight {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: model.walkthroughSessionCreated
                              ? "checkmark.circle.fill" : "play.rectangle")
                    }
                    Text(model.walkthroughSessionCreated ? "TextEdit Is Open"
                         : "Try It with TextEdit")
                }
                .frame(minWidth: 200)
            }
            .controlSize(.large)
            .disabled(model.connectivity != .connected || model.walkthroughLaunchInFlight
                      || model.walkthroughSessionCreated)
            if model.connectivity != .connected {
                Text("Start SpaceO first (step 2).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Button("Back") { go(to: Page(rawValue: page.rawValue - 1)) }
                .opacity(page == .welcome ? 0 : 1)
                .disabled(page == .welcome)
            Spacer()
            HStack(spacing: 7) {
                ForEach(Page.allCases, id: \.self) { item in
                    Capsule()
                        .fill(item == page ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: item == page ? 18 : 7, height: 7)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(page.rawValue + 1) of \(Page.allCases.count)")
            Spacer()
            Button {
                if page == .tryIt { onDismiss() } else { go(to: Page(rawValue: page.rawValue + 1)) }
            } label: {
                Text(primaryTitle).frame(minWidth: 90)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.top, 18)
    }

    private var primaryTitle: String {
        switch page {
        case .welcome: "Get Started"
        case .access: accessReady ? "Continue" : "Continue Anyway"
        case .agents: "Continue"
        case .tryIt: "Finish"
        }
    }

    private var accessReady: Bool {
        model.permissions.screenRecording && model.permissions.accessibility
            && model.connectivity == .connected
    }

    private func go(to next: Page?) {
        guard let next else { return }
        forward = next.rawValue > page.rawValue
        withAnimation(.snappy(duration: 0.32)) { page = next }
    }

    // MARK: - Pieces

    private func pageHeader(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 26, weight: .bold))
            Text(subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 8)
    }

    private func feature(_ symbol: String, _ tint: Color, _ title: String,
                         _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func accessCard(_ kind: ViewerPermissionKind, _ title: String,
                            _ detail: String) -> some View {
        let granted = model.isGranted(kind)
        return card(symbol: kind.systemImage, tint: granted ? .green : .blue,
                    title: title, detail: detail) {
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.callout.weight(.semibold))
            } else {
                Button("Allow") { model.guidePermission(kind) }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var serviceCard: some View {
        let running = model.connectivity == .connected
        return card(symbol: "server.rack", tint: running ? .green : .orange,
                    title: "SpaceO service",
                    detail: running ? "Running in the background."
                        : "Creates the virtual displays agents work on.") {
            if running {
                Label("Running", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.callout.weight(.semibold))
            } else if model.connectivity == .connecting {
                ProgressView().controlSize(.small)
            } else {
                Button("Start") { model.startDaemon() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func card<Trailing: View>(symbol: String, tint: Color, title: String, detail: String,
                                      @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 40, height: 40)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}
