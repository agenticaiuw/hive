import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeIdentifier,
  sanitizeText,
  strictIdentifier,
} from "$lib/server/relay";

export const prerender = false;

/** Runs submitted from a signed-in dashboard browser are attributed honestly. */
const DASHBOARD_DEVICE_ID = "dashboard-web";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_FORMATS = new Set(["webm", "m4a", "ogg", "wav", "mp3"]);

export const POST: RequestHandler = async ({ request, locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const audioBase64 = String(body.audioBase64 || "")
    .replace(/^data:[^;]+;base64,/, "")
    .trim();
  if (!audioBase64) {
    return Response.json(
      { ok: false, error: "audioBase64 is required." },
      { status: 400 },
    );
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(audioBase64)) {
    return Response.json(
      { ok: false, error: "audioBase64 must be base64-encoded audio." },
      { status: 400 },
    );
  }
  const audioBytes = Math.floor((audioBase64.length * 3) / 4);
  if (audioBytes > MAX_AUDIO_BYTES) {
    return Response.json(
      { ok: false, error: "Recording is too large (8 MB max)." },
      { status: 413 },
    );
  }

  const requestedFormat = String(body.format || "").toLowerCase();
  const format = AUDIO_FORMATS.has(requestedFormat) ? requestedFormat : "webm";
  const durationMs = Math.min(
    Math.max(Math.round(Number(body.durationMs) || 0), 0),
    10 * 60 * 1000,
  );
  const requestedLanguage = String(body.language || "");
  const language = /^[a-z]{2}$/i.test(requestedLanguage)
    ? requestedLanguage.toLowerCase()
    : undefined;
  const sessionId = strictIdentifier(body.sessionId);
  if (!sessionId) {
    return Response.json(
      { ok: false, error: "A valid conversation sessionId is required." },
      { status: 400 },
    );
  }

  // `storage: "dashboard"` is what puts this run in the operator feed without
  // pretending it came off the pendant's microSD buffer.
  const inputTelemetry = {
    storage: "dashboard",
    source: DASHBOARD_DEVICE_ID,
    inputMode: "voice",
    ...(durationMs ? { durationMs } : {}),
  };

  try {
    const transcribeResponse = await relayFetch("/v1/transcribe", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relayApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audioBase64,
        format,
        ...(language ? { language } : {}),
        deviceId: DASHBOARD_DEVICE_ID,
        sessionId,
        inputTelemetry,
      }),
    });
    const transcribePayload = (await transcribeResponse
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    if (!transcribeResponse.ok) {
      return Response.json(
        {
          ok: false,
          error:
            sanitizeText(transcribePayload.error, 300) ||
            `Cloud transcription failed (${transcribeResponse.status}).`,
        },
        { status: transcribeResponse.status },
      );
    }

    const text = String(transcribePayload.text || "").trim();
    const transcriptionJobId = safeIdentifier(transcribePayload.jobId, 160);
    const hasSpeech = /[\p{L}\p{N}]/u.test(text);
    let queued = false;
    let queueError = "";
    let planJobId = "";

    if (hasSpeech) {
      const planResponse = await relayFetch("/v1/mac/plan", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${relayApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: text,
          deviceId: DASHBOARD_DEVICE_ID,
          sessionId,
          // Keeps the run attributed to the dashboard even if the announced
          // transcription job could not be upgraded in place.
          inputTelemetry,
          ...(transcriptionJobId
            ? { transcriptionJobId: transcriptionJobId }
            : {}),
        }),
      });
      const planPayload = (await planResponse.json().catch(() => ({}))) as {
        error?: unknown;
        job?: { jobId?: unknown } | null;
      };
      if (planResponse.ok) {
        queued = true;
        // The relay usually upgrades the announced transcription job in
        // place, but when it cannot it forks a fresh plan job — and THAT id
        // is the one `/api/command/status/[jobId]` can actually follow.
        const planJob =
          planPayload.job && typeof planPayload.job === "object"
            ? planPayload.job
            : null;
        planJobId = planJob ? safeIdentifier(planJob.jobId, 160) : "";
      } else {
        queueError =
          sanitizeText(planPayload.error, 300) ||
          `Mac dispatch failed (${planResponse.status}).`;
      }
    }

    return Response.json(
      {
        ok: true,
        // The poll handle for the merged command box: the created plan job
        // when dispatch succeeded, else the announced transcription job.
        jobId: planJobId || transcriptionJobId || null,
        text: sanitizeText(text, 300),
        queued,
        ...(hasSpeech ? {} : { noSpeech: true }),
        ...(queueError ? { queueError } : {}),
      },
      {
        status: 202,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? sanitizeText(error.message, 300)
            : "Unable to reach the Cloudflare voice pipeline.",
      },
      { status: 502 },
    );
  }
};
