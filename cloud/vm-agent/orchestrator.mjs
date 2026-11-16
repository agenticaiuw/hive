#!/usr/bin/env node
// Hive's main orchestrator, in the cloud: it takes the instructions the owner sends from the dashboard
// (any surface: website, phone, extension, Hive's window), plans each into tasks, picks the model each
// task needs, and starts a subagent (hive-task.mjs, Codex on the VM's own screen) for each one.
//
// The queue and the board are the task board Worker (cloud/tasks): it takes the oldest queued request
// (POST /v1/requests/take), files the plan's tasks on the board under it, and reports every task as
// it goes (POST /v1/requests/update): its status, the time it took, its tokens and its report. A task
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
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

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
const KINDS = ['screen', 'answer', 'code'];
const MOST_TASKS = 8;
/** Repositories Hive's cloud agent changes code in: project → origin (the dream's deploy key pushes to it). */
export const REPOS = { hive: 'git@github.com:agenticaiuw/hive.git' };
const POLL_MS = 5000;

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
            "kind": "screen|answer|code", "difficulty": "easy|normal|hard|hardest",
            "minutes": <estimate>, "value": "low|medium|high"}]}
kind: screen = done in a web browser (signing in, reading or filling pages, sending as the owner); answer = only
needs an answer or a lookup; code = changes code in a repository.
difficulty: easy = one quick lookup or step; normal = a few steps; hard = many steps or real judgment;
hardest = long, open-ended or high-stakes work. Rate honestly: the rating picks the agent's model.
If the instruction starts "For <project> › <folder>: ", every task is in that project and folder.
Don't add tasks the owner didn't ask for, and keep their words in quote exactly.`;

/** The plan in the planner's answer: its JSON, checked, with at most MOST_TASKS tasks. */
export function parsePlan(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error("the planner didn't answer with JSON");
  const plan = JSON.parse(answer.slice(start, end + 1));
  const line = (value, most) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, most);
  const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).slice(0, MOST_TASKS).map(t => ({
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
  if (request.from && request.from !== 'web') parts.push(`The owner sent this from their ${request.from}.`);
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
  const first = String(report || '').trim().split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? '';
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
 "css": "<extra CSS, or empty>"}
"keep" hides each matching item that contains none of its texts (case doesn't matter), so a list shows only what the owner
wants. Use only selectors you can see in the outline, preferring ids and stable class names over generated ones, and
never hide the page's main content area itself. Decide which items to keep from what the outline shows (course names,
terms, dates). If the owner wants the page back the way it was, answer {"off": true} and nothing else.`;

/** A rule from the model's answer: only the known fields, each the right type. */
export function parsePageRule(answer) {
  const match = /\{[\s\S]*\}/.exec(String(answer || ''));
  if (!match) throw new Error('the answer had no JSON');
  const value = JSON.parse(match[0]);
  if (value.off === true) return { off: true };
  const strings = list => (Array.isArray(list) ? list.map(x => String(x).trim()).filter(Boolean).slice(0, 60) : []);
  const rule = {
    hide: strings(value.hide),
    keep: (Array.isArray(value.keep) ? value.keep : [])
      .map(k => ({ items: String(k?.items || '').trim(), text: strings(k?.text) }))
      .filter(k => k.items && k.text.length).slice(0, 10),
    css: String(value.css || '').slice(0, 20000),
  };
  if (!rule.hide.length && !rule.keep.length && !rule.css.trim()) throw new Error('the rule changes nothing');
  return { title: String(value.title || 'Page change').trim().slice(0, 120), path: String(value.path ?? '').trim().slice(0, 500), rule };
}

/** A request asked on a web page: one model call writes the page's rule, and the board keeps it. */
export async function handlePage(request, { board, ask, log = () => {} }) {
  const page = request.page;
  const url = new URL(page.url);
  const site = url.hostname.replace(/^www\./, '');
  log(`R${request.id} on ${site}${url.pathname}: ${request.text}`);
  await board('/v1/requests/update', { id: request.id, status: 'working', project: 'web' });
  let made;
  try {
    made = parsePageRule(await ask(`${PAGE_GUIDE}\n\nThe page: ${page.url}\nIts title: ${page.title || ''}\n` +
      `The owner said: ${request.text}\n\nThe page's outline (tag#id.classes "text"):\n${page.outline || '(none)'}\n`, MODELS.normal));
  } catch (error) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `Couldn't write the page change: ${error.message}` });
    return;
  }
  if (made.off) {
    const { off } = await board('/v1/page-rules/off', { host: site });
    await board('/v1/requests/update', { id: request.id, status: 'done', outcome: `${site} is back to normal (${off} change${off === 1 ? '' : 's'} off).` });
    return;
  }
  const { id } = await board('/v1/page-rules', { host: site, path: made.path, title: made.title, rule: made.rule, request: request.id });
  await board('/v1/requests/update', {
    id: request.id, status: 'done',
    outcome: `${made.title}: on ${site}${made.path || ' (every page)'} from now on (page rule ${id}).`,
  });
}

export async function handle(request, deps) {
  if (request.page?.url && deps.ask) return handlePage(request, deps);
  const { board, plan, run, code, now = () => Math.floor(Date.now() / 1000), log = () => {} } = deps;
  const scope = scopeOf(request.text);
  log(`R${request.id}: ${request.text}`);
  let planned;
  try {
    planned = parsePlan(await plan(request.text));
  } catch (error) {
    await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `Couldn't plan it: ${error.message}` });
    return;
  }
  const project = (request.project || scope.project || planned.project || '').toLowerCase();
  const folderName = request.folder || scope.folder;

  // Folders and their memories, read once a request. A folder the planner names is used only if it
  // already exists (the owner makes folders; a guess shouldn't), the one the owner sent from always.
  const folders = new Map();
  const folderOf = async name => {
    if (!name || !project) return null;
    const key = name.toLowerCase();
    if (!folders.has(key)) {
      const answer = await board(`/v1/folder?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`);
      folders.set(key, {
        ...answer.folder, name: answer.folder?.name || name, project, memories: answer.memories ?? [],
        exists: Boolean(answer.folder?.created_at),
      });
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

  for (const task of tasks) {
    const coding = task.kind === 'code';
    if (coding && !(code && REPOS[project])) {
      task.status = 'waiting';
      task.outcome = project && code
        ? `A code change in ${project}: Hive's cloud agent changes code only in ${Object.keys(REPOS).join(', ')}, so it waits for a coding agent on the Mac.`
        : "A code change: it waits for a coding agent on the Mac.";
      await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
      continue;
    }
    task.status = 'active';
    await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
    const folder = await folderOf(task.folder).catch(() => null);
    log(`  T${request.id * 100 + task.key} ${task.title} → ${task.choice.model} (${task.choice.effort})${coding ? ' on code' : ''}`);
    let result;
    try {
      const brief = taskBrief(task, request, folder, rules);
      result = coding
        ? await code(brief, task.choice, { project, branch: branchOf(request.id, task), title: task.title, request: request.id, key: task.key })
        : await run(brief, task.choice);
    } catch (error) {
      result = { ok: false, report: `The agent couldn't start: ${error.message}`, seconds: 0, tokensIn: 0, tokensOut: 0 };
    }
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
    await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
    if (folder && task.report) {
      await board('/v1/folders/memory', {
        project, folder: folder.name, kind: 'report', title: `Report: ${task.title}`, body: task.report,
      }).catch(() => {});
    }
  }

  const done = tasks.filter(t => t.status === 'done').length;
  const left = tasks.filter(t => t.status !== 'done');
  const outcome = left.length
    ? `${done} of ${tasks.length} done; ${left.map(t => `${t.title} (${t.branch ? `${t.status}, on ${t.branch}` : t.status})`).join(', ')}.`
    : tasks.length === 1 ? outcomeOf(tasks[0].report, 'Done.') : `All ${tasks.length} tasks done.`;
  const failed = tasks.every(t => t.status === 'blocked');
  await board('/v1/requests/update', { id: request.id, status: failed ? 'failed' : 'done', outcome });
}

// ---- on the VM ---------------------------------------------------------------------------------

const CODEX_HOME = process.env.HIVE_CODEX_HOME ?? '/root/.codex-hive';

function boardConfig() {
  const text = process.env.HIVE_TASKS_CONFIG
    ? readFileSync(process.env.HIVE_TASKS_CONFIG, 'utf8')
    : execFileSync('sudo', ['-n', 'cat', '/root/.config/hive/tasks.json'], { encoding: 'utf8' });
  const config = JSON.parse(text);
  if (!config.url || !config.token) throw new Error('the board config has no url or token');
  return { url: String(config.url).replace(/\/+$/, ''), token: config.token, machine: config.machine || 'vm' };
}

function boardClient({ url, token }) {
  return async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'hive-orchestrator' },
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

/** hive-task.mjs with these arguments and the brief on stdin: whether it finished, its report, time and tokens. */
function runAgent(args, brief) {
  const started = Date.now();
  return new Promise(resolve => {
    const agent = spawn(process.execPath, [join(here, 'hive-task.mjs'), ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
    let workDir = '';
    createInterface({ input: agent.stdout }).on('line', line => {
      process.stdout.write(`    ${line}\n`);
      const match = /^Task (\S+) \(/.exec(line);
      if (match && !workDir) workDir = join(process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state'), 'tasks', match[1]);
    });
    agent.stdin.end(JSON.stringify({ text: brief }));
    agent.on('close', status => {
      let events = { report: '', tokensIn: 0, tokensOut: 0 };
      try { events = readEvents(readFileSync(join(workDir, 'events.jsonl'), 'utf8').split('\n')); } catch {}
      resolve({ ok: status === 0, ...events, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

/** One task on the VM's screen, with the model picked for it. */
const runOnVm = (brief, choice) => runAgent(['--model', choice.model, '--effort', choice.effort], brief);

// Code work lives in root's /var/lib/hive-orchestrator (like Codex, which runs as root): a clone per
// repository and a worktree per task. The toolchain and the deploy key are the nightly dream's.
const CODE_ROOT = process.env.HIVE_CODE_ROOT ?? '/var/lib/hive-orchestrator';
const DREAM_ROOT = '/var/lib/hive-dream';
const COMMITTER = ['-c', "user.name=Hive's cloud agent", '-c', 'user.email=hive@agent.invalid'];

function asRoot(args) {
  return execFileSync('sudo', ['-n', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 }).trim();
}

/** One code task: a worktree off main, Codex in it with the network off, its change pushed to `branch`. */
async function codeOnVm(brief, choice, { project, branch, title, request, key }) {
  const repo = join(CODE_ROOT, project);
  const ssh = `ssh -i ${DREAM_ROOT}/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=${DREAM_ROOT}/known_hosts -o StrictHostKeyChecking=yes`;
  const git = (...args) => asRoot(['git', '-c', `core.sshCommand=${ssh}`, ...args]);
  try { asRoot(['test', '-d', join(repo, '.git')]); } catch {
    asRoot(['mkdir', '-p', '-m', '700', CODE_ROOT]);
    git('clone', '--quiet', REPOS[project], repo);
  }
  git('-C', repo, 'fetch', '--quiet', 'origin', 'main');
  const dir = join(CODE_ROOT, 'work', `r${request}-${key}`);
  try { git('-C', repo, 'worktree', 'remove', '--force', dir); } catch {}
  git('-C', repo, 'worktree', 'prune');
  git('-C', repo, 'worktree', 'add', '--quiet', '-B', branch, dir, 'origin/main');
  const tmp = join(CODE_ROOT, 'tmp');
  asRoot(['mkdir', '-p', join(CODE_ROOT, 'target'), join(tmp, 'home'), join(tmp, 'state')]);
  const env = {
    HOME: join(tmp, 'home'), AGENT_STATE_DIR: join(tmp, 'state'), HIVE_RECORD: '0',
    CARGO_HOME: `${DREAM_ROOT}/cargo`, RUSTUP_HOME: `${DREAM_ROOT}/rustup`, PATH: `${DREAM_ROOT}/cargo/bin:/usr/local/bin:/usr/bin:/bin`,
    CARGO_TARGET_DIR: join(CODE_ROOT, 'target'), CARGO_INCREMENTAL: '0', CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never',
  };
  try {
    const result = await runAgent(['--code', dir, '--model', choice.model, '--effort', choice.effort,
      '--writable', join(CODE_ROOT, 'target'), '--writable', `${DREAM_ROOT}/cargo`, '--writable', tmp,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])], brief);
    if (git('-C', dir, 'status', '--porcelain')) {
      git('-C', dir, 'add', '-A');
      git('-C', dir, ...COMMITTER, 'commit', '--quiet', '-m',
        `${title}\n\nHive's cloud agent (${choice.model}, ${choice.effort} effort), for the owner's request R${request}, task T${request * 100 + key}.`);
    }
    const files = git('-C', dir, 'diff', '--name-only', 'origin/main', 'HEAD').split('\n').filter(Boolean);
    if (!files.length) return { ...result, files };
    git('-C', dir, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`);
    return { ...result, branch, files };
  } finally {
    try { git('-C', repo, 'worktree', 'remove', '--force', dir); } catch {}
  }
}

/** The VM's ledger syncs, which also sends this machine's Codex plan limits (Hive's home among them). */
function syncLedger() {
  try {
    execFileSync('sudo', ['-n', 'env', 'HOME=/root', '/root/.local/bin/hive-tasks', 'sync'], { stdio: 'ignore', timeout: 60_000 });
  } catch {}
}

async function main(argv) {
  const once = argv.includes('--once');
  const config = boardConfig();
  const board = boardClient(config);
  const log = line => console.log(`${new Date().toISOString()} ${line}`);
  log(`Hive's orchestrator: taking requests for hive-cloud as ${config.machine}`);
  syncLedger();
  let fresh = true;
  for (;;) {
    let request = null;
    try {
      ({ request } = await board('/v1/requests/take', { by: config.machine, agent: 'hive-cloud', fresh }));
      fresh = false;
    } catch (error) {
      log(`couldn't reach the board: ${error.message}`);
    }
    if (request) {
      await handle(request, { board, plan: planWithCodex, ask: askCodex, run: runOnVm, code: codeOnVm, log }).catch(async error => {
        log(`R${request.id} failed: ${error.stack || error}`);
        await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `The orchestrator hit an error: ${error.message}` })
          .catch(() => {});
      });
      syncLedger();
      continue;
    }
    if (once) return;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
