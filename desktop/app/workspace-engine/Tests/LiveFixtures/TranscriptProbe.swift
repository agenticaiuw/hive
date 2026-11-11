// Deliberately outside the safe XCTest target: executing this fixture creates an app window.
// Compile only during source verification; follow docs/LIVE_TESTS.md before executing.
import AppKit
import MetalKit

final class Evidence: @unchecked Sendable {
    private let lock = NSLock()
    private var submissions = 0
    private var completions = 0
    private var failures = 0
    private var callbacks = 0
    private var timestamps: [Double] = []

    func submit() -> Int { lock.lock(); defer { lock.unlock() }; submissions += 1; return submissions }
    func complete(_ failed: Bool) { lock.lock(); defer { lock.unlock() }; completions += 1; if failed { failures += 1 } }
    func presented(_ time: Double) {
        lock.lock(); defer { lock.unlock() }
        callbacks += 1
        if time.isFinite && time > 0 { timestamps.append(time) }
    }
    func report(displayID: UInt32, visible: Bool, mode: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["schemaVersion": 1, "fixture": "SpaceO synthetic presentation probe",
                "inputRoute": "none", "destinationDisplayID": displayID,
                "captureSourceDisplayID": NSNull(), "mode": mode,
                "submittedWork": submissions, "gpuCompletions": completions,
                "gpuFailures": failures, "presentationCallbacks": callbacks,
                "nonzeroPresentationTimestamps": timestamps,
                "freshCapturedFrames": NSNull(), "windowOcclusionVisible": visible,
                "visibility": "unknown", "callbackDrainSeconds": 2]
    }
}

final class Probe: NSObject, NSApplicationDelegate, MTKViewDelegate {
    let displayID: UInt32
    let seconds: Double
    let delay: Double
    let mode: String
    let evidence = Evidence()
    var window: NSWindow?
    var view: MTKView?
    var queue: MTLCommandQueue?
    var frameLabel: NSTextField?

    init(displayID: UInt32, seconds: Double, delay: Double, mode: String) {
        self.displayID = displayID; self.seconds = seconds; self.delay = delay; self.mode = mode
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        // A menu-bar-shaped launch remains alive without a window, then creates Settings.
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.openWindow() }
    }
    func openWindow() {
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        }), let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
            FileHandle.standardError.write(Data("explicit display or Metal device unavailable\n".utf8))
            exit(1)
        }
        self.queue = queue
        let cover = mode == "cover"
        let frame = cover ? screen.frame : NSRect(x: screen.frame.minX + 40, y: screen.frame.minY + 40, width: 560, height: 632)
        let window = NSWindow(contentRect: frame,
            styleMask: cover ? [.borderless] : [.titled, .closable, .resizable], backing: .buffered, defer: false, screen: screen)
        window.title = "SpaceO synthetic fixture"
        window.isReleasedWhenClosed = false
        let view = MTKView(frame: NSRect(origin: .zero, size: frame.size), device: device)
        view.delegate = self
        view.preferredFramesPerSecond = 60
        let label = NSTextField(labelWithString: "SpaceO synthetic frame 0")
        label.textColor = .white
        label.font = .monospacedSystemFont(ofSize: 24, weight: .bold)
        label.frame = NSRect(x: 20, y: 20, width: 510, height: 40)
        view.addSubview(label)
        window.contentView = view
        window.orderFront(nil) // no makeKey or activation
        self.window = window; self.view = view; self.frameLabel = label
        if ProcessInfo.processInfo.environment["SPACEO_PERF_PROBE_READY"] == "1" {
            FileHandle.standardOutput.write(Data("{\"ready\":true}\n".utf8))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            view.isPaused = true
            // Stop submitting, then give outstanding GPU/presentation callbacks a bounded drain.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.finish() }
        }
    }
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}
    func draw(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let descriptor = view.currentRenderPassDescriptor,
              let command = queue?.makeCommandBuffer() else { return }
        let counter = evidence.submit()
        let phase = Double(counter % 120) / 120
        descriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0.1 + phase * 0.7, green: 0.2, blue: 0.8 - phase * 0.6, alpha: 1)
        descriptor.colorAttachments[0].loadAction = .clear
        guard let encoder = command.makeRenderCommandEncoder(descriptor: descriptor) else { evidence.complete(true); return }
        encoder.endEncoding()
        let evidence = self.evidence
        drawable.addPresentedHandler { evidence.presented($0.presentedTime) }
        command.addCompletedHandler { evidence.complete($0.status == .error) }
        command.present(drawable)
        command.commit()
        frameLabel?.stringValue = "SpaceO synthetic frame \(counter)"
    }
    func finish() {
        let report = evidence.report(displayID: displayID, visible: window?.occlusionState.contains(.visible) == true, mode: mode)
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
        window?.close()
        NSApp.terminate(nil)
    }
}

@main enum Main {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        func value(_ key: String) -> String? {
            guard let index = arguments.firstIndex(of: key), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        guard ProcessInfo.processInfo.environment["SPACEO_TRANSCRIPT_PROBE_LIVE"] == "1",
              let raw = value("--display-id"), let displayID = UInt32(raw), displayID > 0 else {
            FileHandle.standardError.write(Data("Follow docs/LIVE_TESTS.md; opt in with SPACEO_TRANSCRIPT_PROBE_LIVE=1 and an explicit --display-id. No physical-display fallback.\n".utf8))
            exit(2)
        }
        let seconds = Double(value("--duration") ?? "5") ?? .nan
        let delay = Double(value("--delay") ?? "0") ?? .nan
        let mode = value("--mode") ?? "normal"
        guard seconds.isFinite, (0.5...15).contains(seconds), delay.isFinite, (0...15).contains(delay), ["normal", "cover", "menu"].contains(mode) else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let probe = Probe(displayID: displayID, seconds: seconds, delay: mode == "menu" ? max(1, delay) : delay, mode: mode)
        app.delegate = probe
        withExtendedLifetime(probe) { app.run() }
    }
}
