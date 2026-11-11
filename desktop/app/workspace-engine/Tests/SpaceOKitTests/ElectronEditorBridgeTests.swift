import Darwin
import Foundation
import XCTest
@testable import SpaceOKit

final class ElectronEditorBridgeTests: XCTestCase {
    func testPreviewRefusesElectronBeforeAccessibilityOrProcessLaunch() async throws {
        let app = FileManager.default.temporaryDirectory
            .appendingPathComponent("refused-\(UUID().uuidString).app")
        try FileManager.default.createDirectory(
            at: app.appendingPathComponent("Contents/Frameworks/Electron Framework.framework"),
            withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: app) }
        do {
            _ = try await AppLauncher.launch(
                appURL: app, into: CGRect(x: 0, y: 0, width: 800, height: 600),
                onMaterialized: { _ in XCTFail("Refused app must never materialize") })
            XCTFail("Electron launch must be refused")
        } catch SpaceOError.unsupportedTarget(let message) {
            XCTAssertTrue(message.contains("managed Electron launches are unavailable"))
        }
    }

    final class RawUnixServer: @unchecked Sendable {
        let path: String
        private let listener: Int32
        private let responses: [String]
        private let stateLock = NSLock()
        private var capturedRequests: [String] = []
        private var stopped = false
        private var thread: Thread?

        var requests: [String] {
            stateLock.withLock { capturedRequests }
        }

        init?(responses: [String]) {
            self.path = "/tmp/so-electron-\(UUID().uuidString.prefix(10)).sock"
            self.responses = responses
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            guard listener >= 0 else { return nil }

            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let capacity = MemoryLayout.size(ofValue: address.sun_path)
            guard path.utf8.count < capacity else {
                close(listener)
                return nil
            }
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                    _ = strcpy($0, path)
                }
            }
            let didBind = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(
                        listener,
                        $0,
                        socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard didBind == 0, listen(listener, 4) == 0,
                  chmod(path, 0o600) == 0 else {
                close(listener)
                unlink(path)
                return nil
            }
        }

        func start() {
            let worker = Thread { [self] in
                for response in responses {
                    let client = accept(listener, nil, nil)
                    guard client >= 0 else { return }
                    if let request = Transport.readLine(
                        from: client,
                        maximumBytes: 16 * 1_024) {
                        stateLock.withLock { capturedRequests.append(request) }
                    }
                    var payload = Data((response + "\n").utf8)
                    payload.withUnsafeMutableBytes { bytes in
                        guard let base = bytes.baseAddress else { return }
                        _ = Foundation.write(client, base, bytes.count)
                    }
                    close(client)
                }
            }
            thread = worker
            worker.start()
        }

        func stop() {
            let shouldStop = stateLock.withLock {
                guard !stopped else { return false }
                stopped = true
                return true
            }
            guard shouldStop else { return }
            shutdown(listener, SHUT_RDWR)
            close(listener)
            thread?.cancel()
            unlink(path)
        }

        deinit { stop() }
    }

    func testCancelledReadinessDoesNotContactAdapter() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [#"{"ok":true}"#]))
        server.start()
        defer { server.stop() }
        let bridge = ElectronEditorBridge(endpoint: ElectronControlEndpoint(
            socket: URL(fileURLWithPath: server.path), token: "test-secret"))
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            let ready = await bridge.waitUntilReady()
            XCTAssertFalse(ready)
            do {
                _ = try await bridge.ping()
                XCTFail("a cancelled call must not start blocking transport work")
            } catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await task.value
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testVSCodeElectronDetectionRequiresTheActualBundleShape() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-vscode-shape-\(UUID().uuidString).app")
        defer { try? FileManager.default.removeItem(at: root) }
        let framework = root.appendingPathComponent(
            "Contents/Frameworks/Electron Framework.framework")
        let appResources = root.appendingPathComponent("Contents/Resources/app")
        try FileManager.default.createDirectory(
            at: framework, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: appResources.appendingPathComponent("out"),
            withIntermediateDirectories: true)
        try "".write(
            to: appResources.appendingPathComponent("out/cli.js"),
            atomically: true,
            encoding: .utf8)
        try "{}".write(
            to: appResources.appendingPathComponent("product.json"),
            atomically: true,
            encoding: .utf8)

        XCTAssertTrue(AppLauncher.isVSCodeElectronFamily(root))
        try FileManager.default.removeItem(
            at: appResources.appendingPathComponent("out/cli.js"))
        XCTAssertFalse(
            AppLauncher.isVSCodeElectronFamily(root),
            "an arbitrary Electron shell must not receive a VS Code extension")
    }

    func testVSCodeLaunchCarriesRequestedFilesOnTheInitialCommandLine() {
        let extensionRoot = URL(fileURLWithPath: "/tmp/private controller/extensions")
        let first = URL(fileURLWithPath: "/tmp/fixture one.txt")
        let second = URL(fileURLWithPath: "/tmp/-fixture-two.txt")

        XCTAssertEqual(
            AppLauncher.electronLaunchArguments(
                extensionsDirectory: extensionRoot,
                opening: [first, second]),
            [
                "--extensions-dir=/tmp/private controller/extensions",
                "--extensionDevelopmentPath=/tmp/private controller/extensions/spaceo.spaceo-electron-control-0.0.1",
                "--new-window",
                "/tmp/fixture one.txt",
                "/tmp/-fixture-two.txt",
            ])
        XCTAssertEqual(
            AppLauncher.electronLaunchArguments(
                extensionsDirectory: extensionRoot,
                opening: []),
            [
                "--extensions-dir=/tmp/private controller/extensions",
                "--extensionDevelopmentPath=/tmp/private controller/extensions/spaceo.spaceo-electron-control-0.0.1",
            ])
    }

    func testGUIEditorOverridesInheritedElectronNodeMode() {
        let endpoint = ElectronControlEndpoint(socket: URL(fileURLWithPath: "/tmp/test/control.sock"),
                                               token: "synthetic-test-token")
        let result = AppLauncher.electronLaunchEnvironment(
            ["ELECTRON_RUN_AS_NODE": "1", "LANG": "en_US.UTF-8"], endpoint: endpoint)
        XCTAssertEqual(result["ELECTRON_RUN_AS_NODE"], "",
                       "omitting the key would leave the inherited Node-mode flag active")
        XCTAssertEqual(result["LANG"], "en_US.UTF-8")
        XCTAssertEqual(result[ElectronControlAssets.socketEnvironmentKey], endpoint.socket.path)
        XCTAssertEqual(result[ElectronControlAssets.tokenEnvironmentKey], endpoint.token)
    }

    func testEmbeddedControllerIsBoundedAuthenticatedAndEffectAware() {
        let source = ElectronControlAssets.extensionJavaScript
        XCTAssertTrue(source.contains("MAX_REQUEST_BYTES = 16 * 1024"))
        XCTAssertTrue(source.contains("timingSafeEqual"))
        XCTAssertTrue(source.contains("visibleRanges"))
        XCTAssertTrue(source.contains("visible range did not change"))
        XCTAssertTrue(source.contains("openTextDocument"))
        XCTAssertTrue(source.contains("showTextDocument"))
        XCTAssertTrue(source.contains(#"server.on("error""#))
        XCTAssertFalse(source.contains("app.activate"))
        XCTAssertFalse(source.contains("showInactive"))
    }

    /// A split window is addressed by view column. Without one the adapter still refuses rather
    /// than acting on whichever pane happens to hold focus — the guard that used to be spelled
    /// `visibleEditors.length !== 1`.
    func testEmbeddedControllerStillRefusesAnUnaddressedSplit() {
        let source = ElectronControlAssets.extensionJavaScript
        XCTAssertTrue(source.contains("several editor panes are visible"))
        XCTAssertTrue(
            source.contains("revealRange"),
            "a non-focused pane must be scrolled per-editor, not through editorScroll")
        XCTAssertFalse(
            source.contains("focusEditorGroup"),
            "addressing a pane must never move the user's focus into it")
    }

    func testOpenDocumentConfirmsTheExactFileTheEditorAdopted() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"opened":"/tmp/fixture.txt","state":{"column":1,"document":"file:///tmp/fixture.txt","visible":[[0,0,40,0]],"selections":[[0,0,0,0]],"version":1,"lineCount":100}}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        let state = try await bridge.openDocument(
            URL(fileURLWithPath: "/tmp/fixture.txt"))

        XCTAssertEqual(state.document, "file:///tmp/fixture.txt")
        let sent = try XCTUnwrap(server.requests.first)
        let request = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        XCTAssertEqual(request["command"] as? String, "open")
        XCTAssertEqual(request["file"] as? String, "/tmp/fixture.txt")
    }

    func testOpenDocumentRefusesAControllerThatNamesAnotherFile() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"opened":"/tmp/other.txt","state":{"column":1,"document":"file:///tmp/other.txt","visible":[[0,0,40,0]],"selections":[[0,0,0,0]],"version":1,"lineCount":100}}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        do {
            _ = try await bridge.openDocument(
                URL(fileURLWithPath: "/tmp/fixture.txt"))
            XCTFail("the controller must not confirm a different document")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("different document"),
                          error.localizedDescription)
        }
    }

    func testScrollAddressesTheRequestedViewColumn() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"confirmed":true,"changed":true,"before":[[0,0,40,0]],"after":[[80,0,120,0]],"document":"file:///tmp/b.txt","column":2}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        let effect = try await bridge.scroll(deltaY: -1_600, pages: 4, column: 2)
        XCTAssertEqual(effect.column, 2)
        let sent = try XCTUnwrap(server.requests.first)
        XCTAssertTrue(sent.contains("\"column\":2"), sent)
        XCTAssertTrue(sent.contains("\"direction\":\"down\""), sent)
    }

    /// VS Code exposes no horizontal viewport offset, so this one operation cannot be confirmed.
    /// It must say so rather than borrowing the vertical path's certainty.
    func testHorizontalRevealReportsItselfUnconfirmed() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"confirmed":false,"changed":false,"document":"file:///tmp/b.txt","column":1,"reveal":{"line":12,"character":160,"longestVisibleLineLength":300}}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        let reveal = try await bridge.revealHorizontally(deltaX: -600, pages: 2)
        XCTAssertFalse(reveal.confirmed)
        XCTAssertEqual(reveal.character, 160)
        XCTAssertEqual(reveal.longestVisibleLineLength, 300)
        XCTAssertTrue(try XCTUnwrap(server.requests.first).contains("\"direction\":\"right\""))
    }

    func testSelectionReportsTheTextTheEditorAdopted() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"changed":true,"before":[[0,0,0,0]],"after":[[1,0,1,9]],"document":"file:///tmp/b.txt","selectedText":"paragraph"}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        let effect = try await bridge.select(
            anchorLine: 1, anchorCharacter: 0, activeLine: 1, activeCharacter: 9)
        XCTAssertEqual(effect.selectedText, "paragraph")
        XCTAssertTrue(effect.changed)
    }

    func testSelectionRefusesNegativePositions() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: []))
        defer { server.stop() }
        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        do {
            _ = try await bridge.select(
                anchorLine: -1, anchorCharacter: 0, activeLine: 0, activeCharacter: 0)
            XCTFail("a negative position must be refused before it reaches the editor")
        } catch {
            XCTAssertTrue("\(error)".contains("zero or greater"))
        }
    }

    func testBridgeRequiresAndReturnsARealVisibleRangeChange() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"document":"file:///tmp/a.txt","visible":[[0,0,40,0]]}"#,
            #"{"ok":true,"changed":true,"before":[[0,0,40,0]],"after":[[80,0,120,0]],"document":"file:///tmp/a.txt"}"#,
        ]))
        server.start()
        defer { server.stop() }

        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        let document = try await bridge.ping()
        XCTAssertEqual(document, "file:///tmp/a.txt")
        let effect = try await bridge.scroll(deltaY: -1_600, pages: 4)
        XCTAssertEqual(effect.before, [[0, 0, 40, 0]])
        XCTAssertEqual(effect.after, [[80, 0, 120, 0]])
        XCTAssertNotEqual(effect.before, effect.after)
        XCTAssertTrue(server.requests.allSatisfy { $0.contains("test-secret") })
    }

    func testBridgeRejectsASuccessResponseWithoutAnEffect() async throws {
        let server = try XCTUnwrap(RawUnixServer(responses: [
            #"{"ok":true,"changed":false,"before":[[0,0,40,0]],"after":[[0,0,40,0]],"document":"file:///tmp/a.txt"}"#,
        ]))
        server.start()
        defer { server.stop() }
        let bridge = ElectronEditorBridge(
            endpoint: ElectronControlEndpoint(
                socket: URL(fileURLWithPath: server.path),
                token: "test-secret"))
        do {
            _ = try await bridge.scroll(deltaY: -800, pages: 2)
            XCTFail("a successful return with no visible-range change must fail")
        } catch {
            XCTAssertTrue("\(error)".contains("observable visible-range change"))
        }
    }
}
