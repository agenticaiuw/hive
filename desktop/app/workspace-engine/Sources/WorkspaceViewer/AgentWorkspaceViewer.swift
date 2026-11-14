// The window where the user watches the agent's workspace and can take it over. It opens by itself
// the first time the workspace display appears; once the user closes it, it stays closed until
// they take control (right Option, or the window's button). While they hold control the agent's
// input is paused, and their clicks and keys in the window go to the workspace's apps.
//
// `<state>/workspace-viewer-visible` holds "1" while the window is open: Hive speaks aloud only
// then, and never reopens a viewer the user closed.
import AppKit
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import WorkspaceCore
import WorkspaceDisplay

public final class AgentWorkspaceViewer: NSObject, NSWindowDelegate, SCStreamOutput, SCStreamDelegate {
    let state = Paths.stateDir()
    private var window: NSWindow?
    private let screen = WorkspaceScreenView()
    private let status = NSTextField(labelWithString: "")
    private let control = NSButton(title: "Take Control", target: nil, action: nil)
    private var stream: SCStream?
    private let frames = DispatchQueue(label: "hive.workspace-viewer.frames")
    private var client: DaemonClient?
    private var displayID: UInt32?
    private var displaySize = CGSize(width: 1440, height: 900)
    private var timer: Timer?
    private var flagsMonitor: Any?
    private var shownOnce = false
    private var inControl = false

    public override init() {
        super.init()
        writeVisible(false)
        screen.viewer = self
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        // Right Option (key code 61) hands the workspace to the user.
        flagsMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            if event.keyCode == 61 && event.modifierFlags.contains(.option) {
                DispatchQueue.main.async { self?.takeControl() }
            }
        }
        refresh()
    }

    public func shutdown() {
        timer?.invalidate()
        timer = nil
        if let flagsMonitor { NSEvent.removeMonitor(flagsMonitor) }
        flagsMonitor = nil
        stopStream()
        window?.delegate = nil
        window?.close()
        window = nil
        writeVisible(false)
        client?.close()
        client = nil
    }

    /// The user resumed the agent after taking over: give the workspace back.
    public func resumeAfterTakeover() {
        giveBack()
    }

    // MARK: following the workspace

    private func refresh() {
        let text = (try? String(contentsOf: state.appendingPathComponent("workspace-display-id"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let online = Set(HiveWorkspaceDisplaysOnline().map(\.uint32Value))
        guard let id = text.flatMap(UInt32.init), online.contains(id) else {
            if displayID != nil {
                displayID = nil
                stopStream()
                status.stringValue = "The workspace is closed."
            }
            return
        }
        if displayID != id {
            displayID = id
            let bounds = CGDisplayBounds(id)
            displaySize = bounds.size
            if !shownOnce {
                shownOnce = true
                show()
            } else if window?.isVisible == true {
                startStream()
            }
        }
        updateStatus()
    }

    private func show() {
        if window == nil { makeWindow() }
        window?.makeKeyAndOrderFront(nil)
        writeVisible(true)
        startStream()
        updateStatus()
    }

    private func makeWindow() {
        let visible = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let scale = min(0.6 * visible.width / displaySize.width, 0.6 * visible.height / displaySize.height, 1)
        let size = CGSize(width: displaySize.width * scale, height: displaySize.height * scale + 36)
        let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: visible.maxX - size.width - 24, y: visible.minY + 24), size: size),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Hive Workspace"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentAspectRatio = CGSize(width: displaySize.width, height: displaySize.height + 36 / scale)

        let content = NSView()
        screen.translatesAutoresizingMaskIntoConstraints = false
        status.translatesAutoresizingMaskIntoConstraints = false
        control.translatesAutoresizingMaskIntoConstraints = false
        control.target = self
        control.action = #selector(toggleControl)
        control.bezelStyle = .rounded
        status.lineBreakMode = .byTruncatingTail
        content.addSubview(screen)
        content.addSubview(status)
        content.addSubview(control)
        NSLayoutConstraint.activate([
            screen.topAnchor.constraint(equalTo: content.topAnchor),
            screen.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            screen.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            screen.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -36),
            status.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            status.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            status.trailingAnchor.constraint(lessThanOrEqualTo: control.leadingAnchor, constant: -8),
            control.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -10),
            control.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
        ])
        window.contentView = content
        self.window = window
    }

    public func windowWillClose(_ notification: Notification) {
        stopStream()
        writeVisible(false)
    }

    private func writeVisible(_ visible: Bool) {
        let url = state.appendingPathComponent("workspace-viewer-visible")
        try? FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        try? Data((visible ? "1\n" : "0\n").utf8).write(to: url, options: .atomic)
    }

    private func updateStatus() {
        guard displayID != nil else { return }
        control.title = inControl ? "Give Back to Agent" : "Take Control"
        status.stringValue = inControl ? "You have control; the agent is paused." : "The agent is working here. Right Option takes control."
    }

    // MARK: the picture

    private func startStream() {
        stopStream()
        guard let id = displayID, CGPreflightScreenCaptureAccess() else {
            status.stringValue = "Hive needs Screen Recording permission to show the workspace."
            return
        }
        let size = displaySize
        Task { [weak self] in
            guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
                  let display = content.displays.first(where: { $0.displayID == id }), let self else { return }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(size.width * 2)
            configuration.height = Int(size.height * 2)
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            configuration.showsCursor = false
            configuration.queueDepth = 4
            let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.frames)
                try await stream.startCapture()
                await MainActor.run { self.stream = stream }
            } catch {
                await MainActor.run { self.status.stringValue = "The workspace picture couldn't start: \(error.localizedDescription)" }
            }
        }
    }

    private func stopStream() {
        guard let stream else { return }
        self.stream = nil
        stream.stopCapture { _ in }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixels = sampleBuffer.imageBuffer,
              let surface = CVPixelBufferGetIOSurface(pixels)?.takeUnretainedValue() else { return }
        DispatchQueue.main.async { [weak self] in self?.screen.layer?.contents = surface }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            if self?.stream === stream { self?.stream = nil }
        }
    }

    // MARK: control

    private func daemon() -> DaemonClient? {
        if let client, client.isOpen { return client }
        client = DaemonClient(path: Wire.socketPath(state: state), role: "viewer")
        return client
    }

    @objc private func toggleControl() {
        inControl ? giveBack() : takeControl()
    }

    func takeControl() {
        guard displayID != nil else { NSSound.beep(); return }
        if window?.isVisible != true { show() }
        do {
            try daemon()?.send("pause", ["reason": "operator"], timeout: 5)
            inControl = true
            window?.makeKeyAndOrderFront(nil)
            window?.makeFirstResponder(screen)
        } catch {
            status.stringValue = "Couldn't take control: \(error)"
        }
        updateStatus()
    }

    func giveBack() {
        guard inControl else { return }
        _ = try? daemon()?.send("resume", timeout: 5)
        inControl = false
        updateStatus()
    }

    /// A point in the window's picture, in workspace points.
    func workspacePoint(_ event: NSEvent) -> CGPoint? {
        let local = screen.convert(event.locationInWindow, from: nil)
        guard screen.bounds.contains(local), screen.bounds.width > 0, screen.bounds.height > 0 else { return nil }
        return CGPoint(x: local.x / screen.bounds.width * displaySize.width,
                       y: (screen.bounds.height - local.y) / screen.bounds.height * displaySize.height)
    }

    func forward(_ fields: [String: Any]) {
        guard inControl else { return }
        DispatchQueue.global().async { [weak self] in
            _ = try? self?.daemon()?.send("operator_input", fields, timeout: 10)
        }
    }

    func mouse(_ event: NSEvent, right: Bool) {
        guard let point = workspacePoint(event) else { return }
        forward(["kind": "click", "x": point.x, "y": point.y, "button": right ? "right" : "left", "count": event.clickCount])
    }

    func scroll(_ event: NSEvent) {
        guard let point = workspacePoint(event) else { return }
        let dy = Int((-event.scrollingDeltaY / (event.hasPreciseScrollingDeltas ? 10 : 1)).rounded())
        let dx = Int((-event.scrollingDeltaX / (event.hasPreciseScrollingDeltas ? 10 : 1)).rounded())
        if dx != 0 || dy != 0 { forward(["kind": "scroll", "x": point.x, "y": point.y, "dx": dx, "dy": dy]) }
    }

    static let keyNames: [UInt16: String] = [
        36: "return", 48: "tab", 51: "delete", 53: "escape", 117: "forward_delete", 115: "home", 119: "end",
        116: "page_up", 121: "page_down", 123: "left", 124: "right", 125: "down", 126: "up",
    ]

    func key(_ event: NSEvent) {
        var modifiers: [String] = []
        if event.modifierFlags.contains(.command) { modifiers.append("cmd") }
        if event.modifierFlags.contains(.control) { modifiers.append("ctrl") }
        if event.modifierFlags.contains(.option) { modifiers.append("option") }
        if let name = Self.keyNames[event.keyCode] {
            if event.modifierFlags.contains(.shift) { modifiers.append("shift") }
            forward(["kind": "key", "key": (modifiers + [name]).joined(separator: "+")])
        } else if !modifiers.isEmpty, let base = event.charactersIgnoringModifiers?.lowercased(), base.count == 1 {
            if event.modifierFlags.contains(.shift) { modifiers.append("shift") }
            forward(["kind": "key", "key": (modifiers + [base]).joined(separator: "+")])
        } else if let characters = event.characters, !characters.isEmpty {
            forward(["kind": "type", "text": characters])
        }
    }
}

/// The picture; it passes the user's input to the viewer while they hold control.
final class WorkspaceScreenView: NSView {
    weak var viewer: AgentWorkspaceViewer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.contentsGravity = .resize
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) { viewer?.mouse(event, right: false) }
    override func rightMouseDown(with event: NSEvent) { viewer?.mouse(event, right: true) }
    override func scrollWheel(with event: NSEvent) { viewer?.scroll(event) }
    override func keyDown(with event: NSEvent) { viewer?.key(event) }
}
