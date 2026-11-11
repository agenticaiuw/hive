import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import SpaceOKit

protocol ViewerDisplayStreamSession: AnyObject, Sendable {
    func stop() async
    /// Re-crop a running capture to a new region of the same display without restarting it.
    /// `nil` returns to the whole display. Identity changes (another display, a different
    /// pixel size) are not crops and must go through a fresh `start`.
    func updateCrop(_ sourceRect: CGRect?) async throws
}

protocol ViewerDisplayStreaming: AnyObject, Sendable {
    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession

    /// The same start, also reporting samples that carry no new picture. ScreenCaptureKit
    /// marks those `.idle`: the capture is alive and the screen did not change. The model uses
    /// them as heartbeats so an unchanged screen is not mistaken for a stalled stream.
    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onIdle: @escaping @Sendable () -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession
}

extension ViewerDisplayStreaming {
    /// Engines without a heartbeat (test fakes) report frames only.
    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onIdle: @escaping @Sendable () -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession {
        try await start(displayID: displayID, pointSize: pointSize, sourceRect: sourceRect,
                        onFrame: onFrame, onStopped: onStopped)
    }
}

/// Creates serialized, independently stoppable ScreenCaptureKit sessions.
///
/// A session owns its callbacks. This is intentionally different from one mutable `onFrame`
/// property on the factory: if two starts complete out of order, an old stream can only call the
/// closures captured for its own display generation.
final class DisplayStream: ViewerDisplayStreaming, @unchecked Sendable {
    private let startGate = AsyncStartGate()

    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession {
        try await start(displayID: displayID, pointSize: pointSize, sourceRect: sourceRect,
                        onFrame: onFrame, onIdle: {}, onStopped: onStopped)
    }

    func start(
        displayID: CGDirectDisplayID,
        pointSize: CGSize,
        sourceRect: CGRect?,
        onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
        onIdle: @escaping @Sendable () -> Void,
        onStopped: @escaping @Sendable (Error?) -> Void
    ) async throws -> any ViewerDisplayStreamSession {
        try await startGate.acquire()
        do {
            try Task.checkCancellation()
            let content: SCShareableContent
            do {
                content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: false)
            } catch {
                throw SpaceOError.captureFailed(
                    "could not enumerate shareable content: \(error.localizedDescription)")
            }
            try Task.checkCancellation()
            guard let display = content.displays.first(where: {
                $0.displayID == displayID
            }) else {
                throw SpaceOError.captureFailed("display \(displayID) is not shareable")
            }

            let config = SCStreamConfiguration()
            let dimensions = Self.frameDimensions(
                pixelWidth: display.width,
                pixelHeight: display.height,
                fallbackPointSize: pointSize,
                sourceRect: sourceRect
            )
            config.width = dimensions.width
            config.height = dimensions.height
            if let sourceRect {
                config.sourceRect = sourceRect
            }
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.queueDepth = 6
            config.showsCursor = false

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let session = ScreenCaptureSession(
                filter: filter,
                configuration: config,
                displayPixelSize: (display.width, display.height),
                displayPointSize: pointSize,
                onFrame: onFrame,
                onIdle: onIdle,
                onStopped: onStopped
            )
            do {
                try await session.start()
                try Task.checkCancellation()
            } catch {
                await session.stop()
                throw error
            }
            await startGate.release()
            return session
        } catch {
            await startGate.release()
            throw error
        }
    }

    /// ScreenCaptureKit reports the display's real pixel dimensions. Use those verbatim: a
    /// virtual display can be 1x even when the Viewer window lives on a Retina display, so
    /// deriving pixels from AppKit points creates an oversized frame with black padding.
    static func frameDimensions(
        pixelWidth: Int,
        pixelHeight: Int,
        fallbackPointSize: CGSize,
        sourceRect: CGRect? = nil
    ) -> (width: Int, height: Int) {
        if pixelWidth > 0, pixelHeight > 0,
           let sourceRect,
           fallbackPointSize.width.isFinite, fallbackPointSize.height.isFinite,
           fallbackPointSize.width > 0, fallbackPointSize.height > 0,
           sourceRect.width.isFinite, sourceRect.height.isFinite,
           sourceRect.width > 0, sourceRect.height > 0 {
            let scaleX = Double(pixelWidth) / fallbackPointSize.width
            let scaleY = Double(pixelHeight) / fallbackPointSize.height
            return (
                max(1, Int((sourceRect.width * scaleX).rounded())),
                max(1, Int((sourceRect.height * scaleY).rounded()))
            )
        }
        if pixelWidth > 0, pixelHeight > 0 {
            return (pixelWidth, pixelHeight)
        }
        guard fallbackPointSize.width.isFinite, fallbackPointSize.height.isFinite,
              fallbackPointSize.width > 0, fallbackPointSize.height > 0,
              fallbackPointSize.width < Double(Int.max),
              fallbackPointSize.height < Double(Int.max) else {
            return (1_920, 1_080)
        }
        return (Int(fallbackPointSize.width.rounded()),
                Int(fallbackPointSize.height.rounded()))
    }
}

private final class ScreenCaptureSession: NSObject, @unchecked Sendable,
    ViewerDisplayStreamSession, SCStreamDelegate, SCStreamOutput {

    private let filter: SCContentFilter
    private let configuration: SCStreamConfiguration
    private let displayPixelSize: (width: Int, height: Int)
    private let displayPointSize: CGSize
    private let onFrame: @Sendable (CMSampleBuffer) -> Void
    private let onIdle: @Sendable () -> Void
    private let onStopped: @Sendable (Error?) -> Void
    private let sampleQueue = DispatchQueue(label: "spaceo.viewer.frames")
    private let stateLock = NSLock()
    private var stream: SCStream?

    init(filter: SCContentFilter,
         configuration: SCStreamConfiguration,
         displayPixelSize: (width: Int, height: Int),
         displayPointSize: CGSize,
         onFrame: @escaping @Sendable (CMSampleBuffer) -> Void,
         onIdle: @escaping @Sendable () -> Void,
         onStopped: @escaping @Sendable (Error?) -> Void) {
        self.filter = filter
        self.configuration = configuration
        self.displayPixelSize = displayPixelSize
        self.displayPointSize = displayPointSize
        self.onFrame = onFrame
        self.onIdle = onIdle
        self.onStopped = onStopped
    }

    /// SPAO-162. A tile that moves or resizes is the same capture with a different crop, so the
    /// running stream is reconfigured in place. ScreenCaptureKit keeps delivering frames across
    /// `updateConfiguration`, which is what stops the console flashing black every time the
    /// agent places a window.
    func updateCrop(_ sourceRect: CGRect?) async throws {
        let running: SCStream? = stateLock.withLock { stream }
        guard let running else {
            throw SpaceOError.captureFailed("the capture is not running")
        }
        let dimensions = DisplayStream.frameDimensions(
            pixelWidth: displayPixelSize.width,
            pixelHeight: displayPixelSize.height,
            fallbackPointSize: displayPointSize,
            sourceRect: sourceRect
        )
        configuration.width = dimensions.width
        configuration.height = dimensions.height
        configuration.sourceRect = sourceRect ?? .zero
        try await running.updateConfiguration(configuration)
    }

    func start() async throws {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        stateLock.withLock { self.stream = stream }
        do {
            try await stream.startCapture()
        } catch {
            stateLock.withLock {
                if self.stream === stream { self.stream = nil }
            }
            throw error
        }
    }

    func stop() async {
        let running: SCStream? = stateLock.withLock {
            defer { stream = nil }
            return stream
        }
        guard let running else { return }
        let trace = PerformanceTrace.signposter.beginInterval("Viewer.StopCapture", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Viewer.StopCapture", trace) }
        do { try await running.stopCapture() }
        catch { PerformanceTrace.signposter.emitEvent("Viewer.StopCaptureFailed") }
    }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        let isCurrent = stateLock.withLock { self.stream === stream }
        guard isCurrent, type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                  sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusValue = attachments.first?[.status] as? Int else { return }
        // An idle sample has no new picture, but it is the only evidence that a capture of an
        // unchanged screen is still running. Forward it as a heartbeat; never as a frame.
        if statusValue == SCFrameStatus.idle.rawValue {
            PerformanceTrace.signposter.emitEvent("Viewer.Idle")
            onIdle()
            return
        }
        guard statusValue == SCFrameStatus.complete.rawValue,
              CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        PerformanceTrace.signposter.emitEvent("Viewer.Frame")
        onFrame(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let wasCurrent = stateLock.withLock {
            guard self.stream === stream else { return false }
            self.stream = nil
            return true
        }
        guard wasCurrent else { return }
        onStopped(error)
    }
}

/// A cancellation-aware one-at-a-time gate. Model generations still reject stale completions,
/// but the concrete ScreenCaptureKit factory never performs two expensive start sequences at
/// once.
private actor AsyncStartGate {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
    }

    private var held = false
    private var waiters: [Waiter] = []

    func acquire() async throws {
        let id = UUID()
        let acquired = await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                if !held {
                    held = true
                    continuation.resume(returning: true)
                } else {
                    waiters.append(Waiter(id: id, continuation: continuation))
                }
            }
        }, onCancel: {
            Task { await self.cancel(id: id) }
        })
        guard acquired, !Task.isCancelled else {
            if acquired { release() }
            throw CancellationError()
        }
    }

    func release() {
        guard !waiters.isEmpty else {
            held = false
            return
        }
        let waiter = waiters.removeFirst()
        waiter.continuation.resume(returning: true)
    }

    private func cancel(id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        waiter.continuation.resume(returning: false)
    }
}
