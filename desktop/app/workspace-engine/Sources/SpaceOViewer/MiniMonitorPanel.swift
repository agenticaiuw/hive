import AppKit
import Observation
import CoreMedia
import CoreVideo
import SpaceOKit

/// SPAO-217. A small always-on-top live view of the selected tile. It is another frame sink on
/// the same stream, so it follows the selection for free and costs no second capture.
///
/// It has no input path to the session at all: no capture, no call into `beginHumanControl`.
/// Watching from the corner of a screen must never become driving. The only controls are its
/// own: a close button on hover, a right-click menu, and double-click to open the Viewer.
@MainActor
final class MiniMonitorController {
    static let shared = MiniMonitorController()

    static let width: CGFloat = 320
    private static let sinkID = "mini-monitor"

    private var panel: NSPanel?
    private var view: MiniMonitorView?
    /// Bumped on every show and hide, so a stale observation chain stops at its next change.
    private var observation: UInt64 = 0
    private var lastBounds: CGRect = .zero

    var isVisible: Bool { panel?.isVisible == true }

    func setVisible(_ visible: Bool, model: ViewerModel) {
        if visible { show(model: model) } else { hide(model: model) }
        model.miniMonitorVisible = isVisible
    }

    private func show(model: ViewerModel) {
        let panel = self.panel ?? makePanel()
        let view = self.view ?? MiniMonitorView(frame: panel.contentRect(forFrameRect: panel.frame))
        view.onHide = { [weak self, weak model] in
            guard let self, let model else { return }
            self.setVisible(false, model: model)
        }
        view.onOpenViewer = { [weak model] in model?.windowRequested = true }
        view.onToggleClickThrough = { [weak model] in
            guard let model else { return }
            model.setMiniMonitorClickThrough(!model.preferences.miniMonitorClickThrough)
        }
        self.panel = panel
        self.view = view
        panel.contentView = view
        model.addFrameSink(Self.sinkID) { [weak view] sample in
            view?.present(sample)
        }
        observation &+= 1
        observe(model, generation: observation)
        panel.orderFrontRegardless()
    }

    private func hide(model: ViewerModel) {
        model.removeFrameSink(Self.sinkID)
        observation &+= 1
        panel?.orderOut(nil)
        view?.clearFrame()
    }

    /// Re-syncs whenever something `sync` read changes, and only then. Observation fires
    /// before the mutation lands, so the next pass reads the new state a turn later.
    private func observe(_ model: ViewerModel, generation: UInt64) {
        guard generation == observation else { return }
        withObservationTracking {
            sync(with: model)
        } onChange: { [weak self, weak model] in
            DispatchQueue.main.async {
                guard let self, let model else { return }
                self.observe(model, generation: generation)
            }
        }
    }

    private func sync(with model: ViewerModel) {
        guard let panel, let view else { return }
        panel.ignoresMouseEvents = model.preferences.miniMonitorClickThrough
        view.clickThrough = model.preferences.miniMonitorClickThrough
        let bounds = model.interactionDisplay?.bounds ?? .zero
        view.displayBounds = bounds
        if !model.streamState.isLive { view.clearFrame() }
        guard bounds != lastBounds, bounds.width > 0, bounds.height > 0 else { return }
        lastBounds = bounds
        let height = max(60, (Self.width * bounds.height / bounds.width).rounded())
        var frame = panel.frame
        frame.origin.y += frame.height - height
        frame.size = CGSize(width: Self.width, height: height)
        panel.setFrame(frame, display: true)
    }

    private func makePanel() -> NSPanel {
        // The screen the console is on, so it appears where the person is already looking.
        let consoleScreen = NSApp.windows.first {
            $0.identifier?.rawValue.hasPrefix(SpaceOViewerApp.mainWindowID) == true && $0.isVisible
        }?.screen
        let screen = (consoleScreen ?? NSScreen.main)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1_440, height: 900)
        let size = CGSize(width: Self.width, height: 180)
        let origin = CGPoint(x: screen.maxX - size.width - 24, y: screen.maxY - size.height - 24)
        let panel = NSPanel(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .black
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.title = "SpaceO Mini Monitor"
        panel.setAccessibilityLabel("SpaceO Mini Monitor")
        return panel
    }
}

/// Paints stream frames aspect-fit. Never a first responder: a click moves the panel, a
/// double-click opens the Viewer, and with click-through on every click falls to whatever is
/// underneath (hide it from the Window menu or ⌥⌘M then).
final class MiniMonitorView: NSView {
    var onHide: (() -> Void)?
    var onOpenViewer: (() -> Void)?
    var onToggleClickThrough: (() -> Void)?
    var clickThrough = false
    private let closeButton = NSButton()
    private var hoverArea: NSTrackingArea?

    var displayBounds: CGRect = .zero {
        didSet { if oldValue != displayBounds { needsLayout = true } }
    }

    private let contentLayer = CALayer()
    private var lastSample: CMSampleBuffer?

    override var acceptsFirstResponder: Bool { false }
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        contentLayer.contentsGravity = .resizeAspect
        layer?.addSublayer(contentLayer)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Live view of the selected SpaceO session. View only.")

        let symbol = NSImage(systemSymbolName: "xmark.circle.fill",
                             accessibilityDescription: "Hide Mini Monitor")
        closeButton.image = symbol?.withSymbolConfiguration(
            .init(pointSize: 16, weight: .semibold).applying(.init(paletteColors: [
                .white, NSColor.black.withAlphaComponent(0.6)])))
        closeButton.isBordered = false
        closeButton.imagePosition = .imageOnly
        closeButton.target = self
        closeButton.action = #selector(hide)
        closeButton.toolTip = "Hide Mini Monitor (⌥⌘M)"
        closeButton.setAccessibilityLabel("Hide Mini Monitor")
        closeButton.alphaValue = 0
        closeButton.frame = CGRect(x: 8, y: 8, width: 22, height: 22)
        addSubview(closeButton)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self)
        addTrackingArea(area)
        hoverArea = area
    }

    override func mouseEntered(with event: NSEvent) { setCloseButtonVisible(true) }
    override func mouseExited(with event: NSEvent) { setCloseButtonVisible(false) }

    private func setCloseButtonVisible(_ visible: Bool) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            closeButton.animator().alphaValue = visible ? 1 : 0
        }
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onOpenViewer?()
            return
        }
        super.mouseDown(with: event)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Viewer", action: #selector(openViewer), keyEquivalent: "")
            .target = self
        let passThrough = menu.addItem(withTitle: "Clicks Pass Through",
                                       action: #selector(toggleClickThrough), keyEquivalent: "")
        passThrough.target = self
        passThrough.state = clickThrough ? .on : .off
        menu.addItem(.separator())
        menu.addItem(withTitle: "Hide Mini Monitor", action: #selector(hide), keyEquivalent: "")
            .target = self
        return menu
    }

    @objc private func hide() { onHide?() }
    @objc private func openViewer() { onOpenViewer?() }
    @objc private func toggleClickThrough() { onToggleClickThrough?() }

    required init?(coder: NSCoder) {
        fatalError("MiniMonitorView is code-only")
    }

    override func layout() {
        super.layout()
        let mapping = MirrorInput.ViewportMapping(displayBounds: displayBounds, viewSize: bounds.size)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        contentLayer.frame = mapping.contentRect == .zero ? bounds : mapping.contentRect
        CATransaction.commit()
    }

    func present(_ sample: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        let trace = PerformanceTrace.signposter.beginInterval("Viewer.SubmitSurface", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Viewer.SubmitSurface", trace) }
        lastSample = sample
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        contentLayer.contents = surface
        CATransaction.commit()
    }

    func clearFrame() {
        guard lastSample != nil else { return }
        lastSample = nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        contentLayer.contents = nil
        CATransaction.commit()
    }
}
