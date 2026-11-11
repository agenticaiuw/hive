import XCTest
@testable import SpaceOKit

final class TOMLTableScannerTests: XCTestCase {
    private func merge(_ text: String) throws -> String {
        try MCPClientConfig.merged(existing: text, client: .codex, executablePath: "/new/spaceo")
    }

    func testHeaderInsideMultilineInstructionsIsPreserved() throws {
        for quote in ["\"\"\"", "'''"] {
            let original = "instructions = \(quote)\n[mcp_servers.spaceo]\ncommand = '/keep/this'\n\(quote)\n"
            let result = try merge(original)
            XCTAssertTrue(result.hasPrefix(original))
            XCTAssertTrue(result.contains("command = \"/new/spaceo\""))
            XCTAssertEqual(try merge(result), result)
            XCTAssertEqual(MCPClientInspection.tomlRegistration(toml: result, source: "fixture")?.command,
                           "/new/spaceo")
        }
    }

    func testArrayRowsCannotEndTheReplacedTable() throws {
        let original = """
        [mcp_servers.spaceo]
        command = "/old"
        nested = [
          ["keep array structure coherent"],
          ["second row"]
        ]
        [profiles.fast]
        model = "keep"
        """
        let result = try merge(original)
        XCTAssertFalse(result.contains("second row"))
        XCTAssertTrue(result.hasSuffix("[profiles.fast]\nmodel = \"keep\""))
        XCTAssertEqual(try merge(result), result)
    }

    func testQuotedAndEscapedTableKeysReplaceTheExistingTable() throws {
        for header in [
            #"["mcp_servers" . 'spaceo']"#,
            "[\tmcp_servers\t.\tspaceo\t] # comment",
            #"["mcp\u005fservers"."spac\U00000065o"]"#,
        ] {
            let result = try merge(header + "\ncommand = '/old'\n")
            XCTAssertFalse(result.contains("/old"))
            XCTAssertEqual(result.components(separatedBy: "[mcp_servers.spaceo]").count, 2)
            XCTAssertEqual(try merge(result), result)
        }
    }

    func testLiteralDotsAndCommentMarkersInKeysAreNotSeparators() throws {
        let prefix = "[\"mcp_servers.spaceo\"]\nkeep = true\n['has#comment']\nkeep = true\n"
        let result = try merge(prefix)
        XCTAssertTrue(result.hasPrefix(prefix))
        XCTAssertEqual(try merge(result), result)
    }

    func testMultilineValuesInsideTheTargetDoNotInventTableBoundaries() throws {
        let original = "[mcp_servers.spaceo]\ncommand = '/old'\ntext = '''\n[other]\n'''\n[keep]\nx = 1\n"
        let result = try merge(original)
        XCTAssertFalse(result.contains("[other]"))
        XCTAssertTrue(result.hasSuffix("[keep]\nx = 1\n"))
    }

    func testCommentsAndEscapedQuotesCannotChangeScannerState() throws {
        let original = #"""
        # """ [mcp_servers.spaceo]
        value = "escaped \" quote and # [not-a-table]"
        literal = '""" and # are plain text'
        instructions = """
        A quote: \" and a pair: ""
        [mcp_servers.spaceo]
        """
        """#
        let result = try merge(original)
        XCTAssertTrue(result.hasPrefix(original))
        XCTAssertEqual(try merge(result), result)
    }

    func testCRLFInputPreservesUnrelatedBytes() throws {
        let prefix = "model = 'keep'\r\n\r\n"
        let suffix = "\r\n[profiles.fast]\r\nmodel = 'keep-too'\r\n"
        let result = try merge(prefix + "[mcp_servers.spaceo]\r\ncommand = '/old'\r\n" + suffix)
        XCTAssertTrue(result.hasPrefix(prefix))
        XCTAssertTrue(result.hasSuffix(suffix))
    }

    func testAmbiguousOrUnfinishedStructuresAreRefused() {
        for original in [
            "instructions = '''\n[mcp_servers.spaceo]",
            "instructions = \"unterminated\n",
            "items = [\n['unfinished']\n",
            "items = { key = 1\n",
            "items = [}\n",
            "[mcp_servers.spaceo]\nx = 1\n['mcp_servers'.'spaceo']\nx = 2\n",
            "[[mcp_servers.spaceo]]\ncommand = '/old'\n",
            "mcp_servers = { spaceo = { command = '/old' } }\n",
            "mcp_servers.spaceo.command = '/old'\n",
            "[mcp_servers]\nspaceo = { command = '/old' }\n",
        ] {
            XCTAssertThrowsError(try merge(original)) {
                guard case MCPClientConfigError.malformedTOML = $0 else {
                    return XCTFail("expected a TOML refusal")
                }
            }
        }
    }

    func testDoctorIgnoresCommandExamplesInsideMultilineValues() {
        for quote in ["\"\"\"", "'''"] {
            let text = "[mcp_servers.spaceo]\ncommand = \"/real/spaceo\"\nargs = [\"mcp\"]\n"
                + "instructions = \(quote)\ncommand = \"/example/do-not-run\"\nargs = [\"fake\"]\n\(quote)\n"
            let registration = MCPClientInspection.tomlRegistration(toml: text, source: "fixture")
            XCTAssertEqual(registration?.command, "/real/spaceo")
            XCTAssertEqual(registration?.arguments, ["mcp"])
        }
    }

    func testDoctorReadsQuotedCommandKey() {
        let text = "[mcp_servers.'spaceo']\n'command' = \"/real/spaceo\"\n\"args\" = [\"mcp\"]\n"
        let registration = MCPClientInspection.tomlRegistration(toml: text, source: "fixture")
        XCTAssertEqual(registration?.command, "/real/spaceo")
        XCTAssertEqual(registration?.arguments, ["mcp"])
    }
}
