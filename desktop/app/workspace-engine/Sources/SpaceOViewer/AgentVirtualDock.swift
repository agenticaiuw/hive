// Show the real macOS Dock on the physical screen while viewing the agent workspace,
// but route app clicks to the workspace instead of activating the user's desktop apps.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import SpaceOKit

struct AgentDockItem: Sendable {
    let frame: CGRect
    let appPath: String?
}

enum AgentDockHit {
    case outside
    case unsupported
    case app(String)

    static func classify(_ point: CGPoint, bounds: CGRect, items: [AgentDockItem]) -> AgentDockHit {
        guard bounds.contains(point) else { return .outside }
        guard let item = items.first(where: { $0.frame.contains(point) }), let path = item.appPath else {
            return .unsupported
        }
        return .app(path)
    }
}

/// The event tap only filters Dock button events while the workspace is on screen.
/// If monitoring fails, the viewer returns above the Dock so clicks cannot leak through.
final class AgentDockInterceptor: @unchecked Sendable {
    private let lock = NSLock()
    private let pid: pid_t
    private var bounds = CGRect.zero
    private var items: [AgentDockItem] = []
    private var active = false
    private var routing = false
    private var suppressedButtons = Set<UInt32>()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "local.personal-agent.dock-snapshot", qos: .utility)
    var onApp: (@Sendable (String) -> Void)?
    var onUnsupported: (@Sendable () -> Void)?
    var onUnavailable: (@Sendable () -> Void)?
    var onReady: (@Sendable () -> Void)?
    private var publishedReady = false

    init?(onReady: @escaping @Sendable () -> Void,
          onApp: @escaping @Sendable (String) -> Void,
          onUnsupported: @escaping @Sendable () -> Void,
          onUnavailable: @escaping @Sendable () -> Void) {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return nil }
        pid = app.processIdentifier
        self.onReady = onReady
        self.onApp = onApp
        self.onUnsupported = onUnsupported
        self.onUnavailable = onUnavailable
    }

    func start() -> Bool {
        let mask = [CGEventType.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                    .otherMouseDown, .otherMouseUp].reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            return Unmanaged<AgentDockInterceptor>.fromOpaque(info).takeUnretainedValue().handle(type, event)
        }
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                    options: .defaultTap, eventsOfInterest: mask, callback: callback,
                    userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        tap = created
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        guard let source else { tap = nil; return false }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        lock.lock(); active = true; lock.unlock()
        CGEvent.tapEnable(tap: created, enable: true)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in self?.refreshSnapshot() }
        self.timer = timer
        timer.resume()
        return true
    }

    func stop() {
        lock.lock(); active = false; routing = false; suppressedButtons.removeAll(); publishedReady = false; lock.unlock()
        timer?.cancel(); timer = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil
    }

    func enableRouting() {
        lock.lock(); routing = active; lock.unlock()
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock(); active = false; routing = false; lock.unlock()
            onUnavailable?()
            return Unmanaged.passUnretained(event)
        }
        let down = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
        let button = UInt32(event.getIntegerValueField(.mouseEventButtonNumber))
        lock.lock()
        guard active, routing else { lock.unlock(); return Unmanaged.passUnretained(event) }
        if !down {
            let suppressed = suppressedButtons.remove(button) != nil
            lock.unlock()
            return suppressed ? nil : Unmanaged.passUnretained(event)
        }
        let hit = AgentDockHit.classify(event.location, bounds: bounds, items: items)
        switch hit {
        case .outside: lock.unlock(); return Unmanaged.passUnretained(event)
        case .unsupported:
            suppressedButtons.insert(button); lock.unlock(); onUnsupported?(); return nil
        case .app(let path):
            suppressedButtons.insert(button); lock.unlock()
            if type == .leftMouseDown {
                let point = event.location
                queue.async { [weak self] in self?.verifyAndOpen(path, at: point) }
            } else { onUnsupported?() }
            return nil
        }
    }

    private func verifyAndOpen(_ expected: String, at point: CGPoint) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        var target: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &target)
        var rawURL: CFTypeRef?
        let matches = result == .success && target.map {
            AXUIElementCopyAttributeValue($0, kAXURLAttribute as CFString, &rawURL) == .success
        } == true && (rawURL as? URL)?.path == expected
        lock.lock(); let stillRouting = active && routing; lock.unlock()
        guard stillRouting else { return }
        if matches { onApp?(expected) } else { onUnsupported?() }
    }

    private func refreshSnapshot() {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        func value(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
        }
        func frame(_ element: AXUIElement) -> CGRect? {
            guard let p = value(element, kAXPositionAttribute as CFString),
                  let s = value(element, kAXSizeAttribute as CFString),
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var origin = CGPoint.zero; var size = CGSize.zero
            guard AXValueGetValue(p as! AXValue, .cgPoint, &origin),
                  AXValueGetValue(s as! AXValue, .cgSize, &size), size.width > 0, size.height > 0 else { return nil }
            return CGRect(origin: origin, size: size)
        }
        guard let children = value(app, kAXChildrenAttribute as CFString) as? [AXUIElement],
              let list = children.first(where: { (value($0, kAXRoleAttribute as CFString) as? String) == "AXList" }),
              let listFrame = frame(list),
              CGDisplayBounds(CGMainDisplayID()).intersects(listFrame),
              let entries = value(list, kAXChildrenAttribute as CFString) as? [AXUIElement] else {
            lock.lock(); let wasActive = active; lock.unlock()
            if wasActive { onUnavailable?() }
            return
        }
        let snapshot: [AgentDockItem] = entries.compactMap { item in
            guard let frame = frame(item) else { return nil }
            let url = value(item, kAXURLAttribute as CFString) as? URL
            let path = url?.isFileURL == true && url?.pathExtension.lowercased() == "app" ? url?.path : nil
            return AgentDockItem(frame: frame, appPath: path)
        }
        lock.lock()
        // A short margin contains icon magnification between AX polls. Unknown clicks in
        // that band are swallowed rather than delivered to the user's physical Dock.
        bounds = listFrame.insetBy(dx: -48, dy: -48); items = snapshot
        let ready = active && !publishedReady
        if ready { publishedReady = true }
        lock.unlock()
        if ready { onReady?() }
    }
}
