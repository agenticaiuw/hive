// Captions for the voice agent: what it says, big, at the bottom of the screen, and what it's doing
// right now, small, under that. While it's listening, or you're dictating (holding fn), a line on
// top says so, with what you're saying under it. Reads one JSON object per line on stdin and quits when stdin closes:
//
//   {"listening": true}             the "Listening" line on top, until {"listening": false}
//   {"dictating": true}             the "Dictating" line on top instead, until {"dictating": false}
//   {"camera": "on"}                "CAMERA ON · lip reading" on top, in green ("starting", "waiting": on
//                                   the way; "off": gone)
//   {"hearing": "Open Safari"}      what you're saying (fades a few seconds after you stop); "" removes it
//   {"say": "I opened Safari."}     show these words (they fade a few seconds later); "" removes them
//   {"doing": "Typing “weather”"}   the line under them; "" removes it
//   {"clear": true}                 hide everything but the line on top now
//
// The captions float over every app, full-screen ones too, let clicks through, never take focus,
// and are left out of screenshots, so the agent doesn't see (or click on) its own words.
//
//   agent-vhid-captions --snapshot out.png [--listening|--dictating] [--hearing TEXT] "words" ["doing"]
//                                   draws them into a PNG instead (tests)

import AppKit

let maxWidth: CGFloat = 860
let padX: CGFloat = 20, padY: CGFloat = 12, gap: CGFloat = 4

let listeningText = "🎙  Listening  ·  tap fn to stop"
let dictatingText = "✍️  Dictating  ·  let go of fn to type it"
let cameraTexts = ["on": "🟢 📷  CAMERA ON  ·  lip reading  ·  tap fn to stop",
                   "starting": "📷  Turning the camera on…",
                   "waiting": "📷  Waiting for camera access (allow Agent if macOS asks)"]

final class Bubble: NSView {
    let header = NSTextField(labelWithString: "")
    let heard = NSTextField(wrappingLabelWithString: "")
    let say = NSTextField(wrappingLabelWithString: "")
    let doing = NSTextField(labelWithString: "")
    var lines: [NSTextField] { [header, heard, say, doing] }  // top to bottom

    override init(frame: NSRect) {
        super.init(frame: frame)
        header.font = .systemFont(ofSize: 13, weight: .semibold)
        header.textColor = NSColor.white.withAlphaComponent(0.8)
        header.alignment = .center
        heard.font = .systemFont(ofSize: 20)
        heard.textColor = NSColor(calibratedRed: 0.72, green: 0.84, blue: 1, alpha: 1)
        heard.alignment = .center
        say.font = .systemFont(ofSize: 24, weight: .medium)
        say.textColor = .white
        say.alignment = .center
        doing.font = .systemFont(ofSize: 15)
        doing.textColor = NSColor.white.withAlphaComponent(0.7)
        doing.alignment = .center
        doing.lineBreakMode = .byTruncatingTail
        lines.forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.75).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 16, yRadius: 16).fill()
    }

    var isEmpty: Bool { lines.allSatisfy { $0.stringValue.isEmpty } }

    /// Places the labels, one under the other, and sizes the bubble around them.
    func layOut() {
        let width = maxWidth - 2 * padX
        func size(_ label: NSTextField) -> NSSize {
            if label.stringValue.isEmpty { return .zero }
            let s = label.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: 1000))
            return NSSize(width: min(width, ceil(s.width)), height: ceil(s.height))
        }
        let shown = lines.map { ($0, size($0)) }.filter { $0.1.height > 0 }
        let inner = shown.map { $0.1.width }.max() ?? 0
        let height = shown.map { $0.1.height }.reduce(0, +) + gap * CGFloat(max(0, shown.count - 1))
        setFrameSize(NSSize(width: inner + 2 * padX, height: height + 2 * padY))
        var y = padY
        for (label, s) in shown.reversed() {
            label.frame = NSRect(x: padX, y: y, width: inner, height: s.height)
            y += s.height + gap
        }
        lines.forEach { $0.isHidden = $0.stringValue.isEmpty }
        needsDisplay = true
    }
}

final class Captions {
    let bubble = Bubble(frame: .zero)
    let window = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: false)
    var fade: Timer?
    var heardFade: Timer?
    var listening = false, dictating = false, camera = "off"

    init() {
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .statusBar
        window.ignoresMouseEvents = true
        window.sharingType = .readOnly  // include captions in screenshots
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.contentView = bubble
        window.alphaValue = 0
    }

    func handle(_ message: [String: Any]) {
        if message["clear"] != nil {
            bubble.heard.stringValue = ""
            bubble.say.stringValue = ""
            bubble.doing.stringValue = ""
        }
        if let listening = message["listening"] as? Bool {
            self.listening = listening
        }
        if let dictating = message["dictating"] as? Bool {
            self.dictating = dictating
        }
        if let camera = message["camera"] as? String {
            self.camera = camera
        }
        bubble.header.stringValue = cameraTexts[camera] ?? (dictating ? dictatingText : listening ? listeningText : "")
        bubble.header.textColor = camera == "on" ? .systemGreen : NSColor.white.withAlphaComponent(0.8)
        if let words = message["hearing"] as? String {
            bubble.heard.stringValue = words
        }
        if message["hearing"] != nil || message["camera"] != nil {
            heardFade?.invalidate()
            let words = bubble.heard.stringValue
            if !words.isEmpty && camera != "on" {
                heardFade = Timer.scheduledTimer(withTimeInterval: 2.5 + 0.04 * Double(words.count), repeats: false) { _ in
                    self.handle(["hearing": ""])
                }
            }
        }
        if let words = message["say"] as? String {
            bubble.say.stringValue = words
            fade?.invalidate()
            if !words.isEmpty {  // long enough to read
                fade = Timer.scheduledTimer(withTimeInterval: 2.5 + 0.06 * Double(words.count), repeats: false) { _ in
                    self.handle(["say": ""])
                }
            }
        }
        if let doing = message["doing"] as? String {
            bubble.doing.stringValue = doing
        }
        show()
    }

    func show() {
        if bubble.isEmpty {
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; window.animator().alphaValue = 0 })
            return
        }
        bubble.layOut()
        let screen = (NSScreen.screens.first ?? NSScreen.main)!.visibleFrame  // the one with the menu bar
        window.setFrame(NSRect(x: screen.midX - bubble.frame.width / 2, y: screen.minY + 36,
                               width: bubble.frame.width, height: bubble.frame.height), display: true)
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.15; window.animator().alphaValue = 1 })
    }
}

let args = CommandLine.arguments
if args.count >= 4 && args[1] == "--snapshot" {
    _ = NSApplication.shared
    let bubble = Bubble(frame: .zero)
    var rest = Array(args[3...])
    if rest.first == "--camera" {
        bubble.header.stringValue = cameraTexts["on"]!
        bubble.header.textColor = .systemGreen
        rest.removeFirst()
    }
    if rest.first == "--listening" || rest.first == "--dictating" {
        bubble.header.stringValue = rest.first == "--listening" ? listeningText : dictatingText
        rest.removeFirst()
    }
    if rest.count >= 2 && rest[0] == "--hearing" {
        bubble.heard.stringValue = rest[1]
        rest.removeFirst(2)
    }
    bubble.say.stringValue = rest.first ?? ""
    bubble.doing.stringValue = rest.count > 1 ? rest[1] : ""
    bubble.layOut()
    let image = bubble.bitmapImageRepForCachingDisplay(in: bubble.bounds)!
    bubble.cacheDisplay(in: bubble.bounds, to: image)
    try! image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // no Dock icon, never the active app
let captions = Captions()
Thread {
    while let line = readLine() {
        if let message = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
            DispatchQueue.main.async { captions.handle(message) }
        }
    }
    DispatchQueue.main.async { exit(0) }
}.start()
app.run()
