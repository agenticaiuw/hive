import Foundation
import JavaScriptCore
import XCTest
@testable import SpaceOKit

/// Page observation of form controls, run against an in-memory DOM in JavaScriptCore: input
/// types, checked and selected state, and — above all — that a secret field's value never
/// becomes a label, a search hit, or any other part of read_screen or find output.
final class ChromiumFieldStateTests: XCTestCase {
    private func context(_ nodes: [[String: Any]]) throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        let data = try JSONSerialization.data(withJSONObject: nodes)
        context.evaluateScript("""
        const fixture = \(String(decoding: data, as: UTF8.self));
        const elements = fixture.map((n, i) => ({
          tagName: n.tag.toUpperCase(),
          type: n.type || '',
          value: n.value || '',
          checked: n.checked === true,
          indeterminate: n.indeterminate === true,
          disabled: false,
          selectedIndex: n.selectedIndex === undefined ? -1 : n.selectedIndex,
          options: (n.options || []).map(text => ({text})),
          innerText: n.text || '',
          getAttribute: name => (n.attributes || {})[name] === undefined ? null : n.attributes[name],
          getBoundingClientRect: () => ({x: i * 10, y: 0, width: 10, height: 10})
        }));
        const NodeFilter = {SHOW_ELEMENT: 1};
        const Element = {prototype: {matches: function() { return true; }}};
        const document = {
          createTreeWalker: () => { let i = 0; return {nextNode: () => elements[i++] || null}; }
        };
        const getComputedStyle = () => ({visibility: 'visible', display: 'block'});
        """)
        XCTAssertNil(context.exception)
        return context
    }

    private func outline(_ nodes: [[String: Any]]) throws -> ChromiumObservation.Outline {
        let context = try context(nodes)
        let json = try XCTUnwrap(context.evaluateScript(ChromiumObservation.outline(limit: 50))?.toString())
        XCTAssertNil(context.exception, context.exception?.toString() ?? "")
        let outline = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from: json)
        try ChromiumObservation.validate(outline.items, limit: 50, sequential: true)
        return outline
    }

    private let secret = "hunter2-SECRET"

    func testUnlabeledSecretFieldsNeverExposeTheirValue() throws {
        let nodes: [[String: Any]] = [
            ["tag": "input", "type": "password", "value": secret],
            ["tag": "input", "attributes": ["type": "password"], "value": secret],
            ["tag": "input", "type": "text", "value": secret, "attributes": ["autocomplete": "cc-number"]],
            ["tag": "input", "type": "text", "value": secret, "attributes": ["autocomplete": "billing cc-csc"]],
            ["tag": "input", "type": "text", "value": secret, "attributes": ["autocomplete": "one-time-code"]],
            ["tag": "input", "type": "password", "value": secret, "attributes": ["placeholder": "Password"]],
        ]
        let result = try outline(nodes)
        let rendered = result.items.map(\.line).joined(separator: "\n")
        XCTAssertFalse(rendered.contains("SECRET"), rendered)
        XCTAssertEqual(result.items.map(\.ty), ["password", "password", "text", "text", "text", "password"])
        XCTAssertEqual(result.items.last?.l, "Password", "the placeholder still names the field")

        // Search must not match on the secret either, or its presence would leak through hits.
        let context = try context(nodes)
        let json = try XCTUnwrap(context.evaluateScript(
            try ChromiumObservation.find(query: "hunter2", limit: 10))?.toString())
        let search = try ChromiumObservation.decode(ChromiumObservation.Search.self, from: json)
        XCTAssertTrue(search.items.isEmpty, "a query equal to the secret must find nothing")
    }

    func testOrdinaryTextFieldValueStillNamesAnUnlabeledField() throws {
        let result = try outline([["tag": "input", "type": "search", "value": "weather"]])
        XCTAssertEqual(result.items.first?.l, "weather")
        XCTAssertEqual(result.items.first?.line, "  [w0] input type=search — weather  at (5,5)")
    }

    func testCheckedStateAndSelectedOptionAreReported() throws {
        let result = try outline([
            ["tag": "input", "type": "checkbox", "checked": true, "value": "on",
             "attributes": ["aria-label": "Remember me"]],
            ["tag": "input", "type": "radio", "value": "small"],
            ["tag": "input", "type": "checkbox", "indeterminate": true],
            ["tag": "div", "attributes": ["role": "switch", "aria-checked": "true", "aria-label": "Wi-Fi"]],
            ["tag": "select", "text": "France Germany", "selectedIndex": 1, "options": ["France", "Germany"],
             "attributes": ["aria-label": "Country"]],
        ])
        XCTAssertEqual(result.items.map(\.c), ["checked", "unchecked", "mixed", "checked", nil])
        XCTAssertEqual(result.items[1].l, "", "a radio's form value is not its name")
        XCTAssertEqual(result.items[4].s, "Germany")
        XCTAssertEqual(result.items[0].line, "  [w0] input type=checkbox — Remember me [checked]  at (5,5)")
        XCTAssertEqual(result.items[4].line, "  [w4] select — Country · selected: Germany  at (45,5)")
    }

    func testDecoderRejectsOutOfVocabularyState() throws {
        let item = #"{"items":[{"i":0,"t":"input","l":"","x":1,"y":1,"d":false,"c":"on"}],"truncated":false}"#
        let outline = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from: item)
        XCTAssertThrowsError(try ChromiumObservation.validate(outline.items, limit: 5, sequential: true))
    }
}
