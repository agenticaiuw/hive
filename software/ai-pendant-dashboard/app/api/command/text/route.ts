export const dynamic = "force-dynamic";

const DEFAULT_RELAY_URL =
  "https://ai-pendant-mission-control.your-subdomain.workers.dev";

/** Runs submitted from a signed-in dashboard browser are attributed honestly. */
const DASHBOARD_DEVICE_ID = "dashboard-web";
const MAX_COMMAND_LENGTH = 2000;

function sanitizeText(value: unknown, maxLength = 500) {
  return String(value ?? "")
    .replace(
      /(?:\/Users\/[^/\s]+|\/Volumes\/[^/\s]+|\/private\/(?:var|tmp)|\/var\/folders|\/tmp)(?:\/[^\n\r"'`]*)?/gi,
      "[local path]",
    )
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\n\r"'`]*)?/g, "[local path]")
    .slice(0, maxLength);
}

function safeIdentifier(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, maxLength);
}

export async function POST(request: Request) {
  type RelayBinding = {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  type RuntimeEnv = {
    RELAY_URL?: string;
    RELAY_API_KEY?: string;
    RELAY?: RelayBinding;
  };
  const runtimeEnv =
    (
      globalThis as typeof globalThis & {
        __PENDANT_RUNTIME_ENV__?: RuntimeEnv;
      }
    ).__PENDANT_RUNTIME_ENV__ ?? (process.env as unknown as RuntimeEnv);
  const relayUrl = String(runtimeEnv.RELAY_URL || DEFAULT_RELAY_URL).replace(
    /\/$/,
    "",
  );
  const relayApiKey = String(runtimeEnv.RELAY_API_KEY || "");
  const relayFetch = (path: string, init?: RequestInit) =>
    runtimeEnv.RELAY
      ? runtimeEnv.RELAY.fetch(new Request(`https://relay.internal${path}`, init))
      : fetch(`${relayUrl}${path}`, init);

  if (!relayApiKey) {
    return Response.json(
      { ok: false, error: "Dashboard relay credential is not configured." },
      { status: 503 },
    );
  }

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
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
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
}
