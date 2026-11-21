// One Codex app-server for all of Hive's agents; each agent is a thread in it. Hive's tools are
// the app-server's dynamic tools: their calls come back here and Hive answers them.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function codex({ command, args = ['app-server'], env, spawnProcess = spawn, onTool, onEvent }) {
  let child = null, ready = null, serial = 0;
  const pending = new Map();
  const send = message => child?.stdin.write(`${JSON.stringify(message)}\n`);
  const call = (method, params, ms = 120_000) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });

  function start() {
    child = spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex stopped.')); }
      pending.clear(); child = null; ready = null;
      onEvent?.('hive/codexStopped', {});
    });
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && !message.method) {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id); clearTimeout(p.timer);
        return message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
      }
      if (message.id != null) {
        if (message.method !== 'item/tool/call' || !onTool) {
          return send({ id: message.id, error: { code: -32601, message: 'Hive answers no interactive requests.' } });
        }
        Promise.resolve().then(() => onTool(message.params ?? {}))
          .then(result => send({ id: message.id, result }))
          .catch(error => send({ id: message.id, result: { success: false,
            contentItems: [{ type: 'inputText', text: String(error?.message ?? error) }] } }));
        return;
      }
      onEvent?.(message.method, message.params ?? {});
    });
    ready = call('initialize', { clientInfo: { name: 'hive', version: '1' }, capabilities: { experimentalApi: true } });
    ready.catch(() => {});
  }

  return {
    async request(method, params, ms) {
      if (!child) start();
      await ready;
      return call(method, params, ms);
    },
    close() { child?.kill(); },
  };
}

/** Text and images a tool returns, in the shape the app-server takes. */
export function toolResult(result) {
  if (result?.contentItems) return result;
  const items = [];
  for (const part of Array.isArray(result) ? result : [result]) {
    if (part?.image) items.push({ type: 'inputImage', imageUrl: part.image });
    else items.push({ type: 'inputText', text: typeof part === 'string' ? part : JSON.stringify(part) });
  }
  return { success: !(result?.error), contentItems: items };
}
