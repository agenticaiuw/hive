// Agent.app: the voice agent in the menu bar, opened at login. Tap fn anywhere to talk to it, and
// again to stop it listening; the icon fills in while it listens. Hold fn and talk to dictate: when
// you let go, what you said is typed into the app in front (that needs Accessibility for Agent).
// The menu starts and stops listening too, and has Open at Login, the log (~/Library/Logs/Agent.log)
// and Quit.
//
// It runs `python/voice_agent.py --app` from the folder it was built in (AgentRepository in its
// Info.plist), and starts it again if it stops. To macOS the voice agent is part of this app, so
// the Microphone, Screen & System Audio Recording and Accessibility permissions are asked for, and
// given, as "Agent".
//
// make builds it into build/Agent.app; ./install.sh puts it in ~/Applications and has the Mac start
// agent-vhid-helper, which it needs.
//
//   Agent --unregister    take it out of the login items, then quit (./install.sh --uninstall)

import AppKit
import ServiceManagement
import UniformTypeIdentifiers
#if canImport(SpaceOViewer)
import SpaceOViewer
#endif

let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Agent.log")

@MainActor final class AgentApp: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    let toggleItem = NSMenuItem(title: "Start Listening (fn)", action: #selector(toggle), keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
    let contextItem = NSMenuItem(title: "Show Agent Context", action: #selector(showContext), keyEquivalent: "")
    let clipboardItem = NSMenuItem(title: "Add Clipboard to Context…", action: #selector(addClipboard), keyEquivalent: "")
    let fileItem = NSMenuItem(title: "Add Text File to Context…", action: #selector(addFile), keyEquivalent: "")
    let voiceItem = NSMenuItem(title: "Voice", action: #selector(chooseVoice), keyEquivalent: "")
    let lipsItem = NSMenuItem(title: "Lip Reading (camera)", action: #selector(chooseLips), keyEquivalent: "")
    var contextURL: URL?  // the browser view of every payload, the panel's fallback
    var panelURL: URL?  // this session's panel.json
    lazy var panel = ContextPanel()
    var camera = false
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
#if canImport(SpaceOViewer)
    var monitorViewer: AgentWorkspaceViewer?
#endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(toggleItem)
        let dictateItem = NSMenuItem(title: "Hold fn to Dictate", action: nil, keyEquivalent: "")
        dictateItem.isEnabled = false
        menu.addItem(dictateItem)
        menu.addItem(.separator())
        let inputItem = NSMenuItem(title: "Input", action: nil, keyEquivalent: "")
        let inputMenu = NSMenu()
        voiceItem.state = .on
        for choice in [voiceItem, lipsItem] { choice.target = self; inputMenu.addItem(choice) }
        inputItem.submenu = inputMenu
        menu.addItem(inputItem)
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
        item.menu = menu
        show()

        // You asked for it to open at login; once you turn that off in the menu, it stays off.
        if !UserDefaults.standard.bool(forKey: "loginItemSet") {
            try? SMAppService.mainApp.register()
            UserDefaults.standard.set(true, forKey: "loginItemSet")
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off

        openLog()
#if canImport(SpaceOViewer)
        let workspaceSetting = ProcessInfo.processInfo.environment["AGENT_EXPERIMENTAL_SPACEO"]
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
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
#if canImport(SpaceOViewer)
        monitorViewer?.shutdown()
#endif
        stop()
    }

    // MARK: the voice agent

    func start() {
        starts = starts.filter { $0.timeIntervalSinceNow > -120 } + [Date()]
        let python = repository + "/.venv/bin/python"
        guard FileManager.default.isExecutableFile(atPath: python) else {
            statusLine.title = "Not set up: run ./voice.sh once in \(repository)"
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-u", "python/voice_agent.py", "--app"]
        process.currentDirectoryURL = URL(fileURLWithPath: repository)
        var environment = ProcessInfo.processInfo.environment
        // Opened at login, it gets launchd's short PATH; codex and Homebrew's tools live further out.
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
#if canImport(SpaceOViewer)
        if monitorViewer != nil {
            environment["AGENT_SPACEO_COMMAND"] = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/spaceo").path
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

    func stop() {
        guard let process = agent, process.isRunning else { return }
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
            } else if line.hasPrefix("@@ input ") {
                let lips = line.hasSuffix("lips")
                lipsItem.state = lips ? .on : .off
                voiceItem.state = lips ? .off : .on
                show()
            } else if line.hasPrefix("@@ camera ") {
                camera = line.hasSuffix("1")
                show()
            } else if line.hasPrefix("@@ workspace-resume ") {
#if canImport(SpaceOViewer)
                monitorViewer?.resumeAfterTakeover()
#endif
            } else {
                write(line + "\n")
            }
        }
    }

    // Hive's logo, the yellow hexagon, with a small dot while it listens (red), dictates (orange)
    // or uses the camera (green).
    func hiveIcon(dot: NSColor?) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let center = NSPoint(x: rect.midX, y: rect.midY), radius: CGFloat = 8
            let hexagon = NSBezierPath()
            for i in 0..<6 {
                let angle = CGFloat.pi / 2 + CGFloat(i) * .pi / 3
                let point = NSPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
                i == 0 ? hexagon.move(to: point) : hexagon.line(to: point)
            }
            hexagon.close()
            NSColor(srgbRed: 0.976, green: 0.812, blue: 0.341, alpha: 1).setFill()
            hexagon.fill()
            if let dot {
                let spot = NSRect(x: rect.maxX - 7, y: rect.minY, width: 7, height: 7)
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
        if camera {
            button?.image = hiveIcon(dot: .systemGreen)
            button?.setAccessibilityLabel("Hive: camera on, lip reading")
        } else if dictating {
            button?.image = hiveIcon(dot: .systemOrange)
            button?.setAccessibilityLabel("Hive is dictating")
        } else {
            button?.image = hiveIcon(dot: listening ? .systemRed : nil)
            button?.setAccessibilityLabel(listening ? "Hive is listening" : "Hive")
        }
        let lips = lipsItem.state == .on
        toggleItem.title = lips ? (listening ? "Stop Lip Reading (fn)" : "Start Lip Reading (fn)")
            : (listening ? "Stop Listening (fn)" : "Start Listening (fn)")
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

    @objc func chooseVoice() { input?.write(Data("input voice\n".utf8)) }

    @objc func configureMacPassword() { Credentials.configure("mac") }

    @objc func configurePhonePasscode() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: repository + "/.venv/bin/python")
        process.arguments = [repository + "/python/credentials.py", "configure", "phone"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { Credentials.showError(error) }
    }

    @objc func chooseLips() {
        let alert = NSAlert()
        alert.messageText = "Lip reading uses the camera"
        alert.informativeText = "In lip reading mode, tapping fn turns the camera on (the green light, and a caption) until you tap " +
            "it again. Live words appear in the floating window; the final text becomes your request. Everything is " +
            "processed on this Mac. macOS asks for camera access the first time. Run scripts/setup-lipread.sh once " +
            "(4.85 GB model download). Hold-fn dictation still uses the microphone."
        alert.addButton(withTitle: "Use Lip Reading")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { input?.write(Data("input lips\n".utf8)) }
    }

    @objc func restart() {
        starts = []
        if agent == nil {
            start()
        } else {
            stop()  // it starts again once it has stopped
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

@main @MainActor
enum Main {
    static let delegate = AgentApp()

    static func main() {
#if canImport(SpaceOViewer)
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--spaceo-self-test" {
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
