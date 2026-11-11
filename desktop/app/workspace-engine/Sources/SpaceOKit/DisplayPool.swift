import Foundation
import CoreGraphics

/// Hands out tiles on shared agent displays, and creates a new display only when the existing
/// ones are full.
///
/// A virtual display costs the WindowServer a full framebuffer to composite, so one display per
/// agent does not scale. The pool packs `sessionsPerDisplay` sessions onto each display and
/// can retain an empty display so successive tasks reuse a stable framebuffer.
public final class DisplayPool {

    /// A tile reservation. The frame is derived from the stage's live bounds rather than
    /// cached, so it stays correct if the display arrangement shifts underneath us.
    public struct Slot: Sendable {
        public let stage: Stage
        public let index: Int
        public let capacity: Int

        public var frame: CGRect {
            TileLayout.rect(in: stage.bounds, capacity: capacity, index: index) ?? stage.bounds
        }
        public var isExclusive: Bool { capacity == 1 }
    }

    private final class Occupancy {
        let stage: Stage
        let capacity: Int
        /// Framebuffer area as *requested*, not as the display later reports it. Budget
        /// accounting must not depend on a WindowServer round trip that can fail or lag —
        /// the cost was incurred when we asked for the pixels.
        let pixels: Int
        let size: CGSize
        var taken: Set<Int> = []
        init(stage: Stage, capacity: Int, size: CGSize) {
            self.stage = stage
            self.capacity = capacity
            self.size = size
            self.pixels = Int(size.width) * Int(size.height)
        }
        var isFull: Bool { taken.count >= capacity }
        var isEmpty: Bool { taken.isEmpty }
        var free: Int? { (0..<capacity).first { !taken.contains($0) } }
    }

    /// How a `Stage` is built. Injectable so allocation behavior can be tested without asking the
    /// WindowServer for a real framebuffer.
    public typealias StageFactory = (_ name: String, _ width: UInt32, _ height: UInt32,
                                     _ hiDPI: Bool) throws -> Stage

    private var displays: [Occupancy] = []
    private var nextDisplayNumber = 0
    /// Creation timestamps inside the rate window, oldest first.
    private var recentCreations: [Date] = []
    private let stageFactory: StageFactory
    private let stageRetirer: @Sendable (Stage, TimeInterval) -> Bool
    private let retirementNow: @Sendable () -> DispatchTime
    private let lock = NSLock()

    /// How many sessions share one display. Changing it affects displays created afterwards;
    /// existing displays keep the capacity they were built with, because re-tiling underneath
    /// a running agent would move its windows out from under it.
    public private(set) var sessionsPerDisplay: Int
    public let displaySize: CGSize
    public let hiDPI: Bool
    public let budget: ResourceBudget

    public init(sessionsPerDisplay: Int = 1,
                displaySize: CGSize = CGSize(width: 1920, height: 1080),
                hiDPI: Bool = true,
                budget: ResourceBudget = .fromEnvironment(),
                stageFactory: StageFactory? = nil) {
        self.sessionsPerDisplay = max(1, sessionsPerDisplay)
        self.displaySize = displaySize
        self.hiDPI = hiDPI
        self.budget = budget
        self.stageFactory = stageFactory ?? { name, width, height, hiDPI in
            try Stage(name: name, width: width, height: height, hiDPI: hiDPI)
        }
        self.stageRetirer = { $0.invalidate(waitingForRemoval: $1) }
        self.retirementNow = { DispatchTime.now() }
    }

    init(sessionsPerDisplay: Int = 1,
         displaySize: CGSize = CGSize(width: 1920, height: 1080),
         hiDPI: Bool = true,
         budget: ResourceBudget = .fromEnvironment(),
         stageFactory: StageFactory? = nil,
         stageRetirer: @escaping @Sendable (Stage) -> Bool,
         retirementNow: @escaping @Sendable () -> DispatchTime = { DispatchTime.now() }) {
        self.sessionsPerDisplay = max(1, sessionsPerDisplay)
        self.displaySize = displaySize
        self.hiDPI = hiDPI
        self.budget = budget
        self.stageFactory = stageFactory ?? { name, width, height, hiDPI in
            try Stage(name: name, width: width, height: height, hiDPI: hiDPI)
        }
        self.stageRetirer = { stage, _ in stageRetirer(stage) }
        self.retirementNow = retirementNow
    }

    public var displayCount: Int { lock.withLock { displays.count } }
    public var sessionCount: Int { lock.withLock { displays.reduce(0) { $0 + $1.taken.count } } }
    public var stages: [Stage] { lock.withLock { displays.map(\.stage) } }

    public func setSessionsPerDisplay(_ value: Int) throws {
        guard value > 0 else {
            throw SpaceOError.badRequest("sessions per display must be a positive integer")
        }
        _ = try budget.validateDisplaySize(displaySize, capacity: value)
        lock.withLock { sessionsPerDisplay = value }
    }

    // MARK: - Allocation

    /// Reserve a tile, reusing a display that has room before making a new one.
    ///
    /// Allocation runs under one lock so concurrent callers receive distinct slots/displays.
    public func allocate() throws -> Slot {
        lock.lock()
        defer { lock.unlock() }

        // Failed retirement retains an occupancy for cleanup, but its backing display has
        // already been invalidated. Never hand that unusable tile to a new session.
        if let existing = displays.first(where: { !$0.isFull && $0.stage.isValid }),
           let index = existing.free {
            try existing.stage.requireAllocationReady()
            try budget.admitSession(usage: usageLocked())
            existing.taken.insert(index)
            return Slot(stage: existing.stage, index: index, capacity: existing.capacity)
        }

        pruneCreationWindowLocked()
        try budget.admitSession(usage: usageLocked())
        let dimensions = try budget.validateDisplaySize(displaySize, capacity: sessionsPerDisplay)
        try budget.admitDisplay(size: displaySize,
                                capacity: sessionsPerDisplay,
                                usage: usageLocked(),
                                rateWindowClearsIn: rateWindowClearsInLocked())

        nextDisplayNumber = nextDisplayNumber == Int.max ? 1 : nextDisplayNumber + 1
        recentCreations.append(Date())
        let stage = try stageFactory("SpaceO display \(nextDisplayNumber)",
                                     dimensions.width, dimensions.height, hiDPI)
        try stage.requireAllocationReady()
        AgentActivity.claim(spaces: stage.retirementSpaces)

        let occupancy = Occupancy(stage: stage,
                                  capacity: sessionsPerDisplay,
                                  size: CGSize(width: Int(dimensions.width), height: Int(dimensions.height)))
        occupancy.taken.insert(0)
        displays.append(occupancy)
        return Slot(stage: stage, index: 0, capacity: occupancy.capacity)
    }

    /// Reserve a whole new display for one session, optionally at a caller-chosen size.
    ///
    /// Presets (`exclusive`, `exclusive_1080p`, `exclusive_1440p`) map here. The geometry goes
    /// through the same representability and budget checks as the pool's own size, and a
    /// preset the budget cannot admit is refused with the pool's usage — never downgraded to a
    /// shared tile, because an agent that asked for its own 1080p display for a canvas app
    /// would then silently get a quarter of one.
    public func allocateExclusive(size requested: CGSize? = nil) throws -> Slot {
        lock.lock()
        defer { lock.unlock() }
        let size = requested ?? displaySize
        pruneCreationWindowLocked()
        try budget.admitSession(usage: usageLocked())
        let dimensions = try budget.validateDisplaySize(size, capacity: 1)
        // An empty single-session display of the same size, kept warm after its last session
        // ended, is exactly what was asked for. Building another one instead let a create/destroy
        // loop exhaust the display budget with idle framebuffers before the grace retired them.
        let validatedSize = CGSize(width: Int(dimensions.width), height: Int(dimensions.height))
        if let idle = displays.first(where: {
            $0.isEmpty && $0.capacity == 1 && $0.size == validatedSize && $0.stage.isValid
        }) {
            try idle.stage.requireAllocationReady()
            idle.taken.insert(0)
            return Slot(stage: idle.stage, index: 0, capacity: 1)
        }
        try budget.admitDisplay(size: size, capacity: 1, usage: usageLocked(),
                                rateWindowClearsIn: rateWindowClearsInLocked())
        nextDisplayNumber = nextDisplayNumber == Int.max ? 1 : nextDisplayNumber + 1
        recentCreations.append(Date())
        let stage = try stageFactory("SpaceO display \(nextDisplayNumber)",
                                     dimensions.width, dimensions.height, hiDPI)
        try stage.requireAllocationReady()
        AgentActivity.claim(spaces: stage.retirementSpaces)
        let occupancy = Occupancy(stage: stage, capacity: 1,
                                  size: validatedSize)
        occupancy.taken.insert(0)
        displays.append(occupancy)
        return Slot(stage: stage, index: 0, capacity: 1)
    }

    /// Session presets, in the order help and schemas list them.
    public static let presets = ["shared", "exclusive", "exclusive_1080p", "exclusive_1440p"]

    /// The display geometry a session preset asks for. `shared` is the pool default (nil).
    public static func presetSize(_ preset: String) throws -> CGSize?? {
        switch preset {
        case "shared": return .some(nil)
        case "exclusive": return .some(nil)
        case "exclusive_1080p": return .some(CGSize(width: 1920, height: 1080))
        case "exclusive_1440p": return .some(CGSize(width: 2560, height: 1440))
        default:
            throw SpaceOError.badRequest("preset must be " + alternatives(presets))
        }
    }

    // MARK: - Budget accounting

    public func usage() -> ResourceBudget.Usage {
        lock.withLock {
            pruneCreationWindowLocked()
            return usageLocked()
        }
    }

    private func usageLocked() -> ResourceBudget.Usage {
        let pixels = displays.reduce(0) { $0 + $1.pixels }
        return ResourceBudget.Usage(
            sessions: displays.reduce(0) { $0 + $1.taken.count },
            displays: displays.count,
            pixels: pixels,
            bytes: pixels * ResourceBudget.bytesPerPixel,
            creationsInLastMinute: recentCreations.count)
    }

    private func rateWindowClearsInLocked() -> Double? {
        recentCreations.min().map { max(0, $0.addingTimeInterval(60).timeIntervalSinceNow) }
    }

    private func pruneCreationWindowLocked() {
        let cutoff = Date().addingTimeInterval(-60)
        recentCreations.removeAll { $0 < cutoff }
    }

    /// With `retainEmpty`, an empty display remains fenced and available for immediate reuse
    /// until `retireEmptyDisplays()` or `releaseAll()` is called.
    @discardableResult
    public func release(_ slot: Slot, retainEmpty: Bool = false) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let position = displays.firstIndex(where: { $0.stage === slot.stage }) else {
            return true
        }
        let occupancy = displays[position]
        let wasReserved = occupancy.taken.remove(slot.index) != nil
        guard occupancy.isEmpty else { return true }
        if retainEmpty {
            // Empty occupancies are ordered by their last transition to idle. Keeping the
            // oldest-created display forever made a newly used geometry attach and retire
            // again on every later task. Duplicate releases must not change that recency.
            if wasReserved {
                displays.remove(at: position)
                displays.append(occupancy)
            }
            return true
        }

        guard retire(occupancy) else { return false }
        displays.remove(at: position)
        return true
    }

    @discardableResult
    public func retireEmptyDisplays(keeping retainedCount: Int = 0) -> [CGDirectDisplayID] {
        lock.lock()
        defer { lock.unlock() }
        let empty = displays.filter(\.isEmpty)
        let retained = Set(empty.filter { $0.stage.isValid }
            .suffix(max(0, retainedCount)).map { ObjectIdentifier($0.stage) })
        let retiring = empty.filter { !retained.contains(ObjectIdentifier($0.stage)) }
        let (retiredStages, stillAttached) = retireEach(retiring)
        displays.removeAll {
            retiredStages.contains(ObjectIdentifier($0.stage))
        }
        return stillAttached
    }

    /// Retire one display now, once it has no tenants.
    ///
    /// - Returns: nil when the pool has no such display, false when it still has tenants or its
    ///   backing display refused to detach (it stays in the pool so a retry can find it), true
    ///   once it is gone.
    public func retireDisplay(_ displayID: CGDirectDisplayID) -> Bool? {
        lock.lock()
        defer { lock.unlock() }
        guard let position = displays.firstIndex(where: { $0.stage.displayID == displayID }) else {
            return nil
        }
        let occupancy = displays[position]
        guard occupancy.isEmpty, retire(occupancy) else { return false }
        displays.remove(at: position)
        return true
    }

    /// Tear down everything. Used on daemon shutdown.
    @discardableResult
    public func releaseAll() -> [CGDirectDisplayID] {
        lock.lock()
        defer { lock.unlock() }
        // Direct pool users call this after destroying their sessions and do not release every
        // slot individually. Mark those reservations empty, but retain any display whose actual
        // invalidation still fails so a later releaseAll can retry it.
        for occupancy in displays { occupancy.taken.removeAll() }
        let (retiredStages, stillAttached) = retireEach(displays)
        displays.removeAll {
            retiredStages.contains(ObjectIdentifier($0.stage))
        }
        // Keep recent creation timestamps so churn telemetry survives a release/create cycle.
        return stillAttached
    }

    /// Retire each display, reporting the ids of the ones that refused to go.
    ///
    /// The id is captured *before* the attempt. Retirement asks the backing display object to
    /// drop its display, which zeroes its id whether or not the WindowServer actually detached
    /// it — so a failure read back afterwards names display `0`, which is nothing an operator
    /// can act on and nothing teardown verification can match against the online display list.
    private func retireEach(
        _ occupancies: [Occupancy]
    ) -> (retired: Set<ObjectIdentifier>, stillAttached: [CGDirectDisplayID]) {
        var retired: Set<ObjectIdentifier> = []
        var stillAttached: [CGDirectDisplayID] = []
        // One aggregate pass leaves five seconds of dispatch/heartbeat headroom against the
        // shortest controller lease. A deferred owner stops this pass, never an N×timeout loop.
        let deadline = retirementNow() + .seconds(25)
        for (index, occupancy) in occupancies.enumerated() {
            let now = retirementNow().uptimeNanoseconds
            let remaining = deadline.uptimeNanoseconds > now
                ? Double(deadline.uptimeNanoseconds - now) / 1e9 : 0
            guard remaining >= 10 else {
                stillAttached.append(contentsOf: occupancies[index...].map { $0.stage.displayID })
                break
            }
            let displayID = occupancy.stage.displayID
            if retire(occupancy, timeout: remaining) {
                retired.insert(ObjectIdentifier(occupancy.stage))
            } else {
                stillAttached.append(displayID)
                stillAttached.append(contentsOf: occupancies.dropFirst(index + 1).map { $0.stage.displayID })
                break
            }
        }
        return (retired, stillAttached.sorted())
    }

    private func retire(_ occupancy: Occupancy, timeout: TimeInterval = 25) -> Bool {
        // Cleanup must not enter an unbounded SkyLight query before Stage's bounded retirement.
        let spaces = occupancy.stage.retirementSpaces
        guard stageRetirer(occupancy.stage, timeout) else { return false }
        AgentActivity.release(spaces: spaces)
        return true
    }

    // MARK: - Reporting

    public struct DisplayReport: Codable, Sendable {
        public var displayID: UInt32
        public var x: Double, y: Double, width: Double, height: Double
        public var capacity: Int
        public var used: Int
        public var spaces: [UInt64]
    }

    public func report() -> [DisplayReport] {
        // Copy mutable occupancy values under the pool lock. Copying only class references
        // left `taken.count` racing allocation/release after the lock had been released.
        let snapshot = lock.withLock {
            displays.map { (stage: $0.stage, capacity: $0.capacity, used: $0.taken.count) }
        }
        return snapshot.map { occupancy in
            let bounds = occupancy.stage.bounds
            return DisplayReport(displayID: occupancy.stage.displayID,
                                 x: bounds.origin.x, y: bounds.origin.y,
                                 width: bounds.width, height: bounds.height,
                                 capacity: occupancy.capacity,
                                 used: occupancy.used,
                                 spaces: occupancy.stage.spaces)
        }
    }
}
