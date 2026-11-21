#!/usr/bin/env node
// The owner's Mac, for Hive's agent on the VM (owner, 2026-11-18: "The Mac's agent still thinks on the
// Mac... the design goal is a cloud brain driving the Mac"): an MCP server over stdio whose tools are
// the Mac's own (hive-mac MacTools: screenshot, click, type_text, open_app...), as Hive on the Mac
// listed them on the board, and whose every call goes through the board (cloud/tasks/mac.js) to Hive on
// the Mac, which runs it with its own tools and rules (the owner taking the mouse and keyboard, a
// one-way step quoting the owner's words for this request) and sends back what came of it.
//
// One task at a time drives the Mac: the first call waits for this task's turn (devices.mjs), held
// until the task ends. HIVE_TASK_LABEL ("R12-1") says whose turn it is and which request a call is for,
// so the Mac checks one-way steps against that request's words. The board's address and token are
// root's hive-tasks config, read as orchestrator.mjs reads it and never printed.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { endWithTask, Lease } from './devices.mjs';
import { boardClient, boardConfig } from './orchestrator.mjs';

export const OFFLINE = "The owner's Mac isn't connected: Hive isn't running there or the Mac is offline, so the mac tools "
  + "are unavailable. Use the VM's screen, or say the task needs the Mac.";
const NO_BOARD = "The owner's Mac can't be reached: this VM doesn't have the board's key (/root/.config/hive/tasks.json).";
// The board answers a held call every 25 s; a call ends within the Mac's own limit (mac.js RUN_MS).
const WAIT_S = 25;
const MOST_MS = 6 * 60_000;

/** The request a task label is for: "R12-1" → 12. */
export const requestOf = label => Number(/^R(\d+)-\d+$/.exec(label ?? '')?.[1]) || null;

/** The Mac to use (the one that asked for work last) and its tools; null when none is connected. */
export async function connectedMac(board) {
  const { macs = [] } = await board('/v1/mac/status?tools=1');
  const mac = macs.find(m => Array.isArray(m.tools) && m.tools.length);
  return mac ? { name: mac.name, about: mac.about || '', tools: mac.tools } : null;
}

/** One call on the Mac, waiting for what came of it: the Mac tool's own MCP result. */
export async function callMac(board, mac, name, args, { request = null, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const started = now();
  let call, id;
  // Losing a reply, even while submitting, does not undo an action. Keep the last known call id
  // so the agent can inspect it instead of sending an irreversible command a second time.
  const failed = (reason, uncertain = true) => ({ content: [{ type: 'text', text: `Failed: ${reason}` + (uncertain
    ? ` The Mac call${id == null ? '' : ` ${id}`} may still run or may already have run. Inspect the outcome before retrying. Do not retry an uncertain send.`
    : '') }], isError: true });
  try {
    ({ call } = await board('/v1/mac/calls', { name, arguments: args ?? {}, mac: mac?.name ?? '', request, wait: WAIT_S }));
    id = call?.id;
    while (call && (call.status === 'queued' || call.status === 'running')) {
      if (now() - started > MOST_MS) {
        const cancelled = await board('/v1/mac/cancel', { id }).catch(() => null);
        return failed(`the Mac didn't answer within ${MOST_MS / 60_000} minutes.`, !cancelled?.cancelled);
      }
      ({ call } = await board(`/v1/mac/calls?id=${id}&wait=${WAIT_S}`));
      if (!call) break;
      if (call.status === 'queued' || call.status === 'running') await sleep(10);
    }
  } catch (error) {
    return failed(error.message);
  }
  if (call?.result) return call.result;
  return failed(call?.error ?? 'the board lost the call', !['expired', 'cancelled'].includes(call?.status));
}

export function server({ board, label = '', turn = null, files = undefined }) {
  let mac;
  const find = async () => {
    if (mac === undefined) mac = board ? await connectedMac(board).catch(() => null) : null;
    return mac;
  };
  return async message => {
    if (message.id === undefined || message.id === null) return null;
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize': {
        const found = await find();
        return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'mac', version: '1.0' },
          instructions: !board ? NO_BOARD : found
            ? `${found.about || "The owner's Mac"} (${found.name}), reached through the cloud: their own computer, which they may be using.`
            : OFFLINE });
      }
      case 'tools/list': {
        const tools = (await find())?.tools ?? [];
        // The orchestrator uses this module's Mac calls, but never serves task tools. Load
        // transfers only in the task process so their updates need no orchestrator restart.
        const { TRANSFER_TOOL } = await import('./mac-files.mjs');
        return reply({ tools: tools.some(t => t.name === 'run_command') ? [...tools, TRANSFER_TOOL] : tools });
      }
      case 'ping': return reply({});
      case 'tools/call': {
        const found = await find();
        if (!found) return reply({ content: [{ type: 'text', text: board ? OFFLINE : NO_BOARD }], isError: true });
        // Transfers compose its command tool with cloud storage. Everything else must be listed
        // by the Mac; hive_self (Hive changing itself) remains the orchestrator's call.
        const transfer = message.params?.name === 'transfer_file' && found.tools.some(t => t.name === 'run_command');
        if (!transfer && !found.tools.some(t => t?.name === message.params?.name)) {
          return reply({ content: [{ type: 'text', text: `Failed: the Mac has no tool ${message.params?.name ?? ''}.` }], isError: true });
        }
        const call = (name, args) => callMac(board, found, name, args, { request: requestOf(label) });
        const run = async () => transfer
          ? (await import('./mac-files.mjs')).transferFile(message.params?.arguments ?? {}, args => call('run_command', args), files)
          : call(message.params?.name, message.params?.arguments ?? {});
        try {
          return reply(await (turn ? turn.use(run) : run()));
        } catch (error) {
          return reply({ content: [{ type: 'text', text: `Failed: ${error.message}` }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let board = null;
  try { board = boardClient(boardConfig()); } catch {}
  const label = process.env.HIVE_TASK_LABEL || 'a task started by hand';
  const state = process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state');
  const turn = new Lease(join(state, 'devices.sock'), 'mac', label);
  endWithTask(turn);
  const answer = server({ board, label, turn });
  createInterface({ input: process.stdin }).on('line', async line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const out = await answer(message);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
