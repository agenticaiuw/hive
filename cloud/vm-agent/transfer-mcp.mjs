// File transfers have their own stable catalog. They must not depend on the managed
// desktop catalog or on which tools the Mac advertised when this task started.
import { createInterface } from 'node:readline';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { TRANSFER_TOOL } from './mac-files.mjs';
import { server as macServer } from './mac-mcp.mjs';
import { boardClient, boardConfig } from './orchestrator.mjs';

export function server({ catalogFile, ...options }) {
  const mac = macServer(options);
  const checked = new Set();
  return async message => {
    if (message.id == null) return null;
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'hivefiles', version: '1.0' },
    });
    if (message.method === 'tools/list') return reply({ tools: [TRANSFER_TOOL] });
    if (message.method === 'ping') return reply({});
    if (message.method !== 'tools/call') return {
      jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' },
    };
    const fail = text => reply({ isError: true, content: [{ type: 'text', text }] });
    if (message.params?.name !== 'transfer_file') return fail('Only transfer_file is available here.');
    const args = message.params.arguments ?? {};
    const key = JSON.stringify([args.direction, args.mac_path, args.vm_path]);
    if (args.check_only !== true && !checked.has(key)) {
      return fail('First call transfer_file with check_only=true and these same paths in this task. Require ready=true before copying.');
    }
    if (args.check_only === true) {
      checked.delete(key);
      if (catalogFile) rmSync(`${catalogFile}.probe`, { force: true });
    }
    const out = await mac(message);
    if (args.check_only === true && !out.result?.isError) {
      for (const item of out.result?.content ?? []) {
        let ready = false;
        try { ready = JSON.parse(item.text).ready === true; } catch {}
        if (!ready) continue;
        if (catalogFile) {
          try {
            const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
            if (!catalog.ok || !catalog.thread_id) return fail('The task catalog is not verified; the probe was not recorded.');
            writeFileSync(`${catalogFile}.probe`, JSON.stringify({
              thread_id: catalog.thread_id, ready: true,
            }), { mode: 0o600 });
          } catch { return fail('Could not record the live transfer probe for this task.'); }
        }
        checked.add(key);
      }
    }
    return out;
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let board = null;
  try { board = boardClient(boardConfig()); } catch {}
  const answer = server({ board, label: process.env.HIVE_TASK_LABEL, catalogFile: process.env.HIVE_TASK_CATALOG });
  createInterface({ input: process.stdin }).on('line', async line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const out = await answer(message);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
