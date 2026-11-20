/* eslint-disable @typescript-eslint/no-explicit-any -- The board returns schemaless records at this boundary. */

/**
 * The one data layer. The same build runs on the website (this app's own `/api/*` server routes,
 * which hold the task board's token), in Hive's Mac app (hive://app/, whose window answers `/api/*`
 * itself) and, through the website, on the phone and in the browser extension. Every host answers
 * the same routes, so the views never learn where they run.
 */
import { base } from "$app/paths";
import { toWav } from "$lib/wav.js";

/** "desktop" in Hive's Mac app, where the window records dictation itself. */
const CONFIGURED = String(import.meta.env.VITE_DASHBOARD_BACKEND || "").toLowerCase();

async function apiRequest(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${path} failed (${response.status})`);
  }
  return payload;
}

/* Tasks and agents. The board's shape is `$lib/tasks`'s to read. */
export async function fetchTaskBoard(): Promise<any> {
  return apiRequest(`${base}/api/tasks`);
}

/** A folder and every one of its memories: `{folder: {project, key, name, about}, memories}`. */
export async function fetchFolder(project: string, key: string): Promise<any> {
  return apiRequest(`${base}/api/folder?${new URLSearchParams({ project, key })}`);
}

/** Makes a folder in a project, or says what it's for. */
export async function saveFolder(folder: { project: string; name: string; about?: string }) {
  return apiRequest(`${base}/api/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(folder),
  });
}

/** Adds a memory to a folder; every agent put on the folder gets it from then on. */
export async function saveMemory(memory: {
  project: string;
  folder: string;
  kind: string;
  title: string;
  body: string;
}) {
  return apiRequest(`${base}/api/folders/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(memory),
  });
}

/* The owner's iPhone (cloud/tasks/phone.js): whether Hive Phone is connected, its pairing, its passcode. */
export async function fetchPhone(): Promise<{ connected: boolean; version: string | null; passcode: boolean; paused: boolean }> {
  return apiRequest(`${base}/api/phone`);
}

export async function pairPhone(): Promise<{ pairing: string; source: string; sidestore: string }> {
  return apiRequest(`${base}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

export async function savePhonePasscode(body: { passcode?: string; consent?: boolean; remove?: boolean; retry?: boolean }) {
  return apiRequest(`${base}/api/phone/passcode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/*
 * Voice-to-text for the composer. In Hive's window the app records you and Hive's own speech
 * model (the one that hears you when you tap fn) reads it; in a browser the page records you and
 * the website's speech model, in the cloud, reads it.
 */
export type Dictation = { stop(): Promise<string>; cancel(): void };

/** Five minutes is plenty for one instruction, and keeps a recording under 10 MB. */
const MAX_DICTATION_SECONDS = 300;

export async function startDictation(): Promise<Dictation> {
  if (CONFIGURED === "desktop") {
    const call = (action: string) =>
      apiRequest(`${base}/api/dictation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    await call("start");
    return {
      stop: async () => String((await call("stop"))?.text ?? "").trim(),
      cancel: () => void call("cancel").catch(() => {}),
    };
  }
  const recording = await recordHere();
  return {
    stop: async () => {
      const answer = await apiRequest(`${base}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: recording.stop(),
      });
      return String(answer?.text ?? "").trim();
    },
    cancel: () => void recording.stop(),
  };
}

/** The microphone, recorded in the page until stop(), which hands back a 16 kHz WAV. */
async function recordHere(): Promise<{ stop(): Blob }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser won't let the page use the microphone.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // (ScriptProcessor is old but everywhere; a worklet would need its own module file.)
  const tap = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let length = 0;
  const limit = context.sampleRate * MAX_DICTATION_SECONDS;
  tap.onaudioprocess = (event) => {
    if (length >= limit) return;
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(chunk);
    length += chunk.length;
  };
  source.connect(tap);
  tap.connect(context.destination);
  let done: Blob | null = null;
  return {
    stop() {
      if (!done) {
        tap.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        done = new Blob([toWav(chunks, context.sampleRate)], { type: "audio/wav" });
      }
      return done;
    },
  };
}

/** Which device this page is on, sent with every instruction so Hive knows where it came from. */
export function deviceName(): string {
  if (typeof location === "undefined") return "web";
  if (location.protocol === "hive:") return "mac";
  if (location.protocol.endsWith("-extension:")) return "extension";
  if (/iPhone|iPad|Android/.test(navigator.userAgent)) return "phone";
  return "web";
}

/**
 * Hands `text` to Hive's agent in the cloud, which plans it and starts the work.
 * `accepted: null` means it may or may not have been queued.
 */
export async function sendToHive(
  text: string,
): Promise<{ accepted: boolean | null; receiptId?: string; ahead?: number; error?: string }> {
  return apiRequest(`${base}/api/agents/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "hive-cloud", text, from: deviceName() }),
  });
}

/**
 * One agent's conversation, `{run, steps, messages}`: its newest steps (`tail`), or the ones after
 * step `after` while it's open and live.
 */
export async function fetchConversation(
  machine: string,
  run: string,
  since: { after?: number; tail?: number } = {},
): Promise<any> {
  const query = new URLSearchParams({ machine, run });
  if (since.after) query.set("after", String(since.after));
  else query.set("tail", String(since.tail ?? 300));
  return apiRequest(`${base}/api/agents/run?${query}`);
}

/**
 * Says `text` to one agent, through the cloud: `{machine, run}` for an agent on a node, `{request}`
 * for Hive's cloud agent (a follow-up to that request).
 */
export async function sendToAgent(
  to: { machine: string; run: string } | { request: number },
  text: string,
): Promise<any> {
  return apiRequest(`${base}/api/agents/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...to, text, from: deviceName() }),
  });
}

/** Turns a standing rule off on every machine (POST /api/rules/off → the board's /v1/rules/off). */
export async function turnRuleOff(rule: { machine: string; id: string }): Promise<any> {
  return apiRequest(`${base}/api/rules/off`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine: rule.machine, id: rule.id }),
  });
}

/** Cancels a task, asks its agent to continue it, or answers what it waits on you for. */
export async function actOnTask(
  task: { machine: string; id: string },
  action: "cancel" | "continue" | "answer",
  text = "",
): Promise<any> {
  return apiRequest(`${base}/api/tasks/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine: task.machine, id: task.id, action, text, from: deviceName() }),
  });
}
