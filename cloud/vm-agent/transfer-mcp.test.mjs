import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from './transfer-mcp.mjs';
import { transferProbed } from './task-catalog.mjs';

const args = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Checking the file transfer.' };
const request = arguments_ => ({ id: 1, method: 'tools/call', params: { name: 'transfer_file', arguments: arguments_ } });

test('the dedicated catalog is stable without a board or a connected Mac', async () => {
  for (const board of [null, async () => ({ macs: [] }), async () => { throw new Error('offline'); }]) {
    const answer = server({ board });
    assert.equal((await answer({ id: 1, method: 'initialize' })).result.serverInfo.name, 'hivefiles');
    const listed = await answer({ id: 2, method: 'tools/list' });
    assert.deepEqual(listed.result.tools.map(t => t.name), ['transfer_file']);
    assert.equal(listed.result.tools[0].inputSchema.properties.check_only.type, 'boolean');
    assert.equal((await answer(request({ ...args, check_only: true }))).result.isError, true);
  }
});

test('only a live probe from this task unlocks its copy and records runtime evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-transfer-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogFile = join(dir, 'runtime-catalog.json');
  writeFileSync(catalogFile, JSON.stringify({ ok: true, thread_id: 'current' }));
  let online = true;
  const calls = [];
  const expected = { size: 5, sha256: 'a'.repeat(64) };
  const board = async (path, body) => {
    if (path.startsWith('/v1/mac/status')) return { macs: [{ name: 'fixture', tools: [{ name: 'run_command' }] }] };
    calls.push(body);
    return { call: { status: 'done', result: online
      ? { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0, stdout: JSON.stringify(expected) }) }] }
      : { isError: true, content: [{ type: 'text', text: 'The Mac did not answer.' }] } } };
  };
  const options = { board, catalogFile, label: 'R42-1', files: { uuid: () => 'fixture', fetch: async () => '/files/clip.mov' } };
  const answer = server(options);
  assert.equal((await answer(request(args))).result.isError, true);
  assert.equal(calls.length, 0, 'unprobed copies never reach the Mac');
  const probe = await answer(request({ ...args, check_only: true }));
  assert.equal(JSON.parse(probe.result.content[0].text).ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.command, '/usr/bin/true');
  assert.equal(calls[0].request, 42);
  assert.equal(transferProbed(catalogFile, 'current'), true);
  assert.equal(transferProbed(catalogFile, 'other'), false);
  assert.equal((await answer(request({ ...args, mac_path: '/Desktop/other.mov' }))).result.isError, true);
  assert.equal((await server(options)(request(args))).result.isError, true, 'a new execution must probe again');
  assert.equal((await answer(request(args))).result.isError, undefined);
  online = false;
  assert.equal((await answer(request({ ...args, check_only: true }))).result.isError, true);
  assert.equal(transferProbed(catalogFile, 'current'), false, 'a failed recheck revokes the earlier evidence');
  assert.equal((await answer(request(args))).result.isError, true);
});

test('the dedicated stdio entry point advertises and probes through the board route', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-transfer-stdio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = join(dir, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ ok: true, thread_id: 'fixture' }));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ url: 'https://board.invalid', token: 'fixture' }));
  const preload = join(dir, 'board.mjs');
  writeFileSync(preload, `
globalThis.fetch = async (url, options) => {
  if (options.headers.authorization !== 'Bearer fixture') throw new Error('Wrong board config');
  if (url.endsWith('/v1/mac/status?tools=1')) return Response.json({ macs: [{ name: 'fixture', tools: [{ name: 'run_command' }] }] });
  const call = JSON.parse(options.body);
  if (!url.endsWith('/v1/mac/calls') || call.name !== 'run_command' || call.arguments.command !== '/usr/bin/true') throw new Error('Only the harmless probe may run');
  return Response.json({ call: { status: 'done', result: { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0 }) }] } } });
};
`);
  writeFileSync(join(dir, 'input'), [
    { id: 2, method: 'initialize' }, { id: 3, method: 'tools/list' }, request({ ...args, check_only: true }),
  ].map(JSON.stringify).join('\n') + '\n');
  // File-backed stdio exercises the real entry point even where the repair sandbox
  // prevents Node children from reading a pipe. The board remains a local fixture.
  const fds = [openSync(join(dir, 'input'), 'r'), openSync(join(dir, 'output'), 'w'), openSync(join(dir, 'errors'), 'w')];
  const child = spawn(process.execPath, [join(import.meta.dirname, 'transfer-mcp.mjs')], {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${preload}`, HIVE_TASKS_CONFIG: join(dir, 'board.json'),
      HIVE_TASK_CATALOG: catalog, HIVE_TASK_LABEL: 'R42-1' }, stdio: fds,
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  for (const fd of fds) closeSync(fd);
  assert.equal(code, 0, readFileSync(join(dir, 'errors'), 'utf8'));
  const replies = readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(replies.find(r => r.id === 2).result.serverInfo.name, 'hivefiles');
  assert.equal(replies.find(r => r.id === 3).result.tools[0].name, 'transfer_file');
  assert.equal(JSON.parse(replies.find(r => r.id === 1).result.content[0].text).ready, true);
  assert.equal(transferProbed(catalog, 'fixture'), true);
});
