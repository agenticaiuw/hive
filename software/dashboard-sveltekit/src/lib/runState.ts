/* eslint-disable @typescript-eslint/no-explicit-any -- Relay/agent records are schemaless at this display boundary. */

/**
 * What is actually true about a run, in words a person uses.
 *
 * The dashboard used to render `run.status` straight onto the screen. That
 * field says "processing" for a run whose plan has PARKED and is waiting on the
 * owner, and keeps saying it after the answer has been spoken and uploaded — so
 * the page said "Running" while the truth was "needs you". Nielsen's heuristic 1
 * (visibility of system status) is only worth anything if the status is true,
 * and heuristic 2 says it has to be in the user's words, not the system's.
 *
 * So the phase is derived from the run's own EVENTS, which are unambiguous, and
 * every human sentence shown to the owner is either a fixed phrase from the
 * table below or the agent's own verbatim text. Nothing here invents a state
 * the data cannot support:
 *
 *   needs-approval  the last `agent` event is `status: "waiting"`. The agent
 *                   writes `label: "Waiting for your approval"` and
 *                   `meta.blocked[] = [{type, reason}]` there itself.
 *   failed          `run.status === "failed"`, or an event failed.
 *   listening       the `transcription` stage is still open on a fresh run.
 *   thinking        the last `agent` event is `status: "active"`.
 *   answered        there is reply text and the agent stage closed `done`.
 *   nothing-yet     no run worth showing.
 *
 * Known ambiguity, deliberately NOT papered over: a parked run's events never
 * record that the owner later approved it — approval starts a *separate* job
 * (`source: "operator-approval"`). So "needs your approval" means "this plan is
 * parked", not "nobody has acted on it". `pendingApprovals()` therefore reads
 * the job list, where a plan that is still parked is still `plan_ready`, and
 * collapses duplicates of the same request rather than guessing.
 */

import { hasUsefulTranscript, isTranscribing, type JsonRecord } from "$lib/pipeline";
import type { JobView } from "$lib/jobs";

export type RunPhase =
  | "nothing-yet"
  | "listening"
  | "thinking"
  | "needs-approval"
  | "answered"
  | "no-result"
  | "failed";

/**
 * How long a stage may sit `active` before "Thinking" stops being true.
 *
 * Runs on this rig routinely open an `agent: active` event and never close it,
 * so a check that only read the last event painted 40-minute-old runs as live.
 * A spinner that never stops is a fabricated progress indicator.
 */
const STALE_AFTER_MS = 180_000;

export type BlockedReason = { type: string; reason: string };

export type RunState = {
  phase: RunPhase;
  /** The status in human words. Never a code, never a stage name. */
  label: string;
  /** One line of "why", verbatim from the agent whenever it wrote one. */
  detail: string;
  /** Drives colour AND is paired with a word + icon — never colour alone. */
  tone: "idle" | "live" | "ok" | "attention" | "bad";
  /** The answer. Non-empty only in the `answered` phase. */
  answer: string;
  /** What the owner asked. Context, never the headline. */
  question: string;
  /** The agent's own reasons for parking, verbatim. */
  blocked: BlockedReason[];
  /** The agent's one-line description of what it wants to do. */
  plan: string;
  /** The real error text, verbatim. Non-empty only in the `failed` phase. */
  error: string;
  /** Whatever the agent actually said out loud, whichever phase this is. */
  spokenReply: string;
  /** The agent's honest account of where the reply got to. Never "played". */
  delivery: string;
  /** `/jobs` id of the plan behind this run, when the events recorded one. */
  planJobId: string;
  at: string;
};

const EMPTY: RunState = {
  phase: "nothing-yet",
  label: "Ready",
  detail: "",
  tone: "idle",
  answer: "",
  question: "",
  blocked: [],
  plan: "",
  error: "",
  spokenReply: "",
  delivery: "",
  planJobId: "",
  at: "",
};

export const NOT_HEARD_YET =
  "Audio reached Cloudflare, but speech recognition returned only punctuation.";

function events(run: JsonRecord | null): JsonRecord[] {
  return Array.isArray(run?.events) ? run!.events : [];
}

function lastOfStage(run: JsonRecord | null, stage: string): JsonRecord | null {
  const matches = events(run).filter((event) => event.stage === stage);
  return matches.length ? matches[matches.length - 1] : null;
}

function textOf(event: JsonRecord | null): string {
  return String(event?.text || "").trim();
}

/**
 * The reply the agent produced, from the most trustworthy place that has one.
 * A candidate that merely repeats the question is the echo bug this redesign
 * exists to kill, so it is rejected rather than shown as an answer.
 */
function replyText(run: JsonRecord): string {
  const question = String(run.command || "").trim();
  const candidates = [
    String(run.reply || ""),
    String(run.audio?.replyTranscript || ""),
    textOf(lastOfStage(run, "tts")),
    ...events(run)
      .filter((event) => event.stage === "agent" && event.status === "done")
      .map(textOf)
      .reverse(),
  ];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value) continue;
    if (value === question) continue;
    return value;
  }
  return "";
}

/** The agent writes this sentence itself; it is never assembled here. */
function deliveryLine(run: JsonRecord): string {
  const label = String(run.delivery?.label || "").trim();
  return label;
}

function blockedFrom(event: JsonRecord | null): BlockedReason[] {
  const raw = event?.meta?.blocked;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => ({
      type: String(entry?.type || "action"),
      reason: String(entry?.reason || ""),
    }))
    .filter((entry) => entry.reason || entry.type);
}

function planJobIdFrom(run: JsonRecord): string {
  for (const event of [...events(run)].reverse()) {
    const id = String(event?.meta?.localJobId || "");
    if (id) return id;
  }
  return "";
}

/** The verbatim message from the first thing that actually failed. */
function failureText(run: JsonRecord): string {
  const failed = events(run).find((event) => event.status === "failed");
  const fromEvent = String(failed?.detail || failed?.text || "").trim();
  return fromEvent || String(run.error || "").trim();
}

export function runState(run: JsonRecord | null): RunState {
  if (!run) return EMPTY;

  const question = String(run.command || "").trim();
  const agentEvent = lastOfStage(run, "agent");
  const spokenReply = replyText(run);
  const delivery = deliveryLine(run);
  const planJobId = planJobIdFrom(run);
  const at = String(run.updatedAt || run.createdAt || "");
  const base = { ...EMPTY, question, spokenReply, delivery, planJobId, at };

  /*
   * Parked first. A parked run keeps `status: "processing"` and still renders
   * TTS and a relay upload afterwards (it speaks "waiting for your approval"),
   * so any check that looked at run.status or at the last event of ANY stage
   * would call this one running. The agent stage is the one that knows.
   */
  if (agentEvent?.status === "waiting") {
    const blocked = blockedFrom(agentEvent);
    return {
      ...base,
      phase: "needs-approval",
      tone: "attention",
      label: String(agentEvent.label || "Waiting for your approval").trim(),
      detail: String(agentEvent.detail || blocked[0]?.reason || "").trim(),
      blocked,
      plan: textOf(
        events(run)
          .filter((event) => event.stage === "agent" && event.status === "done")
          .at(-1) ?? null,
      ),
    };
  }

  // Speech that arrived as nothing. The pipeline records it as a real failure.
  if (
    run.status === "failed" &&
    !hasUsefulTranscript(question) &&
    !isTranscribing(run)
  ) {
    return {
      ...base,
      phase: "failed",
      tone: "bad",
      label: "Didn't catch that",
      detail: NOT_HEARD_YET,
      error: failureText(run) || NOT_HEARD_YET,
    };
  }

  if (run.status === "failed" || events(run).some((e) => e.status === "failed")) {
    const message = failureText(run);
    return {
      ...base,
      phase: "failed",
      tone: "bad",
      label: "Couldn't do it",
      detail: message ? "" : "The run was recorded as failed with no message.",
      error: message,
    };
  }

  if (isTranscribing(run)) {
    return { ...base, phase: "listening", tone: "live", label: "Listening" };
  }

  const updatedAt = Date.parse(at);
  const fresh =
    Number.isFinite(updatedAt) && Date.now() - updatedAt < STALE_AFTER_MS;

  // Live only while it is actually live. See STALE_AFTER_MS.
  if (agentEvent?.status === "active" && fresh) {
    return {
      ...base,
      phase: "thinking",
      tone: "live",
      label: "Thinking",
      // The agent's own stage label, verbatim — jargon, but true, and small.
      detail: String(agentEvent.label || "").trim(),
    };
  }

  /*
   * Before falling back to "no result": the agent stage sometimes never writes
   * its closing event even though TTS rendered and the relay accepted a real
   * spoken reply. The reply is the stronger evidence, so it wins.
   */
  if (spokenReply) {
    return {
      ...base,
      phase: "answered",
      tone: "ok",
      label: "Answered",
      answer: spokenReply,
    };
  }

  if (!question) return EMPTY;

  if (fresh) {
    return { ...base, phase: "thinking", tone: "live", label: "Working on it" };
  }

  /*
   * A question, no failure, no reply, and nothing has moved. Saying "Answered"
   * would be a lie and "Failed" would be a different one; this states exactly
   * what the events show and nothing more.
   */
  return {
    ...base,
    phase: "no-result",
    tone: "idle",
    label: "No answer recorded",
    detail: "This run started and never recorded a result.",
  };
}

/* --------------------------------------------------------------- approvals */

export type PendingApproval = {
  jobId: string;
  command: string;
  /** The steps the agent has prepared and will run only if the owner says so. */
  steps: { label: string; type: string }[];
  blocked: BlockedReason[];
  source: string;
  at: string;
  /** Later parked copies of the same request, folded into this one. */
  duplicates: number;
};

/**
 * Plans parked on the Mac, newest first, one card per distinct request.
 *
 * `plan_ready` is the agent's own terminal status for "prepared, nothing run".
 * Repeat asks of the same question each leave their own parked job, which would
 * otherwise stack four identical cards on the page, so they collapse into one
 * and the count is stated rather than hidden.
 */
export function pendingApprovals(jobs: JobView[]): PendingApproval[] {
  const parked = jobs
    .filter((job) => job.status === "plan_ready")
    .sort(
      (a, b) =>
        Date.parse(String(b.updatedAt || b.createdAt || 0)) -
        Date.parse(String(a.updatedAt || a.createdAt || 0)),
    );

  const byCommand = new Map<string, PendingApproval>();
  for (const job of parked) {
    const key = job.command.trim().toLowerCase() || job.id;
    const existing = byCommand.get(key);
    if (existing) {
      existing.duplicates += 1;
      continue;
    }
    byCommand.set(key, {
      jobId: job.id,
      command: job.command,
      steps: job.planned.map((action) => ({
        label: action.label,
        type: action.type,
      })),
      blocked: [],
      source: job.source,
      at: String(job.updatedAt || job.createdAt || ""),
      duplicates: 0,
    });
  }
  return [...byCommand.values()];
}

/** Merge the blocked reasons the pipeline recorded into the matching plan. */
export function withBlockedReasons(
  approvals: PendingApproval[],
  runs: JsonRecord[],
): PendingApproval[] {
  const reasons = new Map<string, BlockedReason[]>();
  for (const run of runs) {
    const agentEvent = lastOfStage(run, "agent");
    if (agentEvent?.status !== "waiting") continue;
    const blocked = blockedFrom(agentEvent);
    if (!blocked.length) continue;
    const jobId = planJobIdFrom(run);
    if (jobId) reasons.set(jobId, blocked);
    const command = String(run.command || "").trim().toLowerCase();
    if (command && !reasons.has(command)) reasons.set(command, blocked);
  }
  return approvals.map((approval) => ({
    ...approval,
    blocked:
      reasons.get(approval.jobId) ??
      reasons.get(approval.command.trim().toLowerCase()) ??
      approval.blocked,
  }));
}
