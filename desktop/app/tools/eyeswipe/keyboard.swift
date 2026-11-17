// Hive's eye keyboard on the Mac: type by looking. Double-tap right ⌘ and a see-through keyboard covers the
// lower part of the screen. The first time, a yellow dot moves across it: follow it with your eyes for about
// 15 seconds, then look at five dots, and it says how accurate it got. Then just look at the letters of
// what you want to write, with no need to wait on a letter, and blink normally after each word: the blink
// types it into the app in front, and looking up off the keyboard types the last one. A pill shows the word
// it would type right now. Backspace on your own keyboard fixes mistakes.
// Esc closes it. Every word typed tunes it to your eyes a little more.
//
// Gaze comes from the Mac's camera through Apple Vision's face landmarks: where the pupils sit in the eyes,
// how open the lids are, and which way the head points (the nose against the eyes), mapped to the keyboard
// by the setup, which limits how much head position counts (the head moves with the moving dot, and a free
// fit was keys off once the head moved). The pointer holds still while the eyes rest (FixationHold). Nothing
// is saved or sent unless --dump says so: the camera runs only while the keyboard is up, and each frame is
// dropped once read. Each word (the gaze between two blinks) is decoded by EyeSwipe.swift's EyeSwipeDecoder
// off the main thread, the live guess by its EyeStream, with the language model in eyeswipe-lm.bin (next to
// this binary, or --lm).
//
// Writes one JSON object per line on stdout: {"on": true|false}, {"setup": {"x": spread, "y": spread}},
// {"check": {"keys_off": median, "dots": [...]}} (key widths), {"typed": "word", "ms": decode time}, {"phrase": {...}},
// {"speed": {...}}, {"test": {...}} after a test.
//
//   hive-eye-keyboard [--lm path] [--test] [--dump file [--dump-eyes]] [--blink-frames n]
//       --test: shows sentences to type and counts the wrong words, typing nothing into other apps
//       --dump: appends each frame's gaze numbers (not pictures) and the setup dot to a file, to tune it
//       --dump-eyes: also the eyes' part of each frame, grey (file.eyes.bin, described by file.eyes.jsonl)
//       --blink-frames: closed-eye camera frames that make a blink (default: about 50 ms' worth, at least 2)
//   hive-eye-keyboard --snapshot out.png [--setup] [--trail]   draws the keyboard into a PNG (tests)
//   hive-eye-keyboard --test --replay file      types made-up gaze from eyeswipe-sim --write-replay (tests)
//   hive-eye-keyboard --calib-test dump         the setup's fit on each setup in a --dump, checked on its dots
//
// Needs Accessibility (to see right ⌘ and Esc, and to type) and the camera, for the app it runs from.

import AppKit
import AVFoundation
import Vision

let rightCommandKey: Int64 = 54                  // kVK_RightCommand
let escapeKey: Int64 = 53                        // kVK_Escape
let rightCommandDown: UInt64 = 0x10              // NX_DEVICERCMDKEYMASK
let tapSeconds = 0.25, doubleTapSeconds = 0.45
let lookUpFinishes = 0.3                         // off the keyboard this long types the last word
let ourEvents: Int64 = 0x4876_6B62               // marks the keys we type, to tell them from yours

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

    // --dump-eyes: the eyes' part of each frame (grey, as the camera saw it) for tuning the pupil finder offline
    var eyeDump: (rows: FileHandle, pixels: FileHandle, at: UInt64)? = nil
    var fps = 0.0, msPerFrame = 0.0
    var eyeLight = 0.0, faceSize = 0.0              // for the setup's hints: how bright the eyes, how near
    var lastFrame = 0.0

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let began = ProcessInfo.processInfo.systemUptime
        let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let request = VNDetectFaceLandmarksRequest()
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up).perform([request])
        let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width })
        let now = ProcessInfo.processInfo.systemUptime
        msPerFrame += 0.1 * ((now - began) * 1000 - msPerFrame)
        if lastFrame > 0 { fps += 0.1 * (1 / max(1e-3, time - lastFrame) - fps) }
        lastFrame = time
        guard let face, let marks = face.landmarks else { onLook?(.away(time)); return }
        if eyeDump != nil { dumpEyes(marks, pixels, time) }
        if let f = features(marks, pixels) {
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
        var opening = 0.0, light = 0.0
        for (outline, pupilMark) in [(le, marks.leftPupil), (re, marks.rightPupil)] {
            let a = outline.min { $0.x < $1.x }!, b = outline.max { $0.x < $1.x }!
            let cx = Double(a.x + b.x) / 2, cy = Double(a.y + b.y) / 2
            let width = Double(hypot(b.x - a.x, b.y - a.y))
            let top = outline.map { Double($0.y) }.max()!, bottom = outline.map { Double($0.y) }.min()!
            guard width > 8 else { return nil }
            opening += (top - bottom) / width / 2
            var pupil = pupilMark?.pointsInImage(imageSize: size).first.map { (Double($0.x), Double($0.y)) } ?? (cx, cy)
            if let dark = darkest(outline, luma, stride, w, h) {
                pupil = ((pupil.0 + 2 * dark.0) / 3, (pupil.1 + 2 * dark.1) / 3)
                light += dark.2 / 2
            }
            eyes.append(((pupil.0 - cx) / width, (pupil.1 - cy) / width, (top - cy) / width, cx, cy))
        }
        let usual = typicalOpen ?? opening
        if opening < 0.45 * usual || opening < 0.06 { return [] }            // closed
        typicalOpen = usual + 0.02 * (opening - usual)                          // follows slowly
        let mx = (eyes[0].cx + eyes[1].cx) / 2, my = (eyes[0].cy + eyes[1].cy) / 2
        let iod = hypot(eyes[0].cx - eyes[1].cx, eyes[0].cy - eyes[1].cy)
        guard iod > 10 else { return nil }
        eyeLight = light
        faceSize = iod / Double(w)
        let ex = (eyes[0].ex + eyes[1].ex) / 2, ey = (eyes[0].ey + eyes[1].ey) / 2, lid = (eyes[0].lid + eyes[1].lid) / 2
        let nx = (Double(nose.x) - mx) / iod, ny = (Double(nose.y) - my) / iod
        return [ex, ey, lid, nx, ny, mx / Double(w), my / Double(h), iod / Double(w), ex * ex, ey * ey, nx * ny]
    }

    /// Writes both eyes' boxes (a little bigger than the outline) to the --dump-eyes files: the pixels, top row
    /// first, and a line with the camera time, where the box is, the outline and Vision's pupil (y up).
    func dumpEyes(_ marks: VNFaceLandmarks2D, _ pixels: CVPixelBuffer, _ time: Double) {
        guard var d = eyeDump else { return }
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels), size = CGSize(width: w, height: h)
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else { return }
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0), luma = base.assumingMemoryBound(to: UInt8.self)
        var eyes: [[String: Any]] = [], bytes = Data()
        for (outline, pupil) in [(marks.leftEye, marks.leftPupil), (marks.rightEye, marks.rightPupil)] {
            guard let pts = outline?.pointsInImage(imageSize: size), pts.count >= 6 else { return }
            let xs = pts.map { Double($0.x) }, ys = pts.map { Double($0.y) }, ew = xs.max()! - xs.min()!
            let x0 = max(0, Int(xs.min()! - 0.3 * ew)), x1 = min(w - 1, Int(xs.max()! + 0.3 * ew))
            let y0 = max(0, Int(ys.min()! - 0.35 * ew)), y1 = min(h - 1, Int(ys.max()! + 0.35 * ew))
            guard x1 > x0 + 4, y1 > y0 + 2 else { return }
            let at = d.at + UInt64(bytes.count)
            for y in stride(from: y1, through: y0, by: -1) { bytes.append(luma + (h - 1 - y) * rowBytes + x0, count: x1 - x0 + 1) }
            var eye: [String: Any] = ["box": [x0, y0, x1, y1], "at": at,
                                      "outline": pts.flatMap { [(Double($0.x) * 10).rounded() / 10, (Double($0.y) * 10).rounded() / 10] }]
            if let p = pupil?.pointsInImage(imageSize: size).first { eye["pupil"] = [(Double(p.x) * 10).rounded() / 10, (Double(p.y) * 10).rounded() / 10] }
            eyes.append(eye)
        }
        guard let line = try? JSONSerialization.data(withJSONObject: ["ft": time, "w": w, "h": h, "eyes": eyes]) else { return }
        d.pixels.write(bytes)
        d.rows.write(line + Data("\n".utf8))
        d.at += UInt64(bytes.count)
        eyeDump = d
    }

    /// The middle of the darkest pixels inside the eye outline (the pupil and iris), in image points.
    func darkest(_ outline: [CGPoint], _ luma: UnsafePointer<UInt8>, _ stride: Int, _ w: Int, _ h: Int) -> (Double, Double, Double)? {
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
        let mean = inside.reduce(0.0) { $0 + Double($1.2) } / Double(inside.count)     // how well lit the eye is
        return sw > 0 ? (sx / sw, sy / sw, mean) : nil
    }
}

// MARK: - Typing into the app in front

final class Typer {
    var typed: [String] = []          // what each word put in since the last key you pressed ("Hello ", ". ")
    var sentenceStart = true
    var unknown = false               // you typed or deleted something yourself: the word before isn't known
    let source = CGEventSource(stateID: .hidSystemState)

    func post(_ e: CGEvent?) {
        e?.flags = []
        e?.setIntegerValueField(.eventSourceUserData, value: ourEvents)
        e?.post(tap: .cghidEventTap)
    }

    func key(_ code: CGKeyCode) {
        for down in [true, false] { post(CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)) }
    }

    func type(_ text: String) {
        let units = Array(text.utf16)
        for start in Swift.stride(from: 0, to: units.count, by: 16) {
            let chunk = Array(units[start..<min(units.count, start + 16)])
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                post(e)
            }
        }
    }

    /// The word before the next one, for the language model: nil when a sentence starts, "" if unknown.
    var previous: String? {
        if unknown { return "" }
        if sentenceStart { return nil }
        return typed.last.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    }

    func put(_ word: String, live: Bool) {
        let ends = word == "." || word == "?"
        let w = ends ? word : (sentenceStart && !unknown ? word.prefix(1).uppercased() + word.dropFirst() : word)
        if ends, let last = typed.last, last.hasSuffix(" ") {
            if live { key(51) }                                            // no space before the mark
            typed[typed.count - 1] = String(last.dropLast())
        }
        if live { type(w + " ") }
        typed.append(w + " ")
        if typed.count > 50 { typed.removeFirst() }
        sentenceStart = ends
        unknown = false
    }

    /// You pressed a key yourself (fixing a word, say): what came before isn't known any more.
    func youTyped() {
        typed = []
        unknown = true
        sentenceStart = false
    }

    var sentence: String { typed.joined() }
}

// MARK: - The keyboard on screen

/// Where on the keyboard counts as typing: the keys, the space bar and a margin (key units). The margin is
/// a whole key: gaze a little off on the top row mustn't count as looking up (that would end the word).
func onKeyboard(_ x: Double, _ y: Double) -> Bool { x >= -1.0 && x <= 11.0 && y >= -1.0 && y <= 4.6 }

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

/// The setup's dot to follow or look at.
final class Target: NSView {
    override func draw(_ r: NSRect) {
        NSColor(srgbRed: 1, green: 0.8, blue: 0.3, alpha: 1).setFill()
        NSBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2)).fill()
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: bounds.midX - 5, y: bounds.midY - 5, width: 10, height: 10)).fill()
    }
}

/// The key or space bar looked at, lit up.
final class Highlight: NSView {
    override func draw(_ r: NSRect) {
        NSColor(srgbRed: 0.3, green: 0.5, blue: 0.95, alpha: 0.45).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 18, yRadius: 18).fill()
    }
}

/// A line of text on a dark rounded background (what it's about to type; what to do).
final class Pill: NSView {
    var font = NSFont.systemFont(ofSize: 20, weight: .medium), color = NSColor(white: 1, alpha: 0.85)
    var text = "" {
        didSet { if text != oldValue { isHidden = text.isEmpty; needsDisplay = true } }
    }
    override func draw(_ r: NSRect) {
        let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let size = s.size()
        let w = min(bounds.width, size.width + 36), h = size.height + 16
        let box = NSRect(x: bounds.midX - w / 2, y: bounds.midY - h / 2, width: w, height: h)
        NSColor(white: 0.04, alpha: 0.75).setFill()
        NSBezierPath(roundedRect: box, xRadius: h / 2, yRadius: h / 2).fill()
        s.draw(in: box.insetBy(dx: 18, dy: 8))
    }
}

final class KeyboardView: NSView {
    override var isFlipped: Bool { true }
    static let rows = 4.0                         // three rows of keys and the space bar, in key heights
    let dot = Dot(frame: NSRect(x: 0, y: 0, width: 36, height: 36)), highlight = Highlight(frame: .zero)
    let target = Target(frame: NSRect(x: 0, y: 0, width: 52, height: 52))
    let status = Pill(frame: .zero), words = Pill(frame: .zero)
    override init(frame: NSRect) {
        super.init(frame: frame)
        words.font = NSFont.systemFont(ofSize: 34, weight: .semibold)
        words.color = NSColor(srgbRed: 0.75, green: 0.88, blue: 1, alpha: 1)
        for v in [highlight, dot, target, status, words] as [NSView] { v.isHidden = true; addSubview(v) }
        layoutPills()
    }
    required init?(coder: NSCoder) { fatalError() }
    override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); layoutPills() }

    func layoutPills() {
        status.frame = NSRect(x: bounds.width * 0.1, y: bounds.height * 0.02, width: bounds.width * 0.8, height: 52)
        words.frame = NSRect(x: bounds.width * 0.05, y: keyboardRect.minY - 84, width: bounds.width * 0.9, height: 72)
    }

    var keyboardRect: NSRect {
        let top = bounds.height * 0.3
        return NSRect(x: bounds.width * 0.02, y: top, width: bounds.width * 0.96, height: bounds.height - top - bounds.height * 0.02)
    }

    func point(_ k: (Double, Double)) -> NSPoint {
        let r = keyboardRect
        return NSPoint(x: r.minX + k.0 / EyeLayout.width * r.width, y: r.minY + k.1 / Self.rows * r.height)
    }

    func box(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, inset: CGFloat) -> NSRect {
        let a = point((x0, y0)), b = point((x1, y1))
        return NSRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y).insetBy(dx: inset, dy: inset)
    }

    func keyRect(_ i: Int) -> NSRect {
        let c = EyeLayout.centers[i]
        return box(c.x - 0.5, c.y - 0.5, c.x + 0.5, c.y + 0.5, inset: 5)
    }

    var spaceRect: NSRect { box(EyeLayout.space.x0 - 0.5, EyeLayout.space.y - 0.4, EyeLayout.space.x1 + 0.5, EyeLayout.space.y + 0.4, inset: 5) }

    /// The key (or 100: the space bar) nearest a point, if it's on the keyboard.
    static func hot(_ x: Double, _ y: Double) -> Int? {
        guard onKeyboard(x, y) else { return nil }
        let (sx, sy) = EyeLayout.spaceOffset(x, y)
        if y > 3.1 && hypot(sx, sy) < 0.9 { return 100 }
        return EyeLayout.centers.indices.min { a, b in
            hypot(EyeLayout.centers[a].x - x, EyeLayout.centers[a].y - y) < hypot(EyeLayout.centers[b].x - x, EyeLayout.centers[b].y - y) }
    }

    /// Move the pointer and the highlight: nothing is drawn again, the little views just move.
    func move(to g: (Double, Double)?) {
        if let g {
            let c = point(g)
            dot.setFrameOrigin(NSPoint(x: c.x - 18, y: c.y - 18))
            dot.isHidden = false
        } else {
            dot.isHidden = true
        }
        if let h = g.flatMap({ Self.hot($0.0, $0.1) }) {
            let r = h == 100 ? spaceRect : keyRect(h)
            if highlight.frame != r { highlight.frame = r }
            highlight.isHidden = false
        } else {
            highlight.isHidden = true
        }
    }

    func show(target t: (Double, Double)?) {
        if let t {
            let c = point(t)
            target.setFrameOrigin(NSPoint(x: c.x - 26, y: c.y - 26))
            target.isHidden = false
        } else {
            target.isHidden = true
        }
    }

    func label(_ text: String, _ font: NSFont, _ color: NSColor, centeredIn r: NSRect) {
        let shadow = NSShadow()
        shadow.shadowColor = NSColor(white: 0, alpha: 0.9)
        shadow.shadowBlurRadius = 4
        let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .shadow: shadow])
        let size = s.size()
        s.draw(at: NSPoint(x: r.midX - size.width / 2, y: r.midY - size.height / 2))
    }

    // See-through: only a light shade over the keyboard part, so what's behind it stays readable.
    override func draw(_ dirty: NSRect) {
        NSColor.clear.setFill()
        dirty.fill()
        let r = keyboardRect
        NSColor(white: 0, alpha: 0.22).setFill()
        NSBezierPath(roundedRect: r, xRadius: 24, yRadius: 24).fill()
        let kw = r.width / EyeLayout.width, kh = r.height / Self.rows
        let keyFont = NSFont.systemFont(ofSize: min(kw, kh) * 0.4, weight: .semibold)
        for (i, ch) in EyeLayout.keys.enumerated() {
            let k = keyRect(i)
            guard k.intersects(dirty) else { continue }
            NSColor(white: 1, alpha: 0.07).setFill()
            let shape = NSBezierPath(roundedRect: k, xRadius: 18, yRadius: 18)
            shape.fill()
            NSColor(white: 1, alpha: 0.22).setStroke()
            shape.lineWidth = 1.5
            shape.stroke()
            label(String(ch).uppercased(), keyFont, NSColor(white: 1, alpha: 0.92), centeredIn: k)
        }
        let sp = spaceRect
        if sp.intersects(dirty) {
            NSColor(white: 1, alpha: 0.07).setFill()
            let shape = NSBezierPath(roundedRect: sp, xRadius: 18, yRadius: 18)
            shape.fill()
            NSColor(white: 1, alpha: 0.22).setStroke()
            shape.lineWidth = 1.5
            shape.stroke()
            label("space", NSFont.systemFont(ofSize: min(kw, kh) * 0.25, weight: .medium), NSColor(white: 1, alpha: 0.6), centeredIn: sp)
        }
    }
}

// MARK: - The keyboard's behaviour

final class EyeKeyboard {
    let decoder: EyeSwipeDecoder
    let stream: EyeStream
    let camera = GazeCamera()
    let typer = Typer()
    let test: Bool
    var panel: NSPanel!
    var view: KeyboardView!
    var on = false

    // The setup: a dot moves along `route` (follow it), then sits on `checks` one by one (look at each).
    static let route: [(from: (Double, Double), to: (Double, Double), seconds: Double)] = [
        ((0.5, 0.5), (0.5, 0.5), 1.0), ((0.5, 0.5), (9.5, 0.5), 3.0), ((9.5, 0.5), (9.5, 1.5), 0.5),
        ((9.5, 1.5), (0.5, 1.5), 3.0), ((0.5, 1.5), (0.5, 2.5), 0.5), ((0.5, 2.5), (9.5, 2.5), 3.0),
        ((9.5, 2.5), (7.5, 3.6), 0.6), ((7.5, 3.6), (2.5, 3.6), 1.7), ((2.5, 3.6), (5.0, 0.5), 1.4)]
    static let checks: [(Double, Double)] = [(1.5, 0.5), (8.5, 0.5), (5.0, 1.5), (2.5, 2.5), (7.5, 2.5)]
    static let checkSeconds = 1.2, checkSettle = 0.5          // the eyes get to a dot 0.3 to 0.5 s after it jumps
    // Head features ([ex, ey, lid, nx, ny, mx, my, iod, ex², ey², nx·ny]: nose against the eyes, where the eyes
    // are in the picture, how far apart) may count only as much as the geometry allows: the head follows a
    // moving dot, so a free fit gave head position ~17 times its real weight and was 2 to 8 keys off on the
    // owner's next setup 25 s later. With these, 1.2 keys (and 1.0 within one setup, as before).
    static let headScales: [Int: Double] = [3: 0.2, 4: 0.2, 5: 0.1, 6: 0.1, 7: 0.04, 10: 0.1]
    static let lambda = 10.0
    enum Setup { case follow, check(Int) }
    var setup: Setup? = nil
    var setupBegan = 0.0, stepBegan = 0.0, tries = 0
    var followFrames: [(f: [Double], t: Double)] = []
    var checkFrames: [[[Double]]] = []
    var fitted: (cal: GazeCalibration, rows: [[Double]], targets: [(Double, Double)], groups: [Int])? = nil
    var setupRows: [[Double]] = [], setupTargets: [(Double, Double)] = [], setupGroups: [Int] = []
    var timer: Timer?
    var clock: Double? = nil                   // frame time + clock = when it was seen, in uptime

    var calibration: GazeCalibration?
    var learned: [([Double], (Double, Double))] = []           // frames from typed words, and the key looked at
    var toLearn: [([Double], (Double, Double))] = []           // the last phrase's, once you didn't fix it
    var hold = FixationHold()                                  // the pointer: still while the eyes rest
    // The whole map slides when the head moves after the setup (keys off on the owner's second setup). Each
    // typed word says where the eyes were (on its keys), so the map moves back by half the word's median miss.
    var shift = (x: 0.0, y: 0.0)
    let recentering = !CommandLine.arguments.contains("--no-recenter")
    var recent: [(Double, Double)] = [], smoothing = 1
    var typing = false                                         // a phrase is going (on the keyboard since looking up)
    var phrase: [GazeSample] = [], phraseFeatures: [[Double]] = []
    var phraseWords: [(word: String, start: Int, end: Int, restAt: (x: Double, y: Double)?)] = []
    var segment = 0                                            // where the word being looked at starts in `phrase`
    var restPoint: (x: Double, y: Double)? = nil               // where the eyes closed at the last blink
    var closedAt: Double? = nil, closedFrames = 0              // the blink going on
    var streamBegun = false, streamFed = 0                     // the live guess: begun for this word, samples seen
    // Words are worked out one at a time off the main thread; the live guess waits meanwhile (they share
    // the decoder), then catches up.
    enum Job { case word([GazeSample], start: Int, end: Int, restAt: (x: Double, y: Double)?), phraseEnd([GazeSample], [[Double]]) }
    var jobs: [Job] = [], busy = false
    let work = DispatchQueue(label: "hive.eye-keyboard.decode", qos: .userInteractive)
    var offSince: Double? = nil
    var lastTap = 0.0, downAt = 0.0
    var lastSpeedReport = 0.0
    var dump: FileHandle? = nil
    // --test: sentences to type, and how it went
    var testSentences = ["can you send me the notes from today", "i will be home in about an hour",
                         "let me know when you are ready to go", "the meeting got moved to friday morning",
                         "please turn off the lights in the kitchen", "what time does the store close tonight",
                         "thanks for helping me with the project", "do you want to grab lunch after class"]
    var testAt = 0, testGot: [String] = [], testWrong = 0, testWords = 0
    var replaying = false, decodeMs: [Double] = []

    init(decoder: EyeSwipeDecoder, test: Bool) {
        self.decoder = decoder
        self.test = test
        decoder.settings.minFixation = 0.1         // three camera frames: no need to wait on a letter
        stream = EyeStream(decoder: decoder)
        stream.settings.wordStarts = 0             // one word between blinks: the live guess never starts a second
        stream.settings.maxGuesses = 1500
        _ = decoder.lm.id                          // build the word index now, not on the first word
        if let path = option("--dump") {
            FileManager.default.createFile(atPath: path, contents: nil)
            dump = FileHandle(forWritingAtPath: path)
            dump?.seekToEndOfFile()
            if CommandLine.arguments.contains("--dump-eyes") {
                FileManager.default.createFile(atPath: path + ".eyes.jsonl", contents: nil)
                FileManager.default.createFile(atPath: path + ".eyes.bin", contents: nil)
                if let r = FileHandle(forWritingAtPath: path + ".eyes.jsonl"), let p = FileHandle(forWritingAtPath: path + ".eyes.bin") {
                    camera.eyeDump = (r, p, 0)
                }
            }
        }
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

    static let howTo = "Look at each letter (no need to wait on it), blink after each word, look up when done. Esc closes."

    func hint() -> String {
        if test, testAt < testSentences.count { return "Type:  \(testSentences[testAt])   — then look up" }
        return Self.howTo
    }

    func say(_ text: String) { view.status.text = text }

    func record(_ object: [String: Any]) {
        guard let dump, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        dump.write(data + Data("\n".utf8))
    }

    func toggle() {
        on.toggle()
        emit(["on": on])
        if on {
            guard camera.start() else { say("No camera"); return }
            panel.setFrame(NSScreen.main!.frame, display: false)
            view.frame = NSRect(origin: .zero, size: panel.frame.size)
            view.needsDisplay = true
            panel.orderFrontRegardless()
            typing = false
            view.words.text = ""
            if calibration == nil { tries = 0; startSetup() } else { say(hint()) }
        } else {
            if typing { finishPhrase() }
            camera.stop()
            panel.orderOut(nil)
            stopSetup()
        }
    }

    // MARK: Setup

    static func along(_ t: Double) -> (pos: (Double, Double), leg: Int, into: Double)? {
        guard t >= 0 else { return nil }
        var t = t
        for (i, leg) in route.enumerated() {
            if t <= leg.seconds {
                let f = t / leg.seconds
                return ((leg.from.0 + (leg.to.0 - leg.from.0) * f, leg.from.1 + (leg.to.1 - leg.from.1) * f), i, t)
            }
            t -= leg.seconds
        }
        return nil
    }

    func startSetup() {
        setup = .follow
        followFrames = []
        checkFrames = Array(repeating: [], count: Self.checks.count)
        fitted = nil
        view.move(to: nil)
        view.words.text = ""
        say("Follow the yellow dot with your eyes (about 20 seconds). Keep your head still.")
        let now = ProcessInfo.processInfo.systemUptime
        setupBegan = now + 0.8                 // a moment to find the dot before it moves
        stepBegan = now
        record(["follow_began": setupBegan])
        view.show(target: Self.route[0].from)
        timer?.invalidate()
        timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func stopSetup() {
        timer?.invalidate()
        timer = nil
        setup = nil
        view.show(target: nil)
    }

    func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        switch setup {
        case .follow:
            if let a = Self.along(now - setupBegan) {
                view.show(target: a.pos)
            } else if now - setupBegan > 0 {
                let frames = followFrames
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let f = Self.fitFollow(frames, began: self?.setupBegan ?? 0)
                    DispatchQueue.main.async { self?.fitted = f }
                }
                setup = .check(0)
                stepBegan = now
                view.show(target: Self.checks[0])
                say("Now look at each dot until it jumps.")
            }
        case .check(let i):
            guard now - stepBegan > Self.checkSeconds else { return }
            if i + 1 < Self.checks.count {
                setup = .check(i + 1)
                stepBegan = now
                view.show(target: Self.checks[i + 1])
            } else {
                finishSetup()
            }
        case nil:
            break
        }
    }

    /// The moving dot's frames to a calibration: the eyes trail the dot a little (and the camera adds its
    /// own delay), so try a few delays and keep the one that fits best.
    static func fitFollow(_ frames: [(f: [Double], t: Double)], began: Double) -> (GazeCalibration, [[Double]], [(Double, Double)], [Int])? {
        var best: (GazeCalibration, [[Double]], [(Double, Double)], [Int], Double)? = nil
        for lag in [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4] {
            var rows: [[Double]] = [], targets: [(Double, Double)] = [], groups: [Int] = []
            for (f, t) in frames {
                guard let a = along(t - began - lag) else { continue }
                if a.into < (a.leg == 0 ? 0.5 : 0.3) { continue }                 // finding the dot, catching up at a turn
                rows.append(f); targets.append(a.pos)
                groups.append(a.leg * 3 + min(2, Int(3 * a.into / route[a.leg].seconds)))
            }
            guard let cal = GazeCalibration.fit(rows: rows, targets: targets, groups: groups, lambda: lambda,
                                                leaveOut: false, scales: headScales) else { continue }
            let err = hypot(cal.spread.x, cal.spread.y)
            if best == nil || err < best!.4 { best = (cal, rows, targets, groups, err) }
        }
        guard let b = best else { return nil }
        return (b.0, b.1, b.2, b.3)
    }

    func finishSetup() {
        guard let f = fitted else {
            if followFrames.count < 60 {
                retrySetup("It couldn't see your eyes. Face the camera with light on your face.")
            } else {                                                            // the fit isn't done yet
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.finishSetup() }
            }
            return
        }
        stopSetup()
        // How far off it is, on dots it didn't learn from.
        var offs: [Double] = [], ex = 0.0, ey = 0.0, n = 0.0
        var rows = f.rows, targets = f.targets, groups = f.groups
        for (i, frames) in checkFrames.enumerated() where frames.count >= 3 {
            let p = frames.map { f.cal.map($0) }
            let mx = p.map { $0.0 }.sorted()[p.count / 2], my = p.map { $0.1 }.sorted()[p.count / 2]
            let dot = Self.checks[i]
            offs.append(hypot(mx - dot.0, my - dot.1))
            for q in p { ex += (q.0 - dot.0) * (q.0 - dot.0); ey += (q.1 - dot.1) * (q.1 - dot.1); n += 1 }
            for fr in frames { rows.append(fr); targets.append(dot); groups.append(100 + i) }
        }
        let off = offs.isEmpty ? 9 : offs.sorted()[offs.count / 2]
        emit(["check": ["keys_off": off, "dots": offs, "follow_fit": ["x": f.cal.spread.x, "y": f.cal.spread.y],
                        "eye_light": camera.eyeLight, "face_size": camera.faceSize, "frames": followFrames.count]])
        if off > 1.0 && tries < 2 {
            var why = "Keep your head still and follow the dot closely."
            if camera.eyeLight < 60 { why = "More light on your face would help (a lamp in front of you)." }
            else if camera.faceSize < 0.07 { why = "Sit a little closer to the camera." }
            retrySetup(String(format: "That came out %.1f keys off — too far to type well. %@ Again…", off, why))
            return
        }
        setupRows = rows; setupTargets = targets; setupGroups = groups
        learned = []; toLearn = []; shift = (0, 0)
        let cal = GazeCalibration.fit(rows: rows, targets: targets, groups: groups, lambda: Self.lambda,
                                      leaveOut: false, scales: Self.headScales) ?? f.cal
        use(cal, sigma: n > 0 ? ((ex / n).squareRoot(), (ey / n).squareRoot()) : (0.6, 0.6))
        say(String(format: "Accuracy: about %.1f keys off%@. ", off, off > 1 ? " (rough)" : "") + hint())
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.on, self.setup == nil else { return }
            self.say(self.hint())
        }
    }

    func retrySetup(_ why: String) {
        stopSetup()
        tries += 1
        say(why)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
            if self?.on == true && self?.setup == nil { self?.startSetup() }
        }
    }

    func use(_ cal: GazeCalibration, sigma: (Double, Double)? = nil) {
        calibration = cal
        if let s = sigma {
            decoder.settings.sigma = min(1.2, max(0.35, s.0))
            decoder.settings.sigmaY = min(1.0, max(0.3, s.1))
        }
    }

    // MARK: Looking

    func look(_ l: Look) {
        guard on else { return }
        switch l {
        case .gaze(let f):
            closedFrames = 0; closedAt = nil
            gaze(f)
        case .closed(let t):                                   // eyes shut: a normal blink ends the word
            record(["t": t, "phase": "closed"])
            if closedAt == nil { closedAt = t }
            closedFrames += 1
            if closedFrames == blinkFrames, typing, setup == nil { endWord(closedAt: closedAt) }
        case .away(let t):
            closedFrames = 0; closedAt = nil
            off(t)
        }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastSpeedReport > 5 {
            lastSpeedReport = now
            emit(["speed": ["fps": Int(camera.fps.rounded()), "ms_per_frame": Int(camera.msPerFrame.rounded())]])
        }
    }

    func gaze(_ f: GazeFeatures) {
        let now = ProcessInfo.processInfo.systemUptime
        clock = min(clock ?? .infinity, now - f.time)
        let seen = f.time + (clock ?? 0)                   // when the camera saw it, in uptime
        switch setup {
        case .follow:
            followFrames.append((f.values, seen))
            record(["t": seen, "ft": f.time, "phase": "follow", "f": f.values])
            return
        case .check(let i):
            if now - stepBegan > Self.checkSettle { checkFrames[i].append(f.values) }
            record(["t": seen, "ft": f.time, "phase": "check", "dot": [Self.checks[i].0, Self.checks[i].1], "f": f.values])
            return
        case nil:
            break
        }
        guard let cal = calibration else { return }
        let (x, y) = cal.map(f.values)
        record(["t": seen, "ft": f.time, "phase": "type", "f": f.values, "at": [x, y]])
        mapped(x, y, f)
    }

    /// A gaze point on the keyboard (key units): the pointer, and the word being looked at.
    func mapped(_ x: Double, _ y: Double, _ f: GazeFeatures) {
        let x = x + shift.x, y = y + shift.y
        view.move(to: hold(x, y, f.time))                           // the pointer: still while resting, jumps with the eyes
        recent.append((x, y))                                       // the word: raw points (the decoder models the
        if recent.count > smoothing { recent.removeFirst() }        // noise; a median of 3 made 4% more words wrong)
        let mx = recent.map { $0.0 }.sorted()[recent.count / 2], my = recent.map { $0.1 }.sorted()[recent.count / 2]
        guard onKeyboard(mx, my) else { off(f.time); return }
        offSince = nil
        if !typing {
            typing = true
            phrase = []; phraseFeatures = []
            segment = 0; restPoint = nil; streamBegun = false
        }
        phrase.append(GazeSample(x: mx, y: my, t: f.time))
        phraseFeatures.append(f.values)
        feed()
    }

    var rate: Double { min(60, max(15, camera.fps > 1 ? camera.fps : 30)) }
    lazy var blinkFrames: Int = option("--blink-frames").flatMap { Int($0) } ?? max(2, Int((0.05 * rate).rounded()))
    var previousWord: String? { test ? testGot.last : typer.previous }

    /// The live guess (the pill) for the word being looked at. Waits while a word is being worked out.
    func feed() {
        guard typing, !busy, jobs.isEmpty, segment < phrase.count else { return }
        if !streamBegun {
            stream.begin(previous: previousWord, rate: rate, resting: restPoint)
            streamBegun = true; streamFed = 0
        }
        while segment + streamFed < phrase.count { _ = stream.push(phrase[segment + streamFed]); streamFed += 1 }
        view.words.text = stream.guess() ?? ""
    }

    /// A blink (or looking up): the gaze since the last blink is one word. The eyes reopen about where they
    /// closed, so the next word starts resting there; the decoder finds where it really starts.
    func endWord(closedAt tc: Double?) {
        let start = segment, end = phrase.count - 1, rest = restPoint
        let seg = start <= end ? Array(phrase[start...end]) : []
        segment = phrase.count
        streamBegun = false
        view.words.text = ""
        if let tc {
            var near = seg.filter { $0.t >= tc - 0.15 && $0.t < tc }        // the last letter, held to the blink
            if near.isEmpty { near = Array(seg.suffix(3)) }
            if !near.isEmpty {
                let xs = near.map { $0.x }.sorted(), ys = near.map { $0.y }.sorted()
                restPoint = (xs[xs.count / 2], ys[ys.count / 2])
            }
        } else {
            restPoint = nil
        }
        let dwell = max(1, Int((decoder.settings.minFixation * rate).rounded()))
        let moved = rest.map { p in seg.filter { hypot($0.x - p.x, $0.y - p.y) > 1.0 }.count } ?? seg.count
        guard moved >= dwell else { return }                   // only resting (or a second blink): no word
        // A long rest before the word only costs time: keep its last few samples.
        var from = 0
        if let p = rest {
            while from < seg.count, hypot(seg[from].x - p.x, seg[from].y - p.y) < 0.8 { from += 1 }
            from = max(0, from - 4)
        }
        if seg.count - from > Int(8 * rate) { from = seg.count - Int(8 * rate) }
        jobs.append(.word(Array(seg[from...]), start: start + from, end: end, restAt: rest))
        nextJob()
    }

    func nextJob() {
        guard !busy, !jobs.isEmpty else { feed(); return }
        switch jobs.removeFirst() {
        case .word(let seg, let start, let end, let restAt):
            busy = true
            let previous = previousWord, decoder = self.decoder
            work.async { [weak self] in
                let began = DispatchTime.now().uptimeNanoseconds
                let best = decoder.decode(seg, previous: previous, count: 1, restAt: restAt).first
                let ms = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e6
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false
                    if let best {
                        self.phraseWords.append((best.word, start, end, restAt))
                        self.type(best.word, best.shown, ms: ms)
                        self.recenter(best.word, seg, restAt)
                    }
                    self.nextJob()
                }
            }
        case .phraseEnd(let samples, let features):
            learn(samples, features)
            if test { testPhrase() }
            nextJob()
        }
    }

    /// Moves the map back by half the median miss on the keys of the word just typed (at most 0.6 keys a word).
    func recenter(_ word: String, _ seg: [GazeSample], _ restAt: (x: Double, y: Double)?) {
        guard recentering, let keys = decoder.align(word, seg, restAt: restAt), keys.count > 2 else { return }
        var dx: [Double] = [], dy: [Double] = []
        for i in 1..<(keys.count - 1) where keys[i] >= 0 && keys[i - 1] == keys[i] && keys[i] == keys[i + 1] {
            let c = EyeLayout.centers[keys[i]]
            if hypot(seg[i].x - c.x, seg[i].y - c.y) < 2.0 { dx.append(c.x - seg[i].x); dy.append(c.y - seg[i].y) }
        }
        guard dx.count >= 4 else { return }
        let mx = dx.sorted()[dx.count / 2], my = dy.sorted()[dy.count / 2]
        shift.x += max(-0.6, min(0.6, 0.5 * mx))
        shift.y += max(-0.6, min(0.6, 0.5 * my))
    }

    func off(_ t: Double) {
        offSince = offSince ?? t
        if t - offSince! > 0.5 { view.move(to: nil) }
        if typing && t - offSince! > lookUpFinishes { finishPhrase() }
    }

    func type(_ word: String, _ shown: String, ms: Double) {
        decodeMs.append(ms)
        if decodeMs.count > 1000 { decodeMs.removeFirst() }
        NSSound(named: "Pop")?.play()
        if test { testGot.append(word); return }
        typer.put(shown, live: true)
        emit(["typed": shown, "ms": Int(ms.rounded())])
    }

    /// The eyes left the keyboard: type the last word, and (once it's typed) learn from the phrase.
    func finishPhrase() {
        typing = false
        endWord(closedAt: nil)
        jobs.append(.phraseEnd(phrase, phraseFeatures))
        nextJob()
    }

    func learn(_ phrase: [GazeSample], _ phraseFeatures: [[Double]]) {
        emit(["phrase": ["samples": phrase.count, "words": phraseWords.map { $0.word }]])
        // The phrase before this one stood (you didn't fix it): its frames tune the calibration.
        learned += toLearn
        if learned.count > 600 { learned.removeFirst(learned.count - 600) }
        toLearn = []
        for w in phraseWords where w.end < phrase.count && w.end - w.start >= 3 {
            let part = Array(phrase[w.start...w.end])
            guard let keys = decoder.align(w.word, part, restAt: w.restAt) else { continue }
            for i in 1..<(keys.count - 1) where keys[i] >= 0 && keys[i - 1] == keys[i] && keys[i] == keys[i + 1] {
                let c = EyeLayout.centers[keys[i]]
                if hypot(part[i].x - c.x, part[i].y - c.y) < 1.8 { toLearn.append((phraseFeatures[w.start + i], (c.x, c.y))) }
            }
        }
        phraseWords = []
        if !learned.isEmpty && !replaying {
            let rows = setupRows + learned.map { $0.0 }, targets = setupTargets + learned.map { $0.1 }
            let groups = setupGroups + learned.map { _ in -1 }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let cal = GazeCalibration.fit(rows: rows, targets: targets, groups: groups, lambda: Self.lambda,
                                                    leaveOut: false, scales: Self.headScales) else { return }
                DispatchQueue.main.async {
                    guard let self, self.setup == nil else { return }
                    self.use(cal)
                    let last = self.learned.suffix(150)                // what the new fit still misses on them
                    guard last.count >= 10 else { self.shift = (0, 0); return }
                    let dx = last.map { $0.1.0 - cal.map($0.0).0 }.sorted(), dy = last.map { $0.1.1 - cal.map($0.0).1 }.sorted()
                    self.shift = (dx[dx.count / 2], dy[dy.count / 2])
                }
            }
        }
    }

    /// --replay: made-up gaze from `eyeswipe-sim --write-replay` (lines {"sentence"}, {"x", "y"}, {"closed"},
    /// {"away"}, one camera frame each at 30 a second) through the typing code, as in --test.
    func replay(_ path: String) {
        view = KeyboardView(frame: NSRect(x: 0, y: 0, width: 1470, height: 956))
        on = true; replaying = true
        if let v = option("--sigma").flatMap(Double.init) { decoder.settings.sigma = v }   // as the setup would
        if let v = option("--lm-weight").flatMap(Double.init) { decoder.settings.lmWeight = v }
        if let v = option("--shift-sigma").flatMap(Double.init) { decoder.settings.shiftSigma = v }
        if let v = option("--smooth").flatMap(Int.init) { smoothing = v }
        let lines = (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n") ?? []
        let events = lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        testSentences = events.compactMap { $0["sentence"] as? String }
        var t = 0.0, worst = 0.0, waits = 0
        for e in events {
            let began = DispatchTime.now().uptimeNanoseconds
            if e["closed"] != nil { look(.closed(t)) }
            else if e["away"] != nil { look(.away(t)) }
            else if let x = e["x"] as? Double, let y = e["y"] as? Double {
                closedFrames = 0; closedAt = nil                               // as look(.gaze) does
                mapped(x, y, GazeFeatures(values: [], time: t))
            }
            else { continue }
            worst = max(worst, Double(DispatchTime.now().uptimeNanoseconds - began) / 1e6)
            t += 1.0 / 30
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.0005))     // let finished words come in
            if busy { waits += 1 }
        }
        while busy || !jobs.isEmpty { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.002)) }
        let ms = decodeMs.sorted()
        emit(["replay": ["frames": events.count, "worst_frame_ms": (worst * 10).rounded() / 10, "frames_while_decoding": waits,
                         "word_ms": ["median": ms.isEmpty ? 0 : ms[ms.count / 2].rounded(), "p95": ms.isEmpty ? 0 : ms[ms.count * 95 / 100].rounded(),
                                     "worst": ms.last?.rounded() ?? 0]]])
    }

    /// --calib-test dump: the setup's fit on each recorded setup in a --dump file, checked on its own dots and
    /// on the other setups' dots (the head has moved by then, as it does while typing).
    static func calibTest(_ path: String) {
        let lines = (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n") ?? []
        var runs: [(began: Double, follow: [(f: [Double], t: Double)], dots: [[Double]: [(f: [Double], t: Double)]])] = []
        for line in lines {
            guard let e = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if let b = e["follow_began"] as? Double { runs.append((b, [], [:])); continue }
            guard !runs.isEmpty, let f = e["f"] as? [Double], let t = e["t"] as? Double else { continue }
            if e["phase"] as? String == "follow" { runs[runs.count - 1].follow.append((f, t)) }
            if e["phase"] as? String == "check", let d = e["dot"] as? [Double] { runs[runs.count - 1].dots[d, default: []].append((f, t)) }
        }
        func settled(_ frames: [(f: [Double], t: Double)]) -> [[Double]] {
            frames.filter { $0.t - frames[0].t > checkSettle }.map { $0.f }
        }
        func off(_ cal: GazeCalibration, _ frames: [[Double]], _ dot: [Double]) -> Double {
            let p = frames.map { cal.map($0) }
            return hypot(p.map { $0.0 }.sorted()[p.count / 2] - dot[0], p.map { $0.1 }.sorted()[p.count / 2] - dot[1])
        }
        var finals: [GazeCalibration?] = []
        for (k, run) in runs.enumerated() {
            guard let f = fitFollow(run.follow, began: run.began) else { finals.append(nil); continue }
            var rows = f.1, targets = f.2, groups = f.3, offs: [Double] = []
            for (i, (dot, frames)) in run.dots.sorted(by: { $0.key.lexicographicallyPrecedes($1.key) }).enumerated() {
                let s = settled(frames)
                guard s.count >= 3 else { continue }
                offs.append((off(f.0, s, dot) * 100).rounded() / 100)
                for r in s { rows.append(r); targets.append((dot[0], dot[1])); groups.append(100 + i) }
            }
            finals.append(GazeCalibration.fit(rows: rows, targets: targets, groups: groups, lambda: lambda, leaveOut: false, scales: headScales))
            emit(["setup": k, "own_dots_keys_off": offs, "follow_fit": [(f.0.spread.x * 100).rounded() / 100, (f.0.spread.y * 100).rounded() / 100]])
        }
        for (a, cal) in finals.enumerated() {
            guard let cal else { continue }
            for (b, run) in runs.enumerated() where b != a {
                let offs = run.dots.sorted(by: { $0.key.lexicographicallyPrecedes($1.key) }).compactMap { dot, frames -> Double? in
                    let s = settled(frames); return s.count >= 3 ? (off(cal, s, dot) * 100).rounded() / 100 : nil }
                emit(["fit_on": a, "dots_of": b, "keys_off": offs])
            }
        }
    }

    // Right ⌘ (double-tap opens and closes), Esc (closes), and your own typing, from the event tap.
    // Returns false to swallow the event.
    func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let now = ProcessInfo.processInfo.systemUptime
        if type == .keyDown && code == escapeKey && on {
            toggle()
            return false
        }
        if type == .keyDown && on && event.getIntegerValueField(.eventSourceUserData) != ourEvents {
            typer.youTyped()                                   // you fixed something: don't learn from that phrase
            toLearn = []
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

    func testPhrase() {
        guard testAt < testSentences.count, !testGot.isEmpty else { return }
        let want = testSentences[testAt].split(separator: " ").map(String.init)
        if testGot.count < want.count - 2 && !replaying { return }        // not done with the sentence yet
        let wrong = editDistance(testGot, want)
        testWrong += wrong
        testWords += want.count
        emit(["test_sentence": ["want": want.joined(separator: " "), "got": testGot.joined(separator: " "), "wrong": wrong]])
        testGot = []
        testAt += 1
        let rate = 100 * Double(testWrong) / Double(testWords)
        if testAt == testSentences.count {
            emit(["test": ["words": testWords, "wrong": testWrong, "percent_wrong": rate]])
            say(String(format: "Done: %.0f%% of %d words wrong.", rate, testWords))
        } else {
            say(String(format: "%.0f%% wrong so far.   ", rate) + hint())
        }
    }
}

func editDistance(_ a: [String], _ b: [String]) -> Int {
    if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
    var row = Array(0...b.count)
    for i in 1...a.count {
        var prev = row[0]
        row[0] = i
        for j in 1...b.count {
            let cur = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
            prev = cur
        }
    }
    return row[b.count]
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
            view.status.text = keyboard.hint()
            if CommandLine.arguments.contains("--setup") {
                view.status.text = "Follow the yellow dot with your eyes (about 20 seconds). Keep your head still."
                view.show(target: (4.2, 1.5))
            } else {
                view.words.text = "can you send me"
                view.move(to: (5.6, 3.55))
            }
            let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
            exit(0)
        }

        if let path = option("--replay") { keyboard.replay(path); exit(0) }
        if let path = option("--calib-test") { EyeKeyboard.calibTest(path); exit(0) }
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
        if !CGPreflightPostEventAccess() {
            CGRequestPostEventAccess()
            FileHandle.standardError.write(Data("hive-eye-keyboard: it isn't allowed to type; allow it under Accessibility\n".utf8))
        }
        AVCaptureDevice.requestAccess(for: .video) { ok in
            if !ok { FileHandle.standardError.write(Data("hive-eye-keyboard: the camera isn't allowed\n".utf8)) }
        }
        FileHandle.standardError.write(Data("hive-eye-keyboard: double-tap right ⌘ to start (Esc closes it)\n".utf8))
        app.run()
    }
}
