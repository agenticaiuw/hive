#!/usr/bin/env node
// The owner's knowledge base, for Hive's agent on the VM (and the phone tasks it runs): an MCP server
// over stdio whose two tools, lookup and save, are the Mac's (hive-knowledge knowledge.rs tools()),
// answered by the board in the cloud (POST /v1/knowledge/lookup and /save, cloud/tasks/knowledge.js),
// which keeps the one knowledge table every node shares. The board checks every save the way the
// Mac does: the same fact is never stored twice, and passwords, codes, keys, tokens, card and bank
// numbers and Social Security numbers are refused.
//
// The board's address and the machines' token are root's hive-tasks config, read as orchestrator.mjs
// reads it and never printed. HIVE_TASK_FILE is the task's task.txt (its first line is what the fact
// is saved with); HIVE_KNOWLEDGE_DEVICE names the device ("vm" unless set). Without the board config
// it still answers, with no tools and a note saying why.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { boardClient, boardConfig } from './orchestrator.mjs';

export const OFFLINE = "The owner's knowledge base isn't reachable: this VM doesn't have the board's key "
  + '(/root/.config/hive/tasks.json), so the knowledge tools are unavailable.';
export const MAX_FACTS = 30;

const step = { type: 'string', description: 'What this step is for, in a few words.' };
const fact = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Whom or what it is about: "owner" for the owner, else a person\'s or organization\'s name, an account, a place or a thing.' },
    attribute: { type: 'string', description: 'Which fact: "phone number", "school email", "role", "address".' },
    value: { type: 'string', description: 'The fact itself, exactly as seen.' },
    source: { type: 'string', description: 'Where you learned it: "Contacts, My Card", "WIN confirmation page".' },
    kind: { type: 'string', enum: ['fact', 'inference'], default: 'fact', description: '"inference" when you concluded it rather than saw it.' },
    replaces: { type: 'boolean', default: false, description: "True when this value replaces the subject's earlier value for the attribute (a new address); the earlier one is kept, marked outdated." },
  },
  required: ['subject', 'attribute', 'value', 'source'],
};

export const TOOLS = [
  {
    name: 'lookup',
    description: "Look up facts in the owner's knowledge base (in the cloud) before searching the computer or the web for them. "
      + 'Words to find, e.g. "owner phone number" or "Agentic AI UW"; empty lists the newest facts.',
    inputSchema: { type: 'object', properties: {
      step,
      query: { type: 'string', default: '' },
      subject: { type: 'string', default: '', description: 'Only facts about this subject.' },
      include_outdated: { type: 'boolean', default: false },
    } },
  },
  {
    name: 'save',
    description: "Save lasting facts you learned to the owner's knowledge base (in the cloud). It checks for each fact first and "
      + "never stores one twice, so there's no need to look up before saving. Send all of a task's facts in one call. Never "
      + 'passwords, codes, keys, tokens, card or bank numbers.',
    inputSchema: { type: 'object', properties: {
      step,
      facts: { type: 'array', minItems: 1, maxItems: MAX_FACTS, items: fact },
    }, required: ['facts'] },
  },
];

/** What the task is, for the facts it saves: the first line of its task.txt, or nothing. */
export function taskLine(env = process.env, read = path => readFileSync(path, 'utf8')) {
  if (!env.HIVE_TASK_FILE) return '';
  try {
    return (read(env.HIVE_TASK_FILE).split('\n').find(line => line.trim()) ?? '').trim().slice(0, 300);
  } catch {
    return '';
  }
}

/** One tool call: the board's words for the agent. */
export async function callTool(board, name, args = {}, { task = '', device = 'vm' } = {}) {
  if (name === 'lookup') {
    const answer = await board('/v1/knowledge/lookup', {
      query: String(args.query ?? ''), subject: String(args.subject ?? ''), include_outdated: args.include_outdated === true,
    });
    return answer.text;
  }
  if (name === 'save') {
    const facts = Array.isArray(args.facts) ? args.facts : [args];
    return (await board('/v1/knowledge/save', { facts, task, device })).text;
  }
  throw new Error(`There is no knowledge tool ${JSON.stringify(name)} (use lookup or save).`);
}

export async function answer(board, message, context) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'knowledge', version: '1.0' },
        instructions: board ? "The owner's knowledge base in the cloud: look facts up, save new ones." : OFFLINE });
    case 'tools/list': return reply({ tools: board ? TOOLS : [] });
    case 'ping': return reply({});
    case 'tools/call':
      if (!board) return reply({ content: [{ type: 'text', text: OFFLINE }], isError: true });
      try {
        return reply({ content: [{ type: 'text', text: await callTool(board, message.params?.name, message.params?.arguments ?? {}, context) }] });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: `Failed: ${error.message}` }], isError: true });
      }
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let board = null;
  try { board = boardClient(boardConfig()); } catch {}
  const context = { task: taskLine(), device: (process.env.HIVE_KNOWLEDGE_DEVICE || 'vm').slice(0, 40) };
  createInterface({ input: process.stdin }).on('line', async line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const out = await answer(board, message, context);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
