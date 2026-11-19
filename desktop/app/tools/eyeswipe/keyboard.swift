// Hive's eye keyboard on the Mac: type by saying it, with the eyes confirming. Double-tap right ⌘ and a
// see-through keyboard covers the lower part of the screen. Look at the keys and say a sentence (no voice,
// no blinks, no space bar): the lip reader reads the mouth (fitted to the owner's face from practice), and
// the sentence is typed into the app in front once you look up over the top of the screen (or after 8 s of a
// still mouth). The eyes say when a sentence starts and ends, and in practice glancing across the letters
// teaches the gaze map. The gaze isn't in the word search for now (lipgaze.py GAZE_IN_SEARCH says why), so
// typing needn't hunt for letters, which is what made it slow. The line in the keyboard's
// bottom row shows the practice sentence or what was typed, so reading it keeps the eyes on the keyboard;
// gaze there isn't part of the swipe. Esc closes it.
//
// The eye setup (about 3 minutes: follow a slow yellow dot with your eyes, look at it on every key, keep
// looking at it while moving your head a little, then on every key again; it says how accurate it got on that
// last round) is done once: it's saved as numbers (no pictures) in eye-calibration.json in Hive's state folder,
// readable only by you, and every later start uses it. --new-setup does it again; --calibration path keeps it
// elsewhere; --check-calibration says what's saved and whether it reads back the same.
//
// Gaze comes from the Mac's camera through Apple Vision's face landmarks: where the pupils sit in the eyes,
// how open the lids are, and which way the head points (the nose against the eyes), mapped to the keyboard
// by the setup, which limits how much head position counts (the head moves with the moving dot, and a free
// fit was keys off once the head moved). The pointer holds still while the eyes rest (FixationHold). Apart
// from the setup, nothing is saved or sent unless --dump or --lips-record says so: the camera runs only while
// the keyboard is up, and each frame is dropped once read.
//
// Lip reading runs scripts/lipgaze.py serve (USR 2.0, set up by scripts/setup-lipgaze.sh; --lips-python and
// --lips-script to point elsewhere). --lips-record DIR is practice: the line under the keys shows the one
// sentence to say, each take's mouth crops and gaze are kept in DIR, what was read goes to the log only, and
// nothing is typed (lipgaze.py eval DIR reads them again, lips alone against lips + eyes).
//
// --blinks is the older blink typing: look at each letter and blink after each word; the blink types it, and
// looking up off the keyboard types the last one. Each word (the gaze between two blinks) is decoded by
// EyeSwipe.swift's EyeSwipeDecoder off the main thread, the live guess by its EyeStream, with the language model
// in eyeswipe-lm.bin (next to this binary, or --lm); every word typed tunes the setup a little more.
//
// Writes one JSON object per line on stdout: {"on": true|false}, {"setup": {"x": spread, "y": spread}},
// {"check": {"keys_off": median, "dots": [...]}} (key widths), {"typed": "word", "ms": decode time}, {"phrase": {...}},
// {"speed": {...}}, {"test": {...}} after a test, {"calibration": {...}} for --check-calibration.
//
//   hive-eye-keyboard [--lips-record DIR] [--new-setup] [--calibration path] [--dump file [--dump-eyes]]
//       --lips-record DIR also records each time it's open into <state>/lipgaze/sessions/<date time>/ (kept on
//       this Mac): screen.mov (the screen with the Mac's sound and the microphone), camera.mov (the camera as it
//       saw you), events.jsonl (every frame's gaze numbers, where they landed and where the dot was drawn; what
//       was shown, every message from the lip reader, all with times), events.jsonl.eyes.* (the eyes' pixels)
//       and lipreader.log. --no-session-recording turns it off; --record-sessions turns it on without practice.
//       --dump: appends each frame's gaze numbers (not pictures) and the setup dot to a file, to tune it
//       --dump-eyes: also the eyes' part of each frame, grey (file.eyes.bin, described by file.eyes.jsonl)
//   hive-eye-keyboard --check-calibration [--calibration path]
//   hive-eye-keyboard --blinks [--lm path] [--test] [--blink-frames n]
//       --test: shows sentences to type and counts the wrong words, typing nothing into other apps
//       --blink-frames: closed-eye camera frames that make a blink (default: about 50 ms' worth, at least 2)
//   hive-eye-keyboard --snapshot out.png [--setup] [--trail] [--blinks] [--lips-record x]   draws it into a PNG (tests)
//   hive-eye-keyboard --test --replay file      types made-up gaze from eyeswipe-sim --write-replay (tests)
//   hive-eye-keyboard --calib-test dump         the setup's fit on each setup in a --dump, checked on its dots
//   hive-eye-keyboard --learn-replay SESSION [--calibration copy]   a recorded practice session through the
//       map's learning from each sentence: how far off the gaze was with it, against the setup's map alone
//   hive-eye-keyboard --lips-record DIR --session-test SECONDS   opens for SECONDS without a key, records the
//       session, closes and quits once its movies are written (checks the recording; the keys aren't watched)
//
// Needs Accessibility (to see right ⌘ and Esc, and to type) and the camera, for the app it runs from.

import Accelerate
import AppKit
import AVFoundation
@preconcurrency import ScreenCaptureKit
import Vision

let rightCommandKey: Int64 = 54                  // kVK_RightCommand
let escapeKey: Int64 = 53                        // kVK_Escape
let rightCommandDown: UInt64 = 0x10              // NX_DEVICERCMDKEYMASK
let tapSeconds = 0.25, doubleTapSeconds = 0.45
let lookUpFinishes = 0.3                         // off the keyboard this long types the last word
let ourEvents: Int64 = 0x4876_6B62               // marks the keys we type, to tell them from yours

// Lips + eyes is the keyboard (owner, 2026-11-19: "only eye tracking plus lip reading"). Blink typing is kept
// only behind --blinks and for its own tests (--test, --replay, --calib-test). --lips is still accepted.
let blinkTyping = ["--blinks", "--test", "--replay", "--calib-test"].contains { CommandLine.arguments.contains($0) }
let lipsMode = !blinkTyping

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
    var onFace: ((Double, Data) -> Void)?         // --lips: each frame's face, grey, faceSide x faceSide, top row first
    static let faceSide = 320
    var faceBox: (x: Double, y: Double, side: Double)? = nil

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

    // Session recording: the camera's frames as it saw them. `videoURL` starts a movie with the next frame
    // (its first frame is at camera time `onVideoStart`'s); both are only touched on `queue`.
    var videoURL: URL? = nil
    var video: (writer: AVAssetWriter, input: AVAssetWriterInput)? = nil
    var onVideoStart: ((Double, Int, Int) -> Void)?

    /// Records the camera into `url` from the next frame on, or (nil) finishes the movie being recorded.
    func record(to url: URL?) {
        queue.async {
            if let v = self.video {
                v.input.markAsFinished()
                let writer = v.writer
                writer.finishWriting { _ = writer }
                self.video = nil
            }
            self.videoURL = url
        }
    }

    func writeVideo(_ buffer: CMSampleBuffer, _ pixels: CVPixelBuffer, _ time: Double) {
        if let url = videoURL {
            videoURL = nil
            let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
            guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return }
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoMaxKeyFrameIntervalKey: 30]])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { return }
            writer.add(input)
            guard writer.startWriting() else { return }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer))
            video = (writer, input)
            onVideoStart?(time, w, h)
        }
        if let v = video, v.input.isReadyForMoreMediaData { v.input.append(buffer) }
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
        if video != nil || videoURL != nil { writeVideo(sampleBuffer, pixels, time) }
        let request = VNDetectFaceLandmarksRequest()
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up).perform([request])
        let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width })
        let now = ProcessInfo.processInfo.systemUptime
        msPerFrame += 0.1 * ((now - began) * 1000 - msPerFrame)
        if lastFrame > 0 { fps += 0.1 * (1 / max(1e-3, time - lastFrame) - fps) }
        lastFrame = time
        if let onFace {
            if let face, let crop = faceCrop(face.boundingBox, pixels) { onFace(time, crop) } else { faceBox = nil }
        }
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
            // Vision's own pupil point. On the owner's recorded eyes (2026-11-17, light ~56) it was 0.69 keys off
            // on moving-dot rows the fit hadn't seen and jittered 0.34 keys a frame; the old blend with the
            // darkest pixels was 1.00 and 0.63 (darkest pixels alone 1.16). The darkest pixels still give the light.
            let dark = darkest(outline, luma, stride, w, h)
            if let dark { light += dark.2 / 2 }
            let pupil = pupilMark?.pointsInImage(imageSize: size).first.map { (Double($0.x), Double($0.y)) }
                ?? dark.map { ($0.0, $0.1) } ?? (cx, cy)
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

    /// A square 1.6 times Vision's face box from the camera's grey (the luma plane), scaled to faceSide. The
    /// square follows the face smoothly: the lip reader finds the mouth in it frame to frame, and a box that
    /// jumped about with Vision's would shake the mouth crop.
    func faceCrop(_ box: CGRect, _ pixels: CVPixelBuffer) -> Data? {
        let w = CVPixelBufferGetWidthOfPlane(pixels, 0), h = CVPixelBufferGetHeightOfPlane(pixels, 0)
        let side = min(Double(min(w, h)), 1.6 * max(Double(box.width) * Double(w), Double(box.height) * Double(h)))
        let cx = Double(box.midX) * Double(w), cy = (1 - Double(box.midY)) * Double(h)       // Vision's y goes up
        if let b = faceBox, abs(b.x - cx) < 0.25 * b.side, abs(b.y - cy) < 0.25 * b.side, abs(b.side - side) < 0.25 * b.side {
            faceBox = (b.x + 0.2 * (cx - b.x), b.y + 0.2 * (cy - b.y), b.side + 0.1 * (side - b.side))
        } else {
            faceBox = (cx, cy, side)
        }
        let b = faceBox!, n = Self.faceSide
        let s = Int(b.side)
        guard s >= 64 else { return nil }
        let x0 = max(0, min(w - s, Int(b.x - b.side / 2))), y0 = max(0, min(h - s, Int(b.y - b.side / 2)))
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0)
        var src = vImage_Buffer(data: base.advanced(by: y0 * rowBytes + x0), height: vImagePixelCount(s),
                                width: vImagePixelCount(s), rowBytes: rowBytes)
        var out = Data(count: n * n)
        let error = out.withUnsafeMutableBytes { raw -> vImage_Error in
            var dst = vImage_Buffer(data: raw.baseAddress, height: vImagePixelCount(n), width: vImagePixelCount(n), rowBytes: n)
            return vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageHighQualityResampling))
        }
        return error == kvImageNoError ? out : nil
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

// MARK: - Session recording (--lips-record)

/// The screen as it looked, with what the Mac played and the microphone (owner's rule: screen recordings
/// always have the Mac's sound), into a movie by ScreenCaptureKit. `note` gets what happened to it.
final class ScreenRecorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
    let url: URL
    let note: ([String: Any]) -> Void
    var stream: SCStream?
    var output: SCRecordingOutput?
    var keep: ScreenRecorder?                   // itself, from stop() until the movie is written

    init(url: URL, note: @escaping ([String: Any]) -> Void) { self.url = url; self.note = note }

    func start(microphone: Bool = true) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let content, let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                    ?? content.displays.first else {
                self.note(["event": "screen_failed", "why": error?.localizedDescription ?? "no display"])
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            let scale = min(1.5, Double(filter.pointPixelScale))
            config.width = Int(Double(display.width) * scale)
            config.height = Int(Double(display.height) * scale)
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.showsCursor = true
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            config.captureMicrophone = microphone
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            let recording = SCRecordingOutputConfiguration()
            recording.outputURL = self.url
            recording.outputFileType = .mov
            recording.videoCodecType = .h264
            let output = SCRecordingOutput(configuration: recording, delegate: self)
            do { try stream.addRecordingOutput(output) } catch {
                self.note(["event": "screen_failed", "why": error.localizedDescription])
                return
            }
            self.stream = stream
            self.output = output
            stream.startCapture { error in
                if let error {
                    self.note(["event": "screen_failed", "why": error.localizedDescription, "microphone": microphone])
                    self.stream = nil
                    self.output = nil
                    if microphone { self.start(microphone: false) }     // the microphone may be what was refused
                } else {
                    self.note(["event": "screen_capturing", "microphone": microphone, "width": config.width,
                               "height": config.height, "path": self.url.path])
                }
            }
        }
    }

    func stop() {
        guard let stream else { return }
        keep = self
        stream.stopCapture { _ in }
        self.stream = nil
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) { note(["event": "screen_started"]) }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        note(["event": "screen_saved", "path": url.path])
        keep = nil
    }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        note(["event": "screen_failed", "why": error.localizedDescription])
        keep = nil
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        note(["event": "screen_stopped", "why": error.localizedDescription])
    }
}

// MARK: - Lip reading (--lips)

/// scripts/lipgaze.py serve in its own process: USR 2.0 reads the mouth and the gaze confirms the words.
/// It gets each frame's face (grey) and each gaze point on the keyboard, both in camera time, and answers
/// with a line of JSON per event: {"status"}, {"ready"}, {"text"} (a sentence to type), {"prompt"} and
/// {"result"} (--lips-record), {"error"}.
final class LipReader {
    let process = Process()
    let input = Pipe(), output = Pipe(), errors = Pipe()
    var logCopy: FileHandle? = nil           // the session's lipreader.log (under `lock`)
    let writes = DispatchQueue(label: "hive.eye-keyboard.lips")
    let lock = NSLock()
    var backlog = 0                          // frames waiting to be written: past 30 the newest are dropped
    var running = false
    var buffer = Data()
    var onMessage: (([String: Any]) -> Void)?
    let python: String, script: String

    init() {
        let here = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        let state = ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Hive"
        python = option("--lips-python") ?? state + "/lipgaze/.venv/bin/python"
        script = option("--lips-script") ?? here.appendingPathComponent("../scripts/lipgaze.py").standardizedFileURL.path
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [script, "serve"] + (option("--lips-record").map { ["--record", $0] } ?? [])
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
    }

    /// Its log also goes into `url` (nil: only to stderr again).
    func copyLog(to url: URL?) {
        var file: FileHandle? = nil
        if let url {
            FileManager.default.createFile(atPath: url.path, contents: nil)
            file = FileHandle(forWritingAtPath: url.path)
        }
        lock.lock()
        let old = logCopy
        logCopy = file
        lock.unlock()
        try? old?.close()
    }

    /// Why it can't run, or nil.
    var missing: String? {
        if !FileManager.default.isExecutableFile(atPath: python) { return "Lip reading isn't set up (scripts/setup-lipgaze.sh)" }
        if !FileManager.default.fileExists(atPath: script) { return "Can't find lipgaze.py at \(script)" }
        return nil
    }

    func start() throws {
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            FileHandle.standardError.write(data)
            guard let self else { return }
            self.lock.lock()
            self.logCopy?.write(data)
            self.lock.unlock()
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                self.running = false
                DispatchQueue.main.async { self.onMessage?(["gone": true]) }
                return
            }
            self.buffer.append(data)
            while let end = self.buffer.firstIndex(of: 10) {
                let line = self.buffer.subdata(in: self.buffer.startIndex..<end)
                self.buffer.removeSubrange(self.buffer.startIndex...end)
                if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                    DispatchQueue.main.async { self.onMessage?(message) }
                }
            }
        }
        try process.run()
        running = true
    }

    func send(_ header: [String: Any], body: Data? = nil) {
        guard running, var data = try? JSONSerialization.data(withJSONObject: header) else { return }
        data.append(10)
        if let body {
            lock.lock()
            let full = backlog > 30
            if !full { backlog += 1 }
            lock.unlock()
            if full { return }
            data.append(body)
        }
        writes.async {
            do { try self.input.fileHandleForWriting.write(contentsOf: data) } catch { self.running = false }
            if body != nil { self.lock.lock(); self.backlog -= 1; self.lock.unlock() }
        }
    }

    func stop() {
        running = false
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
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
        if lipsMode {          // in the space bar's old row, so reading it keeps the eyes on the keyboard
            let top = point((0, EyeKeyboard.keysEnd)).y, bottom = point((0, Self.rows - 0.05)).y
            words.frame = NSRect(x: bounds.width * 0.05, y: top, width: bounds.width * 0.9, height: bottom - top)
        } else {
            words.frame = NSRect(x: bounds.width * 0.05, y: keyboardRect.minY - 84, width: bounds.width * 0.9, height: 72)
        }
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
        guard onKeyboard(x, y), !(lipsMode && y > EyeKeyboard.keysEnd) else { return nil }   // reading the line below the keys
        let (sx, sy) = EyeLayout.spaceOffset(x, y)
        if !lipsMode && y > 3.1 && hypot(sx, sy) < 0.9 { return 100 }
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
        if !lipsMode && sp.intersects(dirty) {                          // lip reading: the mouth says where words end
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

    // The setup, about 3 minutes (it was 20 s; webcam trackers get more accurate with longer calibration,
    // 1.4 degrees after 5 minutes in a published one, and a key here is about 3 degrees):
    //  1. a dot moves slowly along `route` (follow it): rows take 6 s, not 3, because the eyes trail a moving
    //     dot and the owner's misses were bigger along the motion (1.0-1.35 keys) than across it (0.8-1.0);
    //  2. then `holds`: the dot sits on every key for 2 s; then on four spots while you slowly move your head
    //     (so the map learns head movement with the eyes kept on one spot, which the moving dot can't teach);
    //     then on every key again in another order. The second round is the check: how far off it is comes
    //     from a map that never saw it, and then the map learns it too. The eyes reach a dot 0.6-0.9 s after
    //     it jumps (camera delay included), so the first 0.9 s of each is skipped.
    static let route: [(from: (Double, Double), to: (Double, Double), seconds: Double)] = [
        ((0.5, 0.5), (0.5, 0.5), 1.2), ((0.5, 0.5), (9.5, 0.5), 6.0), ((9.5, 0.5), (9.5, 1.5), 1.0),
        ((9.5, 1.5), (0.5, 1.5), 6.0), ((0.5, 1.5), (0.5, 2.5), 1.0), ((0.5, 2.5), (9.5, 2.5), 6.0),
        ((9.5, 2.5), (7.5, 3.6), 1.2), ((7.5, 3.6), (2.5, 3.6), 3.4), ((2.5, 3.6), (5.0, 0.5), 2.8)]
    typealias Route = [(from: (Double, Double), to: (Double, Double), seconds: Double)]
    /// The 20-second setup's route, for --calib-test on recordings made before 2026-11-17 02:00 (no "route").
    static let fastRoute: Route = [
        ((0.5, 0.5), (0.5, 0.5), 1.0), ((0.5, 0.5), (9.5, 0.5), 3.0), ((9.5, 0.5), (9.5, 1.5), 0.5),
        ((9.5, 1.5), (0.5, 1.5), 3.0), ((0.5, 1.5), (0.5, 2.5), 0.5), ((0.5, 2.5), (9.5, 2.5), 3.0),
        ((9.5, 2.5), (7.5, 3.6), 0.6), ((7.5, 3.6), (2.5, 3.6), 1.7), ((2.5, 3.6), (5.0, 0.5), 1.4)]
    enum HoldKind { case key, head }
    static let keyCentres: [(Double, Double)] = ["qwertyuiop", "asdfghjkl", "zxcvbnm.?"].enumerated().flatMap { r, row in
        row.indices.map { i in ([0, 0.5, 1.0][r] + Double(row.distance(from: row.startIndex, to: i)) + 0.5, Double(r) + 0.5) } }
    static let holds: [(dot: (Double, Double), seconds: Double, kind: HoldKind, pass: Int)] = {
        var out: [(dot: (Double, Double), seconds: Double, kind: HoldKind, pass: Int)] = []
        let snake = [0, 1, 2].flatMap { r -> [(Double, Double)] in
            let row = keyCentres.filter { $0.1 == Double(r) + 0.5 }; return r == 1 ? row.reversed() : row }
        out += snake.map { ($0, 2.0, .key, 1) }
        out += [(1.5, 1.5), (8.5, 1.5), (5.0, 0.5), (5.0, 2.5)].map { ($0, 6.0, .head, 0) }
        let n = keyCentres.count
        out += (0..<n).map { (keyCentres[($0 * 11) % n], 2.0, .key, 2) }       // all 28 keys again, jumping around
        return out
    }()
    static let checkSettle = 0.9
    // Head features ([ex, ey, lid, nx, ny, mx, my, iod, ex², ey², nx·ny]: nose against the eyes, where the eyes
    // are in the picture, how far apart) may count only as much as the geometry allows: the head follows a
    // moving dot, so a free fit gave head position ~17 times its real weight and was 2 to 8 keys off on the
    // owner's next setup 25 s later. With these, 1.2 keys (and 1.0 within one setup, as before).
    static let headScales: [Int: Double] = [3: 0.2, 4: 0.2, 5: 0.1, 6: 0.1, 7: 0.04, 10: 0.1]
    static let lambda = 10.0
    enum Setup { case follow, hold(Int) }
    var setup: Setup? = nil
    var setupBegan = 0.0, stepBegan = 0.0, tries = 0
    var followFrames: [(f: [Double], t: Double)] = []
    var holdFrames: [[[Double]]] = []
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
    var aboveSince: Double? = nil                              // lips: gaze well above the screen since
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
    // --lips: the lip reader, started the first time the keyboard opens
    var lips: LipReader? = nil
    var lipsReady = false, lipsProblem: String? = nil, lipsPrompt: String? = nil, lipsNumber = 0
    var lipsListening = false                                  // frames go to it only while typing (read on the camera queue)
    var lipsEnded = false                                      // {"end"} sent since the eyes left the keyboard
    var lipsHeard = false                                      // practice: the lip reader is listening for this sentence
    // Lips: the last 90 s of gaze on the keys (camera time, features, where the map put it), so each sentence,
    // once its words are known, teaches the map where the eyes really were (learnSentence).
    var sentenceGaze: [(t: Double, f: [Double], x: Double, y: Double)] = []
    static let learnedMost = 3000                              // learned frames kept (about 15 sentences)
    // Session recording (--lips-record, or --record-sessions): see startSessionRecording.
    let recordsSessions = option("--dump") == nil && !CommandLine.arguments.contains("--no-session-recording")
        && ((lipsMode && option("--lips-record") != nil) || CommandLine.arguments.contains("--record-sessions"))
    var sessionFolder: URL? = nil
    var screenRecorder: ScreenRecorder? = nil
    static let keysEnd = 3.25                                  // below this (in key rows) is the line, not keys
    static let lipsLookUp = -2.5                               // lips: above this (key rows) is over the screen
    static let lipsAwayFinishes = 1.5                          // lips: seconds off the keys that end a sentence too

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
        if lipsMode {
            camera.onFace = { [weak self] t, face in
                guard let self, self.lipsListening, let lips = self.lips else { return }
                lips.send(["frame": ["t": t, "w": GazeCamera.faceSide, "h": GazeCamera.faceSide]], body: face)
            }
        }
    }

    static let howTo = "Look at each letter (no need to wait on it), blink after each word, look up when done. Esc closes."

    static let lipsHowTo = "Look at the keys and say a sentence. Then look up over the screen to type it. Esc closes."

    func hint() -> String {
        if lipsMode {
            if let problem = lipsProblem { return problem }
            if !lipsReady { return "Loading the lip reader…" }
            if lipsPrompt != nil {
                if lipsHeard {
                    return "Listening: say it, slowly is fine, glancing across its letters. Then look up over the screen. Esc to finish."
                }
                return "Practice \(lipsNumber): read the blue sentence, then look at the keys and say it. Esc to finish."
            }
            return Self.lipsHowTo
        }
        if test, testAt < testSentences.count { return "Type:  \(testSentences[testAt])   — then look up" }
        return Self.howTo
    }

    func say(_ text: String) {
        if text != view.status.text { note(["event": "status", "text": text]) }
        view.status.text = text
    }

    func record(_ object: [String: Any]) {
        guard let dump, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        dump.write(data + Data("\n".utf8))
    }

    /// An event in the session's events.jsonl, at uptime `t` (the camera's clock) unless it has one.
    func note(_ object: [String: Any]) {
        var object = object
        if object["t"] == nil { object["t"] = ProcessInfo.processInfo.systemUptime }
        record(object)
    }

    /// Records this time the keyboard is open, to study it afterwards (owner, 2026-11-19: everything, so the
    /// whole system can be fixed from what really happened). A folder under <state>/lipgaze/sessions gets the
    /// screen with the Mac's sound and the microphone, the camera as it saw you, every frame's gaze, the eyes'
    /// pixels, everything shown and every message from the lip reader. Kept on this Mac.
    func startSessionRecording() {
        guard recordsSessions, sessionFolder == nil else { return }
        let state = ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Hive"
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let folder = URL(fileURLWithPath: state + "/lipgaze/sessions/" + format.string(from: Date()), isDirectory: true)
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) } catch {
            FileHandle.standardError.write(Data("hive-eye-keyboard: can't record the session: \(error)\n".utf8))
            return
        }
        sessionFolder = folder
        let events = folder.appendingPathComponent("events.jsonl").path
        for path in [events, events + ".eyes.jsonl", events + ".eyes.bin"] { FileManager.default.createFile(atPath: path, contents: nil) }
        dump = FileHandle(forWritingAtPath: events)
        if let rows = FileHandle(forWritingAtPath: events + ".eyes.jsonl"), let pixels = FileHandle(forWritingAtPath: events + ".eyes.bin") {
            camera.queue.async { self.camera.eyeDump = (rows, pixels, 0) }
        }
        lips?.copyLog(to: folder.appendingPathComponent("lipreader.log"))
        let corners = [(0.0, 0.0), (10.0, 0.0), (0.0, KeyboardView.rows)].map { k -> [Double] in
            let p = view.point(k)
            return [Double(p.x), Double(p.y)]
        }
        note(["event": "session", "folder": folder.path, "arguments": CommandLine.arguments,
              "screen": [Double(view.bounds.width), Double(view.bounds.height)],
              "keys_on_screen": ["(0,0)": corners[0], "(10,0)": corners[1], "(0,rows)": corners[2],
                                 "note": "screen points from the top left; key units: x across, y down rows"],
              "keys_end": Self.keysEnd, "look_up_finishes": lookUpFinishes,
              "calibration": calibration.map { ["spread": [$0.spread.x, $0.spread.y]] } ?? [:],
              "shift": [shift.x, shift.y]])
        // The movies take about 100 MB a minute: below 5 GB free they're left out (the rest is still kept).
        let free = (try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage ?? Int64.max
        if free < 5_000_000_000 {
            note(["event": "movies_skipped", "why": "less than 5 GB free on the disk", "free_bytes": free])
            FileHandle.standardError.write(Data("hive-eye-keyboard: under 5 GB free, so no screen or camera movie this time\n".utf8))
            return
        }
        camera.onVideoStart = { [weak self] t, w, h in
            DispatchQueue.main.async { self?.note(["event": "camera_started", "ft": t, "width": w, "height": h]) }
        }
        camera.record(to: folder.appendingPathComponent("camera.mov"))
        let screen = ScreenRecorder(url: folder.appendingPathComponent("screen.mov")) { [weak self] m in
            DispatchQueue.main.async { self?.note(m) }
        }
        screenRecorder = screen
        screen.start()
        FileHandle.standardError.write(Data("hive-eye-keyboard: recording this session in \(folder.path)\n".utf8))
    }

    func stopSessionRecording() {
        guard sessionFolder != nil else { return }
        note(["event": "session_end"])
        camera.record(to: nil)
        screenRecorder?.stop()
        screenRecorder = nil
        camera.queue.async {
            if let d = self.camera.eyeDump { try? d.rows.close(); try? d.pixels.close() }
            self.camera.eyeDump = nil
        }
        lips?.copyLog(to: nil)
        // The screen recorder's last events (its movie written) still come in a moment: the file stays open
        // until the next session opens its own.
        sessionFolder = nil
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
            if lipsMode { startLips() }
            startSessionRecording()
            if calibration == nil { tries = 0; startSetup() } else { say(hint()); showPrompt() }
        } else {
            if typing { finishPhrase() }
            if lipsMode {                                          // the sentence being said, if any, still comes
                lipsListening = false
                lips?.send(["on": false])
            }
            stopSessionRecording()
            camera.stop()
            panel.orderOut(nil)
            stopSetup()
            saveCalibration()
        }
    }

    // MARK: Setup

    static func along(_ t: Double, _ route: Route = route) -> (pos: (Double, Double), leg: Int, into: Double)? {
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
        holdFrames = Array(repeating: [], count: Self.holds.count)
        fitted = nil
        view.move(to: nil)
        view.words.text = ""
        say("Setup, about 3 minutes: follow the yellow dot with your eyes.")
        let now = ProcessInfo.processInfo.systemUptime
        setupBegan = now + 0.8                 // a moment to find the dot before it moves
        stepBegan = now
        record(["follow_began": setupBegan, "route": "slow"])
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
                startHold(0, now)
            }
        case .hold(let i):
            guard now - stepBegan > Self.holds[i].seconds else { return }
            if i + 1 < Self.holds.count { startHold(i + 1, now) } else { finishSetup() }
        case nil:
            break
        }
    }

    func startHold(_ i: Int, _ now: Double) {
        setup = .hold(i)
        stepBegan = now
        view.show(target: Self.holds[i].dot)
        let left = Int(Self.holds[i...].map { $0.seconds }.reduce(0, +).rounded())
        let h = Self.holds[i]
        let what = h.kind == .head ? "Keep your eyes on the dot and slowly move your head a little: left, right, up, down."
            : h.pass == 1 ? "Look at each dot until it jumps." : "Once more: look at each dot until it jumps."
        say(what + String(format: "  (%d:%02d left)", left / 60, left % 60))
    }

    /// The moving dot's frames to a calibration: the eyes trail the dot a little (and the camera adds its
    /// own delay), so try a few delays and keep the one that fits best.
    static func fitFollow(_ frames: [(f: [Double], t: Double)], began: Double, route: Route = route) -> (GazeCalibration, [[Double]], [(Double, Double)], [Int])? {
        var best: (GazeCalibration, [[Double]], [(Double, Double)], [Int], Double)? = nil
        for lag in [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5] {
            var rows: [[Double]] = [], targets: [(Double, Double)] = [], groups: [Int] = []
            for (f, t) in frames {
                guard let a = along(t - began - lag, route) else { continue }
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

    /// The setup's map: the moving dot plus every held dot. How far off it is: the second round of keys
    /// (pass 2) on a map fitted without it, or for recordings with no second round, each dot left out in turn.
    /// `offs` are the dots' median misses in key widths; `sigma` the frames' spread, for the decoder.
    static func fitSetup(_ f: (GazeCalibration, [[Double]], [(Double, Double)], [Int]),
                         _ held: [(dot: (Double, Double), pass: Int, frames: [[Double]])])
        -> (cal: GazeCalibration, offs: [Double], sigma: (Double, Double), rows: [[Double]], targets: [(Double, Double)], groups: [Int])? {
        let held = held.filter { $0.frames.count >= 5 }
        func data(_ use: [Int]) -> ([[Double]], [(Double, Double)], [Int]) {
            var rows = f.1, targets = f.2, groups = f.3
            for i in use { for r in held[i].frames { rows.append(r); targets.append(held[i].dot); groups.append(100 + i) } }
            return (rows, targets, groups)
        }
        func fit(_ use: [Int]) -> GazeCalibration? {
            let d = data(use)
            return GazeCalibration.fit(rows: d.0, targets: d.1, groups: d.2, lambda: lambda, leaveOut: false, scales: headScales)
        }
        let checks = held.indices.filter { held[$0].pass == 2 }
        let tests: [(GazeCalibration?, [Int])] = checks.isEmpty
            ? held.indices.map { k in (fit(held.indices.filter { $0 != k }), [k]) }
            : [(fit(held.indices.filter { held[$0].pass != 2 }), checks)]
        var offs: [Double] = [], ex = 0.0, ey = 0.0, n = 0.0
        for (cal, dots) in tests {
            guard let cal else { continue }
            for k in dots {
                let p = held[k].frames.map { cal.map($0) }, d = held[k].dot
                offs.append(hypot(p.map { $0.0 }.sorted()[p.count / 2] - d.0, p.map { $0.1 }.sorted()[p.count / 2] - d.1))
                for q in p { ex += (q.0 - d.0) * (q.0 - d.0); ey += (q.1 - d.1) * (q.1 - d.1); n += 1 }
            }
        }
        let all = Array(held.indices)
        guard let cal = fit(all) else { return nil }
        let d = data(all)
        return (cal, offs, n > 0 ? ((ex / n).squareRoot(), (ey / n).squareRoot()) : (0.6, 0.6), d.0, d.1, d.2)
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
        say("Working out the map…")
        let held = Self.holds.indices.map { (dot: Self.holds[$0].dot, pass: Self.holds[$0].pass, frames: holdFrames[$0]) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in        // ~0.1 s: off the main thread
            let s = Self.fitSetup((f.cal, f.rows, f.targets, f.groups), held)
            DispatchQueue.main.async { self?.setupFitted(s, f.cal) }
        }
    }

    func setupFitted(_ s: (cal: GazeCalibration, offs: [Double], sigma: (Double, Double), rows: [[Double]], targets: [(Double, Double)], groups: [Int])?,
                     _ follow: GazeCalibration) {
        guard on, setup == nil else { return }                                  // closed (or restarted) meanwhile
        guard let s else { retrySetup("It couldn't see your eyes. Face the camera with light on your face."); return }
        let off = s.offs.isEmpty ? 9 : s.offs.sorted()[s.offs.count / 2]
        emit(["check": ["keys_off": off, "dots": s.offs.map { ($0 * 100).rounded() / 100 },
                        "follow_fit": ["x": follow.spread.x, "y": follow.spread.y], "eye_light": camera.eyeLight,
                        "face_size": camera.faceSize, "frames": followFrames.count, "held_frames": holdFrames.map { $0.count }.reduce(0, +)]])
        // What the dots show is already in the map (it learned every dot); `off` is what's left on dots it
        // hadn't seen. Typing then re-centres it word by word. Only a setup that's far off is done again.
        if off > 2.5 {
            var why = "Look right at each dot."
            if camera.eyeLight < 60 { why = "More light on your face would help (a lamp in front of you)." }
            else if camera.faceSize < 0.07 { why = "Sit a little closer to the camera." }
            say(String(format: "That came out %.1f keys off — too far to type. %@ Press Esc, then double-tap right ⌘ to do the setup again.", off, why))
            return
        }
        setupRows = s.rows; setupTargets = s.targets; setupGroups = s.groups
        learned = []; toLearn = []; shift = (0, 0)
        use(s.cal, sigma: s.sigma)
        saveCalibration()
        say(String(format: "Accuracy: about %.1f keys off on dots it hadn't learned. Saved: no setup next time. ", off) + hint())
        showPrompt()
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

    // MARK: Saved setup

    // The setup is done once and kept (owner, 2026-11-19: "do not make me calibrate the eye tracking typing
    // again"): the map, the decoder's spread, the setup's frames (so typed words keep tuning it on top of them)
    // and the drift correction, as numbers (no pictures), readable only by you. --new-setup does it again.
    static let calibrationFile = option("--calibration")
        ?? (ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Hive")
            + "/eye-calibration.json"

    func calibrationJSON() -> Data? {
        guard let cal = calibration else { return nil }
        let object: [String: Any] = [
            "saved": ISO8601DateFormatter().string(from: Date()),
            "map": ["mean": cal.mean, "scale": cal.scale, "wx": cal.wx, "wy": cal.wy, "spread": [cal.spread.x, cal.spread.y]],
            "sigma": [decoder.settings.sigma, decoder.settings.sigmaY],
            "shift": [shift.x, shift.y],
            "setup": ["rows": setupRows, "targets": setupTargets.map { [$0.0, $0.1] }, "groups": setupGroups],
            "learned": learned.map { ["f": $0.0, "at": [$0.1.0, $0.1.1]] as [String: Any] },
        ]
        return try? JSONSerialization.data(withJSONObject: object)
    }

    /// Writes the setup to `calibrationFile` (off the main thread; a few hundred kB).
    func saveCalibration() {
        guard !replaying, let data = calibrationJSON() else { return }
        let path = Self.calibrationFile
        DispatchQueue.global(qos: .utility).async {
            do {
                try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                        withIntermediateDirectories: true)
                try data.write(to: URL(fileURLWithPath: path), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            } catch {
                FileHandle.standardError.write(Data("hive-eye-keyboard: couldn't save the setup to \(path): \(error)\n".utf8))
            }
        }
    }

    /// Takes up a saved setup; false if there's none (or it can't be read).
    func loadCalibration(_ data: Data) -> Bool {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let m = o["map"] as? [String: Any], let mean = m["mean"] as? [Double], let scale = m["scale"] as? [Double],
              let wx = m["wx"] as? [Double], let wy = m["wy"] as? [Double], let spread = m["spread"] as? [Double],
              !mean.isEmpty, scale.count == mean.count, wx.count == mean.count + 1, wy.count == mean.count + 1,
              spread.count == 2 else { return false }
        if let setup = o["setup"] as? [String: Any], let rows = setup["rows"] as? [[Double]],
           let targets = setup["targets"] as? [[Double]], let groups = setup["groups"] as? [Int],
           rows.count == targets.count, rows.count == groups.count, targets.allSatisfy({ $0.count == 2 }),
           rows.allSatisfy({ $0.count == mean.count }) {
            setupRows = rows; setupTargets = targets.map { ($0[0], $0[1]) }; setupGroups = groups
        }
        learned = (o["learned"] as? [[String: Any]] ?? []).compactMap { w in
            guard let f = w["f"] as? [Double], let at = w["at"] as? [Double], f.count == mean.count, at.count == 2 else { return nil }
            return (f, (at[0], at[1]))
        }
        if let s = o["shift"] as? [Double], s.count == 2 { shift = (s[0], s[1]) }
        let sigma = (o["sigma"] as? [Double]).flatMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
        use(GazeCalibration(mean: mean, scale: scale, wx: wx, wy: wy, spread: (spread[0], spread[1])), sigma: sigma)
        return true
    }

    /// --check-calibration: reads the saved setup, writes it out and reads it back the same, and says what's in it.
    static func checkCalibration(_ keyboard: EyeKeyboard) -> Bool {
        guard let data = FileManager.default.contents(atPath: calibrationFile), keyboard.loadCalibration(data),
              let first = keyboard.calibration, let again = keyboard.calibrationJSON() else {
            emit(["calibration": ["path": calibrationFile, "usable": false]])
            return false
        }
        let rows = keyboard.setupRows.count, sigma = (keyboard.decoder.settings.sigma, keyboard.decoder.settings.sigmaY)
        let probe = keyboard.setupRows.first ?? first.mean
        let same = keyboard.loadCalibration(again) && keyboard.calibration.map {
            hypot($0.map(probe).0 - first.map(probe).0, $0.map(probe).1 - first.map(probe).1) < 1e-9 } == true
            && keyboard.setupRows.count == rows && keyboard.decoder.settings.sigma == sigma.0
        let saved = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["saved"] ?? ""
        emit(["calibration": ["path": calibrationFile, "usable": same, "saved": saved, "features": first.mean.count,
                              "setup_frames": rows, "learned_frames": keyboard.learned.count,
                              "spread": [first.spread.x, first.spread.y], "shift": [keyboard.shift.x, keyboard.shift.y]]])
        return same
    }

    // MARK: Looking

    func look(_ l: Look) {
        guard on else { return }
        lipsListening = lipsMode && setup == nil && calibration != nil
        switch l {
        case .gaze(let f):
            closedFrames = 0; closedAt = nil
            gaze(f)
        case .closed(let t):                                   // eyes shut: a normal blink ends the word
            record(["t": t, "phase": "closed"])
            if lipsMode { break }                                  // lip reading: blinks are just blinks
            if closedAt == nil { closedAt = t }
            closedFrames += 1
            if closedFrames == blinkFrames, typing, setup == nil { endWord(closedAt: closedAt) }
        case .away(let t):
            closedFrames = 0; closedAt = nil
            record(["t": t + (clock ?? 0), "ft": t, "phase": "away"])
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
        case .hold(let i):
            let h = Self.holds[i]
            if now - stepBegan > Self.checkSettle { holdFrames[i].append(f.values) }
            record(["t": seen, "ft": f.time, "phase": "check", "dot": [h.dot.0, h.dot.1], "pass": h.pass, "hold": i, "f": f.values])
            return
        case nil:
            break
        }
        guard let cal = calibration else { return }
        guard cal.mean.count == f.values.count else {                  // saved by a build that read the eyes differently
            calibration = nil; tries = 0; startSetup(); return
        }
        let (x, y) = cal.map(f.values)
        if !lipsMode { record(["t": seen, "ft": f.time, "phase": "type", "f": f.values, "at": [x, y]]) }
        mapped(x, y, f)
    }

    /// A gaze point on the keyboard (key units): the pointer, and the word being looked at.
    func mapped(_ x: Double, _ y: Double, _ f: GazeFeatures) {
        let x = x + shift.x, y = y + shift.y
        if lipsMode {                                               // the lip reader does the words: it gets the gaze
            let shown = hold(x, y, f.time)
            view.move(to: shown)
            record(["t": f.time + (clock ?? 0), "ft": f.time, "phase": "lips", "f": f.values, "at": [x, y],
                    "dot": [shown.0, shown.1], "shift": [shift.x, shift.y]])
            aboveSince = y < Self.lipsLookUp ? (aboveSince ?? f.time) : nil
            guard onKeyboard(x, y) else { off(f.time); return }
            offSince = nil
            lipsEnded = false
            if y < Self.keysEnd {                                       // below the keys is reading the line
                lips?.send(["gaze": [f.time, x, y]])
                sentenceGaze.append((f.time, f.values, x, y))
                if sentenceGaze.count > 2700 { sentenceGaze.removeFirst(sentenceGaze.count - 2700) }
            }
            return
        }
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
            if test, testAt < testSentences.count { record(["phrase_began": f.time, "sentence": testSentences[testAt]]) }
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

    func startLips() {
        guard lips == nil else { return }
        let reader = LipReader()
        if let why = reader.missing { lipsProblem = why; return }
        reader.onMessage = { [weak self] m in self?.heard(m) }
        do {
            try reader.start()
            lips = reader
            lipsProblem = nil
            lipsReady = false
        } catch {
            lipsProblem = "The lip reader didn't start: \(error.localizedDescription)"
        }
    }

    /// A message from the lip reader (on the main thread).
    func heard(_ m: [String: Any]) {
        note(["event": "lips", "message": m])
        let showing = on && setup == nil
        if m["gone"] != nil {
            lips = nil
            lipsReady = false
            lipsProblem = "The lip reader stopped (its log is on stderr). Esc and open again to restart it."
        }
        if let e = m["error"] as? String { lipsProblem = e }
        if let status = m["status"] as? String, showing { say(status) }
        if m["ready"] != nil { lipsReady = true }
        if m["listening"] != nil { lipsHeard = true; NSSound(named: "Tink")?.play() }
        if let p = m["prompt"] as? String {
            lipsHeard = false
            lipsPrompt = p
            lipsNumber = m["number"] as? Int ?? lipsNumber + 1
            showPrompt()
        }
        if m["take"] != nil { NSSound(named: "Pop")?.play() }      // heard; what it read is in the log, not on screen
        // Learn the map from the sentence's gaze: in practice from the sentence shown, else from what was typed,
        // but only if the gaze backs it (see typedFits: typed text is often wrong while the lips are).
        if let from = m["from"] as? Double, let to = m["to"] as? Double,
           let words = (m["take"] != nil ? m["meant"] : m["text"]) as? String, !words.isEmpty {
            learnSentence(words, from: from, to: to, typed: m["take"] == nil)
        }
        if let text = m["text"] as? String {
            emit(["typed": text, "ms": m["ms"] ?? 0, "seconds": m["seconds"] ?? 0, "gaze_points": m["gaze_points"] ?? 0])
            if !text.isEmpty {
                NSSound(named: "Pop")?.play()
                for word in text.split(separator: " ") { typer.put(String(word), live: true) }
                typer.put(".", live: true)                          // the mouth stopped: the sentence ends
                view.words.text = text
            }
        }
        if showing, m["status"] == nil, m["text"] == nil { say(hint()) }
    }

    /// Practice (--lips-record): the one sentence to say, in the big line above the keys. Nothing else goes
    /// there in practice (owner, 2026-11-19: a read-back there looked like a second sentence to say).
    func showPrompt() {
        guard lipsMode, let p = lipsPrompt, on, setup == nil else { return }
        if view.words.text != p { note(["event": "prompt", "text": p, "number": lipsNumber]) }
        view.words.text = p
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
        // Lips: looking up over the top of the screen ends the sentence (not the mouth stopping: speaking
        // slowly while swiping leaves it still between words), or the eyes off the keys for a while. Just
        // off the top isn't enough: in the owner's session, 2026-11-19, four of five sentences ended early
        // there while they looked at top-row keys with the map drifted (the dot 1.6 to 1.9 rows up, the
        // screen's top 1.3 rows up), against 6 to 8.5 rows for the one real look up. Once per look away.
        let lookedUp = aboveSince.map { t - $0 > lookUpFinishes } ?? false
        if lipsMode, lipsListening, !lipsEnded, lookedUp || t - offSince! > Self.lipsAwayFinishes {
            lipsEnded = true
            lips?.send(["end": t])
            note(["event": "end_sent", "ft": t, "off_since": offSince!])
        }
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
        if learned.count > Self.learnedMost { learned.removeFirst(learned.count - Self.learnedMost) }
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
        refit()
    }

    /// Lips: the gaze of a sentence whose words are now known, lined up with its keys (SentenceAlign, the
    /// whole path's drift found too); the frames held on a key join `learned` and the map is fitted again,
    /// so it follows the head as it moves (owner, 2026-11-19: telling people not to move their heads isn't
    /// acceptable). Only when most of the gaze lines up: a sentence read wrong mustn't teach it.
    func learnSentence(_ text: String, from: Double, to: Double, typed: Bool = false) {
        let frames = sentenceGaze.filter { $0.t >= from - 0.3 && $0.t <= to + 0.3 }
        sentenceGaze.removeAll { $0.t <= to }
        guard frames.count >= 20, !replaying, setup == nil else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let margin = typed ? Self.typedFits(text, frames) : nil
            let (add, a) = typed && !(margin.map { $0 >= Self.typedMargin } ?? false) ? ([], nil) : Self.sentenceRows(text, frames)
            DispatchQueue.main.async {
                guard let self else { return }
                self.note(["event": "learn_sentence", "text": text, "typed": typed, "margin": margin ?? -1e9,
                           "frames": frames.count, "kept": add.count,
                           "on_keys": a?.onKeys ?? 0, "reached": a?.reached ?? 0, "drift": a.map { [$0.shift.x, $0.shift.y] } ?? []])
                guard add.count >= 10 else { return }
                self.learned += add
                if self.learned.count > Self.learnedMost { self.learned.removeFirst(self.learned.count - Self.learnedMost) }
                self.refit()
            }
        }
    }

    typealias GazeFrame = (t: Double, f: [Double], x: Double, y: Double)

    /// How much better the gaze follows the typed text's keys than the best of 20 sentences about as long (the
    /// practice sentences): nil if it can't be lined up. Typed text teaches the map only at typedMargin or more.
    /// Replaying the owner's session, 2026-11-19 (17 sentences, both the setup's map and the corrected one):
    /// the sentence meant came out 10 or more ahead 5-6 times, the next sentence's words (standing in for
    /// wrong typed text) never (the best of 33 was +0.2); learning from every wrong sentence instead made the
    /// map worse (1.99 keys off -> 1.13, against 0.97 from the right ones).
    static func typedFits(_ text: String, _ frames: [GazeFrame]) -> Double? {
        let xy = frames.map { (x: $0.x, y: $0.y) }
        guard let mine = SentenceAlign.score(text, xy), let n = SentenceAlign.path(text)?.count else { return nil }
        let own = text.lowercased().split(separator: " ").joined(separator: " ")
        let others = decoys.filter { $0.text != own }.sorted { (abs($0.keys - n), $0.text) < (abs($1.keys - n), $1.text) }
        let best = others.prefix(20).compactMap { SentenceAlign.score($0.text, xy) }.max()
        return best.map { mine - $0 }
    }

    static let typedMargin = 10.0

    /// The practice sentences (scripts/lipgaze_prompts.txt), with how many keys each sweeps.
    static let decoys: [(text: String, keys: Int)] = {
        let here = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        let path = option("--lips-script").map { URL(fileURLWithPath: $0).deletingLastPathComponent()
            .appendingPathComponent("lipgaze_prompts.txt").path }
            ?? here.appendingPathComponent("../scripts/lipgaze_prompts.txt").standardizedFileURL.path
        let lines = ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").split(separator: "\n")
        return lines.compactMap { line in
            let text = line.lowercased().split(separator: " ").joined(separator: " ")
            return SentenceAlign.path(text).map { (text, $0.count) }
        }
    }()

    /// A known sentence's frames held on one of its keys (three frames in a row, within 1.8 keys once the
    /// path's drift is taken off), each with that key's centre; none unless 60% of the gaze lines up and it
    /// gets through 85% of the sentence's keys (a take cut short, shown the whole sentence, would teach it
    /// wrong: the owner's first take, 2026-11-19, moved the map 1.75 keys the wrong way).
    static func sentenceRows(_ text: String, _ frames: [GazeFrame])
        -> ([([Double], (Double, Double))], (keys: [Int], shift: (x: Double, y: Double), onKeys: Double, reached: Double)?) {
        let a = SentenceAlign.align(text, frames.map { ($0.x, $0.y) })
        var add: [([Double], (Double, Double))] = []
        if let a, a.onKeys >= 0.6, a.reached >= 0.85 {
            for i in 1..<(frames.count - 1) where a.keys[i] >= 0 && a.keys[i - 1] == a.keys[i] && a.keys[i] == a.keys[i + 1] {
                let c = EyeLayout.centers[a.keys[i]]
                if hypot(frames[i].x - a.shift.x - c.x, frames[i].y - a.shift.y - c.y) < 1.8 { add.append((frames[i].f, (c.x, c.y))) }
            }
        }
        return (add, a)
    }

    /// The map fitted on the setup plus the learned frames, and the shift that's left: the median of what it
    /// still misses on the latest 150 learned (the head may have moved since the older ones).
    static func refitted(_ setup: (rows: [[Double]], targets: [(Double, Double)], groups: [Int]),
                         _ learned: [([Double], (Double, Double))]) -> (cal: GazeCalibration, shift: (x: Double, y: Double))? {
        let rows = setup.rows + learned.map { $0.0 }, targets = setup.targets + learned.map { $0.1 }
        let groups = setup.groups + learned.map { _ in -1 }
        guard let cal = GazeCalibration.fit(rows: rows, targets: targets, groups: groups, lambda: lambda,
                                            leaveOut: false, scales: headScales) else { return nil }
        let last = learned.suffix(150)
        guard last.count >= 10 else { return (cal, (0, 0)) }
        let dx = last.map { $0.1.0 - cal.map($0.0).0 }.sorted(), dy = last.map { $0.1.1 - cal.map($0.0).1 }.sorted()
        // Little learned yet: trust it less (one sentence read wrong mustn't throw the map off).
        let w = min(1, Double(learned.count) / 300)
        return (cal, (w * dx[dx.count / 2], w * dy[dy.count / 2]))
    }

    /// The map fitted again on the setup plus what typing taught it (refitted), off the main thread.
    func refit() {
        if !learned.isEmpty && !replaying {
            let setup = (setupRows, setupTargets, setupGroups), learned = self.learned
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let (cal, shift) = Self.refitted(setup, learned) else { return }
                DispatchQueue.main.async {
                    guard let self, self.setup == nil else { return }
                    self.use(cal)
                    self.shift = shift
                    self.note(["event": "refit", "learned": self.learned.count, "shift": [self.shift.x, self.shift.y]])
                    self.saveCalibration()
                }
            }
        }
    }

    /// --learn-replay SESSION: a recorded practice session (sessions/<date time>/) through the learning above, one
    /// sentence at a time, as it would have gone: each sentence's gaze mapped by the map as it stood then, how
    /// far that sat from the keys it lined up with, then learned. Against the saved setup's map alone. Saves
    /// nothing (start it with --calibration pointing at a copy taken before the session to replay it fairly).
    func learnReplay(_ folder: String) {
        func lines(_ name: String) -> [[String: Any]] {
            ((try? String(contentsOfFile: folder + "/" + name, encoding: .utf8)) ?? "").split(separator: "\n")
                .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        }
        let rows: [(t: Double, f: [Double])] = lines("events.jsonl").compactMap { r in
            guard r["phase"] as? String == "lips", let t = r["ft"] as? Double, let f = r["f"] as? [Double] else { return nil }
            return (t, f)
        }
        let cuts: [(meant: String, from: Double, to: Double)] = lines("lipreader.log").compactMap { c in
            guard c["cut"] != nil, let m = c["meant"] as? String, let a = c["from"] as? Double, let b = c["to"] as? Double else { return nil }
            return (m, a, b)
        }
        guard let first = calibration else { print("no saved setup to start from"); return }
        let setup = (setupRows, setupTargets, setupGroups)
        var cal = first, shift = self.shift, learned = self.learned
        func median(_ v: [Double]) -> Double { v.isEmpty ? .nan : v.sorted()[v.count / 2] }
        // How far a sentence's gaze, as `map` put it, sat from the keys it lined up with (drift not taken off).
        func miss(_ text: String, _ frames: [GazeFrame]) -> Double? {
            guard let a = SentenceAlign.align(text, frames.map { ($0.x, $0.y) }) else { return nil }
            let d = frames.indices.filter { a.keys[$0] >= 0 }.map { i -> Double in
                let c = EyeLayout.centers[a.keys[i]]; return hypot(frames[i].x - c.x, frames[i].y - c.y) }
            return median(d)
        }
        var before: [Double] = [], after: [Double] = []
        // HIVE_REPLAY_GAZE=<file>: each sentence's gaze both ways, as JSON lines, to try decoders on.
        let dump = ProcessInfo.processInfo.environment["HIVE_REPLAY_GAZE"].map { path -> FileHandle? in
            FileManager.default.createFile(atPath: path, contents: nil); return FileHandle(forWritingAtPath: path) } ?? nil
        defer { try? dump?.close() }
        for cut in cuts {
            let mine = rows.filter { $0.t >= cut.from - 0.3 && $0.t <= cut.to + 0.3 }
            func frames(_ c: GazeCalibration, _ s: (x: Double, y: Double)) -> [GazeFrame] {
                mine.compactMap { r in
                    let (x, y) = c.map(r.f)
                    let p = (x + s.x, y + s.y)
                    return onKeyboard(p.0, p.1) && p.1 < Self.keysEnd ? (r.t, r.f, p.0, p.1) : nil
                }
            }
            let old = frames(first, self.shift), now = frames(cal, shift)
            guard now.count >= 20, let m0 = miss(cut.meant, old), let m1 = miss(cut.meant, now) else { continue }
            if let dump = dump, let line = try? JSONSerialization.data(withJSONObject: [
                "meant": cut.meant, "from": cut.from, "to": cut.to,
                "old": old.map { [$0.t, $0.x, $0.y] }, "now": now.map { [$0.t, $0.x, $0.y] }]) {
                dump.write(line); dump.write(Data("\n".utf8))
            }
            before.append(m0); after.append(m1)
            // HIVE_REPLAY_WRONG=1: learn from the next sentence's words instead (typed text that came out wrong).
            let wrong = ProcessInfo.processInfo.environment["HIVE_REPLAY_WRONG"] != nil
            let text = wrong ? cuts[(cuts.firstIndex { $0.from == cut.from }! + 1) % cuts.count].meant : cut.meant
            // HIVE_REPLAY_TYPED=1: as typed text (real use), learnt only if the gaze backs it (typedFits).
            let typed = ProcessInfo.processInfo.environment["HIVE_REPLAY_TYPED"] != nil
            let margin = typed ? Self.typedFits(text, now) : nil
            let (add, a) = typed && !(margin.map { $0 >= Self.typedMargin } ?? false) ? ([], nil) : Self.sentenceRows(text, now)
            print(String(format: "%-40@ setup map %.2f keys off, learning %.2f; drift left (%+.2f, %+.2f), on keys %.0f%%, reached %.0f%%, learned %d%@",
                         String(cut.meant.prefix(40)) as NSString, m0, m1, a?.shift.x ?? .nan, a?.shift.y ?? .nan,
                         100 * (a?.onKeys ?? 0), 100 * (a?.reached ?? 0), add.count,
                         (margin.map { String(format: ", margin %+.1f", $0) } ?? "") as NSString))
            guard add.count >= 10 else { continue }
            learned += add
            if learned.count > Self.learnedMost { learned.removeFirst(learned.count - Self.learnedMost) }
            if let r = Self.refitted(setup, learned) { cal = r.cal; shift = r.shift }
        }
        print(String(format: "%d sentences: setup map alone %.2f keys off (median), learning from each sentence %.2f; last 6: %.2f vs %.2f",
                     before.count, median(before), median(after), median(Array(before.suffix(6))), median(Array(after.suffix(6)))))
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
        typealias Hold = (key: String, dot: (Double, Double), pass: Int, frames: [(f: [Double], t: Double)])
        var runs: [(began: Double, route: Route, follow: [(f: [Double], t: Double)], holds: [Hold])] = []
        for line in lines {
            guard let e = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if let b = e["follow_began"] as? Double { runs.append((b, e["route"] == nil ? fastRoute : route, [], [])); continue }
            guard !runs.isEmpty, let f = e["f"] as? [Double], let t = e["t"] as? Double else { continue }
            let r = runs.count - 1
            if e["phase"] as? String == "follow" { runs[r].follow.append((f, t)) }
            if e["phase"] as? String == "check", let d = e["dot"] as? [Double] {
                let key = (e["hold"] as? Int).map { "h\($0)" } ?? "d\(d)"         // older recordings: one hold per dot
                if let j = runs[r].holds.firstIndex(where: { $0.key == key }) { runs[r].holds[j].frames.append((f, t)) }
                else { runs[r].holds.append((key, (d[0], d[1]), e["pass"] as? Int ?? 1, [(f, t)])) }
            }
        }
        // the eyes take 0.6-0.9 s to get to a dot; older recordings held each dot only 1.2 s
        func settled(_ frames: [(f: [Double], t: Double)]) -> [[Double]] {
            let settle = frames.last!.t - frames[0].t > 1.6 ? checkSettle : 0.5
            return frames.filter { $0.t - frames[0].t > settle }.map { $0.f }
        }
        func off(_ cal: GazeCalibration, _ frames: [[Double]], _ dot: (Double, Double)) -> Double {
            let p = frames.map { cal.map($0) }
            return (hypot(p.map { $0.0 }.sorted()[p.count / 2] - dot.0, p.map { $0.1 }.sorted()[p.count / 2] - dot.1) * 100).rounded() / 100
        }
        func median(_ v: [Double]) -> Double { v.isEmpty ? 9 : v.sorted()[v.count / 2] }
        var finals: [GazeCalibration?] = []
        for (k, run) in runs.enumerated() {
            guard !run.holds.isEmpty, let f = fitFollow(run.follow, began: run.began, route: run.route),
                  let s = fitSetup(f, run.holds.map { ($0.dot, $0.pass, settled($0.frames)) }) else { finals.append(nil); continue }
            finals.append(s.cal)
            let checked = run.holds.filter { $0.pass == 2 }.isEmpty ? run.holds : run.holds.filter { $0.pass == 2 }
            let before = checked.compactMap { h -> Double? in let s = settled(h.frames); return s.count >= 5 ? off(f.0, s, h.dot) : nil }
            emit(["setup": k, "dots": s.offs.count, "keys_off": (median(s.offs) * 100).rounded() / 100,
                  "moving_dot_only_keys_off": median(before), "own_dots": s.offs.map { ($0 * 100).rounded() / 100 },
                  "follow_fit": [(f.0.spread.x * 100).rounded() / 100, (f.0.spread.y * 100).rounded() / 100]])
        }
        for (a, cal) in finals.enumerated() {
            guard let cal else { continue }
            for (b, run) in runs.enumerated() where b != a {
                let offs = run.holds.compactMap { h -> Double? in let s = settled(h.frames); return s.count >= 5 ? off(cal, s, h.dot) : nil }
                if !offs.isEmpty { emit(["fit_on": a, "dots_of": b, "keys_off": median(offs), "dots": offs]) }
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
        record(["test_sentence": ["want": want.joined(separator: " "), "got": testGot.joined(separator: " "), "wrong": wrong]])
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
        if lipsMode { signal(SIGPIPE, SIG_IGN) }                        // the lip reader quitting mustn't take us down
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let keyboard = EyeKeyboard(decoder: EyeSwipeDecoder(lm: lm), test: CommandLine.arguments.contains("--test"))

        if let out = option("--snapshot") {                                   // draw it into a PNG and stop
            let view = KeyboardView(frame: NSRect(x: 0, y: 0, width: 1470, height: 956))
            keyboard.lipsReady = true
            let practice = lipsMode && option("--lips-record") != nil
            if practice { keyboard.lipsPrompt = "print two copies of this page"; keyboard.lipsNumber = 1 }
            view.status.text = keyboard.hint()
            if CommandLine.arguments.contains("--setup") {
                view.status.text = "Setup, about 3 minutes: follow the yellow dot with your eyes."
                view.show(target: (4.2, 1.5))
            } else {
                view.words.text = keyboard.lipsPrompt ?? "can you send me"
                view.move(to: lipsMode ? (5.6, 1.5) : (5.6, 3.55))
            }
            let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
            exit(0)
        }

        if let path = option("--replay") { keyboard.replay(path); exit(0) }
        if let path = option("--calib-test") { EyeKeyboard.calibTest(path); exit(0) }
        if CommandLine.arguments.contains("--check-calibration") { exit(EyeKeyboard.checkCalibration(keyboard) ? 0 : 1) }
        if !CommandLine.arguments.contains("--new-setup"), let data = FileManager.default.contents(atPath: EyeKeyboard.calibrationFile) {
            if keyboard.loadCalibration(data) {
                FileHandle.standardError.write(Data("hive-eye-keyboard: using the saved setup (\(EyeKeyboard.calibrationFile))\n".utf8))
            } else {
                FileHandle.standardError.write(Data("hive-eye-keyboard: can't read the saved setup at \(EyeKeyboard.calibrationFile)\n".utf8))
            }
        }
        if let folder = option("--learn-replay") { keyboard.learnReplay(folder); exit(0) }
        keyboard.setUpWindow()
        // The lip reader loads now, not when the keyboard first opens: loading it on the GPU then stopped the
        // camera for 12.8 s of the owner's first sentence (2026-11-19, 01:05:15.8-01:05:28.6).
        if lipsMode { keyboard.startLips() }
        if let seconds = option("--session-test").flatMap(Double.init) {
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async {
                    keyboard.toggle()
                    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                        keyboard.toggle()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { keyboard.lips?.process.terminate(); exit(0) }
                    }
                }
            }
            app.run()
        }
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
