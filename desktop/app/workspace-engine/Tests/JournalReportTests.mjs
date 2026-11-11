import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { analyze, parseArguments, renderMarkdown, readJSONLines } from "../scripts/journal-report.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "journal-report.mjs");

const call = (seq, tool, extra = {}) => ({
  v: 1, kind: "tool_call", conn: "c1", seq, tool, trace: `t${seq}`, ms: 10 * seq,
  ts: `2026-09-23T10:00:0${seq}Z`, session: "agent-1", outcome: "ok",
  result: { est_tokens: 50, first_line: `${tool} result` }, ...extra,
});

function fixture() {
  const stale = { code: "stale_snapshot", message: "there is no current accessibility snapshot", recovery_tool: "spaceo_read_screen" };
  return [
    { v: 1, kind: "connection.start", conn: "c1", client: { name: "claude-code", version: "2.1" }, ts: "2026-09-23T10:00:00Z" },
    call(1, "spaceo_session_create"),
    call(2, "spaceo_click", { outcome: "tool_error", error: stale }),
    call(3, "spaceo_click", { outcome: "tool_error", error: stale, repeat: true, after_error: true }),
    call(4, "spaceo_read_screen", { result: { est_tokens: 2_400, first_line: "snapshot: s1" }, truncated: "traversal_budget" }),
    call(5, "spaceo_click", { observe: { mode: "diff", appended: true }, action: { outcome: "confirmed" } }),
    call(6, "spaceo_read_screen"),
    call(7, "spaceo_type", { outcome: "invalid_arguments", error: { code: "invalid_arguments", message: "unexpected argument(s): session_id; accepted: session" } }),
    { v: 1, kind: "connection.end", conn: "c1", reason: "eof", ts: "2026-09-23T10:00:09Z" },
  ];
}

test("analysis ranks repeated errors, retries, schema friction and re-reads", () => {
  const report = analyze(fixture(), [
    { kind: "request.failed", client: "viewer", cmd: "session.control", error_code: "unknown_session", ms: "3" },
    { kind: "request.ok", client: "mcp", cmd: "click", trace: "t5", ms: "20" },
  ]);
  assert.equal(report.scope.calls, 7);
  assert.deepEqual(report.scope.clients, ["claude-code 2.1"]);
  const stale = report.errors.find((error) => error.code === "stale_snapshot");
  assert.equal(stale.count, 2);
  assert.equal(stale.recovery_followed_rate, 0.5, "the second stale error was followed by a read");
  assert.equal(report.signals.retry_loops, 1);
  assert.deepEqual(report.signals.invalid_arguments, { "spaceo_type: session_id": 1 });
  assert.equal(report.signals.reread_despite_observe, 1);
  assert.equal(report.signals.truncated_reads, 1);
  assert.equal(report.signals.sessions_not_destroyed, 1);
  assert.equal(report.token_hogs[0].trace, "t4");
  assert.equal(report.daemon.requests_by_client.viewer, 1);
  assert.equal(report.daemon.mcp_overhead_p50_ms, 30, "MCP time minus daemon time for a joined trace");
  assert.match(report.candidates[0].title, /stale_snapshot/);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /## Ranked candidates/);
  assert.match(markdown, /\| stale_snapshot \| 2 \|/);
});

test("since filters by timestamp and argument parsing is strict", () => {
  assert.equal(analyze(fixture(), [], { since: "2026-09-23T10:00:05Z" }).scope.calls, 3);
  assert.throws(() => parseArguments(["--bogus"]), /unknown option/);
  assert.deepEqual(parseArguments(["dir", "--daemon-log", "d.log", "--top=3"]).daemonLogs, ["d.log"]);
});

test("the CLI reads a journal directory recursively and prints JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "spaceo-journal-report-"));
  try {
    const day = join(root, "2026-09-23");
    mkdirSync(day);
    writeFileSync(join(day, "mcp-1-c1.jsonl"), fixture().map((record) => JSON.stringify(record)).join("\n") + "\nnot json\n");
    const output = JSON.parse(execFileSync(process.execPath, [script, root, "--json"], { encoding: "utf8" }));
    assert.equal(output.scope.calls, 7);
    assert.equal(output.sources.invalid_lines, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("failed creates and observer calls are not acquired sessions", () => {
  const report = analyze([
    call(1, "spaceo_session_create", { outcome: "tool_error", error: { code: "display_creation_failed" } }),
    call(2, "spaceo_open_app", { outcome: "invalid_arguments", error: { code: "invalid_arguments" } }),
    call(3, "spaceo_list_windows"),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ]);
  assert.equal(report.signals.sessions_not_destroyed, 0);
  assert.equal(report.signals.sessions_still_open, 0);
  assert.ok(!report.candidates.some((candidate) => /cleanup|janitor/.test(candidate.title)));
});

test("only confirmed destroys end observed ownership", () => {
  for (const outcome of ["tool_error", "invalid_arguments", "transport_error", "mcp_error"]) {
    const report = analyze([
      call(1, "spaceo_session_create"), call(2, "spaceo_session_destroy", { outcome }),
      { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
    ]);
    assert.equal(report.signals.sessions_not_destroyed, 1, outcome);
  }
  for (const extra of [{}, { outcome: "warning" }, { session: undefined }, { session: undefined, args: { all: true } }]) {
    assert.equal(analyze([
      call(1, "spaceo_session_create"), call(2, "spaceo_session_destroy", extra),
      { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
    ]).signals.sessions_not_destroyed, 0);
  }
});

test("active connections, recreation and connection ownership stay distinct", () => {
  assert.equal(analyze([call(1, "spaceo_session_create")]).signals.sessions_still_open, 1);
  assert.equal(analyze([call(1, "spaceo_session_create")]).signals.sessions_not_destroyed, 0);
  const report = analyze([
    call(1, "spaceo_session_create"), call(2, "spaceo_session_destroy"), call(3, "spaceo_session_create"),
    call(4, "spaceo_session_destroy", { conn: "c2" }),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ].reverse());
  assert.equal(report.signals.sessions_not_destroyed, 1, "recreating the same name starts a new lifetime");
  assert.match(report.candidates.find((candidate) => /cleanup/.test(candidate.title)).evidence, /actual janitor cleanup is unknown/);
});

test("since retains earlier client and ownership context without counting unrelated lifetimes", () => {
  const report = analyze([
    ...fixture().slice(0, 2),
    call(5, "spaceo_click"),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
    call(1, "spaceo_session_create", { conn: "unrelated" }),
  ], [], { since: "2026-09-23T10:00:05Z" });
  assert.equal(report.scope.calls, 1);
  assert.deepEqual(report.scope.clients, ["claude-code 2.1"]);
  assert.equal(report.signals.sessions_not_destroyed, 1);
  assert.equal(report.signals.sessions_still_open, 0);
});

test("explicit lifecycle covers failed create-and-open and partial bulk teardown", () => {
  const report = analyze([
    call(1, "spaceo_session_create", { outcome: "tool_error", error: { code: "launch_failed" }, session_lifecycle: { acquired: "retained" } }),
    call(2, "spaceo_session_create", { session: "second" }),
    call(3, "spaceo_session_destroy", { session: undefined, args: { all: true }, outcome: "tool_error", session_lifecycle: { released: ["second"] } }),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ]);
  assert.equal(report.signals.sessions_not_destroyed, 1);
  assert.equal(analyze([
    call(1, "spaceo_session_create"), call(2, "spaceo_open_app", { outcome: "daemon_restarted" }),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ]).signals.sessions_not_destroyed, 0);
});

test("malformed dates and missing daemon paths are refused", () => {
  for (const arguments_ of [["--since="], ["--since=2026-02-30"], ["--since=yesterday"],
                            ["--daemon-log"], ["--daemon-log="], ["--daemon-log", "--json"]]) {
    assert.throws(() => parseArguments(arguments_));
  }
  assert.equal(parseArguments(["--since=2024-02-29"]).since, "2024-02-29");
});

test("input reader bounds regular-file bytes, line length and record counts", () => {
  const root = mkdtempSync(join(tmpdir(), "spaceo-journal-bounds-"));
  try {
    const file = join(root, "input.jsonl");
    writeFileSync(file, '{"kind":"tool_call","result":{"text":"private content","first_line":"summary"}}\nnull\n[]\n1\n');
    const read = readJSONLines([file], { bytes: 0 });
    assert.equal(read.invalid, 3);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0].result.text, undefined);
    assert.equal(read.records[0].result.first_line, "summary");
    assert.throws(() => readJSONLines([file], { bytes: 512 * 1_048_576 }), /byte budget/);
    assert.throws(() => readJSONLines([file], { bytes: 0, lines: 500_000 }), /records/);
    writeFileSync(file, "x".repeat(1_048_577));
    assert.throws(() => readJSONLines([file], { bytes: 0 }), /line larger/);
    truncateSync(file, 64 * 1_048_576 + 1);
    assert.throws(() => readJSONLines([file], { bytes: 0 }), /file larger/);
    assert.throws(() => readJSONLines([root], { bytes: 0 }), /regular files/);
    if (process.platform !== "win32") {
      const fifo = join(root, "fifo.jsonl");
      execFileSync("mkfifo", [fifo]);
      assert.throws(() => execFileSync(process.execPath, [script, fifo, "--json"], { timeout: 2_000, stdio: "pipe" }),
                    (error) => !error.killed && /regular files/.test(error.stderr.toString()));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discovery deduplicates aliases and refuses deep trees without recursing links", () => {
  const root = mkdtempSync(join(tmpdir(), "spaceo-journal-discovery-"));
  try {
    const file = join(root, "input.jsonl");
    const alias = join(root, "alias.jsonl");
    writeFileSync(file, JSON.stringify(call(1, "spaceo_session_create")) + "\n");
    symlinkSync(file, alias);
    symlinkSync(root, join(root, "cycle"));
    const report = JSON.parse(execFileSync(process.execPath, [script, root, file, alias, "--json"], { encoding: "utf8", timeout: 2_000 }));
    assert.equal(report.scope.calls, 1);
    assert.equal(report.sources.journal_files, 1);
    let deep = root;
    for (let index = 0; index < 17; index += 1) { deep = join(deep, "nested"); mkdirSync(deep); }
    assert.throws(() => execFileSync(process.execPath, [script, root, "--json"], { stdio: "pipe" }),
                  (error) => /directories deeper/.test(error.stderr.toString()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory supplied as journal and daemon input is searched for both, within one entry budget", () => {
  const root = mkdtempSync(join(tmpdir(), "spaceo-journal-shared-"));
  try {
    const lines = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    writeFileSync(join(root, "mcp-1-c1.jsonl"), lines(fixture()));
    writeFileSync(join(root, "daemon.log"), lines([
      { kind: "request.failed", client: "viewer", cmd: "session.control", error_code: "unknown_session", ms: "3" },
      { kind: "request.ok", client: "mcp", cmd: "click", trace: "t5", ms: "20" },
    ]));
    const both = [script, root, "--daemon-log", root, "--json"];
    const report = JSON.parse(execFileSync(process.execPath, both, { encoding: "utf8", timeout: 2_000 }));
    assert.equal(report.sources.journal_files, 1);
    assert.equal(report.sources.daemon_files, 1);
    assert.equal(report.daemon.requests_by_client.viewer, 1);
    assert.equal(report.daemon.failures["viewer session.control: unknown_session"], 1);
    // Each walk alone fits; together they exceed the shared 10,000-entry budget.
    for (let index = 0; index < 5_000; index += 1) writeFileSync(join(root, `entry-${index}`), "");
    execFileSync(process.execPath, [script, root, "--json"], { stdio: "pipe", timeout: 10_000 });
    assert.throws(() => execFileSync(process.execPath, both, { stdio: "pipe", timeout: 10_000 }),
                  (error) => !error.killed && /directory entries/.test(error.stderr.toString()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a connection ending after since retains outstanding acquisitions from earlier calls", () => {
  const report = analyze([
    call(1, "spaceo_session_create"),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ], [], { since: "2026-09-23T10:00:05Z" });
  assert.equal(report.scope.calls, 0);
  assert.equal(report.signals.sessions_not_destroyed, 1);
});


test("guard refusals and non-schema validation do not recommend bypasses or aliases", () => {
  const report = analyze([
    call(1, "spaceo_session_create", { outcome: "tool_error", error: { code: "display_creation_failed" } }),
    call(2, "spaceo_open_app", { outcome: "invalid_arguments", error: { code: "invalid_arguments", message: "No controller lease is available" } }),
  ]);
  assert.match(report.candidates.find((candidate) => /display_creation_failed/.test(candidate.title)).title, /Inspect protected refusal/);
  const validation = report.candidates.find((candidate) => /other validation/.test(candidate.title));
  assert.match(validation.evidence, /inspect ownership and prerequisites/);
  assert.ok(!validation.evidence.includes("alias"));
});


test("a successful bulk destroy remains conclusive when the released-ID list is bounded", () => {
  const report = analyze([
    call(1, "spaceo_session_create"),
    call(2, "spaceo_session_create", { session: "second" }),
    call(3, "spaceo_session_destroy", { session: undefined, args: { all: true },
      session_lifecycle: { released: ["second"], released_truncated: true } }),
    { kind: "connection.end", conn: "c1", ts: "2026-09-23T10:00:09Z" },
  ]);
  assert.equal(report.signals.sessions_not_destroyed, 0);
});
