import CoreGraphics
import Foundation
import SwiftUI

/// SPAO-161. What the console remembers, how zoom modes resolve, and how the saved selection
/// comes back on the first poll. Nothing here can enter Control: `ViewerPreferences` has no
/// field for it by design.
extension ViewerModel {

    // MARK: - Persistence

    func updatePreferences(_ change: (inout ViewerPreferences) -> Void) {
        var next = preferences
        change(&next)
        guard next != preferences else { return }
        preferences = next
        schedulePreferencesSave()
    }

    private func schedulePreferencesSave() {
        guard let preferencesStore else { return }
        preferencesSaveTask?.cancel()
        preferencesSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let self else { return }
            preferencesStore.save(self.preferences)
        }
    }

    /// Write immediately; the app delegate calls this on quit so the debounce cannot lose the
    /// last change.
    func flushPreferences() {
        preferencesSaveTask?.cancel()
        preferencesStore?.save(preferences)
    }

    func applyLoadedPreferences(_ loaded: ViewerPreferences) {
        preferences = loaded
        zoomMode = loaded.zoomMode
        inspectorSection = loaded.inspectorSection
        inspectorVisible = loaded.inspectorVisible
        columnVisibility = loaded.sidebarVisible ? .all : .detailOnly
        applyZoomMode()
    }

    func rememberSelection() {
        updatePreferences {
            $0.canvasMode = canvasMode
            $0.selectedSessionID = canvasMode == .session ? selectedSessionID : nil
            $0.selectedDisplayID = selectedID
        }
    }

    /// Re-apply the saved selection once, on the first poll that can honour it. Returns true
    /// when a selection was made, so the caller's own fallback selection does not run as well.
    func restoreRememberedSelectionIfNeeded() -> Bool {
        guard !selectionRestored, preferencesStore != nil else { return false }
        selectionRestored = true
        switch preferences.canvasMode {
        case .session:
            if let id = preferences.selectedSessionID,
               sessions.contains(where: { $0.id == id && $0.runtimeAttached != false }) {
                // Selecting a session opens Overview for a fresh look; a restore is a return
                // to where the person left off, so the remembered section wins.
                let remembered = preferences.inspectorSection
                selectSession(id)
                inspectorSection = remembered
                return true
            }
        case .display:
            if let displayID = preferences.selectedDisplayID,
               displays.contains(where: { $0.id == displayID }) {
                selectDisplay(displayID)
                return true
            }
        }
        return false
    }

    // MARK: - Zoom

    func setZoomMode(_ mode: ViewerZoomMode) {
        zoomMode = mode
        updatePreferences { $0.zoomMode = mode }
        applyZoomMode()
    }

    func zoomToFit() { setZoomMode(.fit) }

    func zoomToActualSize() { setZoomMode(.actualSize) }

    func zoomIn() {
        setZoom(CGFloat(ViewerZoom.clamp(Double(viewportZoom) + ViewerZoom.step)))
    }

    func zoomOut() {
        setZoom(CGFloat(ViewerZoom.clamp(Double(viewportZoom) - ViewerZoom.step)))
    }

    var canZoomIn: Bool { Double(viewportZoom) < ViewerZoom.maximum && selected != nil }
    var canZoomOut: Bool { viewportZoom > 1 }

    func reportSurfaceSize(_ size: CGSize) {
        guard size != surfaceSize else { return }
        surfaceSize = size
        if zoomMode == .actualSize { applyZoomMode() }
    }

    func applyZoomMode() {
        let bounds = interactionDisplay?.bounds ?? selected?.bounds ?? .zero
        let resolved = CGFloat(ViewerZoom.zoom(
            for: zoomMode, displayBounds: bounds, viewSize: surfaceSize))
        if resolved != viewportZoom { viewportZoom = resolved }
        if viewportZoom <= 1, viewportPan != .zero { viewportPan = .zero }
    }

    // MARK: - Toggles

    func showInspector(_ section: ViewerInspectorSection) {
        inspectorSection = section
        inspectorVisible = true
    }

    func toggleInspector() { inspectorVisible.toggle() }

    func setShowAgentActions(_ show: Bool) {
        updatePreferences { $0.showAgentActions = show }
    }

    var showAgentActions: Bool { preferences.showAgentActions }
}
