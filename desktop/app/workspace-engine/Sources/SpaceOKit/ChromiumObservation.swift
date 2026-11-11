import Foundation

/// Shared DOM selection/order rules. TreeWalker keeps only the traversal cursor; unlike
/// querySelectorAll plus an output array it need not retain every control to resolve w0.
enum ChromiumObservation {
    private static let traversal = #"""
    const selector = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick],[contenteditable=true]';
    const matches = Element.prototype.matches;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    function nextVisible() {
      let el;
      while ((el = walker.nextNode())) {
        if (!matches.call(el, selector)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        return {el, r};
      }
      return null;
    }
    function tagOf(el) { return String(el.tagName || '').toLowerCase(); }
    function typeOf(el) {
      if (tagOf(el) !== 'input') return '';
      return String(el.getAttribute('type') || el.type || 'text').toLowerCase().slice(0, 32);
    }
    // A password, card, or one-time-code field's value is a secret the user typed; it never
    // becomes a label, a search hit, or observation output — not even as a fallback name.
    function secret(el) {
      if (typeOf(el) === 'password') return true;
      const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      return tokens.some(t => t.startsWith('cc-') || t === 'one-time-code' ||
                              t === 'current-password' || t === 'new-password');
    }
    function selectedText(el) {
      if (tagOf(el) !== 'select') return '';
      const option = el.selectedIndex >= 0 && el.options ? el.options[el.selectedIndex] : null;
      return option ? String(option.text || option.label || '') : '';
    }
    function labelSource(el) {
      const kind = tagOf(el), type = typeOf(el);
      // A select's value is an option key and a checkbox's value is a form token ("on");
      // neither names the control. The selected option text is reported separately.
      const valueNames = !secret(el) && kind !== 'select' && type !== 'checkbox' && type !== 'radio';
      return el.getAttribute('aria-label') || el.innerText || (valueNames ? el.value : '') ||
                  el.getAttribute('placeholder') || el.getAttribute('title') || '';
    }
    // Normalize only the prefix we return, without full-label trim/replace copies.
    function clip(raw) {
      let out = '', space = false;
      for (const character of String(raw)) {
        if (/\s/.test(character)) { if (out.length) space = true; continue; }
        const separator = space ? ' ' : '';
        if (out.length + separator.length + character.length > 80) break;
        out += separator + character;
        space = false;
        if (out.length === 80) break;
      }
      return out;
    }
    const ariaChecked = {true: 'checked', false: 'unchecked', mixed: 'mixed'};
    function item(c, index, raw = labelSource(c.el)) {
      const el = c.el, r = c.r, type = typeOf(el);
      const result = {i: index, t: tagOf(el), l: clip(raw),
              x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
              d: el.disabled === true};
      if (type) result.ty = type;
      if (type === 'checkbox' || type === 'radio') {
        result.c = el.indeterminate === true ? 'mixed' : el.checked === true ? 'checked' : 'unchecked';
      } else if (ariaChecked.hasOwnProperty(String(el.getAttribute('aria-checked')))) {
        result.c = ariaChecked[el.getAttribute('aria-checked')];
      }
      const chosen = selectedText(el);
      if (chosen) result.s = clip(chosen);
      return result;
    }
    """#

    static func center(index: Int) -> String {
        """
        (() => {
          \(traversal)
          let c, index = 0;
          while ((c = nextVisible())) {
            if (index++ === \(index)) return JSON.stringify({
              x: Math.round(c.r.x + c.r.width / 2), y: Math.round(c.r.y + c.r.height / 2)});
          }
          return 'missing';
        })()
        """
    }

    static func outline(limit: Int) -> String {
        """
        (() => {
          \(traversal)
          const items = [];
          let c;
          while ((c = nextVisible())) {
            if (items.length === \(limit)) return JSON.stringify({items, truncated: true});
            items.push(item(c, items.length));
          }
          return JSON.stringify({items, truncated: false});
        })()
        """
    }

    static func find(query: String, limit: Int) throws -> String {
        let literal = String(decoding: try JSONSerialization.data(withJSONObject: [query]), as: UTF8.self)
        return #"""
        (() => {
          \#(traversal)
          const needle = \#(literal)[0].trim().replace(/\s+/g, ' '), items = [];
          const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const matcher = new RegExp(escaped.replace(/ /g, '\\s+'), 'iu');
          let c, index = 0;
          while (index < 1000 && (c = nextVisible())) {
            let raw;
            if (matcher.test(c.el.tagName) || matcher.test(raw = labelSource(c.el))) {
              if (items.length === \#(limit)) return JSON.stringify({
                items, scanned: index + 1, truncated: true, reason: 'web_find_cap'});
              items.push(item(c, index, raw));
            }
            index++;
          }
          const truncated = index === 1000 && nextVisible() !== null;
          return JSON.stringify({items, scanned: index, truncated,
                                 reason: truncated ? 'web_index_cap' : null});
        })()
        """#
    }

    static func text(limit: Int) -> String {
        """
        (() => {
          const t = (document.body && document.body.innerText) || '';
          let count = 0, end = 0;
          for (const character of t) {
            if (count++ === \(limit)) break;
            end += character.length;
          }
          return JSON.stringify({text: t.slice(0, end), truncated: end < t.length});
        })()
        """
    }

    /// Limit before serialization, without allocating a UTF-8 copy of the full selection.
    static func selection(maximumBytes: Int, maximumScalars: Int? = nil, requireComplete: Bool) -> String {
        """
        (() => {
          const t = String(window.getSelection ? window.getSelection().toString() : '');
          let bytes = 0, count = 0, end = 0;
          for (const character of t) {
            const code = character.codePointAt(0);
            const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (bytes + size > \(maximumBytes) || count === \(maximumScalars.map(String.init) ?? "Infinity")) break;
            bytes += size; count++; end += character.length;
          }
          const truncated = end < t.length;
          return JSON.stringify({text: \(requireComplete ? "truncated ? '' : t" : "t.slice(0, end)"), truncated});
        })()
        """
    }

    struct Item: Decodable {
        let i: Int
        let t: String
        let l: String
        let x: Int
        let y: Int
        let d: Bool
        /// `<input>` type, so an agent can tell a checkbox from a text field.
        var ty: String? = nil
        /// `checked`, `unchecked`, or `mixed` for checkboxes, radios and `aria-checked`.
        var c: String? = nil
        /// The selected option's text for a `<select>`.
        var s: String? = nil

        var line: String {
            var line = "  [w\(i)] \(t)"
            if let ty { line += " type=\(ty)" }
            if !l.isEmpty { line += " — \(l)" }
            if let s { line += " · selected: \(s)" }
            if let c { line += " [\(c)]" }
            line += "  at (\(x),\(y))"
            if d { line += "  (disabled)" }
            return line
        }
    }

    struct Outline: Decodable {
        let items: [Item]
        let truncated: Bool
    }

    struct Search: Decodable {
        let items: [Item]
        let scanned: Int
        let truncated: Bool
        let reason: String?

        func validate(limit: Int) throws {
            try ChromiumObservation.validate(items, limit: limit, sequential: false)
            guard (0...1000).contains(scanned), items.allSatisfy({ $0.i < scanned }),
                  (truncated && reason == "web_find_cap" && items.count == limit && scanned > items.count)
                    || (truncated && reason == "web_index_cap" && scanned == 1000)
                    || (!truncated && reason == nil) else {
                throw SpaceOError.badRequest("DevTools returned inconsistent page search evidence")
            }
        }

        var truncation: TruncationReport {
            let hint: String?
            switch reason {
            case "web_find_cap": hint = "more page matches exist; narrow the query"
            case "web_index_cap": hint = "only the first 1000 page controls were searched; use the application's search or filter to reduce the page before concluding a control is absent"
            default: hint = nil
            }
            return TruncationReport(shown: items.count, truncated: truncated, reason: reason, hint: hint)
        }

        var outline: String {
            if items.isEmpty {
                return truncated ? "(no matches in the inspected page controls)" : "(no page elements match)"
            }
            return items.map(\.line).joined(separator: "\n")
        }
    }

    struct Text: Decodable {
        let text: String
        let truncated: Bool
    }

    static func decode<T: Decodable>(_ type: T.Type, from value: String, maximumBytes: Int = 1_048_576) throws -> T {
        guard value.utf8.count <= maximumBytes,
              let result = try? JSONDecoder().decode(type, from: Data(value.utf8)) else {
            throw SpaceOError.badRequest("DevTools returned an invalid page observation")
        }
        return result
    }

    static func validate(_ items: [Item], limit: Int, sequential: Bool) throws {
        guard items.count <= limit else {
            throw SpaceOError.badRequest("DevTools page observation exceeds the element limit")
        }
        var previous = -1
        for (offset, item) in items.enumerated() {
            guard (0..<1000).contains(item.i), item.i > previous,
                  !sequential || item.i == offset,
                  !item.t.isEmpty, item.t.utf8.count <= 64, item.l.utf16.count <= 80,
                  (item.ty?.utf16.count ?? 0) <= 32, (item.s?.utf16.count ?? 0) <= 80,
                  item.c.map({ ["checked", "unchecked", "mixed"].contains($0) }) ?? true else {
                throw SpaceOError.badRequest("DevTools returned an invalid page element")
            }
            previous = item.i
        }
    }
}
