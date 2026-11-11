import CoreGraphics
import Darwin
import Foundation
import SpaceOKit

/// A durable marker that the Viewer is holding machine-wide input state.
///
/// Presence is the whole signal: the file's contents are diagnostic only, so a failed or
/// truncated write must never be read as "no capture was active". Application Support is used
/// rather than `UserDefaults` because `cfprefsd` can lose an unflushed write when the process
/// is killed — exactly the death this breadcrumb exists to survive.
struct HostCaptureBreadcrumb: Sendable {
    let url: URL

    static let shared = HostCaptureBreadcrumb(url: defaultURL())

    var isPresent: Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func mark() {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let stamp = ISO8601DateFormatter().string(from: Date())
        try? Data(stamp.utf8).write(to: url, options: .atomic)
    }

    func clear() {
        try? FileManager.default.removeItem(at: url)
    }

    private static func defaultURL() -> URL {
        let root = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return root
            .appendingPathComponent("SpaceO", isDirectory: true)
            .appendingPathComponent("Viewer", isDirectory: true)
            .appendingPathComponent("host-capture.active", isDirectory: false)
    }
}

/// Read by the signal handler, so it is a plain C scalar. Consulting Swift state — an Optional,
/// an Array, anything that can allocate or take a lock — from a handler is not async-signal-safe.
private nonisolated(unsafe) var hostCaptureIsActive: sig_atomic_t = 0

/// Pre-encoded at install time because building a path from a `URL` inside a handler would
/// allocate. `unlink` itself is on the async-signal-safe list.
private nonisolated(unsafe) var hostCaptureBreadcrumbPath: UnsafeMutablePointer<CChar>?

/// Restores only the state whose loss makes the Mac unusable, then lets the original signal
/// kill the process as it would have.
///
/// Tradeoff: strictly, none of these three calls is documented as async-signal-safe, and the
/// hotkey call reaches SkyLight through Objective-C. `HostInputGuard.installTerminationHandlers`
/// warms that path first so the handler makes a resolved function-pointer call with no
/// allocation and no `dispatch_once`. A small chance of deadlocking a process that is already
/// dying is worth a much larger chance of handing the user back their cursor and Spotlight.
private func hostInputGuardHandleSignal(_ number: Int32) {
    if hostCaptureIsActive != 0 {
        hostCaptureIsActive = 0
        CGAssociateMouseAndMouseCursorPosition(1)
        CGDisplayShowCursor(CGMainDisplayID())
        _ = MirrorInput.setHostGlobalShortcutsEnabled(true)
        if let hostCaptureBreadcrumbPath { unlink(hostCaptureBreadcrumbPath) }
    }
    signal(number, SIG_DFL)
    raise(number)
}

/// Entering Control takes over state that belongs to the whole Mac, not to this app: the mouse
/// is decoupled from the cursor, the cursor is hidden, and the WindowServer's global hotkeys
/// (Spotlight, Mission Control, screenshot chords) are switched off. macOS reclaims none of it
/// when the Viewer goes away, so a crash or a Force Quit while captured used to leave a machine
/// that could only be repaired by logging out.
///
/// Defence in depth, because a process can end in ways it cannot all observe:
///   * `applicationWillTerminate` and the surface's own teardown cover an orderly quit;
///   * `atexit` covers an `exit()` that bypasses AppKit;
///   * signal handlers cover a crash or a `kill`, restoring the minimum critical state;
///   * the breadcrumb covers `SIGKILL` and a panic — where no code of ours runs at all — by
///     repairing the host on the next launch.
@MainActor
enum HostInputGuard {

    /// Death by any of these still runs code, so each one gets a chance to hand the machine
    /// back. `SIGKILL` and `SIGSTOP` cannot be caught and are the breadcrumb's job.
    private static let handledSignals: [Int32] = [
        SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGSYS, SIGTRAP,
        SIGHUP, SIGINT, SIGQUIT, SIGTERM,
    ]

    private static var handlersInstalled = false

    static func installTerminationHandlers(breadcrumb: HostCaptureBreadcrumb = .shared) {
        guard !handlersInstalled else { return }
        handlersInstalled = true

        // Resolving SkyLight's hotkey symbol allocates and runs a `dispatch_once`, neither of
        // which is legal inside a handler. A no-op enable here — hotkeys are already on at
        // launch — leaves the handler nothing to do but call the resolved pointer.
        _ = MirrorInput.setHostGlobalShortcutsEnabled(true)
        hostCaptureBreadcrumbPath = strdup(breadcrumb.url.path)

        for number in handledSignals {
            signal(number, hostInputGuardHandleSignal)
        }
        atexit {
            guard hostCaptureIsActive != 0 else { return }
            hostCaptureIsActive = 0
            CGAssociateMouseAndMouseCursorPosition(1)
            CGDisplayShowCursor(CGMainDisplayID())
            _ = MirrorInput.setHostGlobalShortcutsEnabled(true)
            if let hostCaptureBreadcrumbPath { unlink(hostCaptureBreadcrumbPath) }
        }
    }

    /// Arm every recovery path *before* the machine-wide state actually changes: a crash in
    /// between would otherwise leave a captured Mac with nothing recorded to repair.
    static func beginCapture(breadcrumb: HostCaptureBreadcrumb = .shared) {
        hostCaptureIsActive = 1
        breadcrumb.mark()
    }

    static func endCapture(breadcrumb: HostCaptureBreadcrumb = .shared) {
        hostCaptureIsActive = 0
        breadcrumb.clear()
    }

    /// AppKit tears the process down without unwinding the view hierarchy, so the surface's own
    /// `endHostInputCapture` never runs on Quit, on logout, or on a `SIGTERM` from launchd.
    static func restoreIfCaptureActive(
        breadcrumb: HostCaptureBreadcrumb = .shared,
        restore: () -> Void = HostInputGuard.restoreHostInputState
    ) {
        guard hostCaptureIsActive != 0 else { return }
        restore()
        endCapture(breadcrumb: breadcrumb)
    }

    /// Launch-time repair for the deaths the previous run could not observe. Reports whether a
    /// breadcrumb was found so the Viewer can tell the user their Mac was just put back.
    @discardableResult
    static func repairAbandonedCapture(
        breadcrumb: HostCaptureBreadcrumb = .shared,
        restore: () -> Void = HostInputGuard.restoreHostInputState
    ) -> Bool {
        guard breadcrumb.isPresent else { return false }
        restore()
        breadcrumb.clear()
        return true
    }

    /// Idempotent by construction: re-associating an associated mouse, showing a visible cursor,
    /// and enabling enabled hotkeys are all no-ops, so every recovery path may run redundantly.
    ///
    /// Deliberately not main-actor isolated: the recovery paths that matter most — a signal
    /// handler, an `atexit` hook — have no actor to hop to, and a restore that has to wait for
    /// the main queue is a restore that never runs on a process that is already dying.
    nonisolated static func restoreHostInputState() {
        CGAssociateMouseAndMouseCursorPosition(1)
        CGDisplayShowCursor(CGMainDisplayID())
        _ = MirrorInput.setHostGlobalShortcutsEnabled(true)
    }
}
