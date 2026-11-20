// The owner's iPhone, through the board (/v1/phone/…). Hive Phone, the relay app on the iPhone
// (mobile/relay), keeps one WebSocket open to here (/v1/phone/device) with the phone's own key, and
// Hive's agents send WebDriverAgent calls to it (/v1/phone/api/…, signed in as a machine). The phone's
// Durable Object (PhoneRelay) passes each call down that socket to WebDriverAgent on the phone and
// answers with what the phone said. The phone calls out, so it needs no address anyone can reach and
// no computer near it, and every node reaches it the same way, through the cloud.
//
// The phone's key is "phone.iphone.<HMAC of phone:iphone under TASKS_TOKEN>", made the way the browser
// extension's is. The dashboard asks for a pairing (POST /v1/phone/pair): "hive-phone:" and the
// address and key as base64url JSON. The owner copies it on the iPhone and opens Hive Phone, which
// reads it from the clipboard, keeps it, and connects.
//
// Unlocking: the owner saves the iPhone's passcode once, from the dashboard (POST
// /v1/phone/agent/unlock). It's sealed with AES-GCM under a key derived from TASKS_TOKEN and tied to
// this install of Hive Phone (WebDriverAgent's device uuid); only the phone's Durable Object opens it,
// to type it at the system passcode screen (POST /v1/phone/agent/unlock-now, unlock() below). No route
// answers with it. One try at a time: an attempt the iPhone doesn't confirm pauses unlocking until the
// owner allows another from the dashboard.
//
// SideStore installs Hive Phone, and keeps it up to date, from this board's own source (GET
// /v1/phone/source.json, public): the newest phone release (cloud/release.mjs phone), an IPA nobody
// signed, which SideStore signs on the iPhone with the owner's own Apple ID.

import { sawNode } from "./nodes.js";
import { ICON_PNG_BASE64 } from "./phone-icon.js";

/** One phone per board for now; the name is in its key so a second could have its own. */
export const PHONE = "iphone";
export const PAIRING_PREFIX = "hive-phone:";
/** Hive Phone's bundle id as built (mobile/relay/build.mjs); SideStore adds the owner's team to it. */
export const BUNDLE_ID = "app.hive.phone.xctrunner";
export const MIN_IOS = "17.0";

const MOST_PENDING = 4;
const MOST_PER_MINUTE = 120;
const ANSWER_WITHIN_MS = 30_000;
const MOST_BODY = 1024 * 1024;
const MOST_REPLY = 16 * 1024 * 1024;
// What an agent may ask WebDriverAgent for: its own routes, nothing else on the phone.
const WDA_PATH = /^\/(status|screenshot|session|wda)(\/|\?|$)/;
// While the phone is connected its node is written down this often, so the dashboard shows it's there.
const SEEN_EVERY_MS = 5 * 60_000;
const SEAL_PURPOSE = "hive-phone:unlock:v1";

const encode = (text) => new TextEncoder().encode(text);
const clean = (value, most) => String(value ?? "").replace(/[^\w.:@+-]/g, "").slice(0, most);
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unbase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const base64url = (text) => base64(encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares through an HMAC so the comparison takes the same time whatever the guess.
async function same(a, b, key) {
  return (await hmac(key, `same:${a}`)) === (await hmac(key, `same:${b}`));
}

/** The phone's key: what Hive Phone connects with, and nothing else accepts. */
export async function phoneKey(env, name = PHONE) {
  return `phone.${name}.${await hmac(env.TASKS_TOKEN, `phone:${name}`)}`;
}

export async function phoneAllowed(request, env) {
  const header = request.headers.get("authorization") || "";
  const [kind, name, mac] = (header.startsWith("Bearer ") ? header.slice(7) : "").split(".");
  if (kind !== "phone" || name !== PHONE || !mac || !env.TASKS_TOKEN) return false;
  return same(mac, await hmac(env.TASKS_TOKEN, `phone:${name}`), env.TASKS_TOKEN);
}

// ---- the board's own address -----------------------------------------------------------------------
// The pairing holds the address Hive Phone connects to. The dashboard reaches the board through a
// service binding, which doesn't carry it, so the board keeps the address any signed-in node last
// reached it by (worker.js noteNode).

let remembered = null;

export async function rememberOrigin(env, origin) {
  if (remembered === origin || !new URL(origin).hostname.includes(".")) return;
  await env.DB.prepare(
    `INSERT INTO board_settings (key, value, updated_at) VALUES ('origin', ?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(origin, Date.now()).run();
  remembered = origin;
}

export function forgetOrigin() {
  remembered = null;
}

async function boardOrigin(env, url) {
  if (url.hostname.includes(".")) return url.origin;
  const row = await env.DB.prepare("SELECT value FROM board_settings WHERE key = 'origin'").first();
  return row?.value ?? null;
}

// ---- routes ----------------------------------------------------------------------------------------

const relay = (env) => env.PHONE.get(env.PHONE.idFromName(PHONE));
async function forward(env, path, request) {
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  return relay(env).fetch(new Request(`https://phone${path}`, { method: request.method, headers: request.headers, body }));
}

export async function phoneRoute(request, env, url, auth) {
  const path = url.pathname.slice("/v1/phone".length);
  const get = request.method === "GET";
  const post = request.method === "POST";
  // Public: what SideStore reads. None of it is the owner's; it's the app everyone installs.
  if (path === "/source.json" && get) return source(env, url);
  if (path === "/app.ipa" && get) return app(env, url);
  if (path === "/icon.png" && get) return icon();

  if (path === "/device") {
    if (!(await phoneAllowed(request, env))) return json({ error: "Not signed in." }, 401);
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "Hive Phone connects here with a WebSocket." }, 426);
    }
    return forward(env, "/device", request);
  }
  if (path === "/pair" && post) {
    if (!(await auth.allowed(request, env))) return json({ error: "Not signed in." }, 401);
    return pair(env, url);
  }
  if ((path === "/health" && get) || (path === "/agent/unlock" && post)) {
    if (!(await auth.allowed(request, env))) return json({ error: "Not signed in." }, 401);
    return forward(env, path, request);
  }
  if ((path === "/agent/unlock-now" && post) || path.startsWith("/api/")) {
    if (!(await auth.machineAllowed(request, env))) return json({ error: "Not signed in." }, 401);
    return forward(env, path + url.search, request);
  }
  return new Response("Not found", { status: 404 });
}

// POST /v1/phone/pair: what the owner copies on the iPhone before opening Hive Phone, and the
// SideStore source Hive Phone installs from.
async function pair(env, url) {
  const origin = await boardOrigin(env, url);
  if (!origin) {
    return json({ error: "The board doesn't know its own address yet; it learns it from the next call a Mac or the VM makes to it." }, 503);
  }
  const device = `${origin.replace(/^http/, "ws")}/v1/phone/device`;
  const pairing = PAIRING_PREFIX + base64url(JSON.stringify({ url: device, token: await phoneKey(env) }));
  const sourceUrl = `${origin}/v1/phone/source.json`;
  return json({ pairing, source: sourceUrl, sidestore: `sidestore://source?url=${encodeURIComponent(sourceUrl)}` });
}

const newestApp = (env) =>
  env.DB.prepare("SELECT version, sha256, size, notes, published_at FROM board_releases WHERE kind = 'phone' ORDER BY published_at DESC LIMIT 1").first();

/**
 * A phone release's version is "<year>.<monthday>.<hourminute>-<sources>". SideStore reads the first
 * part, and the IPA carries it as both its version and its build (mobile/relay/build.mjs), which
 * SideStore checks against the source.
 */
export function appVersion(version) {
  const shown = String(version).split("-")[0];
  return { version: shown, build: shown };
}

// GET /v1/phone/source.json: a SideStore (AltStore-format) source with Hive Phone's newest release.
async function source(env, url) {
  const release = await newestApp(env);
  const origin = url.origin;
  const apps = [];
  if (release) {
    const { version, build } = appVersion(release.version);
    const date = new Date(release.published_at).toISOString();
    const downloadURL = `${origin}/v1/phone/app.ipa?version=${encodeURIComponent(release.version)}`;
    const about = release.notes || "Hive Phone keeps this iPhone connected to your Hive, so Hive's agents can use it.";
    apps.push({
      name: "Hive Phone",
      bundleIdentifier: BUNDLE_ID,
      developerName: "Hive",
      subtitle: "Lets your Hive use this iPhone.",
      localizedDescription: "Hive Phone keeps this iPhone connected to your Hive, so Hive's agents can use it when you ask. "
        + "Open it once after copying the pairing from your dashboard.",
      iconURL: `${origin}/v1/phone/icon.png`,
      tintColor: "#F5A623",
      versions: [{ version, buildVersion: build, date, localizedDescription: about, downloadURL, size: release.size, minOSVersion: MIN_IOS }],
      // Older SideStore and AltStore read these instead of versions.
      version, versionDate: date, versionDescription: about, downloadURL, size: release.size,
      appPermissions: { entitlements: [], privacy: {} },
    });
  }
  return json({ name: "Hive", identifier: `hive.${url.hostname}`, sourceURL: `${origin}/v1/phone/source.json`, apps, news: [] },
    200, { "cache-control": "public, max-age=60" });
}

// GET /v1/phone/app.ipa[?version=…]: Hive Phone's IPA, the newest or the one asked for.
async function app(env, url) {
  const asked = clean(url.searchParams.get("version"), 40);
  const row = asked
    ? await env.DB.prepare("SELECT version, size FROM board_releases WHERE kind = 'phone' AND version = ?1").bind(asked).first()
    : await newestApp(env);
  const object = row && env.RELEASES ? await env.RELEASES.get(`phone/${row.version}`) : null;
  if (!object) return json({ error: asked ? `There's no Hive Phone ${asked}.` : "There's no Hive Phone release yet." }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(row.size),
      "content-disposition": 'attachment; filename="HivePhone.ipa"',
      "cache-control": asked ? "public, max-age=86400, immutable" : "no-store",
    },
  });
}

function icon() {
  return new Response(unbase64(ICON_PNG_BASE64), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}

// ---- sealing the passcode --------------------------------------------------------------------------

async function sealKey(env) {
  const base = await crypto.subtle.importKey("raw", encode(env.TASKS_TOKEN), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encode("hive-phone"), info: encode(SEAL_PURPOSE) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode(SEAL_PURPOSE) }, await sealKey(env), encode(text));
  return { iv: base64(iv), data: base64(new Uint8Array(data)) };
}

export async function unseal(env, record) {
  const text = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64(record.iv), additionalData: encode(SEAL_PURPOSE) }, await sealKey(env), unbase64(record.data),
  );
  return new TextDecoder().decode(text);
}

// ---- unlocking -------------------------------------------------------------------------------------

/** Unlocking stopped before or after typing; the message says which, and what the owner can do. */
export class NeedsUnlock extends Error {}

const PROMPT = "type == 'XCUIElementTypeStaticText' AND visible == 1 AND (label CONTAINS[c] 'enter passcode' OR label CONTAINS[c] 'enter iphone passcode')";
// Words that mean this isn't the plain unlock prompt, or that a try already failed: never type there.
const NOT_THE_LOCK_SCREEN = ["incorrect", "try again", "failed", "attempts remaining", "unavailable", "disabled", "new passcode",
  "change passcode", "reset", "erase", "payment", "pay ", "purchase"];

/**
 * Unlocks the iPhone with its saved passcode, through `phone(path, method, body)` (WebDriverAgent's
 * routes; `prefix` is "/session/<id>"). Wake with the home button, swipe up from just above the bottom
 * edge, wait for "Enter Passcode", check it's the system's plain unlock prompt with one secure field,
 * then one write of the passcode into that field. `beginAttempt` runs before the passcode goes in and
 * `endAttempt` only once the phone says it's unlocked, so an attempt nobody saw finish is never
 * repeated. Answers whether the phone was locked.
 */
export async function unlock(phone, prefix, { passcode, beginAttempt, endAttempt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const locked = async () => Boolean((await phone("/wda/locked")).value);
  if (!(await locked())) return false;
  const pin = await passcode();
  if (!pin) throw new NeedsUnlock("No passcode is saved for this iPhone; save it on the dashboard.");
  const prompt = async () => {
    const found = await phone(`${prefix}/elements`, "POST", { using: "predicate string", value: PROMPT });
    return Array.isArray(found.value) && found.value.length > 0;
  };
  if (!(await prompt())) {
    await phone(`${prefix}/wda/pressButton`, "POST", { name: "home" });
    await sleep(400);
    const size = (await phone(`${prefix}/window/size`)).value;
    const w = Number(size?.width);
    const h = Number(size?.height);
    if (!(w > 0 && h > 0)) throw new NeedsUnlock("The iPhone gave no screen size. No passcode was entered.");
    await phone(`${prefix}/actions`, "POST", { actions: [{ type: "pointer", id: "show-passcode", parameters: { pointerType: "touch" }, actions: [
      { type: "pointerMove", duration: 0, x: Math.round(w / 2), y: Math.round(h - 11) }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 300, x: Math.round(w / 2), y: Math.round(h * 0.2) }, { type: "pointerUp", button: 0 }] }] });
    let up = false;
    for (const until = now() + 6000; now() < until; ) {
      if (await prompt()) { up = true; break; }
      if (!(await locked())) return true;
      await sleep(200);
    }
    if (!up) throw new NeedsUnlock("The passcode keypad didn't come up after waking the iPhone and swiping up. No passcode was entered.");
  }
  const app = (await phone("/wda/activeAppInfo")).value;
  if (app?.bundleId !== "com.apple.springboard") throw new NeedsUnlock("The iPhone isn't showing its system passcode screen. No passcode was entered.");
  const tree = String((await phone(`${prefix}/source`)).value ?? "");
  const labels = [...tree.matchAll(/<XCUIElementType\w+\b[^>]*>/g)]
    .map((m) => Object.fromEntries([...m[0].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
    .filter((a) => a.visible === "true")
    .map((a) => a.label || "").join(" ").toLowerCase();
  if (NOT_THE_LOCK_SCREEN.some((word) => labels.includes(word)) || !(labels.includes("enter passcode") || labels.includes("enter iphone passcode"))) {
    throw new NeedsUnlock("This isn't the plain unlock passcode prompt, or it shows a failed try. No passcode was entered.");
  }
  const fields = await phone(`${prefix}/elements`, "POST", { using: "predicate string", value: "type == 'XCUIElementTypeSecureTextField' AND visible == 1" });
  if (!Array.isArray(fields.value) || fields.value.length !== 1) throw new NeedsUnlock("The passcode screen doesn't show exactly one passcode field. No passcode was entered.");
  const field = fields.value[0].ELEMENT || fields.value[0]["element-6066-11e4-a52e-4f735466cecf"];
  if (typeof field !== "string" || !/^[\w-]+$/.test(field)) throw new NeedsUnlock("Couldn't address the passcode field. No passcode was entered.");
  await beginAttempt();
  await phone(`${prefix}/element/${field}/value`, "POST", { value: [pin] });
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (!(await locked())) {
      await endAttempt();
      return true;
    }
  }
  throw new NeedsUnlock("The iPhone hasn't confirmed it's unlocked. Unlocking is paused: check the phone, then allow another try on the dashboard.");
}

// ---- the phone's Durable Object --------------------------------------------------------------------

/**
 * One per phone (wrangler.jsonc PHONE). Holds Hive Phone's WebSocket (hibernating while nothing is
 * asked), passes WebDriverAgent calls down it, keeps the sealed passcode, and unlocks.
 */
export class PhoneRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
    this.windowStart = 0;
    this.count = 0;
    this.unlocking = false;
    this.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/device") return this.connect(request);
    if (url.pathname === "/health") {
      const [passcode, paused] = await Promise.all([this.ctx.storage.get("passcode"), this.ctx.storage.get("unlockAttempt")]);
      const socket = this.socket();
      return json({ connected: Boolean(socket), version: socket?.deserializeAttachment?.()?.version ?? null,
        passcode: Boolean(passcode), paused: Boolean(paused) });
    }
    if (url.pathname === "/agent/unlock") return this.savePasscode(request);
    if (url.pathname === "/agent/unlock-now") return this.unlockNow();
    if (url.pathname.startsWith("/api/")) return this.call(request.method, url.pathname.slice(4) + url.search, await request.text());
    return json({ error: "Not found" }, 404);
  }

  connect(request) {
    for (const old of this.ctx.getWebSockets("device")) {
      this.drop(old);
      try { old.close(1000, "replaced"); } catch {}
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["device"]);
    pair[1].serializeAttachment({ version: clean(request.headers.get("x-hive-version"), 40) || "unknown" });
    this.ctx.storage.setAlarm(Date.now() + SEEN_EVERY_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  socket() {
    return this.ctx.getWebSockets("device").find((s) => s.readyState === 1) ?? null;
  }

  // While Hive Phone stays connected, its node stays fresh on the dashboard.
  async alarm() {
    const socket = this.socket();
    if (!socket) return;
    const version = socket.deserializeAttachment?.()?.version || "unknown";
    await sawNode(this.env, { kind: "phone", name: PHONE, version, protocol: null }).catch(() => {});
    await this.ctx.storage.setAlarm(Date.now() + SEEN_EVERY_MS);
  }

  /** One WebDriverAgent call down the socket, answered with what the phone said. */
  async call(method, path, body = "") {
    const socket = this.socket();
    if (!socket) return json({ error: "phone offline: Hive Phone isn't connected" }, 503);
    if (this.pending.size >= MOST_PENDING) return json({ error: "busy" }, 429);
    if (Date.now() - this.windowStart > 60_000) {
      this.windowStart = Date.now();
      this.count = 0;
    }
    if (++this.count > MOST_PER_MINUTE) return json({ error: "rate limit" }, 429);
    if (!WDA_PATH.test(path) || path.includes("..") || path.includes("%")) return json({ error: "invalid route" }, 400);
    if (!["GET", "POST", "DELETE"].includes(method)) return json({ error: "invalid method" }, 405);
    if (encode(body).length > MOST_BODY) return json({ error: "body too large" }, 413);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json({ error: "phone request timed out" }, 504));
      }, ANSWER_WITHIN_MS);
      this.pending.set(id, { resolve, timer, socket });
      try {
        socket.send(JSON.stringify({ id, method, path, body }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(json({ error: "phone disconnected" }, 503));
      }
    });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > MOST_REPLY) {
      socket.close(1009, "too large");
      this.drop(socket);
      return;
    }
    try {
      const m = JSON.parse(message);
      const item = this.pending.get(m.id);
      if (!item || item.socket !== socket) return;
      if (!Number.isInteger(m.status) || m.status < 200 || m.status > 599 || typeof m.body !== "string") throw new Error("invalid response");
      this.pending.delete(m.id);
      clearTimeout(item.timer);
      item.resolve(new Response([204, 205, 304].includes(m.status) ? null : m.body,
        { status: m.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }));
    } catch {
      socket.close(1003, "invalid response");
      this.drop(socket);
    }
  }

  webSocketClose(socket) {
    this.drop(socket);
  }

  webSocketError(socket) {
    this.drop(socket);
  }

  drop(socket) {
    for (const [id, p] of this.pending) {
      if (p.socket !== socket) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve(json({ error: "phone disconnected" }, 503));
    }
  }

  /** A WebDriverAgent call's JSON, or an error in words. */
  async phone(path, method = "GET", body) {
    const response = await this.call(method, path, body === undefined ? "" : JSON.stringify(body));
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value?.value?.error) throw new Error(value?.value?.message || value?.error || "Phone command failed");
    return value;
  }

  // POST /agent/unlock {passcode, consent: true} saves it; {remove: true} forgets it; {retry: true,
  // consent: true} allows another try after one the phone didn't confirm.
  async savePasscode(request) {
    if (this.unlocking) return json({ error: "The iPhone is being unlocked right now; try again in a moment." }, 409);
    const body = await request.json().catch(() => ({}));
    if (body.remove === true) {
      await this.ctx.storage.delete(["passcode", "unlockAttempt"]);
      return json({ saved: false });
    }
    if (body.retry === true && body.consent === true) {
      if (!(await this.ctx.storage.get("passcode"))) return json({ error: "No passcode is saved." }, 409);
      await this.ctx.storage.delete("unlockAttempt");
      return json({ retry: true });
    }
    if (typeof body.passcode !== "string" || !/^[!-~]{4,32}$/.test(body.passcode) || body.consent !== true) {
      return json({ error: "Give the iPhone's passcode and say Hive may type it at the lock screen." }, 400);
    }
    let device = null;
    try { device = (await this.phone("/wda/device/info")).value; } catch {}
    if (!device?.uuid || device.uuid === "unknown") {
      return json({ error: "Open Hive Phone on the iPhone first: the passcode is tied to that iPhone, so it's saved while the phone is connected." }, 409);
    }
    await this.ctx.storage.put("passcode", await seal(this.env, JSON.stringify({ device: device.uuid, passcode: body.passcode })));
    await this.ctx.storage.delete("unlockAttempt");
    return json({ saved: true });
  }

  async savedPasscode() {
    if (await this.ctx.storage.get("unlockAttempt")) {
      throw new NeedsUnlock("Unlocking is paused after a try the iPhone didn't confirm. Check the phone, then allow another try on the dashboard.");
    }
    const record = await this.ctx.storage.get("passcode");
    if (!record) return null;
    const saved = JSON.parse(await unseal(this.env, record));
    const device = (await this.phone("/wda/device/info")).value;
    if (!saved.device || device?.uuid !== saved.device) {
      throw new NeedsUnlock("Hive Phone was installed again since the passcode was saved; save it again on the dashboard.");
    }
    return saved.passcode;
  }

  // POST /agent/unlock-now: Hive's agents (the VM's phone tools, authenticate). Answers status only.
  async unlockNow() {
    if (this.unlocking) return json({ unlocked: false, error: "The iPhone is already being unlocked." }, 409);
    this.unlocking = true;
    try {
      const status = await this.phone("/status");
      let sid = status.sessionId;
      if (!sid) {
        const made = await this.phone("/session", "POST", { capabilities: { alwaysMatch: { shouldWaitForQuiescence: false } } });
        sid = made.sessionId || made.value?.sessionId;
      }
      if (!sid) throw new NeedsUnlock("The iPhone gave no WebDriver session.");
      const wasLocked = await unlock((p, m, b) => this.phone(p, m, b), `/session/${sid}`, {
        passcode: () => this.savedPasscode(),
        beginAttempt: () => this.ctx.storage.put("unlockAttempt", { at: Date.now() }),
        endAttempt: () => this.ctx.storage.delete("unlockAttempt"),
        sleep: this.sleep,
      });
      return json({ unlocked: true, wasLocked });
    } catch (error) {
      return json({ unlocked: false, error: String(error?.message || error) }, error instanceof NeedsUnlock ? 409 : 502);
    } finally {
      this.unlocking = false;
    }
  }
}
