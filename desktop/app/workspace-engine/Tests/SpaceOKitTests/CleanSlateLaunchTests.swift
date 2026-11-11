import XCTest
@testable import SpaceOKit

/// Deterministic coverage for the per-launch defaults overrides. No application is launched:
/// the eligibility check reads fixture bundles written to a temporary directory.
final class CleanSlateLaunchTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-clean-slate-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func bundle(_ name: String, info: [String: Any], frameworks: [String] = []) throws -> URL {
        let app = root.appendingPathComponent("\(name).app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        var plist = info
        plist["CFBundleIdentifier"] = "test.spaceo.\(name)"
        plist["CFBundlePackageType"] = "APPL"
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        for framework in frameworks {
            try FileManager.default.createDirectory(
                at: contents.appendingPathComponent("Frameworks/\(framework)", isDirectory: true),
                withIntermediateDirectories: true)
        }
        return app
    }

    func testDocumentLaunchWithoutFilesSkipsTheOpenPanelAndRestoration() {
        let arguments = AppLauncher.cleanSlateArguments(openingFiles: false)
        XCTAssertEqual(arguments, [
            "-ApplePersistenceIgnoreState", "YES",
            "-NSQuitAlwaysKeepsWindows", "NO",
            "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO",
        ])
        XCTAssertEqual(arguments.count % 2, 0, "defaults arguments are key/value pairs")
    }

    func testLaunchWithFilesKeepsTheDocumentsAndStillIgnoresRestoration() {
        let arguments = AppLauncher.cleanSlateArguments(openingFiles: true)
        XCTAssertFalse(arguments.contains("-NSShowAppCentricOpenPanelInsteadOfUntitledFile"),
                       "an explicit document must not also get an untitled window")
        XCTAssertTrue(arguments.contains("-ApplePersistenceIgnoreState"))
    }

    func testOnlyPlainAppKitBundlesReceiveDefaultsArguments() throws {
        let appKit = try bundle("Native", info: ["NSPrincipalClass": "NSApplication"])
        XCTAssertTrue(AppLauncher.acceptsDefaultsArguments(appKit))

        let electron = try bundle("Chat", info: ["NSPrincipalClass": "AtomApplication"],
                                  frameworks: ["Electron Framework.framework"])
        XCTAssertFalse(AppLauncher.acceptsDefaultsArguments(electron),
                       "Electron can read the value words as documents")

        let qt = try bundle("Plot", info: ["NSPrincipalClass": "NSApplication"],
                            frameworks: ["QtCore.framework"])
        XCTAssertFalse(AppLauncher.acceptsDefaultsArguments(qt))

        let java = try bundle("IDE", info: ["NSPrincipalClass": "NSApplication", "JVMOptions": [:]])
        XCTAssertFalse(AppLauncher.acceptsDefaultsArguments(java))

        let unknown = try bundle("Tool", info: [:])
        XCTAssertFalse(AppLauncher.acceptsDefaultsArguments(unknown),
                       "no principal class means no evidence the app parses AppKit defaults")
    }
    func testReusedBrowserFilesRequirePrivateEndpointAndNeverFallBackToNativeOpen() throws {
        let chrome = try bundle("Browser", info: [:], frameworks: ["Chromium Framework.framework"])
        XCTAssertEqual(try AppLauncher.reusedBrowserPort(appURL: chrome, devToolsPort: 43123), 43123)
        for port: Int? in [nil, 0, 65536] {
            XCTAssertThrowsError(try AppLauncher.reusedBrowserPort(appURL: chrome, devToolsPort: port))
        }
        let native = try bundle("NativeReuse", info: ["NSPrincipalClass": "NSApplication"])
        XCTAssertNil(try AppLauncher.reusedBrowserPort(appURL: native, devToolsPort: nil))
        let electron = try bundle("Editor", info: [:], frameworks: ["Electron Framework.framework"])
        XCTAssertThrowsError(try AppLauncher.reusedBrowserPort(appURL: electron, devToolsPort: 43123))
    }

}
