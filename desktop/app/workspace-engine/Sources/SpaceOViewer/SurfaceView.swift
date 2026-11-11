import AppKit
import CoreMedia
import CoreVideo
import SpaceOKit
import SwiftUI

/// The console surface: paints stream frames into an aspect-fit layer and, while Control is on,
/// swallows local mouse and keyboard events and hands them to the input controller.
///
/// Rendering assigns each frame's IOSurface straight to the layer — zero-copy — and keeps the
/// sample buffer alive until the next frame replaces it. Input mapping uses the same aspect-fit
/// math (`MirrorInput.ViewportMapping`), so pixels and clicks cannot drift apart.
final class VMSurfaceView: NSView {

    weak var input: ViewerInputController?
    var onKey: ((_ down: Bool, _ keyCode: UInt16,
                 _ modifiers: NSEvent.ModifierFlags, _ characters: String?) -> Void)?
    var onExitControl: (() -> Void)?
    /// The window stopped being key. Falls back to `onExitControl` when unset.
    var onResignKey: (() -> Void)?
    var onCaptureRequest: (() -> Void)?
    var onPan: ((CGPoint) -> Void)?
    var onSizeChange: ((CGSize) -> Void)?
    /// SPAO-160. File URLs dropped on the console; the model asks before opening them.
    var onFileDrop: (([URL]) -> Void)?
    var displayBounds = CGRect.zero {
        didSet { if oldValue != displayBounds { needsLayout = true } }
    }
    var zoom: CGFloat = 1 {
        didSet { if oldValue != zoom { needsLayout = true } }
    }
    var pan = CGPoint.zero {
        didSet { if oldValue != pan { needsLayout = true } }
    }
    var displayName = "No display selected" {
        didSet { if oldValue != displayName { updateAccessibilityMetadata() } }
    }
    var streamRunning = false {
        didSet { if oldValue != streamRunning { updateAccessibilityMetadata() } }
    }
    var controlUnavailableReason: String? {
        didSet { if oldValue != controlUnavailableReason { updateAccessibilityMetadata() } }
    }
    var interactionEnabled = false {
        didSet {
            guard oldValue != interactionEnabled else { return }
            if interactionEnabled {
                // A new Control session cannot be a repeat of an exit sequence whose key-up was
                // lost while the previous session was closing.
                localExitKeyIsDown = false
                beginHostInputCapture()
            } else {
                endHostInputCapture()
            }
            window?.invalidateCursorRects(for: self)
            updateAccessibilityMetadata()
        }
    }

    private let contentLayer = CALayer()
    private let virtualPointerLayer = CAShapeLayer()
    private var lastSample: CMSampleBuffer?
    private var activeTrackingArea: NSTrackingArea?
    private var windowObservers: [NSObjectProtocol] = []
    private var hostCaptureActive = false
    private var useNativePointer: Bool {
        ProcessInfo.processInfo.environment["SPACEO_NATIVE_POINTER"] == "1"
    }
    private var savedHostCursorPosition: CGPoint?
    private var virtualPointer = CGPoint.zero
    /// Control turns off during the reserved key-down callback. Remember that sequence so its
    /// matching key-up (and any repeat generated before release) remains local as well.
    private var localExitKeyIsDown = false
    /// Drag-to-pan bookkeeping while zoomed and not capturing (SPAO-161). A press that never
    /// moves is still a click, and a click on the console is the request to capture input.
    private var panDragOrigin: CGPoint?
    private var panDragMoved = false

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }

    override convenience init(frame frameRect: NSRect) {
        self.init(frame: frameRect, configureForDisplay: true)
    }

    /// Event/accessibility fixtures need a real view without layer backing or drag-service
    /// registration. Both initialize desktop services. Production always configures both.
    init(frame frameRect: NSRect, configureForDisplay: Bool) {
        super.init(frame: frameRect)
        if configureForDisplay {
            wantsLayer = true
            layer?.backgroundColor = NSColor.black.cgColor
            contentLayer.contentsGravity = .resizeAspect
            layer?.addSublayer(contentLayer)
            let pointerBounds = CGRect(x: -4, y: -4, width: 8, height: 8)
            virtualPointerLayer.path = CGPath(
                ellipseIn: pointerBounds,
                transform: nil
            )
            virtualPointerLayer.fillColor = NSColor.controlAccentColor.cgColor
            virtualPointerLayer.strokeColor = NSColor.white.cgColor
            virtualPointerLayer.lineWidth = 1.5
            virtualPointerLayer.shadowColor = NSColor.black.cgColor
            virtualPointerLayer.shadowOpacity = 0.45
            virtualPointerLayer.shadowRadius = 2
            // The circle and its opaque stroke never change shape. Supply their outer
            // outline so moving the pointer does not require an alpha-derived shadow.
            let strokeOutset = virtualPointerLayer.lineWidth / 2
            virtualPointerLayer.shadowPath = CGPath(
                ellipseIn: pointerBounds.insetBy(dx: -strokeOutset, dy: -strokeOutset),
                transform: nil)
            virtualPointerLayer.isHidden = true
            layer?.addSublayer(virtualPointerLayer)
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        updateAccessibilityMetadata()
        if configureForDisplay { registerForDraggedTypes([.fileURL]) }
    }

    // MARK: - Drop to open (SPAO-160)

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard onFileDrop != nil, !droppedFileURLs(sender).isEmpty else { return [] }
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        draggingEntered(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = droppedFileURLs(sender)
        guard !urls.isEmpty else { return false }
        onFileDrop?(urls)
        return true
    }

    private func droppedFileURLs(_ sender: NSDraggingInfo) -> [URL] {
        let objects = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return objects.filter(\.isFileURL)
    }

    required init?(coder: NSCoder) {
        fatalError("VMSurfaceView is code-only")
    }

    deinit {
        endHostInputCapture()
        windowObservers.forEach(NotificationCenter.default.removeObserver)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        windowObservers.forEach(NotificationCenter.default.removeObserver)
        windowObservers.removeAll()
        guard let window else {
            endHostInputCapture()
            return
        }
        let center = NotificationCenter.default
        windowObservers.append(center.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            // The model decides: a Viewer-owned prompt waiting on the person's next chord does
            // not end Control (`ViewerControlPolicy.releasesOnResignKey`).
            guard let self else { return }
            if let onResignKey = self.onResignKey { onResignKey() } else { self.onExitControl?() }
        })
        windowObservers.append(center.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            // Control can be granted before the window is key (a deferred Take Control from
            // the menu bar or a notification lands while the window is still coming up); host
            // capture starts once it is.
            self?.beginHostInputCapture()
        })
        windowObservers.append(center.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: NSApp,
            queue: .main
        ) { [weak self] _ in
            self?.onExitControl?()
        })
        if interactionEnabled { beginHostInputCapture() }
    }

    override func layout() {
        super.layout()
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds,
            viewSize: bounds.size,
            zoom: zoom,
            pan: pan
        )
        withoutImplicitAnimation {
            contentLayer.frame = mapping.contentRect
            contentLayer.contentsGravity = .resize
            updateVirtualPointerLayer(mapping: mapping)
        }
        onSizeChange?(bounds.size)
    }

    override func resetCursorRects() {
        if useNativePointer {
            addCursorRect(bounds, cursor: .arrow)
            return
        }
        if !interactionEnabled {
            let hand: NSCursor = panDragOrigin != nil ? .closedHand : .openHand
            addCursorRect(bounds, cursor: zoom > 1 ? hand : .arrow)
        }
    }

    /// One drag step in view space as a change in the model's pan, whose unit range covers the
    /// zoomed content's overflow. Nil when there is no overflow to pan across.
    static func panDelta(viewDelta: CGPoint,
                         displayBounds: CGRect,
                         viewSize: CGSize,
                         zoom: CGFloat) -> CGPoint? {
        guard zoom > 1 else { return nil }
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds, viewSize: viewSize, zoom: zoom, pan: .zero)
        let fitted = CGSize(width: mapping.contentRect.width / zoom,
                            height: mapping.contentRect.height / zoom)
        let overflow = CGSize(width: fitted.width * (zoom - 1),
                              height: fitted.height * (zoom - 1))
        guard overflow.width > 0 || overflow.height > 0 else { return nil }
        // Dragging the picture right brings content from the left into view: pan decreases.
        return CGPoint(
            x: overflow.width > 0 ? -viewDelta.x * 2 / overflow.width : 0,
            y: overflow.height > 0 ? -viewDelta.y * 2 / overflow.height : 0
        )
    }

    // MARK: - Frames

    func present(_ sample: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample),
              let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
        else { return }
        let trace = PerformanceTrace.signposter.beginInterval("Viewer.SubmitSurface", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Viewer.SubmitSurface", trace) }
        lastSample = sample
        withoutImplicitAnimation { contentLayer.contents = surface }
    }

    func clearFrame() {
        guard lastSample != nil else { return }
        lastSample = nil
        withoutImplicitAnimation { contentLayer.contents = nil }
    }

    private func withoutImplicitAnimation(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }

    // MARK: - Pointer events

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let activeTrackingArea { removeTrackingArea(activeTrackingArea) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.activeInKeyWindow, .mouseMoved, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        activeTrackingArea = area
    }

    private func viewPoint(for event: NSEvent) -> CGPoint {
        if useNativePointer {
            return convert(event.locationInWindow, from: nil)
        }
        guard hostCaptureActive else {
            return convert(event.locationInWindow, from: nil)
        }
        if event.type == .mouseMoved
            || event.type == .leftMouseDragged
            || event.type == .rightMouseDragged {
            virtualPointer.x += event.deltaX
            virtualPointer.y += event.deltaY
            clampVirtualPointer()
            updateVirtualPointerLayer()
        }
        return virtualPointer
    }

    private func forwardPointer(_ phase: MirrorInput.PointerPhase,
                                _ button: MouseButton,
                                _ event: NSEvent) {
        guard interactionEnabled else { return }
        input?.pointer(phase, button: button,
                       viewPoint: viewPoint(for: event),
                       viewSize: bounds.size,
                       clickCount: max(1, min(3, event.clickCount)),
                       template: event.cgEvent?.copy(),
                       zoom: zoom,
                       pan: pan)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if !interactionEnabled {
            guard zoom > 1 else {
                onCaptureRequest?()
                return
            }
            // Zoomed: decide between a pan and a capture click when the button comes up.
            panDragOrigin = convert(event.locationInWindow, from: nil)
            panDragMoved = false
            window?.invalidateCursorRects(for: self)
            return
        }
        forwardPointer(.down, .left, event)
    }

    override func mouseDragged(with event: NSEvent) {
        if !interactionEnabled {
            guard let origin = panDragOrigin else { return }
            let point = convert(event.locationInWindow, from: nil)
            let viewDelta = CGPoint(x: point.x - origin.x, y: point.y - origin.y)
            // Measure from mouse-down until the gesture commits, not from the previous event:
            // many one-point steps are still a drag and must never turn into input capture.
            guard panDragMoved || hypot(viewDelta.x, viewDelta.y) > 2 else { return }
            if let delta = Self.panDelta(viewDelta: viewDelta,
                                         displayBounds: displayBounds,
                                         viewSize: bounds.size,
                                         zoom: zoom) {
                panDragMoved = true
                onPan?(delta)
            }
            panDragOrigin = point
            return
        }
        forwardPointer(.drag, .left, event)
    }

    override func mouseUp(with event: NSEvent) {
        if !interactionEnabled {
            let wasPanning = panDragOrigin != nil
            panDragOrigin = nil
            window?.invalidateCursorRects(for: self)
            if wasPanning, !panDragMoved { onCaptureRequest?() }
            panDragMoved = false
            return
        }
        forwardPointer(.up, .left, event)
    }
    override func rightMouseDown(with event: NSEvent) { forwardPointer(.down, .right, event) }
    override func rightMouseDragged(with event: NSEvent) { forwardPointer(.drag, .right, event) }
    override func rightMouseUp(with event: NSEvent) { forwardPointer(.up, .right, event) }
    override func mouseMoved(with event: NSEvent) { forwardPointer(.move, .left, event) }

    override func scrollWheel(with event: NSEvent) {
        guard interactionEnabled else {
            guard zoom > 1 else { return }
            onPan?(CGPoint(
                x: event.scrollingDeltaX / 240,
                y: event.scrollingDeltaY / 240
            ))
            return
        }
        input?.scroll(deltaX: event.scrollingDeltaX,
                      deltaY: event.scrollingDeltaY,
                      viewPoint: viewPoint(for: event),
                      viewSize: bounds.size,
                      zoom: zoom,
                      pan: pan)
    }

    // MARK: - Keyboard events

    override func keyDown(with event: NSEvent) {
        guard handleKeyEvent(event, down: true) else {
            return super.keyDown(with: event)
        }
    }

    override func keyUp(with event: NSEvent) {
        guard handleKeyEvent(event, down: false) else {
            return super.keyUp(with: event)
        }
    }

    /// While Control is on, command shortcuts belong to the selected display except for the
    /// Viewer's documented local exit. The exit is consumed here and never reaches `onKey`.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard interactionEnabled, window?.isKeyWindow == true else {
            return super.performKeyEquivalent(with: event)
        }
        return handleKeyEquivalent(event)
    }

    /// Shared by `performKeyEquivalent` and regression tests, which cannot make a window key.
    ///
    /// AppKit delivers no `keyUp:` to the responder chain while Command is held, and there is no
    /// key-equivalent path that carries `down: false`, so a forwarded equivalent would be a down
    /// with no matching up. The remote app would hold that key forever and the input controller
    /// would keep routing the key code to it, so the release is synthesized here — immediately,
    /// and only for an event that really was forwarded.
    @discardableResult
    func handleKeyEquivalent(_ event: NSEvent) -> Bool {
        let outcome = keyOutcome(event, down: true)
        if outcome == .forwarded {
            onKey?(false, event.keyCode, event.modifierFlags, event.characters)
        }
        return outcome != .notConsumed
    }

    /// What `keyOutcome` did with an event. `notConsumed` leaves it to AppKit; the other two both
    /// mean the Viewer consumed it, and differ only in whether the remote display saw it.
    enum KeyOutcome {
        case notConsumed
        case consumedLocally
        case forwarded
    }

    /// Shared by the AppKit responder methods and regression tests. Returning true means the
    /// Viewer consumed the event; `.exitControl` deliberately never calls the forwarding closure,
    /// for key-down, key-up, or a key-equivalent path.
    @discardableResult
    func handleKeyEvent(_ event: NSEvent, down: Bool) -> Bool {
        keyOutcome(event, down: down) != .notConsumed
    }

    private func keyOutcome(_ event: NSEvent, down: Bool) -> KeyOutcome {
        if event.keyCode == ViewerControlPolicy.localExitKeyCode, localExitKeyIsDown {
            if !down {
                localExitKeyIsDown = false
                return .consumedLocally
            }
            if ViewerControlPolicy.isLocalExitChord(
                keyCode: event.keyCode,
                modifiers: event.modifierFlags
            ) {
                return .consumedLocally
            }
            // A different Escape key-down means the original key-up was lost. End that stale
            // sequence and route this fresh event according to the current Control state.
            localExitKeyIsDown = false
        }
        switch ViewerControlPolicy.keyDisposition(
            interactionEnabled: interactionEnabled,
            keyCode: event.keyCode,
            modifiers: event.modifierFlags
        ) {
        case .local:
            return .notConsumed
        case .forward:
            onKey?(down, event.keyCode, event.modifierFlags, event.characters)
            return .forwarded
        case .exitControl:
            if down {
                localExitKeyIsDown = true
                onExitControl?()
            }
            return .consumedLocally
        }
    }

    private func updateAccessibilityMetadata() {
        setAccessibilityLabel(ViewerAccessibility.surfaceLabel(displayName: displayName))
        setAccessibilityValue(
            ViewerAccessibility.surfaceValue(
                streamRunning: streamRunning,
                controlEnabled: interactionEnabled
            )
        )
        setAccessibilityHelp(
            ViewerAccessibility.surfaceHelp(
                streamRunning: streamRunning,
                controlEnabled: interactionEnabled,
                controlUnavailableReason: controlUnavailableReason
            )
        )
    }

    // MARK: - Host-input capture

    private func beginHostInputCapture() {
        guard interactionEnabled,
              window?.isKeyWindow == true,
              !hostCaptureActive else { return }
        savedHostCursorPosition = useNativePointer ? nil : CGEvent(source: nil)?.location
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds,
            viewSize: bounds.size,
            zoom: zoom,
            pan: pan
        )
        let localMouse = window.map { convert($0.mouseLocationOutsideOfEventStream, from: nil) }
            ?? CGPoint(x: bounds.midX, y: bounds.midY)
        virtualPointer = mapping.contentRect.contains(localMouse)
            ? localMouse
            : CGPoint(x: mapping.contentRect.midX, y: mapping.contentRect.midY)
        clampVirtualPointer()

        // Record the takeover before it happens. Everything below belongs to the whole Mac and
        // outlives this process, so a crash between the breadcrumb and the restore is survivable
        // while a crash between the takeover and the breadcrumb is not.
        HostInputGuard.beginCapture()
        if !useNativePointer { CGAssociateMouseAndMouseCursorPosition(0) }
        _ = MirrorInput.setHostGlobalShortcutsEnabled(false)
        if !useNativePointer { NSCursor.hide() }
        hostCaptureActive = true
        virtualPointerLayer.isHidden = useNativePointer
        updateVirtualPointerLayer(mapping: mapping)
    }

    private func endHostInputCapture() {
        guard hostCaptureActive else { return }
        _ = MirrorInput.setHostGlobalShortcutsEnabled(true)
        if !useNativePointer { CGAssociateMouseAndMouseCursorPosition(1) }
        if let savedHostCursorPosition {
            CGWarpMouseCursorPosition(savedHostCursorPosition)
        }
        savedHostCursorPosition = nil
        hostCaptureActive = false
        virtualPointerLayer.isHidden = true
        if !useNativePointer { NSCursor.unhide() }
        HostInputGuard.endCapture()
    }

    private func clampVirtualPointer() {
        let mapping = MirrorInput.ViewportMapping(
            displayBounds: displayBounds,
            viewSize: bounds.size,
            zoom: zoom,
            pan: pan
        )
        guard mapping.contentRect.width > 0, mapping.contentRect.height > 0 else {
            virtualPointer = CGPoint(x: bounds.midX, y: bounds.midY)
            return
        }
        virtualPointer = CGPoint(
            x: min(mapping.contentRect.maxX.nextDown,
                   max(mapping.contentRect.minX, virtualPointer.x)),
            y: min(mapping.contentRect.maxY.nextDown,
                   max(mapping.contentRect.minY, virtualPointer.y))
        )
    }

    private func updateVirtualPointerLayer(
        mapping: MirrorInput.ViewportMapping? = nil
    ) {
        guard hostCaptureActive, !useNativePointer else {
            virtualPointerLayer.isHidden = true
            return
        }
        if let mapping, !mapping.contentRect.contains(virtualPointer) {
            virtualPointer = CGPoint(
                x: mapping.contentRect.midX,
                y: mapping.contentRect.midY
            )
        }
        virtualPointerLayer.position = virtualPointer
        virtualPointerLayer.isHidden = false
    }
}

/// SwiftUI wrapper for the console surface.
///
/// Each surface registers its own frame sink, so a second console window (⌘N) streams alongside
/// the first instead of stealing its frames.
struct StreamSurface: NSViewRepresentable {
    @Environment(ViewerModel.self) private var model

    final class Coordinator {
        let sinkID = UUID()
        weak var model: ViewerModel?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    static func dismantleNSView(_ nsView: VMSurfaceView, coordinator: Coordinator) {
        coordinator.model?.removeFrameSink(coordinator.sinkID)
    }

    func makeNSView(context: Context) -> VMSurfaceView {
        let view = VMSurfaceView(frame: .zero)
        context.coordinator.model = model
        view.input = model.input
        view.onKey = { [weak input = model.input] down, keyCode, modifiers, characters in
            input?.key(down: down, keyCode: keyCode,
                       modifiers: modifiers, characters: characters)
        }
        view.onExitControl = { [weak model] in
            model?.endHumanControl()
        }
        view.onResignKey = { [weak model] in
            model?.surfaceResignedKey()
        }
        view.onCaptureRequest = { [weak model] in
            model?.beginHumanControl()
        }
        view.onPan = { [weak model] delta in
            model?.pan(by: delta)
        }
        view.onSizeChange = { [weak model] size in
            model?.reportSurfaceSize(size)
        }
        view.onFileDrop = { [weak model] urls in
            model?.requestOpenFiles(urls)
        }
        model.addFrameSink(context.coordinator.sinkID) { [weak view] sample in
            view?.present(sample)
        }
        return view
    }

    func updateNSView(_ view: VMSurfaceView, context: Context) {
        let interactive = model.interactionEnabled
            && model.selected != nil
            && model.streamRunning
        view.displayName = model.interactionDisplay?.name ?? "No display selected"
        view.displayBounds = model.interactionDisplay?.bounds ?? .zero
        view.zoom = model.viewportZoom
        view.pan = model.viewportPan
        view.streamRunning = model.streamRunning
        let controlRequest = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: model.selected != nil,
            selectedDisplayIsSpaceO: model.selected?.isSpaceO == true,
            hasActiveSession: !model.sessionsOnSelectedDisplay.isEmpty,
            streamRunning: model.streamRunning,
            screenRecordingGranted: model.permissions.screenRecording,
            accessibilityGranted: model.permissions.accessibility
        )
        if case let .blocked(reason) = controlRequest {
            view.controlUnavailableReason = reason
        } else {
            view.controlUnavailableReason = nil
        }
        view.interactionEnabled = interactive
        if interactive, view.window?.firstResponder !== view {
            view.window?.makeFirstResponder(view)
        }
        if model.selected == nil || !model.streamState.isLive {
            view.clearFrame()
        }
    }
}
