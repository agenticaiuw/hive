import Foundation
import CoreGraphics

/// Checked allocation budgets for unattended agents. Explicit operator override can lift policy
/// limits, while integer representation and positive geometry remain mandatory.
public struct ResourceBudget: Sendable, Equatable {

    /// Live sessions across the whole daemon.
    public var maximumSessions: Int
    /// Virtual displays attached at once.
    public var maximumDisplays: Int
    /// Total framebuffer area across every SpaceO display, in pixels.

    public var maximumTotalPixels: Int
    /// Total framebuffer memory across every SpaceO display, in bytes, at 4 bytes per pixel.
    public var maximumTotalBytes: Int
    /// Display creation attempts admitted in a rolling minute, including failed allocations.
    public var maximumCreationsPerMinute: Int
    /// Technical lower bound used to keep layout geometry positive and representable.
    public var minimumTileSize: CGSize
    /// Largest edge whose square remains safely representable by this process's pixel accounting.
    public var maximumDisplayEdge: Int

    public static let bytesPerPixel = 4

    private static let representablePixels = Int.max / bytesPerPixel
    private static let representableEdge = Int(Double(representablePixels).squareRoot())

    public static let unrestricted = ResourceBudget(
        maximumSessions: Int.max,
        maximumDisplays: Int.max,
        maximumTotalPixels: representablePixels,
        maximumTotalBytes: Int.max,
        maximumCreationsPerMinute: Int.max,
        minimumTileSize: CGSize(width: 1, height: 1),
        maximumDisplayEdge: representableEdge)

    public static let `default` = ResourceBudget(
        maximumSessions: 16, maximumDisplays: 8,
        maximumTotalPixels: 67_108_864, maximumTotalBytes: 268_435_456,
        maximumCreationsPerMinute: 16, minimumTileSize: CGSize(width: 320, height: 240),
        maximumDisplayEdge: 8192)


    public init(maximumSessions: Int,
                maximumDisplays: Int,
                maximumTotalPixels: Int,
                maximumTotalBytes: Int,
                maximumCreationsPerMinute: Int,
                minimumTileSize: CGSize,
                maximumDisplayEdge: Int) {
        self.maximumSessions = maximumSessions
        self.maximumDisplays = maximumDisplays
        self.maximumTotalPixels = maximumTotalPixels
        self.maximumTotalBytes = maximumTotalBytes
        self.maximumCreationsPerMinute = maximumCreationsPerMinute
        self.minimumTileSize = minimumTileSize
        self.maximumDisplayEdge = maximumDisplayEdge
    }

    /// Explicit daemon-start override; never inferred from an agent request.
    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ResourceBudget {
        environment["SPACEO_UNRESTRICTED_RESOURCES"] == "1" ? .unrestricted : .default
    }

    public var isUnsafe: Bool { self == .unrestricted }

    // MARK: - Geometry admission

    /// Check a display size before anything is created from it.
    ///
    /// Called by the daemon at startup on CLI/environment geometry, so a typo fails at the
    /// command line with a readable message instead of at the first `session.create`.
    public func validateDisplaySize(_ size: CGSize, capacity: Int) throws -> (width: UInt32, height: UInt32) {
        guard size.width.isFinite, size.height.isFinite,
              size.width >= 1, size.height >= 1,
              size.width == size.width.rounded(), size.height == size.height.rounded(),
              let width = UInt32(exactly: size.width),
              let height = UInt32(exactly: size.height) else {
            throw SpaceOError.badRequest(
                "display size must use positive whole pixels representable by UInt32 "
                + "(got \(size.width)x\(size.height))")
        }
        guard Int(width) <= maximumDisplayEdge, Int(height) <= maximumDisplayEdge else {
            throw SpaceOError.badRequest("display edge exceeds configured limit of \(maximumDisplayEdge)")
        }
        let pixels = Int(width).multipliedReportingOverflow(by: Int(height))
        guard !pixels.overflow, pixels.partialValue <= maximumTotalPixels,
              pixels.partialValue <= Int.max / Self.bytesPerPixel else {
            throw SpaceOError.badRequest(
                "display size \(width)x\(height) cannot be represented safely by this process")
        }
        guard let tile = TileLayout.rect(in: CGRect(origin: .zero, size: size),
                                         capacity: capacity, index: 0),
              tile.width >= minimumTileSize.width, tile.height >= minimumTileSize.height else {
            throw SpaceOError.badRequest(
                "sessions per display must give each tile at least \(minimumTileSize.width)x\(minimumTileSize.height) points")
        }
        return (width, height)
    }

    // MARK: - Usage admission

    /// Everything the pool currently holds, for admission and for reporting.
    public struct Usage: Codable, Sendable, Equatable {
        public var sessions: Int
        public var displays: Int
        public var pixels: Int
        public var bytes: Int
        public var creationsInLastMinute: Int

        public init(sessions: Int = 0, displays: Int = 0, pixels: Int = 0,
                    bytes: Int = 0, creationsInLastMinute: Int = 0) {
            self.sessions = sessions
            self.displays = displays
            self.pixels = pixels
            self.bytes = bytes
            self.creationsInLastMinute = creationsInLastMinute
        }
    }

    /// Validate before acquiring a tile, including an existing display.
    ///
    /// A full pool is `resource_limit`, not `bad_request`: the call was well formed and the same
    /// call succeeds once capacity frees up. The retry time for a full pool depends on other
    /// sessions' reclamation, which only the session manager knows, so it is filled in there.
    public func admitSession(usage: Usage) throws {
        guard usage.sessions >= 0, usage.sessions < maximumSessions else {
            throw SpaceOError.resourceLimit(
                kind: .sessions,
                detail: "the session pool is full (\(usage.sessions) of \(maximumSessions) sessions in use)",
                retryAfter: nil)
        }
    }

    /// Keep aggregate accounting representable as well as each display's geometry. This is a
    /// checked arithmetic boundary as well as a configured allocation policy.
    ///
    /// `rateWindowClearsIn` is how long until the oldest creation in the rolling minute ages
    /// out; it becomes the retry hint when the creation rate is what refused the display.
    public func admitDisplay(size: CGSize, capacity: Int, usage: Usage,
                             rateWindowClearsIn: Double? = nil) throws {
        guard usage.displays >= 0, usage.displays < maximumDisplays else {
            throw SpaceOError.resourceLimit(
                kind: .displays,
                detail: "every virtual display is in use (\(usage.displays) of \(maximumDisplays) displays)",
                retryAfter: nil)
        }
        guard usage.creationsInLastMinute >= 0,
              usage.creationsInLastMinute < maximumCreationsPerMinute else {
            let retry = rateWindowClearsIn.flatMap { $0.isFinite ? min(max($0, 0), 60) : nil }
            throw SpaceOError.resourceLimit(
                kind: .creationRate,
                detail: "too many new displays in the last minute "
                    + "(\(usage.creationsInLastMinute) of \(maximumCreationsPerMinute) per minute)",
                retryAfter: retry ?? 60)
        }
        let dimensions = try validateDisplaySize(size, capacity: capacity)
        let pixels = Int(dimensions.width) * Int(dimensions.height)
        let total = usage.pixels.addingReportingOverflow(pixels)
        guard usage.pixels >= 0, !total.overflow,
              total.partialValue <= maximumTotalPixels,
              total.partialValue <= maximumTotalBytes / Self.bytesPerPixel,
              usage.bytes >= 0,
              usage.bytes <= maximumTotalBytes - pixels * Self.bytesPerPixel else {
            throw SpaceOError.badRequest(
                "total display framebuffer usage cannot be represented safely by this process")
        }
    }
}
