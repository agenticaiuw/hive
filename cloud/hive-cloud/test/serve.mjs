// Serves the real worker.js over plain HTTP on 127.0.0.1, with node:sqlite standing in for
// Durable Object storage, so the Rust client can be tested end to end without Cloudflare.
//   CLAIM_SECRET=... [R2=1] [PORT=8787] node test/serve.mjs
import http from 'node:http';
import worker from '../worker.js';
import { makeCloud } from './harness.mjs';

const cloud = await makeCloud({ claimSecret: process.env.CLAIM_SECRET, r2: process.env.R2 === '1' });
cloud.env.ALLOW_HTTP = '1';
const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(parts);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  const response = await worker.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers, body }), cloud.env);
  const out = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-length': out.length });
  res.end(out);
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('listening ' + server.address().port));
