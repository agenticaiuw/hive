import XCTest
import Foundation
@testable import SpaceOKit

final class ChromiumEvaluationTests: XCTestCase {
    private func withBridge(
        executor: @escaping (String, [String: Any]) async throws -> [String: Any],
        body: (ChromiumBridge) async throws -> Void
    ) async throws {
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one"), (id: "B", title: "two")], port: port)
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: executor)
        try await bridge.attach(toTargetID: "A")
        do { try await body(bridge) }
        catch { await bridge.detach(); throw error }
        await bridge.detach()
    }

    func testSelectionPreviewMarksPartialAndCompleteCopyRefusesPartial() async throws {
        var calls = 0
        try await withBridge(executor: { _, params in
            calls += 1
            let expression = try XCTUnwrap(params["expression"] as? String)
            XCTAssertTrue(expression.contains("codePointAt"))
            return ["result": ["value": #"{"text":"preview","truncated":true}"#]]
        }) { bridge in
            let preview = try await bridge.selectionPreview()
            XCTAssertEqual(preview, "preview…")
            do { _ = try await bridge.selectionText(); XCTFail("partial copy must fail") }
            catch { XCTAssertTrue(error.localizedDescription.contains("1 MiB")) }
        }
        XCTAssertEqual(calls, 2)
    }

    func testSelectionRepliesValidateActualTextSizeAndEmptySelection() async throws {
        for text in ["", "whole selection", String(repeating: "x", count: 1_048_577)] {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: ["text": text, "truncated": false]), as: UTF8.self)
            try await withBridge(executor: { _, _ in ["result": ["value": json]] }) { bridge in
                if text.utf8.count > SessionClipboard.maximumBytes {
                    do { _ = try await bridge.selectionText(); XCTFail("oversize complete report must fail") }
                    catch { XCTAssertTrue(error.localizedDescription.contains("1 MiB")) }
                    do { _ = try await bridge.selectionPreview(); XCTFail("oversize preview must fail") }
                    catch { }
                } else {
                    let selection = try await bridge.selectionText()
                    XCTAssertEqual(selection, text.isEmpty ? nil : text)
                }
            }
        }
    }

    func testEvaluationAndViewportUseAnEngineTimeoutWithoutCleanupForPrimitives() async throws {
        var calls: [String] = []
        var groups = Set<String>()
        try await withBridge(executor: { method, params in
            calls.append(method)
            XCTAssertEqual(method, "Runtime.evaluate")
            XCTAssertEqual(params["timeout"] as? Int, 5_000)
            XCTAssertEqual(params["returnByValue"] as? Bool, true)
            XCTAssertTrue(groups.insert(try XCTUnwrap(params["objectGroup"] as? String)).inserted)
            let expression = params["expression"] as? String ?? ""
            let value = expression == "1" ? "1" : #"{"x":3,"y":4,"w":800,"h":600}"#
            return ["result": ["value": value]]
        }) { bridge in
            let value = try await bridge.evaluate("1")
            XCTAssertEqual(value, "1")
            let viewport = try await bridge.viewportOnScreen()
            XCTAssertEqual(viewport, CGRect(x: 3, y: 4, width: 800, height: 600))
        }
        XCTAssertEqual(calls, ["Runtime.evaluate", "Runtime.evaluate"])
    }

    func testUnsupportedExecutionTimeoutIsNeverRetriedWithoutTheBudget() async throws {
        var calls = 0
        try await withBridge(executor: { method, params in
            calls += 1
            XCTAssertEqual(method, "Runtime.evaluate")
            XCTAssertNotNil(params["timeout"])
            throw SpaceOError.badRequest("Invalid parameters: timeout")
        }) { bridge in
            do { _ = try await bridge.evaluate("1"); XCTFail("expected protocol refusal") }
            catch { XCTAssertTrue(error.localizedDescription.contains("Invalid parameters")) }
        }
        XCTAssertEqual(calls, 1)
    }

    func testRemoteResultAndExceptionHandlesAreReleasedInTheirOwnGroup() async throws {
        for throwsException in [false, true] {
            var group: String?
            var methods: [String] = []
            try await withBridge(executor: { method, params in
                methods.append(method)
                if method == "Runtime.releaseObjectGroup" {
                    XCTAssertEqual(params["objectGroup"] as? String, group)
                    return [:]
                }
                group = try XCTUnwrap(params["objectGroup"] as? String)
                let object: [String: Any] = ["type": "object", "description": "Promise", "objectId": "remote-1"]
                return throwsException
                    ? ["result": ["type": "undefined"], "exceptionDetails": ["text": "Uncaught", "exception": object]]
                    : ["result": object]
            }) { bridge in
                do {
                    let value = try await bridge.evaluate("expression")
                    XCTAssertFalse(throwsException)
                    XCTAssertEqual(value, "Promise")
                } catch {
                    XCTAssertTrue(throwsException)
                    XCTAssertTrue(error.localizedDescription.contains("JavaScript evaluation failed: Uncaught"))
                }
            }
            XCTAssertEqual(methods, ["Runtime.evaluate", "Runtime.releaseObjectGroup"])
        }
    }

    func testCancelledEvaluationStillReleasesReturnedHandles() async throws {
        var methods: [String] = []
        try await withBridge(executor: { method, _ in
            methods.append(method)
            if method == "Runtime.evaluate" {
                withUnsafeCurrentTask { $0?.cancel() }
                return ["result": ["objectId": "remote-1", "description": "Object"]]
            }
            XCTAssertFalse(Task.isCancelled, "cleanup needs an uncancelled task")
            return [:]
        }) { bridge in
            await Task {
                do { _ = try await bridge.evaluate("expression"); XCTFail("cancellation must survive cleanup") }
                catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
            }.value
        }
        XCTAssertEqual(methods, ["Runtime.evaluate", "Runtime.releaseObjectGroup"])
    }

    func testCleanupFailureRetiresTheBindingAndPreservesAnOriginalException() async throws {
        for exception in [false, true] {
            try await withBridge(executor: { method, _ in
                if method == "Runtime.releaseObjectGroup" { throw SpaceOError.badRequest("cleanup failed") }
                var result: [String: Any] = ["result": ["objectId": "remote-1", "description": "Object"]]
                if exception { result["exceptionDetails"] = ["text": "original script failure"] }
                return result
            }) { bridge in
                do { _ = try await bridge.evaluate("expression"); XCTFail("failed cleanup cannot keep a usable binding") }
                catch {
                    if exception { XCTAssertTrue(error.localizedDescription.contains("original script failure")) }
                }
                let target = await bridge.boundTargetID
                XCTAssertNil(target)
            }
        }
    }

    func testCleanupCannotFollowAnEvaluationOntoAReplacementPage() async throws {
        let started = expectation(description: "evaluation started")
        let pause = SessionOperationGate()
        let held = try await pause.enter()
        defer { held.finish() }
        var methods: [String] = []
        try await withBridge(executor: { method, _ in
            methods.append(method)
            started.fulfill()
            let lease = try await pause.enter()
            lease.finish()
            return ["result": ["objectId": "remote-A", "description": "Object"]]
        }) { bridge in
            let evaluation = Task {
                do { _ = try await bridge.evaluate("expression"); XCTFail("rebind must invalidate the result") }
                catch { XCTAssertTrue(error.localizedDescription.contains("target changed")) }
            }
            await fulfillment(of: [started], timeout: 1)
            try await bridge.attach(toTargetID: "B")
            held.finish()
            await evaluation.value
            let target = await bridge.boundTargetID
            XCTAssertEqual(target, "B", "cleanup of A must not retire B")
        }
        XCTAssertEqual(methods, ["Runtime.evaluate"])
    }

    func testBooleanResultsRemainBooleansAndNumbersRemainNumbers() async throws {
        let cases: [(Any, String)] = [(true, "true"), (false, "false"), (1, "1"), (0, "0"), (1.5, "1.5")]
        for (value, expected) in cases {
            // JSON decoding reproduces Foundation's NSNumber/CFBoolean bridging on the wire.
            let json = try JSONSerialization.data(withJSONObject: ["result": ["value": value]])
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
            try await withBridge(executor: { _, _ in result }) { bridge in
                let actual = try await bridge.evaluate("expression")
                XCTAssertEqual(actual, expected)
            }
        }
    }

    func testCleanupKeepsTheCommandSlotWithoutAnotherDiscoveryRequest() async throws {
        let requests = ChromiumBridgeTests.LockedCounter()
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one")], port: port)
        }, requestObserver: { request in
            if request.hasPrefix("GET /json/list ") { requests.increment() }
        }))
        defer { server.stop() }
        let releasing = expectation(description: "cleanup started")
        let pause = SessionOperationGate()
        let held = try await pause.enter()
        defer { held.finish() }
        var methods: [String] = []
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { method, params in
            methods.append(method)
            if method == "Runtime.releaseObjectGroup" {
                releasing.fulfill()
                let lease = try await pause.enter()
                lease.finish()
                return [:]
            }
            return params["expression"] as? String == "first"
                ? ["result": ["objectId": "remote-1", "description": "Object"]]
                : ["result": ["value": "second"]]
        })
        try await bridge.attach(toTargetID: "A")
        let before = requests.value
        let first = Task { try await bridge.evaluate("first") }
        await fulfillment(of: [releasing], timeout: 1)
        let second = Task { try await bridge.evaluate("second") }
        held.finish()
        let firstValue = try await first.value
        let secondValue = try await second.value
        XCTAssertEqual(firstValue, "Object")
        XCTAssertEqual(secondValue, "second")
        XCTAssertEqual(methods, ["Runtime.evaluate", "Runtime.releaseObjectGroup", "Runtime.evaluate"])
        XCTAssertEqual(requests.value - before, 2, "only evaluations require target discovery")
        await bridge.detach()
    }

    func testViewportRejectsExceptionsAndMalformedGeometry() async throws {
        for result: [String: Any] in [
            ["result": ["value": #"{"x":0,"y":0,"w":100,"h":100}"#], "exceptionDetails": ["text": "failed"]],
            ["result": ["value": #"{"x":0,"y":0,"w":0,"h":100}"#]],
            ["result": ["value": #"{"x":true,"y":0,"w":100,"h":100}"#]],
            ["result": ["value": String(repeating: "x", count: 1_048_577)]],
        ] {
            try await withBridge(executor: { _, _ in result }) { bridge in
                do { _ = try await bridge.viewportOnScreen(); XCTFail("invalid geometry must be rejected") }
                catch {}
            }
        }
    }
}
