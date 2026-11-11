import XCTest
@testable import SpaceOKit

/// Client registration rewriting.
///
/// The invariant is "only the spaceo entry changes": a user's other servers and unrelated keys
/// must survive, byte-for-byte for TOML (which we do not parse) and structurally for JSON.
final class MCPClientConfigTests: XCTestCase {
    private let exe = "/opt/spaceo/bin/spaceo"
    private let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)

    // MARK: - Reading the existing file

    func testReadExistingDistinguishesMissingFromUnreadable() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-client-config-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertNil(try MCPClientConfig.readExisting(at: directory.appendingPathComponent("absent.json")))

        let text = directory.appendingPathComponent("mcp.json")
        try Data("{\"mcpServers\":{}}".utf8).write(to: text)
        XCTAssertEqual(try MCPClientConfig.readExisting(at: text), "{\"mcpServers\":{}}")

        // Not UTF-8: reading it as "no file" would let setup replace the user's whole config.
        let binary = directory.appendingPathComponent("binary.json")
        try Data([0xFF, 0xFE, 0x00, 0x7B]).write(to: binary)
        XCTAssertThrowsError(try MCPClientConfig.readExisting(at: binary)) { error in
            XCTAssertEqual(error as? MCPClientConfigError, .unreadable(binary.path))
        }
    }

    // MARK: - Locations and commands

    func testConfigFileLocationsPerClient() {
        XCTAssertNil(MCPClientConfig.configFileURL(for: .claudeCode, home: home))
        XCTAssertEqual(
            MCPClientConfig.configFileURL(for: .codex, home: home)?.path,
            "/Users/test/.codex/config.toml")
        XCTAssertEqual(
            MCPClientConfig.configFileURL(for: .cursor, home: home)?.path,
            "/Users/test/.cursor/mcp.json")
        XCTAssertEqual(
            MCPClientConfig.configFileURL(for: .claudeDesktop, home: home)?.path,
            "/Users/test/Library/Application Support/Claude/claude_desktop_config.json")
    }

    func testClaudeCodeUsesItsOwnRegistrationCommand() {
        XCTAssertEqual(
            MCPClientConfig.command(for: .claudeCode, executablePath: exe),
            ["claude", "mcp", "add", "-s", "user", "spaceo", "--", exe, "mcp"],
            "user scope, so a registration made in one project directory is not tied to it")
        for client in MCPClient.allCases where client != .claudeCode {
            XCTAssertNil(MCPClientConfig.command(for: client, executablePath: exe))
        }
    }

    // MARK: - TOML

    func testCodexFreshFileIsExactTable() throws {
        let expected = """
        [mcp_servers.spaceo]
        command = "/opt/spaceo/bin/spaceo"
        args = ["mcp"]

        """
        XCTAssertEqual(
            try MCPClientConfig.merged(existing: nil, client: .codex, executablePath: exe), expected)
        XCTAssertEqual(
            try MCPClientConfig.merged(existing: "  \n", client: .codex, executablePath: exe),
            expected)
    }

    func testCodexAppendsAfterOtherServersBytePreserved() throws {
        let existing = """
        model = "o3"   # keep my comment

        [mcp_servers.github]
        command =   "npx"
        args = ["-y", "@modelcontextprotocol/server-github"]
        """
        let merged = try MCPClientConfig.merged(
            existing: existing, client: .codex, executablePath: exe)
        XCTAssertEqual(
            merged,
            existing + "\n\n[mcp_servers.spaceo]\ncommand = \"/opt/spaceo/bin/spaceo\"\nargs = [\"mcp\"]\n")
        XCTAssertTrue(merged.hasPrefix(existing))
    }

    func testCodexReplacesExistingSpaceOTableOnly() throws {
        let existing = """
        [mcp_servers.spaceo]
        command = "/old/spaceo"
        args = ["mcp", "--verbose"]

        # github follows
        [mcp_servers.github]
        command = "npx"

        """
        let merged = try MCPClientConfig.merged(
            existing: existing, client: .codex, executablePath: exe)
        XCTAssertEqual(
            merged,
            """
            [mcp_servers.spaceo]
            command = "/opt/spaceo/bin/spaceo"
            args = ["mcp"]

            # github follows
            [mcp_servers.github]
            command = "npx"

            """)
    }

    func testCodexReplacesTableAtEndOfFile() throws {
        let existing = "[mcp_servers.github]\ncommand = \"npx\"\n\n[mcp_servers.spaceo]\ncommand = \"/old\"\nargs = [\"mcp\"]\n"
        let merged = try MCPClientConfig.merged(
            existing: existing, client: .codex, executablePath: exe)
        XCTAssertEqual(
            merged,
            "[mcp_servers.github]\ncommand = \"npx\"\n\n[mcp_servers.spaceo]\ncommand = \"/opt/spaceo/bin/spaceo\"\nargs = [\"mcp\"]\n")
    }

    func testTOMLStringEscapesQuotesBackslashesAndControls() {
        XCTAssertEqual(MCPClientConfig.tomlString("/a\"b\\c\tD"), "\"/a\\\"b\\\\c\\u0009D\"")
    }

    // MARK: - JSON

    private func servers(in json: String) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        return try XCTUnwrap(object?["mcpServers"] as? [String: Any])
    }

    func testJSONFreshFileGolden() throws {
        let merged = try MCPClientConfig.merged(existing: nil, client: .cursor, executablePath: exe)
        XCTAssertEqual(
            merged,
            """
            {
              "mcpServers" : {
                "spaceo" : {
                  "args" : [
                    "mcp"
                  ],
                  "command" : "/opt/spaceo/bin/spaceo"
                }
              }
            }

            """)
        XCTAssertEqual(
            try MCPClientConfig.merged(existing: "", client: .claudeDesktop, executablePath: exe),
            merged)
    }

    func testJSONPreservesOtherServersAndUnrelatedKeysStructurally() throws {
        let existing = """
        {"theme":"dark","mcpServers":{"github":{"command":"npx","args":["-y","x"],"env":{"T":"1"}},
        "spaceo":{"command":"/old","args":["mcp","--x"]}}}
        """
        let merged = try MCPClientConfig.merged(
            existing: existing, client: .cursor, executablePath: exe)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(merged.utf8)) as? [String: Any])
        XCTAssertEqual(root["theme"] as? String, "dark")
        let servers = try servers(in: merged)
        XCTAssertEqual(servers.count, 2)
        let github = try XCTUnwrap(servers["github"] as? [String: Any])
        XCTAssertEqual(github["command"] as? String, "npx")
        XCTAssertEqual(github["args"] as? [String], ["-y", "x"])
        XCTAssertEqual(github["env"] as? [String: String], ["T": "1"])
        let spaceo = try XCTUnwrap(servers["spaceo"] as? [String: Any])
        XCTAssertEqual(spaceo["command"] as? String, exe)
        XCTAssertEqual(spaceo["args"] as? [String], ["mcp"])
        // Rewriting is idempotent, so repeated setup runs produce no diff.
        XCTAssertEqual(
            try MCPClientConfig.merged(existing: merged, client: .cursor, executablePath: exe),
            merged)
    }

    func testJSONRejectsNonObjectOrMalformedInput() {
        XCTAssertThrowsError(
            try MCPClientConfig.merged(existing: "[1,2]", client: .cursor, executablePath: exe))
        XCTAssertThrowsError(
            try MCPClientConfig.merged(existing: "{nope", client: .claudeDesktop, executablePath: exe))
    }

    func testJSONRefusesToDiscardMalformedServerCollections() {
        for value in ["null", "[]", "[\"keep me\"]", "\"keep me\"", "1", "true"] {
            for client in [MCPClient.cursor, .claudeDesktop] {
                XCTAssertThrowsError(try MCPClientConfig.merged(
                    existing: "{\"mcpServers\":\(value)}", client: client, executablePath: exe)) {
                    XCTAssertEqual($0 as? MCPClientConfigError,
                        .malformedJSON("mcpServers must be an object; not overwriting it"))
                }
            }
        }
    }

    func testOversizedConfigIsRefused() {
        let huge = String(repeating: "#", count: MCPClientConfig.maximumConfigBytes + 1)
        XCTAssertThrowsError(
            try MCPClientConfig.merged(existing: huge, client: .codex, executablePath: exe)
        ) { error in
            XCTAssertEqual(error as? MCPClientConfigError, .tooLarge(huge.utf8.count))
        }
    }

    // MARK: - Paths

    func testTildeIsExpandedAndRelativePathsRejected() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        XCTAssertEqual(MCPClientConfig.expandTilde("~/bin/spaceo"), home + "/bin/spaceo")
        XCTAssertEqual(MCPClientConfig.expandTilde("~"), home)
        XCTAssertEqual(MCPClientConfig.expandTilde("/abs/~/x"), "/abs/~/x")
        XCTAssertThrowsError(
            try MCPClientConfig.merged(existing: nil, client: .codex, executablePath: "~/spaceo")
        ) { error in
            XCTAssertEqual(error as? MCPClientConfigError, .relativePath("~/spaceo"))
        }
        XCTAssertThrowsError(try MCPClientConfig.validateExecutablePath("bin/spaceo"))
        XCTAssertThrowsError(try MCPClientConfig.validateExecutablePath("/bin/sh\n")) { error in
            XCTAssertEqual(error as? MCPClientConfigError, .controlCharacters)
        }
        XCTAssertThrowsError(
            try MCPClientConfig.validateExecutablePath("/definitely/not/here/spaceo"))
        XCTAssertNoThrow(try MCPClientConfig.validateExecutablePath("/bin/sh"))
    }

    // MARK: - Diff

    func testDiffShowsRemovedAndAddedLines() {
        let old = "a\nb\nc\n"
        let new = "a\nB\nc\nd\n"
        XCTAssertEqual(MCPClientConfig.diff(old: old, new: new), " a\n-b\n+B\n c\n+d")
        XCTAssertEqual(MCPClientConfig.diff(old: nil, new: "x\ny\n"), "+x\n+y")
        XCTAssertEqual(MCPClientConfig.diff(old: "same\n", new: "same\n"), " same")
    }
}
