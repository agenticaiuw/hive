<script lang="ts">
  /* eslint-disable @typescript-eslint/no-explicit-any -- aggregator records are schemaless */
  import {
    HIVE_STATUS_WORD,
    ageOf,
    fmtAge,
    tsMs,
    type HiveNode,
    type HiveSourceMeta,
  } from "$lib/hive";

  let {
    focused,
    node,
    src,
    meta,
    committeeAgents,
    now,
    liveBase,
  }: {
    focused: string;
    node: HiveNode | undefined;
    src: Record<string, any>;
    meta: Record<string, HiveSourceMeta>;
    committeeAgents: string[];
    now: number;
    /** Origin of the live aggregator when in LIVE mode; null in snapshot mode. */
    liveBase: string | null;
  } = $props();

  type FeedRow = {
    key: string;
    age: string;
    fresh?: boolean;
    typ: string;
    ok: boolean | null;
    msg: string;
    jobId?: string;
  };
  type Section = {
    title: string;
    err?: string;
    note?: string;
    kv?: { k: string; v: string }[];
    chips?: { text: string; title?: string }[];
    rows?: FeedRow[];
    runs?: {
      key: string;
      age: string;
      status: string;
      command: string;
      stages: { name: string; cls: string; title: string }[];
    }[];
    empty?: string;
  };

  function metaNote(key: string): { err?: string; note?: string } {
    const m = meta[key];
    if (!m) return { note: "not polled yet" };
    if (m.unsupported) return { note: `${m.label}: endpoint not available (HTTP 404)` };
    if (!m.ok) return { err: `${m.label} failed: ${m.error}` };
    return { note: `polled ${fmtAge(now - m.at)} ago · ${m.ms} ms` };
  }

  function age(ts: unknown): string {
    return ageOf(ts, now);
  }
  function freshAt(ts: unknown): boolean {
    const ms = tsMs(ts);
    return ms != null && now - ms < 12000;
  }

  const CANON_STAGES = [
    "transcription",
    "command",
    "agent",
    "tts",
    "relay_result",
    "device_downlink",
    "reply_downloaded",
    "device_playback",
  ];
  function stageChips(run: any) {
    const byStage: Record<string, string> = {};
    for (const ev of run.events || []) byStage[ev.stage] = ev.status;
    const extras = Object.keys(byStage).filter((s) => !CANON_STAGES.includes(s));
    return CANON_STAGES.concat(extras).map((s) => {
      const st = byStage[s];
      const cls =
        st == null
          ? ""
          : /done|completed|success/i.test(st)
            ? "done"
            : /error|fail/i.test(st)
              ? "error"
              : "active";
      return { name: s, cls, title: `${s}${st ? `: ${st}` : " (not reached)"}` };
    });
  }

  // ------------------------------------------------------------ per-node builders

  function buildMac(): Section[] {
    const s = src["agent.snapshot"];
    const o = src["agent.observe"];
    const c = src["agent.capabilities"];
    const j = src["agent.journal"];
    const jobs = src["agent.jobs"];
    const routines = src["agent.routines"];
    const facts = src["agent.memoryFacts"];
    const out: Section[] = [];

    const env: Section = { title: "ENVIRONMENT" };
    if (s) {
      env.kv = [
        {
          k: "machine",
          v: `${s.machine?.hostname ?? "—"} · ${s.machine?.platform ?? "—"} · ${s.machine?.appCount ?? "—"} apps · tz ${s.machine?.timezone ?? "—"}`,
        },
        {
          k: "agent",
          v: `${s.agent?.service ?? "—"} v${s.agent?.version ?? "?"} · full-control ${s.agent?.fullControlMode ? "on" : "off"} · llm planner ${s.agent?.llmPlannerEnabled ? "on" : "off"} · computer-use loop ${s.agent?.computerUse?.loopEnabled ? "on" : "off"} (max ${s.agent?.computerUse?.maxSteps ?? "—"} steps)`,
        },
        {
          k: "foreground",
          v: o?.foreground
            ? `${o.foreground.name} (${o.foreground.bundleId})${o.runningApps ? ` · ${o.runningApps.count} apps, ${o.runningApps.helperProcesses} helpers` : ""}`
            : (metaNote("agent.observe").err ?? metaNote("agent.observe").note ?? "—"),
        },
        {
          k: "project",
          v: s.workingProject ? `${s.workingProject.name} — ${s.workingProject.summary}` : "—",
        },
        {
          k: "store counts",
          v: s.counts
            ? Object.entries(s.counts)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ")
            : "—",
        },
      ];
    } else Object.assign(env, metaNote("agent.snapshot"));
    if (c) {
      env.chips = [
        { text: `routes ${c.routeCount}` },
        { text: `actions ${c.actionCount}` },
        ...(c.groups || [])
          .slice(0, 14)
          .map((g: any) => ({ text: `${g.group} ${g.routeCount}`, title: g.what })),
      ];
    }
    out.push(env);

    const journal: Section = { title: "TOOL CALLS — EXECUTION JOURNAL" };
    if (j) {
      const jm = metaNote("agent.journal");
      journal.note = `totals: ${j.totals ? `${j.totals.actions} actions · ${j.totals.wrote} wrote · ${j.totals.failed} failed` : "—"} · window ${j.window ? `${j.window.returned}/${j.window.jobsInStore} jobs` : ""} · ${jm.err ?? jm.note ?? ""}`;
      const acts: { at: number; row: FeedRow }[] = [];
      for (const e of j.entries || []) {
        for (const a of e.actions || []) {
          const ts = a.finishedAt || a.startedAt || e.finishedAt;
          acts.push({
            at: tsMs(ts) ?? 0,
            row: {
              key: `${e.jobId}:${a.seq}`,
              age: age(ts),
              fresh: freshAt(ts),
              typ: a.type,
              ok: a.ok ?? null,
              msg: `${a.effect || ""}${a.durationMs != null ? ` · ${a.durationMs}ms` : ""}${a.message ? ` · ${a.message}` : ""}${a.error ? ` · ${a.error}` : ""}${e.command ? ` — job: ${e.command}` : ""}`,
            },
          });
        }
      }
      acts.sort((x, y) => y.at - x.at);
      journal.rows = acts.slice(0, 40).map((x) => x.row);
      journal.empty = "journal returned no actions";
    } else Object.assign(journal, metaNote("agent.journal"));
    out.push(journal);

    const jobsSection: Section = {
      title: liveBase ? "JOBS (CLICK FOR RECEIPTS)" : "JOBS",
    };
    if (jobs) {
      jobsSection.rows = (jobs.jobs || []).slice(0, 15).map((jb: any) => ({
        key: jb.jobId,
        age: age(jb.updatedAt || jb.createdAt),
        fresh: freshAt(jb.updatedAt || jb.createdAt),
        typ: jb.type,
        ok: !/fail|error/i.test(jb.status),
        msg: `${jb.status} · ${jb.command || "(no command)"}${jb.actionCount != null ? ` · ${jb.actionCount} action(s)` : ""}${jb.error ? ` · ${jb.error}` : ""}`,
        jobId: liveBase ? jb.jobId : undefined,
      }));
      jobsSection.empty = "no jobs returned";
    } else Object.assign(jobsSection, metaNote("agent.jobs"));
    out.push(jobsSection);

    const routinesSection: Section = { title: "ROUTINES" };
    if (routines) {
      routinesSection.rows = (routines.routines || []).map((r: any) => {
        const nextAt = tsMs(r.nextRunAt);
        return {
          key: r.id,
          age: age(r.lastRunAt),
          typ: r.name,
          ok: r.lastStatus ? !/fail/i.test(r.lastStatus) : null,
          msg: `${r.schedule ? `${r.schedule.kind} ${r.schedule.at || ""}` : ""} · next in ${nextAt ? fmtAge(nextAt - now) : "—"} · ${r.runCount} runs${r.lastError ? ` · ${r.lastError}` : ""}`,
        };
      });
      routinesSection.empty = "no routines";
    } else Object.assign(routinesSection, metaNote("agent.routines"));
    out.push(routinesSection);

    const factsSection: Section = { title: "MEMORY FACTS (SECRET-LOOKING VALUES MASKED)" };
    if (facts) {
      factsSection.chips = Object.entries(facts.byKind || {}).map(([k, v]) => ({
        text: `${k} ${v}`,
      }));
      factsSection.rows = (facts.facts || []).slice(0, 12).map((f: any) => ({
        key: f.id,
        age: age(f.updatedAt),
        typ: f.key,
        ok: null,
        msg: `${f.masked ? "•••••• (masked)" : f.value} · ${f.kind} · conf ${f.confidence} · used ${f.useCount}×`,
      }));
    } else Object.assign(factsSection, metaNote("agent.memoryFacts"));
    out.push(factsSection);
    return out;
  }

  function buildRelay(): Section[] {
    const he = src["relay.health"];
    const devices = src["relay.devices"];
    const ops = src["relay.ops"];
    const out: Section[] = [];

    const env: Section = { title: "ENVIRONMENT — CLOUD RELAY" };
    if (he) {
      env.kv = [
        {
          k: "service",
          v: `${he.service} v${he.version} · ${he.platform} · store ${he.store}`,
        },
        {
          k: "mac bridge",
          v: `${he.macBridgeOnline ? "online" : "OFFLINE"} · last seen ${age(he.macBridgeLastSeen)} ago`,
        },
        {
          k: "models",
          v: he.models
            ? Object.entries(he.models)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")
            : "—",
        },
        {
          k: "capabilities",
          v: he.capabilities
            ? Object.entries(he.capabilities)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(" · ")
            : "—",
        },
      ];
    } else Object.assign(env, metaNote("relay.health"));
    out.push(env);

    const dev: Section = { title: "DEVICES" };
    if (devices) {
      dev.rows = (devices.devices || []).map((d: any) => ({
        key: d.deviceId,
        age: age(d.lastSeenAt),
        typ: d.deviceType,
        ok: !!d.online,
        msg: `${d.name} (${d.deviceId}) · registered ${d.registeredAt ? new Date(d.registeredAt).toLocaleDateString() : "—"}`,
      }));
      dev.empty = "no devices registered";
    } else Object.assign(dev, metaNote("relay.devices"));
    out.push(dev);

    const opsSection: Section = { title: "TOOL CALLS — VOICE RUNS (OPS HISTORY)" };
    if (ops) {
      opsSection.rows = (ops.entries || []).map((e: any) => ({
        key: e.pipelineId,
        age: age(e.updatedAt || e.createdAt),
        typ: e.kind,
        ok: !/fail|error/i.test(e.status),
        msg: `${e.status} (job ${e.jobStatus}) · ${e.origin}/${e.inputMode} · ${e.command || e.reply || "(no transcript)"}${e.error ? ` · ${e.error}` : ""}${e.actionCount ? ` · ${e.actionCount} action(s)` : ""}`,
      }));
      opsSection.empty = "no runs in recent history";
    } else Object.assign(opsSection, metaNote("relay.ops"));
    out.push(opsSection);
    return out;
  }

  function buildExtension(): Section[] {
    const status = src["agent.browserStatus"];
    const sessions = src["agent.browserSessions"];
    const spool = src["agent.browserSpool"];
    const jobs = src["agent.jobs"];
    const out: Section[] = [];

    const env: Section = { title: "ENVIRONMENT — SAFARI EXTENSION (VIA MAC AGENT)" };
    if (status) {
      env.kv = [
        {
          k: "online",
          v: `${status.online ? "yes" : "NO"} · ${status.pendingCommands} pending command(s)`,
        },
        ...(status.devices || []).map((d: any) => ({
          k: "device",
          v: `${d.deviceName} · ext v${d.extensionVersion} · last poll ${age(d.lastSeenAt)} ago · ${d.tabCount} tab(s)`,
        })),
      ];
    } else Object.assign(env, metaNote("agent.browserStatus"));
    out.push(env);

    const named: Section = { title: "NAMED SESSIONS" };
    if (sessions) {
      named.rows = (sessions.sessions || []).map((s: any) => ({
        key: s.id,
        age: age(s.lastUsedAt),
        typ: s.id,
        ok: null,
        msg: `${s.lastAction || ""} · ${s.title || s.url || ""}`,
      }));
      named.empty = "no named sessions";
    } else Object.assign(named, metaNote("agent.browserSessions"));
    out.push(named);

    const browserJobs: Section = { title: "RECENT BROWSER JOBS" };
    browserJobs.rows = (jobs?.jobs || [])
      .filter((j: any) => String(j.type || "").includes("browser"))
      .slice(0, 15)
      .map((j: any) => ({
        key: j.jobId,
        age: age(j.updatedAt || j.createdAt),
        typ: j.type,
        ok: !/fail|error/i.test(j.status),
        msg: `${j.status} · ${j.command || ""}`,
      }));
    browserJobs.empty = "no browser-typed jobs in the recent window";
    out.push(browserJobs);

    const spoolSection: Section = { title: "SPOOL — LOST COMMANDS (WITH REASONS)" };
    if (spool) {
      spoolSection.note = `${spool.total} total spooled`;
      spoolSection.rows = (spool.entries || []).slice(0, 12).map((e: any) => ({
        key: e.commandId,
        age: age(e.spooledAt),
        typ: e.type || "command",
        ok: false,
        msg: `${e.reason} · ${e.detail || ""} · ${e.attempts} attempt(s)`,
      }));
      spoolSection.empty = "spool is empty";
    } else Object.assign(spoolSection, metaNote("agent.browserSpool"));
    out.push(spoolSection);
    return out;
  }

  function buildPendant(): Section[] {
    const devices = src["relay.devices"];
    const ops = src["relay.ops"];
    const pipeline = src["agent.pipeline"];
    const out: Section[] = [];

    const dev: Section = { title: "DEVICE (VIA RELAY)" };
    if (devices) {
      const rows = (devices.devices || []).filter((d: any) =>
        /pendant|wearable|nrf|mobile|mac_bridge/i.test(`${d.deviceType}`),
      );
      dev.rows = rows.map((d: any) => ({
        key: d.deviceId,
        age: age(d.lastSeenAt),
        typ: d.deviceType,
        ok: !!d.online,
        msg: `${d.name} (${d.deviceId})`,
      }));
      dev.empty = "no pendant-class device registered on the relay — status honest-unknown";
    } else Object.assign(dev, metaNote("relay.devices"));
    out.push(dev);

    const voice: Section = { title: "VOICE RUNS FROM THE DEVICE (live_lte / microsd)" };
    if (ops) {
      voice.rows = (ops.entries || [])
        .filter((e: any) => /live_lte|microsd/i.test(String(e.origin)))
        .map((e: any) => ({
          key: e.pipelineId,
          age: age(e.updatedAt || e.createdAt),
          typ: e.origin,
          ok: !/fail|error/i.test(e.status),
          msg: `${e.status} · ${e.command || e.reply || "(no transcript)"}${e.audioAvailable ? " · audio saved" : ""}`,
        }));
      voice.empty = "no device-origin runs in recent ops history";
    } else Object.assign(voice, metaNote("relay.ops"));
    out.push(voice);

    const trace: Section = { title: "UTTERANCE TRACE — PIPELINE STAGES PER RUN" };
    if (pipeline) {
      trace.runs = (pipeline.runs || []).slice(0, 5).map((run: any) => ({
        key: run.pipelineId,
        age: age(run.updatedAt || run.createdAt),
        status: run.status,
        command: run.command || run.kind || "",
        stages: stageChips(run),
      }));
      trace.empty = "no pipeline runs";
    } else Object.assign(trace, metaNote("agent.pipeline"));
    out.push(trace);
    return out;
  }

  function buildIos(): Section[] {
    const devices = src["relay.devices"];
    const out: Section[] = [];
    out.push({
      title: "ENVIRONMENT",
      kv: [
        {
          k: "architecture",
          v: "iOS app is a Capacitor web shell that live-loads the deployed dashboard; it has no dedicated telemetry endpoint.",
        },
      ],
    });
    const dev: Section = { title: "MOBILE DEVICE ROWS (VIA RELAY)" };
    if (devices) {
      dev.rows = (devices.devices || [])
        .filter((d: any) => d.deviceType === "mobile")
        .map((d: any) => ({
          key: d.deviceId,
          age: age(d.lastSeenAt),
          typ: "mobile",
          ok: !!d.online,
          msg: `${d.name} (${d.deviceId}) · registered ${d.registeredAt ? new Date(d.registeredAt).toLocaleDateString() : "—"}`,
        }));
      dev.empty = "relay reports no mobile devices";
    } else Object.assign(dev, metaNote("relay.devices"));
    out.push(dev);
    return out;
  }

  function buildCommittee(): Section[] {
    const orch = src["committee.orchestrator"];
    const ledger = src["committee.ledger"];
    const commons = src["committee.commons"];
    const bulletin = src["committee.bulletin"];
    const out: Section[] = [];

    const live: Section = { title: "ORCHESTRATOR — AGENT LIVENESS" };
    if (orch) {
      live.rows = Object.entries(orch.agents || {}).map(([name, a]: [string, any]) => ({
        key: name,
        age: age(a.lastRunAt),
        typ: name,
        ok: null,
        msg: `cycle ${a.lastCycle ?? "—"} · ${a.seenCount} commons keys seen`,
      }));
    } else Object.assign(live, metaNote("committee.orchestrator"));
    out.push(live);

    const led: Section = { title: "LEDGER" };
    if (ledger) {
      led.chips = [
        ...Object.entries(ledger.counts || {}).map(([k, v]) => ({ text: `${k} ${v}` })),
        { text: `total ${ledger.total}` },
      ];
    } else Object.assign(led, metaNote("committee.ledger"));
    out.push(led);

    const dep: Section = { title: "TOOL CALLS — COMMONS DEPOSITS" };
    if (commons) {
      dep.rows = (commons.tail || []).slice(0, 18).map((c: any, i: number) => ({
        key: `${c.hash}:${c.at}:${i}`,
        age: age(c.at),
        typ: c.tool,
        ok: !c.absent,
        msg: `${c.agent} r${c.round} · ${c.key} · ${c.bytes ?? "?"}B · ${c.summary || ""}`,
      }));
      dep.empty = "no deposits in the current tail";
    } else Object.assign(dep, metaNote("committee.commons"));
    out.push(dep);

    const bul: Section = { title: "BULLETIN — LATEST INTER-AGENT MESSAGES" };
    if (bulletin) {
      bul.rows = (bulletin.recent || [])
        .slice(-15)
        .reverse()
        .map((m: any) => ({
          key: m.id,
          age: `r${m.round}`,
          typ: `${m.from}→${m.to}`,
          ok: null,
          msg: `${m.subject}: ${m.body}`,
        }));
    } else Object.assign(bul, metaNote("committee.bulletin"));
    out.push(bul);
    return out;
  }

  function buildAgent(name: string): Section[] {
    const orch = src["committee.orchestrator"]?.agents?.[name] ?? null;
    const bulletin = src["committee.bulletin"];
    const commons = src["committee.commons"];
    const out: Section[] = [];
    out.push({
      title: `COMMITTEE AGENT — ${name}`,
      ...(orch
        ? {
            kv: [
              {
                k: "last run",
                v: `${age(orch.lastRunAt)} ago (cycle ${orch.lastCycle ?? "—"})`,
              },
              { k: "commons keys seen", v: String(orch.seenCount) },
            ],
          }
        : { note: "no orchestrator record" }),
    });
    out.push({
      title: "DEPOSITS BY THIS AGENT (COMMONS TAIL)",
      rows: (commons?.tail || [])
        .filter((d: any) => d.agent === name)
        .slice(0, 20)
        .map((c: any, i: number) => ({
          key: `${c.hash}:${i}`,
          age: age(c.at),
          typ: c.tool,
          ok: !c.absent,
          msg: `r${c.round} · ${c.key} · ${c.summary || ""}`,
        })),
      empty: "none in the current tail",
    });
    out.push({
      title: "MESSAGES INVOLVING THIS AGENT",
      rows: (bulletin?.recent || [])
        .filter((m: any) => m.from === name || m.to === name || m.to === "all")
        .slice(-30)
        .reverse()
        .map((m: any) => ({
          key: m.id,
          age: `r${m.round}`,
          typ: `${m.from}→${m.to}`,
          ok: null,
          msg: `${m.subject}: ${m.body}`,
        })),
      empty: "none in the recent window",
    });
    return out;
  }

  const sections = $derived.by<Section[]>(() => {
    switch (focused) {
      case "mac":
        return buildMac();
      case "relay":
        return buildRelay();
      case "extension":
        return buildExtension();
      case "pendant":
        return buildPendant();
      case "ios":
        return buildIos();
      case "committee":
        return buildCommittee();
      default:
        if (committeeAgents.includes(focused)) return buildAgent(focused);
        return [{ title: "NODE", err: `unknown node id: ${focused}` }];
    }
  });

  const headLabel = $derived(
    (node?.label || (committeeAgents.includes(focused) ? focused : focused)).toUpperCase(),
  );

  // ------------------------------------------------------------ receipts (LIVE only)
  let receipts = $state<
    Record<string, { open: boolean; loading: boolean; error: string; data: any }>
  >({});

  async function toggleReceipts(jobId: string) {
    if (!liveBase) return;
    const cur = receipts[jobId];
    if (cur?.open) {
      receipts[jobId] = { ...cur, open: false };
      return;
    }
    receipts[jobId] = { open: true, loading: true, error: "", data: cur?.data ?? null };
    if (cur?.data) {
      receipts[jobId] = { ...receipts[jobId], loading: false };
      return;
    }
    try {
      const response = await fetch(
        `${liveBase}/api/node/mac?job=${encodeURIComponent(jobId)}`,
        { cache: "no-store" },
      );
      const payload: any = await response.json();
      if (!payload.receipts?.ok) {
        throw new Error(payload.receipts?.error || "receipts fetch failed");
      }
      receipts[jobId] = {
        open: true,
        loading: false,
        error: "",
        data: payload.receipts.receipts,
      };
    } catch (error) {
      receipts[jobId] = {
        open: true,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        data: null,
      };
    }
  }
</script>

<div class="hv-panel">
  <div class="hv-phead">
    <h2>{headLabel}</h2>
    {#if node}
      <span class="hv-st hv-st-{node.status}">{HIVE_STATUS_WORD[node.status] || "?"}</span>
      <span class="hv-reason" title={node.reason}>{node.reason}</span>
    {/if}
  </div>
  <div class="hv-pbody">
    {#each sections as section (section.title)}
      <div class="hv-sect">
        <h3>{section.title}</h3>
        {#if section.err}
          <span class="hv-err">{section.err}</span>
        {:else}
          {#if section.note}<div class="hv-mut hv-sect-note">{section.note}</div>{/if}
          {#if section.kv}
            <dl class="hv-kv">
              {#each section.kv as pair (pair.k + pair.v)}
                <dt>{pair.k}</dt>
                <dd>{pair.v}</dd>
              {/each}
            </dl>
          {/if}
          {#if section.chips}
            <div class="hv-chiprow">
              {#each section.chips as chip (chip.text)}
                <span class="hv-chip" title={chip.title || chip.text}>{chip.text}</span>
              {/each}
            </div>
          {/if}
          {#if section.rows}
            {#if section.rows.length}
              <div class="hv-feed">
                {#each section.rows as row (row.key)}
                  {#if row.jobId}
                    <button
                      class="hv-frow hv-jobrow"
                      onclick={() => toggleReceipts(row.jobId!)}
                      title={row.msg}
                    >
                      <span class="hv-frow-age" class:fresh={row.fresh}>{row.age}</span>
                      <span class="hv-frow-typ">{row.typ}</span>
                      {#if row.ok != null}<span class={row.ok ? "hv-ok" : "hv-bad"}
                          >{row.ok ? "ok" : "FAIL"}</span
                        >{/if}
                      <span class="hv-frow-msg">{row.msg}</span>
                    </button>
                    {#if receipts[row.jobId]?.open}
                      <div class="hv-receipts">
                        {#if receipts[row.jobId].loading}
                          <span class="hv-mut">fetching receipts…</span>
                        {:else if receipts[row.jobId].error}
                          <span class="hv-err">{receipts[row.jobId].error}</span>
                        {:else}
                          {@const rc = receipts[row.jobId].data}
                          <div class="hv-mut">
                            {rc.status} · {rc.counts
                              ? `${rc.counts.total} action(s), ${rc.counts.wrote} wrote, ${rc.counts.reversible} reversible`
                              : ""} · undo: {rc.undo?.canUndo
                              ? "possible"
                              : rc.undo?.reason || "n/a"}
                          </div>
                          {#each rc.receipts || [] as x, i (i)}
                            <div>
                              · <b>{x.type}</b>
                              {x.status}
                              <span class="hv-mut"
                                >{x.durationMs ?? "—"} ms · effect {x.effect ?? "?"}{x.irreversibleReason
                                  ? ` · ${x.irreversibleReason}`
                                  : ""}</span
                              >
                            </div>
                          {/each}
                        {/if}
                      </div>
                    {/if}
                  {:else}
                    <div class="hv-frow" title={row.msg}>
                      <span class="hv-frow-age" class:fresh={row.fresh}>{row.age}</span>
                      <span class="hv-frow-typ">{row.typ}</span>
                      {#if row.ok != null}<span class={row.ok ? "hv-ok" : "hv-bad"}
                          >{row.ok ? "ok" : "FAIL"}</span
                        >{/if}
                      <span class="hv-frow-msg">{row.msg}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            {:else if section.empty}
              <span class="hv-mut">{section.empty}</span>
            {/if}
          {/if}
          {#if section.runs}
            {#if section.runs.length}
              {#each section.runs as run (run.key)}
                <div class="hv-run">
                  <div class="hv-run-head">
                    <span class="hv-frow-age">{run.age}</span>
                    <span class="hv-frow-typ">{run.status}</span>
                    <span class="hv-frow-msg" title={run.command}>{run.command}</span>
                  </div>
                  <div>
                    {#each run.stages as stage (stage.name)}
                      <span class="hv-stagechip {stage.cls}" title={stage.title}
                        >{stage.name}</span
                      >
                    {/each}
                  </div>
                </div>
              {/each}
            {:else if section.empty}
              <span class="hv-mut">{section.empty}</span>
            {/if}
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>
