import AppIntents
import ARKit
import UIKit

/*
 * Eye typing on the phone: a big keyboard fills the screen (sideways) and the front camera follows where you
 * look. Look at each letter of a word, then blink normally: the word is typed. Look away and nothing is typed.
 * The first time, you look at a few dots so it learns your eyes; every word you keep tunes it a bit more.
 * The words are decoded on the phone by EyeSwipe.swift (shared with the Mac keyboard,
 * desktop/app/tools/eyeswipe) with its language model, eyeswipe-lm.bin. The buttons above are tapped:
 * the other guesses for the last word, delete it, "Send to Hive" (the same queue as "Ask Hive"), Copy.
 *
 * Opened from the app icon's quick action ("Eye typing", a long press on the icon) or the Shortcuts app
 * ("Eye type with Hive"). Nothing is recorded or sent while you type: each camera frame is dropped once
 * read, and only the words go anywhere, when you send them.
 */
final class EyeTypingViewController: UIViewController, ARSessionDelegate {
    private enum Seen { case gaze(GazeFeatures), closed(Double), away(Double) }
    static let blinkSeconds = 0.03, lookAwayResets = 0.7      // a normal blink: eyes shut for 2 frames (3 at 60 a second)
    static let howTo = "Look at each letter of a word, then blink to type it."

    private let session = ARSession()
    private var decoder: EyeSwipeDecoder?
    private let keyboard = EyeKeyboardView()
    private let textLabel = UILabel(), statusLabel = UILabel()
    private var alternativeButtons: [UIButton] = []
    private let tick = UIImpactFeedbackGenerator(style: .light)

    private var calibration: GazeCalibration?
    private var calibrating: (index: Int, began: TimeInterval, frames: [[GazeFeatures]])?
    private var dotFrames: [[GazeFeatures]] = []
    private var learned: [([Double], (Double, Double))] = []       // frames from kept words, and the key looked at
    private var pending: (word: String, samples: [GazeSample], features: [[Double]], restAt: (x: Double, y: Double)?)?
    private var hold = FixationHold()             // the pointer: still while the eyes rest
    private var recent: [(Double, Double)] = []
    private var word: [GazeSample] = [], wordFeatures: [[Double]] = []
    private var history: [(t: Double, x: Double, y: Double)] = []
    private var restAt: (x: Double, y: Double)?               // where the eyes closed at the last blink
    // Words are worked out one at a time off the main thread (no frame waits on them).
    private var queued: [(got: [GazeSample], features: [[Double]], restAt: (x: Double, y: Double)?)] = []
    private var busy = false
    private let work = DispatchQueue(label: "hive.eye-typing.decode", qos: .userInteractive)
    private var closedSince: Double?, blinkDone = false
    private var offSince: Double?, paused = false
    private var words: [String] = []              // as typed ("Hello", "world", ".")
    private var lastCandidates: [EyeSwipeDecoder.Candidate] = []

    /// Shows the eye keyboard over whatever the app is showing.
    @discardableResult
    static func present() -> Bool {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController
                ?? UIApplication.shared.windows.first?.rootViewController else { return false }
        var top = root
        while let shown = top.presentedViewController { top = shown }
        if top is EyeTypingViewController { return true }
        let screen = EyeTypingViewController()
        screen.modalPresentationStyle = .fullScreen
        top.present(screen, animated: true)
        return true
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0.06, alpha: 1)
        if let url = Bundle.main.url(forResource: "eyeswipe-lm", withExtension: "bin"), let lm = try? EyeLM(contentsOf: url) {
            decoder = EyeSwipeDecoder(lm: lm)
        }
        textLabel.font = .systemFont(ofSize: 22, weight: .medium)
        textLabel.textColor = .white
        textLabel.lineBreakMode = .byTruncatingHead
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textColor = UIColor(white: 1, alpha: 0.6)
        statusLabel.numberOfLines = 2
        let bar = UIStackView()
        bar.axis = .horizontal
        bar.spacing = 8
        for n in 0..<3 {
            let b = button("", #selector(alternative(_:)))
            b.tag = n
            b.setTitleColor(UIColor(red: 0.6, green: 0.8, blue: 1, alpha: 1), for: .normal)
            alternativeButtons.append(b)
            bar.addArrangedSubview(b)
        }
        bar.addArrangedSubview(UIView())
        for (title, action) in [("⌫", #selector(deleteWord)), ("Copy", #selector(copyText)), ("Send to Hive", #selector(send)),
                                ("Dots", #selector(recalibrate)), ("Done", #selector(close))] {
            bar.addArrangedSubview(button(title, action))
        }
        for v in [textLabel, statusLabel, bar, keyboard] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            textLabel.topAnchor.constraint(equalTo: g.topAnchor, constant: 6),
            textLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            textLabel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            bar.topAnchor.constraint(equalTo: textLabel.bottomAnchor, constant: 2),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            bar.heightAnchor.constraint(equalToConstant: 30),
            statusLabel.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 0),
            statusLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            keyboard.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 4),
            keyboard.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboard.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            keyboard.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        session.delegate = self
        refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard decoder != nil else { statusLabel.text = "The eye-typing word list is missing from this build."; return }
        guard ARFaceTrackingConfiguration.isSupported else { statusLabel.text = "This phone can't follow your eyes (it needs Face ID)."; return }
        let config = ARFaceTrackingConfiguration()
        config.isLightEstimationEnabled = false
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        if calibration == nil { startCalibration() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        learnFromLastWord()
        session.pause()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        if calibration != nil { coordinator.animate(alongsideTransition: nil) { _ in self.startCalibration() } }  // turned around
    }

    private func button(_ title: String, _ action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        b.setTitleColor(.white, for: .normal)
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    // MARK: Gaze

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let time = frame.timestamp
        let seen: Seen
        if let face = frame.anchors.compactMap({ $0 as? ARFaceAnchor }).first, face.isTracked {
            let l = face.blendShapes[.eyeBlinkLeft]?.doubleValue ?? 0, r = face.blendShapes[.eyeBlinkRight]?.doubleValue ?? 0
            if l + r > 1.1 {
                seen = .closed(time)
            } else if l + r > 0.9 {
                return                                  // lids on the way down or up: not a gaze sample
            } else if let f = features(face, frame.camera.transform) {
                seen = .gaze(GazeFeatures(values: f, time: time))
            } else {
                return
            }
        } else {
            seen = .away(time)
        }
        DispatchQueue.main.async { self.see(seen) }
    }

    /// Where each eye's line of sight and the look-at point cross the phone's face (in the camera's frame of
    /// reference, metres), where the head is, and which way it points.
    private func features(_ face: ARFaceAnchor, _ camera: simd_float4x4) -> [Double]? {
        let toCamera = camera.inverse * face.transform
        func hit(_ origin: simd_float4, _ direction: simd_float4) -> (Double, Double)? {
            let o = toCamera * origin, d = toCamera * direction
            guard abs(d.z) > 1e-4 else { return nil }
            let t = -o.z / d.z
            return (Double(o.x + t * d.x), Double(o.y + t * d.y))
        }
        let le = face.leftEyeTransform, re = face.rightEyeTransform
        let mid = (le.columns.3 + re.columns.3) / 2
        guard let look = hit(mid, simd_float4(face.lookAtPoint, 1) - mid),
              let left = hit(le.columns.3, le.columns.2), let right = hit(re.columns.3, re.columns.2) else { return nil }
        let head = toCamera * simd_float4(0, 0, 0, 1), facing = toCamera * simd_float4(0, 0, 1, 0)
        return [look.0, look.1, left.0, left.1, right.0, right.1, Double(head.x), Double(head.y), Double(head.z),
                Double(facing.x), Double(facing.y), look.0 * look.0, look.1 * look.1]
    }

    private func see(_ seen: Seen) {
        switch seen {
        case .gaze(let f): take(f)
        case .closed(let t): closed(t)
        case .away(let t): away(t)
        }
    }

    // A margin of most of a key: gaze a little off on the top row isn't looking away.
    private static func onKeys(_ x: Double, _ y: Double) -> Bool { x >= -1.0 && x <= 11.0 && y >= -0.8 && y <= 3.5 }

    private func take(_ f: GazeFeatures) {
        let now = ProcessInfo.processInfo.systemUptime
        closedSince = nil
        blinkDone = false
        if var c = calibrating {
            let since = now - c.began
            if since > 0.45 { c.frames[c.index].append(f) }
            if since > 1.25 {
                c.index += 1
                c.began = now
                if c.index == GazeCalibration.targets.count {
                    calibrating = nil
                    keyboard.target = nil
                    finishCalibration(c.frames)
                    return
                }
                keyboard.target = GazeCalibration.targets[c.index]
                tick.impactOccurred()
            }
            calibrating = c
            return
        }
        guard let cal = calibration else { return }
        if paused { paused = false; statusLabel.text = Self.howTo }
        let (x, y) = cal.map(f.values)
        keyboard.move(to: hold(x, y, f.time))                            // still while resting, jumps with the eyes
        recent.append((x, y))                         // raw points: the decoder models the noise (a median of
        if recent.count > 1 { recent.removeFirst() }  // 3 made 4% more words wrong in the simulator)
        let mx = recent.map { $0.0 }.sorted()[recent.count / 2], my = recent.map { $0.1 }.sorted()[recent.count / 2]
        history.append((f.time, mx, my))
        while let first = history.first, f.time - first.t > 1.2 { history.removeFirst() }
        if Self.onKeys(mx, my) {
            offSince = nil
            word.append(GazeSample(x: mx, y: my, t: f.time))
            wordFeatures.append(f.values)
            keyboard.addTrail((mx, my))
        } else {
            offSince = offSince ?? f.time
            if f.time - offSince! > Self.lookAwayResets, !word.isEmpty { resetWord() }
        }
    }

    private func closed(_ t: Double) {
        guard calibrating == nil, calibration != nil else { return }
        guard let since = closedSince else { closedSince = t; blinkDone = false; return }
        if !blinkDone && t - since >= Self.blinkSeconds {
            blinkDone = true
            blinked(startedAt: since)
        }
    }

    private func away(_ t: Double) {
        closedSince = nil
        offSince = offSince ?? t
        if t - offSince! > Self.lookAwayResets {
            if !word.isEmpty { resetWord() }
            if !paused && calibrating == nil && calibration != nil { paused = true; statusLabel.text = "Paused while you look away." }
        }
    }

    private func resetWord() {
        word = []
        wordFeatures = []
        restAt = nil
        keyboard.clearTrail()
    }

    /// A blink: the word looked across since the last one is typed. The eyes open about where they closed,
    /// so the next word starts resting there (the decoder finds where it really starts).
    private func blinked(startedAt start: Double) {
        let aimed = history.filter { $0.t >= start - 0.2 && $0.t < start }        // the last letter, held to the blink
        var got = word, features = wordFeatures
        let rest = restAt
        resetWord()
        if !aimed.isEmpty { restAt = (aimed.map { $0.x }.sorted()[aimed.count / 2], aimed.map { $0.y }.sorted()[aimed.count / 2]) }
        guard got.count > 1, let decoder else { return }
        let rate = Double(got.count - 1) / max(1e-3, got.last!.t - got.first!.t)
        let dwell = max(3, Int((decoder.settings.minFixation * rate).rounded()))
        let moved = rest.map { p in got.filter { hypot($0.x - p.x, $0.y - p.y) > 1.0 }.count } ?? got.count
        guard moved >= dwell else { return }                  // only resting (or a second blink): no word
        var from = 0                                          // a long rest before the word only costs time
        if let p = rest {
            while from < got.count, hypot(got[from].x - p.x, got[from].y - p.y) < 0.8 { from += 1 }
            from = max(0, from - 6)
        }
        if got.count - from > Int(8 * rate) { from = got.count - Int(8 * rate) }
        got = Array(got[from...]); features = Array(features[from...])
        queued.append((got, features, rest))
        nextWord()
    }

    @objc private func recalibrate() { startCalibration() }

    private func startCalibration() {
        calibrating = (0, ProcessInfo.processInfo.systemUptime, Array(repeating: [], count: GazeCalibration.targets.count))
        keyboard.target = GazeCalibration.targets[0]
        resetWord()
        statusLabel.text = "Look at each yellow dot until it jumps (about 20 seconds)."
    }

    private func finishCalibration(_ frames: [[GazeFeatures]]) {
        guard let cal = GazeCalibration.fit(frames) else {
            statusLabel.text = "Couldn't follow your eyes well enough. Hold the phone about a forearm away, face in view, and tap Dots."
            return
        }
        dotFrames = frames
        learned = []
        use(cal)
        statusLabel.text = Self.howTo
    }

    private func use(_ cal: GazeCalibration) {
        calibration = cal
        decoder?.settings.sigma = max(0.35, 1.1 * cal.spread.x)
        decoder?.settings.sigmaY = max(0.3, 1.1 * cal.spread.y)
    }

    /// The last word stood (another came after it, or it was swapped for the right one): where its letters
    /// are is where the eyes were, so those frames tune the calibration.
    private func learnFromLastWord() {
        guard !busy else { return }                           // the decoder is busy with the next word
        guard let p = pending, let decoder, let keys = decoder.align(p.word, p.samples, restAt: p.restAt) else { pending = nil; return }
        pending = nil
        for i in 1..<max(1, keys.count - 1) where keys[i] >= 0 && keys[i - 1] == keys[i] && keys[i] == keys[i + 1] {
            let c = EyeLayout.centers[keys[i]]
            if hypot(p.samples[i].x - c.x, p.samples[i].y - c.y) < 1.8 { learned.append((p.features[i], (c.x, c.y))) }
        }
        if learned.count > 600 { learned.removeFirst(learned.count - 600) }
        if let cal = GazeCalibration.fit(dotFrames, extra: learned) { use(cal) }
    }

    // MARK: Words

    private func nextWord() {
        guard !busy, !queued.isEmpty, let decoder else { return }
        let (got, features, restAt) = queued.removeFirst()
        learnFromLastWord()                                   // the word before stood
        let last = words.last
        let previous: String? = last == nil || last == "." || last == "?" ? nil : last!.lowercased()
        busy = true
        work.async { [weak self] in
            let found = decoder.decode(got, previous: previous, count: 4, restAt: restAt)
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                if let best = found.first {
                    self.lastCandidates = found
                    self.words.append(best.shown)
                    self.pending = (best.word, got, features, restAt)
                    self.tick.impactOccurred()
                    self.refresh()
                }
                self.nextWord()
            }
        }
    }

    @objc private func alternative(_ sender: UIButton) {
        let n = sender.tag + 1
        guard n < lastCandidates.count, !words.isEmpty else { return }
        let chosen = lastCandidates[n]
        lastCandidates.swapAt(0, n)
        words[words.count - 1] = chosen.shown
        pending?.word = chosen.word
        refresh()
    }

    @objc private func deleteWord() {
        if !words.isEmpty { words.removeLast() }
        lastCandidates = []
        pending = nil
        refresh()
    }

    /// The words as text: capitalized at sentence starts, "." and "?" right after the word before.
    private var text: String {
        var out = "", start = true
        for w in words {
            if w == "." || w == "?" { out += w; start = true; continue }
            if !out.isEmpty { out += " " }
            out += start ? w.prefix(1).uppercased() + w.dropFirst() : w
            start = false
        }
        return out
    }

    private func refresh() {
        textLabel.text = words.isEmpty ? " " : text
        for (n, b) in alternativeButtons.enumerated() {
            let title = n + 1 < lastCandidates.count ? lastCandidates[n + 1].shown : ""
            b.setTitle(title, for: .normal)
            b.isHidden = title.isEmpty
        }
    }

    @objc private func copyText() {
        UIPasteboard.general.string = text
        statusLabel.text = "Copied."
    }

    @objc private func send() {
        let words = text
        guard !words.isEmpty else { return }
        guard let cloud = HiveCloud.load() else { statusLabel.text = "Hive isn't connected on this phone yet."; return }
        var call = URLRequest(url: cloud.url.appendingPathComponent("v1/requests"))
        call.httpMethod = "POST"
        call.timeoutInterval = 15
        call.setValue("Bearer \(cloud.key)", forHTTPHeaderField: "Authorization")
        call.setValue("application/json", forHTTPHeaderField: "Content-Type")
        call.httpBody = try? JSONSerialization.data(withJSONObject: ["text": words, "from": "eye-typing"])
        statusLabel.text = "Sending…"
        URLSession.shared.dataTask(with: call) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self.statusLabel.text = ok ? "Sent to Hive." : "Hive didn't take it. Try again in a moment."
                if ok { self.learnFromLastWord(); self.words = []; self.lastCandidates = []; self.refresh() }
            }
        }.resume()
    }

    @objc private func close() { dismiss(animated: true) }
}

/// The keyboard: keys (drawn once), where you're looking and the key under it (little views that just
/// move), the path of the word so far, and calibration dots.
final class EyeKeyboardView: UIView {
    var target: (Double, Double)? { didSet { setNeedsDisplay(); if target != nil { move(to: nil) } } }
    private let dot = UIView(frame: CGRect(x: 0, y: 0, width: 22, height: 22)), highlight = UIView()
    private let trailLayer = CAShapeLayer()
    private var trail: [CGPoint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        highlight.backgroundColor = UIColor(red: 0.3, green: 0.5, blue: 0.95, alpha: 0.5)
        highlight.layer.cornerRadius = 10
        dot.backgroundColor = UIColor(red: 1, green: 0.85, blue: 0.35, alpha: 0.35)
        dot.layer.cornerRadius = 11
        dot.layer.borderWidth = 2.5
        dot.layer.borderColor = UIColor(white: 1, alpha: 0.9).cgColor
        trailLayer.strokeColor = UIColor(red: 0.45, green: 0.75, blue: 1, alpha: 0.7).cgColor
        trailLayer.fillColor = nil
        trailLayer.lineWidth = 3
        trailLayer.lineJoin = .round
        layer.addSublayer(trailLayer)
        for v in [highlight, dot] { v.isHidden = true; addSubview(v) }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        trailLayer.frame = bounds
        setNeedsDisplay()
    }

    private var area: CGRect { bounds.insetBy(dx: 10, dy: 8) }

    private func point(_ k: (Double, Double)) -> CGPoint {
        CGPoint(x: area.minX + k.0 / EyeLayout.width * area.width, y: area.minY + k.1 / EyeLayout.height * area.height)
    }

    private func keyRect(_ i: Int) -> CGRect {
        let kw = area.width / EyeLayout.width, kh = area.height / EyeLayout.height
        let c = point((EyeLayout.centers[i].x, EyeLayout.centers[i].y))
        return CGRect(x: c.x - kw / 2 + 3, y: c.y - kh / 2 + 3, width: kw - 6, height: kh - 6)
    }

    func move(to g: (Double, Double)?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard let g, target == nil else { dot.isHidden = true; highlight.isHidden = true; return }
        dot.center = point(g)
        dot.isHidden = false
        let near = EyeLayout.centers.indices.min { a, b in
            hypot(EyeLayout.centers[a].x - g.0, EyeLayout.centers[a].y - g.1) < hypot(EyeLayout.centers[b].x - g.0, EyeLayout.centers[b].y - g.1)
        }!
        let on = g.0 >= -0.6 && g.0 <= 10.6 && g.1 >= -0.4 && g.1 <= 3.4
        if on { highlight.frame = keyRect(near) }
        highlight.isHidden = !on
    }

    func addTrail(_ p: (Double, Double)) {
        trail.append(point(p))
        guard trail.count > 1 else { return }
        let path = UIBezierPath()
        path.move(to: trail[0])
        for q in trail.dropFirst() { path.addLine(to: q) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        trailLayer.path = path.cgPath
        CATransaction.commit()
    }

    func clearTrail() {
        trail = []
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        trailLayer.path = nil
        CATransaction.commit()
    }

    override func draw(_ rect: CGRect) {
        let kw = area.width / EyeLayout.width, kh = area.height / EyeLayout.height
        let font = UIFont.systemFont(ofSize: min(kw, kh) * 0.42, weight: .semibold)
        for (i, ch) in EyeLayout.keys.enumerated() {
            let key = keyRect(i)
            UIColor(white: 1, alpha: 0.08).setFill()
            UIBezierPath(roundedRect: key, cornerRadius: 10).fill()
            let s = NSAttributedString(string: String(ch).uppercased(), attributes: [.font: font, .foregroundColor: UIColor(white: 1, alpha: 0.92)])
            let size = s.size()
            s.draw(at: CGPoint(x: key.midX - size.width / 2, y: key.midY - size.height / 2))
        }
        if let t = target {
            let c = point(t)
            UIColor(red: 1, green: 0.8, blue: 0.3, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(x: c.x - 16, y: c.y - 16, width: 32, height: 32)).fill()
            UIColor.black.setFill()
            UIBezierPath(ovalIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)).fill()
        }
    }
}

/// "Eye type with Hive" in Shortcuts and Siri: opens the app on the eye keyboard.
@available(iOS 16.0, *)
struct EyeType: AppIntent {
    static var title: LocalizedStringResource = "Eye Typing"
    static var description = IntentDescription("Type by looking at a big keyboard.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        EyeTypingViewController.present()
        return .result()
    }
}
