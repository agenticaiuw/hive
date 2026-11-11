import SpaceOKit
import SwiftUI

enum ViewerStyle {
    static let cornerRadius: CGFloat = 10
    /// The canvas backdrop: darker than the window so the agent's screen reads as the content.
    static let canvasBackdrop = Color(nsColor: .underPageBackgroundColor)

    static func connectivityColor(_ state: ViewerConnectivityState) -> Color {
        switch state {
        case .connecting: .blue
        case .connected: .green
        case .degraded: .orange
        case .disconnected: .red
        }
    }

    static func severitySymbol(_ severity: ViewerEventSeverity) -> String {
        switch severity {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .critical: "xmark.octagon.fill"
        }
    }

    static func severityColor(_ severity: ViewerEventSeverity) -> Color {
        switch severity {
        case .info: .blue
        case .warning: .orange
        case .critical: .red
        }
    }

    static func value(_ label: String, _ value: String) -> some View {
        LabeledContent(label) {
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }

    static func empty(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .foregroundStyle(.secondary)
            .padding(.vertical, 6)
    }

    /// "Virtual Display 2" for SpaceO displays, by position among them; the system name for a
    /// physical one. The raw id stays in help text and the inspector.
    static func displayTitle(_ display: DisplayEntry, among stages: [DisplayEntry]) -> String {
        guard display.isSpaceO else { return display.name }
        guard let index = stages.firstIndex(where: { $0.id == display.id }) else {
            return "Virtual Display"
        }
        return "Virtual Display \(index + 1)"
    }

    static func resolution(_ width: Double, _ height: Double) -> String {
        "\(Int(width)) × \(Int(height))"
    }
}

extension ViewerSessionStatus.Kind {
    var color: Color {
        switch self {
        case .breach: .red
        case .needsYou: .purple
        case .youHaveControl: .accentColor
        case .cleaningUp: .gray
        case .abandoned, .paused: .orange
        case .working: .green
        case .idle: .secondary
        }
    }

    var systemImage: String {
        switch self {
        case .breach: "exclamationmark.shield.fill"
        case .needsYou: "hand.raised.fill"
        case .youHaveControl: "cursorarrow.rays"
        case .cleaningUp: "hourglass"
        case .abandoned: "exclamationmark.triangle.fill"
        case .paused: "pause.circle.fill"
        case .working: "bolt.fill"
        case .idle: "circle.fill"
        }
    }

    /// Whether the state asks something of the person; the sidebar tints the row's detail line.
    var isAlerting: Bool {
        switch self {
        case .breach, .needsYou, .abandoned: true
        default: false
        }
    }
}

extension ViewerModel {
    /// Whether the toolbar may offer Control right now, from the same facts the policy checks.
    var controlAvailable: Bool {
        controlTargetAvailable
            && streamState.isLive
            && permissions.screenRecording
            && permissions.accessibility
    }

    /// Health alerts, each problem once. A stream that failed only because Screen Recording is
    /// missing is the permission problem again, not a second one.
    var issues: [ViewerHealthAlert] {
        healthAlerts.filter { $0.id != "stream" || permissions.screenRecording }
    }

    /// The one status every surface shows for a session.
    func status(of session: SessionInfo, now: Date = Date()) -> ViewerSessionStatus {
        let controlled = interactionEnabled
            && (canvasMode == .session ? selectedSessionID == session.id
                : sessionsOnSelectedDisplay.contains { $0.id == session.id })
        return .of(session, breached: isolationBreaches.contains(session.id),
                   controlled: controlled, now: now)
    }

    /// The heading for whatever the canvas shows; nil when there is nothing to show. In session
    /// scope that means no session: a virtual display kept briefly after its last session ended
    /// is not something to put in front of the person.
    var canvasTitle: String? {
        switch canvasMode {
        case .session:
            return selectedSession.map(ViewerSessionGrouping.displayTitle)
        case .display:
            return selected.map { ViewerStyle.displayTitle($0, among: stages) }
        }
    }
}
