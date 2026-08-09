import assert from "node:assert/strict";
import test from "node:test";

import {
  hiveNodeFor,
  isMacLocalOwnerJob,
  jobToHistoryEntry,
  mergeMacLocalHistory,
} from "../src/lib/hiveFeed.js";

test("names the pendant from either its transport or its source", () => {
  for (const origin of ["live_lte", "microSD", "pendant_upload"]) {
    assert.equal(hiveNodeFor({ origin, source: "cloudflare" }).label, "Pendant");
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

test("isMacLocalOwnerJob folds only the owner's on-Mac work", () => {
  assert.equal(isMacLocalOwnerJob({ source: "floating-hud" }), true);
  assert.equal(isMacLocalOwnerJob({ source: "dashboard" }), true);
  assert.equal(isMacLocalOwnerJob({ source: "local" }), true);
  // Bridge-executed relay work is stamped 'pendant' and already lives in relay
  // history — folding it would double-count, so it is excluded.
  assert.equal(isMacLocalOwnerJob({ source: "pendant" }), false);
  // Development work is scoped out.
  assert.equal(isMacLocalOwnerJob({ source: "recon" }), false);
  assert.equal(isMacLocalOwnerJob({ source: "harness-task" }), false);
  // A relay-history row (the /api/jobs fallback when the Mac is asleep) can
  // carry source 'dashboard' too, but it sets detailHref — it is relay history,
  // not on-Mac work, and must not be relabelled "This Mac".
  assert.equal(
    isMacLocalOwnerJob({ source: "dashboard", detailHref: "/api/history/x" }),
    false,
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
  // Empty origin so the classifier reads `source` and returns This Mac.
  assert.equal(hiveNodeFor(entry).label, "This Mac");
});

test("mergeMacLocalHistory folds owner Mac work in, deduped and newest-first", () => {
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

  const merged = mergeMacLocalHistory(base, jobs);
  const ids = merged.map((entry) => entry.pipelineId);
  assert.deepEqual(ids, ["local_new", "job_relay"]);
  // The pendant-sourced job (already in relay history) was not folded.
  assert.equal(ids.includes("local_pendant_dup"), false);
  // Newest first.
  assert.equal(merged[0].pipelineId, "local_new");
});

test("mergeMacLocalHistory is a no-op when there is no Mac-local work", () => {
  const base = [{ pipelineId: "a", createdAt: "2026-08-09T00:00:00.000Z" }];
  assert.deepEqual(mergeMacLocalHistory(base, []), base);
  assert.deepEqual(mergeMacLocalHistory(base, [{ source: "recon", id: "r" }]), base);
});
