import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const importer = join(root, 'desktop/integration/scripts/import-pc-agent.mjs');
const run = (...args) => spawnSync(process.execPath, [importer, ...args], { encoding: 'utf8' });

test('top-level entry points resolve to existing repository components', () => {
  const output = execFileSync(process.execPath, [join(root, 'cloud/tools/check-platform.mjs')], { encoding: 'utf8' });
  assert.match(output, /ok: browser\/chrome/);
  assert.match(output, /ok: cloud\/server/);
  assert.match(output, /ok: cloud\/vm-agent/);
  assert.match(output, /pending: independent mobile agent/);
  assert.match(output, /pending: VM worker verification against live sites/);
});

test('import is opt-in, excludes secrets and refuses to overwrite', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-import-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const target = join(dir, 'dest');
  mkdirSync(join(source, 'python'), { recursive: true });
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'crates/agent-core/src'), { recursive: true });
  mkdirSync(join(source, 'examples'), { recursive: true });
  writeFileSync(join(source, 'examples/demo.txt'), 'fixture');
  mkdirSync(join(source, 'workspace-engine/.build'), { recursive: true });
  symlinkSync('/tmp', join(source, 'workspace-engine/.build/debug'));
  writeFileSync(join(source, 'Makefile'), 'all:\n');
  writeFileSync(join(source, 'python/agent.py'), 'print("example")\n');
  writeFileSync(join(source, 'tools/app.swift'), '// example\n');
  writeFileSync(join(source, 'Cargo.toml'), '[workspace]\n');
  writeFileSync(join(source, 'crates/agent-core/src/lib.rs'), 'pub fn ready() {}\n');
  writeFileSync(join(source, '.env'), 'PRIVATE=value\n');
  writeFileSync(join(source, 'python/.env.private'), 'PRIVATE=value\n');
  assert.equal(run('--source', source, '--destination', target).status, 0);
  assert.equal(existsSync(target), false);
  assert.equal(run('--source', source, '--destination', target, '--apply').status, 0);
  assert.equal(existsSync(join(target, '.env')), false);
  assert.equal(existsSync(join(target, 'python/.env.private')), false);
  assert.equal(existsSync(join(target, 'workspace-engine/.build')), false);
  assert.equal(readFileSync(join(target, 'python/agent.py'), 'utf8'), 'print("example")\n');
  assert.equal(readFileSync(join(target, 'crates/agent-core/src/lib.rs'), 'utf8'), 'pub fn ready() {}\n');
  assert.equal(readFileSync(join(target, 'Cargo.toml'), 'utf8'), '[workspace]\n');
  assert.equal(readFileSync(join(target, 'examples/demo.txt'), 'utf8'), 'fixture');
  assert.equal(existsSync(join(target, '.import-incomplete')), false);
  const manifest = JSON.parse(readFileSync(join(target, '.import-manifest.json'), 'utf8'));
  assert.equal(manifest.files.some(f => f.path.includes('.env')), false);
  assert.notEqual(run('--source', source, '--destination', target, '--apply').status, 0);
  assert.equal(readFileSync(join(target, 'python/agent.py'), 'utf8'), 'print("example")\n');
});

test('import rejects source symlinks rather than following them', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-import-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  mkdirSync(join(source, 'python'), { recursive: true });
  mkdirSync(join(source, 'tools'), { recursive: true });
  writeFileSync(join(source, 'Makefile'), 'all:\n');
  writeFileSync(join(source, 'python/agent.py'), 'pass\n');
  writeFileSync(join(source, 'tools/app.swift'), '// example\n');
  symlinkSync('/etc/passwd', join(source, 'python/linked-file'));
  assert.notEqual(run('--source', source, '--destination', join(dir, 'dest'), '--apply').status, 0);
  assert.equal(existsSync(join(dir, 'dest')), false);
});

test('import refuses a destination routed back into the source by a symlink', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-import-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  mkdirSync(join(source, 'python'), { recursive: true });
  mkdirSync(join(source, 'tools'), { recursive: true });
  writeFileSync(join(source, 'Makefile'), 'all:\n');
  writeFileSync(join(source, 'python/agent.py'), 'pass\n');
  writeFileSync(join(source, 'tools/app.swift'), '// example\n');
  symlinkSync(source, join(dir, 'alias'));
  assert.notEqual(run('--source', source, '--destination', join(dir, 'alias', 'import'), '--apply').status, 0);
  assert.equal(existsSync(join(source, 'import')), false);
});
