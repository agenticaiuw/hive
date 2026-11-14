// swift-tools-version: 5.9
import PackageDescription

// Hive.app's main executable (agent-unified-host) and Hive's virtual workspace engine.
let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "agent-unified-host", targets: ["agent-unified-host"]),
        .executable(name: "workspace-engine", targets: ["workspace-engine"]),
        .library(name: "WorkspaceViewer", targets: ["WorkspaceViewer"]),
    ],
    targets: [
        // The virtual display (CoreGraphics' CGVirtualDisplay classes, looked up at run time).
        .target(name: "WorkspaceDisplay",
                linkerSettings: [.linkedFramework("Foundation"), .linkedFramework("CoreGraphics")]),
        // State, the session record, the daemon's wire format and the texts Hive parses.
        .target(name: "WorkspaceCore", dependencies: ["WorkspaceDisplay"]),
        // The daemon, the MCP server, the tools and the command line.
        .target(name: "WorkspaceEngine", dependencies: ["WorkspaceCore", "WorkspaceDisplay"],
                linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ApplicationServices"),
                                 .linkedFramework("ScreenCaptureKit")]),
        .executableTarget(name: "workspace-engine", dependencies: ["WorkspaceEngine"], path: "Sources/WorkspaceEngineCLI"),
        // The window in Hive.app where the user watches and takes over the workspace.
        .target(name: "WorkspaceViewer", dependencies: ["WorkspaceCore", "WorkspaceDisplay"],
                linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ScreenCaptureKit"),
                                 .linkedFramework("CoreMedia"), .linkedFramework("CoreVideo")]),
        .executableTarget(name: "agent-unified-host", dependencies: ["WorkspaceViewer"], path: "Sources/UnifiedAgent"),
        .testTarget(name: "WorkspaceEngineTests", dependencies: ["WorkspaceEngine", "WorkspaceCore"]),
    ]
)
