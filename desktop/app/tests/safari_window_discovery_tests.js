'use strict';
const assert = require('node:assert/strict');
const { makeDiscovery } = require('../safari-agent-extension/resources/window-discovery.js');
(async () => {
  const calls = [];
  const api = { get: async (...args) => { calls.push(args); return {id: 42, tabs: [{url: 'sensitive'}], title: 'private'}; } };
  const unregistered = makeDiscovery(api, []);
  assert.deepEqual(await unregistered.handle({version:'1', operation:'owned_window_status', slot:'agent-window'}), {status:'rejected'});
  assert.deepEqual(calls, []);
  assert.equal((await unregistered.handle({version:'1', operation:'capabilities'})).scoped_lookup, 'api_present_unverified');
  const fixture = makeDiscovery(api, [['agent-window', 42]]);
  assert.deepEqual(await fixture.handle({version:'1', operation:'owned_window_status', slot:'agent-window'}), {status:'observed', ownership:'unverified'});
  assert.deepEqual(calls, [[42, {populate:false}]]);
  for (const message of [null, {}, {version:'1', operation:'owned_window_status', slot:'other'},
    {version:'1', operation:'owned_window_status', slot:'agent-window', id:99},
    {version:'1', operation:'create'}, {version:'1', operation:'capabilities', extra:'private'}]) {
    assert.equal((await fixture.handle(message)).status, 'rejected');
  }
  assert.equal(calls.length, 1);
  assert.equal((await makeDiscovery({get: async () => {throw Error('secret');}}, [['agent-window',42]]).handle({version:'1', operation:'owned_window_status', slot:'agent-window'})).status, 'unavailable');
  assert.equal((await makeDiscovery({get: async () => ({id:99})}, [['agent-window',42]]).handle({version:'1', operation:'owned_window_status', slot:'agent-window'})).status, 'unavailable');
  assert.equal((await makeDiscovery({}, [['agent-window',42]]).handle({version:'1', operation:'owned_window_status', slot:'agent-window'})).status, 'unavailable');
  console.log('Scoped discovery: mocked allowlist, redaction, no enumeration and failure tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
