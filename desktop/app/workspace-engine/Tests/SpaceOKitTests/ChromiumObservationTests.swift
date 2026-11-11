import Foundation
import JavaScriptCore
import XCTest
@testable import SpaceOKit

final class ChromiumObservationTests: XCTestCase {
    /// Execute production JavaScript against an in-memory DOM adapter, never a browser.
    /// Counters expose layout/style work; querySelectorAll is deliberately unavailable.
    private func context(nodes: [[String: Any]], text: String = "", selection: String = "") throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        let data = try JSONSerialization.data(withJSONObject: ["nodes": nodes, "text": text, "selection": selection])
        let literal = String(decoding: data, as: UTF8.self)
        context.evaluateScript("""
        const fixture = \(literal);
        const window = {getSelection: () => ({toString: () => fixture.selection})};
        var counts = {matches: 0, geometry: 0, style: 0, labels: 0};
        const elements = fixture.nodes.map((n, i) => ({
          tagName: 'BUTTON', disabled: n.disabled || false,
          selectorMatches: n.match !== false,
          matches: 'a named property may shadow the instance method',
          getBoundingClientRect: () => { counts.geometry++; return {
            x: i * 10, y: 0, width: n.small ? 0 : 10, height: 10}; },
          getAttribute: () => null,
          get innerText() { counts.labels++; return n.label || ''; },
          hidden: n.hidden || false
        }));
        const NodeFilter = {SHOW_ELEMENT: 1};
        const Element = {prototype: {matches: function() { counts.matches++; return this.selectorMatches; }}};
        const document = {
          body: {innerText: fixture.text},
          createTreeWalker: () => { let i = 0; return {nextNode: () => elements[i++] || null}; }
        };
        const getComputedStyle = el => {
          counts.style++; return {visibility: el.hidden ? 'hidden' : 'visible', display: 'block'};
        };
        """)
        XCTAssertNil(context.exception)
        return context
    }

    private func evaluate(_ expression: String, in context: JSContext) throws -> String {
        let result = context.evaluateScript(expression)
        XCTAssertNil(context.exception, context.exception?.toString() ?? "")
        return try XCTUnwrap(result?.toString())
    }

    private func count(_ key: String, in context: JSContext) -> Int {
        Int(context.evaluateScript("counts.\(key)").toInt32())
    }

    func testSelectionPreviewBoundsLargeUnicodeSelectionsBeforeSerialization() throws {
        let value = String(repeating: "😀", count: 300_000)
        let json = try evaluate(ChromiumObservation.selection(maximumBytes: 800, maximumScalars: 200,
                                                              requireComplete: false),
                                in: context(nodes: [], selection: value))
        let report = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: json)
        XCTAssertEqual(report.text, String(repeating: "😀", count: 200))
        XCTAssertTrue(report.truncated)
        XCTAssertLessThan(json.utf8.count, 900)
    }

    func testCompleteSelectionRejectsOversizeWithoutReturningAPartialCopy() throws {
        for (value, cap, truncated) in [("é😀", 6, false), ("é😀", 5, true), ("", 0, false)] {
            let json = try evaluate(ChromiumObservation.selection(maximumBytes: cap, requireComplete: true),
                                    in: context(nodes: [], selection: value))
            let report = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: json)
            XCTAssertEqual(report.text, truncated ? "" : value)
            XCTAssertEqual(report.truncated, truncated)
        }
        let json = try evaluate(ChromiumObservation.selection(maximumBytes: SessionClipboard.maximumBytes,
                                                              requireComplete: true),
                                in: context(nodes: [], selection: String(repeating: "x", count: 1_048_577)))
        XCTAssertLessThan(json.utf8.count, 64)
        XCTAssertTrue(try ChromiumObservation.decode(ChromiumObservation.Text.self, from: json).truncated)
    }

    func testSelectionJSONBudgetAllowsEscapedControlCharacters() throws {
        let value = String(repeating: "\u{01}", count: 200_000)
        let json = try evaluate(ChromiumObservation.selection(maximumBytes: SessionClipboard.maximumBytes,
                                                              requireComplete: true),
                                in: context(nodes: [], selection: value))
        XCTAssertThrowsError(try ChromiumObservation.decode(ChromiumObservation.Text.self, from: json))
        let report = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: json,
                                                     maximumBytes: SessionClipboard.maximumBytes * 6 + 64)
        XCTAssertEqual(report.text, value)
        XCTAssertFalse(report.truncated)
    }

    func testFirstElementLookupStopsBeforeScanningRemainingControls() throws {
        let context = try context(nodes: Array(repeating: ["label": "button"], count: 10_000))
        let json = try evaluate(ChromiumObservation.center(index: 0), in: context)
        let point = try ChromiumObservation.decode([String: Int].self, from: json)
        XCTAssertEqual(point, ["x": 5, "y": 5])
        XCTAssertEqual(count("matches", in: context), 1)
        XCTAssertEqual(count("geometry", in: context), 1)
        XCTAssertEqual(count("style", in: context), 1)
        XCTAssertEqual(count("labels", in: context), 0)
    }

    func testOutlineFindAndPointUseTheSameVisibleIndices() throws {
        let nodes: [[String: Any]] = [
            ["match": false], ["hidden": true], ["small": true],
            ["label": "First"], ["label": "Second", "disabled": true], ["label": "Third"],
        ]
        let outline = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from:
            evaluate(ChromiumObservation.outline(limit: 10), in: context(nodes: nodes)))
        XCTAssertEqual(outline.items.map(\.i), [0, 1, 2])
        XCTAssertEqual(outline.items.map(\.x), [35, 45, 55])
        let found = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
            evaluate(ChromiumObservation.find(query: "SECOND", limit: 1), in: context(nodes: nodes)))
        XCTAssertEqual(found.items.map(\.i), [1])
        XCTAssertTrue(try XCTUnwrap(found.items.first).d)
        let point = try ChromiumObservation.decode([String: Int].self, from:
            evaluate(ChromiumObservation.center(index: 1), in: context(nodes: nodes)))
        XCTAssertEqual(point["x"], found.items.first?.x)
    }

    func testOutlineDistinguishesExactLimitFromOmittedElements() throws {
        for total in [2, 3, 10_000] {
            let context = try context(nodes: Array(repeating: ["label": "button"], count: total))
            let report = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from:
                evaluate(ChromiumObservation.outline(limit: 2), in: context))
            XCTAssertEqual(report.items.count, 2)
            XCTAssertEqual(report.truncated, total > 2)
            XCTAssertEqual(count("geometry", in: context), min(total, 3))
            XCTAssertEqual(count("labels", in: context), 2, "lookahead does not need a label")
        }
    }

    func testSearchEscapesQueryAndChecksForAnotherHit() throws {
        let query = "'\\\"; [needle]"
        let context = try context(nodes: [["label": query], ["label": "other"]])
        let items = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
            evaluate(ChromiumObservation.find(query: query, limit: 1), in: context))
        XCTAssertEqual(items.items.map(\.i), [0])
        XCTAssertEqual(count("geometry", in: context), 2)
    }

    func testLongLabelNormalizationConsumesOnlyTheReturnedPrefix() throws {
        let context = try context(nodes: [["label": String(repeating: "x", count: 100_000)]])
        context.evaluateScript("""
        counts.characters = 0;
        const originalIterator = String.prototype[Symbol.iterator];
        String.prototype[Symbol.iterator] = function() {
          const iterator = originalIterator.call(this);
          return {next: () => { counts.characters++; return iterator.next(); }};
        };
        """)
        let report = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from:
            evaluate(ChromiumObservation.outline(limit: 2), in: context))
        XCTAssertEqual(report.items.first?.l, String(repeating: "x", count: 80))
        XCTAssertEqual(count("characters", in: context), 80)

        let spaced = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from:
            evaluate(ChromiumObservation.outline(limit: 2),
                     in: self.context(nodes: [["label": "  first \n\t second   "]])))
        XCTAssertEqual(spaced.items.first?.l, "first second")
    }

    func testSearchReportsExactResultAndScanBoundaries() throws {
        for total in [2, 3] {
            let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
                evaluate(ChromiumObservation.find(query: "button", limit: 2),
                         in: context(nodes: Array(repeating: ["label": "control"], count: total))))
            try report.validate(limit: 2)
            XCTAssertEqual(report.items.count, 2)
            XCTAssertEqual(report.truncated, total > 2)
            XCTAssertEqual(report.reason, total > 2 ? "web_find_cap" : nil)
        }
        for total in [1000, 1001] {
            let context = try context(nodes: Array(repeating: ["label": "control"], count: total))
            let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
                evaluate(ChromiumObservation.find(query: "missing", limit: 25), in: context))
            try report.validate(limit: 25)
            XCTAssertEqual(report.scanned, 1000)
            XCTAssertTrue(report.items.isEmpty)
            XCTAssertEqual(report.truncated, total > 1000)
            XCTAssertEqual(report.reason, total > 1000 ? "web_index_cap" : nil)
            XCTAssertEqual(count("labels", in: context), 1000, "scan lookahead needs no label")
            if report.truncated { XCTAssertTrue(report.outline.contains("inspected")) }
        }
    }

    func testSearchFindsFullLabelWithoutNormalizingItsWholeValue() throws {
        let context = try context(nodes: [["label": String(repeating: "x", count: 100_000) + " needle\t tail"]])
        context.evaluateScript("""
        counts.characters = 0;
        const originalIterator = String.prototype[Symbol.iterator];
        String.prototype[Symbol.iterator] = function() {
          const iterator = originalIterator.call(this);
          return {next: () => { counts.characters++; return iterator.next(); }};
        };
        """)
        let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
            evaluate(ChromiumObservation.find(query: "NEEDLE   TAIL", limit: 25), in: context))
        try report.validate(limit: 25)
        XCTAssertEqual(report.items.map(\.i), [0])
        XCTAssertEqual(report.items.first?.l, String(repeating: "x", count: 80))
        XCTAssertFalse(report.truncated)
        XCTAssertEqual(count("labels", in: context), 1)
        XCTAssertEqual(count("characters", in: context), 80, "only the display prefix is normalized")
    }

    func testSearchTreatsRegularExpressionCharactersLiterally() throws {
        for query in [".*", "[test]", "$", "\\", "foo|bar", "(x)", "a+b", "^", "{2}"] {
            let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from:
                evaluate(ChromiumObservation.find(query: query, limit: 25),
                         in: context(nodes: [["label": "ordinary"], ["label": "prefix " + query + " suffix"]])))
            XCTAssertEqual(report.items.map(\.i), [1], query)
        }
    }

    func testSearchRejectsInconsistentCompletenessEvidence() throws {
        for json in [
            #"{"items":[],"scanned":0,"truncated":true,"reason":"web_find_cap"}"#,
            #"{"items":[],"scanned":999,"truncated":true,"reason":"web_index_cap"}"#,
            #"{"items":[],"scanned":1001,"truncated":false}"#,
            #"{"items":[],"scanned":1,"truncated":false,"reason":"unknown"}"#,
        ] {
            let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from: json)
            XCTAssertThrowsError(try report.validate(limit: 25))
        }
    }

    func testPublicSearchReportAndStringAPIPreservePartialEvidence() async throws {
        let json = try evaluate(ChromiumObservation.find(query: "missing", limit: 25),
                                in: context(nodes: Array(repeating: ["label": "control"], count: 1001)))
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one")], port: port)
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in
            ["result": ["value": json]]
        })
        try await bridge.attach(toTargetID: "A")
        let report = try await bridge.findElementsReport(query: "missing")
        XCTAssertEqual(report.scanned, 1000)
        XCTAssertEqual(report.truncation.shown, 0)
        XCTAssertEqual(report.truncation.reason, "web_index_cap")
        XCTAssertTrue(report.outline.contains("inspected"))
        let text = try await bridge.findElements(query: "missing")
        XCTAssertTrue(text.contains(report.truncation.footer))
        await bridge.detach()
    }

    func testMalformedElementFieldsAndIndicesAreRejected() throws {
        let missingCoordinate = #"[{"i":0,"t":"button","l":"label","y":5,"d":false}]"#
        XCTAssertThrowsError(try ChromiumObservation.decode([ChromiumObservation.Item].self,
                                                             from: missingCoordinate))
        for indices in [[0, 0], [1, 0], [0, 1000]] {
            let values = indices.map { ["i": $0, "t": "button", "l": "", "x": 5, "y": 5, "d": false] as [String: Any] }
            let json = String(decoding: try JSONSerialization.data(withJSONObject: values), as: UTF8.self)
            let items = try ChromiumObservation.decode([ChromiumObservation.Item].self, from: json)
            XCTAssertThrowsError(try ChromiumObservation.validate(items, limit: 2, sequential: false))
        }
    }

    func testTextAndLabelsDoNotSplitSurrogatePairs() throws {
        let text = try ChromiumObservation.decode(ChromiumObservation.Text.self, from:
            evaluate(ChromiumObservation.text(limit: 1), in: context(nodes: [], text: "😀next")))
        XCTAssertEqual(text.text, "😀")
        XCTAssertTrue(text.truncated)
        let complete = try ChromiumObservation.decode(ChromiumObservation.Text.self, from:
            evaluate(ChromiumObservation.text(limit: 1), in: context(nodes: [], text: "😀")))
        XCTAssertFalse(complete.truncated)
        let report = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from:
            evaluate(ChromiumObservation.outline(limit: 2),
                     in: context(nodes: [["label": String(repeating: "a", count: 79) + "😀"]])))
        XCTAssertEqual(report.items.first?.l, String(repeating: "a", count: 79))
    }

    func testMalformedObservationCannotBecomeAnEmptyReadOrAnInventedCoordinate() async throws {
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one")], port: port)
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in
            ["result": ["value": "{}"]]
        })
        try await bridge.attach(toTargetID: "A")
        for operation in ["text", "outline", "find", "point", "selector"] {
            do {
                switch operation {
                case "text": _ = try await bridge.pageText(limit: 100)
                case "outline": _ = try await bridge.interactiveElementsReport()
                case "find": _ = try await bridge.findElements(query: "button")
                case "point": _ = try await bridge.elementCenter(index: 0)
                default: _ = try await bridge.selectorExists("button")
                }
                XCTFail("\(operation) must refuse malformed evidence")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("invalid"), "\(error)")
            }
        }
        await bridge.detach()
    }

    func testJavaScriptExceptionDoesNotBecomeObservationText() async throws {
        let server = try XCTUnwrap(ChromiumBridgeTests.FakeDevTools(behavior: .body { port in
            ChromiumBridgeTests.listing([(id: "A", title: "one")], port: port)
        }))
        defer { server.stop() }
        let bridge = ChromiumBridge(port: server.port, commandExecutor: { _, _ in
            ["result": ["description": "Error"], "exceptionDetails": ["text": "Uncaught"]]
        })
        try await bridge.attach(toTargetID: "A")
        do {
            _ = try await bridge.evaluate("throw Error()")
            XCTFail("exception must fail the observation")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("JavaScript evaluation failed"), "\(error)")
        }
        await bridge.detach()
    }
}
