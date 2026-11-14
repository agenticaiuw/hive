<script lang="ts">
  /* eslint-disable @typescript-eslint/no-explicit-any -- aggregator records are schemaless */
  import { onMount } from "svelte";
  import {
    HIVE_NODE_TAG,
    HIVE_STATUS_COLOR,
    HIVE_STATUS_WORD,
    fmtAge,
    tsMs,
    type HiveEdge,
    type HiveNode,
  } from "$lib/hive";

  let {
    nodes,
    edges,
    committeeAgents,
    orchestrator,
    bulletin,
    committeeNode,
    heartbeats,
    focused,
    now,
    onFocus,
  }: {
    nodes: HiveNode[];
    edges: HiveEdge[];
    committeeAgents: string[];
    orchestrator: any;
    bulletin: any;
    committeeNode: HiveNode | undefined;
    heartbeats: Record<string, number | null>;
    focused: string;
    now: number;
    onFocus: (id: string) => void;
  } = $props();

  // ---------------------------------------------------------------- geometry
  // Fixed stage; the SVG scales into the dashboard shell. Matches the
  // standalone hive page's layout at the shell's ~2.7:1 aspect.
  const VBW = 1500;
  const VBH = 560;
  const RT = { cx: 375, cy: 296, r: 185 };
  const CM = { cx: 1095, cy: 296, r: 185 };
  const RT_ANGLES: Record<string, number> = { pendant: -90, mac: 15, extension: 90, ios: 195 };
  const NODE_NAME: Record<string, string> = {
    pendant: "Pendant",
    relay: "Cloud Relay",
    mac: "Mac Agent",
    extension: "Browser Extension",
    ios: "iOS App",
  };

  function polar(c: { cx: number; cy: number }, r: number, deg: number) {
    const a = (deg * Math.PI) / 180;
    return { x: c.cx + r * Math.cos(a), y: c.cy + r * Math.sin(a) };
  }
  function rtPos(id: string) {
    return id === "relay" ? { x: RT.cx, y: RT.cy } : polar(RT, RT.r, RT_ANGLES[id] ?? 0);
  }

  const runtimeIds = ["pendant", "relay", "mac", "extension", "ios"];
  const runtimeNodes = $derived(
    runtimeIds.map((id) => {
      const node = nodes.find((n) => n.id === id);
      const p = rtPos(id);
      const r = id === "relay" ? 42 : 34;
      return { id, p, r, node };
    }),
  );

  const edgeLines = $derived(
    edges.map((e) => {
      const p1 = rtPos(e.from);
      const p2 = rtPos(e.to);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = e.id === "ext-mac" ? 16 : 13;
      return { e, p1, p2, lx: mx - (dy / len) * off, ly: my + (dx / len) * off };
    }),
  );

  const cmPos = $derived(
    Object.fromEntries(
      committeeAgents.map((name, i) => {
        const ang = -90 + i * (360 / Math.max(1, committeeAgents.length));
        return [name, { ...polar(CM, CM.r, ang), ang }];
      }),
    ) as Record<string, { x: number; y: number; ang: number }>,
  );

  function labelAnchor(ang: number) {
    const cos = Math.cos((ang * Math.PI) / 180);
    return Math.abs(cos) < 0.35 ? "middle" : cos > 0 ? "start" : "end";
  }

  // ---------------------------------------------------------------- edge pulses
  // A change in lastActivityAt (after the first sighting) lights the edge up
  // for a moment. `seen` is deliberately non-reactive.
  const edgeSeen: Record<string, number> = {};
  let pulsing = $state<Record<string, boolean>>({});
  const pulseTimers: ReturnType<typeof setTimeout>[] = [];
  $effect(() => {
    for (const e of edges) {
      const act = e.lastActivityAt || 0;
      if (act && act !== edgeSeen[e.id]) {
        if (edgeSeen[e.id] !== undefined) {
          pulsing[e.id] = true;
          pulseTimers.push(
            setTimeout(() => {
              pulsing[e.id] = false;
            }, 2600),
          );
        }
        edgeSeen[e.id] = act;
      }
    }
  });

  // ---------------------------------------------------------------- message dots
  // New bulletin messages fly bright between committee agents; ambient replay
  // of recent ones flies dim, so the ring reads as a conversation, not a still.
  let msgLayer: SVGGElement | undefined = $state();
  let activeDots = 0;
  const bulletinSeen = new Set<string>();
  let bulletinPrimed = false;

  function spawnDot(p1: { x: number; y: number }, p2: { x: number; y: number }, live: boolean) {
    if (!msgLayer || activeDots > 36) return;
    const ns = "http://www.w3.org/2000/svg";
    const dot = document.createElementNS(ns, "circle");
    const trail = document.createElementNS(ns, "line");
    const color = live ? "var(--hv-committee)" : "#5d6c7e";
    dot.setAttribute("r", live ? "4.5" : "3");
    dot.setAttribute("fill", color);
    if (live) dot.setAttribute("filter", "drop-shadow(0 0 5px rgba(232,194,104,0.9))");
    trail.setAttribute("stroke", color);
    trail.setAttribute("stroke-linecap", "round");
    trail.setAttribute("stroke-width", live ? "1.6" : "1");
    trail.setAttribute("opacity", live ? "0.5" : "0.22");
    msgLayer.appendChild(trail);
    msgLayer.appendChild(dot);
    activeDots++;
    const t0 = performance.now();
    const dur = 1500;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bulge = Math.min(46, len * 0.18);
    const cx = mx - (dy / len) * bulge;
    const cy = my + (dx / len) * bulge;
    function step(t: number) {
      const u = (t - t0) / dur;
      if (u >= 1 || !msgLayer) {
        dot.remove();
        trail.remove();
        activeDots--;
        return;
      }
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const x = (1 - e) * (1 - e) * p1.x + 2 * (1 - e) * e * cx + e * e * p2.x;
      const y = (1 - e) * (1 - e) * p1.y + 2 * (1 - e) * e * cy + e * e * p2.y;
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      trail.setAttribute("x1", String(p1.x));
      trail.setAttribute("y1", String(p1.y));
      trail.setAttribute("x2", String(x));
      trail.setAttribute("y2", String(y));
      trail.setAttribute("opacity", String((live ? 0.5 : 0.22) * (1 - e * 0.7)));
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function animateMessage(from: string, to: string, live: boolean) {
    const positions = cmPos;
    if (!positions[from]) return;
    const targets =
      to === "all" ? committeeAgents.filter((a) => a !== from) : positions[to] ? [to] : [];
    targets.forEach((tgt, i) => {
      setTimeout(() => spawnDot(positions[from], positions[tgt], live && to !== "all"), i * 60);
    });
  }

  $effect(() => {
    const recent = bulletin?.recent;
    if (!Array.isArray(recent)) return;
    for (const m of recent) {
      if (m?.id == null || bulletinSeen.has(m.id)) continue;
      bulletinSeen.add(m.id);
      if (bulletinPrimed) animateMessage(m.from, m.to, true);
    }
    bulletinPrimed = true;
  });

  function ambientReplay() {
    const recent = bulletin?.recent;
    if (!Array.isArray(recent) || !recent.length || !committeeAgents.length) return;
    const m = recent[Math.floor(Math.random() * Math.min(recent.length, 40))];
    const to =
      m.to === "all"
        ? committeeAgents[Math.floor(Math.random() * committeeAgents.length)]
        : m.to;
    animateMessage(m.from, to, false);
  }

  onMount(() => {
    const replay = window.setInterval(ambientReplay, 8000);
    const first = window.setTimeout(ambientReplay, 1500);
    return () => {
      window.clearInterval(replay);
      window.clearTimeout(first);
      for (const t of pulseTimers) clearTimeout(t);
    };
  });

  // ---------------------------------------------------------------- derived text
  const committeeNewestRun = $derived.by(() => {
    let newest = 0;
    for (const name of committeeAgents) {
      const t = tsMs(orchestrator?.agents?.[name]?.lastRunAt);
      if (t && t > newest) newest = t;
    }
    return newest;
  });

  function agentHeat(name: string): "hot" | "warm" | "" {
    const last = tsMs(orchestrator?.agents?.[name]?.lastRunAt);
    if (!last) return "";
    const age = now - last;
    if (age < 15 * 60 * 1000) return "hot";
    if (age < 2 * 3600 * 1000) return "warm";
    return "";
  }

  function agentTitle(name: string): string {
    const a = orchestrator?.agents?.[name];
    if (!a) return `${name}\n(no orchestrator record)`;
    const last = tsMs(a.lastRunAt);
    return `${name}\nlast cycle ${a.lastCycle ?? "?"} · last run ${a.lastRunAt || "never"} (${last ? fmtAge(now - last) + " ago" : "—"})\n${a.seenCount} commons keys seen`;
  }
</script>

<svg
  class="hv-graph"
  viewBox="0 0 {VBW} {VBH}"
  preserveAspectRatio="xMidYMid meet"
  role="img"
  aria-label="Hive runtime and design rings"
>
  <text x={RT.cx} y="30" class="hv-ring-title" text-anchor="middle">RUNTIME RING</text>
  <text x={CM.cx} y="30" class="hv-ring-title" text-anchor="middle">DESIGN RING — COMMITTEE</text>
  <circle cx={RT.cx} cy={RT.cy} r={RT.r} class="hv-ring-guide" />
  <circle cx={CM.cx} cy={CM.cy} r={CM.r} class="hv-ring-guide" />

  <g>
    {#each edgeLines as { e, p1, p2, lx, ly } (e.id)}
      <line
        class="hv-edge"
        class:fresh={!!e.lastActivityAt && now - (e.lastActivityAt || 0) < 30000}
        class:pulse={!!pulsing[e.id]}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
      />
      <text class="hv-edge-label" x={lx} y={ly} text-anchor="middle">{e.label}</text>
    {/each}
  </g>

  <g>
    {#each runtimeNodes as { id, p, r, node } (id)}
      {@const col = HIVE_STATUS_COLOR[node?.status ?? "unknown"] || HIVE_STATUS_COLOR.unknown}
      {@const hb = heartbeats[id] ?? null}
      <g
        class="hv-rt-node"
        class:hot={node?.activityAt != null && now - node.activityAt < 12000}
        class:sel={focused === id}
        transform="translate({p.x},{p.y})"
        role="button"
        tabindex="0"
        aria-label="{NODE_NAME[id]}: {HIVE_STATUS_WORD[node?.status ?? 'unknown']}"
        onclick={() => onFocus(id)}
        onkeydown={(ev) => (ev.key === "Enter" || ev.key === " ") && onFocus(id)}
      >
        <title>{NODE_NAME[id]}: {HIVE_STATUS_WORD[node?.status ?? "unknown"]}
{node?.reason || ""}</title>
        <circle class="halo" r={r + 14} fill={col} style="filter: blur(6px)" />
        <circle class="body" {r} stroke={col} />
        <text class="tag" y="5">{HIVE_NODE_TAG[id]}</text>
        <text class="nlabel" y={id === "pendant" ? -(r + 24) : r + 20}>{NODE_NAME[id]}</text>
        <text class="nstatus" y={id === "pendant" ? -(r + 10) : r + 35} fill={col}
          >{HIVE_STATUS_WORD[node?.status ?? "unknown"]}{hb ? ` · ${fmtAge(now - hb)}` : ""}</text
        >
      </g>
    {/each}
  </g>

  <g>
    {#each committeeAgents as name (name)}
      {@const p = cmPos[name]}
      {@const lp = polar(CM, CM.r + 26, p.ang)}
      <g
        class="hv-cm-node {agentHeat(name)}"
        class:sel={focused === name}
        role="button"
        tabindex="0"
        aria-label="committee agent {name}"
        onclick={() => onFocus(name)}
        onkeydown={(ev) => (ev.key === "Enter" || ev.key === " ") && onFocus(name)}
      >
        <title>{agentTitle(name)}</title>
        <circle cx={p.x} cy={p.y} r="16" />
        <text x={lp.x} y={lp.y + 4} text-anchor={labelAnchor(p.ang)}>{name}</text>
      </g>
    {/each}
  </g>

  <text class="hv-cm-center big" x={CM.cx} y={CM.cy - 4} text-anchor="middle"
    >{bulletin ? `round ${bulletin.maxRound}` : "—"}</text
  >
  <text class="hv-cm-center" x={CM.cx} y={CM.cy + 16} text-anchor="middle"
    >{committeeNode
      ? `${HIVE_STATUS_WORD[committeeNode.status] || "?"}${committeeNewestRun ? ` · last cycle ${fmtAge(now - committeeNewestRun)} ago` : ""}${bulletin ? ` · ${bulletin.total} msgs` : ""}`
      : ""}</text
  >

  <g bind:this={msgLayer}></g>
</svg>
