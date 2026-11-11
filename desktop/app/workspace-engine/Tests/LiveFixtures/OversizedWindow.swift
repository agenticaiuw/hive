// Live-only fixture. It enlarges its own marker window after a file trigger; never a user window.
import AppKit

final class MarkerWindow: NSWindow {
    var oversized = false
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        var rect = frameRect
        if oversized { rect.size.width = max(1_800, rect.width) }
        super.setFrame(rect, display: flag)
    }
}

let root = Bundle.main.bundleURL.deletingLastPathComponent()
try String(ProcessInfo.processInfo.processIdentifier).write(to: root.appendingPathComponent("fixture.pid"), atomically: true, encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = MarkerWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
    styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "SpaceO oversized marker fixture"
window.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
window.isReleasedWhenClosed = false
window.orderFront(nil)
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if !window.oversized, FileManager.default.fileExists(atPath: root.appendingPathComponent("enlarge").path) {
        window.oversized = true
        window.minSize = NSSize(width: 1_800, height: 600)
        window.setFrame(window.frame, display: true)
    }
}
app.run()
