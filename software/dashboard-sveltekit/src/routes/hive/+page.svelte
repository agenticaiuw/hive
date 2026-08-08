<script lang="ts">
  /* eslint-disable @typescript-eslint/no-explicit-any -- aggregator records are schemaless */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import CommandBox from "$lib/components/CommandBox.svelte";
  import HiveGraph from "$lib/components/HiveGraph.svelte";
  import HiveNodePanel from "$lib/components/HiveNodePanel.svelte";
  import HiveSharedPanel from "$lib/components/HiveSharedPanel.svelte";
  import HiveTicker from "$lib/components/HiveTicker.svelte";
  import {
    HIVE_LOCAL_BASE,
    HIVE_SHORT_LABEL,
    HIVE_STATUS_COLOR,
    HIVE_STATUS_WORD,
    fmtAge,
    fetchRelayHive,
    probeLocalOverview,
    tsMs,
    type HiveDelta,
    type HiveEdge,
    type HiveEvent,
    type HiveNode,
    type HiveOverview,
    type HiveSourceMeta,
  } from "$lib/hive";

  /*
   * Data mode, decided once per visit and labeled honestly:
   *
   *  - probing:     first paint, local aggregator probe in flight (≤1.5 s)
   *  - live:        http://127.0.0.1:8010 answered → full overview + SSE diffs
   *  - snapshot:    local probe failed (normal when off the Mac — on https the
   *                 browser kills the mixed-content fetch outright) → the copy
   *                 the aggregator pushes to the relay, polled every 10 s
   *  - unavailable: both feeds failed; both real errors stay on screen
   */
  type Mode = "probing" | "live" | "snapshot" | "unavailable";
  let mode = $state<Mode>("probing");
  let sse = $state<"live" | "reconnecting" | "off">("off");
  let localError = $state("");
  let relayError = $state("");
  let pushedAt = $state<number | null>(null);

  let clockOffset = $state(0);
  let nodes = $state<HiveNode[]>([]);
  let edges = $state<HiveEdge[]>([]);
  let shared = $state<any>(null);
  let committeeAgents = $state<string[]>([]);
  let meta = $state<Record<string, HiveSourceMeta>>({});
  let src = $state<Record<string, any>>({});
  let events = $state<HiveEvent[]>([]);
  let maxSeq = 0;

  let focused = $state("mac");
  let nowTick = $state(Date.now());
  const snow = $derived(nowTick - clockOffset);

  function absorbSources(map: Record<string, HiveSourceMeta & { data?: any }> | undefined) {
    for (const [k, v] of Object.entries(map || {})) {
      meta[k] = {
        key: v.key,
        label: v.label,
        family: v.family,
        intervalMs: v.intervalMs,
        ok: v.ok,
        at: v.at,
        ms: v.ms,
        error: v.error,
        parseError: v.parseError,
        unsupported: v.unsupported,
        version: v.version,
      };
      if (v.data != null) src[k] = v.data;
    }
  }

  function appendEvents(list: HiveEvent[] | undefined) {
    for (const e of list || []) {
      if (e.seq <= maxSeq) continue;
      maxSeq = e.seq;
      events.push(e);
    }
    if (events.length > 300) events.splice(0, events.length - 300);
  }

  function applyOverview(o: HiveOverview, replaceEvents: boolean) {
    clockOffset = Date.now() - o.now;
    committeeAgents = o.committeeAgents || [];
    nodes = o.nodes || [];
    edges = o.edges || [];
    shared = o.shared || null;
    absorbSources(o.sources);
    if (replaceEvents) {
      // Snapshot polls overlap; the pushed copy IS the tail, so replace.
      events = (o.events || []).slice();
      maxSeq = Math.max(maxSeq, o.eventSeq || 0);
    } else {
      appendEvents(o.events);
      maxSeq = Math.max(maxSeq, o.eventSeq || 0);
    }
    pushedAt = o.pushedAt ?? null;
  }

  function applyDelta(d: HiveDelta) {
    clockOffset = Date.now() - d.t;
    nodes = d.nodes;
    edges = d.edges;
    shared = d.shared;
    for (const [k, m] of Object.entries(d.meta || {})) {
      meta[k] = { ...(meta[k] || {}), ...m };
    }
    absorbSources(d.sources);
    appendEvents(d.events);
  }

  // ------------------------------------------------------------ live (SSE)
  let es: EventSource | null = null;
  function openSSE() {
    es = new EventSource(`${HIVE_LOCAL_BASE}/api/events?cursor=${maxSeq}`);
    es.onopen = async () => {
      const wasDropped = sse === "reconnecting";
      sse = "live";
      if (wasDropped) {
        // Heal whatever the dropped stream missed with one full overview.
        try {
          applyOverview(await probeLocalOverview(5000), false);
        } catch {
          /* the next delta heals incrementally */
        }
      }
    };
    es.onmessage = (ev) => {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d.hello) return;
      applyDelta(d as HiveDelta);
    };
    es.onerror = () => {
      sse = "reconnecting";
    };
  }

  // ------------------------------------------------------------ snapshot (relay)
  let snapshotPending = false;
  async function pollSnapshot(force = false) {
    if (snapshotPending) return;
    if (!force && document.visibilityState !== "visible") return;
    snapshotPending = true;
    try {
      const payload = await fetchRelayHive();
      applyOverview(payload.data, true);
      if (payload.data.pushedAt == null) {
        pushedAt = tsMs(payload.state.updatedAt);
      }
      relayError = "";
      mode = "snapshot";
    } catch (error) {
      relayError = error instanceof Error ? error.message : String(error);
      if (mode !== "snapshot") mode = "unavailable";
    } finally {
      snapshotPending = false;
    }
  }

  onMount(() => {
    const tick = window.setInterval(() => {
      nowTick = Date.now();
    }, 1000);
    let snapshotTimer: number | undefined;

    (async () => {
      try {
        const o = await probeLocalOverview(1500);
        mode = "live";
        applyOverview(o, true);
        openSSE();
      } catch (error) {
        // Expected off the Mac (connection refused, timeout, or the browser
        // blocking http://127.0.0.1 from an https page). Fall through fast.
        localError = error instanceof Error ? error.message : String(error);
        await pollSnapshot(true);
        snapshotTimer = window.setInterval(() => void pollSnapshot(), 10_000);
      }
    })();

    return () => {
      window.clearInterval(tick);
      if (snapshotTimer) window.clearInterval(snapshotTimer);
      es?.close();
      es = null;
    };
  });

  // ------------------------------------------------------------ derived bits
  const committeeNode = $derived(nodes.find((n) => n.id === "committee"));
  const focusedNode = $derived(nodes.find((n) => n.id === focused));

  const heartbeats = $derived.by<Record<string, number | null>>(() => {
    const ext = src["agent.browserStatus"]?.devices?.[0];
    const pend = (src["relay.devices"]?.devices || []).find((d: any) =>
      /pendant|wearable|nrf/i.test(`${d.deviceType} ${d.deviceId} ${d.name}`),
    );
    const mob = (src["relay.devices"]?.devices || []).find(
      (d: any) => d.deviceType === "mobile",
    );
    return {
      mac: meta["agent.health"]?.ok ? meta["agent.health"].at : null,
      relay: meta["relay.health"]?.ok ? meta["relay.health"].at : null,
      extension: ext ? tsMs(ext.lastSeenAt) : null,
      pendant: pend ? tsMs(pend.lastSeenAt) : null,
      ios: mob ? tsMs(mob.lastSeenAt) : null,
    };
  });

  const failingSources = $derived(
    Object.values(meta).filter((m) => m && !m.ok && !m.unsupported),
  );
  const sourceKeys = $derived(Object.keys(meta).length);

  const badge = $derived.by<{ cls: string; text: string; title: string }>(() => {
    if (mode === "live") {
      return sse === "reconnecting"
        ? {
            cls: "warn",
            text: "LIVE · reconnecting",
            title: `Stream to ${HIVE_LOCAL_BASE} dropped; retrying.`,
          }
        : {
            cls: "ok",
            text: "LIVE",
            title: `Live from the local hive aggregator at ${HIVE_LOCAL_BASE} (overview + SSE).`,
          };
    }
    if (mode === "snapshot") {
      const age = pushedAt ? fmtAge(nowTick - pushedAt) : "unknown age";
      return {
        cls: "warn",
        text: `SNAPSHOT · ${age}`,
        title: `Relay copy pushed by the Mac aggregator every ~8 s; refreshed here every 10 s.${relayError ? ` Last poll failed: ${relayError}` : ""}\nLocal live feed unavailable: ${localError}`,
      };
    }
    if (mode === "unavailable") {
      return { cls: "bad", text: "NO DATA", title: "Both feeds failed — errors below." };
    }
    return { cls: "", text: "probing…", title: "Trying the local aggregator (1.5 s timeout)." };
  });

  function focus(id: string) {
    focused = id;
  }
</script>

<svelte:head>
  <title>Hive — AI Pendant Dashboard</title>
</svelte:head>

<main class="hv-shell">
  <header class="topbar">
    <div class="brand">
      <a class="hv-back" href="{base}/" title="Back to dashboard" aria-label="Back to dashboard">←</a>
      <span class="brand-mark" title="Hive">⬡</span>
      <h1>Hive</h1>
    </div>
    <div class="hv-head-chips">
      {#each nodes as n (n.id)}
        <span class="hv-hchip" title="{n.label}: {n.reason || ''}">
          <span
            class="hv-dot"
            style="background: {HIVE_STATUS_COLOR[n.status] || HIVE_STATUS_COLOR.unknown}"
          ></span>{HIVE_SHORT_LABEL[n.id] || n.label}
          <b>{HIVE_STATUS_WORD[n.status] || "?"}</b>
        </span>
      {/each}
      {#if sourceKeys}
        <span class="hv-hchip" title="aggregator sources polling ok / total">
          <span
            class="hv-dot"
            style="background: {failingSources.length
              ? 'var(--red)'
              : 'var(--green)'}"
          ></span>sources <b>{sourceKeys - failingSources.length}/{sourceKeys}</b>
        </span>
      {/if}
      <span class="hv-badge {badge.cls}" title={badge.title}>{badge.text}</span>
    </div>
  </header>

  <!-- Commands do not depend on hive data, so the box works in every mode —
       including "NO DATA", which is exactly when the owner wants to poke it. -->
  <CommandBox variant="bar" />

  {#if mode === "unavailable"}
    <div class="hv-dead">
      <p>No hive data on either path. Nothing below is a placeholder — there is simply no feed.</p>
      <p class="hv-err">local aggregator ({HIVE_LOCAL_BASE}): {localError}</p>
      <p class="hv-err">relay snapshot (/api/hive): {relayError}</p>
      <p class="hv-mut">
        On the Mac: start it with <code>node software/ai-pendant-simulator/hive-dashboard/server.mjs</code>.
        Elsewhere: the aggregator must be running on the Mac for the relay copy to stay fresh.
      </p>
    </div>
  {:else if mode === "probing"}
    <div class="hv-dead"><p class="hv-mut">probing the local hive aggregator…</p></div>
  {:else}
    {#if failingSources.length}
      <div class="hv-alerts">
        {#each failingSources as m (m.key)}
          <span class="hv-alert" class:parse={m.parseError} title={m.error}
            >{m.parseError ? "parse error" : "failed"} · {m.label} — {m.error}</span
          >
        {/each}
      </div>
    {/if}
    {#if mode === "snapshot" && relayError}
      <div class="hv-alerts">
        <span class="hv-alert" title={relayError}
          >snapshot poll failing (showing last good copy) — {relayError}</span
        >
      </div>
    {/if}

    <section class="hv-graph-wrap">
      <HiveGraph
        {nodes}
        {edges}
        {committeeAgents}
        orchestrator={src["committee.orchestrator"]}
        bulletin={src["committee.bulletin"]}
        {committeeNode}
        {heartbeats}
        {focused}
        now={snow}
        onFocus={focus}
      />
      <div class="hv-legend">
        <span><span class="hv-dot" style="background: var(--hv-mac)"></span>mac</span>
        <span><span class="hv-dot" style="background: var(--hv-relay)"></span>relay</span>
        <span><span class="hv-dot" style="background: var(--hv-extension)"></span>extension</span>
        <span><span class="hv-dot" style="background: var(--hv-committee)"></span>committee</span>
        <span><span class="hv-dot" style="background: var(--hv-pendant)"></span>pendant</span>
        <span><span class="hv-dot" style="background: var(--hv-system)"></span>system</span>
        <span class="hv-mut">nodes labeled UP / DEGRADED / DOWN / UNKNOWN / IDLE · click a node for detail</span>
      </div>
    </section>

    <section class="hv-main">
      <HiveNodePanel
        {focused}
        node={focusedNode}
        {src}
        {meta}
        {committeeAgents}
        now={snow}
        liveBase={mode === "live" ? HIVE_LOCAL_BASE : null}
      />
      <div class="hv-panel">
        <div class="hv-phead"><h2>SHARED / SYNCED ACROSS NODES</h2></div>
        <div class="hv-pbody">
          <HiveSharedPanel {shared} {meta} now={snow} />
        </div>
      </div>
    </section>

    <section class="hv-panel hv-ticker-panel">
      <div class="hv-phead"><h2>EVENT TICKER — ALL SOURCES, CHRONOLOGICAL</h2></div>
      <div class="hv-pbody">
        <HiveTicker {events} now={snow} />
      </div>
    </section>
  {/if}
</main>
