import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');

test('Hive assets are the gold hexagon and the iOS app is Hive', () => {
  // One icon, at the root; the dashboard links to it and the Mac app's .icns is built from it.
  const svg = readFileSync(join(root, 'branding/hive.svg'), 'utf8');
  assert.match(svg, /id="gold"/); assert.match(svg, /id="shineTop"/); assert.match(svg, /id="shineSide"/);
  assert.equal(realpathSync(join(root, 'desktop/dashboard/static/hive.svg')), realpathSync(join(root, 'branding/hive.svg')));
  const config = JSON.parse(readFileSync(join(root, 'mobile/simulator/capacitor.config.json')));
  assert.equal(config.appName, 'Hive'); assert.equal(config.appId, 'com.evanliu.hive');
  const info = readFileSync(join(root, 'mobile/ios/App/App/Info.plist'), 'utf8');
  assert.match(info, /<key>CFBundleDisplayName<\/key>\s*<string>Hive<\/string>/);
});

test('macOS package preserves bundle identity and never overwrites output', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-package-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'Agent.app'), output = join(dir, 'Hive.app');
  mkdirSync(join(source, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(source, 'Contents/MacOS/Agent'), '#!/bin/sh\nexit 0\n'); chmodSync(join(source, 'Contents/MacOS/Agent'), 0o755);
  writeFileSync(join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.personal-agent.Agent</string><key>CFBundleName</key><string>Agent</string><key>CFBundleExecutable</key><string>Agent</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('codesign', ['--force', '--sign', '-', source]);
  const script = join(root, 'desktop/integration/scripts/package-hive-macos.sh');
  execFileSync(script, [source, output], { env: { ...process.env, SIGN: '-' } });
  const plist = join(output, 'Contents/Info.plist');
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim(), 'local.personal-agent.Agent');
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', plist], { encoding: 'utf8' }).trim(), 'Hive');
  assert.ok(existsSync(join(output, 'Contents/Resources/Hive.icns')));
  assert.throws(() => execFileSync(script, [source, output], { env: { ...process.env, SIGN: '-' }, stdio: 'ignore' }));
});

test('app replacement rolls back on failure and retains the previous app on success', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-install-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, 'Agent.app'), candidate = join(dir, 'Hive.app'), backup = join(dir, 'backups');
  mkdirSync(join(old, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(old, 'Contents/MacOS/Agent'), '#!/bin/sh\nexit 0\n'); chmodSync(join(old, 'Contents/MacOS/Agent'), 0o755);
  writeFileSync(join(old, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.personal-agent.Agent</string><key>CFBundleName</key><string>Agent</string><key>CFBundleExecutable</key><string>Agent</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('codesign', ['--force', '--sign', '-', old]);
  execFileSync(join(root, 'desktop/integration/scripts/package-hive-macos.sh'), [old, candidate], { env: { ...process.env, SIGN: '-' } });
  const script = join(root, 'desktop/integration/scripts/hive-app-transaction.sh');
  const env = { ...process.env, HIVE_INSTALL_TEST_ADHOC: '1' };
  assert.throws(() => execFileSync(script, [candidate, old, backup], { env: { ...env, HIVE_TEST_FAIL_AFTER_MOVE: '1' }, stdio: 'ignore' }));
  assert.ok(existsSync(join(old, 'Contents/Info.plist')));
  assert.throws(() => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', join(old, 'Contents/Info.plist')], { stdio: 'ignore' }));
  execFileSync(script, [candidate, old, backup], { env });
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', join(old, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(), 'Hive');
  assert.match(execFileSync('ls', [backup], { encoding: 'utf8' }), /Agent-/);
  const oldCopy = readdirSync(backup).find(name => name.startsWith('Agent-') && name.endsWith('.app'));
  execFileSync(script, [join(backup, oldCopy), old, backup], { env: { ...env, HIVE_ROLLBACK: '1' } });
  assert.throws(() => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', join(old, 'Contents/Info.plist')], { stdio: 'ignore' }));
});

test('app replacement refuses mismatched entitlements', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-entitlements-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, 'Agent.app'), candidate = join(dir, 'Hive.app');
  mkdirSync(join(old, 'Contents/MacOS'), { recursive: true });
  execFileSync('cp', ['/usr/bin/true', join(old, 'Contents/MacOS/Agent')]);
  writeFileSync(join(old, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.personal-agent.Agent</string><key>CFBundleExecutable</key><string>Agent</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('codesign', ['--force', '--sign', '-', old]);
  execFileSync(join(root, 'desktop/integration/scripts/package-hive-macos.sh'), [old, candidate], { env: { ...process.env, SIGN: '-' } });
  const entitlements = join(dir, 'entitlements.plist'); writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.network.client</key><true/></dict></plist>');
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, candidate]);
  assert.match(execFileSync('codesign', ['-d', '--entitlements', ':-', candidate], { encoding: 'utf8' }), /com.apple.security.network.client/);
  assert.throws(() => execFileSync(join(root, 'desktop/integration/scripts/hive-app-transaction.sh'), [candidate, old, join(dir, 'backup')], { env: { ...process.env, HIVE_INSTALL_TEST_ADHOC: '1' }, stdio: 'ignore' }));
  assert.ok(existsSync(join(old, 'Contents/Info.plist')));
});

test('basename migration and rollback leave only one installed app', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-rename-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, 'Agent.app'), installed = join(dir, 'Hive.app'), candidate = join(dir, 'candidate.app'), backup = join(dir, 'backups');
  mkdirSync(join(old, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(old, 'Contents/MacOS/Agent'), '#!/bin/sh\nexit 0\n'); chmodSync(join(old, 'Contents/MacOS/Agent'), 0o755);
  writeFileSync(join(old, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.personal-agent.Agent</string><key>CFBundleExecutable</key><string>Agent</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('codesign', ['--force', '--sign', '-', old]);
  execFileSync(join(root, 'desktop/integration/scripts/package-hive-macos.sh'), [old, candidate], { env: { ...process.env, SIGN: '-' } });
  const transaction = join(root, 'desktop/integration/scripts/hive-app-transaction.sh'); const env = { ...process.env, HIVE_INSTALL_TEST_ADHOC: '1' };
  execFileSync(transaction, [candidate, old, backup, installed], { env });
  assert.equal(existsSync(old), false); assert.equal(existsSync(installed), true);
  const previous = readdirSync(backup).find(name => name.startsWith('Agent-') && name.endsWith('.app'));
  execFileSync(transaction, [join(backup, previous), installed, backup, old], { env: { ...env, HIVE_ROLLBACK: '1' } });
  assert.equal(existsSync(old), true); assert.equal(existsSync(installed), false);
});
