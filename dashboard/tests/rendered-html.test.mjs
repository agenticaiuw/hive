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
  assert.match(setCookie ?? "", /^__Host-hive_session=/);
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

test("the home page is the task board: a box to tell an agent, then every task", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);
  const response = await request(worker, "http://localhost/", { cookie });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Tell an agent what to do/);
  // One box, one page: no picker for where it goes, no second chat page, pairing under Settings.
  assert.doesNotMatch(html, />To</);
  assert.doesNotMatch(html, /href="\/hive"|href="\/pc"|href="\/voice"/);
  assert.match(html, /href="\/settings"[^>]*>Settings</);
});

test("serves the app-authenticated dashboard from a public Sites host", async () => {
  const worker = await loadWorker();
  const cookie = await sessionCookie(worker);
  const response = await request(
    worker,
    "https://hive-dashboard.example.chatgpt.site/",
    { cookie },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(await response.text(), /<title>Hive<\/title>/i);
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
    /^__Host-hive_session=/,
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
      cookie: "__Host-hive_session=9999999999.forged",
      runtimeEnv,
    });
    assert.equal(dashboardResponse.status, 302);
    assert.equal(
      dashboardResponse.headers.get("location"),
      "https://example.com/login?returnTo=%2F",
    );
  }
});

test("rejects anonymous API requests before calling the task board", async () => {
  const worker = await loadWorker();
  let boardRequests = 0;
  const runtimeEnv = {
    ...env,
    TASKS_TOKEN: "server-side-board-secret",
    TASKS: {
      async fetch() {
        boardRequests += 1;
        return Response.json({ ok: true });
      },
    },
  };

  const response = await request(worker, "https://example.com/api/tasks", {
    runtimeEnv,
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: false,
    error: "Sign in to the dashboard.",
  });
  assert.doesNotMatch(JSON.stringify(payload), /server-side-board-secret/);

  // Sending to an agent sits behind the same session gate.
  for (const path of ["/api/agents/send", "/api/agents/message"]) {
    const denied = await postJson(
      worker,
      `https://example.com${path}`,
      { text: "open mail" },
      { runtimeEnv },
    );
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), {
      ok: false,
      error: "Sign in to the dashboard.",
    });
  }
  assert.equal(boardRequests, 0);
});

test("sends an instruction from the website to Hive's orchestrator through the board's queue", async () => {
  const worker = await loadWorker();
  const boardCalls = [];
  const runtimeEnv = {
    ...env,
    TASKS_TOKEN: "server-side-board-token",
    TASKS: {
      async fetch(url, init) {
        boardCalls.push({ path: new URL(url).pathname, init, body: JSON.parse(init.body) });
        return Response.json({ ok: true, id: 7, ahead: 1 });
      },
    },
  };
  const cookie = await sessionCookie(worker, runtimeEnv);

  const listed = await request(worker, "https://dashboard.example/api/agents", { cookie, runtimeEnv });
  assert.deepEqual((await listed.json()).agents, [
    { id: "hive-cloud", name: "Hive", where: "the cloud", available: true },
  ]);

  const response = await postJson(
    worker,
    "https://dashboard.example/api/agents/send",
    { agent: "hive-cloud", text: "  For hive › Voice: check the dictation socket  ", from: "phone" },
    { cookie, runtimeEnv },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, receiptId: "R7", ahead: 1 });
  assert.equal(boardCalls.length, 1);
  assert.equal(boardCalls[0].path, "/v1/requests");
  assert.equal(boardCalls[0].init.method, "POST");
  assert.equal(boardCalls[0].init.headers.authorization, "Bearer server-side-board-token");
  assert.deepEqual(boardCalls[0].body, { text: "For hive › Voice: check the dictation socket", agent: "hive-cloud", from: "phone" });

  // Nothing to send to without the board, and nobody but the owner can send.
  const unplugged = await request(worker, "https://dashboard.example/api/agents", { cookie, runtimeEnv: { ...env } });
  const [hive] = (await unplugged.json()).agents;
  assert.equal(hive.available, false);
  assert.match(hive.note, /isn't connected/);
  const anonymous = await postJson(worker, "https://dashboard.example/api/agents/send", { text: "x" }, { runtimeEnv });
  assert.notEqual(anonymous.status, 200);
  assert.equal(boardCalls.length, 1);
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
    /^__Host-hive_session=;/,
  );
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
