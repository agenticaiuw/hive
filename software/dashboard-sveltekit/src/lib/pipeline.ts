/* eslint-disable @typescript-eslint/no-explicit-any -- Relay records are schemaless at this display boundary. */

export type JsonRecord = Record<string, any>;

export const STAGES = [
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

export function stagesFor(run: JsonRecord | null) {
  return runOrigin(run) === "dashboard" ? DASHBOARD_STAGES : STAGES;
}

export function runOrigin(run: JsonRecord | null) {
  const direct = String(run?.origin || "");
  if (direct) return direct;
  const events = Array.isArray(run?.events) ? run.events : [];
  for (const event of events) {
    const storage = String(event?.meta?.inputTelemetry?.storage || "");
    if (storage) return storage.toLowerCase();
  }
  return "";
}

export const BAD_TRANSCRIPT_DIAGNOSIS =
  "Audio reached Cloudflare, but speech recognition returned only punctuation.";

export function hasUsefulTranscript(value: unknown) {
  return /[\p{L}\p{N}]/u.test(String(value || ""));
}

export function isTranscribing(run: JsonRecord | null) {
  return Boolean(
    run?.events?.some(
      (event: JsonRecord) =>
        event.stage === "transcription" &&
        ["active", "waiting"].includes(event.status),
    ),
  );
}

export function bytes(value: unknown) {
  const amount = Number(value || 0);
  if (!amount) return "";
  if (amount < 1024) return `${amount} B`;
  return `${(amount / 1024).toFixed(1)} KiB`;
}

export function duration(value: unknown) {
  const ms = Number(value || 0);
  if (!ms) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function clock(value: unknown) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(String(value)));
}

export function stageState(run: JsonRecord | null, stageId: string) {
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
  if (stageId === "transcription" && !hasUsefulTranscript(run?.command)) {
    return "failed";
  }
  return "done";
}

export function displayCommand(run: JsonRecord) {
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

export function pickRecorderMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return "";
  }
  return (
    RECORDER_MIME_CANDIDATES.find((type) =>
      MediaRecorder.isTypeSupported(type),
    ) || ""
  );
}

export function mimeToFormat(mimeType: string) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) {
    return "m4a";
  }
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp3") || value.includes("mpeg")) return "mp3";
  if (value.includes("wav")) return "wav";
  return "webm";
}

export function blobToBase64(blob: Blob) {
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

export function recordClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
