import assert from "node:assert/strict";
import test from "node:test";

import {
  commandTitle,
  deviceTagsFor,
  hiveNodeFor,
  isAgentInitiated,
  jobToHistoryEntry,
  mergeHiveFeed,
  pickHero,
  repeatSummary,
  terminalPhaseFor,
} from "../src/lib/hiveFeed.js";

test("names the pendant from either its transport or its source", () => {
  for (const origin of ["live_lte", "microSD", "pendant_upload"]) {
    assert.equal(
      hiveNodeFor({ origin, source: "cloudflare" }).label,
      "Pendant",
    );
  }
  assert.equal(hiveNodeFor({ source: "pendant" }).label, "Pendant");
});

test("origin wins over the relay's witnessing source", () => {
  // A pendant run carries source 'cloudflare' because the relay saw it; the
  // node badge must still say Pendant, not Cloud.
  const node = hiveNodeFor({ origin: "live_lte", source: "cloudflare" });
  assert.equal(node.label, "Pendant");
});

test("names the browser node from any of its markers", () => {
  assert.equal(hiveNodeFor({ kind: "browser_task" }).label, "Browser");
  assert.equal(hiveNodeFor({ origin: "browser-extension" }).label, "Browser");
  assert.equal(
    hiveNodeFor({ executor: "browser", source: "device-7" }).label,
    "Browser",
  );
});

test("separates on-Mac work from a dashboard routed through the relay", () => {
  // A jobTracker job (source, no origin) is This Mac …
  assert.equal(hiveNodeFor({ source: "floating-hud" }).label, "This Mac");
  assert.equal(hiveNodeFor({ source: "dashboard" }).label, "This Mac");
  assert.equal(hiveNodeFor({ source: "local" }).label, "This Mac");
  // … but the same word as a relay history ORIGIN is a remote dashboard.
  assert.equal(
    hiveNodeFor({ origin: "dashboard", source: "cloudflare" }).label,
    "Dashboard",
  );
});

test("maps explicit iPhone signals, and Cloud when there is no device origin", () => {
  assert.equal(hiveNodeFor({ source: "mobile" }).label, "iPhone");
  assert.equal(hiveNodeFor({ origin: "ios" }).label, "iPhone");
  assert.equal(hiveNodeFor({ source: "cloudflare" }).label, "Cloud");
});

test("keeps development work honestly labelled, never as a hive node", () => {
  assert.equal(hiveNodeFor({ source: "recon" }).label, "Recon");
  assert.equal(hiveNodeFor({ source: "harness-task" }).label, "Harness");
  assert.equal(hiveNodeFor({ source: "routine" }).label, "Routine");
  // None of these is a node word.
  for (const key of ["recon", "harness-task", "routine", "probe", "measure"]) {
    assert.notEqual(hiveNodeFor({ source: key }).label, "This Mac");
  }
});

/* ------------------------------------------------------------- device tags */

test("device tags dedupe by device, never by raw source word", () => {
  // `floating-hud` and `dashboard` were two tabs in the owner's screenshot;
  // both are the same device, so both are exactly the one This Mac tag.
  for (const source of ["floating-hud", "dashboard", "local", "mac"]) {
    assert.deepEqual(
      deviceTagsFor({ source }).map((tag) => tag.key),
      ["mac"],
    );
  }
  for (const record of [
    { kind: "browser_task" },
    { origin: "browser-extension", source: "cloudflare" },
    { executor: "browser", source: "device-7" },
  ]) {
    assert.deepEqual(
      deviceTagsFor(record).map((tag) => tag.key),
      ["browser"],
    );
  }
});

test("a run that travelled through several nodes carries every device tag", () => {
  // "one task may travel through multiple nodes as well" — issued on the
  // pendant, executed by the browser extension: both tags, executor first.
  assert.deepEqual(
    deviceTagsFor({
      origin: "live_lte",
      executor: "browser",
      source: "cloudflare",
    }).map((tag) => tag.key),
    ["browser", "pendant"],
  );
});

test("Cloud never rides along as a second tag on a device's run", () => {
  // "'recent' shows cloud work only, which should be changed" — the relay
  // witnesses nearly everything, so Cloud tags only cloud-only work.
  assert.deepEqual(
    deviceTagsFor({ origin: "live_lte", source: "cloudflare" }).map(
      (tag) => tag.key,
    ),
    ["pendant"],
  );
  assert.deepEqual(
    deviceTagsFor({ source: "cloudflare" }).map((tag) => tag.key),
    ["cloud"],
  );
});

test("a remote dashboard row never smuggles a This Mac tag", () => {
  // Relay-history fallback rows keep origin and source apart; the source word
  // 'dashboard' alone must not read as the on-Mac composer.
  assert.deepEqual(
    deviceTagsFor({ origin: "dashboard", source: "cloudflare" }).map(
      (tag) => tag.key,
    ),
    ["dashboard"],
  );
});

test("probes and routines fold into the one Agent-initiated tag", () => {
  for (const source of ["operator-probe", "routine", "recon", "harness-task"]) {
    assert.deepEqual(
      deviceTagsFor({ source }).map((tag) => tag.label),
      ["Agent-initiated"],
    );
    assert.equal(isAgentInitiated({ source }), true);
  }
  assert.equal(isAgentInitiated({ source: "floating-hud" }), false);
  assert.equal(
    isAgentInitiated({ origin: "live_lte", source: "cloudflare" }),
    false,
  );
});

test("pendant identity survives when only input telemetry recorded it", () => {
  // The Mac agent's own /pipeline rows carry no origin — the bridge stamps
  // source 'cloudflare' and the device lives in the run's telemetry.
  assert.deepEqual(
    deviceTagsFor({
      source: "cloudflare",
      events: [{ meta: { inputTelemetry: { storage: "live_lte" } } }],
    }).map((tag) => tag.key),
    ["pendant"],
  );
});

test("jobToHistoryEntry keeps the goal-grounded status verbatim", () => {
  const entry = jobToHistoryEntry({
    id: "local_1",
    source: "floating-hud",
    command: "tidy my desktop",
    status: "incomplete",
    summary: "Moved 3 files; 2 could not be sorted.",
  });
  assert.equal(entry.pipelineId, "local_1");
  assert.equal(entry.status, "incomplete");
  assert.equal(entry.jobStatus, "incomplete");
  assert.equal(entry.reply, "Moved 3 files; 2 could not be sorted.");
  // A job-feed row, never a voice pipeline run (no fabricated STT rail).
  assert.equal(entry.kind, "job");
  // Empty origin so the classifier reads `source` and returns This Mac.
  assert.equal(hiveNodeFor(entry).label, "This Mac");
  // A relay-fallback row keeps its issuing origin through the fold.
  const relayEntry = jobToHistoryEntry({
    id: "job_remote",
    origin: "dashboard",
    source: "cloudflare",
    command: "weather",
    status: "completed",
  });
  assert.equal(hiveNodeFor(relayEntry).label, "Dashboard");
});

test("mergeHiveFeed folds the job feed in, deduped and newest-first", () => {
  const base = [
    {
      pipelineId: "job_relay",
      command: "weather",
      status: "completed",
      origin: "live_lte",
      source: "cloudflare",
      createdAt: "2026-08-08T22:00:00.000Z",
    },
  ];
  const jobs = [
    {
      id: "local_new",
      source: "floating-hud",
      command: "open notes",
      status: "completed",
      summary: "Opened Notes.",
      createdAt: "2026-08-09T09:00:00.000Z",
    },
    {
      id: "local_pendant_dup",
      source: "pendant",
      command: "weather",
      status: "completed",
      createdAt: "2026-08-09T08:00:00.000Z",
    },
    {
      id: "job_relay", // same id as a relay row: must not appear twice
      source: "dashboard",
      command: "weather",
      status: "completed",
      createdAt: "2026-08-09T10:00:00.000Z",
    },
  ];

  const merged = mergeHiveFeed(base, jobs);
  const ids = merged.map((entry) => entry.pipelineId);
  assert.deepEqual(ids, ["local_new", "job_relay"]);
  // The pendant-sourced job (already in relay history) was not folded.
  assert.equal(ids.includes("local_pendant_dup"), false);
  // Newest first.
  assert.equal(merged[0].pipelineId, "local_new");
});

test("mergeHiveFeed folds agent-initiated and browser work in, tagged", () => {
  // Widened on the 2026-08-12 ruling: the feed shows EVERY node's work, so a
  // probe or an agent-driven browser job is a row now — tagged honestly,
  // never dressed as a device.
  const base = [{ pipelineId: "a", createdAt: "2026-08-09T00:00:00.000Z" }];
  const merged = mergeHiveFeed(base, [
    {
      id: "local_probe",
      source: "operator-probe",
      command: "health check",
      status: "completed",
      createdAt: "2026-08-09T01:00:00.000Z",
    },
    {
      id: "local_browser",
      source: "browser-inspect-act",
      command: "read the page",
      status: "completed",
      createdAt: "2026-08-09T02:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    merged.map((entry) => entry.pipelineId),
    ["local_browser", "local_probe", "a"],
  );
  assert.deepEqual(
    deviceTagsFor(merged[0]).map((tag) => tag.key),
    ["browser"],
  );
  assert.deepEqual(
    deviceTagsFor(merged[1]).map((tag) => tag.label),
    ["Agent-initiated"],
  );
});

test("mergeHiveFeed is a no-op when the job feed is empty", () => {
  const base = [{ pipelineId: "a", createdAt: "2026-08-09T00:00:00.000Z" }];
  assert.deepEqual(mergeHiveFeed(base, []), base);
  // The bridge's copy of relay work is the ONE exclusion left.
  assert.deepEqual(mergeHiveFeed(base, [{ source: "pendant", id: "p" }]), base);
});

/* --------------------------------------------- honest terminal verdicts */

test("terminalPhaseFor keeps goal-grounded verdicts out of Answered", () => {
  // Goal not met, or stopped short: attention tone, never the "ok" of Done.
  assert.deepEqual(terminalPhaseFor("incomplete"), {
    phase: "incomplete",
    label: "Incomplete",
    tone: "attention",
  });
  assert.deepEqual(terminalPhaseFor("cancelled"), {
    phase: "incomplete",
    label: "Cancelled",
    tone: "attention",
  });
  // Terminal-but-not-Done stays neutral, with its own honest word.
  for (const status of ["read_only", "handed_off", "finished", "recorded"]) {
    const terminal = terminalPhaseFor(status);
    assert.equal(terminal.phase, "no-result");
    assert.equal(terminal.tone, "idle");
    assert.notEqual(terminal.phase, "answered");
  }
  assert.equal(terminalPhaseFor("read_only").label, "Read only");
  assert.equal(terminalPhaseFor("handed_off").label, "Handed off");
  assert.equal(terminalPhaseFor("finished").label, "Finished");
  assert.equal(terminalPhaseFor("recorded").label, "Recorded");
  // Success, failure, running and parked keep their own branches.
  for (const status of [
    "completed",
    "failed",
    "processing",
    "queued",
    "plan_ready",
    "",
    undefined,
  ]) {
    assert.equal(terminalPhaseFor(status), null);
  }
});

/* ---------------------------------------------------------------- the hero */

/*
 * The same precedence `runState` applies to a merged entry: the goal-grounded
 * terminal verdict is read BEFORE the reply text, so a summary can never
 * promote a goal-not-met run to Answered.
 */
const stateLike = (entry) =>
  terminalPhaseFor(entry.jobStatus || entry.status) ?? {
    phase: entry.reply ? "answered" : "nothing-yet",
  };

const answeredAlways = () => ({ phase: "answered" });

test("hero candidates: the newest node wins, whichever node it is", () => {
  const relayRun = {
    pipelineId: "job_relay",
    command: "weather",
    status: "completed",
    reply: "Clear tonight.",
    origin: "live_lte",
    source: "cloudflare",
    createdAt: "2026-08-09T08:00:00.000Z",
  };
  const hudJob = {
    id: "local_hud",
    source: "floating-hud",
    command: "open notes",
    status: "completed",
    summary: "Opened Notes.",
    createdAt: "2026-08-09T09:00:00.000Z",
  };

  // Local job newer → the Mac-local task is the hero (the owner's complaint:
  // the hero sat on last night's pendant answer while newer HUD work piled up).
  let merged = mergeHiveFeed([relayRun], [hudJob]);
  assert.equal(pickHero(merged, answeredAlways).pipelineId, "local_hud");

  // Relay run newer → the pendant run stays the hero.
  const newerRelay = { ...relayRun, createdAt: "2026-08-09T10:00:00.000Z" };
  merged = mergeHiveFeed([newerRelay], [hudJob]);
  assert.equal(pickHero(merged, answeredAlways).pipelineId, "job_relay");
});

test("hero candidates: a tie keeps the shared record first; no timestamp never claims newest", () => {
  const at = "2026-08-09T09:00:00.000Z";
  const relayRun = {
    pipelineId: "job_tie",
    command: "a",
    status: "completed",
    createdAt: at,
  };
  const tieJob = {
    id: "local_tie",
    source: "dashboard",
    command: "b",
    status: "completed",
    createdAt: at,
  };
  const undatedJob = {
    id: "local_undated",
    source: "floating-hud",
    command: "c",
    status: "completed",
  };

  const merged = mergeHiveFeed([relayRun], [tieJob, undatedJob]);
  assert.deepEqual(
    merged.map((entry) => entry.pipelineId),
    ["job_tie", "local_tie", "local_undated"],
  );
  assert.equal(pickHero(merged, answeredAlways).pipelineId, "job_tie");
});

test("an incomplete local job that is newest heroes as Incomplete, never Answered", () => {
  const relayRun = {
    pipelineId: "job_weather",
    command: "weather",
    status: "completed",
    reply: "Clear tonight.",
    origin: "live_lte",
    source: "cloudflare",
    createdAt: "2026-08-08T22:00:00.000Z",
  };
  const partial = {
    id: "local_partial",
    source: "floating-hud",
    command: "tidy my desktop",
    status: "incomplete",
    summary: "Moved 3 files; 2 could not be sorted.",
    createdAt: "2026-08-09T09:00:00.000Z",
  };

  const merged = mergeHiveFeed([relayRun], [partial]);
  const hero = pickHero(merged, stateLike);
  assert.equal(hero.pipelineId, "local_partial");
  // The honest summary survived the fold …
  assert.equal(hero.reply, "Moved 3 files; 2 could not be sorted.");
  // … and the verdict outranks it: attention, not Answered.
  const state = stateLike(hero);
  assert.equal(state.phase, "incomplete");
  assert.notEqual(state.phase, "answered");
  assert.equal(state.tone, "attention");
  assert.equal(state.label, "Incomplete");
});

test("a relay row that also appears locally is one hero candidate, not two", () => {
  const shared = {
    pipelineId: "job_shared",
    command: "weather",
    status: "completed",
    reply: "Clear tonight.",
    createdAt: "2026-08-09T09:00:00.000Z",
  };
  const jobs = [
    // The bridge's own copy of relay work is stamped 'pendant' — excluded.
    {
      id: "local_bridge_copy",
      source: "pendant",
      command: "weather",
      status: "completed",
      createdAt: "2026-08-09T09:30:00.000Z",
    },
    // An id collision with the shared record is dropped, not shown twice.
    {
      id: "job_shared",
      source: "dashboard",
      command: "weather",
      status: "completed",
      createdAt: "2026-08-09T09:30:00.000Z",
    },
  ];
  const merged = mergeHiveFeed([shared], jobs);
  assert.deepEqual(
    merged.map((entry) => entry.pipelineId),
    ["job_shared"],
  );
  assert.equal(pickHero(merged, answeredAlways).pipelineId, "job_shared");
});

test("pickHero skips empty runs and already-carded approvals, with no fallback", () => {
  const entries = [
    { pipelineId: "a", command: "" },
    { pipelineId: "b", command: "Send the report" },
    { pipelineId: "c", command: "older answer" },
  ];
  const states = {
    a: { phase: "nothing-yet", question: "" },
    b: { phase: "needs-approval", question: "Send the report" },
    c: { phase: "answered", question: "older answer" },
  };
  const stateFor = (entry) => states[entry.pipelineId];

  // The parked run already has its approval card above → the older answer
  // heroes, so the owner's question is never printed twice on one page.
  assert.equal(
    pickHero(entries, stateFor, {
      approvedCommands: new Set(["send the report"]),
    }).pipelineId,
    "c",
  );
  // Without a card, the parked run itself is the hero.
  assert.equal(pickHero(entries, stateFor).pipelineId, "b");
  // Nothing worth showing → null, never "show something anyway".
  assert.equal(pickHero([entries[0]], stateFor), null);
  assert.equal(pickHero([], stateFor), null);
});

test("a surface's provenance trailer is not the title of the ask", () => {
  /*
   * The exact string the browser extension sent on 2026-08-09. It reached the
   * approval card, the RECENT list and the hero's "YOU ASKED" line whole, so
   * two lines of where-it-came-from crowded out the request itself.
   */
  const sent =
    "cancel all my recurring investments on ibkr\n\n" +
    '[Sent from the browser extension. Active page: "evan1liu/agentic-gadget" — https://github.com/evan1liu/agentic-gadget/tree/main]';

  assert.equal(
    commandTitle(sent),
    "cancel all my recurring investments on ibkr",
  );
});

test("commandTitle leaves brackets that are not trailers alone", () => {
  // The anchoring is the whole safety argument: a blank line before "[", and
  // the block closing at end of input. These would each lose real command text
  // to a looser regex.
  assert.equal(
    commandTitle("rename the file to [draft] and save it"),
    "rename the file to [draft] and save it",
  );
  assert.equal(commandTitle("open the file [notes]"), "open the file [notes]");
  assert.equal(
    commandTitle("do the thing\n\n[note] and then stop"),
    "do the thing\n\n[note] and then stop",
  );
  assert.equal(commandTitle(""), "");
  assert.equal(commandTitle(null), "");
});

test("a folded row says how many times, and an unfolded one says nothing", () => {
  // The 99% case: no fold, no extra text anywhere in the row.
  assert.equal(repeatSummary({}), "");
  assert.equal(repeatSummary({ repeatCount: 1 }), "");
  assert.equal(repeatSummary(null), "");

  // A fold must never render as a single occurrence.
  assert.equal(repeatSummary({ repeatCount: 2 }), "2 times in a row");
  assert.equal(repeatSummary({ repeatCount: 12 }), "12 times in a row");

  // Garbage on the wire is not a count.
  assert.equal(repeatSummary({ repeatCount: "lots" }), "");
  assert.equal(repeatSummary({ repeatCount: Number.NaN }), "");
});
