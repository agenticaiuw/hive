// How many words eye-swipe typing gets wrong at a given gaze accuracy, before anyone sits in front of it:
// for each word of real sentences, a made-up gaze path (a fixation on each key, quick jumps between,
// gaze noise, a drift of the whole word, blinks, a glance in from the last word) is decoded with
// EyeSwipe.swift exactly as the keyboards do.
//
//   eyeswipe-sim --lm eyeswipe-lm.bin --sentences file.txt [--skip 0] [--count 300] [--noise 0.3,0.5,0.75]
//       [--rate 30] [--weights 0.5,1,1.5] [--temps 2,4,8] [--fixation 0.1,0.13] [--threads 4] [--seed 1] [--frequency]
//       [--rest 0|1|2]
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
func gaze(for word: String, from start: (x: Double, y: Double)?, noise: Double, rate: Double, rng: inout Rng,
          rest: inout Int) -> [GazeSample] {
    guard let path = EyeLayout.path(word) else { return [] }
    let jitter = 0.5 * noise, miss = 0.6 * noise, drift = 0.6 * noise
    let dx = drift * rng.normal(), dy = drift * rng.normal()
    var t = 0.0
    var out: [GazeSample] = []
    func add(_ x: Double, _ y: Double) { out.append(GazeSample(x: x, y: y, t: t)); t += 1 / rate }
    if rest > 0, let s = start {                                // resting where the last word ended
        let n = max(1, Int((rng.range(0.1, 0.6) * rate).rounded()))
        let rx = s.x + dx + miss * rng.normal(), ry = s.y + dy + miss * rng.normal()
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
        let dwell = rng.range(0.10, 0.30)
        let n = max(1, Int((dwell * rate).rounded()))
        for _ in 0..<n {
            if rng.next() < 0.02 {                               // a blink: anywhere
                add(rng.range(0, EyeLayout.width), rng.range(0, EyeLayout.height))
            } else {
                add(fx + jitter * rng.normal(), fy + jitter * rng.normal())
            }
        }
        last = (fx, fy)
    }
    return out
}

struct Tally { var wrong = 0, wrongFreq = 0, top3 = 0, words = 0, unknown = 0 }

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
        print("\(sentences.count) sentences, \(sentences.reduce(0) { $0 + $1.count }) words, \(Int(rate)) gaze samples a second")
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
