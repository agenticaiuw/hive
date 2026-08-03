import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeIdentifier,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

/** Runs submitted from a signed-in dashboard browser are attributed honestly. */
const DASHBOARD_DEVICE_ID = "dashboard-web";
const MAX_COMMAND_LENGTH = 2000;

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

  const text = String(body.text || "").trim();
  if (!text) {
    return Response.json(
      { ok: false, error: "text is required." },
      { status: 400 },
    );
  }
  if (text.length > MAX_COMMAND_LENGTH) {
    return Response.json(
      {
        ok: false,
        error: `Command is too long (${MAX_COMMAND_LENGTH} characters max).`,
      },
      { status: 413 },
    );
  }

  try {
    const planResponse = await relayFetch("/v1/mac/plan", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relayApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: text,
        deviceId: DASHBOARD_DEVICE_ID,
        inputTelemetry: {
          storage: "dashboard",
          source: DASHBOARD_DEVICE_ID,
          inputMode: "typed",
        },
      }),
    });
    const planPayload = (await planResponse.json().catch(() => ({}))) as {
      error?: unknown;
      job?: { jobId?: unknown; status?: unknown } | null;
    };
    if (!planResponse.ok) {
      return Response.json(
        {
          ok: false,
          error:
            sanitizeText(planPayload.error, 300) ||
            `Command dispatch failed (${planResponse.status}).`,
        },
        { status: planResponse.status },
      );
    }

    const job =
      planPayload.job && typeof planPayload.job === "object"
        ? planPayload.job
        : null;
    return Response.json(
      {
        ok: true,
        jobId: job ? safeIdentifier(job.jobId, 160) : null,
        status: job ? safeIdentifier(job.status, 80) : null,
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
            : "Unable to reach the Cloudflare command queue.",
      },
      { status: 502 },
    );
  }
};
