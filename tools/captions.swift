// Captions for the voice agent: what it says, big, at the bottom of the screen, and what it's doing
// right now, small, under that. Reads one JSON object per line on stdin and quits when stdin closes:
//
//   {"say": "I opened Safari."}     show these words (they fade a few seconds later); "" removes them
//   {"doing": "Typing “weather”"}   the line under them; "" removes it
//   {"clear": true}                 hide everything now
//
// The captions float over every app, full-screen ones too, let clicks through, never take focus,
// and are left out of screenshots, so the agent doesn't see (or click on) its own words.
//
//   agent-vhid-captions --snapshot out.png "words" ["doing"]   draws them into a PNG instead (tests)

import AppKit

let maxWidth: CGFloat = 860
let padX: CGFloat = 20, padY: CGFloat = 12, gap: CGFloat = 4

final class Bubble: NSView {
    let say = NSTextField(wrappingLabelWithString: "")
    let doing = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        say.font = .systemFont(ofSize: 24, weight: .medium)
        say.textColor = .white
        say.alignment = .center
        doing.font = .systemFont(ofSize: 15)
        doing.textColor = NSColor.white.withAlphaComponent(0.7)
        doing.alignment = .center
        doing.lineBreakMode = .byTruncatingTail
        addSubview(say)
        addSubview(doing)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.75).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 16, yRadius: 16).fill()
    }

    var isEmpty: Bool { say.stringValue.isEmpty && doing.stringValue.isEmpty }

    /// Places the labels and sizes the bubble around them.
    func layOut() {
        let width = maxWidth - 2 * padX
        func size(_ label: NSTextField) -> NSSize {
            if label.stringValue.isEmpty { return .zero }
            let s = label.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: 1000))
            return NSSize(width: min(width, ceil(s.width)), height: ceil(s.height))
        }
        let saySize = size(say), doingSize = size(doing)
        let inner = max(saySize.width, doingSize.width)
        let between = saySize.height > 0 && doingSize.height > 0 ? gap : 0
        setFrameSize(NSSize(width: inner + 2 * padX, height: saySize.height + between + doingSize.height + 2 * padY))
        doing.frame = NSRect(x: padX, y: padY, width: inner, height: doingSize.height)
        say.frame = NSRect(x: padX, y: padY + doingSize.height + between, width: inner, height: saySize.height)
        say.isHidden = saySize.height == 0
        doing.isHidden = doingSize.height == 0
        needsDisplay = true
    }
}

final class Captions {
    let bubble = Bubble(frame: .zero)
    let window = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: false)
    var fade: Timer?

    init() {
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .statusBar
        window.ignoresMouseEvents = true
        window.sharingType = .none  // not in screenshots or screen recordings
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.contentView = bubble
        window.alphaValue = 0
    }

    func handle(_ message: [String: Any]) {
        if message["clear"] != nil {
            bubble.say.stringValue = ""
            bubble.doing.stringValue = ""
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
    bubble.say.stringValue = args[3]
    bubble.doing.stringValue = args.count > 4 ? args[4] : ""
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
