#!/usr/bin/env node
// Hive's main orchestrator, in the cloud: it takes the instructions the owner sends from the dashboard
// (any surface: website, phone, extension, Hive's window), plans each into tasks, picks the model each
// task needs, and starts a subagent (hive-task.mjs, Codex on the VM's own screen) for each one.
//
// The queue and the board are the task board Worker (cloud/tasks): it takes the oldest queued request
// (POST /v1/requests/take), files the plan's tasks on the board under it, and reports every task as
// it goes (POST /v1/requests/update): its status, the time it took, its tokens and its report. While a
// task runs, every step its agent prints goes to the board too, as one of the owner's live agent runs
// (POST /v1/runs, a few lines every couple of seconds), so every dashboard shows what it's doing. A task
// in a folder (a part of a project, "hive › Voice") gets every memory of that folder, in full, and
// its report is saved back to the folder as a memory.
//
// Models: the planner is cheap (gpt-6.1-terra, low effort). It rates each task easy, normal, hard or
// hardest, and the subagent gets the model for that rating from MODELS, so the choice is ours, not
// a string the planner made up. Code tasks get at least the coding workhorse.
//
// Code tasks in a repository the VM can push to (REPOS) run on the VM in a fresh worktree off main,
// with the network off (hive-task.mjs --code); what they change is committed and pushed to its own
// branch, hive/r<request>-<n>-<title>, never to main, and waits on the board for the owner's review.
// Code tasks anywhere else wait for the owner's coding agents on the Mac. Every brief carries the
// owner's standing rules for the project (GET /v1/rules).
//
//   node orchestrator.mjs [--once]     (as ubuntu on the VM: the hive-orchestrator systemd service)
//
// The board's address and token are root's hive-tasks config (/root/.config/hive/tasks.json), read
// with sudo like Codex is run; nothing of them is written anywhere else.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serveDevices } from './devices.mjs';
import {
  againBrief, askedBrief, blockers, failuresOf, fixBrief, gateTests, improveBrief, landedLine, macFailures, macRunning, MOST_FIXES,
  MOST_LEASE_WAIT_MS, MOST_ROUNDS, onTheMac, othersHold, partsOf, readNeed, SELF_GUIDE,
} from './improve.mjs';
import { callMac, connectedMac } from './mac-mcp.mjs';
import { nodeHeaders } from './version.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The model each rating of task gets. Checked against the owner's account's model list (2026-11-14). */
export const MODELS = {
  easy: { model: 'gpt-6-luna', effort: 'low' },
  normal: { model: 'gpt-6.1-terra', effort: 'low' },
  hard: { model: 'gpt-6.1-sol', effort: 'medium' },
  hardest: { model: 'gpt-6-astra', effort: 'high' },
};
export const PLANNER = { model: 'gpt-6.1-terra', effort: 'low' };
const RATINGS = Object.keys(MODELS);
const KINDS = ['screen', 'mac', 'answer', 'code'];
const MOST_TASKS = 8;
/** Repositories Hive's cloud agent changes code in: project → origin (the dream's deploy key pushes to it). */
export const REPOS = { hive: 'git@github.com:agenticaiuw/hive.git' };
const POLL_MS = 5000;
// Requests taken at once, and tasks working at once across all of them (each is a Codex run).
const MOST_REQUESTS = Number(process.env.HIVE_MOST_REQUESTS) || 3;
const MOST_RUNNING = Number(process.env.HIVE_MOST_TASKS) || 4;

/** The model and effort for a planned task: its rating's, and never less than `hard` for code. */
export function pick(task) {
  let rating = RATINGS.includes(task.difficulty) ? task.difficulty : 'normal';
  if (task.kind === 'code' && RATINGS.indexOf(rating) < RATINGS.indexOf('hard')) rating = 'hard';
  return { rating, ...MODELS[rating] };
}

export const PLAN_GUIDE = `You are Hive's orchestrator. The owner sent the instruction below. Split it into the tasks it asks for
(one task per separate thing; most instructions are one task) and answer with JSON only, no prose, in this shape:
{"project": "<the project it is about, one word like hive or buckymatch, or empty>",
 "tasks": [{"title": "<one line, an imperative>", "quote": "<the owner's exact words for this task>",
            "brief": "<what the agent doing it must do and how to tell it is done, in a few sentences>",
            "folder": "<the part of the project it belongs to, or empty>",
            "kind": "screen|mac|answer|code", "difficulty": "easy|normal|hard|hardest",
            "minutes": <estimate>, "value": "low|medium|high", "needs": [<task numbers>]}]}
kind: screen = done in a web browser (signing in, reading or filling pages, sending as the owner); mac = done on the
owner's own Mac (its apps, its files, what's on its screen); answer = only needs an answer or a lookup; code = changes
code in a repository. An instruction said on the owner's Mac about "this", "here" or their screen is about the Mac.
difficulty: easy = one quick lookup or step; normal = a few steps; hard = many steps or real judgment;
hardest = long, open-ended or high-stakes work. Rate honestly: the rating picks the agent's model.
needs: the numbers (1 for the first task in your list) of earlier tasks this one can't start before, because it uses
what they find or make; [] when it stands alone. Tasks that need nothing run at the same time.
If the instruction starts "For <project> › <folder>: ", every task is in that project and folder.
Don't add tasks the owner didn't ask for, and keep their words in quote exactly.`;

/** How Hive's own messages start (the board's continueStuck), as hive-tasks' inbox::FROM_HIVE. */
export const FROM_HIVE = '[Hive, not the owner]';

/**
 * What the planner reads for a request. Hive on the Mac hands Hive's own note about its stuck tasks
 * here as a request; read as an instruction, its "register no tasks for it" (meant for an agent's own
 * board) left the plan empty, so the stuck tasks were never continued (R44, R48, R79: "Couldn't plan
 * it: the plan has no tasks"). It's planned as the tasks it lists, one each. A cloud request run again
 * (retry) is planned from the owner's words that come with the note, as before.
 */
export function planWords(request) {
  if (!request.retry && request.text.trimStart().startsWith(FROM_HIVE)) {
    return '(This is Hive\'s own note, not the owner\'s words: tasks it lists got stuck and Hive continues them. ' +
      'Plan exactly one task for each task it lists, to finish that task, titled and quoted with that task\'s title, ' +
      'its brief saying what was in the way and that the agent gets past it and finishes, doing nothing the owner ' +
      'hasn\'t asked for. The note\'s "register no tasks for it" is for an agent\'s own board, not for this plan.)\n' +
      request.text;
  }
  return request.from === 'mac' ? `(Said to Hive on the owner's Mac.) ${request.text}` : request.text;
}

/** The plan in the planner's answer: its JSON, checked, with at most MOST_TASKS tasks. */
export function parsePlan(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error("the planner didn't answer with JSON");
  const plan = JSON.parse(answer.slice(start, end + 1));
  const line = (value, most) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, most);
  const given = (Array.isArray(plan.tasks) ? plan.tasks : []).slice(0, MOST_TASKS);
  const tasks = given.map((t, i) => ({
    at: i + 1,
    needs: (Array.isArray(t.needs) ? t.needs : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= i),
    title: line(t.title, 200),
    quote: line(t.quote, 1000),
    brief: String(t.brief ?? '').trim().slice(0, 4000),
    folder: line(t.folder, 80).replace(/[›:]/g, ' ').trim(),
    kind: KINDS.includes(t.kind) ? t.kind : 'screen',
    difficulty: RATINGS.includes(t.difficulty) ? t.difficulty : 'normal',
    minutes: Number.isFinite(Number(t.minutes)) && Number(t.minutes) > 0 ? Math.round(Number(t.minutes)) : null,
    value: ['low', 'medium', 'high'].includes(t.value) ? t.value : 'medium',
  })).filter(t => t.title || t.quote);
  if (!tasks.length) throw new Error('the plan has no tasks');
  // needs as numbers of the tasks kept (1 for the first), only earlier ones, so there are no loops.
  const kept = new Map(tasks.map((t, i) => [t.at, i + 1]));
  for (const t of tasks) {
    t.needs = [...new Set(t.needs.map(n => kept.get(n)).filter(Boolean))].sort((a, b) => a - b);
    delete t.at;
  }
  return { project: line(plan.project, 60).toLowerCase(), tasks };
}

/** "For hive › Voice: x" → {project: "hive", folder: "Voice"} (as the board reads it). */
export function scopeOf(words) {
  const match = /^For ([^›:\n]{1,120}?)(?: › ([^:\n]{1,120}?))?: /.exec(words);
  return match ? { project: match[1].trim(), folder: (match[2] || '').trim() } : { project: '', folder: '' };
}

/** What the subagent is told: the task, the owner's words, their rules, and every memory of its folder in full. */
export function taskBrief(task, request, folder, rules = []) {
  const parts = [task.brief || task.title, `The owner's words: "${task.quote || request.text}"`];
  // The planner's quote is a piece of the message; the rest of it (text to post word for word, say) must
  // still reach the task, so the whole message always comes along.
  if (task.quote && request.text && task.quote.trim() !== request.text.trim()) {
    parts.push(`The whole message this came from, word for word (any exact words in it are used exactly as written):\n${request.text}`);
  }
  if (request.from === 'siri') {
    parts.push('The owner said this to Siri on their iPhone, likely from across the room through AirPods, so do it on the ' +
      'iPhone with the phone tools: if it is locked, unlock it first with authenticate (it types the saved passcode itself), ' +
      'then do the task there and say what you did.');
  } else if (request.from === 'mac') {
    parts.push("The owner said this to Hive on their Mac, where they are now. For anything on their computer (its apps, " +
      'its files, what is on its screen; "this", "here" and "my screen" mean the Mac\'s) use the mac tools, which drive ' +
      "that Mac through the cloud; use the VM's screen only for web work the Mac isn't needed for.");
  } else if (request.from && request.from !== 'web') parts.push(`The owner sent this from their ${request.from}.`);
  if (rules.length) {
    parts.push(`The owner's standing rules for this project; follow every one:\n${rules.map(r => {
      const paths = (() => { try { return JSON.parse(r.paths || '[]'); } catch { return []; } })();
      return `- ${r.text}${r.quote ? ` (the owner said: "${r.quote}")` : ''}${paths.length ? ` (applies to ${paths.join(', ')})` : ''}`;
    }).join('\n')}`);
  }
  if (folder) {
    const memories = folder.memories ?? [];
    parts.push(memories.length
      ? `This task is in the folder "${folder.name}" of ${folder.project}. Every memory of that folder, all ${memories.length}, in full:\n\n`
        + memories.map(m => `### ${m.title} (${m.kind})\n${m.body}`).join('\n\n')
      : `This task is in the folder "${folder.name}" of ${folder.project}, which has no memories yet.`);
    if (folder.about) parts.splice(parts.length - 1, 0, `What the folder is for: ${folder.about}`);
  }
  return parts.join('\n\n');
}

/** Codex's last message and its token use, from its JSON events. */
export function readEvents(lines) {
  let report = '';
  let tokensIn = 0;
  let tokensOut = 0;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') report = event.item.text ?? '';
    if (event.type === 'turn.completed' && event.usage) {
      tokensIn += Number(event.usage.input_tokens) || 0;
      tokensOut += Number(event.usage.output_tokens) || 0;
    }
  }
  return { report, tokensIn, tokensOut };
}

/** A short outcome for the board: the report's first sentence or line. */
export function outcomeOf(report, fallback) {
  const text = String(report || '').trim();
  const first = text.split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? '';
  // A first line ending in a colon introduces the outcome itself ("Updated the bio:" and the bio): the lines
  // after it too, as many whole ones as fit.
  if (first.endsWith(':')) {
    let out = '';
    for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
      const more = out ? `${out}\n${line}` : line;
      if (more.length > 500) break;
      out = more;
    }
    if (out.length > first.length) return out;
  }
  return (first || fallback).slice(0, 240);
}

/** The branch a code task's change goes to: hive/r<request>-<n>-<a few words of its title>. */
export function branchOf(requestId, task) {
  const words = String(task.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return `hive/r${requestId}-${task.key}${words ? `-${words}` : ''}`;
}

/**
 * One request, start to end. `deps`: board(path, body?) → JSON; plan(text) → the planner's answer;
 * run(brief, choice) → {ok, report, seconds, tokensIn, tokensOut}; code(brief, choice, {project,
 * branch, title, request, key}) → the same plus {branch, files} when it pushed a change (optional:
 * without it code tasks wait for the Mac); now() → seconds; log(line).
 */
// ---- page rules: the owner asks on a web page, through the browser extension ---------------------

export const PAGE_GUIDE = `You change how a web page looks for the owner. They are on the page outlined below and said
what they want it to look like. Write a rule their browser extension applies every time the page loads, and answer
with JSON only, no prose, in this shape:
{"title": "<what the rule does, a few words, like: Only this semester's 5 courses>",
 "path": "<the page's path the rule is for, like /, or empty for every page on this site>",
 "hide": ["<CSS selector of something to hide>", ...],
 "keep": [{"items": "<CSS selector matching every one of a list's items>", "text": ["<text an item to keep contains>", ...]}],
 "css": "<extra CSS, or empty>",
 "go": "<a path on this site to open instead of this page, or empty>",
 "add": [{"after": "<CSS selector of the element the link goes after (or \"before\" instead)>", "text": "<the link's words>", "href": "<a path on this site>"}],
 "frames": "<CSS applied inside every frame of the page, or empty>"}
"keep" hides each matching item that contains none of its texts (case doesn't matter), so a list shows only what the owner
wants. Prefer selectors you can see in the outline, ids and stable class names over generated ones, and never hide the
page's main content area itself. The outline of a long page is cut short (repeated items are summed up in one line
each), so on a well-known site (YouTube, Canvas, Reddit, ...) you may also use selectors and attributes you know it
uses, like ytd-rich-shelf-renderer[is-shorts]. Decide which items to keep from what the outline shows (course names,
terms, dates). An iframe is one line in the outline ([frame from <site>]): "css" styles the iframe element, never what's
inside it. "frames" is CSS applied inside every frame of the page (a document viewer like Canvas's, an embedded player),
and each frame the extension could reach is outlined after the page, under "--- inside a frame from <site>": style what's
in a frame with "frames", by selectors from its outline. A filter on an element applies to everything inside it, iframes
too, and a child's filter: none can't undo it. Something the owner puts in full screen is drawn above the page, outside
the styles of the elements around it (a filter on html no longer reaches it), so style the full-screen element itself
too, with its own rule for each of :fullscreen and
:-webkit-full-screen (a selector list with one the browser doesn't know is dropped whole). When something inside a frame
goes full screen, the iframe element is the page's full-screen element, and the frame has its own.
Dark mode on a page with a frame (Canvas's file viewer): darken the frame from inside with "frames": html, body and its
bars, margins and panels get dark backgrounds and light text (pure black, #000, when the owner wants it truly dark), the
document's pages (their canvas, img or page elements) filter: invert(1) hue-rotate(180deg), and its own full screen too
(:fullscreen, :-webkit-full-screen, ::backdrop). Then the page must leave that frame as it is: when "css" inverts html or
the frame's container, invert the iframe element once more so the two cancel, and give the iframe element filter: none
!important in full screen (iframe:fullscreen, iframe:-webkit-full-screen). A frame with no outline of its own can't be
reached: turn it dark from the page by inverting the iframe element, in full screen too.
"go" sends this page on to another page of the same site the moment it opens ("open YouTube on my subscriptions":
path "/", go "/feed/subscriptions"); it needs the rule's path, and it also works when the site changes pages without
loading one. Each "add" puts a link to a page of the same site next to an element: <a class="hive-added"> holding only
its text, in the colour and font of the words in the element it's next to. Style the rest in "css" (a.hive-added, or
a.hive-added[href*="..."] for one of several: size, spacing, layout) so it sits like the items around it, its icon
drawn with ::before (an emoji, or an inline SVG as a data: URL). Don't use the site's CSS variables (they change and
may not exist); set color or font only with !important, when the owner asked for them. Leave "go" and "add" out when
the owner didn't ask to go somewhere or for something new on the page.
When what they asked needs rules for different paths (a sidebar change on every page, and a page that sends you on),
answer {"rules": [<rule>, <rule>]}, each in the shape above with its own title and path, one per path.
The changes already on for this site are listed below. A new rule for the same path replaces the one there, so when the
owner adds to or adjusts one of them, write the whole rule: what it already does plus the change.
If the owner wants the page back the way it was, answer {"off": true} and nothing else. If you can't write a rule that
does what they asked, answer {"cannot": "<the exact reason, in a sentence the owner understands>"} and nothing else.`;

/**
 * The rules in the model's answer, only the known fields, each the right type: {off}, {cannot}, or
 * {rules: [{title, path, rule}, ...]}. An answer can hold one rule or {"rules": [...]}, one per path
 * (YouTube's sidebar on every page and "open on Subscriptions" for / are two).
 */
export function parsePageRule(answer) {
  const match = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!match) throw new Error('the answer had no JSON');
  const value = JSON.parse(match[0]);
  if (value.off === true) return { off: true };
  if (typeof value.cannot === 'string' && value.cannot.trim()) return { cannot: value.cannot.trim().slice(0, 500) };
  const rules = (Array.isArray(value.rules) ? value.rules.slice(0, 5) : [value]).map(ruleFrom);
  if (!rules.length) throw new Error('the rule changes nothing');
  if (new Set(rules.map(r => r.path)).size < rules.length) throw new Error('two rules for the same path: make them one');
  return { rules };
}

function ruleFrom(value) {
  const strings = list => (Array.isArray(list) ? list.map(x => String(x).trim()).filter(Boolean).slice(0, 60) : []);
  const rule = {
    hide: strings(value?.hide),
    keep: (Array.isArray(value?.keep) ? value.keep : [])
      .map(k => ({ items: String(k?.items || '').trim(), text: strings(k?.text) }))
      .filter(k => k.items && k.text.length).slice(0, 10),
    css: String(value?.css || '').slice(0, 20000),
  };
  const frames = String(value?.frames || '').slice(0, 20000);
  if (frames.trim()) rule.frames = frames;
  const go = String(value?.go || '').trim().slice(0, 500);
  const add = (Array.isArray(value?.add) ? value.add : []).map(a => {
    const where = a?.after ? 'after' : 'before';
    return { [where]: String(a?.[where] || '').trim(), text: String(a?.text || '').trim().slice(0, 80), href: String(a?.href || '').trim().slice(0, 500) };
  }).filter(a => (a.after || a.before) && a.text && a.href).slice(0, 10);
  if (go) rule.go = go;
  if (add.length) rule.add = add;
  const path = String(value?.path ?? '').trim().slice(0, 500);
  if (go && !path) throw new Error('"go" needs the path of the page it sends on');
  if (!rule.hide.length && !rule.keep.length && !rule.css.trim() && !rule.frames && !go && !add.length) throw new Error('the rule changes nothing');
  return { title: String(value?.title || 'Page change').trim().slice(0, 120), path, rule };
}

/** What the model is given for a page request: the guide, the page, what the owner said, the site's rules on now. */
export function pagePrompt(request, page, current = []) {
  const on = current.length
    ? current.map(r => `- rule ${r.id}, "${r.title}", path ${JSON.stringify(r.path || '')}${r.path ? '' : ' (every page)'}: ${JSON.stringify(r.rule)}`).join('\n')
    : '(none)';
  return `${PAGE_GUIDE}\n\nThe page: ${page.url}\nIts title: ${page.title || ''}\nThe owner said: ${request.text}\n\n` +
    `The changes already on for this site:\n${on}\n\nThe page's outline (tag#id.classes "text"):\n${page.outline || '(none)'}\n`;
}

/** A request asked on a web page: a model call writes the page's rule (one retry), and the board keeps it. */
export async function handlePage(request, { board, ask, log = () => {} }) {
  const page = request.page;
  const url = new URL(page.url);
  const site = url.hostname.replace(/^www\./, '');
  log(`R${request.id} on ${site}${url.pathname}: ${request.text}`);
  await board('/v1/requests/update', { id: request.id, status: 'working', project: 'web' });
  // What's already on for the site, so "make it work in full screen as well" adds to the rule it means.
  const { rules: current = [] } = await board(`/v1/page-rules?host=${encodeURIComponent(site)}`).catch(() => ({}));
  const prompt = pagePrompt(request, page, current);
  let made;
  try {
    let answer = await ask(prompt, MODELS.normal);
    try {
      made = parsePageRule(answer);
    } catch (error) {
      // Once more, told what was wrong with the answer, before the owner hears it didn't work.
      answer = await ask(`${prompt}\nYour last answer was refused (${error.message}):\n${String(answer).slice(0, 2000)}\n` +
        'Answer again: a rule that changes the page, or {"cannot": "<the exact reason>"}.\n', MODELS.normal);
      made = parsePageRule(answer);
    }
  } catch (error) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `Couldn't write the page change: ${error.message}` });
    return;
  }
  if (made.cannot) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `Couldn't change the page: ${made.cannot}` });
    return;
  }
  if (made.off) {
    const { off } = await board('/v1/page-rules/off', { host: site });
    await board('/v1/requests/update', { id: request.id, status: 'done', outcome: `${site} is back to normal (${off} change${off === 1 ? '' : 's'} off).` });
    return;
  }
  const saved = [];
  for (const r of made.rules) {
    const { id } = await board('/v1/page-rules', { host: site, path: r.path, title: r.title, rule: r.rule, request: request.id });
    saved.push(`${r.title}: on ${site}${r.path || ' (every page)'} from now on (page rule ${id}).`);
  }
  await board('/v1/requests/update', { id: request.id, status: 'done', outcome: saved.join(' ') });
}

/**
 * A task's run on the board (POST /v1/runs, machine "cloud", named like its task: request*100+key), so
 * the dashboard on every node follows the agent live. The run shows up as working the moment it starts;
 * its steps go a few at a time every `every` ms, numbered here so a post sent twice lands once.
 * Sending never holds up or stops the task: steps a post couldn't deliver go with the next one (at
 * most MOST_UNSENT of them), and `done(status)` sends what's left with how it ended.
 */
const MOST_UNSENT = 300;
const kindOf = line => (/^→|^\$/.test(line) ? 'action' : /^💬/.test(line) ? 'say' : /^✅/.test(line) ? 'done'
  : /^❌|^✗/.test(line) ? 'failed' : '');
export function runSender(board, { request, task, run: name, agent = 'cloud', title = '' }, { every = 2000, log = () => {}, now = () => Math.floor(Date.now() / 1000) } = {}) {
  // A job started on the VM some other way (hive-task.mjs by itself) names its own run and has no request.
  const run = request
    ? { machine: 'cloud', run: String(request * 100 + task), agent, title, request, task }
    : { machine: 'cloud', run: String(name), agent, title };
  let unsent = [];
  let count = 0;
  let status = null;
  let ended = false;
  let shown = false;
  let timer = null;
  let sending = Promise.resolve();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    sending = sending.then(async () => {
      if (shown && !unsent.length && (!status || ended)) return; // nothing new to say
      do {
        const steps = unsent.slice(0, 100);
        const last = status && unsent.length <= 100;
        try {
          await board('/v1/runs', { ...run, ...(last ? { status } : {}), steps });
        } catch (error) {
          log(`couldn't put ${request ? `R${request}` : run.run}'s steps on the board: ${error.message}`);
          return;
        }
        const through = steps.at(-1)?.n ?? 0;
        unsent = unsent.filter(step => step.n > through);
        shown = true;
        if (last) ended = true;
      } while (unsent.length);
    });
    return sending;
  };
  flush(); // on the board as working right away
  return {
    step(line, kind) {
      const text = String(line ?? '').trim();
      if (!text) return;
      unsent.push({ n: ++count, at: now(), kind: kind ?? kindOf(text), text });
      if (unsent.length > MOST_UNSENT) unsent = unsent.slice(-MOST_UNSENT);
      if (!timer) timer = setTimeout(flush, every ?? 2000);
    },
    async done(how = 'done') {
      status = how;
      await flush();
      if (!ended) await flush(); // one more try for what a failed post left
    },
  };
}

/** Which task a tool server is working for, on the VM (hive-task.mjs HIVE_TASK_LABEL). */
export const labelOf = (request, key) => `R${request}-${key}`;

/** A task whose needs didn't get done: not started, and exactly why. */
export function unmetOutcome(unmet) {
  const names = unmet.map(t => `«${t.title}»`).join(' and ');
  const review = unmet.filter(t => t.status === 'waiting' && t.branch);
  if (review.length === unmet.length) {
    return { status: 'waiting', outcome: `Not started: it builds on ${names}, waiting for your review on ${review.map(t => `branch ${t.branch}`).join(' and ')}. Merge ${review.length === 1 ? 'it' : 'them'} and it can run.` };
  }
  const waiting = unmet.filter(t => t.status === 'waiting');
  if (waiting.length === unmet.length) {
    return { status: 'waiting', outcome: `Not started: it builds on ${names}, which ${unmet.length === 1 ? 'waits' : 'wait'} for a coding agent on the Mac.` };
  }
  return { status: 'blocked', outcome: `Not started: it needs ${names} first, which stopped before ${unmet.length === 1 ? 'it' : 'they'} finished.` };
}

/** At most `size` at a time; the rest wait their turn, first come first served. */
export class Slots {
  constructor(size) {
    this.size = Math.max(1, size);
    this.used = 0;
    this.line = [];
  }

  async with(fn) {
    if (this.used < this.size) this.used += 1;
    else await new Promise(resolve => this.line.push(resolve)); // handed its slot by the one that ends
    try {
      return await fn();
    } finally {
      const next = this.line.shift();
      if (next) next(); else this.used -= 1;
    }
  }
}

export async function handle(request, deps) {
  if (request.page?.url && deps.ask) return handlePage(request, deps);
  const stopping = watchStop(request, deps);
  try {
    return await handleWork(request, deps, stopping.signal);
  } finally {
    stopping.end();
  }
}

export const STOPPED = 'Stopped by the owner.';

/**
 * The owner stopping a request (POST /v1/requests/stop: the x on Hive's window on the Mac, whose
 * agent thinks here), looked for every few seconds while it runs: its agents are stopped and its
 * tasks not started yet don't start.
 */
export function watchStop(request, { board, log = () => {}, stopEvery = 4000 }) {
  const controller = new AbortController();
  const timer = setInterval(async () => {
    const state = await board(`/v1/requests/state?id=${request.id}`).catch(() => null);
    if (state?.request?.stop_at && !controller.signal.aborted) {
      log(`R${request.id}: the owner stopped it`);
      controller.abort();
    }
  }, stopEvery);
  timer.unref?.();
  return { signal: controller.signal, end: () => clearInterval(timer) };
}

/** One screen task, changing Hive on the way when Hive itself is what's in its way (improve.mjs): the
 *  task asks for the change with improve_hive and stops; Hive changes, tests and lands itself
 *  (deps.improve), and the task runs again with the change, at most MOST_ROUNDS changes. Without
 *  deps.improve or deps.improveDir it's one run, as before. Time and tokens add up across the runs. */
export async function runImproving(brief, { task, request, label, signal, step }, deps) {
  const { run, improve, improveDir } = deps;
  const total = { seconds: 0, tokensIn: 0, tokensOut: 0 };
  const add = r => { for (const k of Object.keys(total)) total[k] += r?.[k] ?? 0; };
  for (let round = 0; ; round++) {
    const improveFile = improve && improveDir ? join(improveDir, `r${request.id}-${task.key}-${round}.json`) : '';
    const result = await run(brief, task.choice, step, { label, title: task.title, signal, improveFile });
    add(result);
    const need = readNeed(improveFile);
    if (!need || signal.aborted) return { ...result, ...total };
    if (round >= MOST_ROUNDS) {
      return { ...result, ...total, ok: false,
        report: [result.report, `Hive needed to change itself again (${need.what}), but it already changed itself ${MOST_ROUNDS} times for this task.`].filter(Boolean).join('\n\n') };
    }
    step(`🛠 Hive is changing itself: ${need.what}`);
    let change;
    try {
      change = await improve(need, { title: task.title, brief, report: result.report ?? '', request: request.id, key: task.key, round, label, signal, board: deps.board }, step);
    } catch (error) {
      change = { ok: false, report: error.message };
    }
    add(change);
    if (!change.ok || signal.aborted) {
      return { ...result, ...total, ok: false,
        report: [result.report, `Hive couldn't change itself so it can ${need.what.replace(/[.\s]+$/, '')}: ${change.report || 'no report'}`].filter(Boolean).join('\n\n') };
    }
    const landed = landedLine(change);
    step(`✅ Hive changed itself: ${landed}`);
    brief = againBrief(brief, need, landed);
  }
}

/** A code task in Hive's own repository: Hive changes itself as asked (deps.improve with `asked`), and
 *  the task is done once the change is on main and live where it runs. */
export async function changeHive(brief, { task, request, label, signal, step }, deps) {
  const need = { what: task.title, why: task.quote || task.title };
  step(`🛠 Hive is changing itself: ${need.what}`);
  let change;
  try {
    change = await deps.improve(need, { title: task.title, brief, report: '', request: request.id, key: task.key, round: 0, label, signal, board: deps.board, asked: true }, step);
  } catch (error) {
    change = { ok: false, report: error.message };
  }
  if (!change.ok) return { ...change, ok: false, report: change.report || 'Hive couldn\'t change itself, and said nothing about why.' };
  const landed = landedLine(change);
  step(`✅ Hive changed itself: ${landed}`);
  return { ...change, report: [change.report, `Landed: ${landed}.`].filter(Boolean).join('\n\n') };
}

async function handleWork(request, deps, signal) {
  const { board, plan, run, code, now = () => Math.floor(Date.now() / 1000), log = () => {} } = deps;
  const scope = scopeOf(request.text);
  log(`R${request.id}: ${request.text}`);
  let planned;
  try {
    planned = parsePlan(await plan(planWords(request)));
  } catch (error) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `Couldn't plan it: ${error.message}` });
    return;
  }
  if (signal.aborted) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: STOPPED });
    return;
  }
  const project = (request.project || scope.project || planned.project || '').toLowerCase();
  const folderName = request.folder || scope.folder;

  // Folders and their memories, read once a request. A folder the planner names is used only if it
  // already exists (the owner makes folders; a guess shouldn't), the one the owner sent from always.
  const folders = new Map();
  const folderOf = name => {
    if (!name || !project) return Promise.resolve(null);
    const key = name.toLowerCase();
    if (!folders.has(key)) {
      const reading = board(`/v1/folder?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`).then(answer => ({
        ...answer.folder, name: answer.folder?.name || name, project, memories: answer.memories ?? [],
        exists: Boolean(answer.folder?.created_at),
      }));
      reading.catch(() => folders.delete(key)); // a failed read is tried again by the next task
      folders.set(key, reading);
    }
    return folders.get(key);
  };
  const rules = project
    ? ((await board(`/v1/rules?project=${encodeURIComponent(project)}`).catch(() => null))?.rules ?? [])
    : [];
  const created = now();
  const tasks = [];
  for (const [i, t] of planned.tasks.entries()) {
    let folder = folderName;
    if (!folder && t.folder) folder = (await folderOf(t.folder).catch(() => null))?.exists ? t.folder : '';
    tasks.push({ ...t, key: i + 1, folder, choice: pick(t), status: 'open', created_at: created });
  }
  const row = t => ({
    key: t.key, title: t.title, quote: t.quote, status: t.status, minutes: t.minutes, value: t.value,
    folder: t.folder || null, created_at: t.created_at, outcome: t.outcome ?? null, report: t.report ?? null,
    evidence: `${t.kind}; ${t.choice.model}, ${t.choice.effort} effort (${t.choice.rating})`,
    work_seconds: t.seconds ?? null, tokens_in: t.tokensIn ?? null, tokens_out: t.tokensOut ?? null,
  });
  await board('/v1/requests/update', { id: request.id, status: 'working', project, tasks: tasks.map(row) });

  // Each task starts once the tasks it needs are done; the rest run side by side (at most `slots` at
  // a time across every request), and only tasks that need the same device take turns at it.
  const slots = deps.slots ?? { with: fn => fn() };
  const update = task => board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
  const work = async task => {
    const coding = task.kind === 'code';
    // Hive builds Hive: a change to Hive's own code is made, tested, landed and put live by Hive itself
    // (changeHive), the way it changes itself when a task needs it to; changes elsewhere wait for review.
    const selfChange = coding && project === 'hive' && Boolean(deps.improve);
    if (coding && !selfChange && !(code && REPOS[project])) {
      task.status = 'waiting';
      task.outcome = project && code
        ? `A code change in ${project}: Hive's cloud agent changes code only in ${Object.keys(REPOS).join(', ')}, so it waits for a coding agent on the Mac.`
        : "A code change: it waits for a coding agent on the Mac.";
      await update(task);
      return;
    }
    task.status = 'active';
    await update(task);
    const folder = await folderOf(task.folder).catch(() => null);
    log(`  T${request.id * 100 + task.key} ${task.title} → ${task.choice.model} (${task.choice.effort})${coding ? ' on code' : ''}`);
    let result;
    const steps = runSender(board, { request: request.id, task: task.key, agent: coding ? 'code' : 'cloud', title: task.title },
      { log, every: deps.stepEvery });
    const label = labelOf(request.id, task.key);
    deps.labels?.set(label, { title: task.title, step: steps.step });
    try {
      const brief = taskBrief(task, request, folder, rules);
      result = selfChange
        ? await changeHive(brief, { task, request, label, signal, step: steps.step }, deps)
        : coding
        ? await code(brief, task.choice, { project, branch: branchOf(request.id, task), title: task.title, request: request.id, key: task.key, label, signal }, steps.step)
        : await runImproving(brief, { task, request, label, signal, step: steps.step }, deps);
    } catch (error) {
      result = { ok: false, report: `The agent couldn't start: ${error.message}`, seconds: 0, tokensIn: 0, tokensOut: 0 };
    } finally {
      deps.labels?.delete(label);
      deps.release?.(label); // its turns at the devices, even if a tool server outlived it
      await board('/v1/team/release', { agent: label }).catch(() => {}); // and its leases on files
    }
    await steps.done(signal.aborted ? 'stopped' : result.ok ? 'done' : 'failed');
    const files = result.files ?? [];
    task.branch = result.branch && files.length ? result.branch : null;
    const where = task.branch
      ? `${files.length} file${files.length === 1 ? '' : 's'} changed on branch ${task.branch}, not merged`
      : '';
    Object.assign(task, {
      // A pushed change waits for the owner to review and merge it; nothing goes to main by itself.
      status: !result.ok ? 'blocked' : task.branch ? 'waiting' : 'done',
      report: [result.report, where && `${where}: ${files.join(', ')}.`].filter(Boolean).join('\n\n') || null,
      outcome: task.branch && result.ok
        ? `Ready for your review: ${where}.`
        : outcomeOf(result.report, result.ok ? 'Done.' : `The agent stopped before it finished${where ? ` (${where})` : ''}.`),
      seconds: result.seconds, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    if (signal.aborted && task.status !== 'done') Object.assign(task, { status: 'dropped', outcome: STOPPED });
    await update(task);
    if (folder && task.report) {
      await board('/v1/folders/memory', {
        project, folder: folder.name, kind: 'report', title: `Report: ${task.title}`, body: task.report,
      }).catch(() => {});
    }
  };
  const ended = new Map();
  for (const task of tasks) {
    ended.set(task.key, (async () => {
      await Promise.all(task.needs.map(n => ended.get(n)));
      if (signal.aborted) {
        Object.assign(task, { status: 'dropped', outcome: STOPPED });
        await update(task).catch(() => {});
        return;
      }
      const unmet = task.needs.map(n => tasks[n - 1]).filter(t => t.status !== 'done');
      if (unmet.length) {
        Object.assign(task, unmetOutcome(unmet));
        await update(task).catch(() => {});
        return;
      }
      try {
        await slots.with(() => (signal.aborted
          ? update(Object.assign(task, { status: 'dropped', outcome: STOPPED }))
          : work(task)));
      } catch (error) {
        log(`  T${request.id * 100 + task.key} failed: ${error.stack || error}`);
        Object.assign(task, { status: 'blocked', outcome: `The orchestrator hit an error: ${error.message}` });
        await update(task).catch(() => {});
      }
    })());
  }
  await Promise.all(ended.values());

  const done = tasks.filter(t => t.status === 'done').length;
  const left = tasks.filter(t => t.status !== 'done');
  const outcome = left.length
    ? `${done} of ${tasks.length} done; ${left.map(t => `${t.title} (${t.branch ? `${t.status}, on ${t.branch}` : t.status})`).join(', ')}.`
    : tasks.length === 1 ? outcomeOf(tasks[0].report, 'Done.') : `All ${tasks.length} tasks done.`;
  if (signal.aborted) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: done ? `${STOPPED.slice(0, -1)} (${done} of ${tasks.length} done).` : STOPPED });
    return;
  }
  const failed = tasks.every(t => t.status === 'blocked');
  await board('/v1/requests/update', { id: request.id, status: failed ? 'failed' : 'done', outcome });
}

// ---- on the VM ---------------------------------------------------------------------------------

const CODEX_HOME = process.env.HIVE_CODEX_HOME ?? '/root/.codex-hive';

export function boardConfig() {
  const text = process.env.HIVE_TASKS_CONFIG
    ? readFileSync(process.env.HIVE_TASKS_CONFIG, 'utf8')
    : execFileSync('sudo', ['-n', 'cat', '/root/.config/hive/tasks.json'], { encoding: 'utf8' });
  const config = JSON.parse(text);
  if (!config.url || !config.token) throw new Error('the board config has no url or token');
  return { url: String(config.url).replace(/\/+$/, ''), token: config.token, machine: config.machine || 'vm' };
}

// Every call says which VM this is and what code it runs (version.mjs), so the board can tell it
// when it's on routes the board no longer serves, and the dashboard shows what each node runs.
export function boardClient({ url, token, machine = 'vm' }) {
  return async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'hive-orchestrator', ...nodeHeaders(machine) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `the board said ${response.status}`);
    return value;
  };
}

/** Codex with no tools and a read-only sandbox, for the plan: its last message. */
const planWithCodex = words => askCodex(`${PLAN_GUIDE}\n\nThe owner's instruction:\n${words}\n`, PLANNER);

/** One prompt to Codex with no tools and a read-only sandbox: its last message. */
function askCodex(prompt, choice) {
  const dir = join(homedir(), 'hive-vm-agent', 'state', 'planner');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only',
    '-C', dir, '-m', choice.model, '-c', `model_reasoning_effort="${choice.effort}"`, '-c', 'web_search="disabled"', '-'];
  return new Promise((resolve, reject) => {
    const codex = spawn('sudo', ['-n', 'env', 'HOME=/root', `CODEX_HOME=${CODEX_HOME}`, '/root/.local/bin/codex', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    createInterface({ input: codex.stdout }).on('line', line => lines.push(line));
    let errors = '';
    codex.stderr.on('data', chunk => { errors += chunk; });
    codex.stdin.end(prompt);
    const timer = setTimeout(() => codex.kill('SIGTERM'), 5 * 60_000);
    codex.on('close', status => {
      clearTimeout(timer);
      const { report } = readEvents(lines);
      if (status === 0 && report) resolve(report);
      else reject(new Error(`Codex exited with ${status}${errors.trim() ? `: ${errors.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

/** hive-task.mjs with these arguments and the brief on stdin: whether it finished, its report, time and tokens.
 *  Each line it prints after its first goes to `onStep` as it comes. */
function runAgent(args, brief, onStep = () => {}, label = '', signal = null, env = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    // Its steps reach the board as this request's run (runSender), so it doesn't post a run of its own.
    // Its label is whose turn it is when its tool servers ask for the screen or the phone.
    const agent = spawn(process.execPath, [join(here, 'hive-task.mjs'), ...args],
      { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HIVE_RUN_SENT: '1', ...(label ? { HIVE_TASK_LABEL: label } : {}), ...env } });
    let workDir = '';
    createInterface({ input: agent.stdout }).on('line', line => {
      process.stdout.write(`    ${label ? `${label} ` : ''}${line}\n`);
      const match = /^Task (\S+) \(/.exec(line);
      if (match && !workDir) workDir = join(process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state'), 'tasks', match[1]);
      else onStep(line); // "→ click: …", "💬 …", "$ …", "✅ Done.": hive-task.mjs describe()
    });
    agent.stdin.end(JSON.stringify({ text: brief }));
    // The owner stopped the request: hive-task.mjs stops its Codex and says so on the board.
    const stop = () => agent.kill('SIGTERM');
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    agent.on('close', status => {
      signal?.removeEventListener('abort', stop);
      let events = { report: '', tokensIn: 0, tokensOut: 0 };
      try { events = readEvents(readFileSync(join(workDir, 'events.jsonl'), 'utf8').split('\n')); } catch {}
      resolve({ ok: status === 0, ...events, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

/** One task on the VM's screen, with the model picked for it. What it asks Hive to change about itself
 *  (knowledge-mcp.mjs improve_hive) goes to `improveFile`. */
const runOnVm = (brief, choice, onStep, { label = '', signal = null, improveFile = '' } = {}) =>
  runAgent(['--model', choice.model, '--effort', choice.effort], brief, onStep, label, signal,
    improveFile ? { HIVE_IMPROVE_FILE: improveFile } : {});

// Code work lives in root's /var/lib/hive-orchestrator (like Codex, which runs as root): a clone per
// repository and a worktree per task. The toolchain and the deploy key are the nightly dream's.
const CODE_ROOT = process.env.HIVE_CODE_ROOT ?? '/var/lib/hive-orchestrator';
const DREAM_ROOT = '/var/lib/hive-dream';
const COMMITTER = ['-c', "user.name=Hive's cloud agent", '-c', 'user.email=hive@agent.invalid'];

const exec = promisify(execFile);
const asRoot = async args => (await exec('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 << 20 })).stdout.trim();

// One git job at a time in a repository's clone (fetch, worktrees, commits, pushes), so code tasks
// side by side don't trip on each other's locks; their agents still work at the same time.
const repoTurns = new Map();
function inRepo(repo, fn) {
  const before = repoTurns.get(repo) ?? Promise.resolve();
  const mine = before.then(fn, fn);
  const settled = mine.catch(() => {});
  repoTurns.set(repo, settled);
  settled.then(() => { if (repoTurns.get(repo) === settled) repoTurns.delete(repo); });
  return mine;
}

/** One code task: a worktree off main, Codex in it with the network off, its change pushed to `branch`. */
async function codeOnVm(brief, choice, { project, branch, title, request, key, label = '', signal = null }, onStep) {
  const repo = join(CODE_ROOT, project);
  const ssh = `ssh -i ${DREAM_ROOT}/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=${DREAM_ROOT}/known_hosts -o StrictHostKeyChecking=yes`;
  const git = (...args) => asRoot(['git', '-c', `core.sshCommand=${ssh}`, ...args]);
  const dir = join(CODE_ROOT, 'work', `r${request}-${key}`);
  // Its own home and state, so tasks side by side don't share them.
  const tmp = join(CODE_ROOT, 'tmp', `r${request}-${key}`);
  await inRepo(repo, async () => {
    try { await asRoot(['test', '-d', join(repo, '.git')]); } catch {
      await asRoot(['mkdir', '-p', '-m', '700', CODE_ROOT]);
      await git('clone', '--quiet', REPOS[project], repo);
    }
    await git('-C', repo, 'fetch', '--quiet', 'origin', 'main');
    try { await git('-C', repo, 'worktree', 'remove', '--force', dir); } catch {}
    await git('-C', repo, 'worktree', 'prune');
    await git('-C', repo, 'worktree', 'add', '--quiet', '-B', branch, dir, 'origin/main');
  });
  await asRoot(['mkdir', '-p', join(CODE_ROOT, 'target'), join(tmp, 'home'), join(tmp, 'state')]);
  const env = {
    HOME: join(tmp, 'home'), AGENT_STATE_DIR: join(tmp, 'state'), HIVE_RECORD: '0',
    CARGO_HOME: `${DREAM_ROOT}/cargo`, RUSTUP_HOME: `${DREAM_ROOT}/rustup`, PATH: `${DREAM_ROOT}/cargo/bin:/usr/local/bin:/usr/bin:/bin`,
    CARGO_TARGET_DIR: join(CODE_ROOT, 'target'), CARGO_INCREMENTAL: '0', CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never',
  };
  try {
    const result = await runAgent(['--code', dir, '--model', choice.model, '--effort', choice.effort,
      '--writable', join(CODE_ROOT, 'target'), '--writable', `${DREAM_ROOT}/cargo`, '--writable', tmp,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])], brief, onStep, label, signal);
    // Stopped by the owner: what it did so far isn't committed or pushed.
    if (signal?.aborted) return { ...result, ok: false, files: [] };
    return await inRepo(repo, async () => {
      if (await git('-C', dir, 'status', '--porcelain')) {
        await git('-C', dir, 'add', '-A');
        await git('-C', dir, ...COMMITTER, 'commit', '--quiet', '-m',
          `${title}\n\nHive's cloud agent (${choice.model}, ${choice.effort} effort), for the owner's request R${request}, task T${request * 100 + key}.`);
      }
      const files = (await git('-C', dir, 'diff', '--name-only', 'origin/main', 'HEAD')).split('\n').filter(Boolean);
      if (!files.length) return { ...result, files };
      await git('-C', dir, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);
      return { ...result, branch, files };
    });
  } finally {
    await inRepo(repo, () => git('-C', repo, 'worktree', 'remove', '--force', dir)).catch(() => {});
    await asRoot(['rm', '-rf', '--', tmp]).catch(() => {}); // its own scratch home, made above
  }
}

// ---- Hive changing itself (improve.mjs) ---------------------------------------------------------

// The code agent that changes Hive: a change lands on main and goes live without the owner's review,
// so it gets the strongest model. Its tests run as the updater's do (updater.mjs checkRelease): away
// from this VM's state and keys, with HIVE_UPDATE_CHECK set.
const IMPROVER = MODELS.hardest;
const APP_DIR = here;
const GATE_MS = 10 * 60_000;

/** The tests of a change (improve.mjs gateTests), run in its worktree: whether they passed and, if not, what failed. */
async function gateOnVm(dir, files, tmp) {
  const have = (await asRoot(['git', '-C', dir, 'ls-files', '*.test.mjs'])).split('\n').filter(Boolean);
  const tests = gateTests(files, have);
  if (!tests.length) return { ok: true, tests };
  try {
    await exec('sudo', ['-n', 'env', '-i', '-C', dir, `PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`, `HOME=${join(tmp, 'home')}`,
      'LANG=C.UTF-8', 'HIVE_UPDATE_CHECK=1', process.execPath, '--test', ...tests], { encoding: 'utf8', timeout: GATE_MS, maxBuffer: 64 << 20 });
    return { ok: true, tests };
  } catch (error) {
    const said = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    return { ok: false, tests, failures: error.killed ? `The tests took longer than ${GATE_MS / 60_000} minutes.\n${failuresOf(said)}` : failuresOf(said) };
  }
}

/** The VM's app folder on this release, or the time ran out (the updater puts a release in within a minute
 *  when only what tasks start changed; a change to the orchestrator waits for it to be idle). */
async function vmOn(version, { wait = 3 * 60_000, every = 5000 } = {}) {
  const until = Date.now() + wait;
  for (;;) {
    let now = '';
    try { now = readFileSync(join(APP_DIR, 'VERSION'), 'utf8').trim(); } catch {}
    if (now === version) return true;
    if (Date.now() > until) return false;
    await new Promise(resolve => setTimeout(resolve, every));
  }
}

// How long the owner's Mac may take to build and test a change (the whole Mac release, from scratch in a
// worktree), and to publish one and put it in (the build, then up to six hours for Hive to be idle).
const MAC_CHECK_MS = 90 * 60_000;
const MAC_INSTALL_MS = 7 * 3600_000;

/**
 * Hive changing itself so a task can go on: a code agent changes Hive in a worktree off main (SELF_GUIDE),
 * the change's tests run until they pass (at most MOST_FIXES tries), and it lands on main and goes live
 * where it runs: a VM release (the updater puts it in), the board (deployed from the owner's Mac when this
 * VM has no Cloudflare sign-in), the dashboard website (from the owner's Mac), the Mac. Hive on the Mac builds only on
 * macOS, so a change to it is also built and tested on the owner's Mac (hive_self check, on the change's
 * branch) before it lands, and after it lands the Mac publishes a release of it and puts it in once Hive
 * there is idle (hive_self install). With no Mac connected, the change waits on its branch instead.
 */
async function improveOnVm(need, { title, brief, report, request, key, round = 0, label = '', signal = null, board = null, asked = false }, onStep) {
  const repo = join(CODE_ROOT, 'hive');
  const ssh = `ssh -i ${DREAM_ROOT}/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=${DREAM_ROOT}/known_hosts -o StrictHostKeyChecking=yes`;
  const git = (...args) => asRoot(['git', '-c', `core.sshCommand=${ssh}`, ...args]);
  const name = `improve-r${request}-${key}-${round + 1}`;
  const dir = join(CODE_ROOT, 'work', name);
  const tmp = join(CODE_ROOT, 'tmp', name);
  const branch = `hive/${name}`;
  const started = Date.now();
  const tokens = { tokensIn: 0, tokensOut: 0 };
  const end = (ok, text, more = {}) => ({ ok, report: text, ...more, ...tokens, seconds: Math.round((Date.now() - started) / 1000) });
  await inRepo(repo, async () => {
    try { await asRoot(['test', '-d', join(repo, '.git')]); } catch {
      await asRoot(['mkdir', '-p', '-m', '700', CODE_ROOT]);
      await git('clone', '--quiet', REPOS.hive, repo);
    }
    await git('-C', repo, 'fetch', '--quiet', 'origin', 'main');
    try { await git('-C', repo, 'worktree', 'remove', '--force', dir); } catch {}
    await git('-C', repo, 'worktree', 'prune');
    await git('-C', repo, 'worktree', 'add', '--quiet', '-B', branch, dir, 'origin/main');
  });
  await asRoot(['mkdir', '-p', join(CODE_ROOT, 'target'), join(tmp, 'home'), join(tmp, 'state')]);
  const env = {
    HOME: join(tmp, 'home'), AGENT_STATE_DIR: join(tmp, 'state'), HIVE_RECORD: '0', HIVE_UPDATE_CHECK: '1',
    CARGO_HOME: `${DREAM_ROOT}/cargo`, RUSTUP_HOME: `${DREAM_ROOT}/rustup`, PATH: `${DREAM_ROOT}/cargo/bin:/usr/local/bin:/usr/bin:/bin`,
    CARGO_TARGET_DIR: join(CODE_ROOT, 'target'), CARGO_INCREMENTAL: '0', CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never',
  };
  const agentArgs = ['--code', dir, '--model', IMPROVER.model, '--effort', IMPROVER.effort,
    '--writable', join(CODE_ROOT, 'target'), '--writable', `${DREAM_ROOT}/cargo`, '--writable', tmp,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])];
  const agent = async text => {
    const result = await runAgent(agentArgs, text, onStep, label, signal);
    tokens.tokensIn += result.tokensIn ?? 0;
    tokens.tokensOut += result.tokensOut ?? 0;
    return result;
  };
  const changed = async () => {
    await git('-C', dir, 'add', '-A');
    return (await git('-C', dir, 'diff', '--cached', '--name-only', 'origin/main')).split('\n').filter(Boolean);
  };
  // The repository is public: a change asked for keeps the asker's words off its commit.
  const message = `Hive changes itself: ${need.what.replace(/[.\s]+$/, '').slice(0, 60)}\n\n${asked ? `Asked for on the board.` : need.why.slice(0, 1500)}\n\n`
    + `Hive's cloud agent (${IMPROVER.model}, ${IMPROVER.effort} effort), for task T${request * 100 + key} (request R${request}), tested on the VM.`;
  // The change as it stands, committed on its branch and pushed, for the Mac to build: the first time a
  // commit, after a fix the same commit amended.
  let committed = false;
  const pushBranch = () => inRepo(repo, async () => {
    await git('-C', dir, ...COMMITTER, 'commit', '--quiet', ...(committed ? ['--amend', '--no-edit'] : ['-m', message]));
    committed = true;
    await git('-C', dir, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  });
  let mac;
  const onMac = (name, args) => callMac(board, mac, name, args, { request });
  // Other agents changing Hive at the same time (the board's /v1/team/): the code agent hears which files
  // they hold, this change leases the files it touches, and it lands only once the agents that leased
  // them first let go (improve.mjs blockers). The task's end lets go of its leases (handleWork).
  const team = board && label ? board : null;
  const claims = async paths => (team ? (await team(`/v1/team/claims${paths ? `?paths=${encodeURIComponent(paths.join(','))}` : ''}`).catch(() => ({}))).leases ?? [] : []);
  try {
    const held = othersHold(await claims(), label);
    let result = await agent([SELF_GUIDE, asked ? askedBrief(need, { brief }) : improveBrief(need, { title, brief, report }), held].filter(Boolean).join('\n\n'));
    let files = [];
    for (let tries = 1; ; tries++) {
      if (signal?.aborted) return end(false, 'Stopped by the owner before the change landed.');
      if (!result.ok) return end(false, `The code agent stopped before it finished: ${outcomeOf(result.report, 'no report')}`);
      files = await changed();
      if (!files.length) return end(false, `The code agent changed nothing: ${outcomeOf(result.report, 'no report')}`);
      await team?.('/v1/team/claim', { agent: label, paths: files, note: need.what.slice(0, 120), minutes: 240 }).catch(() => {});
      onStep(`$ Testing Hive's change (${files.length} file${files.length === 1 ? '' : 's'})`);
      const gate = await gateOnVm(dir, files, tmp);
      let failures = gate.failures;
      if (gate.ok) {
        onStep(`✅ ${gate.tests.length} test file${gate.tests.length === 1 ? '' : 's'} passed`);
        if (!partsOf(files).mac) break;
        // Hive on the Mac builds only on macOS: the owner's Mac builds and tests it, from the branch.
        const touched = files.filter(f => /^(desktop|browser|dashboard|branding)\//.test(f));
        const which = `${touched.slice(0, 4).join(', ')}${touched.length > 4 ? ', …' : ''}`;
        mac ??= board ? await connectedMac(board).catch(() => null) : null;
        await pushBranch();
        if (!mac) return end(false, `The change touches Hive on the Mac (${which}), which builds only on macOS, and no Mac is connected to build and test it on, so it's on branch ${branch}, not on main.`);
        onStep(`$ Building and testing Hive's change on the owner's Mac`);
        let job;
        try {
          job = await onTheMac(onMac, { action: 'check', branch }, { wait: MAC_CHECK_MS });
        } catch (error) {
          return end(false, `The owner's Mac couldn't test the change (${error.message}), so it's on branch ${branch}, not on main.`);
        }
        if (job.state === 'passed') {
          onStep(`✅ It builds and passes its tests on the Mac`);
          break;
        }
        if (job.timedOut) return end(false, `The Mac's test of the change didn't finish within ${MAC_CHECK_MS / 60_000} minutes, so it's on branch ${branch}, not on main.`);
        failures = macFailures(job);
        onStep(`✗ The change failed on the Mac (try ${tries} of ${MOST_FIXES})`);
      } else {
        onStep(`✗ Hive's tests failed on the change (try ${tries} of ${MOST_FIXES})`);
      }
      if (tries >= MOST_FIXES) return end(false, `Hive's tests still failed after ${MOST_FIXES} tries:\n${failures}`);
      result = await agent(fixBrief(failures));
    }
    const parts = partsOf(files);
    // Not while an agent that leased one of these files first still holds it.
    for (let until = Date.now() + MOST_LEASE_WAIT_MS, said = ''; team;) {
      const waiting = blockers(await claims(files), label);
      if (!waiting.length) break;
      const who = [...new Set(waiting.map(l => `${l.agent} (${l.path})`))].join(', ');
      if (signal?.aborted || Date.now() > until) {
        await pushBranch().catch(() => {});
        return end(false, signal?.aborted ? 'Stopped by the owner before the change landed.'
          : `The change passed its tests but didn't land: ${who} still held its files after ${MOST_LEASE_WAIT_MS / 60_000} minutes. It's on branch ${branch}.`);
      }
      if (who !== said) onStep(`$ Waiting to land until ${(said = who)} lets go`);
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    // Onto main as it is now: rebased, tested again if main moved, then a fast-forward push.
    const commit = await inRepo(repo, async () => {
      if (!committed) await git('-C', dir, ...COMMITTER, 'commit', '--quiet', '-m', message);
      for (let attempt = 1; ; attempt++) {
        const base = await git('-C', dir, 'rev-parse', 'origin/main');
        await git('-C', dir, 'fetch', '--quiet', 'origin', 'main');
        if (await git('-C', dir, 'rev-parse', 'origin/main') !== base) {
          try { await git('-C', dir, ...COMMITTER, 'rebase', '--quiet', 'origin/main'); } catch (error) {
            await git('-C', dir, 'rebase', '--abort').catch(() => {});
            throw new Error(`it no longer applies to main, which changed meanwhile (${error.message.split('\n')[0]})`);
          }
          const again = await gateOnVm(dir, await changed(), tmp);
          if (!again.ok) throw new Error(`its tests failed on main as it is now:\n${again.failures}`);
        }
        try {
          await git('-C', dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
          return git('-C', dir, 'rev-parse', 'HEAD');
        } catch (error) {
          if (attempt >= 3) throw new Error(`main wouldn't take it: ${error.message.split('\n')[0]}`);
        }
      }
    }).catch(error => ({ error }));
    if (commit.error) return end(false, `The change passed its tests but didn't land: ${commit.error.message}`);
    onStep(`✅ On main: ${commit.slice(0, 10)}`);
    const live = [];
    const notes = [];
    const note = text => { notes.push(text); onStep(`✗ ${text}`); };
    if (parts.board) {
      // From here when this VM has a Cloudflare sign-in; otherwise the owner's Mac deploys the same commit
      // with its own (hive_self board).
      let here = '';
      try {
        await exec('sudo', ['-n', 'env', 'HOME=/root', 'WRANGLER=wrangler', process.execPath, join(dir, 'cloud', 'release.mjs'), 'board'],
          { encoding: 'utf8', timeout: GATE_MS, maxBuffer: 16 << 20 });
        live.push('the board');
      } catch (error) {
        here = String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ');
      }
      if (here) {
        mac ??= board ? await connectedMac(board).catch(() => null) : null;
        if (mac) {
          onStep(`$ Deploying the board from the owner's Mac (this VM can't: ${here.slice(0, 200)})`);
          const job = await onTheMac(onMac, { action: 'board', commit }, { wait: MAC_CHECK_MS }).catch(error => ({ state: 'failed', failures: error.message }));
          if (job.state === 'deployed') live.push('the board');
          else note(`The board didn't deploy from the Mac either: ${job.timedOut ? 'it was still on it' : job.failures || 'no reason given'}`);
        } else {
          note(`The board didn't deploy: ${here}; and no Mac is connected to deploy it from`);
        }
      }
    }
    if (parts.vm) {
      try {
        const said = (await exec('sudo', ['-n', 'env', 'HOME=/root', process.execPath, join(dir, 'cloud', 'release.mjs'), 'vm',
          '--notes', need.what.slice(0, 200)], { encoding: 'utf8', timeout: GATE_MS, maxBuffer: 16 << 20 })).stdout;
        const version = /published vm (\S+)/.exec(said)?.[1];
        await asRoot(['systemctl', 'start', '--no-block', 'hive-update.service']).catch(() => {});
        if (version && await vmOn(version)) live.push('the VM');
        else notes.push("The VM release is published; the VM puts it in once it's idle (it changes the orchestrator itself).");
      } catch (error) {
        note(`The VM release didn't publish: ${String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ')}`);
      }
    }
    if (parts.site) {
      // The dashboard website deploys with a Cloudflare sign-in, which the owner's Mac has (hive_self site).
      mac ??= board ? await connectedMac(board).catch(() => null) : null;
      if (mac) {
        onStep(`$ Deploying the dashboard website from the owner's Mac`);
        const job = await onTheMac(onMac, { action: 'site', commit }, { wait: MAC_CHECK_MS }).catch(error => ({ state: 'failed', failures: error.message }));
        if (job.state === 'deployed') live.push('the dashboard website');
        else note(`The dashboard website didn't deploy: ${job.timedOut ? 'the Mac was still on it' : job.failures || 'no reason given'}`);
      } else {
        note("The dashboard website didn't deploy: no Mac is connected to deploy it from");
      }
    }
    // The task runs again only where its change is live: a board without it would answer the task as before.
    if (parts.board && !live.includes('the board')) {
      return end(false, [`The change landed on main as ${commit.slice(0, 10)}, but the board isn't running it.`, ...notes].join('\n\n'), { commit, files, live });
    }
    if (parts.mac) {
      // The Mac publishes a release of main as it now is and puts it in once Hive there is idle; the task
      // runs again only once the Mac runs it, since the task needed it there.
      onStep(`$ Publishing Hive for the Mac and putting it in on the owner's Mac once Hive there is idle`);
      let job;
      try {
        job = await onTheMac(onMac, { action: 'install', commit, notes: need.what.slice(0, 200) }, { wait: MAC_INSTALL_MS });
      } catch (error) {
        job = { state: 'failed', failures: error.message };
      }
      const on = job.state === 'installed' && await macRunning(onMac, job);
      if (!on) {
        const why = job.state === 'failed' ? `it didn't go in: ${job.failures || 'no reason given'}`
          : job.state === 'installed' ? `Hive ${job.version} went in, but the Mac didn't come back running it`
            : job.timedOut ? `the Mac was still on it after ${MAC_INSTALL_MS / 3600_000} hours`
              : `Hive ${job.version ?? ''} is published, but it isn't in on the Mac yet: ${job.here || 'no reason given'}`;
        return end(false, [`The change landed on main as ${commit.slice(0, 10)}, but on the owner's Mac ${why}.`, ...notes].join('\n\n'),
          { commit, files, live });
      }
      live.push('the Mac');
    }
    return end(true, [result.report, ...notes].filter(Boolean).join('\n\n'), { commit, files, live });
  } finally {
    await inRepo(repo, () => git('-C', repo, 'worktree', 'remove', '--force', dir)).catch(() => {});
    await asRoot(['rm', '-rf', '--', tmp]).catch(() => {});
  }
}

/** The VM's ledger syncs, which also sends this machine's Codex plan limits (Hive's home among them).
 *  One at a time: a request that ends while one runs gets one more after it. */
let syncing = null;
let syncAgain = false;
function syncLedger() {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    do {
      syncAgain = false;
      await exec('sudo', ['-n', 'env', 'HOME=/root', '/root/.local/bin/hive-tasks', 'sync'], { timeout: 60_000 }).catch(() => {});
    } while (syncAgain);
  })().finally(() => { syncing = null; });
  return syncing;
}

/*
 * Hive's Codex plan limits, live. Its tasks run Codex with --ephemeral, which leaves no session logs,
 * so hive-tasks (which reads limits from those logs) never saw them and the dashboard kept showing the
 * Mac's last local run. Codex's own app-server answers account/rateLimits/read from the plan itself,
 * spending nothing, so the orchestrator asks it every few minutes and puts the answer on the board.
 */
const LIMITS_EVERY_MS = 5 * 60_000;

/** The board's limits row (cloud/tasks/worker.js limitRow) from app-server's rateLimits answer. */
export function limitsRow(result, home = '~/.codex-hive', at = Math.floor(Date.now() / 1000)) {
  const limits = result?.rateLimits;
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary]
    .filter(w => w && Number.isFinite(w.usedPercent) && Number.isFinite(w.windowDurationMins))
    .map(w => ({ minutes: w.windowDurationMins, used: w.usedPercent, resets_at: w.resetsAt ?? null }));
  return { harness: 'codex', home, plan: limits.planType || '', windows, at };
}

/** Asks `codex app-server` (as root, Hive's Codex home) for its plan limits; null if it doesn't answer. */
function readCodexLimits() {
  return new Promise(resolve => {
    const child = spawn('sudo', ['-n', 'env', 'HOME=/root', `CODEX_HOME=${CODEX_HOME}`, '/root/.local/bin/codex', 'app-server'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 20_000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })}\n`);
      } else if (message.id === 2) finish(message.result ?? null);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'hive-orchestrator', version: '1' } } })}\n`);
  });
}

async function refreshLimits(board, machine, log) {
  const row = limitsRow(await readCodexLimits());
  if (!row) return log("couldn't read Hive's Codex plan limits");
  await board('/v1/sync', { machine, limits: [row] }).catch(error => log(`couldn't put the plan limits on the board: ${error.message}`));
}

const DEVICE_NAMES = { screen: "the VM's screen", phone: "the owner's iPhone", mac: "the owner's Mac" };

/** A device turn's news as a step in the waiting task's run: who it waits for, and when it got it. */
export function turnStep(labels, label, message) {
  const own = name => labels.get(String(name ?? '').replace(/ closing$/, ''));
  const task = own(label);
  const what = DEVICE_NAMES[message.device] ?? message.device;
  if (!task) return null;
  if (message.op === 'queued') {
    const holder = own(message.holder)?.title ?? message.holder ?? 'another task';
    const more = message.ahead ? ` (${message.ahead} more ahead of this one)` : '';
    return { task, text: `⏳ Waiting for ${what}: «${holder}» is using it${more}.` };
  }
  if (message.op === 'granted' && message.waited_ms >= 1000) {
    return { task, text: `Got ${what} after ${Math.round(message.waited_ms / 1000)} s.` };
  }
  if (message.op === 'revoked') return { task, text: `Gave ${what} to the task waiting for it; this one waits in line for its next call.` };
  return null;
}

async function main(argv) {
  const once = argv.includes('--once');
  const config = boardConfig();
  const board = boardClient(config);
  const log = line => console.log(`${new Date().toISOString()} ${line}`);
  log(`Hive's orchestrator: taking requests for hive-cloud as ${config.machine}, up to ${MOST_REQUESTS} at once, ${MOST_RUNNING} tasks working`);
  // Turns at the screen and the phone, for the tasks' tool servers (devices.mjs).
  const labels = new Map();
  const stateDir = process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const devices = serveDevices(join(stateDir, 'devices.sock'), {
    log,
    onEvent: (label, message) => {
      const step = turnStep(labels, label, message);
      if (step) step.task.step(step.text);
    },
  });
  const slots = new Slots(MOST_RUNNING);
  // What a task asks Hive to change about itself lands here (knowledge-mcp.mjs, as root, writes it; this reads and removes it).
  const improveDir = join(stateDir, 'improve');
  mkdirSync(improveDir, { recursive: true, mode: 0o700 });
  const deps = {
    board, plan: planWithCodex, ask: askCodex, run: runOnVm, code: codeOnVm, log, slots, labels, release: devices.release,
    improve: improveOnVm, improveDir,
  };
  const running = new Map();
  // The requests in flight, for the updater (updater.mjs inFlight): it never restarts this mid-request.
  let notedAt = 0;
  const noteRunning = () => {
    notedAt = Date.now();
    const file = join(stateDir, 'requests.json');
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ids: [...running.keys()], at: notedAt }));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      log(`couldn't note the requests in flight: ${error.message}`);
    }
  };
  noteRunning();
  syncLedger();
  let fresh = true;
  let limitsAt = 0;
  for (;;) {
    if (Date.now() - limitsAt > LIMITS_EVERY_MS) {
      limitsAt = Date.now();
      await refreshLimits(board, config.machine, log);
    }
    let request = null;
    if (running.size < MOST_REQUESTS) {
      try {
        ({ request } = await board('/v1/requests/take', { by: config.machine, agent: 'hive-cloud', fresh }));
        fresh = false;
      } catch (error) {
        log(`couldn't reach the board: ${error.message}`);
      }
    }
    if (request) {
      const taken = request;
      // A reply to a request still working here waits for it: it builds on how that one ends.
      const earlier = taken.follows ? running.get(taken.follows) : null;
      const going = (async () => {
        if (earlier) {
          log(`R${taken.id} follows R${taken.follows}, still working: it starts after it`);
          await earlier;
        }
        await handle(taken, deps);
      })().catch(async error => {
        log(`R${taken.id} failed: ${error.stack || error}`);
        await board('/v1/requests/update', { id: taken.id, status: 'failed', outcome: `The orchestrator hit an error: ${error.message}` })
          .catch(() => {});
      }).finally(() => {
        running.delete(taken.id);
        noteRunning();
        syncLedger();
      });
      running.set(taken.id, going);
      noteRunning();
      continue;
    }
    if (running.size && Date.now() - notedAt > 30 * 60_000) noteRunning(); // still fresh for the updater
    if (once && !running.size) {
      await devices.close();
      await syncing;
      return;
    }
    await Promise.race([new Promise(resolve => setTimeout(resolve, POLL_MS)), ...running.values()]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
