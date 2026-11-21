#!/usr/bin/env node
// The owner's own browser, for Hive's agent on the VM: an MCP server over stdio that sends each command
// to the board in the cloud (cloud/tasks/browser.js), where the Hive extension in the owner's Safari or
// Chrome picks it up, runs it in that signed-in browser (browser/chrome/src/executor.js) and sends back
// what came of it. Nothing here reaches the Mac directly (owner, 2026-11-16: "every node should be
// able to reach every other node: through the cloud").
//
// The board's address and the machines' token are root's hive-tasks config
// (/root/.config/hive/tasks.json, or HIVE_TASKS_CONFIG), read as orchestrator.mjs reads it and never
// printed. Without it the server still answers, with no tools and a note saying why.
//
// The first browser that takes a command is the one the rest of the task uses (tab ids and snapshot
// refs only mean something in the browser that made them), unless a tool names another.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { nodeHeaders } from './version.mjs';
import { withHeard } from './meanwhile.mjs';

export const OFFLINE = "The owner's browser isn't reachable: this VM doesn't have the board's key "
  + '(/root/.config/hive/tasks.json), so the browser tools are unavailable.';
const NOT_CONNECTED = "No browser of the owner's is listening: the Hive extension isn't connected in their Safari or "
  + "Chrome right now (their Mac may be asleep). Use the VM's own browser (the desktop tools) instead, or say so.";
const FINISHED = new Set(['done', 'failed', 'expired', 'lost']);
// The board holds an answer open this long at most (browser.js MOST_WAIT_S).
const WAIT_S = 25;
// A queued command expires after 90 s and a running one is lost after 120 s, so this always ends.
const MOST_MS = 150_000;

/** Answers for when there's no board key: initialize, no tools, and an error for any call. */
export function offlineAnswer(message) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'browser', version: '1.0' }, instructions: OFFLINE });
  }
  if (message.method === 'tools/list') return reply({ tools: [] });
  if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: OFFLINE }], isError: true });
  if (message.method === 'ping') return reply({});
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
}

const step = { type: 'string', description: 'What this step is for, in a few words.' };
const tabId = { type: 'integer', minimum: 0, description: 'The tab to act on (from tabs, open or navigate). Without it, the active tab.' };
const ref = { type: 'string', description: 'An element ref from the latest snapshot of that tab, like "e12".' };
const selector = { type: 'string', description: 'A CSS selector, when there is no ref.' };
const browser = { type: 'string', enum: ['safari', 'chrome'],
  description: "Which of the owner's browsers. Leave it out to keep using the one this task already used." };
const tool = (name, description, properties, required = []) =>
  ({ name, description, inputSchema: { type: 'object', properties: { step, ...properties, browser }, required: ['step', ...required] } });

// Each tool is one of the extension's commands (bridge-core.js COMMAND_TYPES). There is deliberately no
// way to type into a password field or read one: signing in is the owner's or the desktop tools'.
export const TOOLS = [
  tool('tabs', "List the web pages open in the owner's browser, most recently used first, with each tab's id.",
    { limit: { type: 'integer', minimum: 1, maximum: 80 } }),
  tool('open', "Bring up the owner's tab for a site (the freshest tab whose address contains url_contains), or open url in a "
    + "new tab when none is open. Use this before navigate: the owner's signed-in tab is usually already there.",
  { url_contains: { type: 'string', description: 'Part of the address, like "canvas.wisc.edu".' },
    url: { type: 'string', description: 'What to open when no tab matches (https://…).' } }),
  tool('navigate', 'Load a page. Opens a new tab unless tab_id is given, so it never takes over a page the owner is on.',
    { url: { type: 'string', description: 'https://…' }, tab_id: tabId }, ['url']),
  tool('snapshot', "The buttons, links and fields on a tab, each with a ref for click, type, select, scroll and press_key. "
    + 'Take a new one after the page changes: refs only last until then.',
  { tab_id: tabId, max_elements: { type: 'integer', minimum: 1, maximum: 400 } }),
  tool('read', "A tab's text. mode: text (default), main_text, forms, landmarks or html. With ref or selector, only that part. "
    + 'A long page (an API answer, a big table) comes in pieces of up to max_chars: the result says when there is more and '
    + 'the offset to read the next piece from.',
    { tab_id: tabId, mode: { type: 'string', enum: ['text', 'main_text', 'forms', 'landmarks', 'html'] },
      max_chars: { type: 'integer', minimum: 1, maximum: 50_000 },
      offset: { type: 'integer', minimum: 0, description: 'Where to start reading, in characters (0 by default): the "more" line of the last piece gives it.' },
      ref, selector }),
  tool('click', 'Click a button, link or field.', { tab_id: tabId, ref, selector }),
  tool('type', 'Put text into a field (replacing what is there). submit: true also submits its form. Not for passwords.',
    { tab_id: tabId, ref, selector, text: { type: 'string' }, submit: { type: 'boolean' } }, ['text']),
  tool('select', 'Choose an option in a drop-down, by its value or its label.',
    { tab_id: tabId, ref, selector, value: { type: 'string' }, label: { type: 'string' } }),
  tool('scroll', 'Scroll an element into view.',
    { tab_id: tabId, ref, selector, block: { type: 'string', enum: ['start', 'center', 'end', 'nearest'] } }),
  tool('press_key', 'Press a key (Enter, Escape, Tab, ArrowDown…) in the element with ref or selector, or the focused one.',
    { tab_id: tabId, key: { type: 'string' }, ref, selector }, ['key']),
  tool('wait_for', 'Wait (up to 30 s) until a tab shows some text or an element matching selector.',
    { tab_id: tabId, text: { type: 'string' }, selector, timeout_ms: { type: 'integer', minimum: 100, maximum: 30_000 } }),
  tool('screenshot', 'A picture of what a tab shows (it brings that tab to the front of its window).', { tab_id: tabId }),
];

const COMMAND = { tabs: 'list_tabs', open: 'activate_tab', navigate: 'navigate', snapshot: 'snapshot', read: 'read_page',
  click: 'click', type: 'type', select: 'select', scroll: 'scroll', press_key: 'press_key', wait_for: 'wait_for',
  screenshot: 'capture' };

/** The extension's command for one tool call: {type, params}. */
export function commandFor(name, args = {}) {
  const type = COMMAND[name];
  if (!type) throw new Error(`No browser tool called ${name}.`);
  const params = {};
  const copy = (from, to = from) => { if (args[from] !== undefined && args[from] !== '') params[to] = args[from]; };
  copy('tab_id', 'tabId');
  copy('ref');
  copy('selector');
  if (name === 'tabs') copy('limit');
  if (name === 'open') { copy('url_contains', 'urlContains'); copy('url'); }
  if (name === 'navigate') {
    copy('url');
    if (params.tabId === undefined) params.newTab = true;
  }
  if (name === 'snapshot') copy('max_elements', 'maxElements');
  if (name === 'read') { copy('mode'); copy('max_chars', 'maxChars'); copy('offset'); }
  if (name === 'type') { copy('text'); if (args.submit === true) params.submit = true; }
  if (name === 'select') { copy('value'); copy('label'); }
  if (name === 'scroll') copy('block');
  if (name === 'press_key') copy('key');
  if (name === 'wait_for') { copy('text', 'textContains'); copy('timeout_ms', 'timeoutMs'); }
  return { type, params };
}

export function boardConfig(env = process.env) {
  const text = env.HIVE_TASKS_CONFIG
    ? readFileSync(env.HIVE_TASKS_CONFIG, 'utf8')
    : execFileSync('sudo', ['-n', 'cat', '/root/.config/hive/tasks.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const config = JSON.parse(text);
  if (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url) || !config.token) {
    throw new Error('the board config has no url or token');
  }
  return { url: config.url.replace(/\/+$/, ''), token: String(config.token), machine: config.machine || 'vm' };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Browser {
  constructor(config, { fetcher = fetch, clock = Date.now, pause = sleep } = {}) {
    this.config = config;
    this.fetch = fetcher;
    this.clock = clock;
    this.pause = pause;
    this.browser = ''; // the owner's browser this task is using, once one took a command
  }

  async board(path, body) {
    let response;
    try {
      response = await this.fetch(this.config.url + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout((WAIT_S + 15) * 1000),
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json', 'user-agent': 'hive-vm-browser',
          ...nodeHeaders(this.config.machine || 'vm') },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? 'The board took too long to answer.' : "Couldn't reach the board in the cloud.");
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `The board said ${response.status}.`);
    return value;
  }

  /** Sends one command and waits for what came of it: the extension's result, or an error in words. */
  async run(action, choice) {
    if (choice) this.browser = '';
    const target = choice || this.browser;
    const started = this.clock();
    let answer = await this.board('/v1/browser/commands', { action, browser: target, wait: WAIT_S });
    // Nobody can take it: say so now, and cancel it so no browser that connects later runs it late.
    const giveUp = async message => {
      await this.board('/v1/browser/cancel', { id: answer.command.id }).catch(() => {});
      throw new Error(message);
    };
    while (!FINISHED.has(answer.command?.status)) {
      if (!answer.command?.id) throw new Error("The board didn't say what became of the command.");
      if (answer.command.status === 'queued') {
        const listening = answer.browsers ?? [];
        if (!listening.length) await giveUp(NOT_CONNECTED);
        if (target.includes('/') && !listening.includes(target)) {
          await giveUp(`The owner's ${target.split('/').pop()} stopped listening. Listening now: ${listening.join(', ')} `
            + '(pass browser to use one of those; tab ids from the other browser mean nothing there).');
        }
      }
      if (this.clock() - started > MOST_MS) await giveUp('The browser never answered.');
      answer = await this.board(`/v1/browser/commands?id=${answer.command.id}&wait=${WAIT_S}`);
    }
    const { command } = answer;
    if (command.status === 'expired') {
      const listening = answer.browsers ?? [];
      if (!listening.length) throw new Error(NOT_CONNECTED);
      throw new Error(`${target ? `The owner's ${target.split('/').pop()}` : 'No browser'} didn't take it in time. `
        + `Listening now: ${listening.join(', ')}.`);
    }
    if (command.status !== 'done') throw new Error(command.error || 'The browser said it failed.');
    if (command.browser) this.browser = command.browser;
    return { result: command.result ?? {}, browser: command.browser || target || 'browser' };
  }
}

const where = r => [r.tabId !== undefined ? `tab ${r.tabId}` : '', r.title ? JSON.stringify(String(r.title).slice(0, 120)) : '',
  r.url ? String(r.url).slice(0, 300) : ''].filter(Boolean).join(' ');

/** What the model reads back for one command's result. */
export function describeResult(type, result, browser) {
  const text = message => ({ type: 'text', text: message });
  const by = `(${browser.split('/').pop()})`;
  if (type === 'list_tabs') {
    const rows = (result.tabs ?? []).map(t => `tab ${t.tabId}${t.active ? ' (active)' : ''}: ${JSON.stringify(String(t.title ?? '').slice(0, 120))} ${t.url ?? ''}`);
    return [text(rows.length ? `${rows.length} open tab(s) ${by}:\n${rows.join('\n')}` : `No web pages are open ${by}.`)];
  }
  if (type === 'snapshot') {
    const rows = (result.elements ?? []).map(e => {
      let line = `${e.ref} ${e.role}${e.inputType && e.role === 'textbox' ? `[${e.inputType}]` : ''} ${JSON.stringify(String(e.name ?? '').slice(0, 100))}`;
      if (e.disabled) line += ' (disabled)';
      if (e.checked !== undefined) line += e.checked ? ' (checked)' : ' (unchecked)';
      if (e.href) line += ` → ${String(e.href).slice(0, 160)}`;
      return line;
    });
    return [text(`${where(result)} ${by}\n${rows.length ? rows.join('\n') : 'Nothing to click or type into.'}`)];
  }
  if (type === 'read_page') {
    const content = String(result.content ?? '');
    const from = Number(result.offset) || 0;
    const part = Number.isInteger(result.total) && (from > 0 || Number.isInteger(result.next))
      ? ` characters ${from}–${from + content.length} of ${result.total}` : '';
    const more = Number.isInteger(result.next)
      ? `\n[${result.total - result.next} more characters: read again with offset ${result.next}]` : '';
    return [text(`${where(result)} ${by}${part}\n${content}${more}`)];
  }
  if (type === 'capture') {
    const data = /^data:image\/png;base64,(.+)$/.exec(String(result.imageDataUrl ?? ''))?.[1];
    if (!data) return [text(`${where(result)} ${by}: the browser sent no picture.`)];
    return [text(`${where(result)} ${by}`), { type: 'image', data, mimeType: 'image/png' }];
  }
  return [text([result.message ?? 'Done.', where(result) && `— ${where(result)}`, by].filter(Boolean).join(' '))];
}

export async function callTool(browserClient, name, args = {}) {
  const action = commandFor(name, args);
  const { result, browser: ran } = await browserClient.run(action, args.browser);
  return describeResult(action.type, result, ran);
}

export async function answer(browserClient, message) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'browser', version: '1.0' },
        instructions: "The owner's own Safari or Chrome on their Mac, signed in as them, reached through the cloud." });
    case 'tools/list': return reply({ tools: TOOLS });
    case 'ping': return reply({});
    case 'tools/call':
      try {
        return reply({ content: await callTool(browserClient, message.params?.name, message.params?.arguments ?? {}) });
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
    // One browser, one command at a time: calls run in order.
    chain = chain.then(async () => {
      const out = withHeard(await handle(message));
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let client = null;
  try { client = new Browser(boardConfig()); } catch {}
  serve(client ? message => answer(client, message) : async message => offlineAnswer(message));
}
