#!/usr/bin/env node
// Talk to the running worker over its control socket.
//   node ctl.mjs status | posts | screenshot
//   echo '{"platform":"discord",...}' | node ctl.mjs draft        (JSON on stdin for every POST)
//   node ctl.mjs upload <name> < file
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROUTES = {
  status: ['GET', '/status'], posts: ['GET', '/posts'], post: ['GET', '/post'], screenshot: ['GET', '/screenshot'],
  check: ['POST', '/check'], draft: ['POST', '/draft'], approve: ['POST', '/approve'], send: ['POST', '/send'],
  cancel: ['POST', '/cancel'], discover: ['POST', '/discover'], 'view-open': ['POST', '/view/open'], 'view-close': ['POST', '/view/close'],
  upload: ['POST', '/upload'], 'desktop-open': ['POST', '/desktop/open'], 'desktop-close': ['POST', '/desktop/close'],
};

const readStdin = async () => { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks); };

export function call(socketPath, method, path, body) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path, headers: body ? { 'content-length': body.length } : {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, argument] = process.argv.slice(2);
  const route = ROUTES[command];
  if (!route) { console.error(`usage: ctl.mjs <${Object.keys(ROUTES).join('|')}>`); process.exit(2); }
  const socketPath = join(process.env.HIVE_VM_STATE ?? join(homedir(), '.hive', 'vm-agent'), 'control.sock');
  let [method, path] = route; let body;
  if (command === 'upload') { path += `?name=${encodeURIComponent(argument ?? '')}`; body = await readStdin(); }
  else if (method === 'POST') { body = process.stdin.isTTY ? Buffer.from('{}') : await readStdin(); if (!body.length) body = Buffer.from('{}'); }
  else if (argument) path += `?${command === 'post' ? 'id' : 'limit'}=${encodeURIComponent(argument)}`;
  try {
    const result = await call(socketPath, method, path, body);
    console.log(JSON.stringify(result.body));
    process.exit(result.status === 200 ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ error: 'worker_unreachable', message: error.message }));
    process.exit(1);
  }
}
