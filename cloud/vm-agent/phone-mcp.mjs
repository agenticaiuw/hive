#!/usr/bin/env node
// The owner's iPhone, for Hive's agent on the VM: an MCP server over stdio that talks straight to the
// phone's relay in the cloud (a Cloudflare Worker the iPhone's WebDriverAgent relay app keeps a
// connection open to). Nothing here goes through the Mac: Hive's cloud agent reaches the phone on its
// own, so "Hey Siri, ask Hive…" from across the room works with the Mac asleep or locked.
//
// The relay is the board's own (cloud/tasks/phone.js, /v1/phone): Hive Phone (mobile/relay) on the
// iPhone keeps a WebSocket open to it, and this reaches it with the board's address and key, the ones
// every tool here uses (/root/.config/hive/tasks.json). A phone still on a relay of its own is reached
// there instead: <state>/phone-relay.json ({"url", "token"}, mode 600). Either is read when needed and
// never printed. Unlocking is the relay's: it keeps the passcode sealed and types it at the phone's
// passcode screen itself (POST …/agent/unlock-now), so the passcode never reaches this process or the
// model. With neither, it still answers, with no tools and a note saying so, so the task can say why
// it can't use the phone instead of failing to start.
//
// Several of Hive's tasks can run at once, but the phone is one: a call waits for this task's turn at
// it (devices.mjs, served by the orchestrator; HIVE_TASK_LABEL names the task). The turn passes to a
// task waiting for the phone after a minute without a phone call, and comes back in line for the next.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Lease } from './devices.mjs';
import { boardConfig } from './browser-mcp.mjs';

const STATE = process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state');
const CONFIG = join(STATE, 'phone-relay.json');
export const OFFLINE = "The owner's phone isn't reachable: this VM has neither the board's address and key "
  + '(/root/.config/hive/tasks.json) nor a phone relay of its own, so the phone tools are unavailable.';
export const HIVE_PHONE_DOWN = "Hive Phone isn't connected: it has to be open on the iPhone (it reconnects by itself while it's "
  + "open). The owner opens it when they next have the phone in hand; if it isn't paired yet, they copy the pairing from the dashboard first.";
const RELAY_DOWN = "The iPhone isn't connected to its relay. Its WebDriverAgent relay app (WebDriverAgentRunner-Runner) "
  + 'has to be open on the phone; the owner reopens it when they next have the phone in hand.';

/** Answers for when the relay key isn't there: initialize, no tools, and an error for any call. */
export function offlineAnswer(message) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'phone', version: '2.0' }, instructions: OFFLINE });
  }
  if (message.method === 'tools/list') return reply({ tools: [] });
  if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: OFFLINE }], isError: true });
  if (message.method === 'ping') return reply({});
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
}

const point = description => ({ type: 'number', description });
const look = { type: 'boolean', description: 'Also return a screenshot after this (default false).' };
const step = { type: 'string', description: 'What this step is for, in a few words.' };

export const TOOLS = [
  { name: 'authenticate',
    description: 'Unlock the iPhone with its saved passcode. The phone relay in the cloud keeps the passcode sealed and types it '
      + 'at the passcode keypad itself; nothing secret passes through you. On a locked iPhone just call this: it wakes the '
      + 'screen and brings up the keypad itself (don\'t swipe to it first). On an unlocked one it only wakes the screen. '
      + 'Returns status only. If it fails, stop using the phone and say why; never retry it or ask for the passcode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'screenshot', description: "See the iPhone's screen. Every x/y in the other tools is a pixel in this image.",
    inputSchema: { type: 'object', properties: {} } },
  { name: 'tap', description: "Tap the phone's screen at (x, y).",
    inputSchema: { type: 'object', properties: { x: point('x in the latest phone screenshot'), y: point('y in the latest phone screenshot'),
      step, screenshot: look }, required: ['x', 'y'] } },
  { name: 'tap_element', description: 'Tap a button, link or field by its label (from elements, or the text on it). More reliable '
      + 'than coordinates for small targets.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' }, step, screenshot: look }, required: ['label'] } },
  { name: 'swipe', description: 'Drag a finger from one point to another: to scroll a list swipe up (from_y > to_y), to go back '
      + 'swipe right from the left edge, to search the home screen swipe down from its middle.',
    inputSchema: { type: 'object', properties: { from_x: point('Start x'), from_y: point('Start y'), to_x: point('End x'),
      to_y: point('End y'), screenshot: look }, required: ['from_x', 'from_y', 'to_x', 'to_y'] } },
  { name: 'type_text', description: "Type into the field that has focus (tap it first). '\\n' presses Return.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, step, screenshot: look }, required: ['text'] } },
  { name: 'press_home', description: 'Go to the home screen of an unlocked iPhone. On a locked one it does nothing (going home on a '
      + 'locked iPhone freezes its relay); unlock with authenticate.',
    inputSchema: { type: 'object', properties: { screenshot: look } } },
  { name: 'open_app', description: 'Open an app by its bundle id, e.g. com.apple.mobilesafari, com.apple.MobileSMS, '
      + 'com.apple.mobilenotes, com.apple.mobilemail, com.apple.Maps, com.apple.Preferences, com.apple.mobiletimer, '
      + 'com.apple.reminders, com.apple.mobilecal, com.duosecurity.DuoMobile. For an app whose id you don\'t know, swipe down '
      + 'on the home screen and type its name.',
    inputSchema: { type: 'object', properties: { bundle_id: { type: 'string' }, screenshot: look }, required: ['bundle_id'] } },
  { name: 'elements', description: "List what's on the phone's screen (buttons, fields, text) with the center of each, from the "
      + 'accessibility tree: exact positions (in screenshot pixels) and labels for tap or tap_element.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'wait', description: 'Wait for something on the phone to load, then look again.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', minimum: 0.1, maximum: 30 }, screenshot: look },
      required: ['seconds'] } },
];

const ATTR = /([\w]+)="([^"]*)"/g;
const unescape = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const NAMED = new Set(['Button', 'StaticText', 'TextField', 'SecureTextField', 'SearchField', 'Link', 'Cell', 'Switch', 'Icon',
  'Image', 'Key', 'TextView', 'Tab', 'MenuItem', 'Slider', 'PageIndicator', 'NavigationBar', 'Alert', 'SegmentedControl']);

/** The visible, named things in WebDriverAgent's page source: `(x, y) Button "Send"`, x/y the center scaled by `scale`. */
export function visibleElements(xml, scale = 1, max = 300) {
  const lines = [];
  const seen = new Set();
  for (const match of String(xml).matchAll(/<XCUIElementType(\w+)\b[^>]*>/g)) {
    const type = match[1];
    if (!NAMED.has(type)) continue;
    const a = Object.fromEntries([...match[0].matchAll(ATTR)].map(m => [m[1], unescape(m[2])]));
    if (a.visible !== 'true') continue;
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(k => Number(a[k]));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const label = (a.label || a.name || '').trim();
    const value = type === 'SecureTextField' ? '' : (a.value || '').trim();
    if (!label && !value) continue;
    const cx = Math.round((x + w / 2) * scale), cy = Math.round((y + h / 2) * scale);
    let line = `(${cx}, ${cy}) ${type} ${JSON.stringify(label.slice(0, 80))}`;
    if (value && value !== label) line += ` value=${JSON.stringify(value.slice(0, 80))}`;
    if (a.enabled === 'false') line += ' (disabled)';
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= max) break;
  }
  return lines;
}

/** A PNG's size from its header. */
export function pngSize(png) {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Where the phone is: its own relay when this VM has one (phone-relay.json), else the board's. */
export function relayConfig(file = CONFIG, board = boardConfig) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { url, token } = board();
    return { url: `${url}/v1/phone`, token, down: HIVE_PHONE_DOWN };
  }
  const value = JSON.parse(text);
  if (typeof value.url !== 'string' || !/^https:\/\//.test(value.url) || typeof value.token !== 'string' || !value.token) {
    throw new Error('phone-relay.json needs {"url": "https://…", "token": "…"}');
  }
  return { url: value.url.replace(/\/+$/, ''), token: value.token, down: RELAY_DOWN };
}

export class Phone {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetch = fetcher;
    this.sid = null;
    this.scale = null; // screenshot pixels per screen point
  }

  async raw(path, method = 'GET', body, timeout = 30_000) {
    let response;
    try {
      response = await this.fetch(this.config.url + path, {
        method, signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? 'The phone relay took too long to answer.' : "Couldn't reach the phone relay.");
    }
    const value = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, value };
  }

  /** A WebDriverAgent request through the relay (`/api…`), its JSON or an error in words. */
  async wda(path, method = 'GET', body, timeout) {
    const { ok, value } = await this.raw(`/api${path}`, method, body, timeout);
    const failure = value?.value?.error ? (value.value.message || value.value.error) : (!ok ? (value.error || 'Phone command failed') : null);
    if (failure) {
      if (/offline|disconnected|not connected|unavailable|timed out/i.test(String(failure))) throw new Error(this.config.down ?? RELAY_DOWN);
      throw new Error(String(failure).split('\n')[0].slice(0, 300));
    }
    return value;
  }

  async session() {
    if (this.sid) return this.sid;
    const status = await this.wda('/status');
    let sid = status.sessionId;
    if (!sid) {
      const made = await this.wda('/session', 'POST', { capabilities: { alwaysMatch: { shouldWaitForQuiescence: false } } });
      sid = made.sessionId || made.value?.sessionId;
    }
    if (!sid) throw new Error('The phone relay gave no WebDriver session.');
    this.sid = sid;
    return sid;
  }

  async inSession(path, method = 'GET', body, timeout) {
    const sid = await this.session();
    try {
      return await this.wda(`/session/${sid}${path}`, method, body, timeout);
    } catch (error) {
      if (!/invalid session|session.*(not|does not) exist/i.test(error.message)) throw error;
      this.sid = null;
      return this.wda(`/session/${await this.session()}${path}`, method, body, timeout);
    }
  }

  async locked() {
    const { value } = await this.wda('/wda/locked');
    if (typeof value !== 'boolean') throw new Error("The iPhone didn't say whether it's locked.");
    return value;
  }

  async screenshot() {
    const { value } = await this.wda('/screenshot', 'GET', undefined, 45_000);
    if (typeof value !== 'string' || !value) throw new Error('The phone returned no screenshot.');
    const png = Buffer.from(value, 'base64');
    const size = pngSize(png);
    if (size) {
      const window = (await this.inSession('/window/size')).value;
      if (window?.width > 0) this.scale = size.width / window.width;
    }
    return png;
  }

  async ratio() {
    if (!this.scale) await this.screenshot();
    return this.scale || 1;
  }

  async points(x, y) {
    for (const n of [x, y]) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 10_000) throw new Error('Give x and y as numbers in the latest screenshot.');
    const s = await this.ratio();
    return [Math.round(x / s), Math.round(y / s)];
  }

  async tap(x, y) {
    const [px, py] = await this.points(x, y);
    await this.inSession('/actions', 'POST', { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x: px, y: py }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 }] }] });
  }

  async swipe(fromX, fromY, toX, toY) {
    const [ax, ay] = await this.points(fromX, fromY);
    const [bx, by] = await this.points(toX, toY);
    await this.inSession('/actions', 'POST', { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x: ax, y: ay }, { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 300, x: bx, y: by }, { type: 'pointerUp', button: 0 }] }] });
  }

  async tapElement(label) {
    if (typeof label !== 'string' || !label || label.length > 300) throw new Error('Give the label of something on screen.');
    const literal = JSON.stringify(label);
    let found;
    try {
      found = (await this.inSession('/element', 'POST', { using: 'accessibility id', value: label })).value;
    } catch {
      try {
        found = (await this.inSession('/element', 'POST', { using: 'predicate string',
          value: `visible == 1 AND (name == ${literal} OR label == ${literal} OR label CONTAINS[c] ${literal})` })).value;
      } catch {
        throw new Error(`Nothing called ${literal} on screen.`);
      }
    }
    const id = found?.ELEMENT || found?.['element-6066-11e4-a52e-4f735466cecf'];
    if (!id) throw new Error(`Nothing called ${literal} on screen.`);
    await this.inSession(`/element/${encodeURIComponent(id)}/click`, 'POST', {});
  }

  async typeText(text) {
    if (typeof text !== 'string' || !text) throw new Error('Give the text to type.');
    await this.inSession('/wda/keys', 'POST', { value: [...text] });
  }

  async home() {
    if (await this.locked()) throw new Error('The iPhone is locked, so it didn\'t go home (that freezes its relay). Call authenticate first.');
    await this.wda('/wda/homescreen', 'POST', {});
  }

  async openApp(bundleId) {
    if (typeof bundleId !== 'string' || !/^[-\w.]{3,200}$/.test(bundleId)) throw new Error(`${JSON.stringify(bundleId)} isn't an app's bundle id (like com.apple.mobilesafari).`);
    if (await this.locked()) throw new Error('The iPhone is locked. Call authenticate first, then open the app.');
    await this.inSession('/wda/apps/activate', 'POST', { bundleId });
  }

  async elements() {
    const { value } = await this.inSession('/source', 'GET', undefined, 45_000);
    return visibleElements(value, await this.ratio());
  }

  async frontApp() {
    try {
      const { value } = await this.wda('/wda/activeAppInfo');
      return value?.bundleId ? `${value.name || '?'} (${value.bundleId})` : 'unknown';
    } catch { return 'unknown'; }
  }

  /** The relay's own unlock: it reads the sealed passcode and types it; this only learns whether it worked. */
  async authenticate() {
    const { status, value } = await this.raw('/agent/unlock-now', 'POST', {}, 150_000);
    this.sid = null; // the relay may have opened a new session
    if (value?.unlocked) return value.wasLocked ? 'Unlocked the iPhone.' : 'The iPhone was already unlocked; its screen is awake.';
    throw new Error(`Phone unlock didn't go through${value?.error ? `: ${value.error}` : ` (relay said ${status})`}. `
      + "Don't retry; stop using the phone and say why.");
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function callTool(phone, name, args = {}) {
  const text = message => ({ type: 'text', text: message });
  const after = async message => {
    if (!args.screenshot) return [text(message)];
    await sleep(700);
    const png = await phone.screenshot();
    return [text(`${message} Front app: ${await phone.frontApp()}.`), { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
  };
  switch (name) {
    case 'authenticate': return [text(await phone.authenticate())];
    case 'screenshot': {
      const png = await phone.screenshot();
      const size = pngSize(png);
      return [text(`The iPhone's screen${size ? ` (${size.width}×${size.height})` : ''}. Front app: ${await phone.frontApp()}.`),
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
    }
    case 'tap': await phone.tap(args.x, args.y); return after(`Tapped (${args.x}, ${args.y}).`);
    case 'tap_element': await phone.tapElement(args.label); return after(`Tapped ${JSON.stringify(args.label)}.`);
    case 'swipe': await phone.swipe(args.from_x, args.from_y, args.to_x, args.to_y); return after('Swiped.');
    case 'type_text': await phone.typeText(args.text); return after('Typed it.');
    case 'press_home': await phone.home(); return after('Went to the home screen.');
    case 'open_app': await phone.openApp(args.bundle_id); return after(`Opened ${args.bundle_id}.`);
    case 'elements': {
      const lines = await phone.elements();
      return [text(lines.length ? `Front app: ${await phone.frontApp()}.\n${lines.join('\n')}` : 'Nothing named is on screen; take a screenshot.')];
    }
    case 'wait': {
      const seconds = Math.min(30, Math.max(0.1, Number(args.seconds) || 1));
      await sleep(seconds * 1000);
      return after(`Waited ${seconds}s.`);
    }
    default: throw new Error(`No phone tool called ${name}.`);
  }
}

const TURN = new Lease(join(STATE, 'devices.sock'), 'phone', process.env.HIVE_TASK_LABEL || 'a task started by hand',
  { waitMs: 10 * 60_000 });

export async function answer(phone, message, turn = TURN) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'phone', version: '2.0' },
        instructions: "The owner's real iPhone, reached through its relay in the cloud. If it's locked, call authenticate first." });
    case 'tools/list': return reply({ tools: TOOLS });
    case 'ping': return reply({});
    case 'tools/call':
      try {
        return reply({ content: await turn.use(() => callTool(phone, message.params?.name, message.params?.arguments ?? {})) });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: error.message }], isError: true });
      }
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
  }
}

function serve(handle) {
  let chain = Promise.resolve();
  createInterface({ input: process.stdin }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    // One phone, one finger: calls run in order.
    chain = chain.then(async () => {
      const out = await handle(message);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let phone = null;
  try { phone = new Phone(relayConfig()); } catch {}
  serve(phone ? message => answer(phone, message) : async message => offlineAnswer(message));
}
