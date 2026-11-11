'use strict';
// Exercise the production background scripts, with no browser or real windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.join(__dirname, '../safari-agent-extension/resources');
(async () => {
  const calls = [], replies = [];
  let listener;
  const port = {onMessage: {addListener(fn) { listener = fn; }}, postMessage(reply) { replies.push(reply); }};
  const windows = new Proxy({}, {get(_, name) { calls.push(String(name)); return () => { throw Error('unexpected window API'); }; }});
  const browser = {windows, runtime: {connectNative(name) { assert.equal(name, 'local.personal-agent.Agent'); return port; }}};
  const context = vm.createContext({browser});
  for (const file of ['window-discovery.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, {filename:file});
  assert.equal(typeof listener, 'function');
  for (const message of [
    {version:'1', operation:'create'},
    {version:'1', operation:'register', slot:'agent-window', id:42},
    {version:'1', operation:'owned_window_status', slot:'agent-window'},
    {version:'1', operation:'close', id:42},
    {version:'1', operation:'focus', id:42}
  ]) listener(message);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.map(r => r.status), Array(5).fill('rejected'));
  assert.deepEqual(calls, []);
  // Connection failure is handled without a fallback to browser window APIs.
  vm.runInNewContext(fs.readFileSync(path.join(base,'background.js'),'utf8'), {
    AgentWindowDiscovery: {makeDiscovery() { return {}; }},
    browser: {windows, runtime: {connectNative() { throw Error('unavailable'); }}}
  });
  assert.deepEqual(calls, []);
  console.log('Production background: creation, registration, lookup, focus and cleanup requests fail closed; no window API calls');
})().catch(error => { console.error(error); process.exitCode = 1; });
