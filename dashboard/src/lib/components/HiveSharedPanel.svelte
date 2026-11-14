<script lang="ts">
  /* eslint-disable @typescript-eslint/no-explicit-any -- aggregator records are schemaless */
  import { ageOf, fmtAge, tsMs, type HiveSourceMeta } from "$lib/hive";

  let {
    shared,
    meta,
    now,
  }: {
    shared: any;
    meta: Record<string, HiveSourceMeta>;
    now: number;
  } = $props();

  type SharedTile = {
    label: string;
    value: string;
    small?: string;
    sub: string;
    err?: boolean;
  };

  /** The honest fallback: the failing source's real error string, or "not polled yet". */
  function srcFail(key: string): { sub: string; err: boolean } {
    const m = meta[key];
    if (!m) return { sub: "not polled yet", err: false };
    return { sub: `${m.label} failed: ${m.error}`, err: true };
  }

  function counts(record: Record<string, number> | null | undefined): string {
    return Object.entries(record || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
  }

  const tiles = $derived.by<SharedTile[]>(() => {
    const sh = shared || {};
    const out: SharedTile[] = [];

    if (sh.fleet && (sh.fleet.macBridgeLastSeenByRelay || sh.fleet.relayReachableFromMac != null)) {
      const f = sh.fleet;
      out.push({
        label: "FLEET SYNC",
        value: f.macBridgeOnline == null ? "—" : f.macBridgeOnline ? "linked" : "unlinked",
        err: f.macBridgeOnline === false,
        sub: `relay sees mac: ${f.macBridgeLastSeenByRelay ? ageOf(f.macBridgeLastSeenByRelay, now, " ago") : "—"} · mac sees relay: ${
          f.relayReachableFromMac == null
            ? "—"
            : f.relayReachableFromMac
              ? "reachable"
              : f.relayErrorFromMac || "unreachable"
        }`,
      });
    } else out.push({ label: "FLEET SYNC", value: "—", ...srcFail("relay.health") });

    if (sh.pipeline) {
      out.push({
        label: "PIPELINE RUNS",
        value: String(sh.pipeline.inFlight),
        small: " in flight",
        sub: `${sh.pipeline.totalRuns} total · latest ${
          sh.pipeline.latest
            ? `${sh.pipeline.latest.status} ${ageOf(sh.pipeline.latest.updatedAt, now, " ago")}`
            : "—"
        }`,
      });
    } else out.push({ label: "PIPELINE RUNS", value: "—", ...srcFail("agent.pipeline") });

    if (sh.jobs) {
      out.push({
        label: "JOBS (LAST 25)",
        value: String(sh.jobs.returned),
        sub:
          counts(sh.jobs.byStatus) +
          (sh.jobs.latestAt ? ` · newest ${ageOf(sh.jobs.latestAt, now, " ago")}` : ""),
      });
    } else out.push({ label: "JOBS (LAST 25)", value: "—", ...srcFail("agent.jobs") });

    if (sh.routines) {
      const nx = sh.routines.next;
      const nextAt = nx ? tsMs(nx.nextRunAt) : null;
      out.push({
        label: "ROUTINES",
        value: String(sh.routines.enabled),
        small: `/${sh.routines.total} enabled`,
        sub: nx
          ? `next: ${nx.name} in ${nextAt ? fmtAge(nextAt - now) : "—"}${sh.routines.failed ? ` · ${sh.routines.failed} failing` : ""}`
          : "—",
        err: Boolean(sh.routines.failed),
      });
    } else out.push({ label: "ROUTINES", value: "—", ...srcFail("agent.routines") });

    if (sh.memory) {
      out.push({
        label: "MEMORY FACTS",
        value: String(sh.memory.totalFacts),
        sub:
          Object.entries(sh.memory.byKind || {})
            .sort((a: any, b: any) => b[1] - a[1])
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ") + (sh.memory.masked ? ` · ${sh.memory.masked} masked` : ""),
      });
    } else out.push({ label: "MEMORY FACTS", value: "—", ...srcFail("agent.memoryFacts") });

    if (sh.ledger) {
      const c = sh.ledger.counts || {};
      out.push({
        label: "DESIGN LEDGER",
        value: String(c.implemented || 0),
        small: " implemented",
        sub: `proposed ${c.proposed || 0} · implementing ${c.implementing || 0} · duplicate ${c.duplicate || 0} · rejected ${c.rejected || 0} · total ${sh.ledger.total}`,
      });
    } else out.push({ label: "DESIGN LEDGER", value: "—", ...srcFail("committee.ledger") });

    if (sh.commons) {
      out.push({
        label: "COMMONS DEPOSITS",
        value: `${sh.commons.atLeast ? "≥" : ""}${sh.commons.depositsLast10m}`,
        small: " / 10 min",
        sub: sh.commons.lastAt
          ? `last deposit ${ageOf(sh.commons.lastAt, now, " ago")}`
          : "no deposits in tail",
      });
    } else out.push({ label: "COMMONS DEPOSITS", value: "—", ...srcFail("committee.commons") });

    if (sh.catchup?.counts) {
      const c = sh.catchup.counts;
      out.push({
        label: "CATCH-UP GAP",
        value: String(c.occurred ?? 0),
        small: " occurred",
        sub: `failed ${c.failed ?? 0} · expired ${c.expired ?? 0} · indeterminate ${c.indeterminate ?? 0} · window ${fmtAge(sh.catchup.spanMs)}`,
      });
    } else out.push({ label: "CATCH-UP GAP", value: "—", ...srcFail("agent.catchup") });

    if (sh.spool) {
      out.push({
        label: "BROWSER SPOOL",
        value: String(sh.spool.depth ?? "—"),
        small: " spooled",
        sub: `${sh.spool.pendingCommands ?? 0} pending now${sh.spool.lastReason ? ` · last loss: ${sh.spool.lastReason}` : ""}`,
      });
    } else out.push({ label: "BROWSER SPOOL", value: "—", ...srcFail("agent.browserStatus") });

    if (sh.bulletin) {
      out.push({
        label: "COMMITTEE BULLETIN",
        value: String(sh.bulletin.total),
        small: " msgs",
        sub: `round ${sh.bulletin.maxRound} · file written ${ageOf(sh.bulletin.fileMtime, now, " ago")}`,
      });
    } else out.push({ label: "COMMITTEE BULLETIN", value: "—", ...srcFail("committee.bulletin") });

    return out;
  });
</script>

<div class="hv-shared-grid">
  {#each tiles as tile (tile.label)}
    <div class="hv-tile">
      <div class="hv-tile-label">{tile.label}</div>
      <div class="hv-tile-value">{tile.value}{#if tile.small}<small>{tile.small}</small>{/if}</div>
      <div class="hv-tile-sub" class:err={tile.err}>{tile.sub}</div>
    </div>
  {/each}
</div>
