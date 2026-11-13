#!/usr/bin/env node
// Hive's agent on the VM: one task, given in words, done by Codex on the VM's own screen.
//
// Codex here is the VM's existing install (the one Devhub runs, in root's home), with a Codex home of
// its own signed in to the owner's ChatGPT account (HIVE_CODEX_HOME, default /root/.codex-hive). It
// runs with no config file (--ignore-user-config), keeps no session files (--ephemeral), and gets two
// tool servers, run as this user: desktop-mcp.mjs, the VM's screen, mouse and keyboard, saved logins
// and the files sent to Hive; and phone-mcp.mjs, the owner's phone through their Mac (for Duo).
// Shell commands it might run are read-only. Each step it says goes to stdout and to the task's folder.
//
//   node hive-task.mjs [--model m] [--effort e] [--keep-open] < task.txt   (or {"text"} as JSON)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { call } from './ctl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAFE = /^[\w@%+=:,./~-]+$/;

export const GUIDE = `You are Hive's agent, working on the owner's cloud VM for them. You see and use the VM's screen
through the desktop tools: an ordinary Chrome browser, signed in to the owner's accounts, on a 1440x900 screen.
Before each tool call, say what you are about to do in the tool's \`step\` field. Look at the screenshot every action
returns before the next action. Work like a careful person at the keyboard; don't guess at what you can't see.
Files the owner sent to Hive are on the VM: list_files shows them with the path to type into a file picker
(in Chrome's file dialog, ctrl+L opens a path box).
Only do what the task asks. Anything sent, posted or published as the owner uses their exact words, once:
never reword, shorten or "fix" them, and never send something twice. If you can't tell whether something
went out, look (for example at their profile) instead of sending it again. If you can't do the task exactly
as asked, stop and say why. End with a short report of what you did, including any link to what you posted.

Signing in: the VM keeps the owner's saved passwords, like their Mac. On a sign-in page, click the field and use
authenticate (never ask for or type a password yourself). If the site then asks for Duo, use the phone tools: they
are the owner's real iPhone. Look with phone.screenshot; if it is locked, phone.authenticate unlocks it; tap Approve
(or "Yes, it's me") on the Duo request for this sign-in, then check the VM screen. Only approve a request you just
caused, and do nothing else on the phone. If the phone tools are missing or say the phone isn't reachable, stop
and say so.`;

export function codexArgs({ model, effort, workDir, appDir, stateDir, filesDir, stepsFile, node = process.execPath, user = process.env.USER ?? 'ubuntu' }) {
  for (const value of [model, effort, workDir, appDir, stateDir, filesDir, stepsFile, node, user]) {
    if (!SAFE.test(value)) throw new Error(`unsupported characters in "${value}"`);
  }
  const toml = value => JSON.stringify(value); // TOML basic strings and arrays of them read like JSON
  const server = ['-n', '-u', user, 'env', `HIVE_VM_STATE=${stateDir}`, `HIVE_FILES_DIR=${filesDir}`, `HIVE_TASK_STEPS=${stepsFile}`,
    node, join(appDir, 'desktop-mcp.mjs')];
  const phone = ['-n', '-u', user, 'env', `HIVE_VM_STATE=${stateDir}`, node, join(appDir, 'phone-mcp.mjs')];
  return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only', '-C', workDir,
    '-m', model, '-c', `model_reasoning_effort=${toml(effort)}`, '-c', 'web_search="disabled"',
    '-c', 'mcp_servers.desktop.command="sudo"', '-c', `mcp_servers.desktop.args=${toml(server)}`,
    '-c', 'mcp_servers.desktop.startup_timeout_sec=60', '-c', 'mcp_servers.desktop.tool_timeout_sec=300',
    '-c', 'mcp_servers.phone.command="sudo"', '-c', `mcp_servers.phone.args=${toml(phone)}`,
    '-c', 'mcp_servers.phone.startup_timeout_sec=30', '-c', 'mcp_servers.phone.tool_timeout_sec=180', '-'];
}

/** One line for a person, from one of Codex's JSON events; null for the rest. */
export function describe(event) {
  const item = event.item;
  if (event.type === 'item.started' && item?.type === 'mcp_tool_call') return `→ ${item.tool}: ${item.arguments?.step ?? ''}`.trimEnd();
  if (event.type === 'item.completed' && item?.type === 'mcp_tool_call' && item.status === 'failed') return `  ✗ ${item.tool} failed: ${item.error?.message ?? ''}`.trimEnd();
  if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') {
    const text = (item.result?.content ?? []).find(part => part.type === 'text')?.text ?? '';
    return /^Failed:/.test(text) ? `  ✗ ${text}` : null;
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message') return `💬 ${item.text}`;
  if (event.type === 'item.completed' && item?.type === 'command_execution') return `$ ${item.command}`;
  if (event.type === 'turn.failed' || event.type === 'error') return `❌ ${event.error?.message ?? event.message ?? 'Codex stopped'}`;
  return null;
}

async function main(argv) {
  const options = { model: process.env.HIVE_TASK_MODEL ?? 'gpt-6.1-terra', effort: process.env.HIVE_TASK_EFFORT ?? 'low', keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') options.model = argv[++i];
    else if (argv[i] === '--effort') options.effort = argv[++i];
    else if (argv[i] === '--keep-open') options.keepOpen = true;
    else { console.error(`unknown option ${argv[i]}`); process.exit(2); }
  }
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  let text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.startsWith('{')) text = String(JSON.parse(text).text ?? '').trim();
  if (!text) { console.error('give the task as text on stdin'); process.exit(2); }

  const stateDir = process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state');
  const filesDir = process.env.HIVE_FILES_DIR ?? join(homedir(), 'hive-files');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const workDir = join(stateDir, 'tasks', id);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workDir, 'task.txt'), `${text}\n`);
  const stepsFile = join(workDir, 'steps.log');
  const events = join(workDir, 'events.jsonl');
  const say = line => { console.log(line); appendFileSync(join(workDir, 'progress.log'), `${line}\n`); };
  say(`Task ${id} (Codex ${options.model}, ${options.effort} effort)`);

  // Hive's own Codex home on the VM, signed in to the owner's account (Devhub's, /root/.codex, is another).
  const codexHome = process.env.HIVE_CODEX_HOME ?? '/root/.codex-hive';
  if (!SAFE.test(codexHome)) throw new Error('unsupported HIVE_CODEX_HOME');
  const codex = spawn('sudo', ['-n', 'env', 'HOME=/root', `CODEX_HOME=${codexHome}`, '/root/.local/bin/codex',
    ...codexArgs({ ...options, workDir, appDir: here, stateDir, filesDir, stepsFile })], { stdio: ['pipe', 'pipe', 'pipe'] });
  codex.stdin.end(`${GUIDE}\n\nThe task, from the owner:\n${text}\n`);
  let last = '';
  createInterface({ input: codex.stdout }).on('line', line => {
    appendFileSync(events, `${line}\n`);
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') last = event.item.text;
    const line2 = describe(event); if (line2) say(line2);
  });
  let errors = '';
  codex.stderr.on('data', chunk => { errors += chunk; appendFileSync(join(workDir, 'codex.err'), chunk); });
  const status = await new Promise(resolve => codex.on('close', resolve));
  if (!options.keepOpen) {
    // Asked, not killed: the browser saves its cookies as it quits, and the worker gets it back.
    await call(join(stateDir, 'control.sock'), 'POST', '/desktop/close', Buffer.from('{}')).catch(() => {});
  }
  if (status !== 0) say(`❌ Codex exited with ${status}${errors.trim() ? `: ${errors.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  else say(`✅ Done. ${last ? '' : '(no report)'}`.trim());
  process.exit(status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
