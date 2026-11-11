import AppKit
import SpaceOKit
import SwiftUI

/// Walks the person through one macOS permission: why SpaceO needs it, the exact switch, and
/// what to do after flipping it. Watches the grant live and closes itself once it lands.
struct PermissionGuideSheet: View {
    @Environment(ViewerModel.self) private var model
    let kind: ViewerPermissionKind
    let onDone: () -> Void

    var body: some View {
        let granted = model.isGranted(kind)
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                Image(systemName: kind.systemImage)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Color.blue.gradient,
                                in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(kind.title).font(.title2.weight(.semibold))
                    Text(kind.reason)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 14) {
                step(1, "Open Privacy & Security in System Settings.") {
                    Button("Open System Settings") { model.openSettings(for: kind) }
                        .buttonStyle(.borderedProminent)
                }
                step(2, "Under \(kind.settingName), turn on \(model.grantee(for: kind)).") {
                    if kind.isViewerPermission {
                        Button("Show App in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
                        }
                        .help("If it isn't listed, click + in System Settings and choose it, or drag "
                              + "it into the list.")
                    }
                }
                step(3, afterText) {
                    if kind.needsRelaunch {
                        Button("Quit & Reopen") { model.relaunchViewer() }
                    } else if !kind.isViewerPermission {
                        HStack(spacing: 6) {
                            Text("spaceo daemon restart --operator")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color(nsColor: .textBackgroundColor),
                                            in: RoundedRectangle(cornerRadius: 5))
                            CopyButton(text: "spaceo daemon restart --operator")
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                        }
                    }
                }
            }
            .padding(16)
            .background(.background.secondary,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack(spacing: 8) {
                if granted {
                    Label("Allowed", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.callout.weight(.semibold))
                } else {
                    ProgressView().controlSize(.small)
                    Text("Waiting for the permission…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(granted ? "Done" : "Not Now") { onDone() }
                    .keyboardShortcut(granted ? .defaultAction : .cancelAction)
            }
        }
        .padding(24)
        .frame(width: 520)
        .task(id: granted) {
            // Once it lands there is nothing left to explain, unless a relaunch still is.
            guard granted, !kind.needsRelaunch else { return }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            onDone()
        }
    }

    private var afterText: String {
        if kind.needsRelaunch {
            return "Quit and reopen the Viewer. macOS applies Screen Recording from the next launch."
        }
        if kind.isViewerPermission {
            return "That's it. The Viewer notices within a couple of seconds."
        }
        return "Restart the SpaceO daemon so it picks up the change."
    }

    private func step<Accessory: View>(_ number: Int, _ text: String,
                                       @ViewBuilder accessory: () -> Accessory) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.callout.weight(.bold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 22, height: 22)
                .background(Color.accentColor.opacity(0.15), in: Circle())
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                accessory()
            }
        }
        .accessibilityElement(children: .contain)
    }
}
