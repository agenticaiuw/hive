// Eye-swipe typing: you look across a word's letters on a big keyboard while holding a key (the Mac) or a
// finger on the screen (the phone); letting go types the word. This file turns that gaze path into the word,
// with a language model choosing among words whose paths look alike. Shared by the Mac keyboard
// (tools/eyeswipe/keyboard.swift) and the iPhone app (mobile/ios/App/App/EyeTyping.swift); Foundation only.
//
// How it decodes: each word is the path through its letters' keys (doubled letters count once: "hello" is
// h-e-l-o). The gaze samples are lined up with those keys in order, each key holding the gaze for at least
// a short fixation, and the word scores how close the samples fall to their keys (with a few samples
// allowed to be anywhere: blinks, the glance to the first letter). A small shift of the whole path is
// allowed too, because webcam gaze drifts. Then the language model (eyeswipe-lm.bin, word pairs distilled
// from Qwen by scripts/eyeswipe_build_lm.py) adds how likely each word is after the one before it.

import Foundation

/// One gaze sample, in key units: keys are 1 wide and 1 tall, (0, 0) is the keyboard's top-left corner.
public struct GazeSample {
    public var x: Double, y: Double, t: Double
    public init(x: Double, y: Double, t: Double) { self.x = x; self.y = y; self.t = t }
}

/// The keyboard: three rows, staggered like a phone keyboard, with "." and "?" after "m".
public enum EyeLayout {
    public static let rows: [String] = ["qwertyuiop", "asdfghjkl", "zxcvbnm.?"]
    public static let offsets: [Double] = [0, 0.5, 1.0]
    public static let width = 10.0, height = 3.0
    public static let keys: [Character] = rows.flatMap { Array($0) }
    public static let centers: [(x: Double, y: Double)] = {
        var c: [(x: Double, y: Double)] = []
        for (r, row) in rows.enumerated() {
            for (i, _) in row.enumerated() { c.append((offsets[r] + Double(i) + 0.5, Double(r) + 0.5)) }
        }
        return c
    }()
    public static let index: [Character: Int] = Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($1, $0) })
    /// The space bar under the keys, for typing without breaks: looking at it between words is optional,
    /// and tells where a word ends. Its middle line, in key units.
    public static let space = (x0: 2.5, x1: 7.5, y: 3.6)

    /// How far a point is from the space bar's middle line, in key units.
    public static func spaceOffset(_ x: Double, _ y: Double) -> (Double, Double) {
        (x < space.x0 ? x - space.x0 : (x > space.x1 ? x - space.x1 : 0), y - space.y)
    }

    /// The keys a word's path goes through, doubled letters once; nil if a letter isn't on the keyboard.
    public static func path(_ word: String) -> [Int]? {
        var out: [Int] = []
        for ch in word.lowercased() where ch != "'" {
            guard let k = index[ch] else { return nil }
            if out.last != k { out.append(k) }
        }
        return out.isEmpty ? nil : out
    }
}

/// Lines a whole sentence's gaze up with its keys once the sentence is known (practice shows it; otherwise
/// what was typed), so the map can learn where the eyes really were. Each sample sits on the sentence's next
/// key or the same one, or counts as off (a glance elsewhere, a saccade), and the whole path may sit off by a
/// shift (the map drifts as the head moves: 1.5 to 3.5 keys by the end of the owner's session, 2026-11-19).
/// The path may stop early (a sentence cut short). On that session, a map refitted after every sentence on
/// the frames this finds was 1.0 key off on the next sentence, against 1.8 for the setup's map alone.
public enum SentenceAlign {
    /// The sentence's keys in order, doubled letters once (words that can't be typed are left out).
    public static func path(_ text: String) -> [Int]? {
        var out: [Int] = []
        for word in text.lowercased().split(separator: " ") {
            guard let p = EyeLayout.path(String(word)) else { continue }
            for k in p where out.last != k { out.append(k) }
        }
        return out.count >= 2 ? out : nil
    }

    /// The key each sample looked at (-1: off), the shift of the whole gaze path that fits best (subtract it
    /// from a sample to get where it looked), the share of samples on keys, and how far along the sentence's
    /// keys the gaze got (1: to the last key). nil if it can't be lined up.
    public static func align(_ text: String, _ samples: [(x: Double, y: Double)], sigma: Double = 0.7,
                             off: Double = -6, range: Double = 3.5)
        -> (keys: [Int], shift: (x: Double, y: Double), onKeys: Double, reached: Double)? {
        guard let path = path(text), samples.count >= 2 * path.count else { return nil }
        let fit = Fit(path, samples, sigma, off), best = fit.bestShift(range)
        let T = samples.count, K = path.count
        var back = [UInt8](repeating: 0, count: T * K)
        let (_, last) = back.withUnsafeMutableBufferPointer { fit.run(best.x, best.y, $0.baseAddress) }
        var keys = [Int](repeating: -1, count: T), j = last
        for t in stride(from: T - 1, through: 0, by: -1) {
            let on = fit.emit(t, j, best.x, best.y) > off
            keys[t] = on ? path[j] : -1
            if t > 0 && back[t * K + j] == 1 { j -= 1 }
        }
        let onKeys = Double(keys.filter { $0 >= 0 }.count) / Double(T)
        return (keys, (best.x, best.y), onKeys, Double(last + 1) / Double(K))
    }

    /// How well the gaze follows the sentence's keys in order at its best shift: a log score, comparable only
    /// between sentences scored on the same samples. nil if it can't be lined up.
    public static func score(_ text: String, _ samples: [(x: Double, y: Double)], sigma: Double = 0.7,
                             off: Double = -6, range: Double = 3.5) -> Double? {
        guard let path = path(text), samples.count >= 2 * path.count else { return nil }
        return Fit(path, samples, sigma, off).bestShift(range).score
    }

    /// One sentence's keys against one gaze path: a monotonic Viterbi (each sample on the key it's at or the
    /// next one), the samples moved by a shift.
    struct Fit {
        let samples: [(x: Double, y: Double)], centers: [(x: Double, y: Double)], norm: Double, s2: Double, off: Double

        init(_ path: [Int], _ samples: [(x: Double, y: Double)], _ sigma: Double, _ off: Double) {
            self.samples = samples
            centers = path.map { EyeLayout.centers[$0] }
            norm = -log(2 * Double.pi * sigma * sigma)
            s2 = 2 * sigma * sigma
            self.off = off
        }

        func emit(_ t: Int, _ j: Int, _ sx: Double, _ sy: Double) -> Double {
            let dx = samples[t].x - sx - centers[j].x, dy = samples[t].y - sy - centers[j].y
            return max(norm - (dx * dx + dy * dy) / s2, off)
        }

        /// Best score over the path's keys at the last sample; with `back`, which key each sample is on.
        func run(_ sx: Double, _ sy: Double, _ back: UnsafeMutablePointer<UInt8>?) -> (Double, Int) {
            let T = samples.count, K = centers.count
            var prev = [Double](repeating: -.infinity, count: K), cur = prev
            prev[0] = emit(0, 0, sx, sy)
            for t in 1..<T {
                for j in 0..<K {
                    let stay = prev[j], move = j > 0 ? prev[j - 1] : -.infinity
                    cur[j] = max(stay, move) + emit(t, j, sx, sy)
                    back?[t * K + j] = move > stay ? 1 : 0
                }
                swap(&prev, &cur)
            }
            var best = 0
            for j in 1..<K where prev[j] > prev[best] { best = j }
            return (prev[best], best)
        }

        /// The shift that fits best: a coarse grid, then finer around the best.
        func bestShift(_ range: Double) -> (score: Double, x: Double, y: Double) {
            var best = (score: -Double.infinity, x: 0.0, y: 0.0)
            for step in [0.5, 0.25] {
                let around = step == 0.5 ? (0.0, 0.0) : (best.x, best.y), reach = step == 0.5 ? range : 0.5
                var dx = -reach
                while dx <= reach + 1e-9 {
                    var dy = -reach
                    while dy <= reach + 1e-9 {
                        let (sx, sy) = (around.0 + dx, around.1 + dy)
                        let v = run(sx, sy, nil).0 - (sx * sx + sy * sy) / 50   // a faint pull towards no shift
                        if v > best.score { best = (v, sx, sy) }
                        dy += step
                    }
                    dx += step
                }
            }
            return best
        }
    }
}

/// The word-pair language model (see scripts/eyeswipe_build_lm.py for the file layout).
public final class EyeLM {
    public let words: [String]        // lowercase, as swiped ("don't")
    public let shown: [String]        // as written ("I'm", "America")
    let unigram: [Float]              // ln P(word), mid-sentence
    let contexts: Int, keep: Int
    let blocks: Data                  // start, then each context word: f32 left over, keep * (u16 id, u8 -lnP*8)
    private var cache: [Int: [Float]] = [:]
    private var order: [Int] = []

    public init(data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count > 17, String(decoding: bytes[0..<5], as: UTF8.self) == "ESLM1" else {
            throw NSError(domain: "EyeLM", code: 1, userInfo: [NSLocalizedDescriptionKey: "not an eye-swipe model"])
        }
        func u32(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 | Int(bytes[at + 2]) << 16 | Int(bytes[at + 3]) << 24 }
        let n = u32(5)
        contexts = u32(9); keep = u32(13)
        var at = 17, start = 17
        var lines: [String] = []
        while at < bytes.count {
            if bytes[at] == 10 {
                if at == start { at += 1; break }
                lines.append(String(decoding: bytes[start..<at], as: UTF8.self))
                start = at + 1
            }
            at += 1
        }
        guard lines.count == n else {
            throw NSError(domain: "EyeLM", code: 2, userInfo: [NSLocalizedDescriptionKey: "word list is cut short"])
        }
        words = lines.map { String($0.split(separator: "\t", maxSplits: 1).first ?? "") }
        shown = lines.map { l in let p = l.split(separator: "\t", maxSplits: 1); return String(p.count > 1 ? p[1] : p[0]) }
        unigram = bytes[at..<(at + n)].map { -Float($0) / 8 }
        at += n
        blocks = data.subdata(in: at..<data.count)
        guard blocks.count >= (contexts + 1) * (4 + 3 * keep) else {
            throw NSError(domain: "EyeLM", code: 3, userInfo: [NSLocalizedDescriptionKey: "word pairs are cut short"])
        }
    }

    public convenience init(contentsOf url: URL) throws { try self.init(data: Data(contentsOf: url)) }

    public lazy var id: [String: Int] = Dictionary(words.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })

    /// ln P(every word | the word before), by word id; nil before = a sentence starts.
    public func next(after previous: Int?) -> [Float] {
        let block: Int? = previous == nil ? 0 : (previous! < contexts ? previous! + 1 : nil)
        guard let b = block else { return unigram }
        if let hit = cache[b] { return hit }
        let size = 4 + 3 * keep
        var out = unigram
        blocks.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let p = raw.baseAddress!.advanced(by: b * size)
            let left = Float(max(1e-6, Double(p.loadUnaligned(as: Float32.self))))
            var keptUni: Float = 0
            var kept: [(Int, Float)] = []
            for k in 0..<keep {
                let q = p.advanced(by: 4 + 3 * k)
                let w = Int(q.load(as: UInt8.self)) | Int(q.advanced(by: 1).load(as: UInt8.self)) << 8
                let lp = -Float(q.advanced(by: 2).load(as: UInt8.self)) / 8
                kept.append((w, lp))
                keptUni += exp(unigram[w])
            }
            let backoff = log(left / max(1e-6, 1 - keptUni))     // what isn't kept, in proportion to how common
            for w in 0..<out.count { out[w] += backoff }
            for (w, lp) in kept { out[w] = lp }
        }
        cache[b] = out
        order.append(b)
        if order.count > 8 { cache[order.removeFirst()] = nil }
        return out
    }

    private var pairs: [Int: (left: Float, kept: [Int: Float])] = [:]

    /// ln P(word | the word before), one pair at a time (for typing without breaks, where many different
    /// words before are in play at once); nil before = a sentence starts.
    public func score(_ word: Int, after previous: Int?) -> Float {
        let block: Int? = previous == nil ? 0 : (previous! < contexts ? previous! + 1 : nil)
        guard let b = block else { return unigram[word] }
        if pairs[b] == nil {
            if pairs.count > 2048 { pairs = [:] }
            let size = 4 + 3 * keep
            var kept: [Int: Float] = [:], keptUni: Float = 0, left: Float = 0
            blocks.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let p = raw.baseAddress!.advanced(by: b * size)
                left = Float(max(1e-6, Double(p.loadUnaligned(as: Float32.self))))
                for k in 0..<keep {
                    let q = p.advanced(by: 4 + 3 * k)
                    let w = Int(q.load(as: UInt8.self)) | Int(q.advanced(by: 1).load(as: UInt8.self)) << 8
                    kept[w] = -Float(q.advanced(by: 2).load(as: UInt8.self)) / 8
                    keptUni += exp(unigram[w])
                }
            }
            pairs[b] = (log(left / max(1e-6, 1 - keptUni)), kept)
        }
        let e = pairs[b]!
        return e.kept[word] ?? unigram[word] + e.left
    }
}

public final class EyeSwipeDecoder {
    public struct Settings {
        public var sigma = 0.6             // how far gaze lands from the key looked at, in key widths
        public var sigmaY: Double? = nil   // the same up and down, in key heights, if it differs
        public var outlier = 0.05          // share of samples that can be anywhere (blinks, the glance to start)
        public var restSpread = 1.25       // after a blink, how loosely the eyes reopen where they closed (x sigma)
        public var minFixation = 0.13      // seconds each key has to hold the gaze (shorter: glances add letters)
        public var lmWeight = 0.8          // the language model's weight against the gaze
        public var gazeTemperature = 4.0   // samples in one fixation aren't independent: divide their evidence
        public var shiftSigma = 0.5        // how far the whole path may be shifted (webcam drift), key widths
        public var refine = 40             // how many leading candidates get the shift search
        public init() {}
    }

    public struct Candidate {
        public let word: String, shown: String
        public let score: Double, gaze: Double, lm: Double
        public let shift: (x: Double, y: Double)    // how far the gaze sat from the keys, for drift tracking
    }

    public var settings: Settings
    public let lm: EyeLM
    // Punctuation the model doesn't know: "." and "?" are swiped as their own one-key word.
    static let punctuation: [(String, Double)] = [(".", log(0.04)), ("?", log(0.012))]
    let pathWords: [[Int]]                // per distinct key path, its word ids; ids >= lm.words.count are punctuation
    // The key paths as a tree, so paths that start alike share the line-up of that start: nodes in depth-first
    // order, each node's children likeliest first (by the commonest word below), `end` = just past its subtree.
    let nodeKey: [Int], nodeDepth: [Int], nodeEnd: [Int], nodeParent: [Int]
    let nodePath: [Int]                   // the path ending at this node, or -1
    let pathNode: [Int]

    public init(lm: EyeLM, settings: Settings = Settings()) {
        self.lm = lm
        self.settings = settings
        var entries: [([Int], Int)] = []
        for (w, word) in lm.words.enumerated() {
            if let p = EyeLayout.path(word) { entries.append((p, w)) }
        }
        for (k, (mark, _)) in Self.punctuation.enumerated() {
            entries.append(([EyeLayout.index[Character(mark)]!], lm.words.count + k))
        }
        entries.sort { a, b in a.0.lexicographicallyPrecedes(b.0) }
        // Build the tree from the sorted paths (each shares a start with the one before).
        var key = [-1], parent = [-1], children: [[Int]] = [[]], ends = [-1], depth = [0]
        var words: [[Int]] = []
        var stack = [0], last: [Int] = []
        for (p, w) in entries {
            if p == last { words[ends[stack.last!]].append(w); continue }
            var common = 0
            while common < min(p.count, last.count), p[common] == last[common] { common += 1 }
            stack.removeLast(stack.count - 1 - common)
            for d in common..<p.count {
                let v = key.count
                key.append(p[d]); parent.append(stack.last!); children.append([]); ends.append(-1); depth.append(d + 1)
                children[stack.last!].append(v)
                stack.append(v)
            }
            ends[stack.last!] = words.count
            words.append([w])
            last = p
        }
        // Likeliest children first, so good words are found early and the rest can be skipped.
        var best = [Float](repeating: -.infinity, count: key.count)
        for v in stride(from: key.count - 1, through: 1, by: -1) {
            if ends[v] >= 0 {
                for w in words[ends[v]] where w < lm.words.count { best[v] = max(best[v], lm.unigram[w]) }
                if words[ends[v]].contains(where: { $0 >= lm.words.count }) { best[v] = max(best[v], -3) }
            }
            best[parent[v]] = max(best[parent[v]], best[v])
        }
        var order: [Int] = [], end = [Int](repeating: 0, count: key.count)
        var todo: [(Int, Bool)] = children[0].sorted { best[$0] > best[$1] }.reversed().map { ($0, false) }
        while let (v, done) = todo.popLast() {
            if done { end[v] = order.count; continue }
            end[v] = -1
            order.append(v)
            todo.append((v, true))
            todo.append(contentsOf: children[v].sorted { best[$0] > best[$1] }.reversed().map { ($0, false) })
        }
        var at = [Int](repeating: -1, count: key.count)
        for (i, v) in order.enumerated() { at[v] = i }
        nodeKey = order.map { key[$0] }
        nodeDepth = order.map { depth[$0] }
        nodeEnd = order.map { end[$0] }
        nodeParent = order.map { parent[$0] == 0 ? -1 : at[parent[$0]] }
        nodePath = order.map { ends[$0] }
        var pn = [Int](repeating: -1, count: words.count)
        for (i, p) in nodePath.enumerated() where p >= 0 { pn[p] = i }
        pathNode = pn
        pathWords = words
    }

    /// The keys of a distinct path, from the tree.
    func path(_ p: Int) -> [Int] {
        var out: [Int] = [], v = pathNode[p]
        while v >= 0 { out.append(nodeKey[v]); v = nodeParent[v] }
        return out.reversed()
    }

    public func text(_ id: Int) -> (word: String, shown: String) {
        if id >= lm.words.count { let m = Self.punctuation[id - lm.words.count].0; return (m, m) }
        return (lm.words[id], lm.shown[id])
    }

    /// The likeliest words for this gaze path, best first. `previous` is the word typed before ("." or nil
    /// when a sentence starts).
    public func decode(_ samples: [GazeSample], previous: String?, count: Int = 5, rest: Int = 0,
                       restAt: (x: Double, y: Double)? = nil) -> [Candidate] {
        guard !samples.isEmpty else { return [] }
        let s = settings
        let rate = samples.count > 1 ? Double(samples.count - 1) / max(1e-3, samples.last!.t - samples.first!.t) : 30
        let dwell = max(1, Int((s.minFixation * rate).rounded()))
        let emit = emissions(samples, shift: (0, 0))
        let pre = restAt.map { restPrefix(samples, at: $0) } ?? restPrefix(emit, samples.count, rest)

        let lmScores: [Float]
        if previous == nil || previous == "." || previous == "?" {
            lmScores = lm.next(after: nil)                          // a sentence starts
        } else if let id = lm.id[previous!.lowercased()] {
            lmScores = lm.next(after: id)
        } else {
            lmScores = lm.unigram
        }
        func lmScore(_ w: Int) -> Double {
            w >= lm.words.count ? Self.punctuation[w - lm.words.count].1 : Double(lmScores[w])
        }
        let keep = max(s.refine, count * 4)
        let found = search(emit, pre, samples.count, dwell, keep: keep, lm: lmScore)
        var gaze = [Int: Double]()
        var best: [(p: Int, total: Double)] = []
        for (p, g, top) in found {
            gaze[p] = g
            best.append((p, g / s.gazeTemperature + s.lmWeight * top))
        }
        best.sort { $0.total > $1.total }
        var shifts = [Int: (Double, Double)]()
        for (p, _) in best.prefix(s.refine) {
            let (score, shift) = shifted(path(p), samples, dwell, rest: rest, restAt: restAt)
            if score > gaze[p]! { gaze[p] = score; shifts[p] = shift }
        }
        var out: [Candidate] = []
        for (p, _) in best.prefix(keep) {
            for w in pathWords[p] {
                let g = gaze[p]! / s.gazeTemperature, l = lmScore(w)
                let (word, shown) = text(w)
                out.append(Candidate(word: word, shown: shown, score: g + s.lmWeight * l, gaze: g, lm: l,
                                     shift: shifts[p] ?? (0, 0)))
            }
        }
        out.sort { $0.score > $1.score }
        return Array(out.prefix(count))
    }

    // The `keep` paths with the best gaze score / temperature + weight * their best word's language model
    // score, as (path, gaze score, best word's score). Walks the tree depth first; a node's line-up ends
    // the samples it has covered on its last key (every sample time t), its children carry on from there.
    // A subtree is skipped when even perfect gaze for the samples left and its likeliest word can't make
    // the list.
    func search(_ emit: [Double], _ pre: [Double], _ count: Int, _ dwell: Int, keep: Int, lm: (Int) -> Double) -> [(Int, Double, Double)] {
        let s = settings, k = EyeLayout.centers.count, n = nodeKey.count
        // The likeliest word at or below each node, in this context.
        var top = [Double](repeating: -.infinity, count: pathWords.count)
        var below = [Double](repeating: -.infinity, count: n)
        for v in stride(from: n - 1, through: 0, by: -1) {
            if nodePath[v] >= 0 {
                var b = -Double.infinity
                for w in pathWords[nodePath[v]] { b = max(b, lm(w)) }
                top[nodePath[v]] = b
                below[v] = max(below[v], b)
            }
            if nodeParent[v] >= 0 { below[nodeParent[v]] = max(below[nodeParent[v]], below[v]) }
        }
        // The best any path could do with the samples from t on.
        var rest = [Double](repeating: 0, count: count + 1)
        for t in stride(from: count - 1, through: 0, by: -1) {
            var m = -Double.infinity
            for j in 0..<k { m = max(m, emit[t * k + j]) }
            rest[t] = rest[t + 1] + m
        }
        let levels = count / dwell + 2
        var lines = [Double](repeating: -.infinity, count: levels * count)   // per depth, the line-up end per t
        var sub = [Double](repeating: -.infinity, count: dwell)
        var heap: [(Double, Int, Double, Double)] = []     // the best `keep` so far, worst first
        func push(_ x: (Double, Int, Double, Double)) {
            if heap.count < keep {
                heap.append(x)
                var i = heap.count - 1
                while i > 0, heap[(i - 1) / 2].0 > heap[i].0 { heap.swapAt(i, (i - 1) / 2); i = (i - 1) / 2 }
                return
            }
            guard x.0 > heap[0].0 else { return }
            heap[0] = x
            var i = 0
            while true {
                let l = 2 * i + 1, r = l + 1
                var m = i
                if l < heap.count, heap[l].0 < heap[m].0 { m = l }
                if r < heap.count, heap[r].0 < heap[m].0 { m = r }
                if m == i { break }
                heap.swapAt(i, m); i = m
            }
        }
        emit.withUnsafeBufferPointer { e in
          lines.withUnsafeMutableBufferPointer { all in
            sub.withUnsafeMutableBufferPointer { sub in
              var v = 0
              while v < n {
                let d = nodeDepth[v], key = nodeKey[v]
                if d * dwell > count { v = nodeEnd[v]; continue }
                for i in 0..<dwell { sub[i] = -.infinity }
                var bound = -Double.infinity
                let line = all.baseAddress! + d * count, up = all.baseAddress! + (d - 1) * count
                for t in 0..<count {
                    let enter: Double = d == 1 ? pre[t] : (t == 0 ? -.infinity : up[t - 1])
                    let here = e[t * k + key]
                    if dwell == 1 {
                        sub[0] = max(enter, sub[0]) + here
                    } else {
                        sub[dwell - 1] = max(sub[dwell - 1], sub[dwell - 2]) + here
                        var i = dwell - 2
                        while i > 0 { sub[i] = sub[i - 1] + here; i -= 1 }
                        sub[0] = enter + here
                    }
                    line[t] = sub[dwell - 1]
                    bound = max(bound, line[t] + rest[t + 1])
                }
                let worst = heap.count < keep ? -Double.infinity : heap[0].0
                if nodePath[v] >= 0, line[count - 1] > -.infinity {
                    let p = nodePath[v], g = line[count - 1]
                    push((g / s.gazeTemperature + s.lmWeight * top[p], p, g, top[p]))
                }
                v = bound / s.gazeTemperature + s.lmWeight * below[v] < worst ? nodeEnd[v] : v + 1
              }
            }
          }
        }
        return heap.map { ($0.1, $0.2, $0.3) }
    }

    /// Which key each sample was on, for this word (indexes into EyeLayout.centers; -1 while still resting
    /// before it), or nil if the word can't fit the samples. Used to tune the calibration with words that were typed.
    public func align(_ word: String, _ samples: [GazeSample], rest: Int = 0, restAt: (x: Double, y: Double)? = nil) -> [Int]? {
        guard samples.count > 1, let path = EyeLayout.path(word) else { return nil }
        let rate = Double(samples.count - 1) / max(1e-3, samples.last!.t - samples.first!.t)
        let dwell = max(1, Int((settings.minFixation * rate).rounded()))
        guard path.count * dwell <= samples.count else { return nil }
        var at = [Int](repeating: 0, count: samples.count)
        let emit = emissions(samples, shift: (0, 0))
        let v = at.withUnsafeMutableBufferPointer {
            viterbi(path, emit, samples.count, dwell, back: $0.baseAddress,
                    pre: restAt.map { restPrefix(samples, at: $0) } ?? restPrefix(emit, samples.count, rest))
        }
        return v > -.infinity ? at.map { $0 < 0 ? -1 : path[$0] } : nil
    }

    // ln P(sample t | looking at key k), for every sample and key: mostly a round blur around the key,
    // plus a small share that can be anywhere on (or near) the keyboard.
    func emissions(_ samples: [GazeSample], shift: (Double, Double)) -> [Double] {
        let s = settings, keys = EyeLayout.centers
        let k = keys.count, sx = s.sigma, sy = s.sigmaY ?? s.sigma
        let norm = 1 / (2 * Double.pi * sx * sy), anywhere = s.outlier / ((EyeLayout.width + 2) * (EyeLayout.height + 2))
        var e = [Double](repeating: 0, count: samples.count * k)
        for (t, g) in samples.enumerated() {
            let x = g.x - shift.0, y = g.y - shift.1
            for j in 0..<k {
                let dx = (x - keys[j].x) / sx, dy = (y - keys[j].y) / sy
                e[t * k + j] = log((1 - s.outlier) * norm * exp(-(dx * dx + dy * dy) / 2) + anywhere)
            }
        }
        return e
    }

    // Before the word, after a blink: the eyes open where the blink closed them (the last word's last key)
    // and stay a moment. Any number of the first samples may be that rest, scored around the point where
    // the gaze was just before the blink, so the decoder itself finds where the word starts.
    func restPrefix(_ samples: [GazeSample], at p: (x: Double, y: Double)) -> [Double] {
        let s = settings, count = samples.count, sx = s.sigma * s.restSpread, sy = (s.sigmaY ?? s.sigma) * s.restSpread
        let norm = 1 / (2 * Double.pi * sx * sy), anywhere = s.outlier / ((EyeLayout.width + 2) * (EyeLayout.height + 2))
        var pre = [Double](repeating: -.infinity, count: count + 1)
        pre[0] = 0
        guard count > 1 else { return pre }
        for t in 1..<count {
            let dx = (samples[t - 1].x - p.x) / sx, dy = (samples[t - 1].y - p.y) / sy
            pre[t] = pre[t - 1] + log((1 - s.outlier) * norm * exp(-(dx * dx + dy * dy) / 2) + anywhere)
        }
        return pre
    }

    // Before the word: the samples while the eyes still rest where the last word ended (they open where the
    // blink that typed it closed them). Any word may start after them, so they don't favour words that
    // start on that key. pre[t] = the score of samples 0..<t resting (t up to `rest`), -inf after.
    func restPrefix(_ emit: [Double], _ count: Int, _ rest: Int) -> [Double] {
        var pre = [Double](repeating: -.infinity, count: count + 1)
        pre[0] = 0
        let r = min(rest, count - 1), k = EyeLayout.centers.count
        guard r > 0 else { return pre }
        var key = 0, best = -Double.infinity
        for j in 0..<k {
            var sum = 0.0
            for t in 0..<r { sum += emit[t * k + j] }
            if sum > best { best = sum; key = j }
        }
        for t in 1...r { pre[t] = pre[t - 1] + emit[(t - 1) * k + key] }
        return pre
    }

    // Best line-up of the samples with the path's keys, in order, each key holding at least `dwell` samples.
    // States: key j, sub-step i (0..<dwell); the last sub-step can stay; the word may begin after resting
    // samples (`pre`). `back` (if given) gets each sample's key index in the path, -1 while resting.
    func viterbi(_ path: [Int], _ emit: [Double], _ count: Int, _ dwell: Int, back: UnsafeMutablePointer<Int>?,
                 pre: [Double]? = nil) -> Double {
        let k = EyeLayout.centers.count, n = path.count * dwell
        var prev = [Double](repeating: -.infinity, count: n), cur = prev
        var from: [Int32] = back == nil ? [] : [Int32](repeating: -1, count: count * n)
        prev[0] = emit[path[0]]
        emit.withUnsafeBufferPointer { e in
            for t in 1..<count {
                let row = t * k
                var st = 0
                for j in 0..<path.count {
                    let here = e[row + path[j]]
                    for i in 0..<dwell {
                        var b = -Double.infinity, arg = -1
                        if i == dwell - 1, prev[st] > b { b = prev[st]; arg = st }       // stay on the key
                        if st > 0, prev[st - 1] > b { b = prev[st - 1]; arg = st - 1 }  // next sub-step or key
                        if st == 0, let pre, pre[t] > b { b = pre[t]; arg = -2 }          // the word starts now
                        cur[st] = b == -.infinity ? b : b + here
                        if back != nil { from[t * n + st] = Int32(arg) }
                        st += 1
                    }
                }
                swap(&prev, &cur)
            }
        }
        let score = prev[n - 1]
        if let back, score > -.infinity {
            var st = n - 1
            for t in stride(from: count - 1, through: 0, by: -1) {
                if st < 0 { back[t] = -1; continue }
                back[t] = st / dwell
                if t > 0 { st = Int(from[t * n + st]) }
            }
        }
        return score
    }

    // The path's score when the whole gaze path may be shifted: line up, move by the average miss (pulled
    // toward no shift), line up again.
    func shifted(_ path: [Int], _ samples: [GazeSample], _ dwell: Int, rest: Int = 0,
                 restAt: (x: Double, y: Double)? = nil) -> (Double, (Double, Double)) {
        let s = settings, keys = EyeLayout.centers
        let fixed = restAt.map { restPrefix(samples, at: $0) }       // the rest point drifted with the gaze: no shift
        var shift = (0.0, 0.0), score = -Double.infinity
        var at = [Int](repeating: 0, count: samples.count)
        for _ in 0..<2 {
            let emit = emissions(samples, shift: shift)
            let v = at.withUnsafeMutableBufferPointer {
                viterbi(path, emit, samples.count, dwell, back: $0.baseAddress, pre: fixed ?? restPrefix(emit, samples.count, rest))
            }
            guard v > -.infinity else { break }
            var sx = 0.0, sy = 0.0, used = 0.0
            for (t, g) in samples.enumerated() where at[t] >= 0 {
                let c = keys[path[at[t]]]
                let dx = g.x - c.x, dy = g.y - c.y
                let sy2 = (s.sigmaY ?? s.sigma) * (s.sigmaY ?? s.sigma)
                if dx * dx + dy * dy < 6.25 * (max(s.sigma * s.sigma, sy2) + s.shiftSigma * s.shiftSigma) { sx += dx; sy += dy; used += 1 }
            }
            let pull = s.sigma * s.sigma / (s.shiftSigma * s.shiftSigma) * s.gazeTemperature
            shift = (sx / (used + pull), sy / (used + pull))
            let e2 = emissions(samples, shift: shift)
            let v2 = viterbi(path, e2, samples.count, dwell, back: nil, pre: fixed ?? restPrefix(e2, samples.count, rest))
            let prior = (shift.0 * shift.0 + shift.1 * shift.1) / (2 * s.shiftSigma * s.shiftSigma) * s.gazeTemperature
            score = max(score, v2 - prior)
        }
        return (score, shift)
    }
}

// MARK: - Typing without stopping between words

/// Eye typing with no break between words: gaze samples go in one at a time while the eyes go from letter
/// to letter and word to word, and a word comes out as soon as every guess still in the running agrees on
/// it. It's EyeSwipeDecoder's line-up (each key holds the gaze a short fixation, samples blur around their
/// key) run over the whole key tree at once: where a word can end, a guess may start the next word, paying
/// that word's language-model score after the word before it.
public final class EyeStream {
    public struct Settings {
        public var beam = 10.0             // guesses this far behind the best are dropped (gaze/temperature units)
        public var maxGuesses = 2500       // and never more than this many
        public var wordStarts = 8          // word endings per sample that may start a next word
        public var wordPenalty = 0.0       // per word: more makes fewer, longer words
        public var noSpace = 0.0           // cost of going on to the next word without a look at the space bar
        public init() {}
    }
    /// A word that came out, and the samples it covers (start...end, counted from begin()).
    public struct Word { public let word: String, shown: String, start: Int, end: Int }

    public let decoder: EyeSwipeDecoder
    public var settings = Settings()
    // The guesses: a tree node, how many samples into its key (up to dwell - 1), score, words so far, last word.
    var node: [Int32] = [], sub: [Int8] = [], score: [Double] = [], hist: [Int32] = [], last: [Int32] = []
    // Words guessed so far, as a tree: word id, the record before, how many words, its last sample.
    var recWord: [Int32] = [], recPrev: [Int32] = [], recDepth: [Int32] = [], recEnd: [Int32] = []
    var given = 0                          // how many agreed words were handed out
    var start: Int32 = -1                  // the word before the first: -1 a sentence starts, -2 unknown
    var dwell = 3
    var best = -Double.infinity            // last sample's best pruning score
    var restAt: (x: Double, y: Double)? = nil  // where the eyes rest before the first word (they open there)
    public private(set) var count = 0      // samples since begin()
    let tops: [Int32]
    let space: Int32                       // the space bar's node (one past the tree)
    let rest: Int32                        // resting where the eyes opened, before the first word (two past)
    let lookahead: [Double]                // ln P of the commonest word at or below each node, for pruning

    public init(decoder: EyeSwipeDecoder) {
        self.decoder = decoder
        var t: [Int32] = [], v = 0
        while v < decoder.nodeKey.count { t.append(Int32(v)); v = decoder.nodeEnd[v] }
        tops = t
        let n = decoder.nodeKey.count, lm = decoder.lm
        space = Int32(n)
        rest = Int32(n + 1)
        var below = [Double](repeating: -.infinity, count: n + 2)
        for v in stride(from: n - 1, through: 0, by: -1) {
            if decoder.nodePath[v] >= 0 {
                for w in decoder.pathWords[decoder.nodePath[v]] {
                    below[v] = max(below[v], w >= lm.words.count ? EyeSwipeDecoder.punctuation[w - lm.words.count].1 : Double(lm.unigram[w]))
                }
            }
            if decoder.nodeParent[v] >= 0 { below[decoder.nodeParent[v]] = max(below[decoder.nodeParent[v]], below[v]) }
        }
        below[n] = t.map { below[Int($0)] }.max() ?? 0
        below[n + 1] = below[n]
        lookahead = below
    }

    /// Start over. `previous` is the word typed before (nil or "." when a sentence starts, "" if unknown),
    /// `rate` the samples a second, `resting` where the eyes open after the blink that ended the last word
    /// (the samples there aren't the next word's first letter, whatever key it is).
    public func begin(previous: String?, rate: Double, resting: (x: Double, y: Double)? = nil) {
        node = []; sub = []; score = []; hist = []; last = []
        restAt = resting
        recWord = []; recPrev = []; recDepth = []; recEnd = []
        given = 0; count = 0; best = -.infinity
        dwell = max(1, min(7, Int((decoder.settings.minFixation * rate).rounded())))
        if let p = previous?.lowercased(), p != ".", p != "?" {
            start = decoder.lm.id[p].map { Int32($0) } ?? -2
        } else {
            start = -1
        }
    }

    func lmScore(_ w: Int, after prev: Int32) -> Double {
        let lm = decoder.lm
        if w >= lm.words.count { return EyeSwipeDecoder.punctuation[w - lm.words.count].1 }
        if prev == -2 { return Double(lm.unigram[w]) }
        if prev < 0 || Int(prev) >= lm.words.count { return Double(lm.score(w, after: nil)) }
        return Double(lm.score(w, after: Int(prev)))
    }

    /// One more gaze sample; returns the words everyone now agrees on, in order.
    public func push(_ g: GazeSample) -> [Word] {
        let s = decoder.settings, keys = EyeLayout.centers, k = keys.count
        let sx = s.sigma, sy = s.sigmaY ?? s.sigma
        let norm = 1 / (2 * Double.pi * sx * sy), anywhere = s.outlier / ((EyeLayout.width + 2) * (EyeLayout.height + 2))
        var e = [Double](repeating: 0, count: k + 2)
        var top = -Double.infinity
        for j in 0...(k + 1) {
            if j == k + 1 && restAt == nil { e[j] = -.infinity; continue }
            var (dx, dy) = j < k ? (g.x - keys[j].x, g.y - keys[j].y)
                : (j == k ? EyeLayout.spaceOffset(g.x, g.y) : (g.x - restAt!.x, g.y - restAt!.y))
            dx /= sx; dy /= sy
            e[j] = log((1 - s.outlier) * norm * exp(-(dx * dx + dy * dy) / 2) + anywhere) / s.gazeTemperature
            top = max(top, e[j])
        }
        let w8 = s.lmWeight, d = decoder, last1 = Int8(dwell - 1)
        var nNode: [Int32] = [], nSub: [Int8] = [], nScore: [Double] = [], nHist: [Int32] = [], nLast: [Int32] = []
        let guess = max(64, node.count * 3)
        nNode.reserveCapacity(guess); nSub.reserveCapacity(guess); nScore.reserveCapacity(guess)
        nHist.reserveCapacity(guess); nLast.reserveCapacity(guess)
        var at: [Int: Int32] = [:]
        at.reserveCapacity(guess)
        let floor = count == 0 ? -Double.infinity : best + top - settings.beam
        func add(_ v: Int32, _ i: Int8, _ sc: Double, _ h: Int32, _ l: Int32) {
            if sc + w8 * lookahead[Int(v)] < floor { return }
            let key = (Int(v) &* 16 &+ Int(i)) &* 262_144 &+ Int(l &+ 2)
            if let j = at[key] {
                if sc > nScore[Int(j)] { nScore[Int(j)] = sc; nHist[Int(j)] = h }
            } else {
                at[key] = Int32(nNode.count)
                nNode.append(v); nSub.append(i); nScore.append(sc); nHist.append(h); nLast.append(l)
            }
        }
        if count == 0 {
            for c in tops { add(c, 0, e[d.nodeKey[Int(c)]], -1, start) }
            if restAt != nil { add(rest, 0, e[k + 1], -1, start) }
        } else {
            var ends: [Int: (Double, Int32)] = [:]              // word id -> best score with it, its words before
            let spaceLast = Int8(max(0, dwell - 2)), sp = Int(space)
            for j in 0..<node.count {
                let v = Int(node[j]), i = sub[j], sc = score[j], h = hist[j], l = last[j]
                if v == Int(rest) {                                              // still resting: stay, or start
                    add(rest, 0, sc + e[k + 1], h, l)
                    for c in tops { add(c, 0, sc + e[d.nodeKey[Int(c)]], h, l) }
                    continue
                }
                if v == sp {                                                     // on the space bar
                    if i < spaceLast { add(space, i + 1, sc + e[k], h, l); continue }
                    add(space, i, sc + e[k], h, l)
                    for c in tops { add(c, 0, sc + e[d.nodeKey[Int(c)]], h, l) }
                    continue
                }
                let here = sc + e[d.nodeKey[v]]
                if i < last1 { add(Int32(v), i + 1, here, h, l); continue }
                add(Int32(v), i, here, h, l)                                     // stay on the key
                var c = v + 1
                while c < d.nodeEnd[v] {                                         // on to the next key
                    add(Int32(c), 0, sc + e[d.nodeKey[c]], h, l)
                    c = d.nodeEnd[c]
                }
                if d.nodePath[v] >= 0 {                                          // a word can end here
                    for w in d.pathWords[d.nodePath[v]] {
                        let total = sc + w8 * lmScore(w, after: l) - settings.wordPenalty
                        if total > (ends[w]?.0 ?? -.infinity) { ends[w] = (total, h) }
                    }
                }
            }
            for (w, (total, h)) in ends.sorted(by: { $0.value.0 > $1.value.0 }).prefix(settings.wordStarts) {
                let r = Int32(recWord.count)
                recWord.append(Int32(w)); recPrev.append(h)
                recDepth.append(h < 0 ? 1 : recDepth[Int(h)] + 1); recEnd.append(Int32(count - 1))
                for c in tops { add(c, 0, total - settings.noSpace + e[d.nodeKey[Int(c)]], r, Int32(w)) }
                add(space, 0, total + e[k], r, Int32(w))                         // or a look at the space bar first
            }
        }
        count += 1
        // Keep the guesses near the best, at most maxGuesses.
        var prune = [Double](repeating: 0, count: nNode.count)
        var b = -Double.infinity
        for j in 0..<nNode.count { prune[j] = nScore[j] + w8 * lookahead[Int(nNode[j])]; b = max(b, prune[j]) }
        var cut = b - settings.beam
        if nNode.count > settings.maxGuesses {
            cut = max(cut, prune.sorted(by: >)[settings.maxGuesses - 1])
        }
        node = []; sub = []; score = []; hist = []; last = []
        for j in 0..<nNode.count where prune[j] >= cut {
            node.append(nNode[j]); sub.append(nSub[j]); score.append(nScore[j]); hist.append(nHist[j]); last.append(nLast[j])
        }
        best = b
        return agreed()
    }

    func words(_ r: Int32, after done: Int) -> [Word] {
        var out: [Word] = [], r = r
        while r >= 0, Int(recDepth[Int(r)]) > done {
            let p = recPrev[Int(r)]
            let (word, shown) = decoder.text(Int(recWord[Int(r)]))
            out.append(Word(word: word, shown: shown, start: p >= 0 ? Int(recEnd[Int(p)]) + 1 : 0, end: Int(recEnd[Int(r)])))
            r = p
        }
        return out.reversed()
    }

    /// The words every guess still in the running shares, not handed out yet.
    func agreed() -> [Word] {
        guard var common = hist.first else { return [] }
        var seen = Set<Int32>()
        for h in hist where h != common && seen.insert(h).inserted {
            var a = common, b = h
            while a != b {
                if a < 0 || b < 0 { a = -1; break }
                let da = recDepth[Int(a)], db = recDepth[Int(b)]
                if da >= db { a = recPrev[Int(a)] }
                if db >= da { b = recPrev[Int(b)] }
            }
            common = a
            if common < 0 || Int(recDepth[Int(common)]) <= given { return [] }
        }
        guard common >= 0, Int(recDepth[Int(common)]) > given else { return [] }
        let out = words(common, after: given)
        given = Int(recDepth[Int(common)])
        return out
    }

    /// The likeliest words so far that aren't agreed yet (to show, greyed).
    public func tentative() -> [String] {
        var b = -1, bs = -Double.infinity
        for j in 0..<node.count where score[j] > bs { bs = score[j]; b = j }
        guard b >= 0 else { return [] }
        return words(hist[b], after: given).map { $0.shown }
    }

    /// The likeliest first word if it ended now: the live guess while one word is looked at (with
    /// settings.wordStarts 0, the stream holds just that one word).
    public func guess() -> String? {
        var bs = -Double.infinity, bw = -1
        for j in 0..<node.count where node[j] < space && hist[j] < 0 && Int(sub[j]) == dwell - 1
            && decoder.nodePath[Int(node[j])] >= 0 {
            for w in decoder.pathWords[decoder.nodePath[Int(node[j])]] {
                let total = score[j] + decoder.settings.lmWeight * lmScore(w, after: last[j])
                if total > bs { bs = total; bw = w }
            }
        }
        return bw >= 0 ? decoder.text(bw).shown : nil
    }

    /// The eyes left the keyboard: the likeliest ending, everything not handed out yet. Then begin() again.
    public func finish() -> [Word] {
        var bs = -Double.infinity, bw = -1, bh: Int32 = -1
        var spaceBest = -Double.infinity, spaceHist: Int32 = -1
        for j in 0..<node.count where node[j] == space && score[j] > spaceBest { spaceBest = score[j]; spaceHist = hist[j] }
        for j in 0..<node.count where node[j] < space && Int(sub[j]) == dwell - 1 && decoder.nodePath[Int(node[j])] >= 0 {
            for w in decoder.pathWords[decoder.nodePath[Int(node[j])]] {
                let total = score[j] + decoder.settings.lmWeight * lmScore(w, after: last[j]) - settings.wordPenalty
                if total > bs { bs = total; bw = w; bh = hist[j] }
            }
        }
        var out: [Word]
        if spaceBest > bs && spaceHist >= 0 {
            out = words(spaceHist, after: given)
        } else if bw >= 0 {
            out = words(bh, after: given)
            let (word, shown) = decoder.text(bw)
            out.append(Word(word: word, shown: shown, start: bh >= 0 ? Int(recEnd[Int(bh)]) + 1 : 0, end: count - 1))
        } else {
            var b = -1, s = -Double.infinity
            for j in 0..<node.count where score[j] > s { s = score[j]; b = j }
            out = b >= 0 ? words(hist[b], after: given) : []
        }
        node = []; sub = []; score = []; hist = []; last = []
        count = 0
        return out
    }
}

/// Smooths the pointer without making it lag: barely any smoothing while the eyes jump, a lot while they
/// rest on something (the "1€ filter").
public struct OneEuro {
    var minCutoff = 1.0, beta = 1.5, dCutoff = 1.0
    var value: Double? = nil, slope = 0.0, time: Double? = nil
    public init() {}
    public mutating func callAsFunction(_ v: Double, _ t: Double) -> Double {
        guard let p = value, let pt = time, t > pt else { value = v; time = t; return v }
        let dt = t - pt
        func alpha(_ cutoff: Double) -> Double { 1 / (1 + 1 / (2 * .pi * cutoff * dt)) }
        slope += alpha(dCutoff) * ((v - p) / dt - slope)
        let next = p + alpha(minCutoff + beta * abs(slope)) * (v - p)
        value = next; time = t
        return next
    }
}

/// Holds the pointer still while the eyes rest on something: it sits at the mean of the frames since they got
/// there and moves only once `confirm` frames in a row land more than `radius` keys away (and near each
/// other). The camera's frame-to-frame noise (about 0.4 keys) doesn't move it; a look elsewhere does, about
/// two frames later. On the owner's recorded typing it moved 0.18 keys a frame against 0.51 with OneEuro.
public struct FixationHold {
    // Radius 1.8 (was 1.2): the camera's gaze wanders slowly (an average of 4 frames still drifts past a
    // key), so it's the radius that stops the jumps. On the owner's setup holds, 2026-11-19, the dot
    // jumped more than half a key 0.19 times a second (0.36 at 1.2) and 0.94 (1.36) while typing
    // sentences, the same 100 ms (median) to follow a look elsewhere, and as quick onto the next key.
    public var radius = 1.8, confirm = 3, keep = 20, yScale = 1.3
    var fix: [(Double, Double)] = [], next: [(Double, Double)] = [], last = -Double.infinity
    public init() {}
    func mean(_ v: [(Double, Double)]) -> (Double, Double) {
        (v.reduce(0) { $0 + $1.0 } / Double(v.count), v.reduce(0) { $0 + $1.1 } / Double(v.count))
    }
    func far(_ a: (Double, Double), _ b: (Double, Double)) -> Bool { hypot(a.0 - b.0, (a.1 - b.1) * yScale) > radius }
    public mutating func callAsFunction(_ x: Double, _ y: Double, _ t: Double) -> (Double, Double) {
        let p = (x, y), gap = t - last
        last = t
        if fix.isEmpty || gap > 0.3 { fix = [p]; next = []; return p }
        if !far(p, mean(fix)) {
            fix.append(p)
            if fix.count > keep { fix.removeFirst() }
            next = []
        } else {
            if !next.isEmpty && far(p, mean(next)) { next = [] }
            next.append(p)
            if next.count >= confirm { fix = next; next = [] }
        }
        return mean(fix)
    }
}

// MARK: - Calibration: what the camera sees to where on the keyboard you look

/// What one camera frame says about where you're looking, before calibration.
public struct GazeFeatures {
    public var values: [Double]
    public var time: Double
    public init(values: [Double], time: Double) { self.values = values; self.time = time }
}


public struct GazeCalibration {
    var mean: [Double], scale: [Double], wx: [Double], wy: [Double]
    public var spread: (x: Double, y: Double)   // how far calibration frames land from their dots, key units

    /// The dots, in key units, one row of five per keyboard row.
    public static let targets: [(Double, Double)] = [0.5, 1.5, 2.5].flatMap { y in [0.7, 2.85, 5.0, 7.15, 9.3].map { ($0, y) } }

    public func map(_ f: [Double]) -> (Double, Double) {
        var x = wx[0], y = wy[0]
        for i in 0..<f.count {
            let z = (f[i] - mean[i]) / scale[i]
            x += wx[i + 1] * z; y += wy[i + 1] * z
        }
        return (x, y)
    }

    /// Ridge regression from features to where you looked, for x and y: the dots (each dot's least typical
    /// third of frames dropped first: blinks, looking elsewhere) and `extra` frames with where they looked
    /// (from words typed since: every typed word tunes it a little more). `spread` is how far a dot lands
    /// when it was left out of the fit, so it's how accurate it really is, not how well it remembers.
    public static func fit(_ samples: [[GazeFeatures]], targets: [(Double, Double)] = GazeCalibration.targets,
                           extra: [([Double], (Double, Double))] = [], lambda: Double = 2.0) -> GazeCalibration? {
        var rows: [[Double]] = [], tx: [Double] = [], ty: [Double] = [], group: [Int] = []
        for (k, frames) in samples.enumerated() where frames.count >= 4 && k < targets.count {
            let n = frames[0].values.count
            var median = [Double](repeating: 0, count: n), spread = median
            for i in 0..<n {
                let v = frames.map { $0.values[i] }.sorted()
                median[i] = v[v.count / 2]
                let dev = v.map { abs($0 - median[i]) }.sorted()
                spread[i] = max(1e-9, dev[dev.count / 2])
            }
            func odd(_ f: GazeFeatures) -> Double {
                var d = 0.0
                for i in 0..<n { d += abs(f.values[i] - median[i]) / spread[i] }
                return d
            }
            let kept = frames.sorted { odd($0) < odd($1) }.prefix(max(3, frames.count * 2 / 3))
            for f in kept { rows.append(f.values); tx.append(targets[k].0); ty.append(targets[k].1); group.append(k) }
        }
        let dots = Set(group).count
        guard rows.count > 30, dots >= 6 else { return nil }
        for (f, t) in extra where f.count == rows[0].count {
            rows.append(f); tx.append(t.0); ty.append(t.1); group.append(-1)
        }
        guard var cal = ridge(rows, tx, ty, lambda) else { return nil }
        // Leave each dot out in turn and see where its frames land.
        var ex = 0.0, ey = 0.0, count = 0.0
        for k in Set(group) where k >= 0 {
            let keep = group.indices.filter { group[$0] != k }
            guard let c = ridge(keep.map { rows[$0] }, keep.map { tx[$0] }, keep.map { ty[$0] }, lambda) else { continue }
            for i in group.indices where group[i] == k {
                let (px, py) = c.map(rows[i])
                ex += (px - tx[i]) * (px - tx[i]); ey += (py - ty[i]) * (py - ty[i]); count += 1
            }
        }
        cal.spread = count > 0 ? ((ex / count).squareRoot(), (ey / count).squareRoot()) : (1, 1)
        return cal
    }

    /// Ridge regression from rows of features to where the eyes were (a moving dot's path, dots, keys of
    /// typed words): fit, drop the fifth that fit worst (blinks, catch-up jumps, looking elsewhere), fit
    /// again. `groups` says which rows belong together: with `leaveOut`, `spread` is how far each group
    /// lands when it's left out of the fit (groups < 0 never are); without, how far rows land from the fit.
    /// `scales` fixes how far a feature may count, in its own units, instead of how much it varied in these
    /// rows: for head position, which moves along with a moving dot, so a free fit leans on it far more than
    /// the geometry allows and is keys off once the head moves a little.
    public static func fit(rows: [[Double]], targets: [(Double, Double)], groups: [Int], lambda: Double = 2.0,
                           leaveOut: Bool = true, scales: [Int: Double] = [:]) -> GazeCalibration? {
        guard rows.count > 30, rows.count == targets.count, rows.count == groups.count else { return nil }
        func ridge(_ rows: [[Double]], _ tx: [Double], _ ty: [Double], _ lambda: Double) -> GazeCalibration? {
            GazeCalibration.ridge(rows, tx, ty, lambda, scales: scales)
        }
        guard let first = ridge(rows, targets.map { $0.0 }, targets.map { $0.1 }, lambda) else { return nil }
        let err = rows.indices.map { i -> Double in
            let (x, y) = first.map(rows[i]); return hypot(x - targets[i].0, y - targets[i].1) }
        let cut = err.sorted()[min(err.count - 1, Int(Double(err.count) * 0.8))]
        let keep = rows.indices.filter { err[$0] <= cut }
        let r = keep.map { rows[$0] }, t = keep.map { targets[$0] }, g = keep.map { groups[$0] }
        guard var cal = ridge(r, t.map { $0.0 }, t.map { $0.1 }, lambda) else { return nil }
        var ex = 0.0, ey = 0.0, n = 0.0
        if leaveOut {
            for k in Set(g) where k >= 0 {
                let others = g.indices.filter { g[$0] != k }
                guard let c = ridge(others.map { r[$0] }, others.map { t[$0].0 }, others.map { t[$0].1 }, lambda) else { continue }
                for i in g.indices where g[i] == k {
                    let (px, py) = c.map(r[i])
                    ex += (px - t[i].0) * (px - t[i].0); ey += (py - t[i].1) * (py - t[i].1); n += 1
                }
            }
        } else {
            for i in r.indices {
                let (px, py) = cal.map(r[i])
                ex += (px - t[i].0) * (px - t[i].0); ey += (py - t[i].1) * (py - t[i].1); n += 1
            }
        }
        cal.spread = n > 0 ? ((ex / n).squareRoot(), (ey / n).squareRoot()) : (1, 1)
        return cal
    }

    static func ridge(_ rows: [[Double]], _ tx: [Double], _ ty: [Double], _ lambda: Double,
                      scales: [Int: Double] = [:]) -> GazeCalibration? {
        guard rows.count > 10 else { return nil }
        let n = rows[0].count
        let mean = (0..<n).map { i in rows.map { $0[i] }.reduce(0, +) / Double(rows.count) }
        let scale = (0..<n).map { i in scales[i] ??
            max(1e-9, (rows.map { pow($0[i] - mean[i], 2) }.reduce(0, +) / Double(rows.count)).squareRoot()) }
        let z = rows.map { r in [1.0] + (0..<n).map { (r[$0] - mean[$0]) / scale[$0] } }
        func solve(_ t: [Double]) -> [Double] {
            let m = n + 1
            var a = [[Double]](repeating: [Double](repeating: 0, count: m + 1), count: m)
            for (r, v) in zip(z, t) {
                for i in 0..<m {
                    for j in 0..<m { a[i][j] += r[i] * r[j] }
                    a[i][m] += r[i] * v
                }
            }
            for i in 1..<m { a[i][i] += lambda }
            for c in 0..<m {                                                  // Gauss-Jordan
                let p = (c..<m).max { abs(a[$0][c]) < abs(a[$1][c]) }!
                a.swapAt(c, p)
                let d = a[c][c]
                guard abs(d) > 1e-12 else { continue }
                for j in 0..<(m + 1) { a[c][j] /= d }
                for i in 0..<m where i != c {
                    let f = a[i][c]
                    if f != 0 { for j in 0..<(m + 1) { a[i][j] -= f * a[c][j] } }
                }
            }
            return a.map { $0[m] }
        }
        return GazeCalibration(mean: mean, scale: scale, wx: solve(tx), wy: solve(ty), spread: (0, 0))
    }
}
