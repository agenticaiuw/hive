import SpaceOKit
import SwiftUI

extension AgentActionOutcome {
    var color: Color {
        switch self {
        case .confirmed: .green
        case .unconfirmed: .orange
        case .refused: .red
        }
    }

    var title: String { rawValue }
}

/// SPAO-158 follow-up. A ripple where the agent's last action landed, coloured by the daemon's
/// verdict, with the target's role and label beside it. Fades over about 1.5 s. The whole view
/// is keyed on the action time by its caller so a repeated identical click ripples again.
struct AgentActionRipple: View {
    let marker: SessionOverlayLayout.ActionMarker
    @State private var progress: CGFloat = 0

    var body: some View {
        ZStack {
            Circle()
                .stroke(marker.outcome.color, lineWidth: 3)
                .frame(width: 18 + 42 * progress, height: 18 + 42 * progress)
                .opacity(Double(1 - progress))
            Circle()
                .fill(marker.outcome.color)
                .frame(width: 10, height: 10)
                .opacity(Double(1 - progress))
            label
                .offset(x: 0, y: 26)
                .opacity(Double(max(0, 1 - progress * 1.1)))
        }
        .position(marker.center)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            progress = 0
            withAnimation(.easeOut(duration: 1.5)) { progress = 1 }
        }
    }

    private var label: some View {
        let text = [marker.action, marker.target].compactMap { $0 }.joined(separator: " · ")
        return Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(marker.outcome.color.opacity(0.85), in: Capsule())
            .fixedSize()
    }
}

struct AgentActionOverlay: View {
    let markers: [SessionOverlayLayout.ActionMarker]

    var body: some View {
        ForEach(markers, id: \.sessionID) { marker in
            AgentActionRipple(marker: marker)
                .id("\(marker.sessionID)-\(marker.at.timeIntervalSinceReferenceDate)")
        }
    }
}
