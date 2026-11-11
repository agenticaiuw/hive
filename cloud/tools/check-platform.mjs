#!/usr/bin/env node
// Validate the public entry points without starting services or changing files.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const components = {
  'browser/chrome': 'browser/chrome',
  'browser/safari': 'browser/safari',
  'cloud/server': 'cloud/server',
  'cloud/worker': 'cloud/worker',
  'cloud/vm-agent': 'cloud/vm-agent',
  'mobile/ios': 'mobile/ios',
  'wearable/hardware': 'wearable/hardware',
  'wearable/firmware': 'wearable/firmware',
  'desktop': 'desktop',
};
let failed = false;
for (const [entry, expected] of Object.entries(components)) {
  const path = resolve(root, entry);
  const target = resolve(root, expected);
  if (!existsSync(path) || !existsSync(target)) {
    console.error(`missing: ${entry}`);
    failed = true;
    continue;
  }
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    console.error(`not a physical directory: ${entry}`);
    failed = true;
    continue;
  }
  const actual = realpathSync(path);
  const inside = relative(root, actual);
  if (inside === '..' || inside.startsWith(`..${sep}`) || actual !== realpathSync(target)) {
    console.error(`incorrect target: ${entry}`);
    failed = true;
    continue;
  }
  console.log(`ok: ${entry}`);
}
if (!existsSync(resolve(root, 'desktop/app/crates/hive/Cargo.toml'))) {
  console.log('pending: personal-agent source import');
}
console.log('pending: independent mobile agent');
console.log('pending: VM worker verification against live sites');
process.exitCode = failed ? 1 : 0;
