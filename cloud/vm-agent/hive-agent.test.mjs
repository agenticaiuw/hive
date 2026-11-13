// Hive's agent on the VM: the VNC client it sees and acts through, its tools' plain parts, the saved
// logins, file keys, the phone pass-through, and how Codex is started. No VM, Codex or phone needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Vnc, charKeysym, comboKeysyms, encodePng, untypable } from './vnc.mjs';
import { checkKey, contentType, localPath } from './files.mjs';
import { hostOf, loginsFromCsv, merge, parseCsv, pick } from './hive-cred.mjs';
import { TOOLS, parseOwnerTime } from './desktop-mcp.mjs';
import { CODE_GUIDE, GUIDE, codeArgs, codexArgs, describe } from './hive-task.mjs';
import { OFFLINE, offlineAnswer } from './phone-mcp.mjs';

const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'hive-agent-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('only printable ASCII, Return and Tab count as typable on the VM', () => {
  assert.deepEqual(untypable('Hello, world!\n\tok ~'), []);
  assert.deepEqual(untypable('café 🔥🔥'), ['é', '🔥']);
  assert.equal(charKeysym('a'), 0x61);
  assert.equal(charKeysym('\n'), 0xff0d);
  assert.equal(charKeysym('\t'), 0xff09);
});

test('key combos name keys or single characters, and cmd is Control on Linux', () => {
  assert.deepEqual(comboKeysyms('ctrl+shift+t'), [0xffe3, 0xffe1, 0x74]);
  assert.deepEqual(comboKeysyms('cmd+L'), [0xffe3, 0x6c]);
  assert.deepEqual(comboKeysyms('ctrl++'), [0xffe3, 0x2b]);
  assert.deepEqual(comboKeysyms('Enter'), [0xff0d]);
  assert.throws(() => comboKeysyms('ctrl+banana'), /unknown key/);
  assert.throws(() => comboKeysyms(''), /no key/);
});

test('a screen picture is a valid PNG of the pixels given', () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const png = encodePng(2, 2, rgb);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 2);
  const idatAt = png.indexOf('IDAT');
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)));
  assert.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
});

/** A tiny RFB 3.8 server: a 4x2 screen, no password; records the client's key and pointer events. */
function fakeVnc(t) {
  const path = join(tempDir(t), 'vnc.sock');
  const events = [];
  const server = createServer(socket => {
    let stage = 'version'; let buffer = Buffer.alloc(0);
    socket.write('RFB 003.008\n');
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === 'version') { if (buffer.length < 12) return; buffer = buffer.subarray(12); socket.write(Buffer.from([1, 1])); stage = 'security'; }
        else if (stage === 'security') { if (buffer.length < 1) return; buffer = buffer.subarray(1); socket.write(Buffer.alloc(4)); stage = 'init'; }
        else if (stage === 'init') {
          if (buffer.length < 1) return; buffer = buffer.subarray(1);
          const init = Buffer.alloc(24 + 4); init.writeUInt16BE(4, 0); init.writeUInt16BE(2, 2); init.writeUInt32BE(4, 20); init.write('fake', 24);
          socket.write(init); stage = 'run';
        } else {
          if (!buffer.length) return;
          if (buffer[0] === 2 && buffer.length < 4) return;
          const need = buffer[0] === 2 ? 4 + buffer.readUInt16BE(2) * 4 : { 0: 20, 3: 10, 4: 8, 5: 6 }[buffer[0]];
          if (buffer.length < need) return;
          const message = buffer.subarray(0, need); buffer = buffer.subarray(need);
          if (message[0] === 4) events.push({ key: message.readUInt32BE(4), down: message[1] === 1 });
          if (message[0] === 5) events.push({ buttons: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
          if (message[0] === 3) {
            // One raw rectangle: the whole screen, blue-green-red-x pixels; pixel (1,0) is pure red.
            const head = Buffer.alloc(4 + 12); head.writeUInt16BE(1, 2); head.writeUInt16BE(4, 8); head.writeUInt16BE(2, 10);
            const pixels = Buffer.alloc(4 * 2 * 4); pixels[4 + 2] = 255;
            socket.write(Buffer.concat([head, pixels]));
          }
        }
      }
    });
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(path, () => resolve({ path, events })));
}

test('the VNC client sees the screen, clicks where asked, and types only what it can', async t => {
  const { path, events } = await fakeVnc(t);
  const vnc = await Vnc.open({ path });
  t.after(() => vnc.close());
  const { width, height, png } = await vnc.capture();
  assert.deepEqual([width, height], [4, 2]);
  assert.equal(png.readUInt32BE(16), 4);
  assert.deepEqual([...vnc.pixels.subarray(3, 6)], [255, 0, 0], 'pixel (1,0) arrives as red');

  await vnc.click(3, 1);
  await vnc.type('Hi\n');
  await assert.rejects(vnc.type('Hi 🔥'), /can't type "🔥".*nothing was typed/);
  await vnc.press('ctrl+a');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(events.filter(e => 'buttons' in e).map(e => e.buttons), [0, 1, 0], 'move, press, release');
  assert.deepEqual(events.find(e => e.buttons === 1), { buttons: 1, x: 3, y: 1 });
  const keys = events.filter(e => 'key' in e);
  assert.deepEqual(keys.slice(0, 6).map(e => [e.key, e.down]), [[0x48, true], [0x48, false], [0x69, true], [0x69, false], [0xff0d, true], [0xff0d, false]]);
  assert.deepEqual(keys.slice(6).map(e => [e.key, e.down]), [[0xffe3, true], [0x61, true], [0x61, false], [0xffe3, false]], 'nothing of the refused text was sent');
});

test('file keys stay inside the files folder', () => {
  assert.equal(checkKey('from-mac/2026-11-13/Screen Recording.mov'), 'from-mac/2026-11-13/Screen Recording.mov');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'x'.repeat(513)]) {
    assert.throws(() => checkKey(bad), /file key/, JSON.stringify(bad));
  }
  assert.equal(localPath('a/b.txt', '/home/u/hive-files'), '/home/u/hive-files/a/b.txt');
  assert.equal(contentType('x.MOV'), 'video/quicktime');
  assert.equal(contentType('x.unknown'), 'application/octet-stream');
});

test('saved logins come from a Passwords or Chrome export, quoted fields and all', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n\r\n"multi\nline",2,3'), [['a', 'b,c', 'd "e"'], ['multi\nline', '2', '3']]);
  const mac = loginsFromCsv('﻿Title,URL,Username,Password,Notes,OTPAuth\nUW,https://login.wisc.edu/idp/profile,bucky,pw1,,\nNo password,https://x.com,me,,,\n');
  assert.deepEqual(mac, [{ title: 'UW', url: 'https://login.wisc.edu/idp/profile', username: 'bucky', password: 'pw1' }]);
  const twice = loginsFromCsv('Title,URL,Username,Password\nUW,https://login.wisc.edu, bucky\t,pw1\nUW,https://login.wisc.edu,bucky,pw1\n');
  assert.deepEqual(twice.map(login => login.username), ['bucky', 'bucky'], 'spaces and tabs around a username are dropped');
  assert.equal(merge([], twice).logins.length, 1, 'so the same login saved twice is one');
  const chrome = loginsFromCsv('name,url,username,password,note\nX,https://x.com/login,me,pw2,\n');
  assert.equal(chrome[0].password, 'pw2');
  assert.throws(() => loginsFromCsv('a,b\n1,2\n'), /URL and Password/);
});

test('a site finds its login by host, nearest first, and asks when it is not clear which', () => {
  assert.equal(hostOf('https://www.Example.com/path'), 'example.com');
  assert.equal(hostOf('login.wisc.edu'), 'login.wisc.edu');
  const logins = [
    { url: 'https://login.wisc.edu', username: 'bucky', password: 'a' },
    { url: 'https://wisc.edu', username: 'other', password: 'b' },
    { url: 'https://x.com', username: 'me', password: 'c' },
    { url: 'https://x.com', username: 'alt', password: 'd' },
  ];
  assert.equal(pick(logins, 'login.wisc.edu').password, 'a', 'the exact host wins over a parent domain');
  assert.equal(pick(logins, 'https://enroll.wisc.edu').password, 'b', 'a parent domain\'s login fits; a sibling subdomain\'s does not');
  assert.deepEqual(pick(logins, 'x.com').choices.map(c => c.username), ['me', 'alt']);
  assert.equal(pick(logins, 'x.com', 'alt').password, 'd');
  assert.deepEqual(pick(logins, 'nowhere.org'), { choices: [] });
  const { logins: merged, added, updated } = merge(logins, [{ url: 'https://x.com/i', username: 'me', password: 'new' }, { url: 'https://y.com', username: 'z', password: 'p' }]);
  assert.deepEqual([added, updated, merged.length], [1, 1, 5]);
});

test('owner times read as today in the owner\'s zone', () => {
  const now = new Date('2026-11-13T09:00:00Z'); // 3:00 AM in Chicago
  assert.equal(parseOwnerTime('8:45:00 AM', now, 'America/Chicago').toISOString(), '2026-11-13T14:45:00.000Z');
  assert.equal(parseOwnerTime('20:15', now, 'America/Chicago').toISOString(), '2026-11-14T02:15:00.000Z');
  assert.equal(parseOwnerTime('12:00 am', now, 'America/Chicago').toISOString(), '2026-11-13T06:00:00.000Z');
  assert.equal(parseOwnerTime('2026-11-13T14:45:00Z', now).toISOString(), '2026-11-13T14:45:00.000Z');
  assert.equal(parseOwnerTime('25:00', now), null);
  assert.equal(parseOwnerTime('soon', now), null);
});

test('every desktop tool asks for its step, and none takes a password', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.inputSchema.required?.includes('step'), `${tool.name} requires step`);
    assert.ok(!('password' in tool.inputSchema.properties), `${tool.name} takes no password`);
  }
  assert.ok(TOOLS.some(tool => tool.name === 'authenticate'));
});

test('Codex runs on its own home with both tool servers, as the VM user, read-only', () => {
  const args = codexArgs({ model: 'gpt-6.1-terra', effort: 'low', workDir: '/s/tasks/1', appDir: '/app', stateDir: '/s', filesDir: '/f', stepsFile: '/s/tasks/1/steps.log', node: '/usr/bin/node', user: 'ubuntu' });
  assert.deepEqual(args.slice(0, 7), ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only']);
  assert.equal(args.at(-1), '-');
  const config = args.filter((_, i) => args[i - 1] === '-c');
  const desktop = JSON.parse(config.find(c => c.startsWith('mcp_servers.desktop.args=')).split('=').slice(1).join('='));
  const phone = JSON.parse(config.find(c => c.startsWith('mcp_servers.phone.args=')).split('=').slice(1).join('='));
  assert.deepEqual(desktop.slice(0, 3), ['-n', '-u', 'ubuntu']);
  assert.deepEqual(phone, ['-n', '-u', 'ubuntu', 'env', 'HIVE_VM_STATE=/s', '/usr/bin/node', '/app/phone-mcp.mjs']);
  for (const name of ['desktop', 'phone']) assert.ok(config.includes(`mcp_servers.${name}.default_tools_approval_mode="approve"`), `${name} tools run without asking`);
  assert.throws(() => codexArgs({ model: 'x; rm -rf /', effort: 'low', workDir: '/w', appDir: '/a', stateDir: '/s', filesDir: '/f', stepsFile: '/f/s' }), /unsupported/);
  assert.match(GUIDE, /exact words, once/);
  assert.match(GUIDE, /authenticate/);
  assert.match(GUIDE, /Only approve a request you just\s+caused/);
});

test('Codex events become one line each for the owner', () => {
  assert.equal(describe({ type: 'item.started', item: { type: 'mcp_tool_call', tool: 'click', arguments: { step: 'Open the cart' } } }), '→ click: Open the cart');
  assert.equal(describe({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }), '💬 Done.');
  assert.match(describe({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'type_text', result: { content: [{ type: 'text', text: 'Failed: no' }] } } }), /✗ Failed: no/);
  assert.equal(describe({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'click', result: { content: [{ type: 'text', text: 'ok' }] } } }), null);
  assert.equal(describe({ type: 'turn.started' }), null);
});

test('without the Mac, the phone server still starts and says why it has no tools', () => {
  const init = offlineAnswer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'phone');
  assert.equal(init.result.instructions, OFFLINE);
  assert.deepEqual(offlineAnswer({ id: 2, method: 'tools/list' }).result, { tools: [] });
  assert.equal(offlineAnswer({ id: 3, method: 'tools/call', params: { name: 'tap' } }).result.isError, true);
  assert.equal(offlineAnswer({ method: 'notifications/initialized' }), null);
  assert.equal(offlineAnswer({ id: 4, method: 'resources/list' }).error.code, -32601);
});

test('a code task gets Codex\'s own sandbox, its folders writable, the env for its commands, and no tool servers', () => {
  const args = codeArgs({ model: 'gpt-6.1-terra', effort: 'high', codeDir: '/d/worktrees/x', writable: ['/d/target', '/d/cargo'],
    env: ['CARGO_TARGET_DIR=/d/target', 'PATH=/d/cargo/bin:/usr/bin:/bin'] });
  assert.deepEqual(args.slice(0, 9), ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'workspace-write', '-C', '/d/worktrees/x']);
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--add-dir'), ['/d/target', '/d/cargo']);
  const config = args.filter((_, i) => args[i - 1] === '-c');
  assert.ok(config.includes('shell_environment_policy.set.CARGO_TARGET_DIR="/d/target"'));
  assert.ok(config.includes('shell_environment_policy.set.PATH="/d/cargo/bin:/usr/bin:/bin"'));
  assert.ok(!config.some(c => c.startsWith('mcp_servers')), 'no screen or phone for code');
  assert.equal(args.at(-1), '-');
  assert.throws(() => codeArgs({ model: 'm', effort: 'high', codeDir: '/w', env: ['BAD NAME=1'] }), /unsupported --env/);
  assert.throws(() => codeArgs({ model: 'm', effort: 'high', codeDir: '/w', env: ['X=$(id)'] }), /unsupported --env/);
  assert.throws(() => codeArgs({ model: 'm', effort: 'high', codeDir: '/w; rm -rf /' }), /unsupported/);
  assert.match(CODE_GUIDE, /network off/);
  assert.match(CODE_GUIDE, /Never commit, push/);
});
