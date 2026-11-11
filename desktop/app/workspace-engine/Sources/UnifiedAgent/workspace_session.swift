// Based on Braus (Apache-2.0), https://github.com/ForteAI-Org/braus.
#if canImport(SeatBroker)
import AppKit
import CoreGraphics
import SeatBroker
import AppAdapters
import AutomationMCP
import AutomationRuntime
import Foundation
import LocalMCP
import Memory

private struct MCPRequestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// WorkspaceSession exposes the current engine for one authenticated client connection.
/// The host serializes requests and drains them before closing this session. Disconnects
/// release its Seat; reconnects start fresh and never replay an earlier operation.
@MainActor
final class WorkspaceSession {
    typealias Performing = @MainActor (@escaping @MainActor () async throws -> JSONValue) async throws -> JSONValue

    private let profile: WorkspaceProfile
    private let desktop: BrokeredAutomationSession
    private var humanControl: HumanPreviewControl?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var rightOptionDown: TimeInterval?
    private var rightOptionUsed = false
    private let tools: AutomationTools
    private let perform: Performing
    private let activity: @MainActor (String) -> Void
    /// The client profile's barrier (R05), from the owner that outlives this session, so a reconnect does not reset it.
    private let barrier: ActionBarrier
    private var isClosed = false

    lazy var router: MCPRouter = {
        let router = MCPRouter(
            tools: profile.desktop ? tools.toolDefinitions : [],
            instructions: profile.desktop ? AutomationTools.mcpInstructions(.full) : Self.withoutDesktop
        ) { [weak self] name, arguments in
            guard let self, !self.isClosed else {
                throw MCPRequestFailure("This client is not authorized for desktop access.")
            }
            return try await self.callBraus(name, arguments)
        }

        return router
    }()

    /// `channels` are the routes beyond the Seat `session` was composed with, which decide Braus's tools. `barrier` is
    /// the profile's own, kept by the owner that makes its sessions (R05). `adapters` replaces the Mac's app adapters
    /// with a test's (on a temporary root) only where `channels` already composes them: it never turns the channel
    /// on, and nil, what the app passes, keeps the composition as it is.
    /// `adapterApprover` asks the person in the app before an adapter's irreversible verb runs; without one
    /// those verbs are refused. `offersWeb` says that `session` routes web addresses to a web session.
    init(
        profile: WorkspaceProfile,
        desktop: BrokeredAutomationSession,
        session: any AutomationSessionOperating,
        channels: AutomationChannels = [],
        perform: @escaping Performing = { try await $0() },
        activity: @escaping @MainActor (String) -> Void = { _ in },
        barrier: ActionBarrier,
        adapters: AppAdapters? = nil,
        adapterApprover: (any AdapterApproving)? = nil,
        offersWeb: Bool = false
    ) {
        self.profile = profile
        self.desktop = desktop
        self.barrier = barrier
        self.tools = AutomationTools(session: session, channels: channels,
                                     adapters: channels.contains(.adapters) ? (adapters ?? .standard(approver: adapterApprover)) : nil,
                                     offersWeb: offersWeb)
        if let adapters, channels.contains(.adapters) { self.tools.adapters = adapters }
        self.tools.producer = CallProducer(source: .mcp, streamID: "mcp-" + profile.id.uuidString)
        self.perform = perform
        self.activity = activity
        startRightOptionMonitor()
    }

    /// A standalone tap of the right Option key lends this client's current app
    /// to the person. Other Option combinations pass through untouched.
    private func startRightOptionMonitor() {
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            let type = event.type.rawValue, code: UInt16 = (event.type == .flagsChanged || event.type == .keyDown) ? event.keyCode : 0, flags = event.modifierFlags.rawValue
            let down = code == 61 && CGEventSource.keyState(.combinedSessionState, key: 61)
            Task { @MainActor [weak self] in self?.observeInput(type: type, code: code, flags: flags, down: down) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.observeInput(type: event.type.rawValue, code: (event.type == .flagsChanged || event.type == .keyDown) ? event.keyCode : 0, flags: event.modifierFlags.rawValue, down: CGEventSource.keyState(.combinedSessionState, key: 61))
            return event
        }
    }
    private func observeInput(type: UInt, code: UInt16, flags: UInt, down: Bool) {
        guard !isClosed else { return }
        if type == NSEvent.EventType.flagsChanged.rawValue && code == 61 {
            if down && rightOptionDown == nil {
                rightOptionDown = ProcessInfo.processInfo.systemUptime
                let other = NSEvent.ModifierFlags(rawValue: flags).intersection([.command,.control,.shift,.function])
                rightOptionUsed = !other.isEmpty
            } else if !down, let since = rightOptionDown {
                rightOptionDown = nil
                if !rightOptionUsed && ProcessInfo.processInfo.systemUptime - since < 0.45 {
                    Task { @MainActor [weak self] in await self?.toggleHumanControl() }
                }
            }
        } else if rightOptionDown != nil { rightOptionUsed = true }
    }
    private func toggleHumanControl() async {
        guard !isClosed else { return }
        if let control = humanControl, !control.isFinished {
            await control.finish(.resumingWorker)
            humanControl = nil
            return
        }
        guard desktop.id != nil else { return }
        let control = desktop.makeHumanPreviewControl(
            suspend: { [weak self] in self?.router.suspendForHumanIntervention() },
            waitForAgent: { [weak self] in await self?.router.drain() },
            endAgent: { [weak self] in self?.router.pause() },
            resumeAgent: { [weak self] _, begin in try await begin(); self?.router.resume() }
        )
        humanControl = control
        control.takeControl(on: NSScreen.main)
    }

    /// Braus's own tools, for a profile with desktop access, through the Seat's queue.
    private func callBraus(
        _ name     : String,
        _ arguments: JSONValue
    ) async throws -> JSONValue {
        guard !isClosed, profile.desktop else {
            throw MCPRequestFailure("This client is not authorized for desktop access.")
        }
        if let refusal = barrier.refusal(of: name, arguments) { throw MCPRequestFailure(refusal) }
        activity(name)
        return try await perform { [tools] in
            try await tools.call(
                name,
                arguments
            )
        }
    }

    /// What a profile without desktop access is told instead of the desktop's instructions.
    static let withoutDesktop = "Braus must remain open. This client has no desktop access: it cannot see or "
        + "control the apps on this Mac, and Braus's desktop tools are not offered to it."

    func close() async {
        guard !isClosed else { return }
        isClosed = true
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let humanControl { await humanControl.finish() }
        await tools.session.close()
    }
}

#endif
