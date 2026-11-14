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
// a string the planner made up. Code tasks get at least the coding workhorse. Hive's cloud agent
// doesn't change code yet (no checkouts, read-only shell), so code tasks wait on the board for the
// owner's coding agents on the Mac.
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

/** What the subagent is told: the task, the owner's words, and every memory of its folder in full. */
export function taskBrief(task, request, folder) {
  const parts = [task.brief || task.title, `The owner's words: "${task.quote || request.text}"`];
  if (folder) {
    const memories = folder.memories ?? [];
    parts.push(memories.length
      ? `This task is in the folder "${folder.name}" of ${folder.project}. Every memory of that folder, all ${memories.length}, in full:\n\n`
        + memories.map(m => `### ${m.title} (${m.kind})\n${m.body}`).join('\n\n')
      : `This task is in the folder "${folder.name}" of ${folder.project}, which has no memories yet.`);
    if (folder.about) parts.splice(2, 0, `What the folder is for: ${folder.about}`);
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

/**
 * One request, start to end. `deps`: board(path, body?) → JSON; plan(text) → the planner's answer;
 * run(brief, choice) → {ok, report, seconds, tokensIn, tokensOut}; now() → seconds; log(line).
 */
export async function handle(request, deps) {
  const { board, plan, run, now = () => Math.floor(Date.now() / 1000), log = () => {} } = deps;
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
    if (task.kind === 'code') {
      task.status = 'waiting';
      task.outcome = "A code change: Hive's cloud agent doesn't change code yet, so it waits for a coding agent on the Mac.";
      await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
      continue;
    }
    task.status = 'active';
    await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
    const folder = await folderOf(task.folder).catch(() => null);
    log(`  T${request.id * 100 + task.key} ${task.title} → ${task.choice.model} (${task.choice.effort})`);
    let result;
    try {
      result = await run(taskBrief(task, request, folder), task.choice);
    } catch (error) {
      result = { ok: false, report: `The agent couldn't start: ${error.message}`, seconds: 0, tokensIn: 0, tokensOut: 0 };
    }
    Object.assign(task, {
      status: result.ok ? 'done' : 'blocked',
      report: result.report || null,
      outcome: outcomeOf(result.report, result.ok ? 'Done.' : 'The agent stopped before it finished.'),
      seconds: result.seconds, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    await board('/v1/requests/update', { id: request.id, tasks: [row(task)] });
    if (folder && result.report) {
      await board('/v1/folders/memory', {
        project, folder: folder.name, kind: 'report', title: `Report: ${task.title}`, body: result.report,
      }).catch(() => {});
    }
  }

  const done = tasks.filter(t => t.status === 'done').length;
  const left = tasks.filter(t => t.status !== 'done');
  const outcome = left.length
    ? `${done} of ${tasks.length} done; ${left.map(t => `${t.title} (${t.status})`).join(', ')}.`
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
function planWithCodex(words) {
  const dir = join(homedir(), 'hive-vm-agent', 'state', 'planner');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only',
    '-C', dir, '-m', PLANNER.model, '-c', `model_reasoning_effort="${PLANNER.effort}"`, '-c', 'web_search="disabled"', '-'];
  return new Promise((resolve, reject) => {
    const codex = spawn('sudo', ['-n', 'env', 'HOME=/root', `CODEX_HOME=${CODEX_HOME}`, '/root/.local/bin/codex', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    createInterface({ input: codex.stdout }).on('line', line => lines.push(line));
    let errors = '';
    codex.stderr.on('data', chunk => { errors += chunk; });
    codex.stdin.end(`${PLAN_GUIDE}\n\nThe owner's instruction:\n${words}\n`);
    const timer = setTimeout(() => codex.kill('SIGTERM'), 5 * 60_000);
    codex.on('close', status => {
      clearTimeout(timer);
      const { report } = readEvents(lines);
      if (status === 0 && report) resolve(report);
      else reject(new Error(`Codex exited with ${status}${errors.trim() ? `: ${errors.trim().split('\n').slice(-1)[0]}` : ''}`));
    });
  });
}

/** One task on the VM's screen through hive-task.mjs, with the model picked for it. */
function runOnVm(brief, choice) {
  const started = Date.now();
  return new Promise(resolve => {
    const agent = spawn(process.execPath, [join(here, 'hive-task.mjs'), '--model', choice.model, '--effort', choice.effort],
      { stdio: ['pipe', 'pipe', 'inherit'] });
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

async function main(argv) {
  const once = argv.includes('--once');
  const config = boardConfig();
  const board = boardClient(config);
  const log = line => console.log(`${new Date().toISOString()} ${line}`);
  log(`Hive's orchestrator: taking requests for hive-cloud as ${config.machine}`);
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
      await handle(request, { board, plan: planWithCodex, run: runOnVm, log }).catch(async error => {
        log(`R${request.id} failed: ${error.stack || error}`);
        await board('/v1/requests/update', { id: request.id, status: 'failed', outcome: `The orchestrator hit an error: ${error.message}` })
          .catch(() => {});
      });
      continue;
    }
    if (once) return;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
