import Foundation
import CoreGraphics
import ScreenCaptureKit

/// Screenshots of the agent's screen.
///
/// The stage's Space is always the current Space *of that display*, so its windows are genuinely
/// composited and capture returns real pixels — no occlusion workarounds needed. Per-window
/// capture uses `desktopIndependentWindow`, which is documented display- and Space-independent.
public enum Capture {

    /// A window another session currently owns on the display being captured.
    ///
    /// The last-known frame is deliberately retained. If ScreenCaptureKit cannot resolve a
    /// window whose known geometry overlaps the requested tile, capture must fail rather than
    /// silently include pixels that may belong to another agent.
    struct ForeignWindow: Sendable, Equatable {
        let sessionID: String
        let windowID: CGWindowID
        let pid: pid_t
        let frame: CGRect
    }

    /// Everything the capture layer needs to identify content owned by neighbouring sessions.
    /// Process ids cover windows created between the AX refresh and ScreenCaptureKit's snapshot;
    /// exact window identities provide the fail-closed check for already-known overlaps.
    struct ForeignContent: Sendable, Equatable {
        let windows: [ForeignWindow]
        let processIDs: Set<pid_t>

        static let none = ForeignContent(windows: [], processIDs: [])
    }

    /// Testable description of a window in ScreenCaptureKit's shareable-content snapshot.
    struct ShareableWindow: Sendable, Equatable {
        let windowID: CGWindowID
        let pid: pid_t?
        let frame: CGRect
    }

    /// Maximum allocation requested from native capture (256 MiB at four bytes per pixel).
    static let maximumPixelCount = 64 * 1_024 * 1_024

    public static func display(_ stage: Stage) async throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else { throw SpaceOError.screenRecordingDenied }
        let content = try await shareableContent()
        try Task.checkCancellation()
        guard let target = content.displays.first(where: { $0.displayID == stage.displayID }) else {
            throw SpaceOError.captureFailed("display \(stage.displayID) is not shareable")
        }
        let filter = SCContentFilter(display: target, excludingWindows: [])
        let config = SCStreamConfiguration()
        let dimensions = try boundedDimensions(
            width: Double(target.width), height: Double(target.height))
        config.width = dimensions.width
        config.height = dimensions.height
        config.showsCursor = false
        config.captureResolution = .best
        return try await capture(filter: filter, config: config,
                                 what: "display \(stage.displayID)")
    }

    /// The scale every agent-facing capture uses unless the caller asks for more detail.
    ///
    /// 1 makes an image pixel and a click coordinate the same number. The previous asymmetry —
    /// window captures hard-coded to 2× while tile captures stayed at 1× — meant an agent reading
    /// a coordinate off the default screenshot clicked at half the intended position, with no
    /// field in the response it could have used to tell the difference.
    public static let defaultScale: Double = 1

    public static func validatedScale(_ requested: Int?) throws -> Double {
        guard let requested else { return defaultScale }
        guard (1...4).contains(requested) else {
            throw SpaceOError.badRequest("capture scale must be from 1 through 4")
        }
        return Double(requested)
    }

    /// A region of one session's tile of a shared agent display.
    ///
    /// Sessions share a display, so "screenshot the screen" has to mean *this session's* screen.
    /// Capturing the whole display and cropping would leak a neighbouring agent's work into
    /// this agent's context, so the crop happens in the capture itself via `sourceRect`.
    ///
    /// `subRect` is tile-local and clamped to the tile, so a caller asking to zoom into a
    /// sub-region can never widen its view past its own tile by passing a larger rect.
    public static func region(
        _ stage: Stage,
        _ rect: CGRect,
        subRect: CGRect? = nil,
        scale: Double = defaultScale
    ) async throws -> (image: CGImage, geometry: ImageGeometry) {
        try await region(
            stage,
            rect,
            subRect: subRect,
            scale: scale,
            foreignContent: .none)
    }

    /// Session-aware region capture. Kept internal because only the session manager can prove
    /// which live processes and windows belong to the other tenants of this display.
    static func region(
        _ stage: Stage,
        _ rect: CGRect,
        subRect: CGRect? = nil,
        scale: Double = defaultScale,
        foreignContent: ForeignContent
    ) async throws -> (image: CGImage, geometry: ImageGeometry) {
        guard CGPreflightScreenCaptureAccess() else { throw SpaceOError.screenRecordingDenied }
        let content = try await shareableContent()
        try Task.checkCancellation()
        guard let target = content.displays.first(where: { $0.displayID == stage.displayID }) else {
            throw SpaceOError.captureFailed("display \(stage.displayID) is not shareable")
        }

        var captured = rect
        if let subRect {
            guard subRect.width >= 1, subRect.height >= 1,
                  subRect.origin.x.isFinite, subRect.origin.y.isFinite,
                  subRect.width.isFinite, subRect.height.isFinite else {
                throw SpaceOError.badRequest("capture region must be finite and at least 1x1")
            }
            captured = CGRect(x: rect.minX + subRect.minX, y: rect.minY + subRect.minY,
                              width: subRect.width, height: subRect.height)
                .intersection(rect)
            guard !captured.isNull, captured.width >= 1, captured.height >= 1 else {
                throw SpaceOError.badRequest(
                    "capture region \(subRect) lies outside this session's tile")
            }
        }

        // sourceRect is display-local; our rects are in global coordinates.
        let bounds = stage.bounds
        let local = CGRect(x: captured.minX - bounds.minX, y: captured.minY - bounds.minY,
                           width: captured.width, height: captured.height)
            .intersection(CGRect(origin: .zero, size: bounds.size))
        guard !local.isNull, local.width >= 1, local.height >= 1 else {
            throw SpaceOError.captureFailed("tile \(rect) is not inside display \(stage.displayID)")
        }

        let shareableWindows = content.windows.map {
            ShareableWindow(
                windowID: $0.windowID,
                pid: $0.owningApplication.map { pid_t($0.processID) },
                frame: $0.frame)
        }
        let exclusionIDs = try exclusionWindowIDs(
            capturedRect: captured,
            foreignContent: foreignContent,
            shareableWindows: shareableWindows)
        let windowsByID = Dictionary(
            content.windows.map { ($0.windowID, $0) },
            uniquingKeysWith: { first, _ in first })
        let exclusions = exclusionIDs.compactMap { windowsByID[$0] }
        guard exclusions.count == exclusionIDs.count else {
            throw SpaceOError.captureFailed(
                "foreign capture exclusions changed while the filter was being built")
        }
        let filter = SCContentFilter(display: target, excludingWindows: exclusions)
        let config = SCStreamConfiguration()
        config.sourceRect = local
        let dimensions = try boundedDimensions(
            width: local.width, height: local.height, scale: scale)
        config.width = dimensions.width
        config.height = dimensions.height
        config.showsCursor = false
        config.captureResolution = .best
        try Task.checkCancellation()
        let image = try await capture(filter: filter, config: config,
                                      what: "tile of display \(stage.displayID)")
        return (image, ImageGeometry(
            origin: "tile",
            scale: scale,
            pixelWidth: image.width,
            pixelHeight: image.height,
            pointWidth: local.width,
            pointHeight: local.height,
            originX: captured.minX,
            originY: captured.minY))
    }

    public static func window(
        _ window: WindowRef,
        scale: Double = defaultScale
    ) async throws -> (image: CGImage, geometry: ImageGeometry) {
        guard CGPreflightScreenCaptureAccess() else { throw SpaceOError.screenRecordingDenied }
        let content = try await shareableContent()
        try Task.checkCancellation()
        guard let target = content.windows.first(where: { $0.windowID == window.windowID }) else {
            throw SpaceOError.captureFailed("window \(window.windowID) is not shareable")
        }
        try validateWindowCaptureOwner(window, ownerPID: target.owningApplication.map { pid_t($0.processID) })
        try validateWindowCaptureFrame(window, frame: target.frame)
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        let dimensions = try boundedDimensions(
            width: target.frame.width, height: target.frame.height, scale: scale)
        config.width = dimensions.width
        config.height = dimensions.height
        config.showsCursor = false
        config.captureResolution = .best
        config.ignoreShadowsSingleWindow = true
        try Task.checkCancellation()
        let image = try await capture(filter: filter, config: config,
                                      what: "window \(window.windowID)")
        return (image, ImageGeometry(
            origin: "window",
            scale: scale,
            pixelWidth: image.width,
            pixelHeight: image.height,
            pointWidth: target.frame.width,
            pointHeight: target.frame.height,
            originX: target.frame.origin.x,
            originY: target.frame.origin.y,
            windowID: window.windowID))
    }

    /// Window IDs can be recycled while the shareable-content request is outstanding. Check
    /// ownership in the same snapshot used to construct the filter, including SDK-only callers
    /// that do not have SessionManager's later geometry and process validation.
    static func validateWindowCaptureOwner(_ window: WindowRef, ownerPID: pid_t?) throws {
        guard window.windowID != 0, window.pid > 0, ownerPID == window.pid else {
            throw SpaceOError.captureFailed("window ownership changed or is unavailable; discover the window again")
        }
    }

    static func validateWindowCaptureFrame(_ window: WindowRef, frame: CGRect) throws {
        guard frame == window.frame else {
            throw SpaceOError.staleGeometry("window changed before capture; refresh windows and capture again")
        }
    }

    /// Resolve the exclusion list against the same shareable-content snapshot used to construct
    /// the `SCContentFilter`. This is the privacy boundary for a shared display.
    ///
    /// A currently shareable window belonging to another session's process is excluded using its
    /// live ScreenCaptureKit frame. A known window that cannot be resolved is fatal only when its
    /// last-known frame overlaps the requested pixels; failures elsewhere on the display do not
    /// make an unrelated tile unavailable.
    static func exclusionWindowIDs(
        capturedRect: CGRect,
        foreignContent: ForeignContent,
        shareableWindows: [ShareableWindow]
    ) throws -> [CGWindowID] {
        let availableByID = Dictionary(
            shareableWindows.map { ($0.windowID, $0) },
            uniquingKeysWith: { first, _ in first })
        var excluded: Set<CGWindowID> = []

        // This also catches a window created after AgentSession.captureWindowIdentities().
        for window in shareableWindows
        where window.pid.map(foreignContent.processIDs.contains) == true
            && overlaps(window.frame, capturedRect) {
            excluded.insert(window.windowID)
        }

        var unresolved: Set<CGWindowID> = []
        for known in foreignContent.windows where known.windowID != 0 {
            guard let available = availableByID[known.windowID] else {
                if overlaps(known.frame, capturedRect) {
                    unresolved.insert(known.windowID)
                }
                continue
            }

            // Prefer the frame from the capture snapshot. If it no longer overlaps, no foreign
            // pixels can enter this sourceRect even when the cached AX frame did overlap.
            guard overlaps(available.frame, capturedRect) else { continue }
            guard available.pid == known.pid else {
                // A missing owner or recycled window id cannot prove this is the known window.
                unresolved.insert(known.windowID)
                continue
            }
            excluded.insert(known.windowID)
        }

        guard unresolved.isEmpty else {
            let ids = unresolved.sorted().map(String.init).joined(separator: ", ")
            throw SpaceOError.captureFailed(
                "could not exclude overlapping window(s) from another session: \(ids)")
        }
        return excluded.sorted()
    }

    private static func overlaps(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        guard lhs.origin.x.isFinite, lhs.origin.y.isFinite,
              lhs.width.isFinite, lhs.height.isFinite,
              rhs.origin.x.isFinite, rhs.origin.y.isFinite,
              rhs.width.isFinite, rhs.height.isFinite,
              lhs.width > 0, lhs.height > 0, rhs.width > 0, rhs.height > 0 else {
            return false
        }
        let intersection = lhs.standardized.intersection(rhs.standardized)
        return !intersection.isNull && intersection.width > 0 && intersection.height > 0
    }

    /// Validate before converting untrusted/window-server floating-point geometry to `Int` or
    /// asking ScreenCaptureKit to allocate a framebuffer.
    static func validatedDimensions(
        width: Double,
        height: Double,
        scale: Double = 1
    ) throws -> (width: Int, height: Int) {
        guard width.isFinite, height.isFinite, scale.isFinite,
              width >= 1, height >= 1, scale > 0 else {
            throw SpaceOError.captureFailed("capture dimensions must be finite and positive")
        }
        let scaledWidth = width * scale
        let scaledHeight = height * scale
        guard scaledWidth.isFinite, scaledHeight.isFinite,
              scaledWidth < Double(Int.max),
              scaledHeight < Double(Int.max) else {
            throw SpaceOError.captureFailed("capture dimensions exceed this process's integer range")
        }
        let width = max(1, Int(scaledWidth.rounded(.up)))
        let height = max(1, Int(scaledHeight.rounded(.up)))
        let (pixels, pixelOverflow) = width.multipliedReportingOverflow(by: height)
        let (_, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
        guard !pixelOverflow, !byteOverflow else {
            throw SpaceOError.captureFailed("capture pixel storage exceeds this process's integer range")
        }
        return (width, height)
    }

    /// Keep arithmetic validation reusable, but refuse excessive native framebuffer allocation.
    static func boundedDimensions(width: Double, height: Double, scale: Double = 1) throws -> (width: Int, height: Int) {
        let dimensions = try validatedDimensions(width: width, height: height, scale: scale)
        guard dimensions.width <= maximumPixelCount / dimensions.height else {
            throw SpaceOError.captureFailed("capture exceeds \(maximumPixelCount) pixels; reduce scale or capture a smaller region")
        }
        return dimensions
    }

    private static func shareableContent() async throws -> SCShareableContent {
        do {
            try Task.checkCancellation()
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            try Task.checkCancellation()
            return content
        } catch is CancellationError { throw CancellationError() }
        catch {
            throw SpaceOError.captureFailed("could not enumerate shareable content: \(error.localizedDescription)")
        }
    }

    private static func capture(filter: SCContentFilter,
                                config: SCStreamConfiguration,
                                what: String) async throws -> CGImage {
        let trace = PerformanceTrace.signposter.beginInterval("Capture.Screenshot", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Capture.Screenshot", trace) }
        do {
            try Task.checkCancellation()
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            try Task.checkCancellation()
            return image
        } catch is CancellationError { throw CancellationError() }
        catch {
            throw SpaceOError.captureFailed("\(what): \(error.localizedDescription)")
        }
    }

    // MARK: - Encoding and inspection

    @discardableResult
    public static func write(_ image: CGImage, to url: URL) throws -> URL {
        try pngData(image).write(to: url)
        return url
    }

    /// How much visual variety the image contains, 0...1.
    ///
    /// This exists so tests can assert "the window actually rendered" rather than trusting that
    /// a non-zero byte count means real content. A blank or single-colour frame scores ~0.
    public static func visualEntropy(_ image: CGImage, samples: Int = 4096) -> Double {
        guard let data = image.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else { return 0 }
        let length = CFDataGetLength(data)
        guard length > 4 else { return 0 }

        var histogram = [Int](repeating: 0, count: 256)
        let stride = max(4, (length / max(1, samples)) & ~3)
        var offset = 0
        var counted = 0
        while offset + 2 < length {
            let luma = (Int(bytes[offset]) + Int(bytes[offset + 1]) + Int(bytes[offset + 2])) / 3
            histogram[luma] += 1
            counted += 1
            offset += stride
        }
        guard counted > 0 else { return 0 }

        var entropy = 0.0
        for count in histogram where count > 0 {
            let p = Double(count) / Double(counted)
            entropy -= p * log2(p)
        }
        return entropy / 8.0
    }

    public static func looksRendered(_ image: CGImage) -> Bool {
        image.width > 8 && image.height > 8 && visualEntropy(image) > 0.02
    }
}
