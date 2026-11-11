import Foundation

/// Embedded VS Code extension used as a semantic renderer adapter.
///
/// It is written into a per-launch 0700 directory and loaded through `--extensions-dir`, so the
/// agent instance neither installs anything into the user's extension set nor runs the user's
/// extensions. Keeping these tiny assets embedded also preserves `make install`'s single-binary
/// distribution contract.
enum ElectronControlAssets {
    static let socketEnvironmentKey = "SPACEO_ELECTRON_CONTROL_SOCKET"
    static let tokenEnvironmentKey = "SPACEO_ELECTRON_CONTROL_TOKEN"
    static let extensionDirectoryName = "spaceo.spaceo-electron-control-0.0.1"

    static let packageJSON = #"""
    {
      "name": "spaceo-electron-control",
      "displayName": "SpaceO Electron Control",
      "version": "0.0.1",
      "publisher": "spaceo",
      "engines": {
        "vscode": "^1.90.0"
      },
      "main": "./extension.js",
      "activationEvents": [
        "*"
      ],
      "capabilities": {
        "untrustedWorkspaces": {
          "supported": true
        }
      }
    }
    """#

    static let extensionJavaScript = #"""
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const net = require("node:net");
    const vscode = require("vscode");

    const MAX_REQUEST_BYTES = 16 * 1024;
    const MAX_SELECTED_TEXT = 4096;
    const socketPath = process.env.SPACEO_ELECTRON_CONTROL_SOCKET;
    const expectedToken = process.env.SPACEO_ELECTRON_CONTROL_TOKEN;

    // VS Code exposes no horizontal scroll offset on TextEditor, so a horizontal reveal cannot be
    // confirmed the way a vertical one can. The adapter therefore keeps its own per-document
    // estimate of the column it last revealed. That is a model of the viewport, not an
    // observation of it, and every horizontal response says so with confirmed:false — SpaceO
    // surfaces it as unconfirmed delivery rather than claiming an effect it cannot see.
    const revealedColumn = new Map();

    function sameToken(candidate) {
      if (typeof candidate !== "string" || typeof expectedToken !== "string") return false;
      const actual = Buffer.from(candidate);
      const expected = Buffer.from(expectedToken);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    function ranges(editor) {
      return editor.visibleRanges.map((range) => [
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character
      ]);
    }

    function selections(editor) {
      return editor.selections.map((selection) => [
        selection.anchor.line,
        selection.anchor.character,
        selection.active.line,
        selection.active.character
      ]);
    }

    function same(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    function delay(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function integer(value, low, high, name) {
      if (!Number.isInteger(value) || value < low || value > high) {
        throw new Error(name + " must be an integer from " + low + " through " + high);
      }
      return value;
    }

    // Only editors that occupy an editor group. `viewColumn` is undefined for editors hosted
    // outside the grid, and those have no on-screen pane for a coordinate to land in.
    function grid() {
      return vscode.window.visibleTextEditors
        .filter((editor) => typeof editor.viewColumn === "number")
        .sort((left, right) => left.viewColumn - right.viewColumn);
    }

    function describe(editor) {
      return {
        column: typeof editor.viewColumn === "number" ? editor.viewColumn : null,
        document: editor.document.uri.toString(),
        visible: ranges(editor),
        selections: selections(editor),
        version: editor.document.version,
        lineCount: editor.document.lineCount
      };
    }

    // Reading state is not an action, so it simply follows focus: the keystroke being confirmed
    // went wherever focus was, split or not.
    function focused() {
      const active = vscode.window.activeTextEditor;
      if (!active) throw new Error("no active text editor");
      return active;
    }

    // A column is addressed explicitly by SpaceO once it has resolved which pane the caller's
    // point landed in. Without one, fall back to the active editor — the single-pane contract
    // that shipped first and stays byte-for-byte unchanged.
    function editorFor(column) {
      if (column === null || column === undefined) {
        const active = focused();
        const panes = grid();
        if (panes.length !== 1 || panes[0] !== active) {
          throw new Error("several editor panes are visible; SpaceO must address one by column");
        }
        return active;
      }
      const matches = grid().filter((editor) => editor.viewColumn === column);
      if (matches.length !== 1) {
        throw new Error("no unique visible editor in view column " + column);
      }
      return matches[0];
    }

    async function settle(read, before) {
      let after = read();
      for (let attempt = 0; attempt < 40 && same(before, after); attempt += 1) {
        await delay(25);
        after = read();
      }
      return after;
    }

    async function scrollVertically(editor, direction, pages, viaCommand) {
      const before = ranges(editor);
      if (viaCommand) {
        await vscode.commands.executeCommand("editorScroll", {
          to: direction,
          by: "page",
          value: pages,
          revealCursor: false
        });
      } else {
        // `editorScroll` acts on whichever pane holds focus, so a split needs a per-editor
        // operation instead. revealRange targets this exact editor and never moves focus.
        const visible = editor.visibleRanges;
        if (!visible.length) throw new Error("editor has no visible range");
        const top = visible[0].start.line;
        const bottom = visible[visible.length - 1].end.line;
        const span = Math.max(1, bottom - top) * pages;
        const target = direction === "down"
          ? Math.min(Math.max(0, editor.document.lineCount - 1), top + span)
          : Math.max(0, top - span);
        editor.revealRange(
          new vscode.Range(target, 0, target, 0),
          vscode.TextEditorRevealType.AtTop
        );
      }
      const after = await settle(() => ranges(editor), before);
      if (same(before, after)) {
        throw new Error("editor accepted the command but its visible range did not change");
      }
      return { before, after };
    }

    // Horizontal movement reveals a character position on the longest visible line. Clamping to
    // that line matters: revealing column 300 of a 4-character line is a no-op, so an unclamped
    // request would look like a working scroll that never moved.
    function scrollHorizontally(editor, direction, pages) {
      const visible = editor.visibleRanges;
      if (!visible.length) throw new Error("editor has no visible range");
      const key = editor.document.uri.toString() + "#" + editor.viewColumn;
      const top = visible[0].start.line;
      const bottom = visible[visible.length - 1].end.line;
      let line = top;
      let width = 0;
      for (let candidate = top; candidate <= bottom && candidate < editor.document.lineCount; candidate += 1) {
        const length = editor.document.lineAt(candidate).text.length;
        if (length > width) {
          width = length;
          line = candidate;
        }
      }
      const step = 40 * pages;
      const current = revealedColumn.get(key) || 0;
      const target = Math.max(0, Math.min(width, direction === "right" ? current + step : current - step));
      revealedColumn.set(key, target);
      editor.revealRange(
        new vscode.Range(line, target, line, target),
        vscode.TextEditorRevealType.Default
      );
      return { line: line, character: target, longestVisibleLineLength: width };
    }

    async function handle(request) {
      if (!sameToken(request.token)) throw new Error("authentication failed");
      if (request.version !== 1) throw new Error("unsupported protocol version");
      const column = request.column === null || request.column === undefined
        ? null
        : integer(request.column, 1, 64, "view column");

      if (request.command === "ping") {
        // Readiness must not depend on the pane layout. Requiring a single editor here made a
        // split window look like an adapter that never came up.
        const active = vscode.window.activeTextEditor;
        return {
          ok: true,
          ready: true,
          document: active ? active.document.uri.toString() : "",
          visible: active ? ranges(active) : [],
          editors: grid().map(describe)
        };
      }

      if (request.command === "layout") {
        const active = vscode.window.activeTextEditor;
        return {
          ok: true,
          editors: grid().map(describe),
          active: active && typeof active.viewColumn === "number" ? active.viewColumn : null
        };
      }

      if (request.command === "open") {
        if (typeof request.file !== "string" || request.file.length === 0
            || Buffer.byteLength(request.file, "utf8") > 12_000) {
          throw new Error("file must be a nonempty path up to 12000 UTF-8 bytes");
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.file));
        const editor = await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: false
        });
        return {
          ok: true,
          opened: editor.document.uri.fsPath,
          state: describe(editor)
        };
      }

      if (request.command === "state") {
        const editor = column === null ? focused() : editorFor(column);
        return { ok: true, state: describe(editor) };
      }

      if (request.command === "select") {
        const editor = editorFor(column);
        const lines = Math.max(0, editor.document.lineCount - 1);
        const anchor = new vscode.Position(
          integer(request.anchorLine, 0, lines, "anchor line"),
          integer(request.anchorCharacter, 0, 1_000_000, "anchor character")
        );
        const active = new vscode.Position(
          integer(request.activeLine, 0, lines, "active line"),
          integer(request.activeCharacter, 0, 1_000_000, "active character")
        );
        const before = selections(editor);
        editor.selection = new vscode.Selection(anchor, active);
        editor.revealRange(
          new vscode.Range(anchor, active),
          vscode.TextEditorRevealType.Default
        );
        const after = await settle(() => selections(editor), before);
        // Confirmation is "the selection is what was asked for", not "it changed" — asking for
        // the selection an editor already has is a legitimate no-op that must still succeed.
        const wanted = editor.document.validateRange(new vscode.Range(anchor, active));
        const settled = editor.selection;
        const matched = settled.start.line === wanted.start.line
          && settled.start.character === wanted.start.character
          && settled.end.line === wanted.end.line
          && settled.end.character === wanted.end.character;
        if (!matched) {
          throw new Error("editor did not adopt the requested selection");
        }
        return {
          ok: true,
          changed: !same(before, after),
          before: before,
          after: after,
          document: editor.document.uri.toString(),
          selectedText: editor.document.getText(settled).slice(0, MAX_SELECTED_TEXT)
        };
      }

      if (request.command !== "scroll") throw new Error("unsupported control request");

      const direction = request.direction;
      const horizontal = direction === "left" || direction === "right";
      if (direction !== "up" && direction !== "down" && !horizontal) {
        throw new Error("invalid scroll direction");
      }
      const pages = integer(request.pages, 1, 100, "scroll pages");
      const editor = editorFor(column);
      const document = editor.document.uri.toString();

      if (horizontal) {
        const reveal = scrollHorizontally(editor, direction, pages);
        return {
          ok: true,
          confirmed: false,
          changed: false,
          document: document,
          column: typeof editor.viewColumn === "number" ? editor.viewColumn : null,
          reveal: reveal
        };
      }

      const panes = grid();
      const viaCommand = column === null
        || (panes.length === 1 && editor === vscode.window.activeTextEditor);
      const moved = await scrollVertically(editor, direction, pages, viaCommand);
      return {
        ok: true,
        confirmed: true,
        changed: true,
        before: moved.before,
        after: moved.after,
        document: document,
        column: typeof editor.viewColumn === "number" ? editor.viewColumn : null
      };
    }

    function activate(context) {
      if (!socketPath || !expectedToken) return;
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (error && error.code !== "ENOENT") throw error;
      }
      const server = net.createServer((connection) => {
        let input = "";
        let handled = false;
        connection.setEncoding("utf8");
        connection.on("data", async (chunk) => {
          if (handled) return;
          input += chunk;
          if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
            handled = true;
            connection.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
            return;
          }
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          handled = true;
          try {
            const response = await handle(JSON.parse(input.slice(0, newline)));
            connection.end(JSON.stringify(response) + "\n");
          } catch (error) {
            connection.end(JSON.stringify({ ok: false, error: String(error) }) + "\n");
          }
        });
      });
      // A late bind failure must make the private controller unavailable, not crash Cursor's
      // extension host. SpaceO will fail closed when the socket is absent.
      server.on("error", () => {});
      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
      });
      context.subscriptions.push({
        dispose: () => {
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {}
        }
      });
    }

    function deactivate() {}

    module.exports = { activate, deactivate };
    """#
}
