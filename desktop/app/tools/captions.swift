// Captions for the voice agent: a small dark card, by default near the bottom of the screen, with what
// the agent says (big), what it's doing and thinking (small), what you're saying, and requests that came
// from another agent. Drag the card anywhere and it stays there (double-click it to put it back). Reads one
// JSON object per line on stdin and quits when stdin closes:
//
//   {"listening": true}             "Listening" in the header, until {"listening": false}
//   {"dictating": true}             "Dictating" in the header instead, until {"dictating": false}
//   {"hands_free": true}            the dictation (fn + shift) goes on until fn: "press fn to type it"
//   {"camera": "on"}                "Camera on · lip reading" in the header, in green ("starting", "waiting":
//                                   on the way; "off": gone)
//   {"framing": "Move closer"}      the header while the camera is on
//   {"preview": "<base64 JPEG>"}    a small camera preview while the camera is on
//   {"muted": true}                 transcription is muted: the header says so and the mic button is crossed
//                                   out; the card stays up and the agent keeps working ({"muted": false} undoes it)
//   {"paused": "Paused — …"}        an amber row (you took over); "" removes it
//   {"agent_request": "…"}          a request from another agent, in its own violet "Another agent" row; "" removes it
//   {"hearing": "Open Safari"}      what you're saying, in the blue "You" row (fades a few seconds after you
//                                   stop); "" removes it
//   {"say": "I opened Safari."}     the agent's words, big, a sentence or so at a time: each stays until there's
//                                   been time to read it, then the next one that came meanwhile replaces it; the
//                                   last fades a few seconds later; "" removes them, and any still waiting
//   {"thinking": "…"}               its progress or reasoning summary, small; "" removes it
//   {"doing": "Typing “weather”"}   the line under them; "" removes it
//   {"activity": "…"}               appended to the Activity log
//   {"active": true}                a task is running: the card stays up with its controls and the log open
//   {"dismiss": true}               hide the card until listening, the camera or a task starts again
//   {"hidden": true}                Show Floating Window is off: the card stays hidden, even when a task starts or
//                                   updates, except while fn is in use (listening, dictating, the camera); everything
//                                   sent meanwhile is kept, so {"hidden": false} shows it again as it is now
//   {"clear": true}                 empty the card now (all but the header and the paused row)
//   {"focus": true}                 typing goes to the entry field (fn opened the card); {"focus": false} gives
//                                   the keyboard back to the app in front (so does a new task, sending, the x)
//
// and writes one JSON object per line on stdout:
//
//   {"text": "…"}                   a request typed into the entry field
//   {"mute": true} / {"mute": false}  the mic button: mute or unmute transcription
//   {"close": true}                 the x button: stop the task; the card collapses
//   {"hidden": true}                the – button: the card hides (and stays hidden, as {"hidden": true} above);
//                                   the task and its voice go on
//   {"focused": true} / {"focused": false}  whether the entry field has the keyboard now
//
// The card floats over every app, full-screen ones too, and never takes keyboard focus from the app in front
// except for the entry field: when you click into it, or when fn opens the card ({"focus": true}). The app in
// front stays in front either way; outside the card, clicks go through.
//
//   agent-vhid-captions --snapshot out.png [--activity] [--camera] [--listening|--dictating] [--muted]
//       [--paused TEXT] [--other TEXT] [--hearing TEXT] [--thinking TEXT] "words" ["doing"]
//                                   draws the card into a PNG instead (tests)

import AppKit
import CoreGraphics

// MARK: - Look

let cardWidth: CGFloat = 540
let cornerRadius: CGFloat = 16
let padX: CGFloat = 18, padTop: CGFloat = 10, padBottom: CGFloat = 16, gap: CGFloat = 10
let headerHeight: CGFloat = 24
let positionKey = "CaptionsPosition"

func srgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: 1) }
let primaryText = NSColor(white: 1, alpha: 0.96)
let secondaryText = NSColor(white: 1, alpha: 0.66)
let tertiaryText = NSColor(white: 1, alpha: 0.45)
let youAccent = srgb(0.42, 0.69, 1.0), youText = srgb(0.87, 0.93, 1.0)
let otherAccent = srgb(0.78, 0.60, 1.0), otherText = srgb(0.94, 0.90, 1.0)
let pausedAccent = srgb(1.0, 0.73, 0.26), pausedText = srgb(1.0, 0.90, 0.72)
let cameraAccent = srgb(0.36, 0.86, 0.50)
let mutedAccent = srgb(1.0, 0.45, 0.42)

var fontCache: [String: NSFont] = [:]

/// Inter at this size and weight: the variable "Inter" family first, then the static optical sizes
/// ("Inter 18pt" for small text, "Inter 24pt" / "Inter 28pt" for large), the system font only if none load.
func inter(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
    let key = "\(size)/\(weight.rawValue)"
    if let font = fontCache[key] { return font }
    let families = size >= 24 ? ["Inter", "Inter 28pt", "Inter 24pt", "Inter 18pt"]
        : size >= 18 ? ["Inter", "Inter 24pt", "Inter 28pt", "Inter 18pt"]
        : ["Inter", "Inter 18pt", "Inter 24pt"]
    let w = weight.rawValue  // NSFontManager weights: 3 light, 5 regular, 6 medium, 8 semibold, 9 bold
    let managerWeight = w >= 0.62 ? 14 : w >= 0.56 ? 11 : w >= 0.4 ? 9 : w >= 0.3 ? 8 : w >= 0.2 ? 6 : w <= -0.4 ? 3 : 5
    var found: NSFont?
    for family in families {
        let descriptor = NSFontDescriptor(fontAttributes: [.family: family,
                                                           .traits: [NSFontDescriptor.TraitKey.weight: w]])
        if let font = NSFont(descriptor: descriptor, size: size), font.familyName == family { found = font; break }
        if let font = NSFontManager.shared.font(withFamily: family, traits: [], weight: managerWeight, size: size) {
            found = font; break
        }
    }
    if found == nil && fontCache.isEmpty {
        FileHandle.standardError.write(Data("captions: Inter isn't installed; using the system font\n".utf8))
    }
    let font = found ?? .systemFont(ofSize: size, weight: weight)
    fontCache[key] = font
    return font
}

/// One text style: Inter, a colour and a fixed line height, so every line (emoji ones too) is the same height
/// and a row of n lines is exactly n line heights tall.
struct TextStyle {
    let font: NSFont
    var color: NSColor
    let lineHeight: CGFloat
    let kern: CGFloat

    init(_ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor, kern: CGFloat = 0) {
        font = inter(size, weight)
        self.color = color
        lineHeight = ceil(size * 1.3)
        self.kern = kern
    }

    var attributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        paragraph.lineBreakMode = .byWordWrapping
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        if kern != 0 { attributes[.kern] = kern }
        return attributes
    }
}

func tidy(_ text: String) -> String {
    var tidied = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\t", with: " ")
    while tidied.contains("\n\n\n") { tidied = tidied.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
    return tidied.trimmingCharacters(in: .whitespacesAndNewlines)
}

func roundedMask(_ radius: CGFloat) -> NSImage {
    let edge = 2 * radius + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
}

// MARK: - Views

/// Wrapped text, measured with the same font, attributes and width it's drawn with, capped to a number of
/// lines: the last one shown ends in "…" (or, with keepEnd, the first one starts with "…" and the latest
/// words stay). Clicks fall through to the card, so it can be dragged by its text.
final class TextRow: NSView {
    var style: TextStyle { didSet { measured = nil; needsDisplay = true } }
    var text = "" { didSet { if text != oldValue { clean = tidy(text); measured = nil; needsDisplay = true } } }
    var keepEnd = false
    private(set) var clean = ""
    private var shown = NSAttributedString()
    private var measured: (width: CGFloat, lines: Int)?
    static let slack: CGFloat = 2  // measured 2 pt narrower than drawn, and framed 2 pt taller than its lines

    init(_ style: TextStyle) {
        self.style = style
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    var lineHeight: CGFloat { style.lineHeight }
    var isBlank: Bool { clean.isEmpty }

    private func attributed(_ string: String) -> NSAttributedString {
        NSAttributedString(string: string, attributes: style.attributes)
    }

    private func count(_ string: NSAttributedString, _ width: CGFloat) -> Int {
        guard string.length > 0 else { return 0 }
        let rect = string.boundingRect(with: NSSize(width: max(1, width - TextRow.slack), height: .greatestFiniteMagnitude),
                                       options: [.usesLineFragmentOrigin])
        return max(1, Int(ceil(rect.height / lineHeight - 0.05)))
    }

    /// How many lines all of it takes at this width.
    func lines(width: CGFloat) -> Int {
        if let measured, measured.width == width { return measured.lines }
        let lines = count(attributed(clean), width)
        measured = (width, lines)
        return lines
    }

    func height(lines: Int) -> CGFloat { lines > 0 ? CGFloat(lines) * lineHeight + TextRow.slack : 0 }

    /// Frames it with at most `cap` lines and returns its height (0, hidden, when there's nothing to show).
    @discardableResult
    func place(x: CGFloat, y: CGFloat, width: CGFloat, cap: Int) -> CGFloat {
        let all = lines(width: width), lines = min(all, cap)
        isHidden = lines == 0
        frame = NSRect(x: x, y: y, width: width, height: height(lines: lines))
        shown = keepEnd && all > lines && lines > 0 ? latestWords(width: width, lines: lines) : attributed(clean)
        needsDisplay = true
        return frame.height
    }

    /// "…" and as many of the last words as fit in that many lines.
    private func latestWords(width: CGFloat, lines: Int) -> NSAttributedString {
        var starts: [String.Index] = []
        var afterSpace = false
        for index in clean.indices {
            if clean[index].isWhitespace { afterSpace = true } else { if afterSpace { starts.append(index) }; afterSpace = false }
        }
        var low = 0, high = starts.count - 1, best = -1
        while low <= high {
            let middle = (low + high) / 2
            if count(attributed("…" + String(clean[starts[middle]...])), width) <= lines { best = middle; high = middle - 1 }
            else { low = middle + 1 }
        }
        return attributed("…" + (best >= 0 ? String(clean[starts[best]...]) : String(clean.suffix(60))))
    }

    override func draw(_ dirtyRect: NSRect) {
        shown.draw(with: bounds, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }
}

/// An SF Symbol (or a picture) that lets clicks fall through to the card.
final class SymbolView: NSImageView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func show(_ name: String, _ color: NSColor, size: CGFloat = 12, weight: NSFont.Weight = .semibold) {
        image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: weight))
        contentTintColor = color
        imageScaling = .scaleProportionallyDown
    }
}

/// A rounded rectangle: the card's tint and edge, the activity log's well, the entry field's box.
final class Box: NSView {
    var fill: NSColor, stroke: NSColor
    let radius: CGFloat
    let passesClicks: Bool

    init(fill: NSColor, stroke: NSColor, radius: CGFloat, passesClicks: Bool = false) {
        self.fill = fill; self.stroke = stroke; self.radius = radius; self.passesClicks = passesClicks
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { passesClicks ? nil : super.hitTest(point) }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius - 0.5, yRadius: radius - 0.5)
        fill.setFill(); path.fill()
        stroke.setStroke(); path.lineWidth = 1; path.stroke()
    }
}

/// A row with an icon: either a caption line ("You", "Another agent") over the text, or the icon beside the
/// text; on a tinted rounded background when `tinted`.
final class Section: NSView {
    let body: TextRow
    let caption: TextRow?
    let icon = SymbolView(frame: .zero)
    let tint: NSColor?
    private let padH: CGFloat, padV: CGFloat

    init(_ style: TextStyle, caption: String? = nil, symbol: String, accent: NSColor, tinted: Bool) {
        body = TextRow(style)
        self.caption = caption.map { label in
            let row = TextRow(TextStyle(11.5, .semibold, accent, kern: 0.2))
            row.text = label
            return row
        }
        tint = tinted ? accent : nil
        padH = tinted ? 12 : 0
        padV = tinted ? 9 : 0
        super.init(frame: .zero)
        icon.show(symbol, accent, size: caption == nil ? 12 : 10.5)
        addSubview(icon)
        if let row = self.caption { addSubview(row) }
        addSubview(body)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    var text: String { get { body.text } set { body.text = newValue } }
    var isBlank: Bool { body.isBlank }
    private var bodyX: CGFloat { padH + (caption == nil ? 22 : 0) }
    private var captionHeight: CGFloat { caption.map { $0.height(lines: 1) + 2 } ?? 0 }

    func lines(width: CGFloat) -> Int { body.lines(width: width - bodyX - padH) }
    func height(lines: Int) -> CGFloat { lines > 0 ? 2 * padV + captionHeight + body.height(lines: lines) : 0 }

    @discardableResult
    func place(x: CGFloat, y: CGFloat, width: CGFloat, cap: Int) -> CGFloat {
        let lines = min(self.lines(width: width), cap)
        isHidden = lines == 0
        guard lines > 0 else { return 0 }
        frame = NSRect(x: x, y: y, width: width, height: height(lines: lines))
        var top = padV
        if let caption {
            icon.frame = NSRect(x: padH, y: top + (caption.lineHeight - 12) / 2, width: 12, height: 12)
            caption.place(x: padH + 17, y: top, width: width - 2 * padH - 17, cap: 1)
            top += captionHeight
        } else {
            icon.frame = NSRect(x: padH, y: top + (body.lineHeight - 14) / 2, width: 14, height: 14)
        }
        body.place(x: bodyX, y: top, width: width - bodyX - padH, cap: cap)
        needsDisplay = true
        return frame.height
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let tint else { return }
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        tint.withAlphaComponent(0.13).setFill(); path.fill()
        tint.withAlphaComponent(0.30).setStroke(); path.lineWidth = 1; path.stroke()
    }
}

/// A borderless button that brightens (with a soft background) under the pointer, works on the first click
/// and never makes the panel key, so the app in front keeps the keyboard.
final class HoverButton: NSButton {
    var restTint = NSColor(white: 1, alpha: 0.5) { didSet { refresh() } }
    var chip = false  // a faint rounded background even when the pointer isn't over it
    var label: String? { didSet { refresh() } }
    var symbol: String? {
        didSet {
            image = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: label == nil ? 12 : 9, weight: .semibold))
        }
    }
    private var hovering = false
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        imagePosition = .imageOnly
        focusRingType = .none
        refusesFirstResponder = true
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var needsPanelToBecomeKey: Bool { false }
    override var acceptsFirstResponder: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; refresh() }
    override func mouseExited(with event: NSEvent) { hovering = false; refresh() }
    func unhover() { if hovering { hovering = false; refresh() } }

    func refresh() {
        let color = hovering ? NSColor(white: 1, alpha: 0.96) : restTint
        contentTintColor = color
        if let label {
            attributedTitle = NSAttributedString(string: label, attributes: [.font: inter(12, .medium), .foregroundColor: color])
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovering || chip {
            NSColor(white: 1, alpha: hovering ? 0.14 : 0.07).setFill()
            let radius = chip ? 7 : bounds.height / 2
            NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        }
        super.draw(dirtyRect)
    }
}

struct Caps { var paused = 2, other = 3, heard = 3, say = 5, thinking = 3, doing = 1, activity: CGFloat = 140, preview = true }

/// The card. Top to bottom: header (status, mute, hide, close), paused, another agent's request, what you're
/// saying, the agent's words, its thinking, what it's doing, the camera preview, the activity log, and the
/// Activity button with the entry field.
final class Bubble: NSView {
    let effect = NSVisualEffectView()
    let chrome = Box(fill: NSColor(srgbRed: 0.05, green: 0.05, blue: 0.07, alpha: 0.45),
                     stroke: NSColor(white: 1, alpha: 0.12), radius: cornerRadius, passesClicks: true)
    let headerIcon = SymbolView(frame: .zero)
    let header = TextRow(TextStyle(12, .semibold, secondaryText))
    let muteButton = HoverButton(frame: .zero)
    let hideButton = HoverButton(frame: .zero)
    let closeButton = HoverButton(frame: .zero)
    let paused = Section(TextStyle(13.5, .medium, pausedText), symbol: "pause.circle.fill", accent: pausedAccent, tinted: true)
    let other = Section(TextStyle(15, .regular, otherText), caption: "Another agent", symbol: "cpu", accent: otherAccent, tinted: true)
    let heard = Section(TextStyle(15, .regular, youText), caption: "You", symbol: "person.fill", accent: youAccent, tinted: true)
    let say = TextRow(TextStyle(19, .medium, primaryText, kern: -0.2))
    let thinking = TextRow(TextStyle(13, .regular, secondaryText))
    let doing = Section(TextStyle(13, .medium, secondaryText), symbol: "gearshape.fill", accent: tertiaryText, tinted: false)
    let preview = SymbolView(frame: .zero)
    let activityBox = Box(fill: NSColor(white: 0, alpha: 0.28), stroke: NSColor(white: 1, alpha: 0.07), radius: 10)
    let activityScroll = NSScrollView(frame: .zero)
    let activityView = NSTextView(frame: .zero)
    let detailsButton = HoverButton(frame: .zero)
    let entryBox = Box(fill: NSColor(white: 1, alpha: 0.07), stroke: NSColor(white: 1, alpha: 0.14), radius: 8)
    let entry = NSTextField(string: "")
    var editing = false, active = false, detailsOpen = false, previewVisible = false
    var muted = false { didSet { refreshMute() } }
    var snapshot = false { didSet { effect.isHidden = snapshot; chrome.fill = chrome.fill.withAlphaComponent(snapshot ? 0.94 : 0.45) } }
    private(set) var dragging = false
    var onMoved: (() -> Void)?
    var onReset: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active  // the app is never active; keep the blur anyway
        effect.maskImage = roundedMask(cornerRadius)
        addSubview(effect)
        addSubview(chrome)

        heard.body.keepEnd = true  // while you talk, the latest words matter
        closeButton.symbol = "xmark"
        closeButton.restTint = NSColor(white: 1, alpha: 0.38)
        closeButton.toolTip = "Stop and close"
        hideButton.symbol = "minus"
        hideButton.restTint = NSColor(white: 1, alpha: 0.38)
        hideButton.toolTip = "Hide; Hive keeps working"
        hideButton.setAccessibilityLabel("Hide the floating window")
        refreshMute()
        detailsButton.label = "Activity"
        detailsButton.chip = true
        detailsButton.imagePosition = .imageTrailing
        detailsButton.imageHugsTitle = true
        detailsButton.restTint = secondaryText
        setDetailsChevron()

        entry.isBordered = false
        entry.isBezeled = false
        entry.drawsBackground = false
        entry.focusRingType = .none
        entry.font = inter(14)
        entry.textColor = primaryText
        entry.placeholderAttributedString = NSAttributedString(string: "Type a request and press Return",
                                                               attributes: [.font: inter(14), .foregroundColor: tertiaryText])
        entry.cell?.usesSingleLineMode = true  // a pasted multi-line text becomes one line that scrolls
        entry.cell?.wraps = false
        entry.cell?.isScrollable = true
        entry.cell?.allowsUndo = true
        entry.cell?.sendsActionOnEndEditing = false  // only Return sends it, not clicking away mid-sentence
        entryBox.addSubview(entry)

        activityView.isEditable = false
        activityView.isSelectable = false  // so a click in it doesn't take the keyboard
        activityView.drawsBackground = false
        activityView.textContainerInset = NSSize(width: 6, height: 8)
        activityView.minSize = .zero
        activityView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        activityView.isVerticallyResizable = true
        activityView.isHorizontallyResizable = false
        activityView.autoresizingMask = [.width]
        activityView.textContainer?.widthTracksTextView = true
        activityScroll.drawsBackground = false
        activityScroll.borderType = .noBorder
        activityScroll.hasVerticalScroller = true
        activityScroll.autohidesScrollers = true
        activityScroll.scrollerStyle = .overlay
        activityScroll.scrollerKnobStyle = .light
        activityScroll.documentView = activityView
        activityBox.addSubview(activityScroll)

        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.wantsLayer = true
        preview.layer?.cornerRadius = 8
        preview.layer?.masksToBounds = true

        for view in [headerIcon, header, muteButton, hideButton, closeButton, paused, other, heard, say, thinking, doing,
                     preview, activityBox, detailsButton, entryBox] as [NSView] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var hasContent: Bool {
        editing || active || detailsOpen || muted
            || ![paused.isBlank, other.isBlank, heard.isBlank, say.isBlank, thinking.isBlank, doing.isBlank].allSatisfy { $0 }
    }

    var activityText: String {
        get { activityView.string }
        set {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 2
            activityView.textStorage?.setAttributedString(NSAttributedString(string: newValue, attributes: [
                .font: inter(12), .foregroundColor: NSColor(white: 1, alpha: 0.78), .paragraphStyle: paragraph]))
            activityView.scrollToEndOfDocument(nil)
        }
    }

    func setHeader(symbol: String, text: String, icon: NSColor, color: NSColor) {
        headerIcon.show(symbol, icon, size: 11.5)
        header.style.color = color
        header.text = text
    }

    func setDetailsChevron() {
        detailsButton.symbol = detailsOpen ? "chevron.up" : "chevron.down"
    }

    private func refreshMute() {
        muteButton.symbol = muted ? "mic.slash.fill" : "mic.fill"
        muteButton.restTint = muted ? mutedAccent : NSColor(white: 1, alpha: 0.5)
        muteButton.toolTip = muted ? "Unmute transcription" : "Mute transcription (the agent keeps working)"
    }

    /// Lays the card out `width` wide and sizes it around its contents, no taller than `maxHeight`: when it
    /// doesn't fit, the log gets shorter, the preview goes, and the rows show fewer lines (with "…").
    func layOut(width: CGFloat, maxHeight: CGFloat) {
        let inner = width - 2 * padX
        let full = (paused: paused.lines(width: inner), other: other.lines(width: inner), heard: heard.lines(width: inner),
                    say: say.lines(width: inner), thinking: thinking.lines(width: inner), doing: doing.lines(width: inner))
        let controls = editing || active || detailsOpen
        func heights(_ c: Caps) -> [CGFloat] {
            [paused.height(lines: min(full.paused, c.paused)), other.height(lines: min(full.other, c.other)),
             heard.height(lines: min(full.heard, c.heard)), say.height(lines: min(full.say, c.say)),
             thinking.height(lines: min(full.thinking, c.thinking)), doing.height(lines: min(full.doing, c.doing)),
             previewVisible && c.preview ? 120 : 0, detailsOpen ? c.activity : 0, controls ? 28 : 0]
        }
        func total(_ c: Caps) -> CGFloat {
            let shown = heights(c).filter { $0 > 0 }
            return padTop + headerHeight + shown.reduce(0, +) + gap * CGFloat(shown.count) + padBottom
        }
        func lower(_ value: inout Int, _ all: Int, to floor: Int) -> Bool {
            let now = min(value, all)
            guard now > floor else { return false }
            value = now - 1
            return true
        }
        let detailsOpen = self.detailsOpen, previewVisible = self.previewVisible
        let steps: [(inout Caps) -> Bool] = [
            { c in guard detailsOpen, c.activity > 72 else { return false }; c.activity = max(72, c.activity - 16); return true },
            { c in guard previewVisible, c.preview else { return false }; c.preview = false; return true },
            { lower(&$0.thinking, full.thinking, to: 1) },
            { lower(&$0.say, full.say, to: 3) },
            { lower(&$0.heard, full.heard, to: 2) },
            { lower(&$0.other, full.other, to: 2) },
            { c in guard detailsOpen, c.activity > 0 else { return false }; c.activity = 0; return true },
            { lower(&$0.say, full.say, to: 2) },
            { lower(&$0.heard, full.heard, to: 1) },
            { lower(&$0.other, full.other, to: 1) },
            { lower(&$0.paused, full.paused, to: 1) },
            { lower(&$0.thinking, full.thinking, to: 0) },
            { lower(&$0.say, full.say, to: 1) },
            { lower(&$0.doing, full.doing, to: 0) },
        ]
        var caps = Caps()
        for step in steps { while total(caps) > maxHeight && step(&caps) {} }

        setFrameSize(NSSize(width: width, height: total(caps)))
        effect.frame = bounds
        chrome.frame = bounds

        // The window's own controls (– hide, x stop) together on the right; the mic, about the transcript, apart.
        closeButton.frame = NSRect(x: width - 34, y: padTop, width: 24, height: 24)
        hideButton.frame = NSRect(x: closeButton.frame.minX - 26, y: padTop, width: 24, height: 24)
        muteButton.frame = NSRect(x: hideButton.frame.minX - 34, y: padTop, width: 24, height: 24)
        headerIcon.frame = NSRect(x: padX, y: padTop + 5, width: 14, height: 14)
        let headerX = padX + 21
        header.place(x: headerX, y: padTop + (headerHeight - header.height(lines: 1)) / 2,
                     width: muteButton.frame.minX - 8 - headerX, cap: 1)

        var y = padTop + headerHeight + gap
        func put(_ height: CGFloat) { if height > 0 { y += height + gap } }
        put(paused.place(x: padX, y: y, width: inner, cap: caps.paused))
        put(other.place(x: padX, y: y, width: inner, cap: caps.other))
        put(heard.place(x: padX, y: y, width: inner, cap: caps.heard))
        put(say.place(x: padX, y: y, width: inner, cap: caps.say))
        put(thinking.place(x: padX, y: y, width: inner, cap: caps.thinking))
        put(doing.place(x: padX, y: y, width: inner, cap: caps.doing))
        preview.isHidden = !(previewVisible && caps.preview)
        if !preview.isHidden {
            preview.frame = NSRect(x: padX, y: y, width: 160, height: 120)
            put(120)
        }
        activityBox.isHidden = !(detailsOpen && caps.activity > 0)
        if !activityBox.isHidden {
            activityBox.frame = NSRect(x: padX, y: y, width: inner, height: caps.activity)
            activityScroll.frame = activityBox.bounds.insetBy(dx: 1, dy: 1)
            activityView.setFrameSize(NSSize(width: activityScroll.contentSize.width, height: activityView.frame.height))
            put(caps.activity)
        }
        detailsButton.isHidden = !controls
        entryBox.isHidden = !(controls && editing)
        if controls {
            detailsButton.frame = NSRect(x: padX, y: y, width: 88, height: 28)
            entryBox.frame = NSRect(x: padX + 96, y: y, width: inner - 96, height: 28)
            let fieldHeight = ceil(entry.intrinsicContentSize.height)
            entry.frame = NSRect(x: 10, y: (28 - fieldHeight) / 2, width: entryBox.frame.width - 20, height: fieldHeight)
        }
        setDetailsChevron()
        needsDisplay = true
    }

    // Drag the card by anything that isn't a button, the entry field or the log; double-click to put it back.
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount >= 2 { onReset?(); return }
        let start = NSEvent.mouseLocation, origin = window.frame.origin
        var moved = false
        dragging = true
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]), next.type == .leftMouseDragged {
            let point = NSEvent.mouseLocation
            let dx = point.x - start.x, dy = point.y - start.y
            if !moved && hypot(dx, dy) < 3 { continue }
            moved = true
            window.setFrameOrigin(NSPoint(x: origin.x + dx, y: origin.y + dy))
        }
        dragging = false
        if moved { onMoved?() }
    }
}

// MARK: - Window

final class InputPanel: NSPanel {
    override var canBecomeKey: Bool { true }  // for the entry field only (becomesKeyOnlyIfNeeded)
    override var canBecomeMain: Bool { false }

    /// This app has no Edit menu (it never shows a menu bar), so ⌘V, ⌘C, ⌘X, ⌘A, ⌘Z and ⇧⌘Z would never reach the
    /// entry field; send them to it here.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        if event.type == .keyDown, flags == .command || flags == [.command, .shift], firstResponder is NSText,
           let key = event.charactersIgnoringModifiers?.lowercased() {
            let shift = flags.contains(.shift)
            let action: Selector? = switch key {
            case "v" where !shift: #selector(NSText.paste(_:))
            case "c" where !shift: #selector(NSText.copy(_:))
            case "x" where !shift: #selector(NSText.cut(_:))
            case "a" where !shift: #selector(NSText.selectAll(_:))
            case "z": shift ? Selector(("redo:")) : Selector(("undo:"))
            default: nil
            }
            if let action, firstResponder?.tryToPerform(action, with: self) == true { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

struct Header { let symbol: String, text: String, icon: NSColor, color: NSColor }

func headerLine(camera: String, framing: String, muted: Bool, dictating: Bool, listening: Bool, active: Bool,
                handsFree: Bool = false) -> Header {
    switch camera {
    case "on":
        return Header(symbol: "video.fill", text: framing.isEmpty ? "Camera on · lip reading · tap fn to send" : framing,
                      icon: cameraAccent, color: cameraAccent)
    case "starting":
        return Header(symbol: "video", text: "Turning the camera on…", icon: cameraAccent, color: secondaryText)
    case "waiting":
        return Header(symbol: "video", text: "Waiting for camera access (allow Agent if macOS asks)", icon: cameraAccent,
                      color: secondaryText)
    default: break
    }
    if muted {
        return Header(symbol: "mic.slash.fill", text: active ? "Transcription muted · the agent keeps working" : "Transcription muted",
                      icon: mutedAccent, color: mutedAccent)
    }
    if dictating {
        return Header(symbol: "keyboard", text: handsFree ? "Dictating · press fn to type it" : "Dictating · let go of fn to type it",
                      icon: youAccent, color: secondaryText)
    }
    if listening { return Header(symbol: "waveform", text: "Listening · the mic button mutes", icon: youAccent, color: secondaryText) }
    return Header(symbol: "sparkles", text: active ? "Hive · working" : "Hive", icon: tertiaryText, color: tertiaryText)
}

/// Where the card goes: its centre x and its bottom edge (or, in the top half of the screen, its top edge),
/// so it grows away from the nearest screen edge.
struct Anchor {
    let x: CGFloat, y: CGFloat, top: Bool
    var probe: NSPoint { NSPoint(x: x, y: top ? y - 1 : y + 1) }
}

final class Captions: NSObject {
    let bubble = Bubble(frame: .zero)
    let window = InputPanel(contentRect: NSRect(x: 0, y: 0, width: cardWidth, height: 60),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    var fade: Timer?
    /// The agent's words on the card are still being read; what it says meanwhile waits in sayQueue.
    var sayHold: Timer?
    var sayQueue: [String] = []
    var heardFade: Timer?
    var otherFade: Timer?
    var listening = false, dictating = false, handsFree = false, camera = "off", framing = ""
    var dismissedByUser = false
    var visible = false
    /// Show Floating Window is off (the menu, or the – button): hidden except while fn is in use.
    var windowOff = false
    /// fn opened the card since it was last hidden: listening, dictating or the camera started.
    var fnOpened = false
    var fnInUse: Bool { listening || dictating || camera != "off" }

    override init() {
        super.init()
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .statusBar
        window.ignoresMouseEvents = true
        window.sharingType = .readOnly  // include captions in screenshots
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = bubble
        bubble.entry.target = self
        bubble.entry.action = #selector(submit)
        bubble.detailsButton.target = self
        bubble.detailsButton.action = #selector(toggleDetails)
        bubble.muteButton.target = self
        bubble.muteButton.action = #selector(toggleMute)
        bubble.hideButton.target = self
        bubble.hideButton.action = #selector(hideCard)
        bubble.closeButton.target = self
        bubble.closeButton.action = #selector(close)
        bubble.onMoved = { [unowned self] in settle() }
        bubble.onReset = { [unowned self] in
            UserDefaults.standard.removeObject(forKey: positionKey)
            show()
        }
        window.alphaValue = 0
    }

    func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line); fflush(stdout)
    }

    @objc func toggleDetails() {
        bubble.detailsOpen.toggle()
        show()
    }

    @objc func toggleMute() {
        bubble.muted.toggle()
        emit(["mute": bubble.muted])
        show()
    }

    /// The x: asks for the task to stop and collapses the card until listening, the camera or a task starts again.
    @objc func close() {
        emit(["close": true])
        releaseFocus()
        [fade, heardFade, otherFade].forEach { $0?.invalidate() }
        dropWaitingWords()
        for section in [bubble.paused, bubble.other, bubble.heard, bubble.doing] { section.text = "" }
        bubble.say.text = ""
        bubble.thinking.text = ""
        bubble.activityText = ""
        bubble.active = false
        bubble.detailsOpen = false
        bubble.closeButton.unhover()
        dismissedByUser = true
        show()
    }

    /// The –: only hides the card (no "close": the task and its voice go on) and turns Show Floating Window off,
    /// which the agent saves and the menu shows. Everything sent meanwhile is kept for when it's shown again.
    @objc func hideCard() {
        emit(["hidden": true])
        windowOff = true
        fnOpened = false
        bubble.hideButton.unhover()
        show()  // hides it, giving the keyboard back if the entry field had it
    }

    @objc func submit() {
        let value = bubble.entry.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        emit(["text": value])
        bubble.entry.stringValue = ""
        releaseFocus()  // the agent is about to work in the app in front
    }

    /// Typing goes to the entry field: fn opened the card to take a request. The app in front stays in front
    /// (the card is a non-activating panel), so the agent and its screenshots see the same screen as before.
    func focusEntry() {
        guard visible, !bubble.entryBox.isHidden else { return }
        window.makeKey()
        window.makeFirstResponder(bubble.entry)
        emit(["focused": window.isKeyWindow])
    }

    /// Gives the keyboard back to the app in front: for your typing, and the agent's.
    func releaseFocus() {
        guard window.isKeyWindow else { return }
        window.makeFirstResponder(nil)
        window.orderOut(nil)  // a panel stops being key only when it leaves the screen
        if visible { window.orderFrontRegardless() }
        emit(["focused": false])
    }

    /// The agent's words, a sentence or so at a time, the same whether Speak Aloud is on or off. Each stays
    /// until there's been time to read it (about 200 words a minute) before the next one replaces it: Codex
    /// writes several a second, faster than anyone reads, and a voice says them about as fast as this. The
    /// last one fades a few seconds later. "" removes them at once, with any still waiting.
    func say(_ words: String) {
        if tidy(words).isEmpty {
            dropWaitingWords()
            showSay("")
        } else if sayHold != nil {
            sayQueue.append(words)
        } else {
            showSay(words)
        }
    }

    func showSay(_ words: String) {
        bubble.say.text = words
        fade?.invalidate()
        sayHold?.invalidate()
        sayHold = nil
        let clean = bubble.say.clean
        guard !clean.isEmpty else { return }
        sayHold = Timer.scheduledTimer(withTimeInterval: 1.0 + 0.05 * Double(clean.count), repeats: false) { _ in
            self.sayHold = nil
            guard !self.sayQueue.isEmpty else { return }
            self.showSay(self.sayQueue.removeFirst())
            self.show()
        }
        fade = Timer.scheduledTimer(withTimeInterval: 2.5 + 0.06 * Double(clean.count), repeats: false) { _ in
            self.handle(["say": ""])
        }
    }

    func dropWaitingWords() {
        sayQueue.removeAll()
        sayHold?.invalidate()
        sayHold = nil
    }

    /// Another agent's request stays while a task runs, and fades once there's been time to read it otherwise.
    func scheduleOtherFade() {
        otherFade?.invalidate()
        otherFade = nil
        let words = bubble.other.body.clean
        guard !words.isEmpty, !bubble.active else { return }
        otherFade = Timer.scheduledTimer(withTimeInterval: max(8, 2.5 + 0.06 * Double(words.count)), repeats: false) { _ in
            self.handle(["agent_request": ""])
        }
    }

    func handle(_ message: [String: Any]) {
        if message["dismiss"] as? Bool == true { dismissedByUser = true }
        if let hidden = message["hidden"] as? Bool {
            windowOff = hidden
            if hidden { fnOpened = false } else { dismissedByUser = false }  // shown again, as it is now
        }
        if message["clear"] != nil {
            bubble.heard.text = ""
            bubble.other.text = ""
            bubble.say.text = ""
            bubble.doing.text = ""
            bubble.thinking.text = ""
            bubble.activityText = ""
            otherFade?.invalidate()
            fade?.invalidate()
            dropWaitingWords()
        }
        if let muted = message["muted"] as? Bool {
            if muted && !bubble.muted { dismissedByUser = false }
            bubble.muted = muted
        }
        if let listening = message["listening"] as? Bool {
            self.listening = listening
            if listening { dismissedByUser = false; fnOpened = true } else if !bubble.muted { dismissedByUser = true }  // muted: stay up
            bubble.editing = listening
        }
        if let dictating = message["dictating"] as? Bool {
            self.dictating = dictating
            if dictating { dismissedByUser = false; fnOpened = true }  // you're talking to it: show what it hears
        }
        if let handsFree = message["hands_free"] as? Bool {
            self.handsFree = handsFree
        }
        if let camera = message["camera"] as? String {
            self.camera = camera
            if camera == "starting" || camera == "on" { dismissedByUser = false }
            if camera == "starting" { fnOpened = true }
            if camera != "on" { framing = ""; bubble.previewVisible = false; bubble.preview.image = nil }
            bubble.editing = camera != "off" || listening
        }
        if let value = message["framing"] as? String { framing = value }
        if camera == "on", let value = message["preview"] as? String,
           let data = Data(base64Encoded: value), let image = NSImage(data: data) {
            bubble.preview.image = image
            bubble.previewVisible = true
        }
        if let paused = message["paused"] as? String {
            if !tidy(paused).isEmpty && bubble.paused.isBlank { dismissedByUser = false }
            bubble.paused.text = paused
        }
        if let request = message["agent_request"] as? String {
            bubble.other.text = request
            scheduleOtherFade()
        }
        if let words = message["hearing"] as? String {
            bubble.heard.text = words
        }
        if message["hearing"] != nil || message["camera"] != nil {
            heardFade?.invalidate()
            let words = bubble.heard.body.clean
            if !words.isEmpty && camera != "on" {
                heardFade = Timer.scheduledTimer(withTimeInterval: 2.5 + 0.04 * Double(words.count), repeats: false) { _ in
                    self.handle(["hearing": ""])
                }
            }
        }
        if let words = message["say"] as? String {
            say(words)
        }
        if let doing = message["doing"] as? String {
            bubble.doing.text = doing
        }
        if let thinking = message["thinking"] as? String {
            bubble.thinking.text = thinking
        }
        if let active = message["active"] as? Bool {
            if active && !bubble.active {
                dismissedByUser = false
                bubble.detailsOpen = true
                dropWaitingWords()  // a new task: what the last one still had to say is stale now
            }
            bubble.active = active
            scheduleOtherFade()
        }
        if let activity = message["activity"] as? String, !activity.isEmpty {
            let current = bubble.activityText
            bubble.activityText = String((current + (current.isEmpty ? "" : "\n\n") + activity).suffix(30_000))
        }
        if !fnInUse { fnOpened = false }  // that fn interaction is over: hidden again if the window is off
        show()
        if message["active"] as? Bool == true { releaseFocus() }  // a task started: it types in the app in front
        if let focus = message["focus"] as? Bool { focus ? focusEntry() : releaseFocus() }
    }

    func savedAnchor() -> Anchor? {
        guard let saved = UserDefaults.standard.dictionary(forKey: positionKey),
              let x = saved["x"] as? Double, let y = saved["y"] as? Double else { return nil }
        return Anchor(x: x, y: y, top: saved["top"] as? Bool ?? false)
    }

    /// After a drag: pulls the card back fully onto the screen the pointer let go on, and remembers it there.
    func settle() {
        let pointer = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? window.screen ?? NSScreen.main
        else { return }
        let area = screen.visibleFrame
        var frame = window.frame
        frame.origin.x = min(max(frame.minX, area.minX + 8), area.maxX - frame.width - 8)
        frame.origin.y = min(max(frame.minY, area.minY + 8), area.maxY - frame.height - 8)
        window.setFrameOrigin(frame.origin)
        let top = frame.midY > area.midY
        UserDefaults.standard.set(["x": Double(frame.midX), "y": Double(top ? frame.maxY : frame.minY), "top": top],
                                  forKey: positionKey)
        show()
    }

    /// The workspace display when the agent works in its own (and nothing when that's gone), otherwise the
    /// screen the card was dragged to, otherwise the main one.
    /// Where the card goes: the virtual workspace's display when Hive works there and it's up,
    /// otherwise your screen. Never nowhere: while Hive listens, you see the card.
    func targetScreen() -> NSScreen? {
        if ProcessInfo.processInfo.environment["AGENT_SPACEO_COMMAND"] != nil {
            let state = ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ??
                FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Personal Agent").path
            let path = URL(fileURLWithPath: state).appendingPathComponent("workspace-display-id")
            if let raw = try? String(contentsOf: path, encoding: .utf8),
               let displayID = UInt32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
               CGDisplayVendorNumber(displayID) == 0x1AF2,
               CGDisplayModelNumber(displayID) == 0x0001,
               let screen = NSScreen.screens.first(where: {
                   ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
               }) {
                return screen
            }
        }
        if bubble.dragging, let screen = NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: window.frame.midX, y: window.frame.midY)) }) {
            return screen
        }
        if let anchor = savedAnchor(), let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor.probe) }) {
            return screen
        }
        return NSScreen.screens.first ?? NSScreen.main
    }

    func hide() {
        window.ignoresMouseEvents = true
        if window.isKeyWindow {  // don't keep the keyboard through the fade
            window.makeFirstResponder(nil)
            window.orderOut(nil)
            emit(["focused": false])
        }
        guard visible else { return }
        visible = false
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; window.animator().alphaValue = 0 }, completionHandler: {
            if !self.visible { self.window.orderOut(nil) }
        })
    }

    func show() {
        let line = headerLine(camera: camera, framing: framing, muted: bubble.muted, dictating: dictating,
                              listening: listening, active: bubble.active, handsFree: handsFree)
        bubble.setHeader(symbol: line.symbol, text: line.text, icon: line.icon, color: line.color)
        if dismissedByUser || (windowOff && !(fnOpened && fnInUse)) || !(bubble.hasContent || dictating || camera != "off") {
            hide(); return
        }
        guard let screen = targetScreen() else {
            visible = false
            window.ignoresMouseEvents = true
            window.orderOut(nil)
            return
        }
        let area = screen.visibleFrame
        bubble.layOut(width: min(cardWidth, area.width - 32), maxHeight: max(140, floor(area.height * 0.4)))
        let size = bubble.frame.size
        var origin: NSPoint
        if bubble.dragging {
            origin = window.frame.origin  // stays under the pointer
        } else {
            if let anchor = savedAnchor(), screen.frame.contains(anchor.probe) {
                origin = NSPoint(x: anchor.x - size.width / 2, y: anchor.top ? anchor.y - size.height : anchor.y)
            } else {
                origin = NSPoint(x: area.midX - size.width / 2, y: area.minY + 36)
            }
            origin.x = min(max(origin.x, area.minX + 8), area.maxX - size.width - 8)
            origin.y = min(max(origin.y, area.minY + 8), area.maxY - size.height - 8)
        }
        window.setFrame(NSRect(origin: origin, size: size), display: true)
        window.invalidateShadow()
        window.ignoresMouseEvents = false  // the card takes clicks (drag, buttons); the rest of the screen doesn't
        window.orderFrontRegardless()
        if !visible {
            visible = true
            NSAnimationContext.runAnimationGroup { $0.duration = 0.15; window.animator().alphaValue = 1 }
        }
    }
}

// MARK: - Main

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "--snapshot" {
    _ = NSApplication.shared
    let bubble = Bubble(frame: .zero)
    bubble.snapshot = true
    var rest = Array(args[3...])
    var camera = "off", listening = false, dictating = false
    while let flag = rest.first, flag.hasPrefix("--") {
        rest.removeFirst()
        let value = ["--paused", "--other", "--hearing", "--thinking"].contains(flag) && !rest.isEmpty ? rest.removeFirst() : ""
        switch flag {
        case "--activity":
            bubble.active = true
            bubble.editing = true
            bubble.detailsOpen = true
            bubble.activityText = "Plan: Find the meeting date.\n\nTool: read_selected_text()\n\nResult: Team meeting Wednesday at 3 PM."
        case "--camera": camera = "on"
        case "--listening": listening = true; bubble.editing = true
        case "--dictating": dictating = true
        case "--muted": bubble.muted = true
        case "--paused": bubble.paused.text = value
        case "--other": bubble.other.text = value
        case "--hearing": bubble.heard.text = value
        case "--thinking": bubble.thinking.text = value
        default: break
        }
    }
    let line = headerLine(camera: camera, framing: "", muted: bubble.muted, dictating: dictating, listening: listening,
                          active: bubble.active)
    bubble.setHeader(symbol: line.symbol, text: line.text, icon: line.icon, color: line.color)
    bubble.say.text = rest.first ?? ""
    bubble.doing.text = rest.count > 1 ? rest[1] : ""
    bubble.layOut(width: cardWidth, maxHeight: 420)
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
