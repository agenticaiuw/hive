import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The Cloudflare adapter's Worker entry expects two workerd-only globals:
// `caches.default` (read at module scope) and the `cloudflare:workers` module.
// Shimming them is the only accommodation this suite makes — every request
// below goes through the real built Worker.
globalThis.caches ??= {
  default: {
    async match() {
      return undefined;
    },
    async put() {},
  },
};
register("./support/workerd-loader.mjs", import.meta.url);

const env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
  DASHBOARD_ACCESS_KEY: "test-pairing-code",
  DASHBOARD_SESSION_SECRET: "test-session-secret-with-enough-entropy",
};

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

async function loadWorker() {
  const workerUrl = new URL(
    "../.svelte-kit/cloudflare/_worker.js",
    import.meta.url,
  );
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function login(
  worker,
  runtimeEnv = env,
  { accessKey = runtimeEnv.DASHBOARD_ACCESS_KEY, returnTo = "/" } = {},
) {
  const response = await worker.fetch(
    new Request("https://dashboard.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        accessKey,
        returnTo,
      }),
    }),
    runtimeEnv,
    context,
  );
  return response;
}

async function sessionCookie(worker, runtimeEnv = env) {
  const response = await login(worker, runtimeEnv);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://dashboard.example/");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie ?? "", /^__Host-pendant_session=/);
  assert.match(setCookie ?? "", /;\s*Path=\//i);
  assert.match(setCookie ?? "", /;\s*HttpOnly/i);
  assert.match(setCookie ?? "", /;\s*Secure/i);
  assert.match(setCookie ?? "", /;\s*SameSite=Lax/i);
  assert.match(setCookie ?? "", /;\s*Max-Age=2592000/i);
  return setCookie.split(";", 1)[0];
}

async function request(
  worker,
  url = "http://localhost/",
  { cookie = "", runtimeEnv = env, method = "GET" } = {},
) {
  return worker.fetch(
    new Request(url, {
      method,
      headers: {
        accept: "text/html",
        ...(cookie ? { cookie } : {}),
      },
    }),
    runtimeEnv,
    context,
  );
}

async function postJson(
  worker,
  url,
  body,
  { cookie = "", runtimeEnv = env } = {},
) {
  return worker.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
    context,
  );
}

test("redirects anonymous visitors to the product login", async () => {
  const worker = await loadWorker();
  const response = await request(worker);
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?returnTo=%2F",
  );
});

test("server-renders the Dashboard after pairing-code login", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);
  const response = await request(worker, "http://localhost/", { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AI Pendant Dashboard<\/title>/i);
  assert.match(html, /Dashboard/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);

  // Topbar dot cluster exposes each subsystem through an accessible label.
  assert.match(html, /aria-label="Cloudflare relay: (?:online|offline)"/);
  assert.match(html, /aria-label="Mac bridge: (?:connected|disconnected)"/);
  assert.match(html, /aria-label="Mic input: (?:ok|speech not detected)"/);
  assert.match(html, /aria-label="Browser extension: (?:online|offline)"/);

  // Icon-only actions keep their accessible names.
  assert.match(html, /aria-label="Refresh"/);
  assert.match(html, /aria-label="Sign out"/);
  assert.match(html, /action="\/api\/auth\/logout"/);

  // The answer card is the hero, and with no data it renders the empty state:
  // what the state is, plus the pathway to the ask box directly below it.
  assert.match(html, /class="answer-card"/);
  assert.match(html, />Ready</);
  assert.match(html, /Press the pendant or type a command/);

  /*
   * Nothing is claimed before data arrives. A cold server render has no runs
   * and nothing parked, so neither the "needs your approval" region nor the
   * Recent list may appear — an empty section with a heading and no rows is
   * exactly the clutter this layout exists to remove. (The old design always
   * emitted an empty run strip; it no longer does.)
   */
  assert.doesNotMatch(html, /id="needs-you"/);
  assert.doesNotMatch(html, /Needs your approval/);
  assert.doesNotMatch(html, /class="recent"/);

  // Telemetry is behind a labelled disclosure and is not on a data-free page.
  assert.doesNotMatch(html, /Sample rate/);
  assert.doesNotMatch(html, />STT</);

  // Jobs replaced Activity: same Mac actions, plus who asked, what each step
  // touched, and what it returned.
  for (const tile of ["Jobs", "System", "Mac", "Browser", "History", "Memory"]) {
    assert.match(html, new RegExp(`>${tile}</span>`));
  }

  // Personal-device composer: record or type a command from this browser.
  assert.match(html, /aria-label="Record a voice command"/);
  assert.match(html, /aria-label="Type a command"/);
  assert.match(html, /placeholder="Type a command…"/);
  assert.match(html, /aria-label="Send command"/);
  // It renders idle on the server; recording chrome only appears after a tap.
  assert.doesNotMatch(html, /Stop recording and send/);
});

test("serves the app-authenticated dashboard from a public Sites host", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);
  const response = await request(
    worker,
    "https://ai-pendant-dashboard.example.chatgpt.site/",
    { cookie },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(await response.text(), /Dashboard/);
});

test("accepts the shared repo-root auth variable names server-side", async () => {
  const worker = await loadWorker();
  const runtimeEnv = {
    ASSETS: env.ASSETS,
    PAIRING_CODE: "shared-root-pairing-code",
    SESSION_SECRET: "shared-root-session-secret-with-enough-entropy",
  };
  const response = await login(worker, runtimeEnv, {
    accessKey: runtimeEnv.PAIRING_CODE,
  });

  assert.equal(response.status, 303);
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^__Host-pendant_session=/,
  );
});

test("rejects a wrong pairing code without creating a session", async () => {
  const worker = await loadWorker();
  const response = await login(worker, env, {
    accessKey: "definitely-not-the-key",
    returnTo: "/settings?tab=devices",
  });

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://dashboard.example/login?error=1&returnTo=%2Fsettings%3Ftab%3Ddevices",
  );
  assert.equal(response.headers.get("set-cookie"), null);
});

test("fails closed when app authentication is missing or weak", async () => {
  const worker = await loadWorker();
  const missingAuthEnv = { ASSETS: env.ASSETS };
  const shortSecretEnv = {
    ...env,
    DASHBOARD_ACCESS_KEY: "too-short",
    DASHBOARD_SESSION_SECRET: "also-too-short",
  };

  for (const runtimeEnv of [missingAuthEnv, shortSecretEnv]) {
    const loginResponse = await login(worker, runtimeEnv, {
      accessKey: "anything-long-enough",
    });
    assert.equal(loginResponse.status, 503);
    assert.equal(loginResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await loginResponse.json(), {
      ok: false,
      error: "Dashboard authentication is not configured.",
    });

    const dashboardResponse = await request(worker, "https://example.com/", {
      cookie: "__Host-pendant_session=9999999999.forged",
      runtimeEnv,
    });
    assert.equal(dashboardResponse.status, 302);
    assert.equal(
      dashboardResponse.headers.get("location"),
      "https://example.com/login?returnTo=%2F",
    );
  }
});

test("rejects anonymous API requests before calling the relay", async () => {
  const worker = await loadWorker();
  let relayRequests = 0;
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch() {
        relayRequests += 1;
        return Response.json({ ok: true });
      },
    },
  };

  const response = await request(worker, "https://example.com/api/snapshot", {
    runtimeEnv,
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "Sign in to the dashboard.",
  });
  assert.equal(relayRequests, 0);
  assert.doesNotMatch(JSON.stringify(payload), /server-side-relay-secret/);

  // The composer endpoints sit behind the same session gate.
  for (const path of ["/api/command/text", "/api/command/audio"]) {
    const denied = await postJson(
      worker,
      `https://example.com${path}`,
      { text: "open mail", audioBase64: "AAAA", format: "webm" },
      { runtimeEnv },
    );
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), {
      ok: false,
      error: "Sign in to the dashboard.",
    });
  }
  assert.equal(relayRequests, 0);
});

test("queues a typed dashboard command through the pendant relay pipeline", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const relayCalls = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        relayCalls.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json(
          { ok: true, job: { jobId: "job-77", status: "queued" } },
          { status: 202 },
        );
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await postJson(
    worker,
    "https://dashboard.example/api/command/text",
    { text: "  open mail  ", sessionId: "session-dashboard-1" },
    { cookie, runtimeEnv },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: "job-77",
    status: "queued",
  });

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].path, "/v1/mac/plan");
  assert.equal(relayCalls[0].authorization, `Bearer ${relayApiKey}`);
  assert.equal(relayCalls[0].body.command, "open mail");
  assert.equal(relayCalls[0].body.sessionId, "session-dashboard-1");
  // Runs are attributed to the browser that sent them, not to the pendant.
  assert.equal(relayCalls[0].body.deviceId, "dashboard-web");
  assert.deepEqual(relayCalls[0].body.inputTelemetry, {
    storage: "dashboard",
    source: "dashboard-web",
    inputMode: "typed",
  });
});

test("validates typed commands before spending a relay call", async () => {
  const worker = await loadWorker();
  let relayCalls = 0;
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch() {
        relayCalls += 1;
        return Response.json({ ok: true });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const empty = await postJson(
    worker,
    "https://dashboard.example/api/command/text",
    { text: "   " },
    { cookie, runtimeEnv },
  );
  assert.equal(empty.status, 400);

  const tooLong = await postJson(
    worker,
    "https://dashboard.example/api/command/text",
    { text: "x".repeat(2001) },
    { cookie, runtimeEnv },
  );
  assert.equal(tooLong.status, 413);

  const invalidSession = await postJson(
    worker,
    "https://dashboard.example/api/command/text",
    { text: "open mail", sessionId: "../another/session" },
    { cookie, runtimeEnv },
  );
  assert.equal(invalidSession.status, 400);
  assert.equal(relayCalls, 0);
});

test("transcribes a browser recording and dispatches the transcript", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const localPath = "/Users/example/Projects/Private/notes.txt";
  const relayCalls = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        relayCalls.push({
          path,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        if (path === "/v1/transcribe") {
          return Response.json({
            ok: true,
            text: `Open ${localPath}`,
            jobId: "job-42",
            internalSecret: relayApiKey,
          });
        }
        return Response.json(
          { ok: true, job: { jobId: "job-42", status: "queued" } },
          { status: 202 },
        );
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await postJson(
    worker,
    "https://dashboard.example/api/command/audio",
    {
      audioBase64: "data:audio/webm;base64,QUJDRA==",
      format: "webm",
      durationMs: 2400,
      language: "en",
      sessionId: "session-dashboard-voice",
    },
    { cookie, runtimeEnv },
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.queued, true);
  assert.equal(payload.jobId, "job-42");
  // Echoed transcripts get the same redaction as every other relay payload.
  assert.match(payload.text, /\[local path\]/);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /server-side-relay-secret/);
  assert.doesNotMatch(serialized, /\/Users\//);

  assert.deepEqual(
    relayCalls.map((call) => [call.path, call.authorization]),
    [
      ["/v1/transcribe", `Bearer ${relayApiKey}`],
      ["/v1/mac/plan", `Bearer ${relayApiKey}`],
    ],
  );
  // The data: URI prefix is stripped before the relay ever sees the audio.
  assert.equal(relayCalls[0].body.audioBase64, "QUJDRA==");
  assert.equal(relayCalls[0].body.format, "webm");
  assert.equal(relayCalls[0].body.deviceId, "dashboard-web");
  assert.equal(relayCalls[0].body.sessionId, "session-dashboard-voice");
  // The transcript upgrades the announced job instead of forking a new run.
  assert.equal(relayCalls[1].body.transcriptionJobId, "job-42");
  assert.equal(relayCalls[1].body.deviceId, "dashboard-web");
  assert.equal(relayCalls[1].body.sessionId, "session-dashboard-voice");
  // Both hops carry the telemetry that keeps the run in the operator feed.
  for (const call of relayCalls) {
    assert.deepEqual(call.body.inputTelemetry, {
      storage: "dashboard",
      source: "dashboard-web",
      inputMode: "voice",
      durationMs: 2400,
    });
  }
});

test("rejects malformed or oversized browser recordings", async () => {
  const worker = await loadWorker();
  let relayCalls = 0;
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch() {
        relayCalls += 1;
        return Response.json({ ok: true });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const missing = await postJson(
    worker,
    "https://dashboard.example/api/command/audio",
    { format: "webm" },
    { cookie, runtimeEnv },
  );
  assert.equal(missing.status, 400);

  const notBase64 = await postJson(
    worker,
    "https://dashboard.example/api/command/audio",
    { audioBase64: "not base64!!", format: "webm" },
    { cookie, runtimeEnv },
  );
  assert.equal(notBase64.status, 400);

  const oversized = await postJson(
    worker,
    "https://dashboard.example/api/command/audio",
    { audioBase64: "A".repeat(11_500_000), format: "webm" },
    { cookie, runtimeEnv },
  );
  assert.equal(oversized.status, 413);

  const invalidSession = await postJson(
    worker,
    "https://dashboard.example/api/command/audio",
    {
      audioBase64: "QUJDRA==",
      format: "webm",
      sessionId: "../another/session",
    },
    { cookie, runtimeEnv },
  );
  assert.equal(invalidSession.status, 400);
  assert.equal(relayCalls, 0);
});

test("publishes only sanitized agent status and keeps relay credentials server-side", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const localPath = "/Users/example/Projects/Private/notes.txt";
  const relayRequests = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        relayRequests.push({
          path,
          authorization: request.headers.get("authorization"),
        });
        if (path === "/health") {
          return Response.json({
            ok: true,
            store: "d1",
            speechToTextConfigured: true,
            macBridgeOnline: true,
            models: {
              speechToText: "whisper",
              textToSpeech: "macOS speech",
            },
            internalSecret: relayApiKey,
          });
        }
        if (path === "/v1/product/state/single-owner") {
          return Response.json({
            ok: true,
            state: {
              schemaVersion: "product-sync.v1",
              accountId: "single-owner",
              revision: 11,
              sessions: [
                {
                  sessionId: "session-1",
                  title: `Private work in ${localPath}`,
                  createdAt: "2026-08-02T19:00:00.000Z",
                  updatedAt: "2026-08-02T20:00:00.000Z",
                  turns: [
                    {
                      id: "turn-1",
                      role: "user",
                      content: `Open ${localPath}`,
                      createdAt: "2026-08-02T20:00:00.000Z",
                    },
                  ],
                },
              ],
              memory: {
                entities: [
                  {
                    id: "entity-1",
                    type: "Project",
                    name: `Project at ${localPath}`,
                    updatedAt: "2026-08-02T20:00:00.000Z",
                  },
                ],
                relations: [],
              },
            },
          });
        }
        if (path === "/v1/ops/voice-runs") {
          return Response.json({
            ok: true,
            observedAt: "2026-08-02T20:02:00.000Z",
            internalSecret: relayApiKey,
            runs: [
              {
                pipelineId: "pipeline-1",
                kind: "voice_command",
                command: `Open ${localPath}`,
                source: "cloudflare",
                status: "done",
                createdAt: "2026-08-02T20:00:00.000Z",
                updatedAt: "2026-08-02T20:01:00.000Z",
                events: [
                  {
                    eventId: "event-1",
                    stage: "agent",
                    status: "done",
                    label: "Opened file",
                    detail: `Opened ${localPath}`,
                    source: "mac",
                    at: "2026-08-02T20:01:00.000Z",
                    meta: { localPath },
                  },
                ],
              },
            ],
          });
        }
        if (path === "/v1/ops/voice-runs/latest") {
          return Response.json({
            ok: true,
            observedAt: "2026-08-02T20:02:00.000Z",
            internalSecret: relayApiKey,
            latest: {
              pipelineId: "pipeline-1",
              status: "done",
              updatedAt: "2026-08-02T20:01:00.000Z",
              localPath,
            },
          });
        }
        return Response.json({
          state: {
            revision: 7,
            updatedAt: "2026-08-02T20:00:00.000Z",
            updatedBy: "home-mac",
            data: {
              ok: true,
              status: {
                agent: {
                  ok: true,
                  version: "0.5.0",
                  fullControlMode: true,
                  llmPlannerEnabled: true,
                  logPath: localPath,
                  permissions: {
                    hostApp: "AI Pendant Agent",
                    nodePath: localPath,
                    ready: false,
                    accessibility: { trusted: true, detail: localPath },
                    screenRecording: { granted: false, detail: localPath },
                    automation: {
                      Finder: { granted: true, detail: localPath },
                      Mail: { granted: false, detail: localPath },
                    },
                    reminders: { granted: true, detail: localPath },
                    requiredMissing: ["Mail"],
                    optionalMissing: [],
                  },
                  browserExtension: {
                    online: true,
                    pendingCommands: 1,
                    devices: [
                      {
                        online: true,
                        extensionId: "private-extension-id",
                        userAgent: "private-user-agent",
                        lastSeenAt: "2026-08-02T20:01:00.000Z",
                      },
                    ],
                  },
                },
              },
              pipeline: [
                {
                  pipelineId: "pipeline-1",
                  command: `Open ${localPath}`,
                  status: "done",
                  events: [
                    {
                      eventId: "event-1",
                      stage: "agent",
                      status: "done",
                      label: "Opened file",
                      detail: `Opened ${localPath}`,
                      meta: {
                        inputTelemetry: {
                          audioBytes: 42,
                          durationMs: 100,
                          sampleRate: 16_000,
                          format: "opus",
                          storage: "D1",
                          inputGainDb: 4,
                          localPath,
                        },
                      },
                    },
                  ],
                },
              ],
              logs: [
                {
                  id: "log-1",
                  command: `Open ${localPath}`,
                  summary: `Opened ${localPath}`,
                  status: "done",
                  createdAt: "2026-08-02T20:00:00.000Z",
                },
              ],
            },
          },
        });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await request(
    worker,
    "https://dashboard.example/api/snapshot",
    { cookie, runtimeEnv },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status.agent.permissions.accessibility.trusted, true);
  assert.equal(payload.status.agent.permissions.screenRecording.granted, false);
  assert.deepEqual(payload.status.agent.permissions.requiredMissing, ["Mail"]);
  assert.deepEqual(payload.status.agent.permissions.automation, {
    Finder: { granted: true },
    Mail: { granted: false },
  });
  assert.deepEqual(payload.status.agent.browserExtension, {
    online: true,
    pendingCommands: 1,
    connectedDevices: 1,
    lastSeenAt: "2026-08-02T20:01:00.000Z",
  });
  assert.equal(payload.activity.length, 1);
  assert.match(payload.activity[0].command, /\[local path\]/);
  assert.equal(payload.product.revision, 11);
  assert.equal(payload.product.sessions.length, 1);
  assert.equal(payload.product.memory.entities.length, 1);
  assert.match(payload.product.sessions[0].title, /\[local path\]/);
  assert.deepEqual(relayRequests, [
    { path: "/health", authorization: null },
    {
      path: "/v1/state/agent-snapshot",
      authorization: `Bearer ${relayApiKey}`,
    },
    {
      path: "/v1/product/state/single-owner",
      authorization: `Bearer ${relayApiKey}`,
    },
  ]);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /server-side-relay-secret/);
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, /private-extension-id|private-user-agent/);

  const runsResponse = await request(
    worker,
    "https://dashboard.example/api/runs",
    { cookie, runtimeEnv },
  );
  assert.equal(runsResponse.status, 200);
  const runsPayload = await runsResponse.json();
  assert.equal(runsPayload.runs.length, 1);
  assert.match(runsPayload.runs[0].command, /\[local path\]/);
  assert.doesNotMatch(JSON.stringify(runsPayload), /server-side-relay-secret/);
  assert.doesNotMatch(JSON.stringify(runsPayload), /\/Users\//);

  const latestResponse = await request(
    worker,
    "https://dashboard.example/api/runs/latest",
    { cookie, runtimeEnv },
  );
  assert.equal(latestResponse.status, 200);
  assert.deepEqual(await latestResponse.json(), {
    ok: true,
    latest: {
      pipelineId: "pipeline-1",
      status: "done",
      updatedAt: "2026-08-02T20:01:00.000Z",
    },
    observedAt: "2026-08-02T20:02:00.000Z",
  });
  assert.deepEqual(relayRequests.slice(3), [
    {
      path: "/v1/ops/voice-runs",
      authorization: `Bearer ${relayApiKey}`,
    },
    {
      path: "/v1/ops/voice-runs/latest",
      authorization: `Bearer ${relayApiKey}`,
    },
  ]);
});

test("serves linked chats and explicitly sanitized historical run detail", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const nestedSecret = "nested-history-secret";
  const localPath = "/Users/example/Projects/Private/run.txt";
  const completionMarker = "[AGENT_RESPONSE_COMPLETE]";
  const relayRequests = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        const url = new URL(request.url);
        relayRequests.push(url.pathname);

        if (url.pathname === "/v1/ops/history") {
          return Response.json({
            ok: true,
            entries: [
              {
                pipelineId: "job-history-1",
                sessionId: "session-dashboard-1",
                kind: "voice_command",
                command: "Open the report",
                origin: "dashboard",
                inputMode: "typed",
                source: "cloudflare",
                status: "completed",
                jobStatus: "completed",
                reply: `Report opened\n${completionMarker}`,
                actionCount: 1,
                eventCount: 2,
                audio: { available: false },
                createdAt: "2026-08-02T20:00:00.000Z",
                updatedAt: "2026-08-02T20:00:01.000Z",
              },
            ],
            nextCursor: "2026-08-02T20:00:00.000Z|job-history-1",
            hasMore: true,
            limit: 24,
            retention: {
              runsTtlMs: 86_400_000,
              runsOldestVisibleAt: "2026-08-01T20:00:00.000Z",
              runsNote: "Old runs expire.",
              internalSecret: nestedSecret,
              audio: {
                maxAgeMs: 2_592_000_000,
                maxAgeDays: 30,
                defaultMaxAgeMs: 2_592_000_000,
                sweepEnabled: false,
                expiresBefore: "2026-07-03T20:00:00.000Z",
                internalSecret: nestedSecret,
              },
            },
            observedAt: "2026-08-02T20:00:02.000Z",
          });
        }

        if (url.pathname === "/v1/ops/history/job-history-1") {
          return Response.json({
            ok: true,
            run: {
              pipelineId: "job-history-1",
              sessionId: "session-dashboard-1",
              command: "Open the report",
              reply: `Report opened\n<|eot_id|>`,
              status: "completed",
              origin: "dashboard",
              inputMode: "typed",
              audio: {
                available: false,
                captureId: null,
                internalSecret: nestedSecret,
              },
              events: [
                {
                  eventId: "event-history-1",
                  stage: "agent",
                  status: "done",
                  label: "Opened report",
                  detail: `Opened ${localPath}`,
                  text: `Visible event text\n${completionMarker}`,
                  source: "mac-bridge",
                  at: "2026-08-02T20:00:01.000Z",
                  meta: {
                    authorization: nestedSecret,
                    inputTelemetry: {
                      audioBytes: 12,
                      storage: localPath,
                      privateToken: nestedSecret,
                    },
                  },
                },
              ],
              actions: [
                {
                  type: "open_path",
                  label: "Open report",
                  params: { path: localPath, apiKey: nestedSecret },
                },
              ],
              execution: {
                ok: true,
                status: "success",
                summary: `Opened ${localPath}`,
                response: `Report opened\n${completionMarker}`,
                planner: "llm",
                thinking: { systemPrompt: nestedSecret },
                results: [
                  {
                    ok: true,
                    status: "success",
                    message: `Opened ${localPath}`,
                    authorization: nestedSecret,
                  },
                ],
                actions: [
                  {
                    type: "open_path",
                    label: "Open report",
                    params: { path: localPath, token: nestedSecret },
                  },
                ],
                pendantSpeech: { audioBase64: nestedSecret },
              },
              createdAt: "2026-08-02T20:00:00.000Z",
              updatedAt: "2026-08-02T20:00:01.000Z",
            },
            retention: { runsTtlMs: 86_400_000, audio: {} },
            observedAt: "2026-08-02T20:00:02.000Z",
          });
        }

        if (url.pathname === "/v1/ops/memory") {
          return Response.json({
            ok: true,
            counts: {
              entities: 0,
              relations: 0,
              sessions: 1,
              turns: 2,
              internalSecret: nestedSecret,
            },
            memory: { entities: [] },
            sessions: [
              {
                sessionId: "session-dashboard-1",
                title: "Report chat",
                turnCount: 2,
                updatedAt: "2026-08-02T20:00:01.000Z",
                turns: [
                  {
                    role: "user",
                    content: "Open the report",
                    createdAt: "2026-08-02T20:00:00.000Z",
                  },
                  {
                    role: "assistant",
                    content: `Report opened\n${completionMarker}`,
                    createdAt: "2026-08-02T20:00:01.000Z",
                  },
                ],
              },
            ],
            observedAt: "2026-08-02T20:00:02.000Z",
          });
        }

        return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const historyResponse = await request(
    worker,
    "https://dashboard.example/api/history?limit=24",
    { cookie, runtimeEnv },
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.entries[0].sessionId, "session-dashboard-1");
  assert.equal(history.entries[0].reply, "Report opened");
  assert.equal(history.hasMore, true);
  assert.match(history.nextCursor, /job-history-1$/);

  const memoryResponse = await request(
    worker,
    "https://dashboard.example/api/memory",
    { cookie, runtimeEnv },
  );
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json();
  assert.equal(memory.sessions[0].turns[1].content, "Report opened");
  assert.deepEqual(memory.counts, {
    entities: 0,
    relations: 0,
    sessions: 1,
    turns: 2,
    matchedEntities: 0,
    matchedRelations: 0,
    matchedSessions: 0,
  });

  const detailResponse = await request(
    worker,
    "https://dashboard.example/api/history/job-history-1",
    { cookie, runtimeEnv },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.run.sessionId, "session-dashboard-1");
  assert.equal(detail.run.reply, "Report opened");
  assert.match(detail.run.events[0].detail, /\[local path\]/);
  assert.equal(detail.run.events[0].text, "Visible event text");
  assert.deepEqual(detail.run.actions, [
    { type: "open_path", label: "Open report" },
  ]);
  assert.equal(detail.run.execution.thinking, undefined);
  assert.equal(detail.run.execution.pendantSpeech, undefined);
  assert.deepEqual(detail.run.execution.actions, [
    { type: "open_path", label: "Open report" },
  ]);

  const serialized = JSON.stringify({ history, memory, detail });
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, new RegExp(nestedSecret));
  assert.doesNotMatch(serialized, /AGENT_RESPONSE_COMPLETE|eot_id/);

  const relayCount = relayRequests.length;
  const invalidId = await request(
    worker,
    "https://dashboard.example/api/history/bad%24id",
    { cookie, runtimeEnv },
  );
  assert.equal(invalidId.status, 400);
  assert.equal(relayRequests.length, relayCount);
});

test("rejects tampered sessions and prevents cross-origin return redirects", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);
  const [name, token] = cookie.split("=", 2);
  const tamperedCookie = `${name}=${token.slice(0, -1)}x`;
  const dashboardResponse = await request(worker, "https://example.com/", {
    cookie: tamperedCookie,
  });
  assert.equal(dashboardResponse.status, 302);

  const loginResponse = await login(worker, env, {
    returnTo: "/\\attacker.example/escape",
  });
  assert.equal(loginResponse.status, 303);
  assert.equal(
    loginResponse.headers.get("location"),
    "https://dashboard.example/",
  );
});

test("logout clears the host-only session cookie", async () => {
  const worker = await loadWorker();
  const response = await request(
    worker,
    "https://dashboard.example/api/auth/logout",
    { method: "POST" },
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://dashboard.example/login",
  );
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^__Host-pendant_session=;/,
  );
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("serves the full Mac job list with its evidence through the ops proxy", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const proxied = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== "/v1/ops/proxy") {
          return Response.json({ ok: false }, { status: 404 });
        }
        proxied.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        // Exactly the shape the Mac agent's GET /jobs returns.
        return Response.json({
          jobs: [
            {
              jobId: "local_1",
              type: "execute",
              status: "completed",
              command: "probe disk",
              source: "probe",
              createdAt: "2026-08-07T05:00:00.000Z",
              updatedAt: "2026-08-07T05:00:04.000Z",
              cancellable: false,
              undo: { canUndo: true },
              result: {
                response: "Disk is 41% full.",
                results: [
                  {
                    ok: true,
                    status: "completed",
                    action: {
                      type: "run_shell",
                      label: "df",
                      params: {
                        command: "df -h /Users/example/Projects",
                        apiKey: "sk-live-should-never-render",
                      },
                    },
                    stdout: "Filesystem  Size  Used\n/dev/disk3s5 926Gi 380Gi",
                    stderr: "",
                  },
                ],
              },
            },
          ],
        });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await worker.fetch(
    new Request("https://dashboard.example/api/jobs", { headers: { cookie } }),
    runtimeEnv,
    context,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();

  // The Mac is asked first, because agent-initiated work never reaches the relay.
  assert.deepEqual(proxied[0].body, {
    method: "GET",
    path: "/jobs",
    body: null,
    deviceId: "ops-dashboard",
  });
  assert.equal(proxied[0].authorization, `Bearer ${relayApiKey}`);
  assert.equal(payload.origin, "mac-agent");

  const [job] = payload.jobs;
  assert.equal(job.source, "probe");
  assert.equal(job.undo.canUndo, true);

  // Evidence survives: the command that ran and what it printed are the whole
  // point of the view, so unlike spoken transcripts they keep their real paths.
  const [step] = job.result.results;
  assert.equal(step.action.params.command, "df -h /Users/example/Projects");
  assert.match(step.stdout, /\/dev\/disk3s5/);
  // Credentials never do.
  assert.equal(step.action.params.apiKey, "••••••• hidden");
  assert.doesNotMatch(JSON.stringify(payload), /sk-live-should-never-render/);
});

test("falls back to relay history, and says so, when the Mac is asleep", async () => {
  const worker = await loadWorker();
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/ops/proxy") {
          return Response.json(
            { ok: false, error: "Mac bridge is offline." },
            { status: 503 },
          );
        }
        if (path === "/v1/ops/history") {
          return Response.json({
            ok: true,
            entries: [
              {
                pipelineId: "pipe_1",
                command: "what is my battery",
                origin: "dashboard",
                status: "completed",
                jobStatus: "completed",
                reply: "88 percent.",
                createdAt: "2026-08-07T05:00:00.000Z",
                updatedAt: "2026-08-07T05:00:02.000Z",
              },
            ],
          });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await worker.fetch(
    new Request("https://dashboard.example/api/jobs", { headers: { cookie } }),
    runtimeEnv,
    context,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.origin, "relay-history");
  assert.equal(payload.jobs[0].pipelineId, "pipe_1");
  // A short list must never read as a quiet Mac.
  assert.match(payload.note, /Mac bridge is offline/);
  assert.match(payload.note, /work the Mac started on its own is not in this list/);
});

test("reports scheduled routines as unreadable from the cloud rather than absent", async () => {
  const worker = await loadWorker();
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      // `/routines` is not on the relay's ops-proxy allowlist, so this is what
      // the deployed dashboard really gets back.
      async fetch() {
        return Response.json(
          {
            ok: false,
            error:
              "Blocked for safety: path not allowed for ops proxy (/routines).",
          },
          { status: 403 },
        );
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const response = await worker.fetch(
    new Request("https://dashboard.example/api/routines", {
      headers: { cookie },
    }),
    runtimeEnv,
    context,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.routines, []);
  assert.match(payload.note, /not readable from the cloud dashboard/);
  assert.match(payload.note, /They run on the Mac whether or not anything is watching/);
});

/* ------------------------- Ask the hive (universal command box) --------- */

test("renders the ask-the-hive box on the dashboard and hive pages", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);

  for (const path of ["/", "/hive"]) {
    const response = await request(worker, `https://dashboard.example${path}`, {
      cookie,
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /aria-label="Ask the hive"/);
    assert.match(html, /placeholder="Ask the hive…"/);
    assert.match(html, /aria-label="Send to the hive"/);
    // The deployed build's honest transport label: this page has no route to
    // the Mac, so its commands go through the server-held relay key.
    assert.match(html, />VIA RELAY</);
    assert.doesNotMatch(html, />LOCAL</);
  }
});

test("dispatches an ask-the-hive command and answers its status poll with the key server-side", async () => {
  const worker = await loadWorker();
  const relayApiKey = "server-side-relay-secret";
  const relayCalls = [];
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: relayApiKey,
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        relayCalls.push({
          path,
          authorization: request.headers.get("authorization"),
        });
        if (path === "/v1/mac/plan") {
          return Response.json(
            { ok: true, job: { jobId: "job-cmd-1", status: "queued" } },
            { status: 202 },
          );
        }
        if (path === "/v1/mac/jobs/job-cmd-1") {
          return Response.json({
            ok: true,
            job: {
              jobId: "job-cmd-1",
              type: "plan",
              status: "plan_ready",
              command: "what is the battery percentage",
              createdAt: "2026-08-08T05:00:00.000Z",
              updatedAt: "2026-08-08T05:00:06.000Z",
              error: null,
              result: {
                response: "Battery is at 84 percent.",
                summary: "Battery is at 84 percent.",
                executed: true,
                phase: "complete",
                actions: [
                  {
                    type: "get_mac_status",
                    label: "Read battery status",
                    params: { probe: "battery", api_key: "should-hide-me" },
                  },
                ],
                execution: {
                  results: [
                    {
                      action: { type: "get_mac_status", label: "Read battery status" },
                      ok: true,
                      message: "Battery is at 84 percent.",
                    },
                  ],
                },
                // Megabytes of PCM in production; must never reach the browser.
                pendantSpeech: { pcmBase64: "AAAA", pcmBytes: 4 },
              },
            },
          });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const dispatch = await postJson(
    worker,
    "https://dashboard.example/api/command",
    { text: "  what is the battery percentage  ", sessionId: "cmdbox-1" },
    { cookie, runtimeEnv },
  );
  assert.equal(dispatch.status, 202);
  assert.deepEqual(await dispatch.json(), {
    ok: true,
    jobId: "job-cmd-1",
    status: "queued",
  });
  assert.equal(relayCalls[0].path, "/v1/mac/plan");
  assert.equal(relayCalls[0].authorization, `Bearer ${relayApiKey}`);

  const status = await request(
    worker,
    "https://dashboard.example/api/command/status/job-cmd-1",
    { cookie, runtimeEnv },
  );
  assert.equal(status.status, 200);
  const payload = await status.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.job.status, "plan_ready");
  assert.equal(payload.job.result.response, "Battery is at 84 percent.");
  assert.equal(payload.job.result.executed, true);
  assert.equal(payload.job.result.results[0].ok, true);
  assert.equal(
    payload.job.result.results[0].action.label,
    "Read battery status",
  );

  const raw = JSON.stringify(payload);
  // Allowlist holds: no speech payload, no credentials, key stays server-side.
  assert.doesNotMatch(raw, /pendantSpeech|pcmBase64/);
  assert.doesNotMatch(raw, /should-hide-me/);
  assert.doesNotMatch(raw, new RegExp(relayApiKey));
});

test("reports a parked-for-approval plan distinctly from a failure", async () => {
  const worker = await loadWorker();
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/mac/jobs/job-parked-1") {
          // The current contract ("parked is not failed"): an ordinary
          // plan_ready job, no error, with the parked markers and the
          // blocked actions inside the result.
          return Response.json({
            ok: true,
            job: {
              jobId: "job-parked-1",
              type: "plan",
              status: "plan_ready",
              command: "delete my downloads folder",
              error: null,
              result: {
                response: "Waiting for your approval on the dashboard.",
                executed: false,
                parked: true,
                phase: "parked_for_approval",
                approval: { relayJobId: "job-parked-1", planJobId: "job_77" },
                awaitingApproval: [
                  {
                    type: "run_shell",
                    reason: "Shell commands need a confirm first.",
                  },
                ],
                actions: [
                  {
                    type: "run_shell",
                    label: "Remove the folder",
                    params: { command: "rm -rf ~/Downloads" },
                  },
                ],
              },
            },
          });
        }
        if (path === "/v1/mac/jobs/job-parked-legacy") {
          // A relay deployed before the parked fix recorded the same plan as
          // a failure with the approval sentence in job.error; the markers
          // must still let clients render it as parked, never failed.
          return Response.json({
            ok: true,
            job: {
              jobId: "job-parked-legacy",
              type: "plan",
              status: "failed",
              command: "delete my downloads folder",
              error: "Waiting for your approval on the dashboard.",
              result: {
                response: "Waiting for your approval on the dashboard.",
                executed: false,
                awaitingApproval: [
                  { type: "run_shell", reason: "Shell commands need a confirm first." },
                ],
              },
            },
          });
        }
        return Response.json({ ok: false, error: "Job not found." }, { status: 404 });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const status = await request(
    worker,
    "https://dashboard.example/api/command/status/job-parked-1",
    { cookie, runtimeEnv },
  );
  assert.equal(status.status, 200);
  const payload = await status.json();
  assert.equal(payload.job.status, "plan_ready");
  assert.equal(payload.job.result.parked, true);
  assert.equal(payload.job.result.phase, "parked_for_approval");
  assert.equal(payload.job.result.awaitingApproval.length, 1);
  assert.equal(payload.job.result.awaitingApproval[0].type, "run_shell");
  assert.match(payload.job.result.awaitingApproval[0].reason, /confirm first/);
  // The approval sentence survives verbatim for the parked banner.
  assert.match(payload.job.result.response, /Waiting for your approval/);

  const legacy = await request(
    worker,
    "https://dashboard.example/api/command/status/job-parked-legacy",
    { cookie, runtimeEnv },
  );
  const legacyPayload = await legacy.json();
  assert.equal(legacyPayload.job.status, "failed");
  assert.equal(legacyPayload.job.result.awaitingApproval.length, 1);
  assert.match(legacyPayload.job.error, /Waiting for your approval/);

  const missing = await request(
    worker,
    "https://dashboard.example/api/command/status/job-unknown",
    { cookie, runtimeEnv },
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: "Job not found." });
});

test("validates ask-the-hive input and rejects anonymous callers before any relay call", async () => {
  const worker = await loadWorker();
  let relayCalls = 0;
  const runtimeEnv = {
    ...env,
    RELAY_API_KEY: "server-side-relay-secret",
    RELAY: {
      async fetch() {
        relayCalls += 1;
        return Response.json({ ok: true });
      },
    },
  };

  // Anonymous: both the dispatch and the status poll 401 before the relay.
  const anonymousDispatch = await postJson(
    worker,
    "https://dashboard.example/api/command",
    { text: "open mail", sessionId: "cmdbox-2" },
    { runtimeEnv },
  );
  assert.equal(anonymousDispatch.status, 401);
  const anonymousStatus = await request(
    worker,
    "https://dashboard.example/api/command/status/job-1",
    { runtimeEnv },
  );
  assert.equal(anonymousStatus.status, 401);
  assert.equal(relayCalls, 0);

  const cookie = await sessionCookie(worker, runtimeEnv);
  const empty = await postJson(
    worker,
    "https://dashboard.example/api/command",
    { text: "   ", sessionId: "cmdbox-2" },
    { cookie, runtimeEnv },
  );
  assert.equal(empty.status, 400);

  const tooLong = await postJson(
    worker,
    "https://dashboard.example/api/command",
    { text: "x".repeat(2001), sessionId: "cmdbox-2" },
    { cookie, runtimeEnv },
  );
  assert.equal(tooLong.status, 413);

  const badSession = await postJson(
    worker,
    "https://dashboard.example/api/command",
    { text: "open mail", sessionId: "../another/session" },
    { cookie, runtimeEnv },
  );
  assert.equal(badSession.status, 400);

  // Routable as a segment, but not a legal job id (contains "..").
  const badJobId = await request(
    worker,
    "https://dashboard.example/api/command/status/bad..id",
    { cookie, runtimeEnv },
  );
  assert.equal(badJobId.status, 400);
  assert.equal(relayCalls, 0);
});
