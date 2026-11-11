import SpaceOKit
import SwiftUI

/// SPAO-219. Shown when the person releases Control. The note travels to the agent with the
/// resume as `operatorHandoff`, so its next screen read comes with an explanation instead of a
/// changed world. Skip sends the resume without a note; both paths resume.
struct HandoffNoteSheet: View {
    let handoff: ViewerModel.PendingHandoff
    let onComplete: (String?) -> Void
    @State private var note = ""
    @FocusState private var noteFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "arrowshape.turn.up.left.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hand back to the agent")
                        .font(.headline)
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            TextField("What did you change? (optional)", text: $note)
                .textFieldStyle(.roundedBorder)
                .focused($noteFocused)
                .onSubmit { onComplete(note) }
                .accessibilityLabel("Hand-back note")
            HStack {
                Spacer()
                Button("Skip") { onComplete(nil) }
                    .keyboardShortcut(.cancelAction)
                Button("Hand Back") { onComplete(note) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width: 460)
        .onAppear { noteFocused = true }
    }

    private var summary: String {
        let seconds = Int(max(0, handoff.controlDuration).rounded())
        let duration = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
        return "You were in control for \(duration). A short note tells the agent what changed, "
            + "so it isn't surprised. It carries on when you hand back or skip."
    }
}

/// SPAO-219, reverse direction. An agent that paused itself with a reason ("needs 2FA code")
/// is asking for a person; the Take Control button goes through the ordinary Control path.
struct AgentPauseBanner: View {
    let sessionID: String
    var sessionTitle: String?
    let reason: String
    let compact: Bool
    let canTakeControl: Bool
    let takeControl: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(compact ? Color.white : Color.purple)
            VStack(alignment: .leading, spacing: 1) {
                Text("Needs you")
                    .font(compact ? .caption2.weight(.semibold) : .callout.weight(.semibold))
                Text(reason)
                    .font(compact ? .caption2 : .caption)
                    .foregroundStyle(compact ? AnyShapeStyle(.white.opacity(0.85))
                                             : AnyShapeStyle(.secondary))
                    .lineLimit(compact ? 1 : 2)
            }
            Spacer(minLength: 4)
            Button("Take Control") { takeControl() }
                .controlSize(compact ? .mini : .small)
                .disabled(!canTakeControl)
                .help("Pause the agent and use this session yourself; you hand it back with a "
                      + "note when you release")
        }
        .foregroundStyle(compact ? Color.white : Color.primary)
        .padding(.horizontal, compact ? 8 : 12)
        .padding(.vertical, compact ? 5 : 8)
        .background(compact ? AnyShapeStyle(Color.purple.opacity(0.9))
                            : AnyShapeStyle(Color.purple.opacity(0.12)),
                    in: RoundedRectangle(cornerRadius: compact ? 7 : 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(sessionTitle ?? sessionID) needs you: \(reason)")
    }
}

/// SPAO-218. Rename and colour-tag the selected session. Commits on Return or focus loss so a
/// half-typed title is not sent on every keystroke.
struct SessionAnnotationControls: View {
    let session: SessionInfo
    let annotate: (_ title: String??, _ colorTag: ViewerSessionColorTag??) -> Void
    @State private var draftTitle = ""
    @FocusState private var editingTitle: Bool

    var body: some View {
        TextField("Name", text: $draftTitle, prompt: Text("Untitled session"))
            .focused($editingTitle)
            .onSubmit { commitTitle() }
            .onChange(of: editingTitle) { _, focused in if !focused { commitTitle() } }
            .accessibilityLabel("Session title")
        LabeledContent("Colour") {
            HStack(spacing: 5) {
                ForEach(ViewerSessionColorTag.allCases) { tag in
                    let current = ViewerSessionColorTag(wire: session.colorTag) == tag
                    Button {
                        annotate(nil, .some(current ? nil : tag))
                    } label: {
                        Circle()
                            .fill(tag.color)
                            .frame(width: 14, height: 14)
                            .overlay {
                                if current {
                                    Circle().strokeBorder(Color.primary, lineWidth: 2)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .help(current ? "Remove \(tag.title) tag" : tag.title)
                    .accessibilityLabel(tag.title)
                    .accessibilityAddTraits(current ? .isSelected : [])
                }
            }
        }
        .onAppear { draftTitle = session.title ?? "" }
        .onChange(of: session.id) { _, _ in draftTitle = session.title ?? "" }
        .onChange(of: session.title) { _, new in if !editingTitle { draftTitle = new ?? "" } }
    }

    private func commitTitle() {
        let normalized = ViewerSessionGrouping.normalizedTitle(draftTitle)
        let existing = ViewerSessionGrouping.normalizedTitle(session.title ?? "")
        guard normalized != existing else { return }
        annotate(.some(normalized), nil)
    }
}

/// SPAO-160. "Open <file> with <app>?" The file stays where it is; the daemon hands its path
/// to the app inside the session.
struct FileDropSheet: View {
    let drop: ViewerModel.PendingFileDrop
    let onOpen: (String) -> Void
    let onCancel: () -> Void
    @State private var app = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(drop.files.count == 1 ? "Open this file in the session?"
                  : "Open \(drop.files.count) files in the session?",
                  systemImage: "arrow.down.doc")
                .font(.headline)
            VStack(alignment: .leading, spacing: 3) {
                ForEach(drop.files, id: \.self) { file in
                    Text(file.lastPathComponent)
                        .font(.callout.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            TextField("App", text: $app)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Application to open the files with")
            Text("The app opens on the session's display, not on your desktop. The file stays "
                 + "where it is.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { onCancel() }.keyboardShortcut(.cancelAction)
                Button("Open") { onOpen(app) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(app.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { app = drop.defaultApp }
    }
}
