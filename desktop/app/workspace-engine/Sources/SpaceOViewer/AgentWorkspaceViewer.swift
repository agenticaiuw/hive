// SpaceO is MIT-licensed, Copyright 2026 Parth Jadhav and SpaceO contributors.
// This adapter embeds its viewer in Agent rather than installing another app.
import AppKit
import SwiftUI
import CoreGraphics
import SpaceOKit

private struct AgentDesktopView: View {
    @Environment(ViewerModel.self) private var model

    private var ordered: [String] { WorkspaceCycle.ordered(model.sessions) }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color.black
            if model.selectedSession != nil {
                StreamSurface()
                GeometryReader { geometry in
                    let markers = model.agentActionMarkers(viewSize: geometry.size)
                    AgentWorkspaceActionCursor(markers: markers)
                        .id(model.selectedSessionID)
                    AgentActionOverlay(markers: markers)
                }
                .allowsHitTesting(false)
            }
            if model.selectedSession == nil || !model.streamRunning {
                Group {
                    if let error = model.streamError {
                        Text("Virtual display unavailable: \(error)")
                    } else if model.connectivity == .disconnected {
                        Text("Virtual display is offline. Press Right Option to return.")
                    } else if !model.permissions.screenRecording {
                        Text("Screen Recording permission is required to view the virtual display.")
                    } else {
                        ProgressView("Opening virtual display…")
                    }
                }.foregroundStyle(.white)
                 .frame(maxWidth: .infinity, maxHeight: .infinity)
                 .allowsHitTesting(false)
            }
            if let note = model.note, note.isWarning {
                Text(note.text)
                    .font(.callout)
                    .padding(10)
                    .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(.top, 24)
                    .allowsHitTesting(false)
            }
            if let selected = model.selectedSessionID, let index = ordered.firstIndex(of: selected) {
                Text("\(index + 1)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .background(.black.opacity(0.38), in: Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(8)
                    .accessibilityLabel("Virtual display \(index + 1)")
                    .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea()
        .onAppear { selectWorkspaceIfNeeded() }
        .onChange(of: model.sessions.map(\.id)) { _, _ in selectWorkspaceIfNeeded() }
    }

    private func selectWorkspaceIfNeeded() {
        if model.selectedSession == nil, let first = ordered.first { model.selectSession(first) }
    }
}

/// This displays the last reported agent pointer destination without moving the system cursor.
private struct AgentWorkspaceActionCursor: View {
    let markers: [SessionOverlayLayout.ActionMarker]
    @State private var lastPointer: SessionOverlayLayout.ActionMarker?

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let pointer = lastPointer {
                let cursor = NSCursor.arrow
                Image(nsImage: cursor.image)
                    .frame(width: cursor.image.size.width, height: cursor.image.size.height)
                    .position(x: pointer.center.x + cursor.image.size.width / 2 - cursor.hotSpot.x,
                              y: pointer.center.y + cursor.image.size.height / 2 - cursor.hotSpot.y)
                    .accessibilityLabel("Agent pointer, last reported location")
            }
        }
        .onAppear { update(markers) }
        .onChange(of: markers) { _, next in update(next) }
        .allowsHitTesting(false)
    }

    private func update(_ markers: [SessionOverlayLayout.ActionMarker]) {
        guard let marker = markers.first(where: { $0.action == "move" || $0.action == "click" }) else { return }
        lastPointer = marker
    }
}

enum WorkspaceCycle {
    static func ordered(_ sessions: [SessionInfo]) -> [String] {
        var displays = Set<UInt32>()
        return sessions.filter { $0.runtimeAttached != false && !$0.teardownPending }
            .sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
            .compactMap { displays.insert($0.displayID).inserted ? $0.id : nil }
    }

    static func next(current: String?, ordered: [String]) -> String? {
        guard let current else { return ordered.first }
        guard let index = ordered.firstIndex(of: current) else { return ordered.first }
        return index + 1 < ordered.count ? ordered[index + 1] : nil
    }
}

private final class AgentDesktopWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

struct RightOptionTap {
    private var started: TimeInterval?
    private var used = false

    mutating func observe(type: UInt, code: UInt16, flags: UInt, down: Bool, now: TimeInterval) -> Bool {
        if type == NSEvent.EventType.flagsChanged.rawValue && code == 61 {
            if down && started == nil {
                started = now
                used = !NSEvent.ModifierFlags(rawValue: flags).intersection([.command, .control, .shift, .function]).isEmpty
            } else if !down, let started {
                self.started = nil
                return !used && now - started < 0.7
            }
        } else if started != nil && type != NSEvent.EventType.mouseMoved.rawValue {
            used = true
        }
        return false
    }
}

// The virtual display is part of the macOS display arrangement, but it must not
// be reachable by moving the physical pointer across an edge.
struct WorkspacePointerBoundary {
    static func destination(_ point: CGPoint, virtualBounds: [CGRect], previous: CGPoint?, physicalBounds: [CGRect]) -> CGPoint? {
        guard virtualBounds.contains(where: { $0.contains(point) }) else { return nil }
        if let previous, physicalBounds.contains(where: { $0.contains(previous) }),
           !virtualBounds.contains(where: { $0.contains(previous) }) { return previous }
        // Select the nearest actual physical display, including displays left of or above the main display.
        return physicalBounds.filter { !$0.isEmpty }.map { bounds in
            CGPoint(x: min(max(point.x, bounds.minX), bounds.maxX - 1),
                    y: min(max(point.y, bounds.minY), bounds.maxY - 1))
        }.filter { candidate in !virtualBounds.contains(where: { $0.contains(candidate) }) }
         .min { a, b in
             hypot(a.x - point.x, a.y - point.y) < hypot(b.x - point.x, b.y - point.y)
         }
    }

    static func isWorkspaceDisplay(vendor: UInt32, model: UInt32) -> Bool {
        vendor == 0x1AF2 && model == 0x0001
    }
}

@MainActor
public final class AgentWorkspaceViewer: NSObject, NSWindowDelegate {
    private let model = ViewerModel(frontWindowProvider: ViewerModel.productionFrontWindow)
    private var window: NSWindow?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var shortcut = RightOptionTap()
    private var showing = false
    private var previousApplication: NSRunningApplication?
    private var physicalCursorPosition: CGPoint?
    private var workspaceCursorPositions: [String: CGPoint] = [:]
    private var dockInterceptor: AgentDockInterceptor?
    private var dockGeneration = UUID()
    private var pointerTap: CFMachPort?
    private var pointerTapSource: CFRunLoopSource?
    private var lastPhysicalPointer: CGPoint?
    private var displayRefreshTimer: Timer?

    public override init() {
        super.init()
        publishViewerVisibility(false)
        // Preserve geometry even if an existing display has a different aspect ratio.
        setenv("SPACEO_FULLSCREEN_STRETCH", "0", 1)
        setenv("SPACEO_NATIVE_POINTER", "1", 1)
        // Match the physical screen when a new workspace is created, so aspect-fit fills it.
        if getenv("SPACEO_DISPLAY_SIZE") == nil {
            let size = CGDisplayBounds(CGMainDisplayID()).size
            if size.width > 0, size.height > 0 {
                setenv("SPACEO_DISPLAY_SIZE", "\(Int(size.width))x\(Int(size.height))", 1)
            }
        }
        _ = HostInputGuard.repairAbandonedCapture()
        HostInputGuard.installTerminationHandlers()
        displayRefreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.ensurePointerBoundary() }
        }
        installPointerBoundary()
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            let type = event.type.rawValue
            let code = (event.type == .flagsChanged || event.type == .keyDown) ? event.keyCode : 0
            let flags = event.modifierFlags.rawValue
            // The right-option device flag is present for physical and virtual HID keyboards;
            // CGEventSource.keyState can remain false for the latter.
            let down = code == 61 && (flags & 0x40) != 0
            Task { @MainActor [weak self] in self?.handle(type: type, code: code, flags: flags, down: down) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            let code = (event.type == .flagsChanged || event.type == .keyDown) ? event.keyCode : 0
            self?.handle(type: event.type.rawValue, code: code, flags: event.modifierFlags.rawValue,
                         down: code == 61 && (event.modifierFlags.rawValue & 0x40) != 0)
            if let self, self.showing, !self.model.interactionEnabled, event.window === self.window {
                let moved = event.type == .mouseMoved && (event.deltaX != 0 || event.deltaY != 0)
                let acted = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(event.type)
                if moved || acted {
                    self.takeControlWhenReady(until: ProcessInfo.processInfo.systemUptime + 15)
                    return nil // Wait for the agent input gate to close before accepting input.
                }
            }
            return event
        }
    }

    private func publishViewerVisibility(_ visible: Bool) {
        let root = ProcessInfo.processInfo.environment["AGENT_STATE_DIR"] ??
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Personal Agent").path
        let file = URL(fileURLWithPath: root).appendingPathComponent("workspace-viewer-visible")
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (visible ? "1\n" : "0\n").write(to: file, atomically: true, encoding: .utf8)
        } catch { NSLog("Could not publish workspace visibility: \(error)") }
    }

    private func ensurePointerBoundary() {
        if let tap = pointerTap, CFMachPortIsValid(tap) {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
        } else {
            if let source = pointerTapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            pointerTap = nil
            pointerTapSource = nil
            installPointerBoundary()
        }
    }

    private static func activeDisplayBounds() -> (virtual: [CGRect], physical: [CGRect])? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return nil }
        var virtual: [CGRect] = []
        var physical: [CGRect] = []
        for id in ids.prefix(Int(count)) {
            let bounds = CGDisplayBounds(id)
            guard !bounds.isEmpty else { continue }
            if WorkspacePointerBoundary.isWorkspaceDisplay(vendor: CGDisplayVendorNumber(id), model: CGDisplayModelNumber(id)) {
                virtual.append(bounds)
            } else {
                physical.append(bounds)
            }
        }
        return (virtual, physical)
    }

    private func installPointerBoundary() {
        lastPhysicalPointer = CGEvent(source: nil)?.location
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            return MainActor.assumeIsolated {
                let viewer = Unmanaged<AgentWorkspaceViewer>.fromOpaque(info).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    if let tap = viewer.pointerTap { CGEvent.tapEnable(tap: tap, enable: true) }
                    return Unmanaged.passUnretained(event)
                }
                guard let displays = AgentWorkspaceViewer.activeDisplayBounds() else {
                    return Unmanaged.passUnretained(event)
                }
                if let safe = WorkspacePointerBoundary.destination(event.location, virtualBounds: displays.virtual,
                        previous: viewer.lastPhysicalPointer, physicalBounds: displays.physical) {
                    event.location = safe
                    CGWarpMouseCursorPosition(safe)
                    viewer.lastPhysicalPointer = safe
                } else if displays.physical.contains(where: { $0.contains(event.location) }) &&
                            !displays.virtual.contains(where: { $0.contains(event.location) }) {
                    viewer.lastPhysicalPointer = event.location
                }
                return Unmanaged.passUnretained(event)
            }
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                          options: .defaultTap, eventsOfInterest: mask, callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            NSLog("Agent workspace pointer boundary unavailable: could not create event tap")
            return
        }
        pointerTap = tap
        pointerTapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handle(type: UInt, code: UInt16, flags: UInt, down: Bool) {
        if shortcut.observe(type: type, code: code, flags: flags, down: down,
                            now: ProcessInfo.processInfo.systemUptime) { toggle() }
    }

    public func toggle() {
        let ordered = WorkspaceCycle.ordered(model.sessions)
        if showing {
            if let current = model.selectedSessionID, let cursor = CGEvent(source: nil)?.location {
                workspaceCursorPositions[current] = cursor
            }
            if model.interactionEnabled { model.endHumanControl(); model.completeHandoff(note: nil) }
            guard let next = WorkspaceCycle.next(current: model.selectedSessionID, ordered: ordered) else {
                hide(); return
            }
            model.selectSession(next)
            publishViewerVisibility(next == "personal-agent-workspace")
            if let cursor = workspaceCursorPositions[next] { CGWarpMouseCursorPosition(cursor) }
            return
        }
        if let first = WorkspaceCycle.next(current: nil, ordered: ordered) { model.selectSession(first) }
        let surface: NSWindow
        if let existing = window { surface = existing } else {
            surface = AgentDesktopWindow(contentRect: .zero, styleMask: [.borderless],
                                         backing: .buffered, defer: false)
            surface.title = "Agent Workspace"
            surface.delegate = self
            surface.isReleasedWhenClosed = false
            surface.hasShadow = false
            surface.animationBehavior = .none
            surface.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            surface.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
            surface.acceptsMouseMovedEvents = true
            surface.contentView = NSHostingView(rootView: AgentDesktopView().environment(model))
            window = surface
        }
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
        }) else { return }
        surface.setFrame(screen.frame, display: false)
        previousApplication = NSWorkspace.shared.frontmostApplication
        physicalCursorPosition = CGEvent(source: nil)?.location
        showing = true
        publishViewerVisibility(model.selectedSessionID == "personal-agent-workspace")
        if model.selectedSession == nil { model.refresh() }
        NSApp.activate(ignoringOtherApps: true)
        surface.makeKeyAndOrderFront(nil)
        if let id = model.selectedSessionID, let cursor = workspaceCursorPositions[id] { CGWarpMouseCursorPosition(cursor) }
        startDockRouting()
    }

    private func startDockRouting() {
        // Kept opt-in until real Dock click routing has been verified on a reserved host.
        guard ProcessInfo.processInfo.environment["AGENT_EXPERIMENTAL_NATIVE_DOCK"] == "1" else { return }
        let generation = UUID()
        dockGeneration = generation
        let dock = AgentDockInterceptor(
            onReady: { [weak self] in
                Task { @MainActor in
                    guard let self, self.showing, self.dockGeneration == generation,
                          let dock = self.dockInterceptor else { return }
                    dock.enableRouting()
                    self.window?.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.dockWindow)) - 1)
                }
            },
            onApp: { [weak self] path in
                Task { @MainActor in
                    guard let self, self.showing, self.dockGeneration == generation else { return }
                    self.openDockApp(path)
                }
            },
            onUnsupported: { [weak self] in
                Task { @MainActor in
                    guard let self, self.showing, self.dockGeneration == generation else { return }
                    self.model.note = InputNote(text: "That Dock item cannot be opened in the virtual workspace.", isWarning: true)
                }
            },
            onUnavailable: { [weak self] in
                Task { @MainActor in
                    guard let self, self.showing, self.dockGeneration == generation else { return }
                    self.window?.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
                    self.dockInterceptor?.stop()
                    self.dockInterceptor = nil
                    self.model.note = InputNote(text: "The Dock is unavailable in the virtual workspace.", isWarning: true)
                }
            })
        guard let dock, dock.start() else { return }
        dockInterceptor = dock
    }

    private func openDockApp(_ path: String) {
        guard let sessionID = model.selectedSessionID else { return }
        let transport = model.daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                var pause = Request(cmd: "session.control")
                pause.session = sessionID
                pause.operatorScope = true
                pause.paused = true
                let paused = try transport(pause)
                guard paused.ok else { throw SpaceOError.badRequest(paused.error ?? "Could not pause the agent.") }
                var request = Request(cmd: "run")
                request.session = sessionID
                request.operatorScope = true
                request.app = path
                let result = try transport(request)
                guard result.ok else { throw SpaceOError.badRequest(result.error ?? "Could not open the app.") }
                await MainActor.run { [weak self] in self?.model.refreshControlPlane(afterMutation: true) }
            } catch {
                let message = error.localizedDescription
                await MainActor.run { [weak self] in
                    self?.model.note = InputNote(text: message, isWarning: true)
                }
            }
        }
    }

    private func takeControlWhenReady(until deadline: TimeInterval) {
        guard showing, !model.interactionEnabled else { return }
        if let id = model.selectedSessionID {
            model.takeControl(for: id)
            return
        }
        guard ProcessInfo.processInfo.systemUptime < deadline else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.takeControlWhenReady(until: deadline)
        }
    }

    private func hide() {
        guard let surface = window else { return }
        showing = false
        publishViewerVisibility(false)
        surface.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        dockInterceptor?.stop()
        dockInterceptor = nil
        if let id = model.selectedSessionID, let cursor = CGEvent(source: nil)?.location {
            workspaceCursorPositions[id] = cursor
        }
        if model.interactionEnabled { model.endHumanControl() }
        surface.orderOut(nil)
        if let physicalCursorPosition { CGWarpMouseCursorPosition(physicalCursorPosition) }
        physicalCursorPosition = nil
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
            previousApplication?.activate(options: [.activateIgnoringOtherApps])
        }
        previousApplication = nil
    }

    public func windowWillClose(_ notification: Notification) {
        showing = false
        publishViewerVisibility(false)
        dockInterceptor?.stop()
        dockInterceptor = nil
        if model.interactionEnabled { model.endHumanControl() }
    }

    public func shutdown() {
        publishViewerVisibility(false)
        displayRefreshTimer?.invalidate()
        displayRefreshTimer = nil
        if let pointerTap { CGEvent.tapEnable(tap: pointerTap, enable: false) }
        if let pointerTapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), pointerTapSource, .commonModes) }
        pointerTap = nil
        pointerTapSource = nil
        dockInterceptor?.stop()
        dockInterceptor = nil
        if model.interactionEnabled { model.endHumanControl() }
        HostInputGuard.restoreIfCaptureActive()
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        globalMonitor = nil
        localMonitor = nil
    }

    public func resumeAfterTakeover() {
        guard !showing && !model.interactionEnabled else { return }
        if model.pendingHandoff != nil {
            model.completeHandoff(note: nil)
        } else if model.selectedSessionInputPaused {
            model.toggleSelectedAgentPause()
        }
    }
}
