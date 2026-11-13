#!/usr/bin/env node
// The owner's phone, for Hive's agent on the VM: an MCP server over stdio that is really the Mac's
// (desktop/hive-bridge.mjs forwards build/hive-phone-mcp to <state>/mac-phone.sock over SSH). This
// passes Codex's messages through. When the Mac's bridge isn't up it still answers, with no tools and
// a note saying so, so the task can say why it can't approve a sign-in instead of failing to start.
import { connect } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const SOCKET = join(process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state'), 'mac-phone.sock');
export const OFFLINE = "The owner's phone isn't reachable: Hive's bridge on their Mac isn't running (desktop/hive-bridge.mjs), "
  + 'so the phone tools are unavailable. Sign-ins that need the phone (Duo) can\'t be approved now.';

/** Answers for when the Mac isn't there: initialize, no tools, and an error for any call. */
export function offlineAnswer(message) {
  if (message.id === undefined || message.id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'phone', version: '1.0' }, instructions: OFFLINE });
  }
  if (message.method === 'tools/list') return reply({ tools: [] });
  if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: OFFLINE }], isError: true });
  if (message.method === 'ping') return reply({});
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } };
}

function offline() {
  createInterface({ input: process.stdin }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const answer = offlineAnswer(message);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const socket = connect(SOCKET);
  let connected = false;
  socket.once('connect', () => {
    connected = true;
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on('close', () => process.exit(0));
    process.stdin.on('end', () => socket.end());
  });
  socket.on('error', () => { socket.destroy(); if (connected) process.exit(1); else offline(); });
}
