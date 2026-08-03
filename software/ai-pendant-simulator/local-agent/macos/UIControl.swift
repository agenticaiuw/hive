// aipendant-uicontrol — mouse / keyboard / accessibility helper for the AI Pendant
// local agent.
//
// Why a compiled helper at all: CGEventPost is the only reliable way to
// synthesize mouse events on macOS (AppleScript's System Events has no
// click-at-coordinate primitive), and walking an AXUIElement tree through
// osascript is orders of magnitude slower and cannot read element frames.
//
// TCC: this binary is deliberately unsigned and un-bundled. It MUST be spawned
// as a short-lived direct child of the agent process ("AI Pendant Agent.app").
// Responsibility for TCC is inherited across posix_spawn, so the child inherits
// the parent's Accessibility grant. Do not daemonize it, do not wrap it in its
// own .app, do not launch it via launchctl, do not child.unref() it — any of
// those makes it its own TCC subject and every event is silently swallowed.
//
// Every subcommand prints exactly one line of JSON on stdout.

import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation

let env = ProcessInfo.processInfo.environment
let dryRun = env["PENDANT_INPUT_DRYRUN"] == "1"

func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    var payload = object
    if payload["ok"] == nil { payload["ok"] = exitCode == 0 }
    if dryRun { payload["dryRun"] = true }
    let data =
        (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        ?? Data("{\"ok\":false,\"code\":\"ENCODE\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "message": message], exitCode: 2)
}

// MARK: - Displays and coordinate space

// CGDisplayBounds and CGEvent both use a global, top-left-origin point space,
// so they need no conversion between them. NSScreen.frame does NOT (bottom-left
// origin) and is deliberately never used for geometry here.
func activeDisplays() -> [[String: Any]] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)

    var rows: [[String: Any]] = []
    for (index, id) in ids.prefix(Int(count)).enumerated() {
        let bounds = CGDisplayBounds(id)
        // NOTE: CGDisplayPixelsWide() returns POINTS on Retina displays, not
        // backing pixels. Deriving scale from it yields 1.0 and every
        // screenshot-derived click lands at half the intended offset.
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
            scale = Double(mode.pixelWidth) / Double(mode.width)
        }
        rows.append([
            "id": Int(id),
            "index": index + 1,
            "x": bounds.origin.x,
            "y": bounds.origin.y,
            "w": bounds.size.width,
            "h": bounds.size.height,
            "scale": scale,
            "main": CGDisplayIsMain(id) != 0,
        ])
    }
    return rows
}

func displayUnionContains(_ point: CGPoint) -> Bool {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return false }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    for id in ids.prefix(Int(count)) where CGDisplayBounds(id).contains(point) {
        return true
    }
    return false
}

func requirePoint(_ x: Double?, _ y: Double?, _ what: String) -> CGPoint {
    guard let x, let y, x.isFinite, y.isFinite else {
        fail("BAD_COORDINATE", "\(what) requires finite numeric x and y.")
    }
    let point = CGPoint(x: x, y: y)
    guard displayUnionContains(point) else {
        fail(
            "OFF_SCREEN",
            "Point (\(x), \(y)) is not inside any active display.")
    }
    return point
}

// MARK: - Secure input interlock

// IsSecureEventInputEnabled() is true system-wide whenever any password field
// holds focus. Checking it here rather than in JS means a caller cannot race or
// bypass it: the agent structurally cannot type into, or photograph, a password
// prompt.
func assertNotSecureInput(_ what: String) {
    if IsSecureEventInputEnabled() {
        emit(
            [
                "ok": false,
                "code": "SECURE_INPUT",
                "message":
                    "Refusing to \(what): macOS secure input is active (a password field has focus).",
            ], exitCode: 3)
    }
}

// MARK: - Modifiers and keys

func parseModifiers(_ raw: String?) -> CGEventFlags {
    var flags: CGEventFlags = []
    for token in (raw ?? "").lowercased().split(whereSeparator: { $0 == "," || $0 == "+" }) {
        switch token {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        case "": continue
        default: fail("BAD_MODIFIER", "Unsupported modifier: \(token)")
        }
    }
    return flags
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25,
    "7": 26, "minus": 27, "8": 28, "0": 29, "rightbracket": 30, "o": 31, "u": 32,
    "leftbracket": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38,
    "quote": 39, "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44,
    "n": 45, "m": 46, "period": 47, "tab": 48, "space": 49, "grave": 50, "backtick": 50,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "keypaddecimal": 65, "keypadmultiply": 67, "keypadplus": 69, "keypadclear": 71,
    "keypaddivide": 75, "keypadenter": 76, "keypadminus": 78, "keypadequals": 81,
    "keypad0": 82, "keypad1": 83, "keypad2": 84, "keypad3": 85, "keypad4": 86,
    "keypad5": 87, "keypad6": 88, "keypad7": 89, "keypad8": 91, "keypad9": 92,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107,
    "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80,
    "help": 114, "home": 115, "pageup": 116, "pgup": 116, "forwarddelete": 117,
    "end": 119, "pagedown": 121, "pgdn": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
]

struct KeyChord {
    let code: CGKeyCode
    let flags: CGEventFlags
}

func parseChord(_ spec: String) -> KeyChord {
    var parts = spec.lowercased().split(separator: "+").map {
        $0.trimmingCharacters(in: .whitespaces)
    }
    guard let last = parts.popLast(), !last.isEmpty else {
        fail("BAD_KEYS", "Empty key specification.")
    }
    let flags = parseModifiers(parts.joined(separator: "+"))
    guard let code = keyCodes[last] else {
        fail("UNKNOWN_KEY", "Unknown key: \(last)")
    }
    return KeyChord(code: code, flags: flags)
}

// MARK: - Event posting

let eventTap = CGEventTapLocation.cghidEventTap

func post(_ event: CGEvent?) {
    guard let event else { fail("EVENT", "Could not create a CGEvent.") }
    if dryRun { return }
    event.post(tap: eventTap)
}

func mouseTypes(_ button: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch button {
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    case "left": return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    default: fail("BAD_BUTTON", "Unsupported mouse button: \(button)")
    }
}

func moveMouse(to point: CGPoint) {
    let event = CGEvent(
        mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point,
        mouseButton: .left)
    post(event)
}

func clickMouse(at point: CGPoint, button: String, clicks: Int, flags: CGEventFlags) {
    let (cgButton, downType, upType, _) = mouseTypes(button)
    moveMouse(to: point)
    // A double click is ONE down/up pair with clickState 2 — not two separate
    // clicks. Sending two single clicks is why synthesized double clicks
    // usually fail to register.
    for index in 1...max(1, clicks) {
        for type in [downType, upType] {
            guard
                let event = CGEvent(
                    mouseEventSource: nil, mouseType: type, mouseCursorPosition: point,
                    mouseButton: cgButton)
            else { fail("EVENT", "Could not create a mouse event.") }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            event.flags = flags
            post(event)
        }
    }
}

func dragMouse(
    from start: CGPoint, to end: CGPoint, button: String, steps: Int, flags: CGEventFlags
) {
    let (cgButton, downType, upType, dragType) = mouseTypes(button)
    let stepCount = max(2, min(steps, 200))

    func send(_ type: CGEventType, _ point: CGPoint) {
        guard
            let event = CGEvent(
                mouseEventSource: nil, mouseType: type, mouseCursorPosition: point,
                mouseButton: cgButton)
        else { fail("EVENT", "Could not create a drag event.") }
        event.flags = flags
        post(event)
    }

    moveMouse(to: start)
    send(downType, start)
    // A single jump from A to B is ignored by most AppKit drag targets; the
    // interpolated intermediate events are what make the drag register.
    for step in 1...stepCount {
        let t = Double(step) / Double(stepCount)
        let eased = t * t * (3 - 2 * t)
        send(
            dragType,
            CGPoint(
                x: start.x + (end.x - start.x) * eased,
                y: start.y + (end.y - start.y) * eased))
        if !dryRun { usleep(6000) }
    }
    send(upType, end)
}

// MARK: - Accessibility tree

let interactiveRoles: Set<String> = [
    "AXButton", "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXLink",
    "AXSlider", "AXTabGroup", "AXRow", "AXCell", "AXDisclosureTriangle",
    "AXIncrementor", "AXSearchField", "AXToolbar", "AXStaticText",
]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func frameOf(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = attribute(element, kAXPositionAttribute as String),
        let sizeValue = attribute(element, kAXSizeAttribute as String)
    else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    // AXPosition / AXSize are already in POINTS — the same space CGEvent
    // consumes — so nothing on this path is ever scaled.
    guard
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: origin, size: size)
}

func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = attribute(element, kAXChildrenAttribute as String),
        let children = value as? [AXUIElement]
    else { return [] }
    return children
}

func appElement(_ name: String) -> (AXUIElement, String) {
    let workspace = NSWorkspace.shared
    let wanted = name.lowercased()
    let apps = workspace.runningApplications.filter { $0.activationPolicy == .regular }
    let match: NSRunningApplication? =
        (wanted == "frontmost" || wanted.isEmpty)
        ? workspace.frontmostApplication
        : apps.first(where: { ($0.localizedName ?? "").lowercased() == wanted })
            ?? apps.first(where: { ($0.localizedName ?? "").lowercased().contains(wanted) })
    guard let app = match else { fail("NO_APP", "No running application matched: \(name)") }
    return (AXUIElementCreateApplication(app.processIdentifier), app.localizedName ?? name)
}

struct FoundElement {
    let ref: String
    let role: String
    let title: String
    let frame: CGRect?
    let element: AXUIElement
}

func walk(
    _ element: AXUIElement, ref: String, depth: Int, limit: Int, into results: inout [FoundElement]
) {
    if results.count >= limit || depth > 14 { return }
    let role = stringAttribute(element, kAXRoleAttribute as String) ?? ""
    let title =
        stringAttribute(element, kAXTitleAttribute as String)
        ?? stringAttribute(element, kAXDescriptionAttribute as String)
        ?? stringAttribute(element, kAXValueAttribute as String) ?? ""
    if interactiveRoles.contains(role) {
        results.append(
            FoundElement(ref: ref, role: role, title: title, frame: frameOf(element), element: element)
        )
    }
    for (index, child) in childrenOf(element).enumerated() {
        if results.count >= limit { return }
        walk(child, ref: "\(ref)/\(index)", depth: depth + 1, limit: limit, into: &results)
    }
}

func snapshot(_ appName: String, limit: Int) -> (String, [FoundElement]) {
    let (root, resolved) = appElement(appName)
    var results: [FoundElement] = []
    for (index, child) in childrenOf(root).enumerated() {
        walk(child, ref: "\(index)", depth: 1, limit: limit, into: &results)
    }
    return (resolved, results)
}

func encode(_ found: FoundElement) -> [String: Any] {
    var row: [String: Any] = [
        "ref": found.ref,
        "role": found.role,
        "title": String(found.title.prefix(120)),
    ]
    if let frame = found.frame {
        row["x"] = frame.origin.x
        row["y"] = frame.origin.y
        row["w"] = frame.size.width
        row["h"] = frame.size.height
        let center = CGPoint(x: frame.midX, y: frame.midY)
        // Unopened menu items report degenerate frames (often the display's
        // bottom-left corner). Clicking those coordinates hits the Dock.
        let offscreen =
            frame.size.width <= 1 || frame.size.height <= 1 || !displayUnionContains(center)
        row["offscreen"] = offscreen
        if !offscreen {
            row["centerX"] = center.x
            row["centerY"] = center.y
        }
    } else {
        row["offscreen"] = true
    }
    return row
}

func resolve(_ appName: String, ref: String?, title: String?, contains: String?, nth: Int)
    -> (String, FoundElement)
{
    let (resolved, elements) = snapshot(appName, limit: 4000)
    if let ref, !ref.isEmpty {
        guard let match = elements.first(where: { $0.ref == ref }) else {
            fail("STALE_REF", "No element at ref \(ref) in \(resolved).")
        }
        return (resolved, match)
    }
    let wantedTitle = (title ?? "").lowercased()
    let wantedContains = (contains ?? "").lowercased()
    guard !wantedTitle.isEmpty || !wantedContains.isEmpty else {
        fail("BAD_TARGET", "Provide ref, title, or titleContains.")
    }
    let scored = elements.compactMap { element -> (Int, FoundElement)? in
        let candidate = element.title.lowercased()
        if !wantedTitle.isEmpty && candidate == wantedTitle { return (100, element) }
        if !wantedContains.isEmpty && candidate.hasPrefix(wantedContains) { return (80, element) }
        if !wantedContains.isEmpty && candidate.contains(wantedContains) { return (60, element) }
        if !wantedTitle.isEmpty && candidate.contains(wantedTitle) { return (50, element) }
        return nil
    }.sorted { $0.0 > $1.0 }
    guard scored.count > nth else {
        fail("NOT_FOUND", "No element matched in \(resolved).")
    }
    return (resolved, scored[nth].1)
}

// MARK: - Argument parsing

var positional: [String] = []
var flags: [String: String] = [:]
var iterator = CommandLine.arguments.dropFirst().makeIterator()
while let argument = iterator.next() {
    if argument.hasPrefix("--") {
        let body = String(argument.dropFirst(2))
        if let equals = body.firstIndex(of: "=") {
            flags[String(body[body.startIndex..<equals])] = String(body[body.index(after: equals)...])
        } else {
            flags[body] = iterator.next() ?? ""
        }
    } else {
        positional.append(argument)
    }
}

func flagDouble(_ name: String) -> Double? { flags[name].flatMap(Double.init) }
func flagInt(_ name: String, _ fallback: Int) -> Int { flags[name].flatMap(Int.init) ?? fallback }
func flagString(_ name: String) -> String? { flags[name] }

guard let command = positional.first else {
    fail("USAGE", "Usage: aipendant-uicontrol <probe|displays|cursor|move|click|down|up|drag|scroll|key|type|snapshot|find|press|menu|hittest>")
}

let modifierFlags = parseModifiers(flagString("modifiers"))

switch command {
case "probe":
    // A zero-delta move to the cursor's own location: a genuine no-op that
    // still proves the event tap accepts posted events.
    let location = CGEvent(source: nil)?.location ?? .zero
    let trusted = AXIsProcessTrusted()
    if trusted { moveMouse(to: location) }
    emit([
        "axTrusted": trusted,
        "secureInput": IsSecureEventInputEnabled(),
        "cursor": ["x": location.x, "y": location.y],
        "displays": activeDisplays(),
        "eventPostAttempted": trusted,
    ])

case "displays":
    emit(["displays": activeDisplays()])

case "cursor":
    let location = CGEvent(source: nil)?.location ?? .zero
    emit(["x": location.x, "y": location.y])

case "move":
    let point = requirePoint(flagDouble("x"), flagDouble("y"), "move")
    moveMouse(to: point)
    emit(["x": point.x, "y": point.y])

case "click":
    let point = requirePoint(flagDouble("x"), flagDouble("y"), "click")
    let clicks = max(1, min(flagInt("clicks", 1), 3))
    let button = flagString("button") ?? "left"
    clickMouse(at: point, button: button, clicks: clicks, flags: modifierFlags)
    emit(["x": point.x, "y": point.y, "button": button, "clicks": clicks])

case "down", "up":
    let point = requirePoint(flagDouble("x"), flagDouble("y"), command)
    let button = flagString("button") ?? "left"
    let (cgButton, downType, upType, _) = mouseTypes(button)
    moveMouse(to: point)
    guard
        let event = CGEvent(
            mouseEventSource: nil, mouseType: command == "down" ? downType : upType,
            mouseCursorPosition: point, mouseButton: cgButton)
    else { fail("EVENT", "Could not create a mouse event.") }
    event.flags = modifierFlags
    post(event)
    emit(["x": point.x, "y": point.y, "button": button, "phase": command])

case "drag":
    let start = requirePoint(flagDouble("fromX"), flagDouble("fromY"), "drag start")
    let end = requirePoint(flagDouble("toX"), flagDouble("toY"), "drag end")
    dragMouse(
        from: start, to: end, button: flagString("button") ?? "left",
        steps: flagInt("steps", 24), flags: modifierFlags)
    emit(["fromX": start.x, "fromY": start.y, "toX": end.x, "toY": end.y])

case "scroll":
    let dx = flagDouble("dx") ?? 0
    let dy = flagDouble("dy") ?? 0
    guard dx.isFinite, dy.isFinite, dx != 0 || dy != 0 else {
        fail("BAD_SCROLL", "scroll requires a finite non-zero dx or dy.")
    }
    if let x = flagDouble("x"), let y = flagDouble("y") {
        moveMouse(to: requirePoint(x, y, "scroll"))
    }
    // Pixel units (not line units) give trackpad-like behavior.
    guard
        let event = CGEvent(
            scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
            wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0)
    else { fail("EVENT", "Could not create a scroll event.") }
    event.flags = modifierFlags
    post(event)
    emit(["dx": dx, "dy": dy])

case "key":
    assertNotSecureInput("press keys")
    guard let spec = flagString("keys"), !spec.isEmpty else {
        fail("BAD_KEYS", "key requires --keys.")
    }
    let chord = parseChord(spec)
    let repeats = max(1, min(flagInt("repeat", 1), 50))
    let holdMs = max(0, min(flagInt("holdMs", 0), 10_000))
    for _ in 1...repeats {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: chord.code, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: chord.code, keyDown: false)
        else { fail("EVENT", "Could not create a key event.") }
        down.flags = chord.flags
        up.flags = chord.flags
        post(down)
        if holdMs > 0 && !dryRun { usleep(UInt32(holdMs) * 1000) }
        post(up)
        if repeats > 1 && !dryRun { usleep(12000) }
    }
    emit(["keys": spec, "repeat": repeats])

case "type":
    assertNotSecureInput("type text")
    let text = flagString("text") ?? ""
    guard !text.isEmpty else { fail("BAD_TEXT", "type requires --text.") }
    let perChar = max(0, min(flagInt("perCharDelayMs", 0), 200))
    // keyboardSetUnicodeString is layout independent and handles emoji, CJK
    // and newlines, none of which survive AppleScript `keystroke`.
    let characters = Array(text)
    for chunk in stride(from: 0, to: characters.count, by: 20) {
        let slice = String(characters[chunk..<min(chunk + 20, characters.count)])
        let utf16 = Array(slice.utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { fail("EVENT", "Could not create a typing event.") }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        post(down)
        post(up)
        if !dryRun { usleep(UInt32(max(perChar * 20, 8)) * 1000) }
    }
    emit(["characters": characters.count])

case "snapshot":
    guard AXIsProcessTrusted() else { fail("NO_AX", "Accessibility permission is not granted.") }
    let (resolved, elements) = snapshot(flagString("app") ?? "frontmost", limit: flagInt("max", 120))
    let rows = elements.map(encode)
    emit([
        "app": resolved,
        "semanticAvailable": !rows.isEmpty,
        "elements": rows,
    ])

case "find":
    guard AXIsProcessTrusted() else { fail("NO_AX", "Accessibility permission is not granted.") }
    let (resolved, found) = resolve(
        flagString("app") ?? "frontmost", ref: flagString("ref"), title: flagString("title"),
        contains: flagString("titleContains"), nth: flagInt("nth", 0))
    emit(["app": resolved, "element": encode(found)])

case "press":
    guard AXIsProcessTrusted() else { fail("NO_AX", "Accessibility permission is not granted.") }
    let (resolved, found) = resolve(
        flagString("app") ?? "frontmost", ref: flagString("ref"), title: flagString("title"),
        contains: flagString("titleContains"), nth: flagInt("nth", 0))
    var method = "press"
    if dryRun {
        method = "dryrun"
    } else if AXUIElementPerformAction(found.element, kAXPressAction as CFString) != .success {
        guard let frame = found.frame, displayUnionContains(CGPoint(x: frame.midX, y: frame.midY))
        else { fail("NO_PRESS", "Element exposes no press action and has no on-screen frame.") }
        clickMouse(
            at: CGPoint(x: frame.midX, y: frame.midY), button: "left", clicks: 1, flags: [])
        method = "mouse"
    }
    emit(["app": resolved, "element": encode(found), "method": method])

case "menu":
    guard AXIsProcessTrusted() else { fail("NO_AX", "Accessibility permission is not granted.") }
    let (root, resolved) = appElement(flagString("app") ?? "frontmost")
    let pathParts = (flagString("path") ?? "").split(separator: "\u{1}").map(String.init)
    guard !pathParts.isEmpty else { fail("BAD_PATH", "menu requires --path.") }
    guard let menuBarValue = attribute(root, kAXMenuBarAttribute as String) else {
        fail("NO_MENU", "\(resolved) exposes no menu bar.")
    }
    var current = menuBarValue as! AXUIElement
    var walked: [String] = []
    for part in pathParts {
        var matched: AXUIElement?
        for child in childrenOf(current) {
            let title = stringAttribute(child, kAXTitleAttribute as String) ?? ""
            if title.lowercased() == part.lowercased() { matched = child; break }
        }
        guard let target = matched else {
            fail("NO_MENU_ITEM", "Menu item not found: \(part) (after \(walked.joined(separator: " > ")))")
        }
        walked.append(part)
        if !dryRun {
            AXUIElementPerformAction(target, kAXPressAction as CFString)
            usleep(120_000)
        }
        current = childrenOf(target).first ?? target
    }
    emit(["app": resolved, "path": walked])

case "hittest":
    guard AXIsProcessTrusted() else { fail("NO_AX", "Accessibility permission is not granted.") }
    let point = requirePoint(flagDouble("x"), flagDouble("y"), "hittest")
    var element: AXUIElement?
    AXUIElementCopyElementAtPosition(
        AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element)
    guard var current = element else { emit(["title": "", "role": "", "named": false]) }
    // The hit-test result is usually an untitled AXGroup, so walk up to the
    // nearest titled ancestor before deciding the click is "unnamed".
    var title = ""
    var role = stringAttribute(current, kAXRoleAttribute as String) ?? ""
    for _ in 0..<6 {
        let candidate =
            stringAttribute(current, kAXTitleAttribute as String)
            ?? stringAttribute(current, kAXDescriptionAttribute as String) ?? ""
        if !candidate.isEmpty {
            title = candidate
            role = stringAttribute(current, kAXRoleAttribute as String) ?? role
            break
        }
        guard let parent = attribute(current, kAXParentAttribute as String) else { break }
        current = parent as! AXUIElement
    }
    emit(["title": String(title.prefix(120)), "role": role, "named": !title.isEmpty])

default:
    fail("USAGE", "Unknown command: \(command)")
}
