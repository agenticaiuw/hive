"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- Relay records are schemaless at this display boundary. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type JsonRecord = Record<string, any>;

const STAGES = [
  { id: "transcription", label: "Speech → text" },
  { id: "agent", label: "Agent + LLM" },
  { id: "tts", label: "Text → speech" },
  { id: "relay_result", label: "Cloud handoff" },
  { id: "reply_downloaded", label: "nRF download" },
  { id: "playback", label: "I²S playback" },
];

function hasUsefulTranscript(value: unknown) {
  return /[\p{L}\p{N}]/u.test(String(value || ""));
}

function isTranscribing(run: JsonRecord | null) {
  return Boolean(
    run?.events?.some(
      (event: JsonRecord) =>
        event.stage === "transcription" &&
        ["active", "waiting"].includes(event.status),
    ),
  );
}

function bytes(value: unknown) {
  const amount = Number(value || 0);
  if (!amount) return "—";
  if (amount < 1024) return `${amount} B`;
  return `${(amount / 1024).toFixed(1)} KiB`;
}

function duration(value: unknown) {
  const ms = Number(value || 0);
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function clock(value: unknown) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(String(value)));
}

function stageState(run: JsonRecord | null, stageId: string) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const matches = events.filter((event: JsonRecord) => {
    if (stageId === "playback") {
      return [
        "playback",
        "playback_started",
        "playback_complete",
        "device_playback",
      ].includes(event.stage);
    }
    return event.stage === stageId;
  });
  if (!matches.length) return "waiting";
  if (matches.some((event: JsonRecord) => event.status === "failed")) {
    return "failed";
  }
  if (matches.some((event: JsonRecord) => event.status === "active")) {
    const last = matches[matches.length - 1];
    if (last.status === "active") return "active";
  }
  if (
    stageId === "transcription" &&
    !hasUsefulTranscript(run?.command)
  ) {
    return "failed";
  }
  return "done";
}

function displayCommand(run: JsonRecord) {
  if (isTranscribing(run)) return "Transcribing new recording…";
  if (!hasUsefulTranscript(run.command)) return "Unrecognized audio";
  return run.command;
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<JsonRecord | null>(null);
  const [liveRuns, setLiveRuns] = useState<JsonRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const snapshotRefreshPending = useRef(false);
  const runsRefreshPending = useRef(false);
  const latestRunKey = useRef("");

  const refresh = useCallback(async () => {
    if (snapshotRefreshPending.current) return;
    snapshotRefreshPending.current = true;
    setRefreshing(true);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Dashboard refresh failed (${response.status})`);
      }
      setSnapshot(payload);
      setError("");
      setSelectedId((current) => {
        const runs = Array.isArray(payload.pipeline) ? payload.pipeline : [];
        return current && runs.some((run: JsonRecord) => run.pipelineId === current)
          ? current
          : runs[0]?.pipelineId || "";
      });
    } catch (refreshError) {
      if (
        refreshError instanceof Error &&
        refreshError.message.includes(
          "Superseded by a newer dashboard snapshot request",
        )
      ) {
        return;
      }
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Dashboard refresh failed.",
      );
    } finally {
      snapshotRefreshPending.current = false;
      setRefreshing(false);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    if (runsRefreshPending.current) return;
    runsRefreshPending.current = true;
    try {
      const response = await fetch("/api/runs", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          payload.error || `Voice-run refresh failed (${response.status})`,
        );
      }
      const nextRuns = Array.isArray(payload.runs) ? payload.runs : [];
      setLiveRuns(nextRuns);
      setSelectedId((current) =>
        current &&
        nextRuns.some((run: JsonRecord) => run.pipelineId === current)
          ? current
          : nextRuns[0]?.pipelineId || current,
      );
    } catch {
      // The slower full snapshot remains available if the direct feed blips.
    } finally {
      runsRefreshPending.current = false;
    }
  }, []);

  const checkLatest = useCallback(async () => {
    try {
      const response = await fetch("/api/runs/latest", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) return;
      const latest = payload.latest;
      const key = latest
        ? `${latest.pipelineId}|${latest.status}|${latest.updatedAt}`
        : "";
      if (key !== latestRunKey.current) {
        latestRunKey.current = key;
        void refreshRuns();
        void refresh();
      }
    } catch {
      // Freshness probe is best-effort; the timed refreshes still run.
    }
  }, [refresh, refreshRuns]);

  useEffect(() => {
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const initial = window.setTimeout(refreshRuns, 0);
    const probe = window.setInterval(checkLatest, 500);
    const backstop = window.setInterval(refreshRuns, 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(probe);
      window.clearInterval(backstop);
    };
  }, [refreshRuns, checkLatest]);

  const snapshotRuns = Array.isArray(snapshot?.pipeline) ? snapshot.pipeline : [];
  const runs = liveRuns.length ? liveRuns : snapshotRuns;
  const selected =
    runs.find((run: JsonRecord) => run.pipelineId === selectedId) ??
    runs[0] ??
    null;
  const cloud = snapshot?.cloud ?? {};
  const agent = snapshot?.status?.agent ?? {};
  const telemetry = useMemo(() => {
    const event = selected?.events?.find(
      (candidate: JsonRecord) => candidate.stage === "transcription",
    );
    return event?.meta?.inputTelemetry ?? null;
  }, [selected]);
  const selectedTranscribing = isTranscribing(selected);
  const badTranscript =
    selected && !selectedTranscribing && !hasUsefulTranscript(selected.command);
  const newestRun = runs[0] ?? null;
  const newestTranscribing = isTranscribing(newestRun);
  const latestBad =
    newestRun && !newestTranscribing && !hasUsefulTranscript(newestRun.command);
  const latestMacAction = Array.isArray(snapshot?.logs)
    ? snapshot.logs[0]
    : null;
  const permissions = agent.permissions ?? {};
  const browserExtension = agent.browserExtension ?? {};
  const automationEntries = Object.entries(
    permissions.automation ?? {},
  ) as [string, JsonRecord][];
  const grantedAutomation = automationEntries.filter(
    ([, result]) => result.granted,
  ).length;
  const requiredMissing = Array.isArray(permissions.requiredMissing)
    ? permissions.requiredMissing
    : [];
  const activity = Array.isArray(snapshot?.activity)
    ? snapshot.activity.slice(0, 6)
    : [];
  const sharedProduct = snapshot?.product ?? {};
  const sharedSessions = Array.isArray(sharedProduct.sessions)
    ? sharedProduct.sessions
    : [];
  const memoryEntities = Array.isArray(sharedProduct.memory?.entities)
    ? sharedProduct.memory.entities
    : [];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div>
            <p className="kicker">AI Pendant</p>
            <h1>Mission Control</h1>
          </div>
        </div>
        <div className="status-cluster" aria-label="System status">
          <StatusPill label="Cloudflare" online={Boolean(cloud.ok)} />
          <StatusPill label="Mac bridge" online={Boolean(cloud.macBridgeOnline)} />
          <StatusPill
            label={latestBad ? "Mic needs attention" : "Mic input"}
            online={!latestBad}
            warning={Boolean(latestBad)}
          />
          <StatusPill
            label="Browser"
            online={Boolean(browserExtension.online)}
          />
          <button className="refresh-button" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Updating…" : "Refresh"}
          </button>
          <form action="/api/auth/logout" method="post">
            <button className="logout-button" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="hero-grid">
        <article className={`hero-card ${latestBad ? "has-alert" : ""}`}>
          <div className="hero-copy">
            <p className="kicker">Latest hardware request</p>
            <h2>
              {newestRun ? displayCommand(newestRun) : "Waiting for the pendant"}
            </h2>
            {latestBad ? (
              <>
                <p className="diagnosis">
                  Audio reached Cloudflare, but speech recognition returned only
                  punctuation. “Open Finder” never reached the Mac.
                </p>
                <div className="signal-callout">
                  <span>Input failure</span>
                  <strong>Recording received · speech not detected</strong>
                </div>
              </>
            ) : (
              <p className="diagnosis">
                {newestRun
                  ? "The command is moving through the live pendant pipeline."
                  : "Press the pendant button and speak to begin a run."}
              </p>
            )}
          </div>
          <div className="hero-metrics">
            <Metric label="Recorded audio" value={bytes(
              newestRun?.events?.find((event: JsonRecord) => event.stage === "transcription")
                ?.meta?.inputTelemetry?.audioBytes,
            )} />
            <Metric label="Duration" value={duration(
              newestRun?.events?.find((event: JsonRecord) => event.stage === "transcription")
                ?.meta?.inputTelemetry?.durationMs,
            )} />
            <Metric label="Last seen" value={clock(newestRun?.updatedAt)} />
          </div>
        </article>

        <aside className="system-card">
          <div className="section-heading">
            <div>
              <p className="kicker">Live system</p>
              <h3>Cloud ↔ home Mac</h3>
            </div>
            <span className={`pulse ${cloud.macBridgeOnline ? "online" : ""}`} />
          </div>
          <dl className="system-list">
            <SystemRow label="Relay" value={cloud.ok ? "Cloudflare Worker online" : "Offline"} />
            <SystemRow label="Queue" value={cloud.store === "d1" ? "D1 persistent queue" : cloud.store || "—"} />
            <SystemRow
              label="Transcription"
              value={
                cloud.speechToTextConfigured
                  ? cloud.models?.speechToText || "Workers AI ready"
                  : "Unavailable"
              }
            />
            <SystemRow
              label="Text to speech"
              value={cloud.models?.textToSpeech || "macOS say · 24 kHz PCM"}
            />
            <SystemRow label="Mac bridge" value={cloud.macBridgeOnline ? "Connected" : "Disconnected"} />
            <SystemRow label="Local agent" value={agent.ok ? `v${agent.version}` : "Unavailable"} />
            <SystemRow
              label="Latest Mac action"
              value={
                latestMacAction
                  ? `${latestMacAction.command} · ${latestMacAction.status}`
                  : "No activity yet"
              }
            />
          </dl>
        </aside>
      </section>

      <section className="agent-overview" aria-label="Mac agent status">
        <article className="agent-card">
          <div className="section-heading">
            <div>
              <p className="kicker">Mac agent</p>
              <h3>Device permissions</h3>
            </div>
            <span className={`pulse ${permissions.ready ? "online" : ""}`} />
          </div>
          <dl className="system-list">
            <SystemRow
              label="Accessibility"
              value={permissions.accessibility?.trusted ? "Allowed" : "Missing"}
            />
            <SystemRow
              label="Screen recording"
              value={permissions.screenRecording?.granted ? "Allowed" : "Missing"}
            />
            <SystemRow
              label="Automation"
              value={
                automationEntries.length
                  ? `${grantedAutomation}/${automationEntries.length} allowed`
                  : "Not checked"
              }
            />
            <SystemRow
              label="Host identity"
              value={agent.hostApp || "Unavailable"}
            />
          </dl>
          {requiredMissing.length ? (
            <p className="agent-warning">
              Still needed: {requiredMissing.join(", ")}
            </p>
          ) : permissions.ready ? (
            <p className="agent-ready">All required Mac permissions are ready.</p>
          ) : null}
        </article>

        <article className="agent-card">
          <div className="section-heading">
            <div>
              <p className="kicker">Browser bridge</p>
              <h3>
                {browserExtension.online
                  ? "Extension connected"
                  : "Waiting for extension"}
              </h3>
            </div>
            <span
              className={`pulse ${browserExtension.online ? "online" : ""}`}
            />
          </div>
          <dl className="system-list">
            <SystemRow
              label="Status"
              value={browserExtension.online ? "Online" : "Offline"}
            />
            <SystemRow
              label="Connected browsers"
              value={String(browserExtension.connectedDevices ?? 0)}
            />
            <SystemRow
              label="Pending commands"
              value={String(browserExtension.pendingCommands ?? 0)}
            />
            <SystemRow
              label="Last heartbeat"
              value={clock(browserExtension.lastSeenAt)}
            />
          </dl>
        </article>

        <article className="agent-card activity-card">
          <div className="section-heading">
            <div>
              <p className="kicker">Local activity</p>
              <h3>Recent Mac agent logs</h3>
            </div>
            <span className="activity-count">{activity.length}</span>
          </div>
          {activity.length ? (
            <ol className="activity-list">
              {activity.map((entry: JsonRecord) => (
                <li key={entry.id}>
                  <span
                    className={`activity-dot ${
                      entry.status === "failed" ? "failed" : ""
                    }`}
                  />
                  <div>
                    <strong>{entry.command || entry.summary || "Agent activity"}</strong>
                    <small>
                      {entry.status || "complete"} · {clock(entry.createdAt)}
                    </small>
                    {entry.error ? <p>{entry.error}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="agent-empty">
              No synced Mac activity yet. New actions will appear here.
            </p>
          )}
        </article>
      </section>

      <section className="shared-data" aria-label="Shared cloud data">
        <div className="shared-data-heading">
          <div>
            <p className="kicker">Shared cloud data</p>
            <h2>One history across Mac, web, and iPhone</h2>
          </div>
          <span className="revision-badge">
            D1 revision {sharedProduct.revision ?? 0}
          </span>
        </div>
        <div className="shared-data-grid">
          <article className="shared-data-card">
            <div className="section-heading">
              <div>
                <p className="kicker">Chats</p>
                <h3>{sharedSessions.length} synchronized sessions</h3>
              </div>
            </div>
            {sharedSessions.length ? (
              <ol className="shared-record-list">
                {sharedSessions.slice(0, 6).map((session: JsonRecord) => (
                  <li key={session.sessionId}>
                    <div>
                      <strong>{session.title || "Untitled session"}</strong>
                      <small>
                        {session.turns?.length ?? 0} recent turns ·{" "}
                        {clock(session.updatedAt)}
                      </small>
                    </div>
                    <span>{session.sessionId?.slice(0, 8)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="agent-empty">
                No synchronized sessions yet. New conversations will persist
                here after the Mac bridge publishes them.
              </p>
            )}
          </article>

          <article className="shared-data-card">
            <div className="section-heading">
              <div>
                <p className="kicker">Memory</p>
                <h3>{memoryEntities.length} synchronized entities</h3>
              </div>
            </div>
            {memoryEntities.length ? (
              <ol className="shared-record-list">
                {memoryEntities.slice(0, 6).map((entity: JsonRecord) => (
                  <li key={entity.id}>
                    <div>
                      <strong>{entity.name || "Untitled memory"}</strong>
                      <small>
                        {entity.type || "Memory"} · {clock(entity.updatedAt)}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="agent-empty">
                Memory is empty. Facts captured by the local agent will appear
                here and remain available on every signed-in device.
              </p>
            )}
          </article>
        </div>
      </section>

      <section className="workspace">
        <aside className="run-rail">
          <div className="section-heading">
            <div>
              <p className="kicker">Voice runs</p>
              <h3>{runs.length} recent</h3>
            </div>
          </div>
          <div className="run-list">
            {runs.map((run: JsonRecord) => {
              const transcribing = isTranscribing(run);
              const unreadable =
                !transcribing && !hasUsefulTranscript(run.command);
              return (
                <button
                  key={run.pipelineId}
                  className={`run-row ${run.pipelineId === selected?.pipelineId ? "selected" : ""}`}
                  onClick={() => setSelectedId(run.pipelineId)}
                >
                  <span className={`run-status ${unreadable ? "failed" : run.status}`} />
                  <span>
                    <strong>{displayCommand(run)}</strong>
                    <small>
                      {transcribing
                        ? "Transcribing"
                        : unreadable
                          ? "Speech not detected"
                          : run.status}{" "}
                      · {clock(run.createdAt)}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <article className="trace-panel">
          {selected ? (
            <>
              <div className="trace-head">
                <div>
                  <p className="kicker">Pipeline trace</p>
                  <h2>{displayCommand(selected)}</h2>
                  <p className="trace-id">{selected.pipelineId}</p>
                </div>
                <span className={`state-badge ${badTranscript ? "failed" : selected.status}`}>
                  {badTranscript ? "input failed" : selected.status}
                </span>
              </div>

              <div className="stage-map">
                {STAGES.map((stage) => (
                  <div key={stage.id} className={`stage ${stageState(selected, stage.id)}`}>
                    <span />
                    <strong>{stage.label}</strong>
                  </div>
                ))}
              </div>

              <section className="telemetry-card">
                <div>
                  <p className="kicker">Recorded input</p>
                  <h3>
                    {selectedTranscribing
                      ? "Audio received by Cloudflare"
                      : badTranscript
                        ? "Audio present, speech missing"
                        : "Microphone telemetry"}
                  </h3>
                </div>
                <div className="telemetry-grid">
                  <Metric label="Payload" value={bytes(telemetry?.audioBytes)} />
                  <Metric label="Duration" value={duration(telemetry?.durationMs)} />
                  <Metric label="Sample rate" value={telemetry?.sampleRate ? `${telemetry.sampleRate.toLocaleString()} Hz` : "—"} />
                  <Metric label="Format" value={telemetry?.format || "—"} />
                  <Metric label="Storage" value={telemetry?.storage || "—"} />
                  <Metric label="Input gain" value={telemetry?.inputGainDb != null ? `+${telemetry.inputGainDb} dB` : "—"} />
                  <Metric label="Transcript" value={selected.command || "empty"} />
                </div>
              </section>

              <ol className="event-list">
                {(selected.events ?? []).map((event: JsonRecord, index: number) => (
                  <li key={event.eventId || `${event.stage}-${index}`}>
                    <div className={`event-index ${event.status}`}>{index + 1}</div>
                    <div className="event-copy">
                      <div className="event-title">
                        <span>{event.stage?.replaceAll("_", " ")}</span>
                        <time>{clock(event.at)}</time>
                      </div>
                      <strong>{event.label}</strong>
                      <p>{event.detail}</p>
                      {event.text ? <blockquote>{event.text}</blockquote> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="empty-state">
              <p className="kicker">Pipeline trace</p>
              <h2>No pendant runs yet</h2>
              <p>The first recording will appear here automatically.</p>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

function StatusPill({
  label,
  online,
  warning = false,
}: {
  label: string;
  online: boolean;
  warning?: boolean;
}) {
  return (
    <span className={`status-pill ${warning ? "warning" : online ? "online" : "offline"}`}>
      <i />
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SystemRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
