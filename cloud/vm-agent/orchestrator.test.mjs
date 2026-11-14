import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, handle, outcomeOf, parsePlan, pick, readEvents, scopeOf, taskBrief } from './orchestrator.mjs';

test('each task gets the model for its rating, and code never less than the coding workhorse', () => {
  assert.deepEqual(pick({ difficulty: 'easy', kind: 'answer' }), { rating: 'easy', ...MODELS.easy });
  assert.deepEqual(pick({ difficulty: 'hardest', kind: 'screen' }), { rating: 'hardest', ...MODELS.hardest });
  assert.deepEqual(pick({ difficulty: 'easy', kind: 'code' }), { rating: 'hard', ...MODELS.hard });
  assert.deepEqual(pick({ difficulty: 'made-up' }), { rating: 'normal', ...MODELS.normal });
});

test("the planner's answer is read as checked JSON, prose around it or not", () => {
  const plan = parsePlan(`Here you go:
{"project": "Hive", "tasks": [
  {"title": "Check the board", "quote": "check the board", "brief": "Open it.", "folder": "hive › Task board",
   "kind": "screen", "difficulty": "easy", "minutes": 4.6, "value": "high"},
  {"title": "", "quote": ""},
  {"title": "Fix it", "quote": "fix it", "kind": "rewrite", "difficulty": "?", "minutes": -1, "value": "huge"}]}`);
  assert.equal(plan.project, 'hive');
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[0], {
    title: 'Check the board', quote: 'check the board', brief: 'Open it.', folder: 'hive   Task board',
    kind: 'screen', difficulty: 'easy', minutes: 5, value: 'high',
  });
  assert.equal(plan.tasks[1].kind, 'screen');
  assert.equal(plan.tasks[1].difficulty, 'normal');
  assert.equal(plan.tasks[1].minutes, null);
  assert.equal(plan.tasks[1].value, 'medium');
  assert.throws(() => parsePlan('no idea'), /JSON/);
  assert.throws(() => parsePlan('{"tasks": []}'), /no tasks/);
});

test("a subagent gets its task, the owner's words and every memory of its folder in full", () => {
  const brief = taskBrief(
    { brief: 'Check the socket answers.', quote: 'check the dictation socket' },
    { text: 'For hive › Voice: check the dictation socket' },
    { name: 'Voice', project: 'hive', about: 'Speech in and out', memories: [
      { title: 'Socket', kind: 'spec', body: 'One JSON line in, one out.' },
      { title: 'Model', kind: 'decision', body: 'Parakeet on the Mac.\nWhisper on the web.' },
    ] },
  );
  assert.match(brief, /^Check the socket answers\./);
  assert.match(brief, /The owner's words: "check the dictation socket"/);
  assert.match(brief, /What the folder is for: Speech in and out/);
  assert.match(brief, /all 2, in full/);
  assert.match(brief, /### Socket \(spec\)\nOne JSON line in, one out\./);
  assert.match(brief, /Parakeet on the Mac\.\nWhisper on the web\./);
  assert.match(taskBrief({ title: 'T', quote: '' }, { text: 'do T' }, { name: 'X', project: 'p', memories: [] }), /no memories yet/);
});

test("Codex's events give its report and the tokens it used", () => {
  const lines = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Looking."}}',
    'not json',
    '{"type":"item.completed","item":{"type":"agent_message","text":"It answered in 0.4 s. Nothing else to do."}}',
    '{"type":"turn.completed","usage":{"input_tokens":2000,"cached_input_tokens":1500,"output_tokens":120}}',
  ];
  assert.deepEqual(readEvents(lines), { report: 'It answered in 0.4 s. Nothing else to do.', tokensIn: 2000, tokensOut: 120 });
  assert.equal(outcomeOf('It answered in 0.4 s. Nothing else to do.', 'x'), 'It answered in 0.4 s.');
  assert.equal(outcomeOf('', 'Done.'), 'Done.');
  assert.deepEqual(scopeOf('For hive › Voice: x'), { project: 'hive', folder: 'Voice' });
  assert.deepEqual(scopeOf('For buckymatch: x'), { project: 'buckymatch', folder: '' });
  assert.deepEqual(scopeOf('just do it'), { project: '', folder: '' });
});

/** A board that keeps what the orchestrator tells it. */
function fakeBoard(folders = {}) {
  const calls = [];
  const board = async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith('/v1/folder?')) {
      const key = new URL(`http://x${path}`).searchParams.get('key');
      const found = folders[key];
      return found
        ? { folder: { name: found.name, about: '', created_at: 1 }, memories: found.memories }
        : { folder: { name: key, about: '' }, memories: [] };
    }
    return { ok: true };
  };
  return { board, calls };
}

test('a request is planned, filed, run task by task with its model, reported and saved to its folder', async () => {
  const { board, calls } = fakeBoard({ voice: { name: 'Voice', memories: [{ title: 'Socket', kind: 'spec', body: 'JSON lines.' }] } });
  const runs = [];
  await handle({ id: 4, text: 'For hive › Voice: check the socket, then fix the reader', project: 'hive', folder: 'Voice' }, {
    board,
    now: () => 1000,
    plan: async () => JSON.stringify({ project: 'hive', tasks: [
      { title: 'Check the socket', quote: 'check the socket', kind: 'answer', difficulty: 'easy', minutes: 5 },
      { title: 'Fix the reader', quote: 'fix the reader', kind: 'code', difficulty: 'normal' },
    ] }),
    run: async (brief, choice) => {
      runs.push({ brief, choice });
      return { ok: true, report: 'It answers. Checked twice.', seconds: 30, tokensIn: 900, tokensOut: 40 };
    },
  });

  const updates = calls.filter(c => c.path === '/v1/requests/update').map(c => c.body);
  assert.equal(updates[0].status, 'working');
  assert.equal(updates[0].project, 'hive');
  assert.deepEqual(updates[0].tasks.map(t => [t.key, t.status, t.folder]), [[1, 'open', 'Voice'], [2, 'open', 'Voice']]);
  assert.equal(updates[0].tasks[0].evidence, 'answer; gpt-6-luna, low effort (easy)');
  assert.equal(updates[0].tasks[1].evidence, 'code; gpt-6.1-sol, medium effort (hard)');

  assert.equal(runs.length, 1, 'the code task waits for the Mac');
  assert.deepEqual(runs[0].choice, { rating: 'easy', ...MODELS.easy });
  assert.match(runs[0].brief, /### Socket \(spec\)\nJSON lines\./);

  const finished = updates.flatMap(u => u.tasks ?? []).filter(t => t.key === 1).at(-1);
  assert.equal(finished.status, 'done');
  assert.equal(finished.outcome, 'It answers.');
  assert.equal(finished.report, 'It answers. Checked twice.');
  assert.deepEqual([finished.work_seconds, finished.tokens_in, finished.tokens_out, finished.created_at], [30, 900, 40, 1000]);
  const waiting = updates.flatMap(u => u.tasks ?? []).filter(t => t.key === 2).at(-1);
  assert.equal(waiting.status, 'waiting');

  const memory = calls.find(c => c.path === '/v1/folders/memory').body;
  assert.deepEqual(memory, { project: 'hive', folder: 'Voice', kind: 'report', title: 'Report: Check the socket', body: 'It answers. Checked twice.' });
  const last = updates.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.outcome, '1 of 2 done; Fix the reader (waiting).');
});

test("a folder the planner guesses is used only if it exists; a plan that fails fails the request", async () => {
  const { board, calls } = fakeBoard({ dashboard: { name: 'Dashboard', memories: [] } });
  await handle({ id: 5, text: 'tidy the board and the bot', project: '' }, {
    board,
    plan: async () => JSON.stringify({ project: 'hive', tasks: [
      { title: 'Tidy the board', quote: 'tidy the board', folder: 'Dashboard' },
      { title: 'Tidy the bot', quote: 'the bot', folder: 'Made up' },
    ] }),
    run: async () => ({ ok: false, report: '', seconds: 3, tokensIn: 0, tokensOut: 0 }),
  });
  const filed = calls.find(c => c.body?.status === 'working').body.tasks;
  assert.deepEqual(filed.map(t => t.folder), ['Dashboard', null]);
  const last = calls.filter(c => c.path === '/v1/requests/update').at(-1).body;
  assert.equal(last.status, 'failed');
  assert.match(last.outcome, /^0 of 2 done; Tidy the board \(blocked\), Tidy the bot \(blocked\)\.$/);

  const second = fakeBoard();
  await handle({ id: 6, text: 'x' }, { board: second.board, plan: async () => 'sorry', run: async () => assert.fail('no run') });
  assert.deepEqual(second.calls.at(-1).body, { id: 6, status: 'failed', outcome: "Couldn't plan it: the planner didn't answer with JSON" });
});
