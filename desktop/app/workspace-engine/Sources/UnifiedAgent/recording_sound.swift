// Puts the Mac's sound into screen recordings made with macOS's own recorder (Shift-Command-5),
// which records a microphone at most and never what the Mac plays (owner, 2026-11-18, of a
// recording that came out silent: "it should be on by default ... keep it on").
//
// The recorder is left as it is. While it records, replayd writes the movie into the screencapture
// group container's ScreenRecordings folder; a new file there is the start, and Hive captures the
// Mac's sound from then on (ScreenCaptureKit, Hive's own sound left out). When the finished
// "Screen Recording ….mov" lands where the recorder saves (Desktop unless set), the sound goes in
// as an audio track at the moment the recording began, and the file is replaced in place. A
// recording trimmed before saving can't be lined up, so it's left as it is (the log says so).
//
// Hive quitting or restarting mid-recording must not lose the sound (owner, 2026-11-19, after a
// restart 12 s into a take left it silent: "why didn't it happen for my previous screen
// recording?"). So the sound is written in one-second fragments (readable even if Hive is killed)
// and the take is kept in take.json; a restarted Hive picks the same recording back up, captures
// from then on, and puts every stretch it has at its own moment. A recording already going when
// Hive starts gets the sound from then on. Hive's own task recordings (`screencapture -v` into
// ~/Movies/Hive, hive-knowledge task_recording.rs) use the same folder and are left alone.
import AVFoundation
import Foundation
@preconcurrency import ScreenCaptureKit

// Its state is only touched on `queue`.
final class RecordingSound: NSObject, SCStreamOutput, @unchecked Sendable {
    let working: URL  // where replayd writes a recording while it runs
    let saves: URL    // where the recorder puts the finished one
    let scratch: URL  // Hive's own copy of the sound, until it's in the movie
    let log: (String) -> Void
    private let queue = DispatchQueue(label: "hive.recording-sound")
    private var watchers: [DispatchSourceFileSystemObject] = []
    private var timer: DispatchSourceTimer?
    private var seen = Set<String>()       // recordings already in the working folder
    private var savedBefore = Set<String>() // movies already in the save folder
    private var hiveRecorders = Set<Int32>() // Hive's own recorders whose file was already found

    /// One stretch of captured sound. A recording has one per Hive run while it went on.
    struct Segment: Codable {
        var sound: String    // the file
        var began: Double?   // the first sample's moment (seconds since 1970); nil until it comes
    }

    /// What take.json keeps, so a restarted Hive can carry on with the same recording.
    struct Saved: Codable {
        var working: String
        var began: Double
        var segments: [Segment]
    }

    /// One recording being captured or waiting for its finished file.
    private final class Take: @unchecked Sendable {
        let working: URL
        let began: Date       // the working file's creation: the movie's first moment
        var segments: [Segment] // earlier runs' and this run's (last, while capturing)
        var writer: AVAssetWriter?
        var input: AVAssetWriterInput?
        var stream: SCStream?
        var lastSize: Int64 = -1, stillSince = Date()
        init(working: URL, began: Date, segments: [Segment]) { self.working = working; self.began = began; self.segments = segments }
    }
    private var take: Take?

    init(working: URL? = nil, saves: URL? = nil, scratch: URL? = nil, log: @escaping (String) -> Void) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        self.working = working ?? home.appendingPathComponent("Library/Group Containers/group.com.apple.screencapture/ScreenRecordings")
        self.saves = saves ?? RecordingSound.saveFolder(home: home)
        self.scratch = scratch ?? home.appendingPathComponent("Library/Caches/Hive/recording-sound")
        self.log = log
    }

    /// The recorder's save folder: its "location" setting, else the Desktop.
    static func saveFolder(home: URL) -> URL {
        if let set = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location"), !set.isEmpty {
            return URL(fileURLWithPath: (set as NSString).expandingTildeInPath, isDirectory: true)
        }
        return home.appendingPathComponent("Desktop", isDirectory: true)
    }

    private var stateFile: URL { scratch.appendingPathComponent("take.json") }

    func start() {
        queue.async { [self] in
            try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
            let all = movies(in: working)
            seen = Set(all.map(\.lastPathComponent))
            let live = all.filter { Date().timeIntervalSince(modified($0)) < 5 }
            var since: Date?  // a take carried over: movies saved after it began are still to come
            if let saved = loadState(), FileManager.default.fileExists(atPath: saved.working) {
                let file = URL(fileURLWithPath: saved.working)
                let carried = Take(working: file, began: Date(timeIntervalSince1970: saved.began), segments: saved.segments)
                carried.lastSize = size(file)
                carried.stillSince = modified(file)
                take = carried
                since = carried.began
                let going = live.contains { $0.lastPathComponent == file.lastPathComponent }
                log("recording sound: Hive restarted during a screen recording; \(going ? "capturing its sound again" : "its sound is kept for when it's saved")\n")
                if going { capture(carried) }
            } else {
                clearState()
                removeLeftovers()
                if let file = live.first(where: { !hiveOwn($0) }) {
                    log("recording sound: a screen recording was already going; capturing the Mac's sound from now on\n")
                    begin(file)
                }
            }
            savedBefore = Set(movies(in: saves).filter { since == nil || created($0) < since!.addingTimeInterval(-1) }.map(\.lastPathComponent))
            for folder in [working, saves] {
                let fd = open(folder.path, O_EVTONLY)
                guard fd >= 0 else { log("recording sound: can't watch \(folder.path)\n"); continue }
                let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: queue)
                source.setEventHandler { [weak self] in self?.look() }
                source.setCancelHandler { close(fd) }
                source.resume()
                watchers.append(source)
            }
            let tick = DispatchSource.makeTimerSource(queue: queue)
            tick.schedule(deadline: .now() + 1, repeating: 1)
            tick.setEventHandler { [weak self] in self?.look() }
            tick.resume()
            timer = tick
        }
    }

    private func movies(in folder: URL) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey])) ?? [])
            .filter { $0.pathExtension.lowercased() == "mov" && !$0.lastPathComponent.hasPrefix(".") }
    }

    private func created(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
    }

    private func modified(_ url: URL) -> Date {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? .distantPast
    }

    private func size(_ url: URL) -> Int64 {
        Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1)
    }

    /// On every change in either folder, and each second.
    private func look() {
        // A recording began: a new movie in the working folder.
        for file in movies(in: working) where !seen.contains(file.lastPathComponent) {
            seen.insert(file.lastPathComponent)
            if hiveOwn(file) { log("recording sound: \(file.lastPathComponent) is Hive's own task recording; left alone\n"); continue }
            if take == nil { begin(file) }
        }
        guard let take else { return }
        // It was saved: a new "Screen Recording …" movie in the save folder.
        for file in movies(in: saves) where !savedBefore.contains(file.lastPathComponent) {
            guard created(file) >= take.began.addingTimeInterval(-1) else { savedBefore.insert(file.lastPathComponent); continue }
            savedBefore.insert(file.lastPathComponent)
            self.take = nil
            finish(take) { [weak self] in self?.whenWritten(file) { self?.merge(take, into: file) } }
            return
        }
        // The recorder stopped long ago and nothing was saved (the thumbnail was thrown away).
        let now = size(take.working)
        if now != take.lastSize { take.lastSize = now; take.stillSince = Date() }
        if Date().timeIntervalSince(take.stillSince) > 120 {
            log("recording sound: no saved recording came; dropping its sound\n")
            self.take = nil
            finish(take) { [weak self] in self?.discard(take) }
        }
    }

    /// Whether `file` is one of Hive's own task recordings: a `screencapture -v` into ~/Movies/Hive that
    /// started just before the file did (each recorder has one file).
    private func hiveOwn(_ file: URL) -> Bool {
        let born = created(file)
        for (pid, started) in RecordingSound.hiveRecorders() where !hiveRecorders.contains(pid) {
            let after = born.timeIntervalSince(started)
            if after > -3 && after < 15 { hiveRecorders.insert(pid); return true }
        }
        return false
    }

    /// Running `screencapture -v … /Movies/Hive/…` processes and when each started.
    static func hiveRecorders() -> [(Int32, Date)] {
        let ps = Process(), out = Pipe()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-axww", "-o", "pid=,lstart=,args="]
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return [] }
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        ps.waitUntilExit()
        let when = DateFormatter()
        when.locale = Locale(identifier: "en_US_POSIX")
        when.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        var found: [(Int32, Date)] = []
        for line in text.split(separator: "\n") {
            // "  123 Thu Nov 19 19:31:38 2026     screencapture -v -C -k -x /Users/…/Movies/Hive/…/screen.mov"
            let words = line.split(separator: " ", omittingEmptySubsequences: true)
            guard words.count > 7, let pid = Int32(words[0]), words[6].hasSuffix("screencapture") else { continue }
            let args = words[6...].joined(separator: " ")
            guard args.contains(" -v"), args.contains("/Movies/Hive/"),
                  let started = when.date(from: words[1...5].joined(separator: " ")) else { continue }
            found.append((pid, started))
        }
        return found
    }

    private func begin(_ file: URL) {
        let take = Take(working: file, began: created(file), segments: [])
        self.take = take
        log("recording sound: a screen recording began; capturing the Mac's sound\n")
        capture(take)
    }

    /// Starts a new stretch of sound for `take`.
    private func capture(_ take: Take) {
        take.segments.append(Segment(sound: scratch.appendingPathComponent(UUID().uuidString + ".mov").path, began: nil))
        take.writer = nil
        take.input = nil
        save(take)
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else { throw NSError(domain: "RecordingSound", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true  // never Hive's own voice and chimes
                config.sampleRate = 48_000
                config.channelCount = 2
                config.width = 2; config.height = 2  // a screen is needed; its picture isn't
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: nil)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                try await stream.startCapture()
                queue.async { take.stream = stream }
            } catch {
                log("recording sound: couldn't capture the Mac's sound: \(error.localizedDescription)\n")
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let take, take.stream === stream || take.stream == nil, buffer.isValid, let last = take.segments.indices.last else { return }
        if take.writer == nil {
            do {
                // A QuickTime movie in one-second fragments: what's written stays readable if Hive quits.
                let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: take.segments[last].sound), fileType: .mov)
                writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000,
                ])
                input.expectsMediaDataInRealTime = true
                writer.add(input)
                guard writer.startWriting() else { throw writer.error ?? NSError(domain: "RecordingSound", code: 2) }
                let pts = buffer.presentationTimeStamp
                writer.startSession(atSourceTime: pts)
                // The sample's moment on the wall clock: now, less how long ago the host clock says it was.
                let ago = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()) - pts)
                take.segments[last].began = Date().addingTimeInterval(-max(0, ago)).timeIntervalSince1970
                take.writer = writer
                take.input = input
                save(take)
            } catch {
                log("recording sound: couldn't write the sound: \(error.localizedDescription)\n")
                return
            }
        }
        if let input = take.input, input.isReadyForMoreMediaData { input.append(buffer) }
    }

    /// Stops capturing and closes this run's sound file, then `then` (on the queue).
    private func finish(_ take: Take, then: @escaping () -> Void) {
        let stream = take.stream
        take.stream = nil
        Task {
            try? await stream?.stopCapture()
            queue.async {
                guard let writer = take.writer, writer.status == .writing else { then(); return }
                take.input?.markAsFinished()
                writer.finishWriting { [weak self] in self?.queue.async(execute: then) }
            }
        }
    }

    /// Waits until the recorder has finished writing `file` (its size steady for two seconds).
    private func whenWritten(_ file: URL, last: Int64 = -1, steady: Int = 0, then: @escaping () -> Void) {
        let now = size(file)
        if now > 0 && now == last && steady >= 2 { then(); return }
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.whenWritten(file, last: now, steady: now == last ? steady + 1 : 0, then: then)
        }
    }

    private func merge(_ take: Take, into file: URL) {
        let stretches = take.segments.compactMap { s in s.began.map { (URL(fileURLWithPath: s.sound), $0 - take.began.timeIntervalSince1970) } }
        Task {
            do {
                try await RecordingSound.addSound(stretches, to: file, recorded: take.working)
                let parts = stretches.count > 1 ? " (\(stretches.count) stretches: Hive restarted during it)" : ""
                log("recording sound: put the Mac's sound into \(file.lastPathComponent)\(parts)\n")
            } catch {
                log("recording sound: left \(file.lastPathComponent) as it was: \(error.localizedDescription)\n")
            }
            queue.async { [weak self] in self?.discard(take) }
        }
    }

    /// Deletes a finished take's sound files and take.json.
    private func discard(_ take: Take) {
        for s in take.segments { try? FileManager.default.removeItem(atPath: s.sound) }
        if self.take == nil { clearState() }
    }

    private func save(_ take: Take) {
        let saved = Saved(working: take.working.path, began: take.began.timeIntervalSince1970, segments: take.segments)
        if let data = try? JSONEncoder().encode(saved) { try? data.write(to: stateFile, options: .atomic) }
    }

    private func loadState() -> Saved? {
        guard let data = try? Data(contentsOf: stateFile) else { return nil }
        return try? JSONDecoder().decode(Saved.self, from: data)
    }

    private func clearState() { try? FileManager.default.removeItem(at: stateFile) }

    /// Sound files no take refers to (from before take.json, or a take whose movie went away).
    private func removeLeftovers() {
        for file in (try? FileManager.default.contentsOfDirectory(at: scratch, includingPropertiesForKeys: nil)) ?? []
        where ["m4a", "mov"].contains(file.pathExtension.lowercased()) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Adds the stretches of sound to the movie `file` as one audio track, each beginning at its offset
    /// (seconds into the movie) and ending where the next begins, keeping every track the movie has, and
    /// replaces the file. `recorded` is the recorder's own copy, whose length shows whether the saved
    /// one was trimmed.
    static func addSound(_ stretches: [(URL, TimeInterval)], to file: URL, recorded: URL?) async throws {
        let movie = AVURLAsset(url: file)
        let length = try await movie.load(.duration)
        if let recorded {
            let full = try? await AVURLAsset(url: recorded).load(.duration)
            if let full, full.isNumeric, abs(CMTimeGetSeconds(full) - CMTimeGetSeconds(length)) > 0.5 {
                throw NSError(domain: "RecordingSound", code: 3, userInfo: [NSLocalizedDescriptionKey: "it was trimmed before saving, so its sound can't be lined up"])
            }
        }
        let composition = AVMutableComposition()
        let whole = CMTimeRange(start: .zero, duration: length)
        for track in try await movie.load(.tracks) {
            let type = track.mediaType
            guard let into = composition.addMutableTrack(withMediaType: type, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
            try into.insertTimeRange(whole, of: track, at: .zero)
            into.preferredTransform = try await track.load(.preferredTransform)
        }
        let ordered = stretches.sorted { $0.1 < $1.1 }
        var sound: AVMutableCompositionTrack?
        for (i, (url, offset)) in ordered.enumerated() {
            let audio = AVURLAsset(url: url)
            guard let soundTrack = try? await audio.loadTracks(withMediaType: .audio).first,
                  let soundRange = try? await soundTrack.load(.timeRange), soundRange.duration > .zero else { continue }
            let at = CMTime(seconds: max(0, offset), preferredTimescale: 48_000)
            let skip = CMTime(seconds: max(0, -offset), preferredTimescale: 48_000)
            let end = i + 1 < ordered.count ? CMTime(seconds: max(0, ordered[i + 1].1), preferredTimescale: 48_000) : length
            let fits = CMTimeMinimum(soundRange.duration - skip, CMTimeMinimum(end, length) - at)
            guard fits > .zero else { continue }
            if sound == nil { sound = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }
            try sound?.insertTimeRange(CMTimeRange(start: soundRange.start + skip, duration: fits), of: soundTrack, at: at)
        }
        guard sound != nil else {
            throw NSError(domain: "RecordingSound", code: 4, userInfo: [NSLocalizedDescriptionKey: "no sound was captured"])
        }
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".\(file.deletingPathExtension().lastPathComponent).with-sound.mov")
        try? FileManager.default.removeItem(at: temporary)
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw NSError(domain: "RecordingSound", code: 5, userInfo: [NSLocalizedDescriptionKey: "macOS couldn't copy the movie"])
        }
        try await export.export(to: temporary, as: .mov)
        let created = try? file.resourceValues(forKeys: [.creationDateKey]).creationDate
        _ = try FileManager.default.replaceItemAt(file, withItemAt: temporary)
        if let created { try? FileManager.default.setAttributes([.creationDate: created], ofItemAtPath: file.path) }
    }
}
