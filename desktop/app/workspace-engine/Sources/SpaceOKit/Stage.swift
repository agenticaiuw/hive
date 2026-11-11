import Foundation
import CoreGraphics
import SpaceOPrivate

protocol StageDisplayBacking: AnyObject {
    var displayID: CGDirectDisplayID { get }
    var valid: Bool { get }
    var bounds: CGRect { get }
    var pixelWidth: Int? { get }
    func invalidate()
}

extension StageDisplayBacking {
    var pixelWidth: Int? { nil }
}

extension SPOVirtualDisplay: StageDisplayBacking {
    var pixelWidth: Int? { valid ? CGDisplayPixelsWide(displayID) : nil }
}

/// The agent's screen: a headless virtual display the user never sees.
///
/// Why a display and not a Space — a window on an inactive Space is officially "not visible"
/// and macOS tells apps to stop drawing (and Electron AX trees go stale). A window on a second
/// display's active Space renders normally, so every standard API just works. See FINDINGS.md §2.
///
/// Creation refuses an unsafe or unreadable display graph. Lifecycle waits are bounded and
/// permanently stop subsequent mutations after a timeout; a stuck OS call is not cancelled.
/// A stage may be read by capture tasks while lifecycle work runs elsewhere. Immutable metadata
/// is freely shared; every access to the mutable backing display and invalidation flags is
/// serialized by `stateLock`.
public final class Stage: @unchecked Sendable {

    /// Public CoreGraphics state that adding or removing a SpaceO display must not change for
    /// any of the user's existing monitors. Capture it around each lifecycle mutation instead
    /// of assuming WindowServer preserved topology, mirroring, scale, rotation, or refresh.
    struct UserDisplayConfiguration: Equatable, Sendable {
        struct Display: Equatable, Sendable {
            let id: CGDirectDisplayID
            let active: Bool
            let main: Bool
            let bounds: CGRect
            let pixelWidth: Int
            let pixelHeight: Int
            let rotation: Double
            let mirroredTo: CGDirectDisplayID
            let modeWidth: Int
            let modeHeight: Int
            let modePixelWidth: Int
            let modePixelHeight: Int
            let refreshRate: Double
        }

        let displays: [Display]

        func changes(from expected: UserDisplayConfiguration) -> [String] {
            let expectedByID = Dictionary(
                uniqueKeysWithValues: expected.displays.map { ($0.id, $0) })
            let actualByID = Dictionary(uniqueKeysWithValues: displays.map { ($0.id, $0) })
            var changes: [String] = []
            let expectedIDs = Set(expectedByID.keys)
            let actualIDs = Set(actualByID.keys)
            let missing = expectedIDs.subtracting(actualIDs).sorted()
            let added = actualIDs.subtracting(expectedIDs).sorted()
            if !missing.isEmpty { changes.append("user display(s) went offline: \(missing)") }
            if !added.isEmpty { changes.append("user display(s) appeared: \(added)") }
            for id in expectedIDs.intersection(actualIDs).sorted() {
                guard let expectedDisplay = expectedByID[id],
                      let actualDisplay = actualByID[id],
                      expectedDisplay != actualDisplay else { continue }
                var fields: [String] = []
                if expectedDisplay.active != actualDisplay.active { fields.append("active state") }
                if expectedDisplay.main != actualDisplay.main { fields.append("main-display role") }
                if expectedDisplay.bounds != actualDisplay.bounds { fields.append("bounds") }
                if expectedDisplay.pixelWidth != actualDisplay.pixelWidth
                    || expectedDisplay.pixelHeight != actualDisplay.pixelHeight {
                    fields.append("pixel dimensions")
                }
                if expectedDisplay.rotation != actualDisplay.rotation { fields.append("rotation") }
                if expectedDisplay.mirroredTo != actualDisplay.mirroredTo {
                    fields.append("mirroring")
                }
                // CoreGraphics republishes a synthetic mode for an inactive mirror follower
                // whenever another display attaches. The active mirror master, its geometry,
                // and the follower's mirror relationship are the effective user settings; the
                // follower's transient independent mode is neither selected nor visible.
                let stableInactiveMirrorFollower = !expectedDisplay.active
                    && !actualDisplay.active
                    && expectedDisplay.mirroredTo != 0
                    && expectedDisplay.mirroredTo == actualDisplay.mirroredTo
                if !stableInactiveMirrorFollower {
                    if expectedDisplay.modeWidth != actualDisplay.modeWidth
                        || expectedDisplay.modeHeight != actualDisplay.modeHeight
                        || expectedDisplay.modePixelWidth != actualDisplay.modePixelWidth
                        || expectedDisplay.modePixelHeight != actualDisplay.modePixelHeight {
                        fields.append("display mode")
                    }
                    if expectedDisplay.refreshRate != actualDisplay.refreshRate {
                        fields.append("refresh rate")
                    }
                }
                if !fields.isEmpty {
                    changes.append("user display \(id) changed \(fields.joined(separator: ", "))")
                }
            }
            return changes
        }
    }

    /// Process-wide display ownership is mutable, but never accessed without this holder's lock.
    private final class OwnershipState: @unchecked Sendable {
        let lock = NSLock()
        var displayIDs: Set<CGDirectDisplayID> = []
    }

    /// Teardown owns the display reference after `Stage.deinit` begins. The wrapper makes that
    /// one-way transfer explicit: the serial lifecycle queue is its only remaining accessor.
    private final class PendingInvalidation: @unchecked Sendable {
        let display: any StageDisplayBacking
        let displayID: CGDirectDisplayID
        let onlineDisplayIDs: @Sendable () throws -> [CGDirectDisplayID]
        private let lock = NSLock()
        private var started = false
        private var confirmed = false
        var removalConfirmed: Bool { lock.withLock { confirmed } }
        func markRemovalConfirmed() { lock.withLock { confirmed = true } }
        var mutationStarted: Bool { lock.withLock { started } }
        func markMutationStarted() { lock.withLock { started = true } }

        init(
            display: any StageDisplayBacking,
            displayID: CGDirectDisplayID,
            onlineDisplayIDs: @escaping @Sendable () throws -> [CGDirectDisplayID]
        ) {
            self.display = display
            self.displayID = displayID
            self.onlineDisplayIDs = onlineDisplayIDs
        }
    }

    private static let lease = DisplayLifecycleLease()
    private static let lifecycle = DisplayLifecycleCoordinator(onFailure: { reason in
        lease.trip(reason)
        DaemonLog.shared.event("display.safety.tripped", ["reason": reason])
    }, onSlowQuery: { seconds in
        // A slow geometry read keeps the last verified snapshot; it is not a graph change.
        DaemonLog.shared.event("display.query.slow", ["deadlineSeconds": String(seconds)])
    })
    private static let ownership = OwnershipState()
    private static let identities = DisplayIdentityAllocator.shared
    private static let identityNotRetired =
        "; its display identity could not be retired in display-identities.json and may be offered again after a restart"
    private static let hostHealth = DisplayHostHealth(onFailure: { reason in lifecycle.trip(reason) })

    /// Status reads never start sampling or touch the display server.
    public static func runtimeHostHealthReport() -> DisplayHostHealthReport { hostHealth.report }

    static func checkActiveHostHealth() throws {
        try lifecycle.check()
        if hostHealth.hasStarted { try hostHealth.requireHealthy() }
    }

    /// A known pressure refusal may clear after sustained fresh observations. A lifecycle
    /// circuit failure must still stop background work instead of being retried.
    static func isRecoveringTransientResources() -> Bool {
        lifecycle.failureReason == nil && hostHealth.isRecoveringTransientResources
    }

    /// Evaluated once, like the lease and host-health monitor this process constructs.
    private static let creationRateTestingOverride = DisplayTestingPolicy.enabled()

    /// Includes in-memory circuit failures even if the asynchronous journal write is stalled.
    public static func displaySafetyStatus() -> DisplaySafetyStatus {
        if let reason = lifecycle.failureReason { return reportedSafety(.init(state: .blocked, reason: reason)) }
        return reportedSafety(DisplayLifecycleLease.status())
    }

    /// Socket responses must never perform journal I/O or wait for the journal owner's mutex.
    /// Nil means no owner has observed the journal yet; there is no status to annotate.
    public static func runtimeDisplaySafetyStatus() -> DisplaySafetyStatus? {
        if let reason = lifecycle.failureReason { return reportedSafety(.init(state: .blocked, reason: reason)) }
        if let cached = lease.cachedStatus { return reportedSafety(cached) }
        guard !lifecycle.deferredRetirementDisplayIDs.isEmpty else { return nil }
        return reportedSafety(.init(state: .unknown))
    }

    private static func reportedSafety(_ status: DisplaySafetyStatus) -> DisplaySafetyStatus {
        reportedSafety(status, coordinator: lifecycle, testingOverride: creationRateTestingOverride)
    }

    /// Diagnostic evidence records the creation-rate bypass whichever path produced a status:
    /// the in-memory circuit, the owner's cache or a read-only journal inspection.
    static func reportedSafety(_ status: DisplaySafetyStatus, coordinator: DisplayLifecycleCoordinator,
                               testingOverride: Bool) -> DisplaySafetyStatus {
        coordinator.annotatingDeferredRetirements(
            DisplayLifecycleLease.annotating(status, testingOverride: testingOverride))
    }

    /// XCTest's first recorded live failure also stops focused reruns through the shared latch.
    static func stopLiveDisplayWork() {
        lifecycle.trip("live integration test failed; do not continue or automatically rerun")
    }

    static func beginLiveTestCase() throws {
        try lifecycle.perform(timeout: 10) { _ in
            try lease.acquire()
            try lease.beginLiveTest()
        }
    }

    static func finishLiveTestCase() throws {
        try lifecycle.perform(timeout: 10) { _ in try lease.finishLiveTest() }
    }

    static func liveTestUserConfiguration() throws -> UserDisplayConfiguration {
        try lifecycle.perform(timeout: 1) { _ in try checkedUserDisplayConfiguration() }
    }

    static func liveTestOnlineDisplayIDs() throws -> [CGDirectDisplayID] {
        try lifecycle.perform(timeout: 10) { _ in try checkedOnlineDisplayIDs() }
    }
    private let backing: any StageDisplayBacking
    private let onlineDisplayIDsProvider: @Sendable () throws -> [CGDirectDisplayID]
    private let configurationProvider: @Sendable () throws -> UserDisplayConfiguration?
    private let reconfigurationReadiness: @Sendable (TimeInterval) throws -> Void
    private let reconfigurationCheck: @Sendable () throws -> Void
    private let retirementNow: @Sendable () -> DispatchTime
    private let fallbackRetirementCompletion: (@Sendable () -> Void)?
    private let mutationLease: DisplayLifecycleLease?
    private let mutationMarkerDidPersist: (@Sendable () -> Void)?
    private let coordinator: DisplayLifecycleCoordinator
    private let usesLiveLease: Bool
    let retirementSpaces: [UInt64]
    private let stateLock = NSLock()
    private var cachedBounds: CGRect
    private var cachedScale: Double?
    private var cachedSpaces: [UInt64]
    private var didInvalidate = false
    private var retirementConfirmed = false
    private var retirementInProgress = false
    private var invalidatedDisplayID: CGDirectDisplayID = 0
    public var backingScale: Double? {
        stateLock.withLock {
            guard !didInvalidate, coordinator.failureReason == nil else { return nil }
            do {
                cachedScale = try coordinator.perform(timeout: 1, retaining: backing, onlyWhenIdle: true, readOnly: true) { [backing] _ in
                    let width = backing.bounds.width
                    guard let pixels = backing.pixelWidth, pixels > 0, width > 0 else { return nil }
                    return Double(pixels) / Double(width)
                }
            } catch is DisplayLifecycleCoordinator.QueryDeferred { /* Use the last verified snapshot. */ }
            catch { return nil }
            return cachedScale
        }
    }
    public let identity = UUID()
    public let name: String
    public let requestedSize: CGSize

    /// The display this stage owns — or, once teardown has begun, the one it last owned.
    ///
    /// The shim drops its display id the instant `invalidate()` is called, long before the
    /// WindowServer has actually detached the framebuffer. Reading straight through to it after
    /// a *failed* retirement therefore reports `0`, which names no display an operator can act
    /// on and is indistinguishable from "already gone" to every retirement check. Keep reporting
    /// the id we owned; `isValid` is the separate question of whether it is still ours.
    public var displayID: CGDirectDisplayID {
        stateLock.withLock {
            didInvalidate ? invalidatedDisplayID : backing.displayID
        }
    }
    public var isValid: Bool {
        stateLock.withLock { !didInvalidate && coordinator.failureReason == nil && backing.valid }
    }
    var hasLifecycleFailure: Bool { coordinator.failureReason != nil }
    /// Global-coordinate rect of the agent's screen.
    public var bounds: CGRect {
        stateLock.withLock {
            guard !didInvalidate, coordinator.failureReason == nil else { return .zero }
            do {
                cachedBounds = try coordinator.perform(timeout: 1, retaining: backing, onlyWhenIdle: true, readOnly: true) { [backing] _ in
                    backing.bounds
                }
            } catch is DisplayLifecycleCoordinator.QueryDeferred { /* A mutation owns the worker. */ }
            catch { return .zero }
            return cachedBounds
        }
    }

    public init(name: String, width: UInt32 = 1920, height: UInt32 = 1080, hiDPI: Bool = true) throws {
        guard width > 0, height > 0 else {
            throw SpaceOError.badRequest("display width and height must be positive")
        }
        guard SPOCapabilityAvailable(.virtualDisplay) else {
            throw SpaceOError.stageCreationFailed(
                SPOCapabilityUnavailableReason(.virtualDisplay)
                    ?? "virtual-display is unavailable on this host"
            )
        }
        // A Stage lost during deferred fallback cleanup no longer has a pool retry owner.
        // Refuse another framebuffer until its retained ownership is explicitly resolved.
        try Self.lifecycle.requireNoDeferredRetirements()
        // Acquire the persistent owner before sampling so refusal survives a daemon restart.
        // Sampling stays outside the display worker and its mutation deadline.
        try Self.lifecycle.perform(timeout: 2) { _ in try Self.lease.acquire() }
        do { try Self.hostHealth.requireSettledForReconfiguration(timeout: 15) }
        catch let refusal as DisplayHostHealth.ReconfigurationSettlingRefusal { throw refusal.underlyingError }
        let published: (SPOVirtualDisplay, [UInt64], CGRect, Double?) = try Self.lifecycle.perform(timeout: 10) { operation in
            try Self.lifecycle.requireNoDeferredRetirements()
            try Self.lease.acquire()
            try operation.check()
            let userConfigurationBefore: UserDisplayConfiguration
            let online: [CGDirectDisplayID]
            do {
                userConfigurationBefore = try Self.checkedUserDisplayConfiguration()
                online = try Self.checkedOnlineDisplayIDs()
            } catch {
                Self.lifecycle.trip("pre-creation display inventory failed")
                throw error
            }
            if let failure = Self.admissionFailure(
                configuration: userConfigurationBefore,
                foreignDisplayIDs: online.filter { Self.isSpaceODisplay($0) }
                    .filter { id in !Self.ownership.lock.withLock { Self.ownership.displayIDs.contains(id) } }) {
                throw SpaceOError.stageCreationFailed(failure)
            }
            // On this Mac an attachment can reset the single built-in display's selected
            // mode. Keep the exact pre-attachment mode and restore it before publication.
            let mainDisplay = CGMainDisplayID()
            let savedMainMode = userConfigurationBefore.displays.count == 1
                ? CGDisplayCopyDisplayMode(mainDisplay) : nil
            // A bounded identity, never a fresh one per attachment (RA-057). Every slot busy means
            // 32 live displays of this geometry; refuse rather than mint an unbounded identity.
            let onlineSerials = Set(online.map { CGDisplaySerialNumber($0) })
            let claimed: DisplayIdentityAllocator.Identity?
            do {
                claimed = try Self.identities.claim(width: width, height: height, hiDPI: hiDPI,
                                                    onlineSerials: onlineSerials)
            } catch {
                throw SpaceOError.stageCreationFailed(error.localizedDescription)
            }
            guard let identity = claimed else {
                throw SpaceOError.stageCreationFailed(
                    "every display identity for \(width)x\(height) is in use; release a display first")
            }
            // Releases the claim unless a display bound it (binding ends the pending state).
            defer { Self.identities.abandon(identity) }
            try operation.check()
            do { try Self.hostHealth.requireStillSettledForReconfiguration() }
            catch let refusal as DisplayHostHealth.ReconfigurationSettlingRefusal { throw refusal.underlyingError }
            do {
                try Self.beginCheckedMutation(
                    creation: true, operation: operation, coordinator: Self.lifecycle,
                    lease: Self.lease,
                    readiness: { try Self.hostHealth.requireStillSettledForReconfiguration() })
            } catch let refusal as DisplayHostHealth.ReconfigurationSettlingRefusal {
                throw refusal.underlyingError
            } catch let refusal as DisplayLifecycleCoordinator.CreationDeferred {
                throw refusal.underlyingError
            }
            var completed = false
            var attachedDisplay: SPOVirtualDisplay?
            defer {
                if !completed {
                    if let attachedDisplay {
                        Self.lifecycle.quarantineDeferred(attachedDisplay, displayID: attachedDisplay.displayID)
                    }
                    Self.lifecycle.trip("display creation did not complete safely")
                }
            }
            guard let display = SPOVirtualDisplay(name: name, width: width, height: height,
                                                  hiDPI: hiDPI, serial: identity.serial) else {
                Self.lifecycle.trip("CGVirtualDisplay creation failed; attachment state is unknown")
                throw SpaceOError.stageCreationFailed("CGVirtualDisplay refused \(width)x\(height)")
            }
            attachedDisplay = display
            Self.identities.bind(identity, to: display)
            operation.retain(display)
            Self.hostHealth.resetReconfigurationSettling()
            guard display.settingsApplied else {
                try Self.rejectPublication(display, reason: "the display refused its mode settings",
                                           coordinator: Self.lifecycle)
            }
            try operation.check()
            if let savedMainMode,
               let current = CGDisplayCopyDisplayMode(mainDisplay),
               (current.width != savedMainMode.width || current.height != savedMainMode.height ||
                current.pixelWidth != savedMainMode.pixelWidth || current.pixelHeight != savedMainMode.pixelHeight) {
                let result = CGDisplaySetDisplayMode(mainDisplay, savedMainMode, nil)
                guard result == .success else {
                    try Self.rejectPublication(display, reason: "could not restore the original display mode",
                                               coordinator: Self.lifecycle)
                }
            }

            let deadline = ContinuousClock.now + .seconds(3)
            var publicationFailure: String?
            repeat {
                try operation.check()
                publicationFailure = try Self.publicationFailure(
                    for: display, preserving: userConfigurationBefore)
                if publicationFailure == nil { break }
                usleep(200_000)
            } while ContinuousClock.now < deadline
            guard publicationFailure == nil else {
                // macOS may have restored this identity into a saved state it cannot leave
                // (mirrored, inactive, sharing a Space). Never offer that identity again.
                let retired = Self.identities.rotate(identity)
                // Attachment reset the settling fence. Immediate rollback cannot safely pass
                // it; retain the owner and preserve the actual publication failure for recovery.
                try Self.rejectPublication(display, reason: (publicationFailure ?? "unsafe display publication")
                                               + (retired ? "" : Self.identityNotRetired),
                                           coordinator: Self.lifecycle)
            }
            try operation.check()
            let spaces = (SPOSpacesForDisplay(display.displayID) ?? []).map { $0.uint64Value }
            try operation.check()
            guard !spaces.isEmpty else {
                let retired = Self.identities.rotate(identity)
                try Self.rejectPublication(display, reason: "published display has no verified managed Space"
                                               + (retired ? "" : Self.identityNotRetired),
                                           coordinator: Self.lifecycle)
            }
            let bounds = display.bounds
            let scale: Double? = display.pixelWidth.flatMap { pixels in
                pixels > 0 && bounds.width > 0 ? Double(pixels) / Double(bounds.width) : nil
            }
            try operation.check()
            try Self.lease.finish()
            Self.recordOwned(display.displayID)
            completed = true
            return (display, spaces, bounds, scale)
        }
        self.backing = published.0
        self.retirementSpaces = published.1
        cachedSpaces = published.1
        cachedBounds = published.2
        cachedScale = published.3
        self.onlineDisplayIDsProvider = { try Self.checkedOnlineDisplayIDs() }
        self.configurationProvider = { try Self.checkedUserDisplayConfiguration() }
        self.reconfigurationReadiness = { try Self.hostHealth.requireSettledForReconfiguration(timeout: $0) }
        self.reconfigurationCheck = {
            try Self.checkActiveHostHealth()
            try Self.hostHealth.requireStillSettledForReconfiguration()
        }
        self.retirementNow = { DispatchTime.now() }
        self.fallbackRetirementCompletion = nil
        self.mutationLease = Self.lease
        self.mutationMarkerDidPersist = nil
        self.coordinator = Self.lifecycle
        self.usesLiveLease = true
        self.name = name
        self.requestedSize = CGSize(width: Int(width), height: Int(height))
    }

    init(
        testingBacking: any StageDisplayBacking,
        name: String = "test display",
        onlineDisplayIDs: @escaping @Sendable () throws -> [CGDirectDisplayID],
        coordinator: DisplayLifecycleCoordinator = DisplayLifecycleCoordinator(),
        configuration: @escaping @Sendable () throws -> UserDisplayConfiguration? = { nil },
        reconfigurationReadiness: @escaping @Sendable (TimeInterval) throws -> Void = { _ in },
        reconfigurationCheck: @escaping @Sendable () throws -> Void = {},
        retirementNow: @escaping @Sendable () -> DispatchTime = { DispatchTime.now() },
        fallbackRetirementCompletion: (@Sendable () -> Void)? = nil,
        mutationLease: DisplayLifecycleLease? = nil,
        mutationMarkerDidPersist: (@Sendable () -> Void)? = nil
    ) {
        backing = testingBacking
        onlineDisplayIDsProvider = onlineDisplayIDs
        configurationProvider = configuration // Safe tests inject values, never WindowServer.
        self.reconfigurationReadiness = reconfigurationReadiness
        self.reconfigurationCheck = reconfigurationCheck
        self.retirementNow = retirementNow
        self.fallbackRetirementCompletion = fallbackRetirementCompletion
        self.mutationLease = mutationLease
        self.mutationMarkerDidPersist = mutationMarkerDidPersist
        self.coordinator = coordinator
        usesLiveLease = false
        retirementSpaces = []
        self.name = name
        cachedBounds = testingBacking.bounds
        cachedScale = testingBacking.pixelWidth.flatMap {
            $0 > 0 && testingBacking.bounds.width > 0 ? Double($0) / Double(testingBacking.bounds.width) : nil
        }
        cachedSpaces = []
        requestedSize = cachedBounds.size
        Self.recordOwned(testingBacking.displayID)
    }

    /// Managed Space ids belonging to this display. A healthy stage owns exactly one, and it is
    /// always that display's current Space — which is what keeps agent windows composited.
    public var spaces: [UInt64] {
        stateLock.withLock {
            guard usesLiveLease, !didInvalidate, coordinator.failureReason == nil else { return [] }
            let id = backing.displayID
            do {
                cachedSpaces = try coordinator.perform(timeout: 1, retaining: backing, onlyWhenIdle: true, readOnly: true) { _ in
                    (SPOSpacesForDisplay(id) ?? []).map { $0.uint64Value }
                }
            } catch is DisplayLifecycleCoordinator.QueryDeferred { /* A mutation owns the worker. */ }
            catch { return [] }
            return cachedSpaces
        }
    }

    public var hasOwnSpace: Bool {
        let mine = Set(spaces)
        return !mine.isEmpty && !mine.contains(SPOActiveSpace())
    }

    public func contains(_ rect: CGRect) -> Bool {
        bounds.contains(CGPoint(x: rect.midX, y: rect.midY))
    }

    /// Refuse publishing a slot after any lifecycle failure. Allocation uses publication-time
    /// Space IDs, so claiming it never introduces another synchronous display query.
    func requireAllocationReady() throws {
        try requireHostHealth()
        try coordinator.check()
        guard isValid else { throw SpaceOError.stageCreationFailed("display is no longer valid") }
    }

    func requireHostHealth() throws {
        if usesLiveLease { try Self.checkActiveHostHealth() }
    }

    private struct RetirementBudgetDeferral: Error {}

    private static func retirementTimeRemaining(until deadline: DispatchTime, now: DispatchTime) -> TimeInterval {
        deadline.uptimeNanoseconds > now.uptimeNanoseconds
            ? Double(deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1e9 : 0
    }

    private static func isRetirementDeferral(_ error: Error) -> Bool {
        error is DisplayHostHealth.ReconfigurationSettlingRefusal || error is RetirementBudgetDeferral
    }

    /// WindowServer removes a virtual display asynchronously, so by default we wait for it to
    /// actually leave the online list. Merely becoming inactive is not teardown: an attached
    /// phantom can still poison the next display-graph change. The timeout is one total budget
    /// covering queueing, preflight, invalidation, removal and final verification.
    @discardableResult
    public func invalidate(waitingForRemoval timeout: TimeInterval = 30.0) -> Bool {
        // Confirmed teardown is idempotent, even while a later host interval is unsettled.
        if stateLock.withLock({ retirementConfirmed }) { return true }
        let safeTimeout = timeout.isFinite ? min(max(timeout, 0), 30) : 30
        // Short explicit budgets (including zero's synchronous removal check) never wait for
        // settling. Normal live retirement reserves ten seconds for queueing/removal checks.
        let removalReserve: TimeInterval = safeTimeout > 10 ? 10 : 0
        let deadline = retirementNow() + max(safeTimeout, 0.1)
        do {
            try coordinator.check()
            try reconfigurationReadiness(max(0, safeTimeout - 10))
            guard Self.retirementTimeRemaining(until: deadline, now: retirementNow()) > 0,
                  Self.retirementTimeRemaining(until: deadline, now: retirementNow()) >= removalReserve else {
                throw RetirementBudgetDeferral()
            }
        } catch {
            coordinator.quarantine(backing)
            if !Self.isRetirementDeferral(error) {
                coordinator.trip("display retirement readiness failed")
            }
            return false
        }
        let state = stateLock.withLock { () -> (id: CGDirectDisplayID, newlyInvalidated: Bool)? in
            guard !retirementInProgress else { return nil }
            retirementInProgress = true
            let newlyInvalidated = !didInvalidate
            if newlyInvalidated {
                didInvalidate = true
                invalidatedDisplayID = backing.displayID
            }
            return (invalidatedDisplayID, newlyInvalidated)
        }
        guard let state else { return false }
        let pending = PendingInvalidation(
            display: backing, displayID: state.id, onlineDisplayIDs: onlineDisplayIDsProvider)
        defer {
            stateLock.withLock {
                retirementInProgress = false
                if pending.removalConfirmed { retirementConfirmed = true }
            }
        }
        do {
            let remaining = Self.retirementTimeRemaining(until: deadline, now: retirementNow())
            guard remaining > 0, remaining >= removalReserve else { throw RetirementBudgetDeferral() }
            return try coordinator.perform(timeout: remaining, retaining: backing) {
                [configurationProvider, reconfigurationCheck, retirementNow, mutationLease,
                 mutationMarkerDidPersist, usesLiveLease, coordinator] operation in
                try Self.retire(pending, timeout: safeTimeout, deadline: deadline, operation: operation,
                                configuration: configurationProvider, readiness: reconfigurationCheck,
                                removalReserve: removalReserve, now: retirementNow,
                                mutationLease: mutationLease, markerDidPersist: mutationMarkerDidPersist,
                                liveLease: usesLiveLease, coordinator: coordinator)
            }
        } catch {
            coordinator.quarantine(backing)
            if !pending.mutationStarted, Self.isRetirementDeferral(error) {
                // The worker can observe a new warm interval after preflight. Restore only a
                // previously valid owner; an earlier attempted teardown remains invalid.
                if state.newlyInvalidated {
                    stateLock.withLock {
                        didInvalidate = false
                        invalidatedDisplayID = 0
                    }
                }
            } else {
                coordinator.trip("display \(state.id) retirement was not confirmed")
            }
            return false
        }
    }

    /// A durable pending marker can take long enough for health/admission to change. Recheck
    /// after its acknowledged write, and clear it only after a no-mutation abort is acknowledged.
    static func beginCheckedMutation(
        creation: Bool, operation: DisplayLifecycleCoordinator.Operation,
        coordinator: DisplayLifecycleCoordinator, lease: DisplayLifecycleLease?,
        markerDidPersist: (() -> Void)? = nil,
        readiness: () throws -> Void,
        requireRemovalBudget: () throws -> Void = {}
    ) throws {
        var markerPersisted = false
        do {
            try operation.check()
            try lease?.begin(creation: creation)
            markerPersisted = lease != nil
            markerDidPersist?()
            try readiness()
            try requireRemovalBudget()
            try operation.check()
            // This is the last synchronized check before the caller's attach. It shares the
            // registration lock, and leaves no blocking work between admission and private IPC.
            if creation { try coordinator.admitCreation() }
        } catch {
            let deferred = isRetirementDeferral(error) || error is DisplayLifecycleCoordinator.CreationDeferred
            if deferred {
                do {
                    try operation.check()
                    if markerPersisted { try lease?.finish() }
                    try operation.check()
                } catch {
                    coordinator.trip("display mutation abort was not acknowledged safely")
                    throw error
                }
            } else if !markerPersisted, case SpaceOError.resourceLimit = error {
                // A creation-rate refusal happens before any pending marker or OS mutation.
            } else {
                coordinator.trip("display mutation preparation did not complete safely")
            }
            throw error
        }
    }

    private static func retire(
        _ pending: PendingInvalidation, timeout: TimeInterval, deadline: DispatchTime,
        operation: DisplayLifecycleCoordinator.Operation,
        configuration: () throws -> UserDisplayConfiguration?,
        readiness: () throws -> Void, removalReserve: TimeInterval,
        now: () -> DispatchTime,
        mutationLease: DisplayLifecycleLease?, markerDidPersist: (() -> Void)?,
        liveLease: Bool, coordinator: DisplayLifecycleCoordinator
    ) throws -> Bool {
        // Refuse a blocked host before querying its display server, then recheck immediately
        // before mutation because configuration sampling can span a new CPU interval.
        try readiness()
        let before = try configuration()
        try readiness()
        let remaining = retirementTimeRemaining(until: deadline, now: now())
        guard remaining > 0, remaining >= removalReserve else { throw RetirementBudgetDeferral() }
        try beginCheckedMutation(
            creation: false, operation: operation, coordinator: coordinator, lease: mutationLease,
            markerDidPersist: markerDidPersist, readiness: readiness,
            requireRemovalBudget: {
                let remaining = retirementTimeRemaining(until: deadline, now: now())
                guard remaining > 0, remaining >= removalReserve else { throw RetirementBudgetDeferral() }
            })
        pending.markMutationStarted()
        pending.display.invalidate()
        if liveLease { hostHealth.resetReconfigurationSettling() }
        repeat {
            try operation.check()
            let retired = displayIsRetired(
                pending.displayID, onlineDisplayIDs: try pending.onlineDisplayIDs())
            if retired {
                if let before, let after = try configuration() {
                    let changes = after.changes(from: before)
                    if !changes.isEmpty {
                        if now() < deadline { usleep(200_000); continue }
                        coordinator.trip("user display configuration changed during retirement")
                        return false
                    }
                }
                try operation.check()
                try mutationLease?.finish()
                recordReleased(pending.displayID)
                coordinator.clearDeferredRetirement(pending.displayID, releasing: pending.display)
                pending.markRemovalConfirmed()
                return true
            }
            if timeout == 0 {
                if liveLease { coordinator.trip("display removal was not confirmed") }
                return false
            }
            usleep(200_000)
        } while now() < deadline
        coordinator.trip("display \(pending.displayID) removal was not confirmed")
        return false
    }

    public static func activeDisplayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else {
            return []
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard count == 0
                || CGGetActiveDisplayList(count, &ids, &count) == .success else {
            return []
        }
        return Array(ids.prefix(Int(count)))
    }

    public static func onlineDisplayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success else {
            return []
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard count == 0
                || CGGetOnlineDisplayList(count, &ids, &count) == .success else {
            return []
        }
        return Array(ids.prefix(Int(count)))
    }

    static func isSpaceODisplay(_ id: CGDirectDisplayID) -> Bool {
        CGDisplayVendorNumber(id) == 0x1AF2 && CGDisplayModelNumber(id) == 0x0001
    }

    static func checkedOnlineDisplayIDs() throws -> [CGDirectDisplayID] {
        try checkedDisplayIDs(active: false)
    }

    private static func checkedDisplayIDs(active: Bool) throws -> [CGDirectDisplayID] {
        // A successful zero count is readable; failure/overflow remains unknown.
        // Admission separately refuses currently unqualified empty/inactive configurations.
        var ids = [CGDirectDisplayID](repeating: 0, count: 128)
        var count: UInt32 = 0
        let result = active ? CGGetActiveDisplayList(128, &ids, &count)
            : CGGetOnlineDisplayList(128, &ids, &count)
        return try validatedDisplayIDs(result: result, buffer: ids, count: count)
    }

    static func validatedDisplayIDs(
        result: CGError, buffer: [CGDirectDisplayID], count: UInt32
    ) throws -> [CGDirectDisplayID] {
        guard result == .success, !buffer.isEmpty, Int(count) < buffer.count else {
            throw SpaceOError.stageCreationFailed("display inventory is unavailable or exceeds its bound")
        }
        let ids = Array(buffer.prefix(Int(count)))
        guard !ids.contains(0), Set(ids).count == ids.count else {
            throw SpaceOError.stageCreationFailed("display inventory contains invalid identifiers")
        }
        return ids
    }

    /// Diagnostics preserve the existing nonthrowing API; lifecycle uses the checked variant.
    static func userDisplayConfiguration() -> UserDisplayConfiguration {
        (try? checkedUserDisplayConfiguration()) ?? UserDisplayConfiguration(displays: [])
    }

    static func checkedUserDisplayConfiguration() throws -> UserDisplayConfiguration {
        let active = Set(try checkedDisplayIDs(active: true))
        let main = CGMainDisplayID()
        let ids = try checkedOnlineDisplayIDs().filter { !isSpaceODisplay($0) }
        let displays = ids.sorted().map { id in
            let mode = CGDisplayCopyDisplayMode(id)
            return UserDisplayConfiguration.Display(
                id: id,
                active: active.contains(id),
                main: id == main,
                bounds: CGDisplayBounds(id),
                pixelWidth: CGDisplayPixelsWide(id),
                pixelHeight: CGDisplayPixelsHigh(id),
                rotation: CGDisplayRotation(id),
                mirroredTo: CGDisplayMirrorsDisplay(id),
                modeWidth: mode?.width ?? 0,
                modeHeight: mode?.height ?? 0,
                modePixelWidth: mode?.pixelWidth ?? 0,
                modePixelHeight: mode?.pixelHeight ?? 0,
                refreshRate: mode?.refreshRate ?? 0)
        }
        return UserDisplayConfiguration(displays: displays)
    }

    /// Pure publication checks live behind one helper so unsafe overlap and configuration-drift
    /// scenarios can be unit tested without creating a real virtual monitor.
    static func publicationFailure(
        displayID: CGDirectDisplayID,
        bounds: CGRect,
        activeDisplayIDs: Set<CGDirectDisplayID>,
        spaces: [UInt64],
        activeSpace: UInt64,
        otherDisplayBounds: [(CGDirectDisplayID, CGRect)],
        userConfigurationBefore: UserDisplayConfiguration,
        userConfigurationAfter: UserDisplayConfiguration
    ) -> String? {
        guard displayID != 0 else { return "the virtual display has no display id" }
        guard !bounds.isNull, !bounds.isInfinite,
              bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0 else {
            return "the virtual display has no finite positive bounds"
        }
        guard activeDisplayIDs.contains(displayID) else {
            return "the virtual display is online but inactive"
        }
        guard !spaces.isEmpty else { return "the virtual display has no managed Space" }
        guard activeSpace == 0 || !spaces.contains(activeSpace) else {
            return "the virtual display shares the user's active Space"
        }
        for (otherID, otherBounds) in otherDisplayBounds {
            let overlap = bounds.intersection(otherBounds)
            if !overlap.isNull && overlap.width > 0 && overlap.height > 0 {
                return "the virtual display overlaps display \(otherID)"
            }
        }
        let changes = userConfigurationAfter.changes(from: userConfigurationBefore)
        guard changes.isEmpty else { return changes.joined(separator: "; ") }
        return nil
    }

    private static func publicationFailure(
        for display: SPOVirtualDisplay,
        preserving userConfigurationBefore: UserDisplayConfiguration
    ) throws -> String? {
        let id = display.displayID
        let spaces = (SPOSpacesForDisplay(id) ?? []).map { $0.uint64Value }
        let otherBounds = try checkedOnlineDisplayIDs()
            .filter { $0 != id }
            .map { ($0, CGDisplayBounds($0)) }
        return publicationFailure(
            displayID: id,
            bounds: display.bounds,
            activeDisplayIDs: Set(try checkedDisplayIDs(active: true)),
            spaces: spaces,
            activeSpace: SPOActiveSpace(),
            otherDisplayBounds: otherBounds,
            userConfigurationBefore: userConfigurationBefore,
            userConfigurationAfter: try checkedUserDisplayConfiguration())
    }

    /// Requires a readable user display graph with at least one active display. Inactive
    /// displays are admitted only as mirror followers, whose mode belongs to their master.
    static func admissionFailure(
        configuration: UserDisplayConfiguration, foreignDisplayIDs: [CGDirectDisplayID]
    ) -> String? {
        guard !configuration.displays.isEmpty,
              configuration.displays.contains(where: { $0.active }),
              configuration.displays.allSatisfy({
                  ($0.active || $0.mirroredTo != 0)
                     && $0.bounds.width.isFinite && $0.bounds.height.isFinite
                     && $0.bounds.origin.x.isFinite && $0.bounds.origin.y.isFinite
                     && $0.bounds.width > 0 && $0.bounds.height > 0
                     && $0.modeWidth > 0 && $0.modeHeight > 0
              }) else { return "user display configuration has no qualified active display or is unreadable" }
        guard foreignDisplayIDs.isEmpty else {
            return "unowned SpaceO displays are still online; refusing another attachment"
        }
        return nil
    }

    public static func nonSpaceOActiveDisplayIDs() -> [CGDirectDisplayID] {
        activeDisplayIDs().filter { !isSpaceODisplay($0) }
    }

    /// A real, currently active display to which cursor/window recovery may safely return.
    /// `CGMainDisplayID()` is not sufficient: during the lockout it referred to a SpaceO
    /// virtual display while both physical displays were inactive.
    public static func preferredActiveUserDisplayBounds() -> CGRect? {
        let active = nonSpaceOActiveDisplayIDs()
        guard !active.isEmpty else { return nil }
        let main = CGMainDisplayID()
        let selected = active.contains(main) ? main : active[0]
        let bounds = CGDisplayBounds(selected)
        guard bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0 else {
            return nil
        }
        return bounds
    }

    /// User-facing/third-party displays that are online, even if WindowServer made them inactive.
    public static func nonSpaceOOnlineDisplayIDs() -> [CGDirectDisplayID] {
        onlineDisplayIDs().filter { !isSpaceODisplay($0) }
    }

    /// User displays in a mirror set, reported by `doctor` for diagnostics.
    public static func mirroredNonSpaceODisplayIDs() -> [CGDirectDisplayID] {
        nonSpaceOOnlineDisplayIDs().filter { CGDisplayIsInMirrorSet($0) != 0 }
    }

    /// Online displays created with SpaceO's vendor/model identifiers, including inactive
    /// displays that survived their owner unexpectedly.
    public static func spaceODisplayIDs() -> [CGDirectDisplayID] {
        onlineDisplayIDs().filter(isSpaceODisplay)
    }

    private static func recordOwned(_ id: CGDirectDisplayID) {
        guard id != 0 else { return }
        _ = ownership.lock.withLock { ownership.displayIDs.insert(id) }
    }

    private static func recordReleased(_ id: CGDirectDisplayID) {
        _ = ownership.lock.withLock { ownership.displayIDs.remove(id) }
    }

    static func displayIsRetired(
        _ id: CGDirectDisplayID,
        onlineDisplayIDs: [CGDirectDisplayID]
    ) -> Bool {
        id == 0 || !onlineDisplayIDs.contains(id)
    }

    /// Keep failed publication owned: destroying it before the post-attachment settling fence
    /// clears would be a second unsafe graph change and would erase the useful failure reason.
    static func rejectPublication(
        _ display: any StageDisplayBacking, reason: String,
        coordinator: DisplayLifecycleCoordinator
    ) throws -> Never {
        coordinator.quarantineDeferred(display, displayID: display.displayID)
        coordinator.trip(reason)
        throw SpaceOError.stageCreationFailed(reason)
    }

    deinit {
        let pending = stateLock.withLock { () -> PendingInvalidation? in
            guard !didInvalidate else { return nil }
            didInvalidate = true
            invalidatedDisplayID = backing.displayID
            return PendingInvalidation(
                display: backing, displayID: invalidatedDisplayID,
                onlineDisplayIDs: onlineDisplayIDsProvider)
        }
        guard let pending else { return }
        let coordinator = coordinator
        // Transfer and report ownership before scheduling: shutdown must see this display
        // throughout the readiness wait, even before the fallback worker has started.
        coordinator.quarantineDeferred(pending.display, displayID: pending.displayID)
        let configuration = configurationProvider
        let liveLease = usesLiveLease
        let reconfigurationReadiness = reconfigurationReadiness
        let reconfigurationCheck = reconfigurationCheck
        let retirementNow = retirementNow
        let completion = fallbackRetirementCompletion
        let mutationLease = mutationLease
        let mutationMarkerDidPersist = mutationMarkerDidPersist
        // Never query or mutate the display server synchronously from deinit.
        DispatchQueue.global(qos: .utility).async {
            defer { completion?() }
            do {
                let deadline = retirementNow() + .seconds(30)
                try reconfigurationReadiness(20)
                let remaining = Self.retirementTimeRemaining(until: deadline, now: retirementNow())
                guard remaining >= 10 else { throw RetirementBudgetDeferral() }
                _ = try coordinator.perform(timeout: remaining, retaining: pending.display) { operation in
                    try Self.retire(pending, timeout: 30, deadline: deadline, operation: operation,
                                    configuration: configuration, readiness: reconfigurationCheck,
                                    removalReserve: 10, now: retirementNow,
                                    mutationLease: mutationLease, markerDidPersist: mutationMarkerDidPersist,
                                    liveLease: liveLease, coordinator: coordinator)
                }
            } catch {
                // The registered owner stays visible for every failure. Only a pre-mutation
                // settling/budget deferral avoids the persistent health circuit.
                if pending.mutationStarted || !Self.isRetirementDeferral(error) {
                    coordinator.trip("fallback display retirement was not confirmed")
                }
            }
        }
    }
}
