/* eslint-disable @typescript-eslint/no-explicit-any -- Hive feeds are schemaless aggregator records at this boundary. */

/**
 * Hive data layer — one view, two feeds.
 *
 * LIVE: the local aggregator on http://127.0.0.1:8010 (hive-dashboard/server.mjs),
 * reachable only when the browser is physically on the Mac. It serves the full
 * overview plus an SSE diff stream.
 *
 * SNAPSHOT: that same aggregator PUTs a trimmed copy of the overview to the
 * relay's state store (`/v1/state/hive`) every ~8 s. Away from the Mac the page
 * reads it back through this app's own `/api/hive` server route — the same
 * relay-credential pattern every other `/api/*` route uses, so no token ever
 * reaches the browser.
 *
 * The two feeds share one shape (`HiveOverview`), so the views never branch on
 * where the data came from — only the badge does.
 */

export const HIVE_LOCAL_BASE = "http://127.0.0.1:8010";

export type HiveStatus = "up" | "degraded" | "down" | "unknown" | "idle";

export type HiveNode = {
  id: string;
  label: string;
  status: HiveStatus;
  reason: string;
  activityAt: number | null;
};

export type HiveEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  lastActivityAt: number | null;
};

export type HiveEvent = {
  seq: number;
  at: number;
  source: string;
  kind: string;
  text: string;
};

export type HiveSourceMeta = {
  key: string;
  label: string;
  family: string;
  intervalMs?: number;
  ok: boolean;
  at: number;
  ms?: number;
  error: string | null;
  parseError?: boolean;
  unsupported?: boolean;
  version?: number;
};

export type HiveOverview = {
  now: number;
  startedAt?: number;
  port?: number;
  /** Present only on relay snapshots — when the aggregator pushed this copy. */
  pushedAt?: number;
  committeeAgents: string[];
  nodes: HiveNode[];
  edges: HiveEdge[];
  shared: any;
  sources: Record<string, HiveSourceMeta & { data: any }>;
  events: HiveEvent[];
  eventSeq: number;
};

export type HiveDelta = {
  t: number;
  nodes: HiveNode[];
  edges: HiveEdge[];
  shared: any;
  meta: Record<string, HiveSourceMeta>;
  sources: Record<string, HiveSourceMeta & { data: any }>;
  events: HiveEvent[];
  eventSeq: number;
};

export const HIVE_STATUS_WORD: Record<string, string> = {
  up: "UP",
  degraded: "DEGRADED",
  down: "DOWN",
  unknown: "UNKNOWN",
  idle: "IDLE",
};

/** Status → dashboard palette. Always paired with the text label above. */
export const HIVE_STATUS_COLOR: Record<string, string> = {
  up: "var(--green)",
  degraded: "var(--amber)",
  down: "var(--red)",
  unknown: "#5d6470",
  idle: "var(--blue)",
};

/** Event-source → categorical color (hive-only tokens set in globals.css). */
export const HIVE_SOURCE_COLOR: Record<string, string> = {
  mac: "var(--hv-mac)",
  relay: "var(--hv-relay)",
  extension: "var(--hv-extension)",
  committee: "var(--hv-committee)",
  pendant: "var(--hv-pendant)",
  system: "var(--hv-system)",
};

export const HIVE_NODE_TAG: Record<string, string> = {
  pendant: "PND",
  relay: "RLY",
  mac: "MAC",
  extension: "EXT",
  ios: "IOS",
};

export const HIVE_SHORT_LABEL: Record<string, string> = {
  mac: "Mac",
  relay: "Relay",
  extension: "Ext",
  pendant: "Pendant",
  ios: "iOS",
  committee: "Committee",
};

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function tsMs(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return isFinite(parsed) ? parsed : null;
}

/** Age of a timestamp against the (server-corrected) clock; "—" when absent. */
export function ageOf(value: unknown, now: number, suffix = ""): string {
  const ms = tsMs(value);
  if (ms == null) return "—";
  return fmtAge(now - ms) + suffix;
}

/**
 * Probe the local aggregator. On an https page this fetch is usually killed by
 * the browser (mixed content / private-network access) before the timeout —
 * that rejection is an expected signal meaning "not on the Mac", not a fault.
 */
export async function probeLocalOverview(timeoutMs = 1500): Promise<HiveOverview> {
  const response = await fetch(`${HIVE_LOCAL_BASE}/api/overview`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`local hive aggregator answered HTTP ${response.status}`);
  }
  return (await response.json()) as HiveOverview;
}

export type RelayHivePayload = {
  data: HiveOverview;
  state: { revision: number; updatedAt: string | null; updatedBy: string | null };
};

/**
 * Relay snapshot via this app's own server route. On the Mac-agent build there
 * is no server behind the static files, so this fails with the host's real
 * response — which the page shows verbatim rather than papering over.
 */
export async function fetchRelayHive(): Promise<RelayHivePayload> {
  const response = await fetch("/api/hive", { cache: "no-store" });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `/api/hive failed (${response.status})`);
  }
  if (!payload.data || typeof payload.data !== "object") {
    throw new Error("/api/hive returned no data object");
  }
  return payload as RelayHivePayload;
}
