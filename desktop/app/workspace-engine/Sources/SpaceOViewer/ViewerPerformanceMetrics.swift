import AppKit
import Foundation
import SpaceOKit

/// Opt-in, bounded telemetry for profiling the real Viewer. No pixel, app, session, path or
/// input content is recorded. One pending write prevents slow storage from queuing samples.
@MainActor
enum ViewerPerformanceMetrics {
    private static var timer: Timer?
    private static var writer: Writer?

    static func startIfRequested(model: ViewerModel) {
        guard let path = ProcessInfo.processInfo.environment["SPACEO_VIEWER_METRICS_FILE"],
              !path.isEmpty, path.utf8.count <= 4096, writer == nil else { return }
        let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            fputs("Viewer performance log could not be created; profiling disabled\n", stderr)
            return
        }
        let sink = Writer(handle: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true))
        writer = sink
        let started = ContinuousClock.now
        var sequence = 0
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak model] timer in
            MainActor.assumeIsolated {
                guard let model, sequence < 600 else {
                    timer.invalidate()
                    sink.finish()
                    Self.timer = nil
                    Self.writer = nil
                    return
                }
                sequence += 1
                // Explicit profiling scenario: exercise real SwiftUI surface teardown/recreation.
                if ProcessInfo.processInfo.environment["SPACEO_VIEWER_PERF_LIFECYCLE"] == "1" {
                    if ProcessInfo.processInfo.environment["SPACEO_VIEWER_PERF_MINI"] == "1" {
                        if sequence == 3 { MiniMonitorController.shared.setVisible(true, model: model) }
                        if sequence == 10 { MiniMonitorController.shared.setVisible(false, model: model) }
                    }
                    if sequence == 6 { model.showSettings(.general) }
                    if sequence == 12 { model.closeSettings() }
                }
                let usage = ProcessMetricsSnapshot.capture()
                let elapsed = started.duration(to: .now).components
                let health = model.streamHealth()
                let windows = NSApp.windows.filter { $0.isVisible }
                let knownScreens = model.displays.reduce(into: [CGDirectDisplayID: Bool]()) { $0[$1.id] = $1.isSpaceO }
                let hostedScreens = windows.map { window -> Bool? in
                    guard let number = window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
                    return knownScreens[number.uint32Value]
                }
                let sample = Sample(
                    sequence: sequence,
                    elapsedSeconds: Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18,
                    userCPUSeconds: usage.userCPUSeconds, systemCPUSeconds: usage.systemCPUSeconds,
                    residentBytes: usage.residentBytes, physicalFootprintBytes: usage.physicalFootprintBytes,
                    streamRunning: model.streamRunning,
                    screenRecordingGranted: model.permissions.screenRecording,
                    accessibilityGranted: model.permissions.accessibility,
                    hasSelectedDisplay: model.selected != nil,
                    settingsVisible: model.settingsPane != nil,
                    visibleWindows: windows.count,
                    unoccludedWindows: windows.filter { $0.occlusionState.contains(.visible) }.count,
                    frameSinks: model.performanceFrameSinkCount,
                    windowsOnSpaceODisplay: hostedScreens.filter { $0 == true }.count,
                    windowsOnPhysicalDisplay: hostedScreens.filter { $0 == false }.count,
                    windowsOnUnknownDisplay: hostedScreens.filter { $0 == nil }.count,
                    framesPerSecond: health.framesPerSecond,
                    sampleAgeSeconds: model.lastSampleAt.map { max(0, Date().timeIntervalSince($0)) })
                if var data = try? JSONEncoder().encode(sample) {
                    data.append(10)
                    sink.offer(data)
                }
            }
        }
    }

    private struct Sample: Encodable {
        let sequence: Int
        let elapsedSeconds, userCPUSeconds, systemCPUSeconds: Double
        let residentBytes, physicalFootprintBytes: UInt64
        let streamRunning, screenRecordingGranted, accessibilityGranted, hasSelectedDisplay: Bool
        let settingsVisible: Bool
        let visibleWindows, unoccludedWindows, frameSinks: Int
        let windowsOnSpaceODisplay, windowsOnPhysicalDisplay, windowsOnUnknownDisplay: Int
        let framesPerSecond, sampleAgeSeconds: Double?
    }

    private final class Writer: @unchecked Sendable {
        private let queue = DispatchQueue(label: "spaceo.viewer.performance", qos: .utility)
        private let pending = ViewerLatestValue<Data>()
        private let handle: FileHandle
        // Accessed on queue only.
        private var finished = false
        init(handle: FileHandle) { self.handle = handle }
        func offer(_ data: Data) {
            guard pending.offer(data) else { return }
            queue.async { [self] in
                guard let data = pending.take(), !finished else { return }
                do { try handle.write(contentsOf: data) }
                catch { finished = true; try? handle.close() }
            }
        }
        func finish() {
            queue.async { [self] in
                guard !finished else { return }
                finished = true
                try? handle.close()
            }
        }
    }
}
