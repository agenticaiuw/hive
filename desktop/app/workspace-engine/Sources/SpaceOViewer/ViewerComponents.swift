import AppKit
import SpaceOKit
import SwiftUI

// MARK: - App icons

/// Icons for the apps inside a session. Resolved once per bundle (or process) and kept: the
/// sidebar redraws on every poll, and a LaunchServices lookup per row per poll adds up.
@MainActor
enum AppIconProvider {
    private static var cache: [String: NSImage?] = [:]
    private static let cacheLimit = 256

    static func icon(for app: AppInfo) -> NSImage? {
        if let bundleID = app.bundleID, !bundleID.isEmpty,
           let icon = cached("bundle:\(bundleID)", {
               NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
                   .map { NSWorkspace.shared.icon(forFile: $0.path) }
           }) {
            return icon
        }
        // Not registered with LaunchServices (a build run from anywhere): ask the process.
        return cached("pid:\(app.pid)") {
            NSRunningApplication(processIdentifier: app.pid)?.icon
        }
    }

    private static func cached(_ key: String, _ resolve: () -> NSImage?) -> NSImage? {
        if let hit = cache[key] { return hit }
        if cache.count >= cacheLimit { cache.removeAll(keepingCapacity: true) }
        let image = resolve()
        cache[key] = .some(image)
        return image
    }
}

struct AppIconView: View {
    let app: AppInfo?
    var size: CGFloat = 20

    var body: some View {
        if let app, let image = AppIconProvider.icon(for: app) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .fill(.quaternary)
                .overlay {
                    Image(systemName: "macwindow")
                        .font(.system(size: size * 0.5))
                        .foregroundStyle(.secondary)
                }
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

struct SessionIconView: View {
    let session: SessionInfo
    let status: ViewerSessionStatus
    var size: CGFloat = 28

    var body: some View {
        AppIconView(app: session.apps.first, size: size)
            .overlay(alignment: .bottomTrailing) {
                StatusDot(kind: status.kind, size: size * 0.4)
                    .offset(x: size * 0.1, y: size * 0.1)
            }
            .padding(.trailing, size * 0.08)
    }
}

// MARK: - Status

/// The small indicator used everywhere a session's status appears. A help request changes
/// the shape as well as the colour, so colour never carries the state alone.
struct StatusDot: View {
    let kind: ViewerSessionStatus.Kind
    var size: CGFloat = 9

    var body: some View {
        ZStack {
            Circle()
                .fill(fill)
            if kind == .needsYou || kind == .breach {
                Image(systemName: kind == .needsYou ? "hand.raised.fill" : "exclamationmark")
                    .font(.system(size: size * 0.55, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: max(1, size * 0.14)))
        .accessibilityHidden(true)
    }

    private var fill: Color {
        kind == .idle ? Color.gray.opacity(0.55) : kind.color
    }
}

struct StatusBadge: View {
    let status: ViewerSessionStatus

    var body: some View {
        Label(status.title, systemImage: status.kind.systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(status.kind == .idle ? Color.secondary : status.kind.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                (status.kind == .idle ? Color.secondary : status.kind.color).opacity(0.14),
                in: Capsule())
            .accessibilityElement(children: .combine)
    }
}

// MARK: - Notices

/// One message above the canvas: a daemon problem, a missing permission, a failed stream, an
/// agent asking for help. Every notice has the same shape so none reads as more urgent than
/// its severity says.
struct NoticeCard<Actions: View>: View {
    let tint: Color
    let systemImage: String
    let title: String
    var message: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                if let message, !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) { actions }
                .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: ViewerStyle.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: ViewerStyle.cornerRadius, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

extension NoticeCard where Actions == EmptyView {
    init(tint: Color, systemImage: String, title: String, message: String? = nil) {
        self.init(tint: tint, systemImage: systemImage, title: title, message: message) {
            EmptyView()
        }
    }
}

// MARK: - Canvas chrome

struct CanvasPill: View {
    let text: String
    var systemImage: String?
    var tint: Color = .black

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(tint == .black ? 0.72 : 0.9), in: Capsule())
        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
    }
}

/// A copy-to-clipboard button for identifiers and snippets. An explicit click is the one place
/// the Viewer may write the general pasteboard on the person's behalf.
struct CopyButton: View {
    let text: String
    var label = "Copy"
    @State private var copied = false

    var body: some View {
        Button {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            copied = true
        } label: {
            Label(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            copied = false
        }
    }
}

// MARK: - Activity

/// Twelve bars covering the last minute of one session's agent input, so an idle agent is
/// obvious without reading a timestamp.
struct ActivitySparklineView: View {
    let buckets: [Int]

    var body: some View {
        let peak = max(1, buckets.max() ?? 1)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(buckets.enumerated()), id: \.offset) { entry in
                RoundedRectangle(cornerRadius: 1)
                    .fill(entry.element == 0 ? Color.secondary.opacity(0.25) : Color.accentColor)
                    .frame(width: 4, height: 3 + 11 * CGFloat(entry.element) / CGFloat(peak))
            }
        }
        .frame(height: 14, alignment: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let total = buckets.reduce(0, +)
        return total == 0 ? "No agent actions in the last minute"
            : "\(total) agent action\(total == 1 ? "" : "s") in the last minute"
    }
}
