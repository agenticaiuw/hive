import AppKit

final class ClickDismissView: NSView {
  var onDismiss: (() -> Void)?

  override func mouseDown(with event: NSEvent) {
    onDismiss?()
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }
}

final class OverlayController: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private var escapeMonitor: Any?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = Array(CommandLine.arguments.dropFirst())
    let region = (args.count > 0 ? args[0] : "left").lowercased()
    let colorName = args.count > 1 ? args[1] : "black"
    let opacity = Double(args.count > 2 ? args[2] : "1") ?? 1.0
    let fraction = Double(args.count > 3 ? args[3] : "0.5") ?? 0.5

    guard let screen = NSScreen.main ?? NSScreen.screens.first else {
      fputs("No screen available\n", stderr)
      exit(1)
    }

    let frame = overlayFrame(
      screen: screen.frame,
      region: region,
      fraction: clamp(fraction, min: 0.05, max: 1.0)
    )

    let window = NSWindow(
      contentRect: frame,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false,
      screen: screen
    )
    window.isOpaque = opacity >= 0.999
    window.alphaValue = CGFloat(clamp(opacity, min: 0.2, max: 1.0))
    window.backgroundColor = resolveColor(colorName)
    window.hasShadow = false
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    window.ignoresMouseEvents = false
    window.isReleasedWhenClosed = false

    let content = ClickDismissView(frame: NSRect(origin: .zero, size: frame.size))
    content.wantsLayer = true
    content.layer?.backgroundColor = resolveColor(colorName).cgColor
    content.onDismiss = { [weak self] in self?.close() }
    window.contentView = content

    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    self.window = window

    escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 53 { // Escape
        self?.close()
        return nil
      }
      return event
    }

    FileHandle.standardOutput.write(
      Data("ready region=\(region) fraction=\(fraction) frame=\(NSStringFromRect(frame))\n".utf8)
    )
  }

  private func close() {
    if let escapeMonitor {
      NSEvent.removeMonitor(escapeMonitor)
    }
    window?.orderOut(nil)
    NSApp.terminate(nil)
  }
}

func overlayFrame(screen: NSRect, region: String, fraction: Double) -> NSRect {
  let w = screen.width
  let h = screen.height
  let x = screen.origin.x
  let y = screen.origin.y
  let f = fraction

  switch region {
  case "right":
    let rw = w * f
    return NSRect(x: x + (w - rw), y: y, width: rw, height: h)
  case "top":
    // AppKit y grows upward — top strip sits at the high end of the screen.
    let rh = h * f
    return NSRect(x: x, y: y + (h - rh), width: w, height: rh)
  case "bottom":
    let rh = h * f
    return NSRect(x: x, y: y, width: w, height: rh)
  case "full", "all":
    return screen
  default: // left
    let rw = w * f
    return NSRect(x: x, y: y, width: rw, height: h)
  }
}

func resolveColor(_ name: String) -> NSColor {
  switch name.lowercased() {
  case "black": return .black
  case "white": return .white
  case "red": return .red
  case "gray", "grey": return .darkGray
  default: return .black
  }
}

func clamp(_ value: Double, min: Double, max: Double) -> Double {
  Swift.min(max, Swift.max(min, value))
}

let app = NSApplication.shared
let delegate = OverlayController()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
