const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Exercise the actual tool handlers without starting the extension's polling loop.
const source = readFileSync(`${__dirname}/../worker.js`, 'utf8')
  .replace("import { api, conf } from './hive.js';", '')
  .split('async function run(c, call)')[0];
function handlers(tabs) {
  return vm.runInNewContext(`${source}\nRUN`, { chrome: { tabs }, setTimeout });
}

test('background screenshots never select or capture another tab', async () => {
  const run = handlers({ get: async () => ({ active: false }) });
  await assert.rejects(run.browser_screenshot({ tab: 12 }), /background/);
});

test('visible screenshots capture the requested window without selecting a tab', async () => {
  const run = handlers({
    get: async (id) => { assert.equal(id, 12); return { active: true, windowId: 3, title: 'Page', url: 'https://example.com' }; },
    captureVisibleTab: async (windowId) => { assert.equal(windowId, 3); return 'image'; },
  });
  const result = await run.browser_screenshot({ tab: 12 });
  assert.equal(result.images[0], 'image');
});

test('new agent tabs open in the background', async () => {
  const run = handlers({
    create: async (options) => { assert.equal(options.active, false); return { id: 12 }; },
    get: async () => ({ id: 12, status: 'complete' }),
  });
  await run.browser_open({ tab: 0, url: 'https://example.com' });
});
