// How many words eye-swipe typing gets wrong at a given gaze accuracy, before anyone sits in front of it:
// for each word of real sentences, a made-up gaze path (a fixation on each key, quick jumps between,
// gaze noise, a drift of the whole word, blinks, a glance in from the last word) is decoded with
// EyeSwipe.swift exactly as the keyboards do.
//
//   eyeswipe-sim --lm eyeswipe-lm.bin --sentences file.txt [--skip 0] [--count 300] [--noise 0.3,0.5,0.75]
//       [--rate 30] [--weights 0.5,1,1.5] [--temps 2,4,8] [--fixation 0.1,0.13] [--threads 4] [--seed 1] [--frequency]
//       [--rest 0|1|2] [--dwell 0.1,0.3] [--stream [--beam 10] [--penalty 0] [--blink 1 --perword] [--write-replay f]]
//
// --stream: typing with no break between words (EyeStream): each sentence is one gaze path, words are
// counted wrong by edit distance (a missed, extra or wrong word each count one). --dwell: how long each
// letter is looked at, seconds (random in that range). --blink 1 --perword: the keyboards' way, a normal
// blink after every word ends it; each word between blinks is decoded on its own, the eyes reopening about
// where they closed (--restmoves: they open somewhere else; --exactrest: the decoder is told how long they
// rest; --drift sentence: one drift a sentence, like a webcam's). --write-replay f: the gaze and blinks, to
// type through the real keyboard code with hive-eye-keyboard --test --replay f.
//
// --rest: the Mac keyboard's blink flow, where the eyes open on the last word's last key and rest there a
// moment before the next word: 1 decodes those samples as resting (as the keyboard does), 2 doesn't.
//
// Noise is in key widths: the spread of where the gaze lands around the key looked at (all of it:
// jitter, fixation miss and drift together). It prints % of words wrong with the language model, with
// word frequency only, and how often the right word is among the top 3.

import Foundation

struct Rng {
    var state: UInt64
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(1 << 53)
    }
    mutating func normal() -> Double {
        let u = max(next(), 1e-12), v = next()
        return (-2 * log(u)).squareRoot() * cos(2 * .pi * v)
    }
    mutating func range(_ a: Double, _ b: Double) -> Double { a + (b - a) * next() }
}

func arg(_ name: String, _ fallback: String) -> String {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return fallback
}

/// A made-up gaze path for a word, starting where the last word ended.
var dwellRange = (0.10, 0.30)

func gaze(for word: String, from start: (x: Double, y: Double)?, noise: Double, rate: Double, rng: inout Rng,
          rest: inout Int, fixedDrift: (Double, Double)? = nil, restFrom: (x: Double, y: Double)? = nil,
          lastFixation: UnsafeMutablePointer<(x: Double, y: Double)>? = nil) -> [GazeSample] {
    guard let path = EyeLayout.path(word) else { return [] }
    let jitter = 0.5 * noise, miss = 0.6 * noise, drift = 0.6 * noise
    var dx = drift * rng.normal(), dy = drift * rng.normal()
    if let d = fixedDrift { dx = d.0; dy = d.1 }       // --drift sentence: one drift a sentence (slow webcam drift)
    var t = 0.0
    var out: [GazeSample] = []
    func add(_ x: Double, _ y: Double) { out.append(GazeSample(x: x, y: y, t: t)); t += 1 / rate }
    if rest > 0, let s = start {                                // resting where the last word ended
        let n = max(1, Int((rng.range(0.1, 0.6) * rate).rounded()))
        var rx = s.x + dx + miss * rng.normal(), ry = s.y + dy + miss * rng.normal()
        if let f = restFrom { rx = f.x + 0.3 * miss * rng.normal(); ry = f.y + 0.3 * miss * rng.normal() }  // opening about where they closed
        for _ in 0..<n { add(rx + jitter * rng.normal(), ry + jitter * rng.normal()) }
        rest = n
    } else {
        rest = 0
    }
    if let s = start, rng.next() < 0.5 {                       // the glance in from the last word
        let c = EyeLayout.centers[path[0]]
        let n = 1 + Int(rng.next() * 3)
        for i in 0..<n {
            let f = Double(i + 1) / Double(n + 1)
            add(s.x + (c.x - s.x) * f + jitter * rng.normal(), s.y + (c.y - s.y) * f + jitter * rng.normal())
        }
    }
    var last: (Double, Double)? = nil
    for k in path {
        let c = EyeLayout.centers[k]
        let fx = c.x + dx + miss * rng.normal(), fy = c.y + dy + miss * rng.normal()
        if let l = last {                                       // a jump: ~50 ms
            let n = max(0, Int((0.05 * rate).rounded()) - 1)
            for i in 0..<n {
                let f = Double(i + 1) / Double(n + 1)
                add(l.0 + (fx - l.0) * f, l.1 + (fy - l.1) * f)
            }
        }
        let dwell = rng.range(dwellRange.0, dwellRange.1)
        let n = max(1, Int((dwell * rate).rounded()))
        for _ in 0..<n {
            if rng.next() < 0.02 {                               // a blink: anywhere
                add(rng.range(0, EyeLayout.width), rng.range(0, EyeLayout.height))
            } else {
                add(fx + jitter * rng.normal(), fy + jitter * rng.normal())
            }
        }
        last = (fx, fy)
        lastFixation?.pointee = (fx, fy)
    }
    return out
}

struct Tally { var wrong = 0, wrongFreq = 0, top3 = 0, words = 0, unknown = 0, early = 0, samples = 0, ms = 0.0, worstMs = 0.0 }

func editDistance(_ a: [String], _ b: [String]) -> Int {
    var row = Array(0...b.count)
    for i in 1...max(1, a.count) where !a.isEmpty {
        var prev = row[0]; row[0] = i
        for j in stride(from: 1, through: b.count, by: 1) {
            let cur = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
            prev = cur
        }
    }
    return a.isEmpty ? b.count : row[b.count]
}

/// Typing whole sentences with no break between words.
func stream(sentences: [[String]], data: Data, noise: Double, rate: Double, weight: Double, temp: Double,
            threads: Int, seed: UInt64, fixation: Double, beam: Double, penalty: Double, show: Int) -> Tally {
    let lock = NSLock()
    var total = Tally()
    let replayOut: FileHandle? = arg("--write-replay", "").isEmpty ? nil : {
        FileManager.default.createFile(atPath: arg("--write-replay", ""), contents: nil)
        return FileHandle(forWritingAtPath: arg("--write-replay", ""))
    }()
    DispatchQueue.concurrentPerform(iterations: threads) { part in
        let lm = try! EyeLM(data: data)
        var s = EyeSwipeDecoder.Settings()
        let jitter = 0.5 * noise, miss = 0.6 * noise, drift = 0.6 * noise
        s.sigma = max(0.25, (jitter * jitter + miss * miss + drift * drift).squareRoot())
        if let v = Double(arg("--sigma", "")) { s.sigma = v }
        if let v = Double(arg("--outlier", "")) { s.outlier = v }
        s.lmWeight = weight
        s.gazeTemperature = temp
        s.minFixation = fixation
        let st = EyeStream(decoder: EyeSwipeDecoder(lm: lm, settings: s))
        let spaceShare = Double(arg("--space", "0"))!
        st.settings.noSpace = Double(arg("--nospace", "0"))!
        let blinkShare = Double(arg("--blink", "0"))!               // a blink between words (it ends the word)
        let hybrid = CommandLine.arguments.contains("--hybrid")     // one word between blinks: decode it on its own
        let perWord = CommandLine.arguments.contains("--perword")   // every segment is one word
        let exactRest = CommandLine.arguments.contains("--exactrest")
        let realRest = !CommandLine.arguments.contains("--restmoves")  // after a blink the eyes open about where they were
        var ws = s
        ws.sigma = max(0.25, (jitter * jitter + miss * miss).squareRoot())
        ws.shiftSigma = max(0.25, 0.6 * noise)
        if let v = Double(arg("--restspread", "")) { ws.restSpread = v }
        let single = EyeSwipeDecoder(lm: lm, settings: ws)
        st.settings.beam = beam
        st.settings.wordPenalty = penalty
        st.settings.wordStarts = Int(arg("--starts", String(st.settings.wordStarts)))!
        st.settings.maxGuesses = Int(arg("--guesses", String(st.settings.maxGuesses)))!
        var tally = Tally(), shown = 0
        for (n, sentence) in sentences.enumerated() where n % threads == part {
            var rng = Rng(state: seed &+ UInt64(n) &* 7919)
            var samples: [GazeSample] = [], from: (x: Double, y: Double)? = nil
            var blinks = Set<Int>()                                   // a blink right before these samples
            var restCounts: [Int: Int] = [:]
            var fixation = (x: 0.0, y: 0.0), hadFixation = false
            let fixed: (Double, Double)? = arg("--drift", "word") == "sentence" ? (drift * rng.normal(), drift * rng.normal()) : nil
            for word in sentence {
                let blinked = !samples.isEmpty && rng.next() < blinkShare
                var rest = blinked ? 1 : 0                                  // after a blink the eyes open where they were
                let t0 = samples.last.map { $0.t + 1 / rate } ?? 0
                let before = samples.count
                let restFrom = realRest && hadFixation ? fixation : nil
                samples += gaze(for: word, from: from, noise: noise, rate: rate, rng: &rng, rest: &rest, fixedDrift: fixed,
                                restFrom: restFrom, lastFixation: &fixation).map {
                    GazeSample(x: $0.x, y: $0.y, t: $0.t + t0) }
                hadFixation = true
                if blinked { blinks.insert(before); restCounts[before] = rest }
                if let p = EyeLayout.path(word) { from = EyeLayout.centers[p.last!] }
                if word != sentence.last, rng.next() < spaceShare, let f = from {   // a look at the space bar
                    let sx = min(max(f.x, EyeLayout.space.x0 + 0.3), EyeLayout.space.x1 - 0.3) + 0.6 * noise * rng.normal()
                    let sy = EyeLayout.space.y + 0.6 * noise * rng.normal()
                    var t = samples.last!.t + 1 / rate
                    for _ in 0..<max(1, Int((rng.range(dwellRange.0, dwellRange.1) * rate).rounded())) {
                        samples.append(GazeSample(x: sx + 0.5 * noise * rng.normal(), y: sy + 0.5 * noise * rng.normal(), t: t))
                        t += 1 / rate
                    }
                    from = (sx, sy)
                }
            }
            if let out = replayOut {                                   // for hive-eye-keyboard --replay
                var lines: [Any] = [["sentence": sentence.joined(separator: " ")]]
                for (i, g) in samples.enumerated() {
                    if blinks.contains(i) { for _ in 0..<3 { lines.append(["closed": 1]) } }
                    lines.append(["x": (g.x * 1000).rounded() / 1000, "y": (g.y * 1000).rounded() / 1000])
                }
                for _ in 0..<12 { lines.append(["away": 1]) }
                let text = lines.map { String(data: try! JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! + "\n" }.joined()
                lock.lock(); out.write(Data(text.utf8)); lock.unlock()
            }
            var got: [String] = []
            func take(_ ws: [EyeStream.Word]) { got += ws.map { $0.word } }
            // Segments between blinks: each starts fresh, resting where the eyes opened.
            var cuts = blinks.sorted()
            cuts.insert(0, at: 0)
            cuts.append(samples.count)
            var resting: (x: Double, y: Double)? = nil
            for c in 0..<(cuts.count - 1) {
                let seg = Array(samples[cuts[c]..<cuts[c + 1]])
                st.begin(previous: got.last, rate: rate, resting: resting)
                let agreedBefore = got.count
                for g in seg where !perWord {
                    let began = DispatchTime.now().uptimeNanoseconds
                    take(st.push(g))
                    let ms = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e6
                    tally.ms += ms; tally.worstMs = max(tally.worstMs, ms)
                }
                tally.early += got.count - agreedBefore
                if perWord {                                            // a blink ends every word: one word a segment
                    let r = exactRest ? restCounts[cuts[c]] ?? 0 : 0
                    let began = DispatchTime.now().uptimeNanoseconds
                    if let best = single.decode(seg, previous: got.last, count: 1, rest: r, restAt: exactRest ? nil : resting).first {
                        got.append(best.word)
                    }
                    let ms = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e6
                    tally.ms += ms; tally.worstMs = max(tally.worstMs, ms)
                    let tail = seg.suffix(3)
                    resting = (tail.map { $0.x }.sorted()[tail.count / 2], tail.map { $0.y }.sorted()[tail.count / 2])
                    continue
                }
                let fin = st.finish()
                if hybrid && got.count == agreedBefore && fin.count == 1 {
                    var r = 0
                    if let p = resting { while r < seg.count, hypot(seg[r].x - p.x, seg[r].y - p.y) < 1.2 { r += 1 } }
                    let prev = agreedBefore > 0 ? got[agreedBefore - 1] : nil
                    if let best = single.decode(seg, previous: prev, count: 1, rest: r).first { got.append(best.word) } else { take(fin) }
                } else {
                    take(fin)
                }
                let tail = seg.suffix(3)
                resting = (tail.map { $0.x }.sorted()[tail.count / 2], tail.map { $0.y }.sorted()[tail.count / 2])
            }
            tally.samples += samples.count
            tally.words += sentence.count
            tally.unknown += sentence.filter { lm.id[$0] == nil }.count
            let wrong = editDistance(got, sentence)
            tally.wrong += wrong
            if wrong > 0 && shown < show {
                shown += 1
                lock.lock(); print("  \(sentence.joined(separator: " "))\n  -> \(got.joined(separator: " "))"); lock.unlock()
            }
        }
        lock.lock()
        total.wrong += tally.wrong; total.words += tally.words; total.unknown += tally.unknown
        total.early += tally.early; total.samples += tally.samples; total.ms += tally.ms
        total.worstMs = max(total.worstMs, tally.worstMs)
        lock.unlock()
    }
    return total
}

func run(sentences: [[String]], data: Data, noise: Double, rate: Double, weight: Double, temp: Double,
         threads: Int, seed: UInt64, frequencyToo: Bool, show: Int = 0, fixation: Double = 0.13, restMode: Int = 0) -> Tally {
    let lock = NSLock()
    var total = Tally()
    DispatchQueue.concurrentPerform(iterations: threads) { part in
        let lm = try! EyeLM(data: data)
        var s = EyeSwipeDecoder.Settings()
        let jitter = 0.5 * noise, miss = 0.6 * noise
        s.sigma = max(0.25, (jitter * jitter + miss * miss).squareRoot())
        s.shiftSigma = max(0.25, 0.6 * noise)
        s.lmWeight = weight
        s.gazeTemperature = temp
        s.minFixation = fixation
        if let v = Int(arg("--refine", "")) { s.refine = v }
        let dec = EyeSwipeDecoder(lm: lm, settings: s)
        var tally = Tally()
        for (n, sentence) in sentences.enumerated() where n % threads == part {
            var rng = Rng(state: seed &+ UInt64(n) &* 7919)
            var previous: String? = nil, from: (x: Double, y: Double)? = nil
            for word in sentence {
                var rest = restMode
                let samples = gaze(for: word, from: from, noise: noise, rate: rate, rng: &rng, rest: &rest)
                tally.words += 1
                if lm.id[word] == nil { tally.unknown += 1 }
                let got = dec.decode(samples, previous: previous, count: 3, rest: restMode == 1 ? rest : 0)
                if got.first?.word != word {
                    tally.wrong += 1
                    if show > 0 && tally.wrong <= show {
                        lock.lock()
                        print("  \(previous ?? "^") \(word) -> \(got.map { $0.word }.joined(separator: ", "))")
                        lock.unlock()
                    }
                }
                if !got.contains(where: { $0.word == word }) { tally.top3 += 1 }
                if frequencyToo {
                    let alone = dec.decode(samples, previous: "\u{1}", count: 1)   // unknown word before: frequency only
                    if alone.first?.word != word { tally.wrongFreq += 1 }
                }
                previous = got.first?.word ?? word
                if let p = EyeLayout.path(word) { from = EyeLayout.centers[p.last!] }
            }
        }
        lock.lock()
        total.wrong += tally.wrong; total.wrongFreq += tally.wrongFreq; total.top3 += tally.top3
        total.words += tally.words; total.unknown += tally.unknown
        lock.unlock()
    }
    return total
}

@main
struct Sim {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: arg("--lm", "eyeswipe-lm.bin")))
        let lines = try String(contentsOfFile: arg("--sentences", "sentences.txt"), encoding: .utf8).split(separator: "\n")
        let skip = Int(arg("--skip", "0"))!, count = Int(arg("--count", "300"))!
        let sentences = lines.dropFirst(skip).prefix(count).map { line in
            line.lowercased().split(separator: " ").map { String($0.filter { $0.isLetter || $0 == "'" }) }.filter { !$0.isEmpty }
        }
        let noises = arg("--noise", "0.3,0.5,0.75").split(separator: ",").map { Double($0)! }
        let weights = arg("--weights", "1").split(separator: ",").map { Double($0)! }
        let temps = arg("--temps", "4").split(separator: ",").map { Double($0)! }
        let rate = Double(arg("--rate", "30"))!, threads = Int(arg("--threads", "4"))!, seed = UInt64(arg("--seed", "1"))!
        let frequencyToo = CommandLine.arguments.contains("--frequency")
        let fixations = arg("--fixation", String(EyeSwipeDecoder.Settings().minFixation)).split(separator: ",").map { Double($0)! }
        let dw = arg("--dwell", "0.1,0.3").split(separator: ",").map { Double($0)! }
        dwellRange = (dw[0], dw[1])
        print("\(sentences.count) sentences, \(sentences.reduce(0) { $0 + $1.count }) words, \(Int(rate)) gaze samples a second, letters looked at \(dw[0])-\(dw[1]) s")
        if CommandLine.arguments.contains("--stream") {
            let beams = arg("--beam", "10").split(separator: ",").map { Double($0)! }
            let penalties = arg("--penalty", "0").split(separator: ",").map { Double($0)! }
            for noise in noises { for fix in fixations { for w in weights { for t in temps { for b in beams { for pen in penalties {
                let began = Date()
                let r = stream(sentences: sentences, data: data, noise: noise, rate: rate, weight: w, temp: t, threads: threads,
                               seed: seed, fixation: fix, beam: b, penalty: pen, show: Int(arg("--show", "0"))!)
                let pct = { (n: Int) in String(format: "%.1f%%", 100 * Double(n) / Double(max(1, r.words))) }
                print("stream: noise \(noise), fixation \(fix) s, lm weight \(w), temperature \(t), beam \(b), penalty \(pen): "
                      + "\(pct(r.wrong)) words wrong, \(pct(r.early)) out before looking away, "
                      + String(format: "%.2f ms a sample (worst %.0f ms), %.0f s", r.ms / Double(max(1, r.samples)), r.worstMs, Date().timeIntervalSince(began)))
                fflush(stdout)
            } } } } } }
            return
        }
        for noise in noises {
          for fix in fixations {
            for w in weights {
                for t in temps {
                    let began = Date()
                    let r = run(sentences: sentences, data: data, noise: noise, rate: rate, weight: w, temp: t,
                                threads: threads, seed: seed, frequencyToo: frequencyToo, show: Int(arg("--show", "0"))!,
                            fixation: fix, restMode: Int(arg("--rest", "0"))!)
                    let pct = { (n: Int) in String(format: "%.1f%%", 100 * Double(n) / Double(max(1, r.words))) }
                    var line = "noise \(noise) keys, fixation \(fix) s, lm weight \(w), temperature \(t): \(pct(r.wrong)) wrong"
                    if frequencyToo { line += ", \(pct(r.wrongFreq)) with word frequency only" }
                    line += ", right word not in top 3: \(pct(r.top3)), not in the word list: \(pct(r.unknown))"
                    line += String(format: "  (%.0f s)", Date().timeIntervalSince(began))
                    print(line)
                    fflush(stdout)
                }
            }
          }
        }
    }
}
