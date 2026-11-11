import Foundation
import ApplicationServices
import CoreGraphics
import SpaceOPrivate

public struct WindowRef: Sendable, Equatable, Identifiable {
    public let windowID: CGWindowID
    public let pid: pid_t
    public let title: String
    public let frame: CGRect
    public var id: CGWindowID { windowID }
}

/// Moves other apps' windows onto a stage — using accessibility, so no cursor moves and
/// no app is activated.
public enum WindowPlacement {
    public enum Policy: String, Codable, Sendable, CaseIterable {
        case preserve, fit, cover
    }

    /// Preserve normal geometry; a display-sized panel must start at the display origin.
    public static func targetFrame(for original: CGRect, in region: CGRect,
                                   policy: Policy = .preserve, index: Int = 0) -> CGRect {
        if policy == .cover { return region }
        if policy == .fit { return cascadeFrame(in: region, index: index) }
        let size = CGSize(width: min(max(1, original.width), region.width),
                          height: min(max(1, original.height), region.height))
        let inset = min(40, min(region.width, region.height) * 0.04)
        let offset = inset + CGFloat(max(0, min(index, 1000))) * 28
        return CGRect(x: region.minX + min(offset, region.width - size.width),
                      y: region.minY + min(offset, region.height - size.height),
                      width: size.width, height: size.height)
    }

    public static func overflowEdges(_ observed: CGRect, outside region: CGRect) -> [String] {
        var edges: [String] = []
        if observed.minX < region.minX - placementTolerance { edges.append("left") }
        if observed.minY < region.minY - placementTolerance { edges.append("top") }
        if observed.maxX > region.maxX + placementTolerance { edges.append("right") }
        if observed.maxY > region.maxY + placementTolerance { edges.append("bottom") }
        return edges
    }


    /// Fail before launching an application when this process cannot inspect or move its
    /// windows. Without this preflight, a missing TCC grant looks like an application that
    /// launched successfully but never produced a window, and callers waste the full launch
    /// timeout before receiving a misleading error.
    public static func requireAccessibility(trusted: Bool = AX.isTrusted) throws {
        guard trusted else { throw SpaceOError.accessibilityDenied }
    }

    /// Bounded compatibility list. Empty can mean unavailable or over budget, not just absent.
    /// Session commands use throwing discovery so a failed read cannot establish absence.
    public static func windows(of pid: pid_t) -> [WindowRef] {
        guard let identity = ProcessIdentity.current(of: pid) else { return [] }
        do {
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
                now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
            let found = try AXWindowDiscovery.liveWindows(of: pid, budget: budget)
            guard identity.isAlive else { return [] }
            try budget.check()
            return found
        } catch { return [] }
    }

    /// The AX element for a specific window id, or nil when bounded lookup cannot resolve it.
    public static func element(for window: WindowRef) -> AXUIElement? {
        try? boundedElement(for: window)
    }

    private static func boundedElement(for window: WindowRef) throws -> AXUIElement {
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        return try AXTraversal.root(pid: window.pid, window: window,
                                    provider: SystemAXTraversalProvider(), budget: budget)
    }

    /// Callers that need to prove absence must not use the best-effort compatibility list.
    static func hasWindows(of pid: pid_t) throws -> Bool {
        guard let identity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.windowNotFound("the process exited before window discovery")
        }
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
            now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
        let found = try AXWindowDiscovery.hasWindows(app: AX.application(pid),
                                                    provider: SystemAXTraversalProvider(), budget: budget)
        guard identity.isAlive else { throw SpaceOError.windowNotFound("the process changed during window discovery") }
        return found
    }

    /// Move and resize a window. Position is set twice: some apps clamp the first request to
    /// the display the window is currently on, and accept it once the size fits.
    @discardableResult
    public static func move(_ window: WindowRef, to frame: CGRect) throws -> CGRect {
        try validate(frame: frame)
        guard let identity = ProcessIdentity.current(of: window.pid) else {
            throw SpaceOError.windowNotFound("the window's process exited before placement")
        }
        return try move(window, to: frame, identity: identity)
    }

    /// A cached window omitted by AX still needs bounded lookup against its original process.
    static func move(_ window: WindowRef, to frame: CGRect, identity: ProcessIdentity) throws -> CGRect {
        try validate(frame: frame)
        guard identity.pid == window.pid, identity.isAlive else {
            throw SpaceOError.windowNotFound("the window's original process exited before placement")
        }
        let element = try boundedElement(for: window)
        try Task.checkCancellation()
        return try move(window, to: frame, element: element, identity: identity)
    }

    /// Move a retained discovery handle, revalidating its process and window identity first.
    static func move(_ window: WindowRef, to frame: CGRect, element: AXUIElement,
                     identity: ProcessIdentity, parentBudget: AXTraversalBudget? = nil) throws -> CGRect {
        try validate(frame: frame)
        guard identity.pid == window.pid else {
            throw SpaceOError.windowNotFound("the discovered window identity changed before placement")
        }
        // Retained-handle moves also restore windows during cancelled placement rollback.
        // Keep that authority until native work returns; admitting callers check cancellation.
        let budget = try WindowMovement.budget(parent: parentBudget)
        return try WindowMovement.perform(windowID: window.windowID, target: frame,
            element: element, provider: SystemAXTraversalProvider(), budget: budget, validate: {
                guard identity.isAlive else {
                    throw SpaceOError.windowNotFound("the movement process exited or changed")
                }
            }, liveBounds: {
                var bounds = CGRect.zero
                return SPOWindowBounds(window.windowID, &bounds) ? bounds : nil
            }, sleep: {
                Thread.sleep(forTimeInterval: Double($0) / 1_000_000_000)
            })
    }

    /// A sensible default window frame inside a session's tile: inset, but never so inset
    /// that a small tile leaves no usable window.
    public static func defaultFrame(in region: CGRect) -> CGRect {
        let inset = min(40, min(region.width, region.height) * 0.04)
        return region.insetBy(dx: inset, dy: inset)
    }

    /// Relocate every window of `pid` into `region`. Returns the windows as placed.
    ///
    /// Windows are cascaded slightly so several windows from one app stay reachable, but the
    /// cascade is clamped to the region — a session must never spill into a neighbour's tile.
    @discardableResult
    public static func placeAll(of pid: pid_t, into region: CGRect,
                                policy: Policy = .preserve) throws -> [WindowRef] {
        try requireAccessibility()
        try validate(frame: region)
        guard let identity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.windowNotFound("the process exited before window discovery")
        }
        return try placeAll(of: pid, into: region, policy: policy, discover: {
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
                now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
            let result = try AXWindowDiscovery.discover(of: pid, app: AX.application(pid),
                provider: SystemAXTraversalProvider(), budget: budget,
                liveBounds: { try? liveBounds(of: $0) }, retainingElements: true)
            guard identity.isAlive else { throw SpaceOError.windowNotFound("the process changed during window discovery") }
            guard !result.windows.isEmpty else {
                throw SpaceOError.windowNotFound(
                    "pid \(pid) has no accessibility windows\(windowServerDisagreement(pid: pid))")
            }
            return result
        }, move: { window, element, frame in
            _ = try move(window, to: frame, element: element, identity: identity)
        }, bounds: { try liveBounds(of: $0) })
    }

    /// Shared transaction logic; injected operations keep discovery failure and rollback tests
    /// deterministic without querying or moving native windows.
    static func placeAll<Element>(
        of pid: pid_t, into region: CGRect, policy: Policy,
        discover: () throws -> AXWindowDiscovery.Result<Element>,
        move: (WindowRef, Element, CGRect) throws -> Void,
        bounds: (CGWindowID) throws -> CGRect
    ) throws -> [WindowRef] {
        try validate(frame: region)
        try Task.checkCancellation()
        let discovery = try discover()
        let found = discovery.windows
        guard !found.isEmpty else {
            throw SpaceOError.windowNotFound("pid \(pid) has no accessibility windows")
        }
        guard found.allSatisfy({ $0.pid == pid && discovery.elements[$0.windowID] != nil }) else {
            throw AXWindowDiscovery.incomplete("placement handles do not cover the discovered windows")
        }
        var placed: [WindowRef] = []
        do {
            for (index, window) in found.enumerated() {
                try Task.checkCancellation()
                let target = targetFrame(for: window.frame, in: region, policy: policy, index: index)
                try move(window, discovery.elements[window.windowID]!, target)
                // Accept only on full containment, from live bounds rather than the frame `move`
                // echoed back: an app may resize itself the instant it is repositioned, and a
                // window whose centre landed while its edges spill is exactly the cross-tile
                // leak this check exists to catch.
                guard let actual = try? bounds(window.windowID) else {
                    continue  // the WindowServer forgot it: closed mid-placement, not refused
                }
                guard isFullyInside(actual, region) else {
                    throw SpaceOError.unsupportedTarget(
                        "window \(window.windowID) rejected placement policy=\(policy.rawValue); "
                        + "requested=\(target), observed=\(actual), "
                        + "overflowEdges=\(overflowEdges(actual, outside: region))")
                }
                placed.append(WindowRef(windowID: window.windowID, pid: pid,
                                        title: window.title, frame: actual))
            }
        } catch {
            // The window that triggered the error may have moved asynchronously after its
            // verification read. Roll every original window back, not only those already
            // appended to `placed`.
            for original in found {
                try? move(original, discovery.elements[original.windowID]!, original.frame)
            }
            throw error
        }
        return placed
    }

    /// Where the `index`-th window of one app goes inside `region`.
    ///
    /// Windows are cascaded so several windows from one app stay reachable, but the cascade is
    /// clamped on *full bounds*: a midpoint clamp let the third window's edges hang past the tile
    /// while its centre stayed inside, which `placeAll`'s acceptance check would then — correctly
    /// — reject as a refusal to move, failing a launch on a frame SpaceO itself picked.
    static func cascadeFrame(in region: CGRect, index: Int) -> CGRect {
        let base = defaultFrame(in: region)
        let offset = CGFloat(index) * 28
        let cascaded = base.offsetBy(dx: offset, dy: offset)
        return isFullyInside(cascaded, region) ? cascaded : base
    }

    /// Points of slack when comparing a published frame against the one we asked for. Apps round
    /// to integral points; anything past this is the app disagreeing with us, not rounding.
    static let placementTolerance: CGFloat = 2

    /// Has the window server published a frame that puts this window where `move` asked for it?
    ///
    /// The origin must match. The size must be *no larger* than requested, rather than equal:
    ///
    /// - Waiting on the origin alone is the PAR-25 race. `AX.setSize` publishes independently of
    ///   `AX.setPosition`, so a window whose origin has arrived can still be reporting its old,
    ///   larger extent — and `isFullyInRegion`, evaluated by the janitor the instant `move`
    ///   returns, reads that stale extent as a window that refused to move.
    /// - Demanding the size back exactly would instead burn the whole deadline on every app that
    ///   snaps its size to a grid — terminals to character cells — on a placement that worked.
    ///
    /// A window no larger than the frame we asked for, sitting at the origin we asked for, is
    /// inside every region that frame was inside. That is the property the callers actually test.
    static func hasLanded(_ bounds: CGRect, at frame: CGRect) -> Bool {
        abs(bounds.origin.x - frame.origin.x) <= placementTolerance
            && abs(bounds.origin.y - frame.origin.y) <= placementTolerance
            && bounds.width <= frame.width + placementTolerance
            && bounds.height <= frame.height + placementTolerance
    }

    static func validate(frame: CGRect) throws {
        guard !frame.isNull, !frame.isInfinite,
              frame.origin.x.isFinite, frame.origin.y.isFinite,
              frame.width.isFinite, frame.height.isFinite,
              frame.width >= 1, frame.height >= 1 else {
            throw SpaceOError.badRequest("window region must be finite and positive")
        }
    }

    public static func waitForWindow(
        of pid: pid_t,
        timeout: TimeInterval = 12,
        pollNanoseconds: UInt64 = 150_000_000
    ) async throws -> [WindowRef] {
        try await waitForWindow(of: pid, timeout: timeout, pollNanoseconds: pollNanoseconds) { remaining in
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: remaining),
                now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
            let found = try AXWindowDiscovery.liveWindows(of: pid, budget: budget)
            return found.isEmpty ? nil : found
        }
    }

    /// Launch immediately performs checked placement, so readiness only needs one window ID.
    static func waitForWindowPresence(of pid: pid_t, timeout: TimeInterval,
                                      pollNanoseconds: UInt64) async throws {
        var lastAXCount: Int?
        let _: Bool = try await waitForWindow(of: pid, timeout: timeout, pollNanoseconds: pollNanoseconds,
            diagnostic: { lastAXCount.map { "; last successful AX window count: \($0), with no identified window" } ?? "" }) { remaining in
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: remaining),
                now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
            return try AXWindowDiscovery.hasIdentifiedWindow(app: AX.application(pid),
                provider: SystemAXTraversalProvider(), budget: budget,
                observedCount: { lastAXCount = $0 }) ? true : nil
        }
    }

    private static func waitForWindow<Value: Sendable>(of pid: pid_t, timeout: TimeInterval,
        pollNanoseconds: UInt64, diagnostic: () -> String = { "" },
        probe: (TimeInterval) throws -> Value?) async throws -> Value {
        try requireAccessibility()
        try WindowReadiness.validate(timeout: timeout, pollNanoseconds: pollNanoseconds)
        guard let identity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.applicationExited("pid \(pid) exited before window wait")
        }
        if let found = try await WindowReadiness.wait(timeout: timeout, pollNanoseconds: pollNanoseconds, validate: {
            try requireAccessibility()
            guard identity.isAlive else {
                throw SpaceOError.applicationExited("pid \(pid) exited during window wait")
            }
        }, probe: probe) { return found }
        throw SpaceOError.windowNotReady(
            "pid \(pid) produced no window within \(timeout)s"
                + windowServerDisagreement(pid: pid) + diagnostic())
    }

    /// Which tile does this window *belong* to?
    ///
    /// Judged by the window's centre, and that is the only question it answers. A window whose
    /// centre is in a tile is that tile's window even while it spills past the edges — which is
    /// what `primaryWindow` needs, and precisely the wrong test for "is this window contained".
    /// Use `isContained(_:in:)` / `hasEscaped(_:from:)` for containment.
    public static func isInRegion(_ window: WindowRef, _ region: CGRect) -> Bool {
        var bounds = CGRect.zero
        guard SPOWindowBounds(window.windowID, &bounds) else { return false }
        return region.contains(CGPoint(x: bounds.midX, y: bounds.midY))
    }

    /// Does every pixel of `bounds` fall inside `region`?
    ///
    /// The stricter test the containment janitor uses. Midpoint containment is the right answer
    /// for "which tile does this window belong to", but the wrong one for "has this window been
    /// contained": a dialog twice its tile's width has its centre in the right place while
    /// spilling across a neighbouring session — or off the agent display entirely, onto the
    /// user's screen. Marking that handled is exactly the silent failure SpaceO exists to avoid.
    public static func isFullyInside(_ bounds: CGRect, _ region: CGRect) -> Bool {
        guard !bounds.isNull, !bounds.isInfinite, !region.isNull, !region.isInfinite,
              bounds.width.isFinite, bounds.height.isFinite,
              bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              region.width > 0, region.height > 0 else { return false }
        // A zero-area window has no pixels to escape with; treat it as contained if its origin
        // is, so a minimised or collapsed window does not loop forever in the janitor.
        guard bounds.width >= 0, bounds.height >= 0 else { return false }
        return bounds.minX >= region.minX && bounds.maxX <= region.maxX
            && bounds.minY >= region.minY && bounds.maxY <= region.maxY
    }

    /// Live full-bounds containment for one window, straight from the WindowServer.
    ///
    /// Returns nil when the WindowServer no longer knows the window, so callers can tell
    /// "escaped" from "closed" instead of collapsing both into false.
    public static func isFullyInRegion(_ windowID: CGWindowID, _ region: CGRect) -> Bool? {
        var bounds = CGRect.zero
        guard SPOWindowBounds(windowID, &bounds) else { return nil }
        return isFullyInside(bounds, region)
    }

    /// Is every pixel of this window inside `region` right now?
    ///
    /// The question the audit, the `onStage` field, and `placeAll`'s acceptance check all ask.
    /// A window the WindowServer no longer knows has closed, so it is not on stage either.
    public static func isContained(_ window: WindowRef, in region: CGRect) -> Bool {
        isFullyInRegion(window.windowID, region) ?? false
    }

    /// Has this window wandered out of `region` and needs re-parking?
    ///
    /// Not simply `!isContained`. A window the WindowServer has forgotten is **closed, not
    /// escaped**: reporting it as drift would make every audit that races a closing dialog
    /// fail, and would send the janitor chasing a window id that no longer exists.
    public static func hasEscaped(_ window: WindowRef, from region: CGRect) -> Bool {
        guard let contained = isFullyInRegion(window.windowID, region) else { return false }
        return !contained
    }

    public static func spaces(of window: WindowRef) -> [UInt64] {
        (SPOSpacesForWindow(window.windowID) ?? []).map { $0.uint64Value }
    }

    /// Authoritative live bounds from the WindowServer, or a refusal when it no longer knows
    /// the window. The one place the lookup-or-refuse decision lives, so every input path
    /// reports a vanished window the same way.
    public static func liveBounds(of windowID: CGWindowID) throws -> CGRect {
        var bounds = CGRect.zero
        guard SPOWindowBounds(windowID, &bounds) else {
            throw SpaceOError.windowNotFound("no bounds for window \(windowID)")
        }
        return bounds
    }

    /// A suffix naming the windows the WindowServer has for `pid` when accessibility reported
    /// none, or an empty string when the two agree.
    ///
    /// "produced no window" and "this process could not read its windows" are different failures
    /// with different fixes, and both used to print the first one. On a host where an app's
    /// accessibility tree stops answering — observed on 2026-08-29, with `kAXWindowsAttribute`
    /// returning empty for a live TextEdit for a full 15-second wait while
    /// `CGWindowListCopyWindowInfo` listed its document window the whole time — the message sent
    /// the reader after the application, which was behaving perfectly. Naming the windows the
    /// WindowServer can see puts the reader in front of the accessibility read instead.
    ///
    /// Kept to bounded, non-sensitive detail: window ids and a count, never titles.
    static func windowServerDisagreement(pid: pid_t) -> String {
        guard let list = CGWindowListCopyWindowInfo(
                  [.optionAll], kCGNullWindowID) as? [[String: Any]]
        else { return "" }
        let ids = list.compactMap { info -> Int? in
            guard info[kCGWindowOwnerPID as String] as? Int == Int(pid),
                  let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let number = info[kCGWindowNumber as String] as? Int,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds),
                  rect.width >= 120, rect.height >= 120
            else { return nil }
            return number
        }
        guard !ids.isEmpty else { return "" }
        let shown = ids.sorted().prefix(8).map(String.init).joined(separator: ", ")
        return "; but the WindowServer lists \(ids.count) window(s) for it (\(shown))"
            + "; no identified Accessibility window was observed within the wait"
            + " — check daemon Accessibility permission (`spaceo doctor`) and app startup state"

    }

    /// The process the WindowServer says owns `windowID` right now, or nil when it no longer
    /// knows the window.
    ///
    /// A `CGWindowID` is a recycled integer exactly like a `pid_t`, and geometry is not identity:
    /// "the WindowServer still has bounds for 4242" is equally true of our window and of the
    /// stranger's window that inherited the number after ours closed. Anything that keeps a
    /// window on the strength of a WindowServer lookup has to ask *whose* it is, or a later
    /// re-park moves a window belonging to an application SpaceO never launched.
    public static func liveOwnerPID(of windowID: CGWindowID) -> pid_t? {
        liveOwnerPID(of: windowID, describeWindows: CGWindowListCreateDescriptionFromArray)
    }

    static func liveOwnerPID(
        of windowID: CGWindowID,
        describeWindows: (CFArray?) -> CFArray?
    ) -> pid_t? {
        // `CGWindowListCopyWindowInfo(.optionIncludingWindow, id)` answers only while the window
        // is on screen, so an ordered-out window that still has WindowServer geometry looked
        // ownerless and failed every discovery in its session (#47). CreateDescriptionFromArray
        // describes any live window, but only from raw CGWindowID entries: bridging [windowID]
        // produces CFNumbers, which it silently matches to nothing.
        guard windowID != 0,
              let ids = rawWindowIDArray(windowID),
              let list = describeWindows(ids) as? [[String: Any]],
              list.count == 1,
              let info = list.first,
              let returnedID = info[kCGWindowNumber as String] as? CGWindowID,
              returnedID == windowID,
              let owner = info[kCGWindowOwnerPID as String] as? Int,
              let pid = pid_t(exactly: owner), pid > 0
        else { return nil }
        return pid
    }

    /// A one-element CFArray whose value is the window number itself, with no callbacks.
    static func rawWindowIDArray(_ windowID: CGWindowID) -> CFArray? {
        var values = [UnsafeRawPointer(bitPattern: UInt(windowID))]
        return values.withUnsafeMutableBufferPointer {
            CFArrayCreate(kCFAllocatorDefault, $0.baseAddress, $0.count, nil)
        }
    }
}
