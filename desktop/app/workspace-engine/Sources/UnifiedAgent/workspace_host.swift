// Local workspace host built into Agent; Braus driver and MCP components are Apache-2.0.
import Foundation
#if canImport(SeatBroker)
import AppKit
import SeatBroker
import LocalMCP
import AutomationRuntime

struct WorkspaceProfile {
    let id: UUID
    let desktop = true
}

@MainActor
final class WorkspaceHost {
    private let broker = SeatBroker(configuration: .init(allowUnvalidatedBuild: true))
    private var host: LocalMCPHost?
    private var directory: MCPConnectionDirectory?
    private let profile = WorkspaceProfile(id: UUID(uuidString: "2A737849-499F-4BE4-95E1-C5310DE13059")!)
    private let state: URL
    private(set) var ready = false
    init(state: URL) { self.state = state }
    func start() async -> Bool {
        do {
            let folder = state.appendingPathComponent("workspace-host/MCP", isDirectory: true)
            let directory = MCPConnectionDirectory(url: folder)
            try directory.acquire()
            let knowledge = state.appendingPathComponent("workspace-host/Knowledge", isDirectory: true)
            let broker = self.broker, profile = self.profile
            let host = LocalMCPHost(maximumConnections: 1) {
                let desktop = BrokeredAutomationSession(broker: broker, workerID: UUID(), knowledgeDirectory: knowledge)
                let session = WorkspaceSession(profile: profile, desktop: desktop, session: desktop,
                    perform: { body in
                        var result = JSONValue.null
                        try await desktop.turn { result = try await body() }
                        return result
                    }, activity: { _ in },
                    barrier: ActionBarrier(persistingIn: folder.appendingPathComponent("Refusals"), context: profile.id.uuidString))
                return MCPHostSession(router: session.router) { await session.close() }
            }
            try directory.publish(try await host.start(), for: profile.id)
            self.host = host
            self.directory = directory
            ready = true
            return true
        } catch {
            NSLog("Workspace host could not start: %@", String(describing: error))
            return false
        }
    }
    func stop() async {
        ready = false
        await host?.stopAndDrain()
        try? directory?.remove(profile.id)
        directory?.release()
        host = nil
        directory = nil
    }
    var connectionPath: String { state.appendingPathComponent("workspace-host/MCP/\(profile.id.uuidString).connection.json").path }
}
#else
@MainActor
final class WorkspaceHost {
    let ready = false
    let connectionPath = ""
    init(state: URL) {}
    func start() async -> Bool { false }
    func stop() async {}
}
#endif
