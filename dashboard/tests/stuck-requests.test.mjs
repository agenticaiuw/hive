import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { render } from 'svelte/server';
import { agents } from '../src/lib/agents.js';
import { normalizeBoard } from '../src/lib/tasks.js';

register('./support/svelte-loader.mjs', import.meta.url);
const { default: StuckRequests } = await import('../src/lib/StuckRequests.svelte');
const NOW = 1_794_889_000;

function board() {
  return normalizeBoard({ source: 'cloud', board: {
    now: NOW,
    requests: [
      { id: 1, text: 'Blocked transfer', status: 'working', updated_at: NOW },
      { id: 2, text: 'Quiet planning', status: 'planning', updated_at: NOW - 1200 },
      { id: 3, text: 'Recent work', status: 'working', updated_at: NOW },
      { id: 4, text: 'Finished work', status: 'done', updated_at: NOW - 86400 },
      { id: 5, text: 'Blocked request', status: 'blocked', updated_at: NOW },
    ],
    tasks: [{ machine: 'cloud', id: 101, status: 'blocked', retrying: 1, updated_at: NOW }],
  } });
}

const html = (board) => render(StuckRequests, { props: { agents: agents(board) } }).body;

test('the main-page list names blocked and quiet requests, including ones without tasks', () => {
  const body = html(board());
  assert.match(body, /<h2[^>]*>Stuck <span[^>]*>3<\/span>/);
  for (const [id, title] of [[1, 'Blocked transfer'], [2, 'Quiet planning'], [5, 'Blocked request']]) {
    assert.match(body, new RegExp(`href="#/agent/cloud%7CR${id}"[^>]*>${title}</a>`));
  }
  assert.doesNotMatch(body, /Recent work|Finished work|<details/);
});

test('the list clears when blockers resolve and quiet work makes progress', () => {
  const b = board();
  b.tasks[0].status = 'active';
  b.requests.find((r) => r.id === 'R2').updated = NOW;
  b.requests.find((r) => r.id === 'R5').status = 'done';
  assert.doesNotMatch(html(b), /<section|Stuck|Blocked transfer|Quiet planning/);
});

test('request titles are text, never markup', () => {
  const b = board();
  b.requests[0].text = '<img src=x onerror=alert(1)>';
  assert.match(html(b), /&lt;img/);
  assert.doesNotMatch(html(b), /<img/);
});
