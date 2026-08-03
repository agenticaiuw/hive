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

  // Hero renders the pre-data empty state on the server.
  assert.match(html, /Waiting for pendant/);
  assert.match(html, /Press and speak/);

  // Run strip and the five status tiles.
  assert.match(html, /aria-label="Recent commands"/);
  for (const tile of ["System", "Mac", "Browser", "Activity", "Data"]) {
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
    { text: "  open mail  " },
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
  // The transcript upgrades the announced job instead of forking a new run.
  assert.equal(relayCalls[1].body.transcriptionJobId, "job-42");
  assert.equal(relayCalls[1].body.deviceId, "dashboard-web");
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
