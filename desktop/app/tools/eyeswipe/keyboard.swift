// Hive's eye keyboard on the Mac: type by looking. Double-tap right ⌘ and a big keyboard covers the screen
// (the first time, look at each yellow dot until it jumps, so it learns your eyes). Then look at each
// letter of a word and blink slowly: the word is typed into the app in front, with a space. If it got the
// word wrong, the other guesses are buttons above the keyboard: look at the right one and blink slowly.
// Esc closes it. That's all there is: a dot shows where it thinks you're looking, looking away pauses it,
// and every word you type tunes it to your eyes a little more.
//
// Gaze comes from the Mac's camera through Apple Vision's face landmarks: where the pupils sit in the eyes,
// how open the lids are, and which way the head points (the nose against the eyes), mapped to the keyboard
// by the dots. Turning your head a little toward each letter helps. Nothing is saved or sent: the camera
// runs only while the keyboard is up, and each frame is dropped once read. The words are decoded by
// EyeSwipe.swift with the language model in eyeswipe-lm.bin (next to this binary, or --lm).
//
// Writes one JSON object per line on stdout: {"typed": "word", "alternatives": [...]}, {"on": true|false},
// {"calibrated": {"x": spread, "y": spread}} (key widths), {"test": {...}} after a test.
//
//   hive-eye-keyboard [--lm path] [--test]    --test: shows sentences to type and counts the wrong words,
//                                             typing nothing into other apps
//   hive-eye-keyboard --snapshot out.png [--calibrating] [--trail]   draws the keyboard into a PNG (tests)
//
// Needs Accessibility (to see right ⌘ and Esc, and to type) and the camera, for the app it runs from.

import AppKit
import AVFoundation
import Vision

let rightCommandKey: Int64 = 54                  // kVK_RightCommand
let escapeKey: Int64 = 53                        // kVK_Escape
let rightCommandDown: UInt64 = 0x10              // NX_DEVICERCMDKEYMASK
let tapSeconds = 0.25, doubleTapSeconds = 0.45
let slowBlink = 0.35                             // eyes closed this long types the word (a normal blink is ~0.15 s)
let lookAwayResets = 0.7                         // looking off the keyboard this long starts the word over

/// What one camera frame says: where the eyes point, eyes closed, or no face (looking away).
enum Look { case gaze(GazeFeatures), closed(Double), away(Double) }
var eventTap: CFMachPort?                         // to turn it back on if macOS pauses it

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func option(_ name: String) -> String? {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return nil
}

// MARK: - Gaze features from the camera

final class GazeCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "eye-camera")
    var onLook: ((Look) -> Void)?
    var typicalOpen: Double? = nil                // how open the eyes usually are, to tell a closed eye

    func start() -> Bool {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return false }
        session.beginConfiguration()
        session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .hd1280x720
        if session.canAddInput(input) { session.addInput(input) }
        // As many frames a second as the camera gives at 720p or more (the bigger picture when it's a tie),
        // held there even in dim light.
        func size(_ f: AVCaptureDevice.Format) -> Int32 { CMVideoFormatDescriptionGetDimensions(f.formatDescription).width }
        func fastest(_ f: AVCaptureDevice.Format) -> AVFrameRateRange? { f.videoSupportedFrameRateRanges.max { $0.maxFrameRate < $1.maxFrameRate } }
        if let format = device.formats.filter({ size($0) >= 1280 && fastest($0) != nil }).max(by: { a, b in
               let fa = fastest(a)!.maxFrameRate, fb = fastest(b)!.maxFrameRate
               return fa != fb ? fa < fb : size(a) < size(b) }),
           (try? device.lockForConfiguration()) != nil {
            device.activeFormat = format
            device.activeVideoMinFrameDuration = fastest(format)!.minFrameDuration
            device.activeVideoMaxFrameDuration = fastest(format)!.minFrameDuration
            device.unlockForConfiguration()
        }
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        queue.async { self.session.startRunning() }
        return true
    }

    func stop() {
        queue.async {
            self.session.stopRunning()
            for i in self.session.inputs { self.session.removeInput(i) }
            for o in self.session.outputs { self.session.removeOutput(o) }
        }
    }

    // Speed: after the first frame, Vision is told where the face is (last frame's box) so it only finds
    // the landmarks, not the face; a fresh search every 20 frames or when it loses the face.
    var lastFace: VNFaceObservation? = nil
    var framesSinceSearch = 0
    var fps = 0.0, msPerFrame = 0.0
    var lastFrame = 0.0

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let began = ProcessInfo.processInfo.systemUptime
        let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let request = VNDetectFaceLandmarksRequest()
        if let face = lastFace, framesSinceSearch < 20 {
            let b = face.boundingBox.insetBy(dx: -face.boundingBox.width * 0.15, dy: -face.boundingBox.height * 0.15)
            request.inputFaceObservations = [VNFaceObservation(boundingBox: b.intersection(CGRect(x: 0, y: 0, width: 1, height: 1)))]
            framesSinceSearch += 1
        } else {
            framesSinceSearch = 0
        }
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up).perform([request])
        let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width })
        lastFace = face?.landmarks != nil ? face : nil
        let now = ProcessInfo.processInfo.systemUptime
        msPerFrame += 0.1 * ((now - began) * 1000 - msPerFrame)
        if lastFrame > 0 { fps += 0.1 * (1 / max(1e-3, time - lastFrame) - fps) }
        lastFrame = time
        guard let face, let marks = face.landmarks else { onLook?(.away(time)); return }
        if var f = features(marks, pixels) {
            if !f.isEmpty {                                                   // head turn and tilt from Vision
                f += [face.yaw?.doubleValue ?? 0, face.pitch?.doubleValue ?? 0]
            }
            onLook?(f.isEmpty ? .closed(time) : .gaze(GazeFeatures(values: f, time: time)))
        } else {
            onLook?(.closed(time))                // a face but no readable eyes: almost always closed eyes
        }
    }

    /// Pupil in each eye (from the darkest part inside the eye outline), lid opening, nose against the eyes
    /// (head turn), where the eyes are in the picture and how far apart (distance). Empty when the eyes
    /// are closed (much less open than usual), nil when they can't be read.
    func features(_ marks: VNFaceLandmarks2D, _ pixels: CVPixelBuffer) -> [Double]? {
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
        let size = CGSize(width: w, height: h)
        guard let le = marks.leftEye?.pointsInImage(imageSize: size), let re = marks.rightEye?.pointsInImage(imageSize: size),
              le.count >= 6, re.count >= 6, let nose = marks.noseCrest?.pointsInImage(imageSize: size).last else { return nil }
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else { return nil }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0)
        let luma = base.assumingMemoryBound(to: UInt8.self)
        var eyes: [(ex: Double, ey: Double, lid: Double, cx: Double, cy: Double)] = []
        var opening = 0.0
        for (outline, pupilMark) in [(le, marks.leftPupil), (re, marks.rightPupil)] {
            let a = outline.min { $0.x < $1.x }!, b = outline.max { $0.x < $1.x }!
            let cx = Double(a.x + b.x) / 2, cy = Double(a.y + b.y) / 2
            let width = Double(hypot(b.x - a.x, b.y - a.y))
            let top = outline.map { Double($0.y) }.max()!, bottom = outline.map { Double($0.y) }.min()!
            guard width > 8 else { return nil }
            opening += (top - bottom) / width / 2
            var pupil = pupilMark?.pointsInImage(imageSize: size).first.map { (Double($0.x), Double($0.y)) } ?? (cx, cy)
            if let dark = darkest(outline, luma, stride, w, h) { pupil = ((pupil.0 + 2 * dark.0) / 3, (pupil.1 + 2 * dark.1) / 3) }
            eyes.append(((pupil.0 - cx) / width, (pupil.1 - cy) / width, (top - cy) / width, cx, cy))
        }
        let usual = typicalOpen ?? opening
        if opening < 0.45 * usual || opening < 0.06 { return [] }            // closed
        typicalOpen = usual + 0.02 * (opening - usual)                          // follows slowly
        let mx = (eyes[0].cx + eyes[1].cx) / 2, my = (eyes[0].cy + eyes[1].cy) / 2
        let iod = hypot(eyes[0].cx - eyes[1].cx, eyes[0].cy - eyes[1].cy)
        guard iod > 10 else { return nil }
        let ex = (eyes[0].ex + eyes[1].ex) / 2, ey = (eyes[0].ey + eyes[1].ey) / 2, lid = (eyes[0].lid + eyes[1].lid) / 2
        let nx = (Double(nose.x) - mx) / iod, ny = (Double(nose.y) - my) / iod
        return [ex, ey, lid, nx, ny, mx / Double(w), my / Double(h), iod / Double(w), ex * ex, ey * ey, nx * ny]
    }

    /// The middle of the darkest pixels inside the eye outline (the pupil and iris), in image points.
    func darkest(_ outline: [CGPoint], _ luma: UnsafePointer<UInt8>, _ stride: Int, _ w: Int, _ h: Int) -> (Double, Double)? {
        let x0 = max(0, Int(outline.map { $0.x }.min()!)), x1 = min(w - 1, Int(outline.map { $0.x }.max()!))
        let y0 = max(0, Int(outline.map { $0.y }.min()!)), y1 = min(h - 1, Int(outline.map { $0.y }.max()!))
        guard x1 > x0 + 4, y1 > y0 + 2 else { return nil }
        let path = CGMutablePath()
        path.addLines(between: outline)
        path.closeSubpath()
        var inside: [(Int, Int, UInt8)] = []
        for y in y0...y1 {
            let row = h - 1 - y                                              // Vision's y goes up, rows go down
            for x in x0...x1 where path.contains(CGPoint(x: x, y: y)) {
                inside.append((x, y, luma[row * stride + x]))
            }
        }
        guard inside.count > 20 else { return nil }
        let cut = inside.map { $0.2 }.sorted()[inside.count / 6]
        var sx = 0.0, sy = 0.0, sw = 0.0
        for (x, y, v) in inside where v <= cut {
            let weight = Double(cut - v) + 1
            sx += Double(x) * weight; sy += Double(y) * weight; sw += weight
        }
        return sw > 0 ? (sx / sw, sy / sw) : nil
    }
}

// MARK: - Typing into the app in front

final class Typer {
    var typed: [String] = []          // what each word put in, this session ("Hello ", ". ")
    var sentenceStart = true
    let source = CGEventSource(stateID: .hidSystemState)

    func key(_ code: CGKeyCode) {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            e?.flags = []
            e?.post(tap: .cghidEventTap)
        }
    }

    func type(_ text: String) {
        let units = Array(text.utf16)
        for start in Swift.stride(from: 0, to: units.count, by: 16) {
            let chunk = Array(units[start..<min(units.count, start + 16)])
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.flags = []
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                e?.post(tap: .cghidEventTap)
            }
        }
    }

    /// What typing this word puts in: capitalized at a sentence start; "." and "?" go right after the word.
    func text(for word: String) -> (String, Bool) {
        if word == "." || word == "?" { return (word + " ", true) }
        let w = sentenceStart ? word.prefix(1).uppercased() + word.dropFirst() : word
        return (w + " ", false)
    }

    func put(_ word: String, live: Bool) {
        let (t, ends) = text(for: word)
        if ends, let last = typed.last, last.hasSuffix(" ") {
            if live { key(51) }                                            // no space before the mark
            typed[typed.count - 1] = String(last.dropLast())
        }
        if live { type(t) }
        typed.append(t)
        sentenceStart = ends
    }

    func deleteLast(live: Bool) {
        guard let last = typed.popLast() else { return }
        if live { for _ in 0..<last.count { key(51) } }
        sentenceStart = typed.isEmpty || [". ", "? ", ".", "?"].contains(typed.last!)
    }

    func replaceLast(with word: String, live: Bool) {
        deleteLast(live: live)
        put(word, live: live)
    }

    var sentence: String { typed.joined() }
}

// MARK: - The keyboard on screen

/// The buttons above the keyboard, in key units: the three other guesses, delete the last word, redo the
/// dots. Look at one and blink slowly.
enum Buttons {
    static let count = 5
    static let top = -0.95, bottom = -0.15
    static func rect(_ i: Int) -> (x0: Double, y0: Double, x1: Double, y1: Double) { (Double(2 * i), top, Double(2 * i + 2), bottom) }
    static func at(_ x: Double, _ y: Double) -> Int? {
        guard y >= top - 0.3, y < bottom + 0.05, x >= -0.3, x < 10.3 else { return nil }
        return max(0, min(count - 1, Int(x / 2)))
    }
    static func onKeyboard(_ x: Double, _ y: Double) -> Bool { x >= -0.6 && x <= 10.6 && y >= bottom + 0.05 && y <= 3.4 }
}

/// Where it thinks you look. Its own little view, so moving it redraws nothing.
final class Dot: NSView {
    override func draw(_ r: NSRect) {
        let d = bounds.insetBy(dx: 4, dy: 4)
        NSColor(srgbRed: 1, green: 0.85, blue: 0.35, alpha: 0.9).setFill()
        NSBezierPath(ovalIn: d.insetBy(dx: 8, dy: 8)).fill()
        NSColor(white: 1, alpha: 0.9).setStroke()
        let ring = NSBezierPath(ovalIn: d)
        ring.lineWidth = 3
        ring.stroke()
    }
}

/// The key or button looked at, lit up.
final class Highlight: NSView {
    override func draw(_ r: NSRect) {
        NSColor(srgbRed: 0.3, green: 0.5, blue: 0.95, alpha: 0.5).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 18, yRadius: 18).fill()
    }
}

final class KeyboardView: NSView {
    override var isFlipped: Bool { true }
    let dot = Dot(frame: NSRect(x: 0, y: 0, width: 36, height: 36)), highlight = Highlight(frame: .zero)
    override init(frame: NSRect) {
        super.init(frame: frame)
        for v in [highlight, dot] { v.isHidden = true; addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError() }
    var gaze: (Double, Double)? = nil
    var trail: [(Double, Double)] = []
    var target: (Double, Double)? = nil
    var status = "", line = "", alternatives: [String] = []
    var hot: Int? = nil                     // the key under the pointer (or 100 + button)
    var flash: Int? = nil                   // a button just chosen

    var keyboardRect: NSRect {
        let b = bounds.insetBy(dx: bounds.width * 0.02, dy: 0)
        let top = bounds.height * 0.34
        return NSRect(x: b.minX, y: top, width: b.width, height: bounds.height - top - bounds.height * 0.03)
    }

    func point(_ k: (Double, Double)) -> NSPoint {
        let r = keyboardRect
        return NSPoint(x: r.minX + k.0 / EyeLayout.width * r.width, y: r.minY + k.1 / EyeLayout.height * r.height)
    }

    func box(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, inset: CGFloat) -> NSRect {
        let a = point((x0, y0)), b = point((x1, y1))
        return NSRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y).insetBy(dx: inset, dy: inset)
    }

    func keyRect(_ i: Int) -> NSRect {
        let c = EyeLayout.centers[i]
        return box(c.x - 0.5, c.y - 0.5, c.x + 0.5, c.y + 0.5, inset: 5)
    }

    func buttonRect(_ i: Int) -> NSRect { let r = Buttons.rect(i); return box(r.x0, r.y0, r.x1, r.y1, inset: 8) }

    func dotRect(_ g: (Double, Double)) -> NSRect { let c = point(g); return NSRect(x: c.x - 18, y: c.y - 18, width: 36, height: 36) }

    func hotRect(_ h: Int?) -> NSRect? {
        guard let h, target == nil else { return nil }
        if h < 100 { return keyRect(h) }
        return h - 100 < 3 && h - 100 >= alternatives.count ? nil : buttonRect(h - 100)
    }

    /// Move the pointer and the highlight: nothing is drawn again, the two little views just move.
    func move(to g: (Double, Double)?, hot newHot: Int?) {
        gaze = g
        hot = newHot
        if let g, target == nil {
            let c = point(g)
            dot.setFrameOrigin(NSPoint(x: c.x - 18, y: c.y - 18))
            dot.isHidden = false
        } else {
            dot.isHidden = true
        }
        if let r = hotRect(newHot) {
            if highlight.frame != r { highlight.frame = r }
            highlight.isHidden = false
        } else {
            highlight.isHidden = true
        }
    }

    func label(_ text: String, _ font: NSFont, _ color: NSColor, centeredIn r: NSRect) {
        let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let size = s.size()
        s.draw(at: NSPoint(x: r.midX - size.width / 2, y: r.midY - size.height / 2))
    }

    override func draw(_ dirty: NSRect) {
        NSColor(white: 0.04, alpha: 0.82).setFill()
        dirty.fill()
        let r = keyboardRect
        let kw = r.width / EyeLayout.width, kh = r.height / EyeLayout.height
        let keyFont = NSFont.systemFont(ofSize: min(kw, kh) * 0.42, weight: .semibold)
        for (i, ch) in EyeLayout.keys.enumerated() {
            let k = keyRect(i)
            guard k.intersects(dirty) else { continue }
            NSColor(white: 1, alpha: 0.08).setFill()
            NSBezierPath(roundedRect: k, xRadius: 18, yRadius: 18).fill()
            label(String(ch).uppercased(), keyFont, NSColor(white: 1, alpha: 0.92), centeredIn: k)
        }
        if target == nil {                                                    // the buttons above the keys
            let font = NSFont.systemFont(ofSize: min(32, kh * 0.2), weight: .medium)
            for i in 0..<Buttons.count {
                let b = buttonRect(i)
                guard b.intersects(dirty) else { continue }
                let title = i < 3 ? (i < alternatives.count ? alternatives[i] : "") : (i == 3 ? "⌫  delete word" : "◎  redo dots")
                (flash == i ? NSColor(srgbRed: 0.25, green: 0.45, blue: 0.85, alpha: 1)
                            : NSColor(white: 1, alpha: title.isEmpty ? 0.03 : 0.1)).setFill()
                NSBezierPath(roundedRect: b, xRadius: 16, yRadius: 16).fill()
                label(title, font, i < 3 ? NSColor(srgbRed: 0.7, green: 0.85, blue: 1, alpha: 1) : NSColor(white: 1, alpha: 0.75), centeredIn: b)
            }
        }
        if trail.count > 1 {
            let path = NSBezierPath()
            path.move(to: point(trail[0]))
            for p in trail.dropFirst() { path.line(to: point(p)) }
            NSColor(srgbRed: 0.45, green: 0.75, blue: 1, alpha: 0.6).setStroke()
            path.lineWidth = 4
            path.stroke()
        }
        if let t = target {                                                   // a calibration dot
            let c = point(t)
            NSColor(srgbRed: 1, green: 0.8, blue: 0.3, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: c.x - 24, y: c.y - 24, width: 48, height: 48)).fill()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: c.x - 5, y: c.y - 5, width: 10, height: 10)).fill()
        }
        // The top: what's typed, and one line on what to do.
        let textRect = NSRect(x: r.minX + 8, y: bounds.height * 0.015, width: r.width - 16, height: bounds.height * 0.06)
        if textRect.intersects(dirty) {
            NSAttributedString(string: line.isEmpty ? " " : line, attributes: [.font: NSFont.systemFont(ofSize: 34, weight: .medium), .foregroundColor: NSColor.white])
                .draw(in: textRect)
        }
        let statusRect = NSRect(x: r.minX + 8, y: bounds.height * 0.075, width: r.width - 16, height: bounds.height * 0.05)
        if statusRect.intersects(dirty) {
            NSAttributedString(string: status, attributes: [.font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor(white: 1, alpha: 0.7)])
                .draw(in: statusRect)
        }
    }
}

// MARK: - The keyboard's behaviour

final class EyeKeyboard {
    let decoder: EyeSwipeDecoder
    let camera = GazeCamera()
    let typer = Typer()
    let test: Bool
    var panel: NSPanel!
    var view: KeyboardView!
    var on = false
    // The dots: the keyboard's (same as the phone's) and three on the buttons above it.
    static let targets = GazeCalibration.targets + [(1.0, -0.55), (5.0, -0.55), (9.0, -0.55)]
    var calibration: GazeCalibration?
    var calibrating: (index: Int, began: Double, frames: [[GazeFeatures]])? = nil
    var dotFrames: [[GazeFeatures]] = []
    var learned: [([Double], (Double, Double))] = []         // frames from typed words, and the key looked at
    var pending: (word: String, samples: [GazeSample], features: [[Double]], rest: Int)? = nil   // the last word typed
    var fx = OneEuro(), fy = OneEuro()
    var settle: (x: Double, y: Double)? = nil, restCount = 0      // after a blink types: where the eyes rest
    var recent: [(Double, Double)] = []
    var word: [GazeSample] = [], wordFeatures: [[Double]] = []
    var history: [(t: Double, x: Double, y: Double)] = []   // the last second: what a blink was aimed at
    var closedSince: Double? = nil, blinkDone = false
    var offSince: Double? = nil, paused = false
    var lastTap = 0.0, downAt = 0.0
    var lastCandidates: [EyeSwipeDecoder.Candidate] = []
    var lastSpeedReport = 0.0
    // --test: sentences to type, and how it went
    let testSentences = ["can you send me the notes from today", "i will be home in about an hour",
                         "let me know when you are ready to go", "the meeting got moved to friday morning",
                         "please turn off the lights in the kitchen", "what time does the store close tonight",
                         "thanks for helping me with the project", "do you want to grab lunch after class"]
    var testAt = (sentence: 0, word: 0), testWrong = 0, testWords = 0, testTop3 = 0

    init(decoder: EyeSwipeDecoder, test: Bool) {
        self.decoder = decoder
        self.test = test
    }

    func setUpWindow() {
        let screen = NSScreen.main!.frame
        panel = NSPanel(contentRect: screen, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        view = KeyboardView(frame: NSRect(origin: .zero, size: screen.size))
        panel.contentView = view
        camera.onLook = { [weak self] look in DispatchQueue.main.async { self?.look(look) } }
    }

    static let howTo = "Look at each letter of a word, then blink slowly to type it.     Esc closes."

    func hint() -> String {
        if test, testAt.sentence < testSentences.count {
            let words = testSentences[testAt.sentence].split(separator: " ")
            return "Type:  " + words.enumerated().map { $0 == testAt.word ? "[\($1)]" : String($1) }.joined(separator: " ")
                + "      (look at each letter, then blink slowly)"
        }
        return Self.howTo
    }

    func say(_ text: String) {
        view.status = text
        view.setNeedsDisplay(NSRect(x: 0, y: 0, width: view.bounds.width, height: view.bounds.height * 0.13))
    }

    func redraw() { view.needsDisplay = true }

    func toggle() {
        on.toggle()
        emit(["on": on])
        if on {
            guard camera.start() else { say("No camera"); return }
            panel.setFrame(NSScreen.main!.frame, display: false)
            view.frame = NSRect(origin: .zero, size: panel.frame.size)
            panel.orderFrontRegardless()
            resetWord()
            if calibration == nil { startCalibration() } else { say(hint()) }
        } else {
            learnFromLastWord()
            camera.stop()
            panel.orderOut(nil)
            calibrating = nil
            view.target = nil
        }
        redraw()
    }

    func startCalibration() {
        calibrating = (0, ProcessInfo.processInfo.systemUptime, Array(repeating: [], count: Self.targets.count))
        view.target = Self.targets[0]
        view.trail = []
        view.move(to: nil, hot: nil)
        say("Look at each yellow dot until it jumps (about 20 seconds).")
        redraw()
    }

    func resetWord() {
        word = []
        wordFeatures = []
        settle = nil
        restCount = 0
        if !view.trail.isEmpty { view.trail = []; redraw() }
    }

    func look(_ l: Look) {
        guard on else { return }
        switch l {
        case .gaze(let f): gaze(f)
        case .closed(let t): closed(t)
        case .away(let t): away(t)
        }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastSpeedReport > 5 {
            lastSpeedReport = now
            emit(["speed": ["fps": Int(camera.fps.rounded()), "ms_per_frame": Int(camera.msPerFrame.rounded())]])
        }
    }

    func gaze(_ f: GazeFeatures) {
        let now = ProcessInfo.processInfo.systemUptime
        closedSince = nil
        blinkDone = false
        if var c = calibrating {
            let since = now - c.began
            if since > 0.45 { c.frames[c.index].append(f) }                 // settle first, then collect
            if since > 1.25 {
                c.index += 1
                c.began = now
                if c.index == Self.targets.count {
                    calibrating = nil
                    view.target = nil
                    finishCalibration(c.frames)
                    return
                }
                view.target = Self.targets[c.index]
                redraw()
            }
            calibrating = c
            return
        }
        guard let cal = calibration else { return }
        if paused { paused = false; say(hint()) }
        let (x, y) = cal.map(f.values)
        // The pointer: right away, smoothed only while the eyes rest.
        let px = fx(x, f.time), py = fy(y, f.time)
        let hot: Int? = Buttons.at(px, py).map { 100 + $0 }
            ?? (Buttons.onKeyboard(px, py) ? EyeLayout.centers.indices.min { a, b in
                hypot(EyeLayout.centers[a].x - px, EyeLayout.centers[a].y - py) < hypot(EyeLayout.centers[b].x - px, EyeLayout.centers[b].y - py) } : nil)
        view.move(to: (px, py), hot: hot)
        // The word: the median of the last three, a little steadier for the decoder.
        recent.append((x, y))
        if recent.count > 3 { recent.removeFirst() }
        let mx = recent.map { $0.0 }.sorted()[recent.count / 2], my = recent.map { $0.1 }.sorted()[recent.count / 2]
        history.append((f.time, mx, my))
        while let first = history.first, f.time - first.t > 1.2 { history.removeFirst() }
        if Buttons.onKeyboard(mx, my) {
            offSince = nil
            if let s = settle {                       // still resting where the last word ended?
                if hypot(mx - s.x, my - s.y) < 1.2 && restCount == word.count { restCount += 1 } else { settle = nil }
            }
            word.append(GazeSample(x: mx, y: my, t: f.time))
            wordFeatures.append(f.values)
            view.trail.append((mx, my))
            if view.trail.count > 1 {
                let a = view.point(view.trail[view.trail.count - 2]), b = view.point((mx, my))
                view.setNeedsDisplay(NSRect(x: min(a.x, b.x) - 4, y: min(a.y, b.y) - 4, width: abs(a.x - b.x) + 8, height: abs(a.y - b.y) + 8))
            }
        } else {
            offSince = offSince ?? f.time
            if f.time - offSince! > lookAwayResets, !word.isEmpty { resetWord() }
        }
    }

    func closed(_ t: Double) {
        guard calibrating == nil, calibration != nil else { return }
        if closedSince == nil { closedSince = t; blinkDone = false; return }
        if !blinkDone && t - closedSince! >= slowBlink {
            blinkDone = true
            blinked(startedAt: closedSince!)
        }
    }

    func away(_ t: Double) {
        closedSince = nil
        offSince = offSince ?? t
        if t - offSince! > lookAwayResets {
            if !word.isEmpty { resetWord() }
            if !paused && calibrating == nil { paused = true; say("Paused while you look away.") }
        }
    }

    /// A slow blink: on a button, press it; anywhere else, type the word looked across.
    func blinked(startedAt start: Double) {
        let aimed = history.filter { $0.t >= start - 0.5 && $0.t <= start - 0.1 }
        let samples = word.enumerated().filter { $0.element.t < start - 0.1 }        // not the lids coming down
        let got = samples.map { $0.element }, features = samples.map { wordFeatures[$0.offset] }
        let rest = min(restCount, got.count)
        resetWord()
        var at: (x: Double, y: Double)? = nil
        if !aimed.isEmpty {
            let ax = aimed.map { $0.x }.sorted()[aimed.count / 2], ay = aimed.map { $0.y }.sorted()[aimed.count / 2]
            if let b = Buttons.at(ax, ay) { press(b); return }
            at = (ax, ay)
        }
        guard got.count - rest >= 3 else { return }
        finishWord(got, features, rest: rest)
        settle = at                 // the eyes open where they closed: that isn't the next word's first letter yet
    }

    func press(_ b: Int) {
        switch b {
        case 0, 1, 2:
            let n = b + 1
            guard n < lastCandidates.count, !test else { return }
            typer.replaceLast(with: lastCandidates[n].shown, live: true)
            pending?.word = lastCandidates[n].word
            view.alternatives = lastCandidates.enumerated().filter { $0.offset != n }.map { $0.element.shown }
            lastCandidates.swapAt(0, n)
            view.line = typer.sentence
        case 3:
            guard !test else { return }
            typer.deleteLast(live: true)
            pending = nil
            view.alternatives = []
            lastCandidates = []
            view.line = typer.sentence
        default:
            startCalibration()
            return
        }
        NSSound(named: "Tink")?.play()
        view.flash = b
        redraw()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.view.flash = nil; self?.redraw() }
    }

    func finishCalibration(_ frames: [[GazeFeatures]]) {
        guard let cal = GazeCalibration.fit(frames, targets: Self.targets) else {
            say("Couldn't see your eyes well enough. Face the camera in good light; trying again…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.on == true { self?.startCalibration() } }
            return
        }
        dotFrames = frames
        learned = []
        use(cal)
        emit(["calibrated": ["x": cal.spread.x, "y": cal.spread.y]])
        say(hint())
        redraw()
    }

    func use(_ cal: GazeCalibration) {
        calibration = cal
        decoder.settings.sigma = max(0.35, 1.1 * cal.spread.x)
        decoder.settings.sigmaY = max(0.3, 1.1 * cal.spread.y)
    }

    /// The last word stood (another came after it, or it was swapped for the right one): where its letters
    /// are is where the eyes were, so those frames tune the calibration.
    func learnFromLastWord() {
        guard let p = pending, let keys = decoder.align(p.word, p.samples, rest: p.rest) else { pending = nil; return }
        pending = nil
        for i in 1..<max(1, keys.count - 1) where keys[i] >= 0 && keys[i - 1] == keys[i] && keys[i] == keys[i + 1] {
            let c = EyeLayout.centers[keys[i]]
            if hypot(p.samples[i].x - c.x, p.samples[i].y - c.y) < 1.8 { learned.append((p.features[i], (c.x, c.y))) }
        }
        if learned.count > 600 { learned.removeFirst(learned.count - 600) }
        if let cal = GazeCalibration.fit(dotFrames, targets: Self.targets, extra: learned) { use(cal) }
    }

    func finishWord(_ got: [GazeSample], _ features: [[Double]], rest: Int) {
        learnFromLastWord()
        let previous: String? = typer.sentenceStart ? nil
            : typer.typed.last.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        let found = decoder.decode(got, previous: previous, count: 4, rest: rest)
        guard let best = found.first else { return }
        lastCandidates = found
        view.alternatives = found.dropFirst().map { $0.shown }
        NSSound(named: "Pop")?.play()
        if test { testWord(found); redraw(); return }
        typer.put(best.shown, live: true)
        pending = (best.word, got, features, rest)
        view.line = typer.sentence
        redraw()
        emit(["typed": best.shown, "alternatives": found.dropFirst().map { $0.shown }])
    }

    // Right ⌘ (double-tap opens and closes) and Esc (closes), from the event tap. Returns false to swallow it.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let now = ProcessInfo.processInfo.systemUptime
        if type == .keyDown && code == escapeKey && on {
            toggle()
            return false
        }
        if type == .flagsChanged && code == rightCommandKey {
            if event.flags.rawValue & rightCommandDown != 0 {
                downAt = now
            } else if now - downAt < tapSeconds {
                if now - lastTap < doubleTapSeconds { lastTap = 0; toggle() } else { lastTap = now }
            }
        }
        return true
    }

    func testWord(_ found: [EyeSwipeDecoder.Candidate]) {
        guard testAt.sentence < testSentences.count else { return }
        let words = testSentences[testAt.sentence].split(separator: " ").map(String.init)
        let want = words[testAt.word]
        testWords += 1
        if found.first?.word != want { testWrong += 1 }
        if !found.prefix(3).contains(where: { $0.word == want }) { testTop3 += 1 }
        typer.put(found.first!.shown, live: false)
        view.line = typer.sentence
        testAt.word += 1
        if testAt.word == words.count {
            testAt = (testAt.sentence + 1, 0)
            typer.typed = []
            typer.sentenceStart = true
        }
        let rate = 100 * Double(testWrong) / Double(testWords)
        if testAt.sentence == testSentences.count {
            emit(["test": ["words": testWords, "wrong": testWrong, "not_in_top3": testTop3, "percent_wrong": rate]])
            say(String(format: "Done: %.0f%% of %d words wrong (%d not even in the top 3).", rate, testWords, testTop3))
        } else {
            say(String(format: "%.0f%% wrong so far (%d of %d).  ", rate, testWrong, testWords) + hint())
        }
    }
}

// MARK: - Start

@main
struct Main {
    static func main() {
        let here = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        let lmPath = option("--lm") ?? [here.appendingPathComponent("eyeswipe-lm.bin").path,
                                        here.appendingPathComponent("../tools/eyeswipe/eyeswipe-lm.bin").path]
            .first { FileManager.default.fileExists(atPath: $0) } ?? "eyeswipe-lm.bin"
        guard let lm = try? EyeLM(contentsOf: URL(fileURLWithPath: lmPath)) else {
            FileHandle.standardError.write(Data("hive-eye-keyboard: can't read the language model at \(lmPath)\n".utf8))
            exit(1)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let keyboard = EyeKeyboard(decoder: EyeSwipeDecoder(lm: lm), test: CommandLine.arguments.contains("--test"))

        if let out = option("--snapshot") {                                   // draw it into a PNG and stop
            let view = KeyboardView(frame: NSRect(x: 0, y: 0, width: 1470, height: 956))
            view.line = "Can you send me the "
            view.alternatives = ["then", "they", "thee"]
            view.status = keyboard.hint()
            if CommandLine.arguments.contains("--calibrating") { view.target = EyeKeyboard.targets[16] }
            if CommandLine.arguments.contains("--trail") {
                view.trail = [(4.6, 0.5), (4.9, 0.6), (5.4, 1.4), (5.6, 1.5), (3.0, 0.6), (2.6, 0.5)]
                view.move(to: (2.6, 0.5), hot: 1)
            }
            let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
            exit(0)
        }

        keyboard.setUpWindow()
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let box = Unmanaged.passUnretained(keyboard).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: CGEventMask(mask), callback: { _, type, event, refcon in
            let keyboard = Unmanaged<EyeKeyboard>.fromOpaque(refcon!).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let t = eventTap { CGEvent.tapEnable(tap: t, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            return keyboard.handle(type, event) ? Unmanaged.passUnretained(event) : nil
        }, userInfo: box) else {
            CGRequestPostEventAccess()
            FileHandle.standardError.write(Data(("hive-eye-keyboard: it isn't allowed to watch the keyboard; allow it under "
                                                 + "System Settings › Privacy & Security › Accessibility\n").utf8))
            exit(2)
        }
        eventTap = tap
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        AVCaptureDevice.requestAccess(for: .video) { ok in
            if !ok { FileHandle.standardError.write(Data("hive-eye-keyboard: the camera isn't allowed\n".utf8)) }
        }
        FileHandle.standardError.write(Data("hive-eye-keyboard: double-tap right ⌘ to start (Esc closes it)\n".utf8))
        app.run()
    }
}
