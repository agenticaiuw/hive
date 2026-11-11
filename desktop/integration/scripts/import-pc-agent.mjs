#!/usr/bin/env node
// Copy a stable, explicit source snapshot; never merge into an existing target.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a path`);
  return args[index + 1];
}
const sourceArg = option('--source');
if (!sourceArg) throw new Error('Use --source /path/to/personal-agent [--apply]');
const source = realpathSync(sourceArg);
const target = resolve(option('--destination') ?? resolve(root, 'desktop/app'));
function canonicalFuturePath(path) {
  const suffix = [];
  let current = path;
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) throw new Error('Destination has no existing parent');
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}
const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
};
if (isWithin(source, canonicalFuturePath(target))) throw new Error('Destination must be outside the source tree');
if (existsSync(target)) throw new Error('Destination already exists; refusing to overwrite it');
for (const required of ['Makefile', 'python/agent.py', 'tools/app.swift']) {
  if (!existsSync(resolve(source, required))) throw new Error(`Missing required source: ${required}`);
}

const entries = [
  'Makefile', 'README.md', 'requirements.txt', 'Cargo.toml', 'Cargo.lock', '.env.example', 'run.sh', 'voice.sh', 'install.sh',
  'src', 'crates', 'python', 'tools', 'scripts', 'tests', 'workspace-engine', 'safari-agent-extension', 'safari-hive-extension',
  'examples', 'patches',
  'third_party/Karabiner-DriverKit-VirtualHIDDevice',
];
const excluded = new Set(['.git', '.venv', '__pycache__', 'node_modules', 'build', '.build', '.swiftpm', '.pytest_cache', 'target', 'xcuserdata',
  'models', 'captures', 'memory', 'secrets', 'dist', '.DS_Store']);
const files = [];
const digest = data => createHash('sha256').update(data).digest('hex');
function walk(rel) {
  const path = resolve(source, rel);
  if (!existsSync(path)) return;
  const name = rel.split('/').at(-1);
  if (excluded.has(name) || name === '.env' || (name.startsWith('.env.') && name !== '.env.example') ||
      /\.(pyc|log|pem|p12|pfx|key|xcuserstate|xcuserdatad)$/i.test(name)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing source symlink: ${rel}`);
  if (info.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(`${rel}/${name}`);
  } else if (info.isFile()) {
    const data = readFileSync(path);
    files.push({ rel, hash: digest(data), mode: info.mode & 0o777 });
  } else {
    throw new Error(`Unsupported source entry: ${rel}`);
  }
}
for (const entry of entries) walk(entry);
console.log(`${args.includes('--apply') ? 'Importing' : 'Dry run:'} ${files.length} source files; local runtime data excluded.`);
if (!args.includes('--apply')) process.exit(0);

mkdirSync(dirname(target), { recursive: true });
const staging = resolve(dirname(target), `.pc-agent-import-${randomUUID()}`);
mkdirSync(staging, { mode: 0o700 });
try {
  for (const file of files) {
    const data = readFileSync(resolve(source, file.rel));
    if (digest(data) !== file.hash) throw new Error(`Source changed during import: ${file.rel}`);
    const out = resolve(staging, file.rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data, { mode: file.mode, flag: 'wx' });
  }
  // Detect edits made while other files were being copied; never publish a known mixed snapshot.
  for (const file of files) {
    if (digest(readFileSync(resolve(source, file.rel))) !== file.hash)
      throw new Error(`Source changed during import: ${file.rel}`);
  }
  // Also reject additions and removals: a file-by-file recheck alone misses new
  // sources created after the initial walk and can publish an incomplete tree.
  const initialFiles = files.splice(0);
  for (const entry of entries) walk(entry);
  if (initialFiles.length !== files.length || initialFiles.some((file, i) =>
    file.rel !== files[i].rel || file.hash !== files[i].hash || file.mode !== files[i].mode))
    throw new Error('Source tree changed during import; retry after edits settle');
  writeFileSync(resolve(staging, '.import-manifest.json'), JSON.stringify({
    format: 1, importedAt: new Date().toISOString(), files: files.map(({ rel, hash }) => ({ path: rel, sha256: hash })),
  }, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  // Reserve the target exclusively. Never rename over an existing directory.
  mkdirSync(target, { mode: 0o755 });
  const incomplete = resolve(target, '.import-incomplete');
  writeFileSync(incomplete, 'Import in progress; inspect before using this folder.\n', { flag: 'wx' });
  for (const name of readdirSync(staging)) {
    const destination = resolve(target, name);
    if (existsSync(destination)) throw new Error(`Destination changed during import: ${name}`);
    renameSync(resolve(staging, name), destination);
  }
  unlinkSync(incomplete);
  rmSync(staging, { recursive: true });
  console.log('Imported the source snapshot. Existing runtime and credentials were not changed.');
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
