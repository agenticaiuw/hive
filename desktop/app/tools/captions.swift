// Captions for the voice agent: Hive's floating window, a small card in Hive's look (the same as the browser
// extension's popup), by default near the bottom of the screen, with what
// the agent says (big), what it's doing and thinking (small), what you're saying, and requests that came
// from another agent. Drag the card anywhere and it stays there (double-click it to put it back). Reads one
// JSON object per line on stdin and quits when stdin closes:
//
//   {"listening": true}             the mic pill says "Listening", in gold, until {"listening": false}
//   {"dictating": true}             "Dictating" in the header instead, until {"dictating": false}
//   {"hands_free": true}            the dictation (fn + shift) goes on until fn: "press fn to type it"
//   {"muted": true}                 transcription is muted: the mic pill says "Muted", in red, and is crossed
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
//   {"dismiss": true}               hide the card until listening, dictating or a task starts again
//   {"hidden": true}                Show Floating Window is off: the card stays hidden, even when a task starts or
//                                   updates, except while fn is in use (listening or dictating); everything
//                                   sent meanwhile is kept, so {"hidden": false} shows it again as it is now
//   {"clear": true}                 empty the card now (all but the header and the paused row)
//   {"focus": true}                 typing goes to the entry field (fn opened the card); {"focus": false} gives
//                                   the keyboard back to the app in front (so does a new task, sending, the x)
//
// and writes one JSON object per line on stdout:
//
//   {"text": "…"}                   a request typed into the entry field (Return or Send)
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
//   agent-vhid-captions --snapshot out.png [--activity] [--listening|--dictating] [--muted]
//       [--paused TEXT] [--other TEXT] [--hearing TEXT] [--thinking TEXT] "words" ["doing"]
//                                   draws the card into a PNG instead (tests)

import AppKit
import CoreGraphics

// MARK: - Look

// Hive's look, the same values as the browser extension's popup (browser/chrome/src/ui.css) and the
// dashboard: warm near-black, honey gold from the icon, and the system font. Gold is for Hive and for the
// main button; amber and red only say how something is doing.
enum Palette {
    static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
    static func warm(_ alpha: CGFloat) -> NSColor { rgb(255, 244, 228, alpha) }
    static let ink = rgb(246, 243, 238), ink2 = rgb(189, 182, 170), muted = rgb(149, 141, 129)
    static let background = rgb(20, 18, 16), panel = rgb(28, 26, 23)
    static let raise1 = warm(0.04), raise2 = warm(0.07), line = warm(0.085), lineStrong = warm(0.15)
    static let gold = rgb(245, 197, 66), goldHover = rgb(255, 212, 94), onGold = rgb(29, 21, 5)
    static let amber = rgb(255, 173, 92), red = rgb(255, 123, 112)
}

let cardWidth: CGFloat = 540
let cornerRadius: CGFloat = 14
let padX: CGFloat = 16, padTop: CGFloat = 12, padBottom: CGFloat = 14, gap: CGFloat = 10
let headerHeight: CGFloat = 26
let controlsHeight: CGFloat = 36
let positionKey = "CaptionsPosition"

/// Hive's icon (branding/hive.svg, built into build/Hive.icns beside this program), as the popup's header has it.
let hiveLogo: NSImage? = Bundle.main.executableURL.flatMap {
    NSImage(contentsOf: $0.resolvingSymlinksInPath().deletingLastPathComponent().appendingPathComponent("Hive.icns"))
}

/// The system font (SF Pro), as the popup uses.
func uiFont(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont { .systemFont(ofSize: size, weight: weight) }

/// One text style: the system font, a colour and a fixed line height, so every line (emoji ones too) is the
/// same height and a row of n lines is exactly n line heights tall.
struct TextStyle {
    let font: NSFont
    var color: NSColor
    let lineHeight: CGFloat
    let kern: CGFloat

    init(_ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor, kern: CGFloat = 0) {
        font = uiFont(size, weight)
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
/// text; on a rounded panel when it has a `fill` (Hive's raised panel, or amber for the paused row).
final class Section: NSView {
    let body: TextRow
    let caption: TextRow?
    let icon = SymbolView(frame: .zero)
    let fill: NSColor?, edge: NSColor?
    private let padH: CGFloat, padV: CGFloat

    init(_ style: TextStyle, caption: String? = nil, symbol: String, accent: NSColor, fill: NSColor? = nil,
         edge: NSColor? = nil) {
        body = TextRow(style)
        self.caption = caption.map { label in
            let row = TextRow(TextStyle(11.5, .semibold, accent, kern: 0.2))
            row.text = label
            return row
        }
        self.fill = fill
        self.edge = edge
        padH = fill == nil ? 0 : 12
        padV = fill == nil ? 0 : 9
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
        guard let fill else { return }
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        fill.setFill(); path.fill()
        if let edge { edge.setStroke(); path.lineWidth = 1; path.stroke() }
    }
}

/// Hover tracking, a first click that works and a panel that never becomes key, so the app in front keeps
/// the keyboard: what the card's buttons share.
class CardButton: NSButton {
    private(set) var hovering = false
    private var tracking: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        imagePosition = .imageOnly
        focusRingType = .none
        refusesFirstResponder = true
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
    func refresh() { needsDisplay = true }

    /// An SF Symbol in one colour.
    func symbolImage(_ name: String?, _ color: NSColor, size: CGFloat) -> NSImage? {
        name.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: .semibold)
                .applying(NSImage.SymbolConfiguration(paletteColors: [color])))
    }
}

/// The card's own controls (– hide, x stop): a quiet symbol that brightens, on a soft circle, under the pointer.
final class HoverButton: CardButton {
    var symbol: String? { didSet { refresh() } }

    override func draw(_ dirtyRect: NSRect) {
        if hovering {
            Palette.raise2.setFill()
            NSBezierPath(ovalIn: bounds).fill()
        }
        guard let image = symbolImage(symbol, hovering ? Palette.ink : Palette.muted, size: 12) else { return }
        let size = image.size
        image.draw(in: NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                              width: size.width, height: size.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}

/// A pill like the popup's buttons (ui.css): `.outline` is its mic button at rest, `.lit` its mic while it
/// listens (gold) or, here, while transcription is muted (red), `.primary` its gold Send.
final class PillButton: CardButton {
    enum Look { case outline, lit(NSColor), primary }
    var look = Look.outline { didSet { refresh() } }
    var label = "" { didSet { refresh() } }
    var symbol: String? { didSet { refresh() } }
    var symbolAfter = false  // "Activity ⌄": the chevron follows the word

    private var isPrimary: Bool { if case .primary = look { return true } else { return false } }
    private var pillFont: NSFont { uiFont(12.5, isPrimary ? .semibold : .medium) }
    private var symbolSize: CGFloat { label.isEmpty ? 12 : 10 }
    private var colors: (fill: NSColor, edge: NSColor?, ink: NSColor) {
        switch look {
        case .outline: return (hovering ? Palette.raise2 : .clear, Palette.lineStrong, hovering ? Palette.ink : Palette.ink2)
        case .lit(let color): return (color.withAlphaComponent(hovering ? 0.18 : 0.12), color.withAlphaComponent(0.55), color)
        case .primary: return (hovering ? Palette.goldHover : Palette.gold, nil, Palette.onGold)
        }
    }

    private func measure(_ ink: NSColor) -> (text: NSSize, image: NSImage?, spacing: CGFloat) {
        let text = label.isEmpty ? NSSize.zero : (label as NSString).size(withAttributes: [.font: pillFont])
        let image = symbolImage(symbol, ink, size: symbolSize)
        return (text, image, text.width > 0 && image != nil ? 6 : 0)
    }

    /// How wide the pill wants to be for its word and symbol.
    var fittingWidth: CGFloat {
        let (text, image, spacing) = measure(Palette.ink)
        let pad: CGFloat = isPrimary ? 16 : label.isEmpty ? 9 : 11
        return ceil(text.width + (image?.size.width ?? 0) + spacing + 2 * pad)
    }

    override func draw(_ dirtyRect: NSRect) {
        let (fill, edge, ink) = colors
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
        fill.setFill(); path.fill()
        if let edge { edge.setStroke(); path.lineWidth = 1; path.stroke() }
        let (text, image, spacing) = measure(ink)
        let imageSize = image?.size ?? .zero
        var x = (bounds.width - text.width - imageSize.width - spacing) / 2
        func drawImage() {
            guard let image else { return }
            image.draw(in: NSRect(x: x, y: (bounds.height - imageSize.height) / 2, width: imageSize.width,
                                  height: imageSize.height),
                       from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            x += imageSize.width + spacing
        }
        if !symbolAfter { drawImage() }
        if text.width > 0 {
            (label as NSString).draw(at: NSPoint(x: x, y: (bounds.height - text.height) / 2),
                                     withAttributes: [.font: pillFont, .foregroundColor: ink])
            x += text.width + spacing
        }
        if symbolAfter { drawImage() }
    }
}

struct Caps { var paused = 2, other = 3, heard = 3, say = 5, thinking = 3, doing = 1, activity: CGFloat = 140 }

/// The card. Top to bottom: header (Hive's logo and name, status, mic, hide, close), paused, another agent's
/// request, what you're saying, the agent's words, its thinking, what it's doing, the activity log, and the
/// Activity button with the ask box (the popup's: the entry field and a gold Send).
final class Bubble: NSView, NSTextFieldDelegate {
    let chrome = Box(fill: Palette.background.withAlphaComponent(0.97), stroke: Palette.lineStrong, radius: cornerRadius,
                     passesClicks: true)
    let logo = NSImageView(frame: .zero)
    let title = TextRow(TextStyle(15, .semibold, Palette.ink, kern: -0.15))
    let header = TextRow(TextStyle(12.5, .regular, Palette.ink2))
    let muteButton = PillButton(frame: .zero)
    let hideButton = HoverButton(frame: .zero)
    let closeButton = HoverButton(frame: .zero)
    let paused = Section(TextStyle(13.5, .medium, Palette.ink), symbol: "pause.circle.fill", accent: Palette.amber,
                         fill: Palette.amber.withAlphaComponent(0.10), edge: Palette.amber.withAlphaComponent(0.30))
    let other = Section(TextStyle(15, .regular, Palette.ink), caption: "Another agent", symbol: "cpu", accent: Palette.gold,
                        fill: Palette.panel, edge: Palette.line)
    let heard = Section(TextStyle(15, .regular, Palette.ink), caption: "You", symbol: "person.fill", accent: Palette.muted,
                        fill: Palette.panel, edge: Palette.line)
    let say = TextRow(TextStyle(19, .medium, Palette.ink, kern: -0.2))
    let thinking = TextRow(TextStyle(13, .regular, Palette.ink2))
    let doing = Section(TextStyle(13, .medium, Palette.ink2), symbol: "gearshape.fill", accent: Palette.muted)
    let activityBox = Box(fill: Palette.panel, stroke: Palette.line, radius: 10)
    let activityScroll = NSScrollView(frame: .zero)
    let activityView = NSTextView(frame: .zero)
    let detailsButton = PillButton(frame: .zero)
    let entryBox = Box(fill: Palette.panel, stroke: Palette.lineStrong, radius: 12)
    let entry = NSTextField(string: "")
    let sendButton = PillButton(frame: .zero)
    var editing = false, active = false, detailsOpen = false
    var muted = false { didSet { refreshMute() } }
    var listening = false { didSet { refreshMute() } }
    private(set) var dragging = false
    var onMoved: (() -> Void)?
    var onReset: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        addSubview(chrome)

        logo.image = hiveLogo
        logo.imageScaling = .scaleProportionallyUpOrDown
        logo.isHidden = hiveLogo == nil
        title.text = "Hive"
        heard.body.keepEnd = true  // while you talk, the latest words matter
        closeButton.symbol = "xmark"
        closeButton.toolTip = "Stop and close"
        hideButton.symbol = "minus"
        hideButton.toolTip = "Hide; Hive keeps working"
        hideButton.setAccessibilityLabel("Hide the floating window")
        refreshMute()
        detailsButton.label = "Activity"
        detailsButton.symbolAfter = true
        setDetailsChevron()
        sendButton.look = .primary
        sendButton.label = "Send"

        entry.isBordered = false
        entry.isBezeled = false
        entry.drawsBackground = false
        entry.focusRingType = .none
        entry.font = uiFont(14)
        entry.textColor = Palette.ink
        entry.placeholderAttributedString = NSAttributedString(string: "Tell an agent what to do…",
                                                               attributes: [.font: uiFont(14), .foregroundColor: Palette.muted])
        entry.cell?.usesSingleLineMode = true  // a pasted multi-line text becomes one line that scrolls
        entry.cell?.wraps = false
        entry.cell?.isScrollable = true
        entry.cell?.allowsUndo = true
        entry.cell?.sendsActionOnEndEditing = false  // only Return or Send sends it, not clicking away mid-sentence
        entry.delegate = self
        entryBox.addSubview(entry)
        entryBox.addSubview(sendButton)

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

        for view in [logo, title, header, muteButton, hideButton, closeButton, paused, other, heard, say, thinking, doing,
                     activityBox, detailsButton, entryBox] as [NSView] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // The ask box's edge turns gold while you type in it, as the popup's does (.ask:focus-within).
    func controlTextDidBeginEditing(_ obj: Notification) { setEntryFocused(true) }
    func controlTextDidEndEditing(_ obj: Notification) { setEntryFocused(false) }
    func setEntryFocused(_ focused: Bool) {
        entryBox.stroke = focused ? Palette.gold.withAlphaComponent(0.4) : Palette.lineStrong
        entryBox.needsDisplay = true
    }

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
                .font: uiFont(12), .foregroundColor: Palette.ink2, .paragraphStyle: paragraph]))
            activityView.scrollToEndOfDocument(nil)
        }
    }

    func setHeader(text: String, color: NSColor) {
        header.style.color = color
        header.text = text
    }

    func setDetailsChevron() {
        detailsButton.symbol = detailsOpen ? "chevron.up" : "chevron.down"
    }

    /// The mic, as the popup's: an outlined pill at rest, gold and saying "Listening" while it listens, red and
    /// saying "Muted" while transcription is muted.
    private func refreshMute() {
        muteButton.symbol = muted ? "mic.slash.fill" : "mic.fill"
        muteButton.look = muted ? .lit(Palette.red) : listening ? .lit(Palette.gold) : .outline
        muteButton.label = muted ? "Muted" : listening ? "Listening" : ""
        muteButton.toolTip = muted ? "Unmute transcription" : "Mute transcription (the agent keeps working)"
    }

    /// Lays the card out `width` wide and sizes it around its contents, no taller than `maxHeight`: when it
    /// doesn't fit, the log gets shorter and the rows show fewer lines (with "…").
    func layOut(width: CGFloat, maxHeight: CGFloat) {
        let inner = width - 2 * padX
        let full = (paused: paused.lines(width: inner), other: other.lines(width: inner), heard: heard.lines(width: inner),
                    say: say.lines(width: inner), thinking: thinking.lines(width: inner), doing: doing.lines(width: inner))
        let controls = editing || active || detailsOpen
        func heights(_ c: Caps) -> [CGFloat] {
            [paused.height(lines: min(full.paused, c.paused)), other.height(lines: min(full.other, c.other)),
             heard.height(lines: min(full.heard, c.heard)), say.height(lines: min(full.say, c.say)),
             thinking.height(lines: min(full.thinking, c.thinking)), doing.height(lines: min(full.doing, c.doing)),
             detailsOpen ? c.activity : 0, controls ? controlsHeight : 0]
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
        let detailsOpen = self.detailsOpen
        let steps: [(inout Caps) -> Bool] = [
            { c in guard detailsOpen, c.activity > 72 else { return false }; c.activity = max(72, c.activity - 16); return true },
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
        chrome.frame = bounds

        // Hive's logo and name, as the popup's header; then what's going on. The window's own controls (– hide,
        // x stop) together on the right; the mic, about the transcript, apart.
        closeButton.frame = NSRect(x: width - 12 - 26, y: padTop, width: 26, height: 26)
        hideButton.frame = NSRect(x: closeButton.frame.minX - 28, y: padTop, width: 26, height: 26)
        let micWidth = max(muteButton.fittingWidth, 32)
        muteButton.frame = NSRect(x: hideButton.frame.minX - 10 - micWidth, y: padTop, width: micWidth, height: 26)
        logo.frame = NSRect(x: padX, y: padTop + 2, width: 22, height: 22)
        let titleX = logo.isHidden ? padX : padX + 30
        let titleWidth = ceil(("Hive" as NSString).size(withAttributes: [.font: title.style.font]).width) + 2
        title.place(x: titleX, y: padTop + (headerHeight - title.height(lines: 1)) / 2, width: titleWidth, cap: 1)
        let headerX = titleX + titleWidth + 6
        header.place(x: headerX, y: padTop + (headerHeight - header.height(lines: 1)) / 2,
                     width: max(0, muteButton.frame.minX - 8 - headerX), cap: 1)

        var y = padTop + headerHeight + gap
        func put(_ height: CGFloat) { if height > 0 { y += height + gap } }
        put(paused.place(x: padX, y: y, width: inner, cap: caps.paused))
        put(other.place(x: padX, y: y, width: inner, cap: caps.other))
        put(heard.place(x: padX, y: y, width: inner, cap: caps.heard))
        put(say.place(x: padX, y: y, width: inner, cap: caps.say))
        put(thinking.place(x: padX, y: y, width: inner, cap: caps.thinking))
        put(doing.place(x: padX, y: y, width: inner, cap: caps.doing))
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
            let detailsWidth = detailsButton.fittingWidth
            detailsButton.frame = NSRect(x: padX, y: y + (controlsHeight - 30) / 2, width: detailsWidth, height: 30)
            let boxX = padX + detailsWidth + 8
            entryBox.frame = NSRect(x: boxX, y: y, width: inner - (boxX - padX), height: controlsHeight)
            let sendWidth = sendButton.fittingWidth
            sendButton.frame = NSRect(x: entryBox.frame.width - 4 - sendWidth, y: 4, width: sendWidth, height: controlsHeight - 8)
            let fieldHeight = ceil(entry.intrinsicContentSize.height)
            entry.frame = NSRect(x: 12, y: (controlsHeight - fieldHeight) / 2, width: sendButton.frame.minX - 8 - 12,
                                 height: fieldHeight)
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

struct Header { let text: String, color: NSColor }

/// What follows "Hive" in the header. The mic pill already says "Listening" or "Muted", so this doesn't.
func headerLine(muted: Bool, dictating: Bool, listening: Bool, active: Bool, handsFree: Bool = false) -> Header {
    if dictating {
        return Header(text: handsFree ? "· Dictating, press fn to type it" : "· Dictating, let go of fn to type it",
                      color: Palette.ink2)
    }
    if muted { return Header(text: active ? "· the agent keeps working" : "", color: Palette.ink2) }
    return Header(text: active && !listening ? "· working" : "", color: Palette.ink2)
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
    var listening = false, dictating = false, handsFree = false
    var dismissedByUser = false
    var visible = false
    /// Show Floating Window is off (the menu, or the – button): hidden except while fn is in use.
    var windowOff = false
    /// fn opened the card since it was last hidden: listening or dictating started.
    var fnOpened = false
    var fnInUse: Bool { listening || dictating }

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
        bubble.sendButton.target = self
        bubble.sendButton.action = #selector(submit)
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

    /// The x: asks for the task to stop and collapses the card until listening, dictating or a task starts again.
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
            bubble.listening = listening
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
        if message["hearing"] != nil {
            heardFade?.invalidate()
            let words = bubble.heard.body.clean
            if !words.isEmpty {
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
    /// ~/Library/Application Support/Hive, or its old name on a Mac that has only that.
    static func hiveFolder() -> URL {
        let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        let hive = support.appendingPathComponent("Hive"), old = support.appendingPathComponent("Personal Agent")
        let has = { (url: URL) in FileManager.default.fileExists(atPath: url.path) }
        return !has(hive) && has(old) ? old : hive
    }

    func targetScreen() -> NSScreen? {
        if ProcessInfo.processInfo.environment["AGENT_WORKSPACE_ENGINE"] != nil {
            let state = ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ??
                Captions.hiveFolder().path
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
        let line = headerLine(muted: bubble.muted, dictating: dictating, listening: listening, active: bubble.active,
                              handsFree: handsFree)
        bubble.setHeader(text: line.text, color: line.color)
        if dismissedByUser || (windowOff && !(fnOpened && fnInUse)) || !(bubble.hasContent || dictating) {
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
    var rest = Array(args[3...])
    var listening = false, dictating = false
    while let flag = rest.first, flag.hasPrefix("--") {
        rest.removeFirst()
        let value = ["--paused", "--other", "--hearing", "--thinking"].contains(flag) && !rest.isEmpty ? rest.removeFirst() : ""
        switch flag {
        case "--activity":
            bubble.active = true
            bubble.editing = true
            bubble.detailsOpen = true
            bubble.activityText = "Plan: Find the meeting date.\n\nTool: read_selected_text()\n\nResult: Team meeting Wednesday at 3 PM."
        case "--listening": listening = true; bubble.listening = true; bubble.editing = true
        case "--dictating": dictating = true
        case "--muted": bubble.muted = true
        case "--paused": bubble.paused.text = value
        case "--other": bubble.other.text = value
        case "--hearing": bubble.heard.text = value
        case "--thinking": bubble.thinking.text = value
        default: break
        }
    }
    let line = headerLine(muted: bubble.muted, dictating: dictating, listening: listening, active: bubble.active)
    bubble.setHeader(text: line.text, color: line.color)
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
