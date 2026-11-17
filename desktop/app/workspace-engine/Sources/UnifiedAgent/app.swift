// Agent.app: the voice agent in the menu bar, opened at login. Tap fn anywhere to talk to it, and
// again to stop it listening; the icon fills in while it listens. Hold fn and talk to dictate: when
// you let go, what you said is typed into the app in front (that needs Accessibility for Agent).
// The menu starts and stops listening too, and has Sound (Voice and Chimes) (off: replies are shown,
// not spoken, and agent-vhid-helper plays no chime when the agent takes or gives back the screen), Show Floating Window (off: the card shows only while fn is in use), Open at Login, the
// log (~/Library/Logs/Agent.log), Restart and Quit; Restart and Quit are written in the log and the
// session journal, so a quit isn't taken for a crash.
//
// It runs `build/hive-agent --app` (Rust, crates/hive) from the folder it was built in
// (AgentRepository in its Info.plist), and starts it again if it stops. The voice models run in a
// Python sidecar it starts itself (python/sidecar_voice.py). To macOS the voice agent is part of this app, so
// the Microphone, Screen & System Audio Recording and Accessibility permissions are asked for, and
// given, as "Agent".
//
// make builds it into build/Agent.app; ./install.sh puts it in ~/Applications and has the Mac start
// agent-vhid-helper, which it needs.
//
//   Agent --unregister    take it out of the login items, then quit (./install.sh --uninstall)

import AppKit
import SafariServices
import ServiceManagement
import UniformTypeIdentifiers
#if canImport(WorkspaceViewer)
import WorkspaceViewer
#endif

let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Agent.log")

@MainActor final class AgentApp: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    let toggleItem = NSMenuItem(title: "Start Listening (fn)", action: #selector(toggle), keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
    let safariItem = NSMenuItem(title: "Turn On Hive in Safari…", action: #selector(openSafariSettings), keyEquivalent: "")
    let contextItem = NSMenuItem(title: "Show Agent Context", action: #selector(showContext), keyEquivalent: "")
    let clipboardItem = NSMenuItem(title: "Add Clipboard to Context…", action: #selector(addClipboard), keyEquivalent: "")
    let fileItem = NSMenuItem(title: "Add Text File to Context…", action: #selector(addFile), keyEquivalent: "")
    // Checked as the agent says ("@@ speak 1|0", "@@ window 1|0"); it keeps both for the next launch.
    let speakItem = NSMenuItem(title: "Sound (Voice and Chimes)", action: #selector(toggleSpeak), keyEquivalent: "")
    let windowItem = NSMenuItem(title: "Show Floating Window", action: #selector(toggleWindow), keyEquivalent: "")
    /// The dashboard (dashboard/ at the repository's root) in a window; see dashboard.swift.
    lazy var dashboard = DashboardWindow(files: URL(fileURLWithPath: repository).appendingPathComponent("build/dashboard"),
                                         stateDir: stateDir)
    var contextURL: URL?  // the browser view of every payload, the panel's fallback
    var panelURL: URL?  // this session's panel.json
    lazy var panel = ContextPanel()
    var stateDir: URL {
        if let panelURL { return panelURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Personal Agent")
    }
    let repository = Bundle.main.object(forInfoDictionaryKey: "AgentRepository") as? String ?? ""
    var agent: Process?
    var input: FileHandle?
    var output = Data()  // what the agent printed, up to the end of the last whole line
    var log: FileHandle?
    var starts: [Date] = []
    var quitting = false
    var listening = false, dictating = false
    var workspace: WorkspaceHost?
#if canImport(WorkspaceViewer)
    var monitorViewer: AgentWorkspaceViewer?
#endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        let quietly = launchedQuietly()  // first: it reads the event that opened Hive
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(toggleItem)
        let dictateItem = NSMenuItem(title: "Hold fn to Dictate", action: nil, keyEquivalent: "")
        dictateItem.isEnabled = false
        menu.addItem(dictateItem)
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d"))
        menu.addItem(safariItem)
        menu.addItem(.separator())
        speakItem.state = .on
        windowItem.state = .on
        menu.addItem(speakItem)
        menu.addItem(windowItem)
        let authentication = NSMenuItem(title: "Authentication", action: nil, keyEquivalent: "")
        let authMenu = NSMenu()
        let macPassword = NSMenuItem(title: "Mac Password…", action: #selector(configureMacPassword), keyEquivalent: "")
        let phonePasscode = NSMenuItem(title: "Phone Passcode…", action: #selector(configurePhonePasscode), keyEquivalent: "")
        for choice in [macPassword, phonePasscode] { choice.target = self; authMenu.addItem(choice) }
        authentication.submenu = authMenu
        menu.addItem(authentication)
        menu.addItem(.separator())
        menu.addItem(loginItem)
        menu.autoenablesItems = false
        menu.addItem(NSMenuItem(title: "Show Log", action: #selector(showLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Agent", action: #selector(restart), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Agent", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        menu.delegate = self  // menuWillOpen: hide the Safari item once the extension is on
        item.menu = menu
        show()

        // You asked for it to open at login; once you turn that off in the menu, it stays off.
        if !UserDefaults.standard.bool(forKey: "loginItemSet") {
            try? SMAppService.mainApp.register()
            UserDefaults.standard.set(true, forKey: "loginItemSet")
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off

        openLog()
#if canImport(WorkspaceViewer)
        let workspaceSetting = ProcessInfo.processInfo.environment["AGENT_EXPERIMENTAL_VIRTUAL_WORKSPACE"]
        let workspaceDefault = (Bundle.main.object(forInfoDictionaryKey: "AgentWorkspaceDefault") as? String) != "0"
        if workspaceSetting.map({ $0 != "0" }) ?? workspaceDefault {
            monitorViewer = AgentWorkspaceViewer()
        }
#endif
        // The current seat is a single-window experiment, not the requested multi-window
        // virtual monitor. Do not route the user's tasks to it unless explicitly testing it.
        if ProcessInfo.processInfo.environment["AGENT_EXPERIMENTAL_WINDOW_SEAT"] == "1" {
            let host = WorkspaceHost(state: stateDir)
            workspace = host
            Task { @MainActor in
                _ = await host.start()
                start()
            }
        } else {
            start()
        }

        // Opened by you (Spotlight, Finder, Launchpad, the Dock), Hive shows its window. At login
        // and when an update reopens it, it stays in the menu bar.
        if !quietly { dashboard.show() }
        refreshSafariItem()
    }

    /// Hive was opened at login (the event that launched it says so) or by tools/update-app.sh after
    /// an update (HIVE_STAY_IN_MENU_BAR=1), not by you. Whether Hive was the active app half a
    /// second in didn't tell: opened from Spotlight it often wasn't yet, and no window came.
    func launchedQuietly() -> Bool {
        if ProcessInfo.processInfo.environment["HIVE_STAY_IN_MENU_BAR"] == "1" { return true }
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == AEEventID(kAEOpenApplication) else { return false }
        return event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    /// Opening Hive while it's running (Spotlight, Finder, the Dock) shows its window, not just the menu.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        dashboard.show()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if !quitting { write("--- quit, not from the menu (macOS or another app asked) \(Date())\n") }
        quitting = true
#if canImport(WorkspaceViewer)
        monitorViewer?.shutdown()
#endif
        stop()
    }

    // MARK: the voice agent

    func start() {
        starts = starts.filter { $0.timeIntervalSinceNow > -120 } + [Date()]
        let agentPath = repository + "/build/hive-agent"
        guard FileManager.default.isExecutableFile(atPath: agentPath) else {
            statusLine.title = "Not set up: run ./voice.sh once in \(repository)"
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: agentPath)
        process.arguments = ["--app"]
        process.currentDirectoryURL = URL(fileURLWithPath: repository)
        var environment = ProcessInfo.processInfo.environment
        // Opened at login, it gets launchd's short PATH; codex and Homebrew's tools live further out.
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
#if canImport(WorkspaceViewer)
        if monitorViewer != nil {
            environment["AGENT_WORKSPACE_ENGINE"] = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/workspace-engine").path
        }
#endif
        if let workspace, workspace.ready {
            environment["AGENT_WORKSPACE_CONNECTION"] = workspace.connectionPath
            environment["AGENT_WORKSPACE_BRIDGE"] = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/agent-workspace-bridge").path
        }
        process.environment = environment
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stdout
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.took(data) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async { self?.stopped(process) }
        }
        do {
            try process.run()
        } catch {
            statusLine.title = "Couldn't start the agent: \(error.localizedDescription)"
            return
        }
        agent = process
        input = stdin.fileHandleForWriting
        statusLine.title = "Starting…"
        write("--- started \(Date())\n")
    }

    /// `note` ("quit", "restart") first goes to the agent, which writes it in the log and the
    /// session journal and then stops itself; SIGTERM if it hasn't begun to in half a second.
    func stop(note: String? = nil) {
        guard let process = agent, process.isRunning else { return }
        if let note, let input {
            input.write(Data("\(note)\n".utf8))
            let noted = Date().addingTimeInterval(0.5)
            while process.isRunning && Date() < noted {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
        }
        process.terminate()  // SIGTERM: it stops the task and hands back the mouse and keyboard
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }

    func stopped(_ process: Process) {
        guard process === agent else { return }
        agent = nil
        input = nil
        listening = false
        dictating = false
        show()
        if quitting { return }
        // Again at once, unless it keeps stopping: then every half a minute, and the menu says why.
        let delay: TimeInterval = starts.count >= 3 ? 30 : 1
        if starts.count >= 3 {
            statusLine.title = "The agent keeps stopping (exit \(process.terminationStatus)): see Show Log"
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            if let self, self.agent == nil, !self.quitting { self.start() }
        }
    }

    /// What it prints goes to the log; "@@ listening 1|0", "@@ dictating 1|0" and "@@ status TEXT" lines
    /// are for the menu bar.
    func took(_ data: Data) {
        output.append(data)
        while let end = output.firstIndex(of: UInt8(ascii: "\n")) {
            let line = String(decoding: output[output.startIndex..<end], as: UTF8.self)
            output.removeSubrange(output.startIndex...end)
            if line.hasPrefix("@@ listening ") {
                listening = line.hasSuffix("1")
                show()
            } else if line.hasPrefix("@@ dictating ") {
                dictating = line.hasSuffix("1")
                show()
            } else if line.hasPrefix("@@ status ") {
                statusLine.title = String(line.dropFirst("@@ status ".count))
            } else if line.hasPrefix("@@ context ") {
                contextURL = URL(fileURLWithPath: String(line.dropFirst("@@ context ".count)))
            } else if line.hasPrefix("@@ panel ") {
                panelURL = URL(fileURLWithPath: String(line.dropFirst("@@ panel ".count)))
                panel.feedURL = panelURL
                clipboardItem.isEnabled = true
                fileItem.isEnabled = true
                if panel.isVisible { panel.load(force: true) }
            } else if line.hasPrefix("@@ speak ") {
                speakItem.state = line.hasSuffix("1") ? .on : .off
            } else if line.hasPrefix("@@ window ") {
                windowItem.state = line.hasSuffix("1") ? .on : .off
            } else if line.hasPrefix("@@ workspace-resume ") {
#if canImport(WorkspaceViewer)
                monitorViewer?.resumeAfterTakeover()
#endif
            } else {
                write(line + "\n")
            }
        }
    }

    // Hive's logo (branding/hive.svg) in the menu bar: its flat-topped gold hexagon and two shine
    // lines, without the app icon's dark square. A small dot shows while it listens (red) or
    // dictates (orange).
    func hiveIcon(dot: NSColor?) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
                CGColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
                        blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
            }
            func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
                CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                           colors: stops.map(\.1) as CFArray, locations: stops.map(\.0))!
            }
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
            // The svg's units: the hexagon spans x 212…812 and y 252…772 of its 1024 square.
            let scale = (rect.width - 1) / 600
            cg.saveGState()
            cg.translateBy(x: rect.midX - 512 * scale, y: rect.midY - 512 * scale)
            cg.scaleBy(x: scale, y: scale)
            let hexagon = CGMutablePath()
            hexagon.move(to: point(802, 494.7))
            hexagon.addQuadCurve(to: point(802, 529.3), control: point(812, 512))
            hexagon.addLine(to: point(672, 754.5))
            hexagon.addQuadCurve(to: point(642, 771.8), control: point(662, 771.8))
            hexagon.addLine(to: point(382, 771.8))
            hexagon.addQuadCurve(to: point(352, 754.5), control: point(362, 771.8))
            hexagon.addLine(to: point(222, 529.3))
            hexagon.addQuadCurve(to: point(222, 494.7), control: point(212, 512))
            hexagon.addLine(to: point(352, 269.5))
            hexagon.addQuadCurve(to: point(382, 252.2), control: point(362, 252.2))
            hexagon.addLine(to: point(642, 252.2))
            hexagon.addQuadCurve(to: point(672, 269.5), control: point(662, 252.2))
            hexagon.closeSubpath()
            cg.saveGState()
            cg.addPath(hexagon)
            cg.clip()
            cg.drawLinearGradient(gradient([(0, color(0xFFEBB0)), (0.28, color(0xF6C547)),
                                            (0.68, color(0xDC9C22)), (1, color(0xA86C10))]),
                                  start: point(702, 252), end: point(322, 772), options: [])
            cg.restoreGState()
            // The shine lines, a little wider than the svg's so they still show at 18 points.
            for (from, to, fade) in [(point(442, 282), point(630, 282), false),
                                     (point(659, 306), point(720, 413), true)] {
                cg.saveGState()
                cg.setLineWidth(26)
                cg.setLineCap(.round)
                cg.move(to: from)
                cg.addLine(to: to)
                cg.replacePathWithStrokedPath()
                cg.clip()
                let shine = [(CGFloat(0), color(0xFFF9E6, fade ? 0.95 : 0)), (1, color(0xFFF9E6, fade ? 0 : 0.95))]
                cg.drawLinearGradient(gradient(shine), start: from, end: to,
                                      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
                cg.restoreGState()
            }
            cg.restoreGState()
            if let dot {
                let spot = NSRect(x: rect.maxX - 7, y: rect.maxY - 7, width: 7, height: 7)
                NSColor.black.withAlphaComponent(0.55).setFill()
                NSBezierPath(ovalIn: spot.insetBy(dx: -1, dy: -1)).fill()
                dot.setFill()
                NSBezierPath(ovalIn: spot).fill()
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    func show() {
        let button = item.button
        button?.contentTintColor = nil
        if dictating {
            button?.image = hiveIcon(dot: .systemOrange)
            button?.setAccessibilityLabel("Hive is dictating")
        } else {
            button?.image = hiveIcon(dot: listening ? .systemRed : nil)
            button?.setAccessibilityLabel(listening ? "Hive is listening" : "Hive")
        }
        toggleItem.title = listening ? "Stop Listening (fn)" : "Start Listening (fn)"
    }

    // MARK: the log

    func openLog() {
        let manager = FileManager.default
        try? manager.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? manager.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > 5_000_000 {
            let old = logURL.deletingPathExtension().appendingPathExtension("old.log")
            try? manager.removeItem(at: old)
            try? manager.moveItem(at: logURL, to: old)
        }
        if !manager.fileExists(atPath: logURL.path) {
            manager.createFile(atPath: logURL.path, contents: nil)
        }
        log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
    }

    func write(_ text: String) {
        log?.write(Data(text.utf8))
    }

    // MARK: the menu

    @objc func toggle() {
        input?.write(Data("toggle\n".utf8))  // the same as tapping fn
    }

    @objc func toggleLogin() {
        let service = SMAppService.mainApp
        if service.status == .enabled {
            try? service.unregister()
        } else {
            try? service.register()
        }
        loginItem.state = service.status == .enabled ? .on : .off
    }

    @objc func openDashboard() { dashboard.show() }

    /// Hive's Safari extension (Contents/PlugIns/Hive.appex) does nothing until you turn it on in
    /// Safari's settings; this opens them at it. Only the app that carries an extension may ask
    /// Safari about it, so this lives here.
    var safariExtension: String { (Bundle.main.bundleIdentifier ?? "local.personal-agent.Agent") + ".Safari" }

    @objc func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: safariExtension, completionHandler: nil)
    }

    /// Hides "Turn On Hive in Safari…" once the extension is on.
    func refreshSafariItem() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: safariExtension) { state, _ in
            let on = state?.isEnabled ?? false
            Task { @MainActor [weak self] in self?.safariItem.isHidden = on }
        }
    }

    /// hive:// links (`open hive://tasks`) open the dashboard there.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "hive" { dashboard.show(path: DashboardWindow.path(for: url)) }
    }

    @objc func showLog() {
        NSWorkspace.shared.open(logURL)
    }

    @objc func showContext() {
        panel.show(feed: panelURL)
    }

    @objc func addClipboard() {
        guard let text = NSPasteboard.general.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            let alert = NSAlert()
            alert.messageText = "There's no text on the clipboard."
            alert.informativeText = "Copy the text (a transcript, say) first, then choose Add Clipboard to Context again."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }
        ingest(text, source: "the clipboard")
    }

    @objc func addFile() {
        let open = NSOpenPanel()
        open.allowedContentTypes = [.plainText, .text, .json, .html, .xml, .commaSeparatedText]
        open.message = "Choose a text file (a transcript, notes) to add to the agent's conversation"
        NSApp.activate(ignoringOtherApps: true)
        guard open.runModal() == .OK, let url = open.url else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            let alert = NSAlert()
            alert.messageText = "That file isn't UTF-8 text."
            alert.runModal()
            return
        }
        ingest(text, source: "“\(url.lastPathComponent)”")
    }

    func ingest(_ text: String, source: String) {
        guard let title = confirmIngest(text: text, source: source) else { return }
        guard let input, let file = writeIngestFile(text: text, title: title, stateDir: stateDir) else {
            statusLine.title = "Couldn't add the text: the agent isn't running"
            return
        }
        input.write(Data("ingest \(file.path)\n".utf8))
        statusLine.title = "Adding “\(title.prefix(40))” to the conversation…"
        panel.show(feed: panelURL)  // where you see whether it got there
    }

    // The checkmark changes when the agent says it has (a line it's sent before it's running is dropped).
    @objc func toggleSpeak() { input?.write(Data("speak \(speakItem.state == .on ? "off" : "on")\n".utf8)) }

    @objc func toggleWindow() { input?.write(Data("window \(windowItem.state == .on ? "off" : "on")\n".utf8)) }

    @objc func configureMacPassword() { Credentials.configure("mac") }

    @objc func configurePhonePasscode() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: repository + "/build/hive-credentials")
        process.arguments = ["configure", "phone"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { Credentials.showError(error) }
    }

    @objc func restart() {
        write("--- restart from the menu \(Date())\n")
        starts = []
        if agent == nil {
            start()
        } else {
            stop(note: "restart")  // it starts again once it has stopped
        }
    }

    @objc func quit() {
        write("--- quit from the menu \(Date())\n")
        quitting = true
        stop(note: "quit")
        NSApp.terminate(nil)
    }
}

extension AgentApp: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) { refreshSafariItem() }
}

@main @MainActor
enum Main {
    static let delegate = AgentApp()

    static func main() {
#if canImport(WorkspaceViewer)
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--viewer-self-test" {
            _ = NSApplication.shared
            let viewer = AgentWorkspaceViewer()
            withExtendedLifetime(viewer) {
                print("Embedded workspace viewer initialized")
                print("Input monitoring: \(CGPreflightListenEventAccess())")
            }
            return
        }
#endif
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--workspace-serve" {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let host = WorkspaceHost(state: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
            Task { @MainActor in
                guard await host.start() else { exit(1) }
                print("Workspace ready"); fflush(stdout)
            }
            app.run()
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--workspace-self-test" {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let host = WorkspaceHost(state: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
            Task { @MainActor in
                let ready = await host.start()
                if ready { print("Workspace host started and stopped."); fflush(stdout); await host.stop() }
                exit(ready ? 0 : 1)
            }
            app.run()
        }
        if CommandLine.arguments.dropFirst().first == "--credential" {
            exit(Credentials.command(Array(CommandLine.arguments.dropFirst(2))))
        }
        if let command = CommandLine.arguments.dropFirst().first,
           ["--login-status", "--login-register", "--login-unregister"].contains(command) {
            let service = SMAppService.mainApp
            do {
                if command == "--login-register" { try service.register() }
                if command == "--login-unregister" { try service.unregister() }
            } catch {
                fputs("Login item operation failed.\n", stderr)
                exit(1)
            }
            switch service.status {
            case .enabled: print("enabled")
            case .notRegistered: print("notRegistered")
            case .notFound: print("notFound")
            case .requiresApproval: print("requiresApproval")
            @unknown default: print("unknown")
            }
            exit(0)
        }
        if CommandLine.arguments.dropFirst().first == "--unregister" {
            try? SMAppService.mainApp.unregister()
            exit(0)
        }
        if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--panel-snapshot" {
            // Agent --panel-snapshot panel.json out.png: draws the context panel offscreen, for tests.
            _ = NSApplication.shared
            exit(ContextPanel.snapshot(feed: URL(fileURLWithPath: CommandLine.arguments[2]),
                                       to: URL(fileURLWithPath: CommandLine.arguments[3])) ? 0 : 1)
        }
        signal(SIGPIPE, SIG_IGN)  // writing to an agent that has just stopped
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)  // the menu bar only, no Dock icon
        app.delegate = delegate
        app.run()
    }
}
