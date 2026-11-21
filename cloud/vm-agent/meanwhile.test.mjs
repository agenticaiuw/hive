// What's said to a request while its agents work (meanwhile.mjs, orchestrator.mjs tellRunning): the
// owner's message to a working Hive on the VM reaches its agents at their next step, once each, and
// runs by itself only if none heard it before the request ended.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forget, hear, heardBy, inboxOf, leave, told, withHeard } from './meanwhile.mjs';
import { handle, tellRunning } from './orchestrator.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'hive-meanwhile-'));
const said = 'post: Turn YouTube to black and white to avoid doom scrolling!';
const reply = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

test("each of a request's tasks hears what's said to it once, oldest first, through whichever tool server answers first", () => {
  const state = scratch();
  try {
    leave(state, 119, { id: 120, text: said });
    leave(state, 119, { id: 122, text: 'and add the usual thread comment', from: 'The owner' });
    leave(state, 7, { id: 8, text: 'not for request 119' });
    // R119-1's desktop server answers first: its answer ends with both, word for word.
    const first = withHeard(reply(1, 'Clicked Post.'), state, 'R119-1');
    assert.equal(first.result.content.length, 2);
    assert.equal(first.result.content[0].text, 'Clicked Post.');
    assert.equal(first.result.content[1].text, [
      `The owner just said this about the request you're working on, word for word, through Hive's message box: «${said}»`,
      "The owner just said this about the request you're working on, word for word, through Hive's message box: «and add the usual thread comment»",
      'Take it into account from here on: if it changes what you should do, change course now.',
    ].join('\n'));
    // Its other servers (phone, Mac, ...) don't say it again; another task of the request does, once.
    assert.deepEqual(withHeard(reply(2, 'Unlocked.'), state, 'R119-1'), reply(2, 'Unlocked.'));
    assert.deepEqual(hear(state, 'R119-2').map(s => s.id), [120, 122]);
    assert.deepEqual(hear(state, 'R119-2'), []);
    assert.deepEqual(heardBy(state, 119, 120).sort(), ['R119-1', 'R119-2']);
    assert.deepEqual(heardBy(state, 119, 121), []);
    // Not a tool answer, no task, or no state folder: untouched.
    const init = { jsonrpc: '2.0', id: 0, result: { tools: [] } };
    assert.equal(withHeard(init, state, 'R7-1'), init);
    assert.deepEqual(hear(state, 'a task started by hand'), []);
    assert.deepEqual(hear(undefined, 'R7-1'), []);
    assert.equal(withHeard(null, state, 'R7-1'), null);
    // Taken back: no task hears it after, and an empty inbox goes.
    forget(state, 119, 120);
    forget(state, 119, 122);
    assert.deepEqual(hear(state, 'R119-3'), []);
    assert.throws(() => readdirSync(inboxOf(state, 119)), /ENOENT/);
    assert.equal(hear(state, 'R7-3').length, 1);
    assert.equal(told([]), '');
    assert.match(told([{ text: 'x', from: 'Club member alice' }]), /^Club member alice just said this/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

/** A board that keeps every call. */
const fakeBoard = () => {
  const calls = [];
  return { calls, board: async (path, body) => { calls.push({ path, body }); return path.startsWith('/v1/runs?') ? { steps: [] } : {}; } };
};

test('a message to a working request reaches its agent at its next step, and is done once heard', async () => {
  const state = scratch();
  try {
    const { board, calls } = fakeBoard();
    let finish;
    const earlier = new Promise(resolve => { finish = resolve; });
    const telling = tellRunning({ id: 120, follows: 119, text: said }, earlier, { board, stateDir: state, everyMs: 5, stepEvery: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.some(c => c.path === '/v1/requests/update'), false, 'not heard yet: still open');
    // The posting task's next tool answer carries it.
    const answer = withHeard(reply(3, 'Uploaded 68%.'), state, 'R119-1');
    assert.match(answer.result.content.at(-1).text, /«post: Turn YouTube to black and white to avoid doom scrolling!»/);
    await new Promise(resolve => setTimeout(resolve, 30));
    const closed = calls.find(c => c.path === '/v1/requests/update');
    assert.deepEqual(closed.body, { id: 120, status: 'done', outcome: 'The agent working on this heard you and carries on with it.' });
    finish();
    assert.equal(await telling, true, "heard: it doesn't run again by itself");
    const runs = calls.filter(c => c.path === '/v1/runs');
    assert.equal(runs[0].body.request, 120);
    assert.ok(runs.flatMap(c => c.body.steps ?? []).some(s => /^💬 Passed on to the agent working on this/.test(s.text)), 'the owner sees it was passed on');
    assert.deepEqual(hear(state, 'R119-2'), [], 'taken back once the request ended');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("a message no agent heard before its request ended runs by itself; one sent while Hive changes itself is in the rerun's brief", async () => {
  const state = scratch();
  try {
    const { board, calls } = fakeBoard();
    assert.equal(await tellRunning({ id: 130, follows: 129, text: 'stop' }, Promise.resolve(), { board, stateDir: state, everyMs: 5, stepEvery: 1 }), false);
    assert.equal(calls.some(c => c.path === '/v1/requests/update'), false);
    assert.deepEqual(hear(state, 'R129-1'), [], 'taken back: it runs as its own request instead');

    // A screen task asks Hive to change itself; while it does, the owner says something; the rerun hears it.
    const improveDir = join(state, 'improve');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(improveDir);
    const briefs = [];
    await handle({ id: 140, text: 'post the video' }, {
      board, now: () => 1000, stepEvery: 1, improveDir, hear: label => hear(state, label),
      plan: async () => JSON.stringify({ project: 'hive', tasks: [{ title: 'Post the video', quote: 'post the video', kind: 'screen', difficulty: 'normal' }] }),
      run: async (brief, choice, step, { improveFile }) => {
        briefs.push(brief);
        if (briefs.length === 1) writeFileSync(improveFile, JSON.stringify({ what: 'Move big files', why: 'The upload failed.' }));
        return { ok: true, report: 'ok', seconds: 1 };
      },
      improve: async () => {
        leave(state, 140, { id: 141, text: said });
        return { ok: true, commit: 'abcdef0123456789', files: ['a.mjs'], live: ['the VM'], report: '' };
      },
    });
    assert.equal(briefs.length, 2);
    assert.doesNotMatch(briefs[0], /just said/);
    assert.match(briefs[1], /The owner just said this about the request you're working on, word for word, through Hive's message box: «post: Turn YouTube/);
    assert.deepEqual(heardBy(state, 140, 141), ['R140-1']);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
