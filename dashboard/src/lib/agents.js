/**
 * The owner's agents, one row each, and what talking to one reads as.
 *
 * An agent is anything the owner can open and talk to (the owner, 2026-11-16: "make it similar to
 * claude code where i can click into each agent and also directly talk to each agent"):
 *
 *   - a Claude Code or Codex session on one of the owner's Macs ("claude:<session>"), from its run,
 *     or from the tasks it holds when it never streamed a run;
 *   - Hive on a Mac, or a browser extension's own agent, from its run;
 *   - Hive in the cloud: one conversation per thread of requests, a follow-up joined to what it follows.
 *
 * Each row says what it is, where, whether it's working or needs the owner, its newest line, and
 * every unfinished task it holds ("an easy way to see all the active agents and also all of the tasks
 * an agent is claiming"). A conversation is what the owner said (with how each message got there),
 * what the agent said, and its work in between folded into one line per stretch ("Ran 3 commands and
 * edited 2 files"), each step a short line inside, never a raw dump.
 *
 * Plain JavaScript so `node --test` can load it without a build.
 */
import { HARNESSES, needsOwner, nodeName } from './tasks.js';

/** @typedef {import('./tasks.js').Task} Task */
/** @typedef {import('./tasks.js').Run} Run */
/** @typedef {import('./tasks.js').Step} Step */

/** The statuses a task an agent holds can be in until it ends. */
const UNFINISHED = ['waiting', 'active', 'blocked', 'open'];
/** A run that hasn't moved in this long isn't working any more, whatever it last said. */
const QUIET = 20 * 60;
/** An agent with nothing left to do stays in the list this long after its last step. */
const RECENT = 24 * 3600;
const GOING = ['queued', 'planning', 'working'];

/**
 * @typedef {{key: string, kind: 'session'|'hive'|'browser'|'cloud', machine: string, run: string,
 *   request: number, harness: string, session: string, label: string, place: string, title: string,
 *   status: 'needs-you'|'working'|'idle', updated: number, latest: string, tasks: Task[],
 *   steps: Step[], requests: any[], runs: Run[]}} Agent
 */

/**
 * What an agent or the board wrote, its task numbers ("on T246", the ledger's own handle, which
 * each machine counts by itself) as those tasks' titles: the owner sees no code names (T320). A
 * number it doesn't know stays as it is.
 * @param {string} text
 * @param {string} machine where it was written
 * @param {Map<string, string>} titles "<machine>:<id>" → title
 */
export function withTitles(text, machine, titles) {
  return text.replace(/\bT(\d+)\b/g, (whole, n) => {
    const title = titles.get(`${machine}:${n}`);
    return title ? `“${title}”` : whole;
  });
}

/**
 * Every agent worth showing: needing the owner first, then working, then the rest, newest first.
 * @param {{now: number, tasks: Task[], runs: Run[], requests: any[]}} board
 * @returns {Agent[]}
 */
export function agents(board) {
  const now = board.now;
  /** @type {Map<string, Agent>} */
  const by = new Map();
  /** @param {string} key @param {() => Omit<Agent, 'key'|'tasks'|'steps'|'requests'|'runs'|'status'|'updated'|'latest'>} make */
  const row = (key, make) => {
    let a = by.get(key);
    if (!a) {
      a = { key, ...make(), status: 'idle', updated: 0, latest: '', tasks: [], steps: [], requests: [], runs: [] };
      by.set(key, a);
    }
    return a;
  };

  // Hive in the cloud: a thread of requests, each follow-up under the first one it follows.
  const requests = new Map((board.requests ?? []).map((r) => [r.id, r]));
  const rootOf = (/** @type {string} */ id) => {
    let r = requests.get(id);
    const seen = new Set();
    while (r?.follows && requests.has(r.follows) && !seen.has(r.id)) {
      seen.add(r.id);
      r = requests.get(r.follows);
    }
    return r?.id ?? id;
  };
  for (const r of [...requests.values()].sort((a, b) => a.created - b.created)) {
    const root = rootOf(r.id);
    const a = row(`cloud|${root}`, () => ({
      kind: 'cloud', machine: 'cloud', run: '', request: 0, harness: 'hive', session: '',
      label: 'Hive', place: 'in the cloud', title: requests.get(root)?.text ?? r.text,
    }));
    a.requests.push(r);
    a.request = Number(String(r.id).replace(/^R/, '')) || a.request;
    a.updated = Math.max(a.updated, r.updated);
    a.status = GOING.includes(r.status) ? 'working' : 'idle';
    a.latest = r.outcome || (GOING.includes(r.status) ? 'Working on it' : '');
  }

  for (const run of board.runs ?? []) {
    if (run.request) {
      const a = by.get(`cloud|${rootOf(run.request)}`);
      if (a) {
        a.runs.push(run);
        const said = lastSaid(run.steps);
        if (said && GOING.includes(a.requests.at(-1)?.status)) a.latest = said;
      }
      continue;
    }
    const kind = run.session ? 'session' : run.machine.startsWith('ext:') ? 'browser' : 'hive';
    const a = row(`${run.machine}|${run.run}`, () => ({
      kind, machine: run.machine, run: run.run, request: 0, harness: run.harness, session: run.session,
      label: kind === 'session' ? HARNESSES[/** @type {keyof typeof HARNESSES} */ (run.harness)] ?? run.harness
        : kind === 'browser' ? nodeName(run.machine) : 'Hive',
      place: placeOf(run.projectName, run.machine, kind),
      title: oneLine(run.title),
    }));
    a.runs.push(run);
    a.steps = run.steps;
    a.updated = Math.max(a.updated, run.updated);
    if (run.status === 'working' && now - run.updated <= QUIET) a.status = 'working';
    a.latest = lastSaid(run.steps) || lastLine(run.steps);
  }

  for (const t of board.tasks ?? []) {
    if (!UNFINISHED.includes(t.status)) continue;
    let a;
    if (t.machine === 'cloud') {
      a = by.get(`cloud|${rootOf(`R${Math.floor(Number(String(t.id).replace(/^T/, '')) / 100)}`)}`);
    } else if (t.session && t.harness) {
      const kind = ['claude', 'codex'].includes(t.harness) ? 'session' : 'hive';
      a = row(`${t.machine}|${t.harness}:${t.session}`, () => ({
        kind, machine: t.machine, run: `${t.harness}:${t.session}`, request: 0, harness: t.harness,
        session: t.session, label: HARNESSES[/** @type {keyof typeof HARNESSES} */ (t.harness)] ?? t.harness,
        place: placeOf(t.projectName, t.machine, kind), title: '',
      }));
      a.updated = Math.max(a.updated, t.updated);
    }
    a?.tasks.push(t);
  }

  const order = { 'needs-you': 0, working: 1, idle: 2 };
  return [...by.values()]
    .map((a) => {
      a.tasks.sort((x, y) => UNFINISHED.indexOf(x.status) - UNFINISHED.indexOf(y.status) || y.updated - x.updated);
      // Waiting on an answer, or stuck with Hive's own tries spent: it goes nowhere until the owner acts.
      if (a.tasks.some(needsOwner)) a.status = 'needs-you';
      // What it's on, in the owner's terms: the task it's doing, never a bare "Working".
      const on = a.tasks.find((t) => t.status === 'active') ?? a.tasks[0];
      a.title = (a.kind === 'cloud' ? a.title : on?.title || a.title) || lastAsked(a.steps) || `${a.label} ${a.place}`;
      return a;
    })
    .filter((a) => a.status !== 'idle' || a.tasks.length || now - a.updated <= RECENT)
    .sort((x, y) => order[x.status] - order[y.status] || y.updated - x.updated);
}

/** Each unfinished task's agent, by the task's key. */
export function agentOfTask(/** @type {Agent[]} */ list) {
  /** @type {Map<string, Agent>} */
  const of = new Map();
  for (const a of list) for (const t of a.tasks) of.set(t.key, a);
  return of;
}

/**
 * Why a task hasn't started, or why it's stuck: what its agent said when it says, else what can be
 * read from its agent (the owner: "when it's not started, it needs a reason as well").
 * @param {Task} task
 * @param {Agent | undefined} agent
 */
export function reasonFor(task, agent) {
  if (task.retrying) return `Hive is continuing it for you. It was stuck on: ${task.outcome || "something its agent didn't say"}`;
  if (task.outcome) return task.outcome;
  if (task.status === 'blocked') return "Its agent didn't say what's in the way. Continue asks it.";
  if (!agent) return 'No agent has it yet. Continue hands it to one.';
  if (agent.kind === 'cloud') {
    const r = agent.requests.at(-1);
    if (r?.status === 'queued') return "Hive in the cloud hasn't picked it up yet.";
    if (GOING.includes(r?.status)) return 'Hive in the cloud is on an earlier step first.';
    return 'Hive in the cloud stopped before it got here. Continue asks it again.';
  }
  const on = agent.tasks.find((t) => t.status === 'active' && t !== task);
  if (agent.status !== 'idle') {
    return on ? `Its agent is on “${on.title}” first.` : 'Its agent is busy with something else first.';
  }
  return on
    ? `Its session stopped while on “${on.title}”, before getting here. Continue starts it again.`
    : 'Its session stopped before starting it. Continue starts it again.';
}

/** How a message to an agent is getting there, in words. */
export function deliveryWords(/** @type {{status: string, detail?: string}} */ m) {
  if (m.status === 'delivered') return m.detail || 'Delivered';
  if (m.status === 'failed') return m.detail || "Didn't reach it";
  if (m.status === 'taken') return 'On its way';
  return 'Waiting to reach it';
}

/**
 * @typedef {{verb: string, target: string, group: string, failed?: boolean, n?: number, full?: string}} Line
 * @typedef {{type: 'owner', key: string, at: number, text: string, state?: string, detail?: string, about?: string}
 *   | {type: 'agent', key: string, at: number, text: string, failed?: boolean}
 *   | {type: 'note', key: string, at: number, text: string}
 *   | {type: 'work', key: string, at: number, lines: Line[], summary: string}} Item
 */

const WAKE = /^The owner just sent you (?:this message|these messages) from the Hive dashboard, in their own words\. Read (?:it|them) and act on (?:it|them) now:\n/;

/**
 * A conversation from a run's steps and the owner's messages to it, in order.
 * @param {Step[]} steps
 * @param {any[]} [messages] board_run_messages rows: {id, text, status, detail, created_at}
 * @returns {Item[]}
 */
export function conversation(steps, messages = []) {
  const sent = messages.map((m) => ({ ...m, at: Number(m.created_at ?? m.created) || 0 }));
  const said = new Set(sent.map((m) => squash(m.text)));
  /** @type {({step: Step} | {message: any})[]} */
  const events = [
    ...[...steps].sort((a, b) => a.n - b.n).map((step) => ({ step, at: step.at, order: step.n })),
    ...sent.map((message) => ({ message, at: message.at, order: Infinity })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);

  /** @type {Item[]} */
  const items = [];
  /** @type {Extract<Item, {type: 'work'}> | null} */
  let work = null;
  const flush = () => {
    if (work) {
      work.summary = summary(work.lines);
      items.push(work);
    }
    work = null;
  };
  for (const e of events) {
    if ('message' in e) {
      flush();
      items.push(fromMessage(e.message));
      continue;
    }
    const s = e.step;
    if (s.kind === 'asked') {
      // A session woken with the owner's messages shows them as asked: they're already here, with
      // how they got there.
      const words = s.text.replace(WAKE, '').split('\n---\n').filter((w) => !said.has(squash(w)));
      if (!words.length) continue;
      flush();
      items.push({ type: 'owner', key: `s${s.n}`, at: s.at, text: words.join('\n\n') });
    } else if (s.kind === 'say' || (s.kind === 'done' && s.text && !/^done\.?$/i.test(s.text.trim()))) {
      flush();
      items.push({ type: 'agent', key: `s${s.n}`, at: s.at, text: s.text.replace(/^💬\s*/, '').trim() });
    } else if (s.kind !== 'done') {
      const l = line(s);
      if (!l) continue;
      if (!work) work = { type: 'work', key: `w${s.n}`, at: s.at, lines: [], summary: '' };
      work.lines.push({ ...l, n: s.n });
    }
  }
  flush();
  return items;
}

/**
 * Hive in the cloud's thread as a conversation: each request the owner sent, the steps of its runs,
 * and how it ended.
 * @param {Agent} agent
 * @returns {Item[]}
 */
export function threadConversation(agent) {
  /** @type {Item[]} */
  const items = [];
  for (const r of agent.requests) {
    items.push({ type: 'owner', key: `${r.id}`, at: r.created, text: r.text });
    const steps = agent.runs
      .filter((run) => run.request === r.id)
      .sort((a, b) => a.task - b.task)
      .flatMap((run) => run.steps)
      .map((step, i) => ({ ...step, n: i + 1 }));
    items.push(...conversation(steps).map((item) => ({ ...item, key: `${r.id}-${item.key}` })));
    if (r.outcome && !GOING.includes(r.status)) {
      items.push({ type: 'agent', key: `${r.id}-end`, at: r.updated, text: r.outcome, failed: r.status === 'failed' });
    }
  }
  return items;
}

/**
 * A message the owner sent, as it reads in the conversation: a dashboard action reads as a note.
 * @param {any} m
 * @returns {Item}
 */
function fromMessage(m) {
  const base = { key: `m${m.id}`, at: m.at };
  const text = String(m.text ?? '');
  let hit;
  if ((hit = text.match(/^The owner cancelled (T\d+)/))) return { type: 'note', ...base, text: `You cancelled ${hit[1]}` };
  if ((hit = text.match(/^The owner asks you to continue (T\d+) \(".*?"\)(?:: ([\s\S]*))?\.?$/))) {
    return hit[2]
      ? { type: 'owner', ...base, text: hit[2], about: `Continue ${hit[1]}`, state: m.status, detail: m.detail }
      : { type: 'note', ...base, text: `You asked it to continue ${hit[1]}` };
  }
  if ((hit = text.match(/^The owner answered you on (T\d+)[\s\S]*?in their own words: ([\s\S]*)$/))) {
    return { type: 'owner', ...base, text: hit[2], about: `Answer to ${hit[1]}`, state: m.status, detail: m.detail };
  }
  return { type: 'owner', ...base, text, state: m.status, detail: m.detail };
}

/** Steps that are the agent keeping its own lists, not work the owner wants to read. */
const HIDDEN = /^(ToolSearch|update_plan|wrap_up|TodoWrite|TaskCreate|TaskUpdate|TaskList|mark_chapter|read_me|ReadNotifications)\b/;

/**
 * One step as a short line: "Ran npm test", "Edited agents.js", "Searched for "fetchTaskBoard"".
 * Null for bookkeeping the owner doesn't need.
 * @param {{kind: string, text: string}} step
 * @returns {Line | null}
 */
export function line(step) {
  const l = label(step);
  if (!l) return null;
  // The line is short; `full` keeps the whole step so the owner can open it (nothing is ever cut off).
  const text = String(step.text ?? '').trim();
  return text === `${l.verb} ${l.target}`.trim() || text === l.target ? l : { ...l, full: text };
}

/**
 * @param {{kind: string, text: string}} step
 * @returns {Line | null}
 */
function label(step) {
  const text = String(step.text ?? '').trim();
  if (!text) return null;
  if (step.kind === 'failed') return { verb: 'Failed:', target: clip(firstLine(text)), group: 'failed', failed: true };
  if (step.kind === 'think') return { verb: 'Thought:', target: clip(firstLine(text.replace(/\*\*/g, ''))), group: 'think' };
  let m;
  if ((m = text.match(/^\$ ([\s\S]*)$/))) return { verb: 'Ran', target: clip(command(m[1])), group: 'command' };
  if ((m = text.match(/^(?:Read|NotebookRead) (.+)$/))) return { verb: 'Read', target: files(m[1]), group: 'read' };
  if ((m = text.match(/^(Write|Edit|MultiEdit|NotebookEdit) (.+)$/))) {
    return { verb: m[1] === 'Write' ? 'Wrote' : 'Edited', target: files(m[2]), group: 'edit' };
  }
  if ((m = text.match(/^Search for "([\s\S]*?)"(?: in .+)?$/))) return { verb: 'Searched for', target: clip(`"${m[1]}"`), group: 'search' };
  if ((m = text.match(/^Find (\S+)/))) return { verb: 'Looked for', target: clip(m[1]), group: 'search' };
  if ((m = text.match(/^Open (\S+)/))) return { verb: 'Opened', target: site(m[1]), group: 'web' };
  if ((m = text.match(/^Search the web: (.+)$/))) return { verb: 'Searched the web for', target: clip(m[1]), group: 'web' };
  if ((m = text.match(/^Agent: (.*)$/))) return { verb: 'Started an agent:', target: clip(m[1]), group: 'agent' };
  if ((m = text.match(/^Skill: (.*)$/))) return { verb: 'Used the skill', target: clip(m[1]), group: 'other' };
  if ((m = text.match(/^Run code: (.*)$/))) return { verb: 'Ran code:', target: clip(m[1]), group: 'command' };
  if ((m = text.match(/^SendMessage: .*?summary=([^,]+)/))) return { verb: 'Messaged another session:', target: clip(m[1]), group: 'other' };
  if (HIDDEN.test(text)) return null;
  if ((m = text.match(/^([A-Za-z_][\w.-]*): ([\s\S]*)$/))) {
    return { verb: `${words(m[1])}:`, target: clip(firstLine(m[2])), group: 'other' };
  }
  return { verb: '', target: clip(firstLine(text.replace(/^→\s*/, ''))), group: 'other' };
}

/**
 * A stretch of work in one line: "Ran 3 commands, read 2 files and edited 1 file".
 * @param {Line[]} lines
 */
export function summary(lines) {
  /** @type {Record<string, number>} */
  const n = {};
  for (const l of lines) n[l.group] = (n[l.group] ?? 0) + 1;
  const parts = /** @type {string[]} */ ([
    n.command && `ran ${count(n.command, 'command')}`,
    n.read && `read ${count(n.read, 'file')}`,
    n.edit && `edited ${count(n.edit, 'file')}`,
    n.search && `searched ${n.search === 1 ? 'once' : `${n.search} times`}`,
    n.web && `opened ${count(n.web, 'page')}`,
    n.agent && `started ${count(n.agent, 'agent')}`,
    n.other && `took ${count(n.other, 'other step')}`,
  ].filter(Boolean));
  if (!parts.length) parts.push(n.think ? 'thought it through' : `took ${count(lines.length, 'step')}`);
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const failed = n.failed ? ` (${n.failed} failed)` : '';
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}${failed}`;
}

function count(/** @type {number} */ n, /** @type {string} */ thing) {
  return `${n} ${thing}${n === 1 ? '' : 's'}`;
}

/** The last thing an agent said to the owner, in a line. */
function lastSaid(/** @type {Step[]} */ steps = []) {
  const s = [...steps].reverse().find((x) => x.kind === 'say' && x.text.trim());
  return s ? oneLine(s.text.replace(/^💬\s*/, '')) : '';
}

function lastAsked(/** @type {Step[]} */ steps = []) {
  const s = [...steps].reverse().find((x) => x.kind === 'asked');
  return s ? oneLine(s.text.replace(WAKE, '')) : '';
}

function lastLine(/** @type {Step[]} */ steps = []) {
  for (const s of [...steps].reverse()) {
    const l = line(s);
    if (l) return `${l.verb} ${l.target}`.trim();
  }
  return '';
}

function placeOf(/** @type {string} */ project, /** @type {string} */ machine, /** @type {string} */ kind) {
  const on = kind === 'browser' ? '' : machine ? `on ${machine}` : '';
  return [project, on].filter(Boolean).join(' · ');
}

/** A command without the `cd somewhere &&` it starts with. */
function command(/** @type {string} */ text) {
  return firstLine(text).replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, '').trim();
}

function files(/** @type {string} */ list) {
  return clip(list.split(/,\s*/).map((p) => p.trim().split('/').filter(Boolean).at(-1) ?? p).join(', '));
}

function site(/** @type {string} */ url) {
  try {
    const u = new URL(url);
    return clip(`${u.host}${u.pathname === '/' ? '' : u.pathname}`);
  } catch {
    return clip(url);
  }
}

/** A tool's name as words: "browser_batch" → "Browser batch", "mac.click" → "Click". */
function words(/** @type {string} */ name) {
  const short = name.split(/__|\./).at(-1) ?? name;
  const spaced = short.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function firstLine(/** @type {string} */ text) {
  return text.trim().split('\n')[0].trim();
}

/** Whitespace folded to single spaces; never shortened (the page wraps it). */
function oneLine(/** @type {string} */ text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function clip(/** @type {string} */ text, most = 90) {
  return text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;
}

function squash(/** @type {string} */ text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Tasks under the agent that holds each, in the order they come: one heading per agent, so its name
 * and why its tasks wait are said once, not on every row.
 * @param {Task[]} tasks
 * @param {Map<string, Agent>} of
 * @returns {{key: string, agent: Agent | null, tasks: Task[]}[]}
 */
export function byAgent(tasks, of) {
  /** @type {Map<string, {key: string, agent: Agent | null, tasks: Task[]}>} */
  const groups = new Map();
  for (const t of tasks) {
    const agent = of.get(t.key) ?? null;
    const key = agent?.key ?? '';
    if (!groups.has(key)) groups.set(key, { key, agent, tasks: [] });
    groups.get(key)?.tasks.push(t);
  }
  return [...groups.values()];
}
