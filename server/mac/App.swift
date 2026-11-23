// Hive Server.app's window: it moves itself into Applications the first time, then shows setup (hive-server ui, beside this
// program) in a window of its own. Setup's page is served by hive-server on this computer only; closing the window quits both.
import Cocoa
import WebKit

@main
final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate {
    var window: NSWindow?
    var server: Process?

    static func main() {
        let app = NSApplication.shared
        let delegate = App()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = menu()
        NSApp.activate(ignoringOtherApps: true)
        if moveToApplications() { return }
        let p = Process()
        p.executableURL = Bundle.main.url(forAuxiliaryExecutable: "hive-server")
        p.arguments = ["ui"]
        let out = Pipe()
        p.standardOutput = out
        do { try p.run() } catch { fail("Hive Server couldn't start: \(error.localizedDescription)"); return }
        server = p
        DispatchQueue.global().async {
            var line = Data()
            while let c = try? out.fileHandleForReading.read(upToCount: 1), let b = c.first, b != 10 { line.append(b) }
            let url = URL(string: String(decoding: line, as: UTF8.self))
            DispatchQueue.main.async { if let url { self.show(url) } else { self.fail("Hive Server stopped before its window opened.") } }
        }
    }

    func show(_ url: URL) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 680), styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Hive"
        let web = WKWebView(frame: w.contentView!.bounds)
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        w.contentView = web
        w.delegate = self
        w.center()
        w.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: url))
        window = w
    }

    // Links that open a new window (sign-in pages, the dashboard) go to the person's browser.
    func webView(_ web: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { server?.terminate() }

    func fail(_ text: String) {
        let a = NSAlert()
        a.messageText = text
        a.runModal()
        NSApp.terminate(nil)
    }

    func menu() -> NSMenu {
        let bar = NSMenu(), item = NSMenuItem(), m = NSMenu()
        m.addItem(withTitle: "Quit Hive Server", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = m
        bar.addItem(item)
        let edit = NSMenuItem(), e = NSMenu(title: "Edit")
        e.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        e.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        e.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = e
        bar.addItem(edit)
        return bar
    }

    /// Opened from anywhere but Applications (Downloads, usually): offers to move there, so cleaning up Downloads never removes
    /// it. True when it moved and the copy in Applications is opening instead.
    func moveToApplications() -> Bool {
        let here = Bundle.main.bundleURL
        let original = originalLocation(of: here) ?? here
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if original.path.hasPrefix("/Applications/") || original.path.hasPrefix(home + "/Applications/") { return false }
        let a = NSAlert()
        a.messageText = "Move Hive Server to your Applications folder?"
        a.informativeText = "That way it stays put when you clean up Downloads, and you can open it again from Applications."
        a.addButton(withTitle: "Move to Applications")
        a.addButton(withTitle: "Not Now")
        guard a.runModal() == .alertFirstButtonReturn else { return false }
        let fm = FileManager.default
        let dirs = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: home + "/Applications")]
        for dir in dirs where fm.isWritableFile(atPath: dir.path) || (!fm.fileExists(atPath: dir.path) && dir.path.hasPrefix(home)) {
            let dest = dir.appendingPathComponent("Hive Server.app")
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                if fm.fileExists(atPath: dest.path) { try fm.trashItem(at: dest, resultingItemURL: nil) }
                try fm.copyItem(at: here, to: dest)
            } catch { continue }
            // macOS already checked this download when it was opened, so the copy needn't ask again.
            run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dest.path])
            if original != dest { try? fm.trashItem(at: original, resultingItemURL: nil) }
            run("/usr/bin/open", ["-n", dest.path])
            NSApp.terminate(nil)
            return true
        }
        let f = NSAlert()
        f.messageText = "Hive Server couldn't move itself to Applications."
        f.informativeText = "Drag it into Applications in Finder and open it from there, or carry on from where it is."
        f.runModal()
        return false
    }

    func run(_ cmd: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        try? p.run()
        p.waitUntilExit()
    }

    /// Where the app really is: macOS runs a downloaded app from a hidden copy ("translocation") until it's moved.
    func originalLocation(of url: URL) -> URL? {
        guard let sec = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
              let isT = dlsym(sec, "SecTranslocateIsTranslocatedURL"),
              let orig = dlsym(sec, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        typealias IsT = @convention(c) (CFURL, UnsafeMutablePointer<DarwinBoolean>, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> DarwinBoolean
        typealias Orig = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        var translocated: DarwinBoolean = false
        guard unsafeBitCast(isT, to: IsT.self)(url as CFURL, &translocated, nil).boolValue, translocated.boolValue else { return nil }
        return unsafeBitCast(orig, to: Orig.self)(url as CFURL, nil)?.takeRetainedValue() as URL?
    }
}
