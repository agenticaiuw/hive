"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- Relay records are schemaless at this display boundary. */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";

type JsonRecord = Record<string, any>;

const STAGES = [
  { id: "transcription", short: "STT", label: "Speech to text" },
  { id: "agent", short: "AGENT", label: "Agent + LLM" },
  { id: "tts", short: "TTS", label: "Text to speech" },
  { id: "relay_result", short: "RELAY", label: "Cloud handoff" },
  { id: "reply_downloaded", short: "NRF", label: "nRF download" },
  { id: "playback", short: "PLAY", label: "I²S playback" },
];

// A command sent from a browser stops at the Mac; the pendant stages would
// sit unlit forever, reading as a stalled run.
const DASHBOARD_STAGES = STAGES.slice(0, 2);

function stagesFor(run: JsonRecord | null) {
  return runOrigin(run) === "dashboard" ? DASHBOARD_STAGES : STAGES;
}

function runOrigin(run: JsonRecord | null) {
  const direct = String(run?.origin || "");
  if (direct) return direct;
  const events = Array.isArray(run?.events) ? run.events : [];
  for (const event of events) {
    const storage = String(event?.meta?.inputTelemetry?.storage || "");
    if (storage) return storage.toLowerCase();
  }
  return "";
}

const BAD_TRANSCRIPT_DIAGNOSIS =
  "Audio reached Cloudflare, but speech recognition returned only punctuation.";

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
  if (!amount) return "";
  if (amount < 1024) return `${amount} B`;
  return `${(amount / 1024).toFixed(1)} KiB`;
}

function duration(value: unknown) {
  const ms = Number(value || 0);
  if (!ms) return "";
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
  if (isTranscribing(run)) return "Transcribing…";
  if (!hasUsefulTranscript(run.command)) return "No speech detected";
  return run.command;
}

// Same candidate order as the simulator's voiceCapture so Safari/iOS lands on
// audio/mp4 and Chrome/Firefox on webm/opus.
const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

function pickRecorderMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return "";
  }
  return (
    RECORDER_MIME_CANDIDATES.find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) || ""
  );
}

function mimeToFormat(mimeType: string) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) {
    return "m4a";
  }
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp3") || value.includes("mpeg")) return "mp3";
  if (value.includes("wav")) return "wav";
  return "webm";
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read recorded audio."));
    reader.onloadend = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

function recordClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<JsonRecord | null>(null);
  const [liveRuns, setLiveRuns] = useState<JsonRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toggledEvents, setToggledEvents] = useState<Set<string>>(
    () => new Set(),
  );
  const [openTile, setOpenTile] = useState("");
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
  const badTranscript = Boolean(
    selected && !selectedTranscribing && !hasUsefulTranscript(selected.command),
  );
  const newestRun = runs[0] ?? null;
  const newestTranscribing = isTranscribing(newestRun);
  const latestBad = Boolean(
    newestRun && !newestTranscribing && !hasUsefulTranscript(newestRun.command),
  );
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

  // Auto-open the hero details when the selected run failed to transcribe so
  // the evidence is on screen without a click. Closing it stays closed until
  // the selection (or its bad-transcript state) changes.
  useEffect(() => {
    if (badTranscript) setDetailsOpen(true);
  }, [badTranscript, selectedId]);

  const handleCommandQueued = useCallback(() => {
    void refreshRuns();
    void refresh();
  }, [refresh, refreshRuns]);

  const toggleEvent = useCallback((id: string) => {
    setToggledEvents((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const storeLabel = cloud.store === "d1" ? "D1" : cloud.store || "—";
  const cloudUp = Boolean(cloud.ok);
  const bridgeUp = Boolean(cloud.macBridgeOnline);
  const browserUp = Boolean(browserExtension.online);
  const systemTone =
    cloudUp && bridgeUp ? "ok" : cloudUp || bridgeUp ? "warn" : "off";
  const newestFailedLog = activity[0]?.status === "failed";

  const heroChip = !selected
    ? null
    : badTranscript
      ? { tone: "warn", word: "No speech" }
      : selectedTranscribing ||
          selected.status === "processing" ||
          selected.status === "active"
        ? { tone: "run", word: "Running" }
        : selected.status === "failed"
          ? { tone: "warn", word: "Failed" }
          : { tone: "ok", word: "Done" };

  const metaSegments: { title: string; text: string }[] = [];
  if (selected) {
    const audio = bytes(telemetry?.audioBytes);
    if (audio) metaSegments.push({ title: "Recorded audio", text: audio });
    const length = duration(telemetry?.durationMs);
    if (length) metaSegments.push({ title: "Duration", text: length });
    if (telemetry?.sampleRate) {
      metaSegments.push({
        title: "Sample rate",
        text: `${telemetry.sampleRate.toLocaleString()} Hz`,
      });
    }
    if (selected.updatedAt) {
      metaSegments.push({ title: "Last update", text: clock(selected.updatedAt) });
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" title="AI Pendant Dashboard">
            P
          </span>
          <h1>Dashboard</h1>
        </div>
        <div className="top-actions">
          <div className="dot-cluster" aria-label="System status">
            <ClusterDot
              short="Cloud"
              state={cloudUp ? "ok" : "off"}
              text={`Cloudflare relay: ${cloudUp ? "online" : "offline"}`}
            />
            <ClusterDot
              short="Bridge"
              state={bridgeUp ? "ok" : "off"}
              text={`Mac bridge: ${bridgeUp ? "connected" : "disconnected"}`}
            />
            <ClusterDot
              short="Mic"
              state={latestBad ? "warn" : "ok"}
              text={`Mic input: ${latestBad ? "speech not detected" : "ok"}`}
            />
            <ClusterDot
              short="Browser"
              state={browserUp ? "ok" : "off"}
              text={`Browser extension: ${browserUp ? "online" : "offline"}`}
            />
          </div>
          <button
            className={`icon-button ${refreshing ? "spinning" : ""}`}
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
          >
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.6 5.6" />
              <path d="M13.7 2.2v3.4h-3.4" />
            </svg>
          </button>
          <form action="/api/auth/logout" method="post">
            <button
              className="icon-button"
              type="submit"
              aria-label="Sign out"
              title="Sign out"
            >
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6.5 2H2.5v12h4" />
                <path d="M10.5 5l3 3-3 3" />
                <path d="M13.5 8H6" />
              </svg>
            </button>
          </form>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {latestBad || requiredMissing.length ? (
        <div className="alert-strip" aria-label="Attention needed">
          {latestBad ? (
            <span className="alert-chip" title={BAD_TRANSCRIPT_DIAGNOSIS}>
              Mic · no speech
            </span>
          ) : null}
          {requiredMissing.length ? (
            <span className="alert-chip" title={requiredMissing.join(", ")}>
              Permissions · {requiredMissing.length} missing
            </span>
          ) : null}
        </div>
      ) : null}

      <article className={`hero ${badTranscript ? "has-alert" : ""}`}>
        {selected ? (
          <>
            <div className="hero-top">
              <span className="micro-chip">
                {selected.pipelineId === newestRun?.pipelineId
                  ? "Latest"
                  : clock(selected.createdAt)}
              </span>
              {heroChip ? (
                <span
                  className={`status-chip ${heroChip.tone}`}
                  title={`${selected.status} · ${selected.pipelineId}`}
                >
                  <i aria-hidden="true" />
                  {heroChip.word}
                </span>
              ) : null}
            </div>
            <h2 className="hero-command">{displayCommand(selected)}</h2>
            {badTranscript ? (
              <span className="alert-chip hero-alert" title={BAD_TRANSCRIPT_DIAGNOSIS}>
                Speech not detected
              </span>
            ) : null}

            <div className="stage-rail" aria-label="Pipeline stages">
              {stagesFor(selected).map((stage, index, stages) => {
                const state = stageState(selected, stage.id);
                const previousDone =
                  index > 0 &&
                  stageState(selected, stages[index - 1].id) === "done";
                return (
                  <Fragment key={stage.id}>
                    {index ? (
                      <i
                        className={`stage-link ${previousDone ? "done" : ""}`}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className={`stage-node ${state}`}
                      title={`${stage.label}: ${state}`}
                      aria-label={`${stage.label}: ${state}`}
                      role="img"
                    >
                      <i aria-hidden="true" />
                      <em>{stage.short}</em>
                    </span>
                  </Fragment>
                );
              })}
            </div>

            {metaSegments.length ? (
              <p className="meta-line">
                {metaSegments.map((segment, index) => (
                  <Fragment key={segment.title}>
                    {index ? (
                      <span className="sep" aria-hidden="true">
                        {" · "}
                      </span>
                    ) : null}
                    <span title={segment.title}>{segment.text}</span>
                  </Fragment>
                ))}
              </p>
            ) : null}

            <button
              className="details-toggle"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
            >
              <span className={`chevron ${detailsOpen ? "open" : ""}`} aria-hidden="true">
                ▸
              </span>
              Details
            </button>

            {detailsOpen ? (
              <div className="details-panel">
                <p className="pipeline-id">{selected.pipelineId}</p>
                {badTranscript ? (
                  <p className="details-note">{BAD_TRANSCRIPT_DIAGNOSIS}</p>
                ) : null}
                <div className="telemetry-grid">
                  <Metric label="Payload" value={bytes(telemetry?.audioBytes) || "—"} />
                  <Metric label="Duration" value={duration(telemetry?.durationMs) || "—"} />
                  <Metric
                    label="Sample rate"
                    value={
                      telemetry?.sampleRate
                        ? `${telemetry.sampleRate.toLocaleString()} Hz`
                        : "—"
                    }
                  />
                  <Metric label="Format" value={telemetry?.format || "—"} />
                  <Metric label="Storage" value={telemetry?.storage || "—"} />
                  <Metric
                    label="Input gain"
                    value={
                      telemetry?.inputGainDb != null
                        ? `+${telemetry.inputGainDb} dB`
                        : "—"
                    }
                  />
                  <Metric label="Transcript" value={selected.command || "empty"} />
                </div>
                <ol className="event-list">
                  {(selected.events ?? []).map((event: JsonRecord, index: number) => {
                    const eventId = String(
                      event.eventId || `${event.stage}-${index}`,
                    );
                    const failed = event.status === "failed";
                    const open = failed !== toggledEvents.has(eventId);
                    const expandable = Boolean(event.detail || event.text);
                    return (
                      <li key={eventId}>
                        <div className={`event-index ${event.status}`}>
                          {index + 1}
                        </div>
                        <div className="event-copy">
                          <button
                            className="event-row"
                            onClick={() => toggleEvent(eventId)}
                            aria-expanded={open}
                            disabled={!expandable}
                          >
                            <span className="event-stage">
                              {event.stage?.replaceAll("_", " ")}
                            </span>
                            <span className="event-label">{event.label}</span>
                            <time>{clock(event.at)}</time>
                          </button>
                          {open && expandable ? (
                            <>
                              {event.detail ? (
                                <p className="event-detail">{event.detail}</p>
                              ) : null}
                              {event.text ? (
                                <blockquote>{event.text}</blockquote>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}
          </>
        ) : (
          <div className="hero-empty">
            <h2 className="hero-command">Waiting for pendant</h2>
            <p className="hero-hint">Press and speak</p>
          </div>
        )}
        <Composer onQueued={handleCommandQueued} />
      </article>

      <div className="run-strip" aria-label="Recent commands">
        {runs.map((run: JsonRecord) => {
          const transcribing = isTranscribing(run);
          const unreadable = !transcribing && !hasUsefulTranscript(run.command);
          const statusText = transcribing
            ? "Transcribing"
            : unreadable
              ? "Speech not detected"
              : run.status;
          const dotTone = unreadable
            ? "failed"
            : transcribing
              ? "processing"
              : run.status;
          return (
            <button
              key={run.pipelineId}
              className={`run-chip ${
                run.pipelineId === selected?.pipelineId ? "selected" : ""
              }`}
              onClick={() => setSelectedId(run.pipelineId)}
              title={`${displayCommand(run)} · ${statusText} · ${clock(run.createdAt)}`}
              aria-label={`${displayCommand(run)} · ${statusText} · ${clock(run.createdAt)}`}
            >
              <i className={`run-dot ${dotTone}`} aria-hidden="true" />
              <span>{displayCommand(run)}</span>
            </button>
          );
        })}
      </div>

      <div className="tile-strip">
        <Tile
          id="system"
          label="System"
          tone={systemTone}
          dotText={`Relay ${cloudUp ? "online" : "offline"} · Bridge ${
            bridgeUp ? "connected" : "disconnected"
          }`}
          value={
            cloudUp
              ? `${storeLabel} · ${agent.ok ? `v${agent.version}` : "—"}`
              : "Offline"
          }
          open={openTile === "system"}
          onToggle={() =>
            setOpenTile((current) => (current === "system" ? "" : "system"))
          }
        />
        <Tile
          id="mac"
          label="Mac"
          tone={permissions.ready ? "ok" : "warn"}
          dotText={
            permissions.ready
              ? "Mac permissions ready"
              : "Mac permissions incomplete"
          }
          value={
            requiredMissing.length ? `${requiredMissing.length} missing` : "Ready"
          }
          open={openTile === "mac"}
          onToggle={() =>
            setOpenTile((current) => (current === "mac" ? "" : "mac"))
          }
        />
        <Tile
          id="browser"
          label="Browser"
          tone={browserUp ? "ok" : "off"}
          dotText={`Browser extension ${browserUp ? "online" : "offline"}`}
          value={browserUp ? "Connected" : "Offline"}
          open={openTile === "browser"}
          onToggle={() =>
            setOpenTile((current) => (current === "browser" ? "" : "browser"))
          }
        />
        <Tile
          id="activity"
          label="Activity"
          tone={activity.length ? (newestFailedLog ? "warn" : "ok") : "off"}
          dotText={
            activity.length
              ? newestFailedLog
                ? "Latest Mac action failed"
                : "Mac agent activity ok"
              : "No Mac agent activity"
          }
          value={
            latestMacAction
              ? latestMacAction.command || latestMacAction.summary || "—"
              : "—"
          }
          open={openTile === "activity"}
          onToggle={() =>
            setOpenTile((current) => (current === "activity" ? "" : "activity"))
          }
        />
        <Tile
          id="data"
          label="Data"
          tone="ok"
          dotText="Shared cloud data"
          value={`${sharedSessions.length} chats · ${memoryEntities.length} mem`}
          open={openTile === "data"}
          onToggle={() =>
            setOpenTile((current) => (current === "data" ? "" : "data"))
          }
        />
      </div>

      {openTile === "system" ? (
        <section id="tile-panel-system" className="tile-panel" aria-label="System detail">
          <dl className="system-list">
            <SystemRow label="Relay" value={cloudUp ? "Online" : "Offline"} />
            <SystemRow label="Queue" value={storeLabel} />
            <SystemRow
              label="STT"
              value={
                cloud.speechToTextConfigured
                  ? cloud.models?.speechToText || "Workers AI ready"
                  : "Off"
              }
            />
            <SystemRow
              label="TTS"
              value={cloud.models?.textToSpeech || "macOS say · 24 kHz"}
            />
            <SystemRow
              label="Bridge"
              value={bridgeUp ? "Connected" : "Disconnected"}
            />
            <SystemRow
              label="Agent"
              value={agent.ok ? `v${agent.version}` : "Offline"}
            />
          </dl>
        </section>
      ) : null}

      {openTile === "mac" ? (
        <section id="tile-panel-mac" className="tile-panel" aria-label="Mac permissions detail">
          <dl className="system-list">
            <SystemRow
              label="Accessibility"
              value={permissions.accessibility?.trusted ? "✓" : "—"}
            />
            <SystemRow
              label="Screen"
              value={permissions.screenRecording?.granted ? "✓" : "—"}
            />
            <SystemRow
              label="Automation"
              value={
                automationEntries.length
                  ? `${grantedAutomation}/${automationEntries.length}`
                  : "Not checked"
              }
            />
            <SystemRow label="Host" value={agent.hostApp || "—"} />
          </dl>
          {requiredMissing.length ? (
            <div className="perm-chips">
              {requiredMissing.map((name: string) => (
                <span key={name} className="perm-chip">
                  {name}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {openTile === "browser" ? (
        <section id="tile-panel-browser" className="tile-panel" aria-label="Browser bridge detail">
          <dl className="system-list">
            <SystemRow
              label="Devices"
              value={String(browserExtension.connectedDevices ?? 0)}
            />
            <SystemRow
              label="Queued"
              value={String(browserExtension.pendingCommands ?? 0)}
            />
            <SystemRow label="Seen" value={clock(browserExtension.lastSeenAt)} />
          </dl>
        </section>
      ) : null}

      {openTile === "activity" ? (
        <section id="tile-panel-activity" className="tile-panel" aria-label="Mac agent activity detail">
          {activity.length ? (
            <ol className="activity-list">
              {activity.map((entry: JsonRecord) => (
                <li key={entry.id}>
                  <span
                    className={`activity-dot ${
                      entry.status === "failed" ? "failed" : ""
                    }`}
                    title={entry.status || "complete"}
                    aria-label={entry.status || "complete"}
                    role="img"
                  />
                  <strong>
                    {entry.command || entry.summary || "Agent activity"}
                  </strong>
                  <small>
                    {entry.status || "complete"} · {clock(entry.createdAt)}
                  </small>
                  {entry.error ? <p>{entry.error}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="panel-empty">No activity</p>
          )}
        </section>
      ) : null}

      {openTile === "data" ? (
        <section id="tile-panel-data" className="tile-panel" aria-label="Shared cloud data detail">
          <span className="rev-badge">rev {sharedProduct.revision ?? 0}</span>
          <div className="data-grid">
            <div>
              <p className="micro-label">Chats</p>
              {sharedSessions.length ? (
                <ol className="data-list">
                  {sharedSessions.slice(0, 6).map((session: JsonRecord) => (
                    <li key={session.sessionId}>
                      <div className="data-line">
                        <strong>{session.title || "Untitled session"}</strong>
                        <span>{session.sessionId?.slice(0, 8)}</span>
                      </div>
                      <small>
                        {session.turns?.length ?? 0} turns ·{" "}
                        {clock(session.updatedAt)}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="panel-empty">None</p>
              )}
            </div>
            <div>
              <p className="micro-label">Memory</p>
              {memoryEntities.length ? (
                <ol className="data-list">
                  {memoryEntities.slice(0, 6).map((entity: JsonRecord) => (
                    <li key={entity.id}>
                      <div className="data-line">
                        <strong>{entity.name || "Untitled memory"}</strong>
                      </div>
                      <small>
                        {entity.type || "Memory"} · {clock(entity.updatedAt)}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="panel-empty">None</p>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

type ComposerMode = "idle" | "recording" | "sending";

type ActiveRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
};

/**
 * Lets a signed-in personal device speak or type a command. Both paths land in
 * the same relay pipeline the pendant uses, so the run simply appears in the
 * hero via the existing freshness polling.
 */
function Composer({ onQueued }: { onQueued: () => void }) {
  const [mode, setMode] = useState<ComposerMode>("idle");
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [seconds, setSeconds] = useState(0);
  const recordingRef = useRef<ActiveRecording | null>(null);

  useEffect(() => {
    if (mode !== "recording") return;
    const timer = window.setInterval(() => {
      const startedAt = recordingRef.current?.startedAt;
      if (startedAt) {
        setSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [mode]);

  // Release the microphone if the dashboard unmounts mid-recording.
  useEffect(
    () => () => {
      const active = recordingRef.current;
      recordingRef.current = null;
      if (!active) return;
      try {
        if (active.recorder.state !== "inactive") active.recorder.stop();
      } catch {
        // already stopped
      }
      active.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const startRecording = useCallback(async () => {
    setHint("");
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setHint("This browser cannot record audio — type a command instead.");
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(250);
      recordingRef.current = {
        recorder,
        stream,
        chunks,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        startedAt: Date.now(),
      };
      setSeconds(0);
      setMode("recording");
    } catch {
      // The mic stays live if MediaRecorder failed after getUserMedia resolved.
      stream?.getTracks().forEach((track) => track.stop());
      setHint("Microphone blocked — allow mic access or type instead.");
    }
  }, []);

  const stopAndSend = useCallback(async () => {
    const active = recordingRef.current;
    if (!active) return;
    recordingRef.current = null;
    setMode("sending");
    try {
      // A recorder that already stopped itself will never fire onstop again,
      // and a wedged one must not strand the composer in "sending".
      if (active.recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => {
          active.recorder.onstop = () => resolve();
        });
        active.recorder.stop();
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }

      const blob = new Blob(active.chunks, { type: active.mimeType });
      if (!blob.size) {
        throw new Error("No audio captured — try again.");
      }
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch("/api/command/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          format: mimeToFormat(blob.type || active.mimeType),
          durationMs: Date.now() - active.startedAt,
          language: navigator.language?.toLowerCase().startsWith("ko")
            ? "ko"
            : "en",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Voice send failed (${response.status})`);
      }
      if (payload.noSpeech) {
        setHint("No speech detected — try again.");
      } else if (payload.queueError) {
        setHint(payload.queueError);
      }
      onQueued();
    } catch (sendError) {
      setHint(
        sendError instanceof Error ? sendError.message : "Voice send failed.",
      );
    } finally {
      active.stream.getTracks().forEach((track) => track.stop());
      setMode("idle");
    }
  }, [onQueued]);

  const submitText = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const command = text.trim();
      if (!command || mode !== "idle") return;
      setHint("");
      setMode("sending");
      try {
        const response = await fetch("/api/command/text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: command }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `Send failed (${response.status})`);
        }
        setText("");
        onQueued();
      } catch (sendError) {
        setHint(
          sendError instanceof Error ? sendError.message : "Send failed.",
        );
      } finally {
        setMode("idle");
      }
    },
    [mode, onQueued, text],
  );

  const recording = mode === "recording";
  const sending = mode === "sending";

  return (
    <div className="composer-block">
      <div className="composer">
        <button
          type="button"
          className={`mic-button ${recording ? "recording" : ""}`}
          onClick={recording ? stopAndSend : startRecording}
          disabled={sending}
          aria-label={
            recording ? "Stop recording and send" : "Record a voice command"
          }
          title={
            recording ? "Stop recording and send" : "Record a voice command"
          }
        >
          {recording ? (
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="8" height="8" rx="1.5" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
              <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0" />
              <path d="M8 11.8v2.4" />
            </svg>
          )}
        </button>
        {recording ? (
          <span className="record-timer">{recordClock(seconds)}</span>
        ) : null}
        {sending ? <span className="composer-status">Sending…</span> : null}
        <form className="composer-field" onSubmit={submitText}>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type a command…"
            aria-label="Type a command"
            enterKeyHint="send"
            maxLength={2000}
            disabled={mode !== "idle"}
          />
          <button
            type="submit"
            className="send-button"
            aria-label="Send command"
            title="Send command"
            disabled={mode !== "idle" || !text.trim()}
          >
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 12.5v-9" />
              <path d="M4.2 7.2 8 3.5l3.8 3.7" />
            </svg>
          </button>
        </form>
      </div>
      {hint ? <p className="composer-hint">{hint}</p> : null}
    </div>
  );
}

function ClusterDot({
  short,
  state,
  text,
}: {
  short: string;
  state: "ok" | "off" | "warn";
  text: string;
}) {
  return (
    <span
      className={`cluster-dot ${state}`}
      title={text}
      aria-label={text}
      role="img"
    >
      <i aria-hidden="true" />
      {state !== "ok" ? <em>{short}</em> : null}
    </span>
  );
}

function Tile({
  id,
  label,
  value,
  tone,
  dotText,
  open,
  onToggle,
}: {
  id: string;
  label: string;
  value: string;
  tone: "ok" | "warn" | "off";
  dotText: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`tile ${open ? "open" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`tile-panel-${id}`}
      title={dotText}
    >
      <span className="tile-head">
        <i
          className={`tile-dot ${tone}`}
          title={dotText}
          aria-label={dotText}
          role="img"
        />
        <span>{label}</span>
        <em className="tile-chevron" aria-hidden="true">
          ▾
        </em>
      </span>
      <span className="tile-value">{value}</span>
    </button>
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
