// swift-tools-version: 5.9
import PackageDescription

// Hive.app's main executable. Hive's own virtual workspace engine joins this package as it lands.
let package = Package(
    name: "HiveWorkspace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "agent-unified-host", targets: ["agent-unified-host"]),
    ],
    targets: [
        .executableTarget(name: "agent-unified-host", path: "Sources/UnifiedAgent"),
    ]
)
