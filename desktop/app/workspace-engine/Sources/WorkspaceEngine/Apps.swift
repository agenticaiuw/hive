// Opening apps in the workspace and keeping their windows there, and the displays themselves.
import AppKit
import CoreGraphics
import Foundation
import WorkspaceCore
import WorkspaceDisplay

/// The real virtual display (WorkspaceDisplay.m).
final class RealDisplay: WorkspaceDisplayHandle {
    let made: HiveWorkspaceDisplay
    init(_ made: HiveWorkspaceDisplay) { self.made = made }
    var displayID: UInt32 { made.displayID }
    var bounds: CGRect { CGDisplayBounds(made.displayID) }
    func invalidate() { made.invalidate() }
}

struct RealDisplays: DisplayProvider {
    func make(width: Int, height: Int, name: String) throws -> WorkspaceDisplayHandle {
        var reason: NSString?
        guard let made = HiveWorkspaceDisplay.create(withWidth: UInt32(width), height: UInt32(height), name: name, reason: &reason) else {
            throw WorkspaceError("display_creation_failed", (reason as String?) ?? "the display could not be made")
        }
        tuckAway(made.displayID)
        return RealDisplay(made)
    }

    func online() -> [UInt32] { HiveWorkspaceDisplaysOnline().map { $0.uint32Value } }

    /// Puts the display off the bottom-right corner of the user's screens, touching them only at a
    /// corner, so the user's pointer doesn't wander onto it.
    func tuckAway(_ id: CGDirectDisplayID) {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        guard CGGetOnlineDisplayList(32, &ids, &count) == .success else { return }
        var union = CGRect.null
        for other in ids.prefix(Int(count)) where other != id { union = union.union(CGDisplayBounds(other)) }
        guard !union.isNull else { return }
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success, let config else { return }
        CGConfigureDisplayOrigin(config, id, Int32(union.maxX), Int32(union.maxY))
        if CGCompleteDisplayConfiguration(config, .forSession) != .success { CGCancelDisplayConfiguration(config) }
    }
}

/// A stand-in display for tests of the engine's processes: nothing is shown or created.
final class TestDisplay: WorkspaceDisplayHandle {
    static var online: Set<UInt32> = []
    static let lock = NSLock()
    let displayID: UInt32
    let bounds: CGRect
    init(id: UInt32, width: Int, height: Int) {
        displayID = id
        bounds = CGRect(x: 5000, y: 5000, width: width, height: height)
        TestDisplay.lock.lock()
        TestDisplay.online.insert(id)
        TestDisplay.lock.unlock()
    }
    func invalidate() {
        TestDisplay.lock.lock()
        TestDisplay.online.remove(displayID)
        TestDisplay.lock.unlock()
    }
}

struct TestDisplays: DisplayProvider {
    func make(width: Int, height: Int, name: String) throws -> WorkspaceDisplayHandle {
        TestDisplay(id: 9000 + UInt32.random(in: 1...999), width: width, height: height)
    }
    func online() -> [UInt32] {
        TestDisplay.lock.lock()
        defer { TestDisplay.lock.unlock() }
        return Array(TestDisplay.online)
    }
}

struct RealHousekeeper: AppHousekeeper {
    func putAway(_ apps: [SessionApp]) {
        for app in apps {
            guard let running = NSRunningApplication(processIdentifier: app.pid), !running.isTerminated,
                  app.bundleID.isEmpty || running.bundleIdentifier == app.bundleID else { continue }
            running.hide()
            running.terminate()
        }
    }
}

struct NoHousekeeper: AppHousekeeper {
    func putAway(_ apps: [SessionApp]) {}
}

enum Apps {
    static let chromium = ["com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac", "com.brave.Browser",
                           "com.google.Chrome.canary", "com.vivaldi.Vivaldi"]

    static func alive(_ pid: Int32) -> Bool {
        guard let running = NSRunningApplication(processIdentifier: pid) else { return processAlive(pid) }
        return !running.isTerminated
    }

    /// An app by name ("TextEdit"), bundle id or path.
    static func resolve(_ name: String) throws -> URL {
        let fileManager = FileManager.default
        if name.hasPrefix("/") {
            guard fileManager.fileExists(atPath: name) else { throw WorkspaceError("app_not_found", "there is no app at \(name)") }
            return URL(fileURLWithPath: name)
        }
        if name.contains("."), !name.hasSuffix(".app"), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
            return url
        }
        let file = name.hasSuffix(".app") ? name : name + ".app"
        let home = fileManager.homeDirectoryForCurrentUser.path
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                       "/Applications/Utilities", "\(home)/Applications", "/System/Library/CoreServices"] {
            let path = "\(folder)/\(file)"
            if fileManager.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
        }
        // Names differ in case or spacing from the bundle's file name ("google chrome").
        for folder in ["/Applications", "/System/Applications", "\(home)/Applications"] {
            for entry in (try? fileManager.contentsOfDirectory(atPath: folder)) ?? []
            where entry.lowercased() == file.lowercased() {
                return URL(fileURLWithPath: "\(folder)/\(entry)")
            }
        }
        throw WorkspaceError("app_not_found", "no app called \"\(name)\" was found")
    }

    /// Opens a separate copy of the app, without bringing it in front of the user's work.
    /// Refuses when macOS hands back a copy that was already running: that one is the user's.
    static func launch(_ url: URL, arguments: [String] = []) throws -> NSRunningApplication {
        let bundleID = Bundle(url: url)?.bundleIdentifier
        let before = Set((bundleID.map { NSRunningApplication.runningApplications(withBundleIdentifier: $0) } ?? []).map(\.processIdentifier))
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.createsNewApplicationInstance = true
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        configuration.arguments = arguments
        final class Box { var app: NSRunningApplication?; var error: Error? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
            box.app = app
            box.error = error
            done.signal()
        }
        guard done.wait(timeout: .now() + 30) == .success else {
            throw WorkspaceError("launch_failed", "\(url.deletingPathExtension().lastPathComponent) did not start within 30 seconds")
        }
        guard let app = box.app else {
            throw WorkspaceError("launch_failed", box.error?.localizedDescription ?? "the app did not start")
        }
        if before.contains(app.processIdentifier) {
            throw WorkspaceError("app_in_use", "\(app.localizedName ?? "That app") is already open on the user's screen and won't run a second copy; it was left alone")
        }
        return app
    }

    /// Moves the windows of these apps that aren't on the stage onto it. Returns how many moved.
    @discardableResult
    static func herd(_ pids: [Int32], onto stage: Stage) -> Int {
        var moved = 0
        var slot = 0
        for pid in pids {
            for window in AX.windows(pid) {
                guard let frame = AX.frame(window), frame.width > 1, frame.height > 1 else { continue }
                if stage.holds(frame) { continue }
                if AX.move(window, to: stage.slot(slot, size: frame.size)) { moved += 1 }
                slot += 1
            }
        }
        return moved
    }

    /// Waits for the app's first window and brings it onto the stage.
    static func settle(_ pid: Int32, onto stage: Stage, others: [Int32], timeout: Double = 8) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            herd(others + [pid], onto: stage)
            if AX.windows(pid).contains(where: { AX.frame($0).map(stage.holds) ?? false }) { return true }
            usleep(150_000)
        } while Date() < deadline
        return false
    }

    static func runOnMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }
}
