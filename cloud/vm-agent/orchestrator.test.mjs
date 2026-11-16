import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, branchOf, handle, outcomeOf, parsePlan, pick, readEvents, scopeOf, taskBrief } from './orchestrator.mjs';

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
    if (path.startsWith('/v1/rules?')) return { rules: folders.__rules ?? [] };
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

test("every brief carries the owner's standing rules for the project, before the folder's memories", () => {
  const brief = taskBrief(
    { brief: 'Tidy the reader.', quote: 'tidy it' },
    { text: 'tidy it' },
    { name: 'Voice', project: 'hive', about: 'Speech', memories: [{ title: 'Socket', kind: 'spec', body: 'JSON lines.' }] },
    [{ text: "Don't resume the Rust voice port", quote: 'the rust port is stopped', paths: '[]' },
     { text: 'Keep it in the cloud', quote: '', paths: '["cloud/**"]' }],
  );
  assert.match(brief, /The owner's standing rules for this project; follow every one:\n- Don't resume the Rust voice port \(the owner said: "the rust port is stopped"\)\n- Keep it in the cloud \(applies to cloud\/\*\*\)/);
  assert.ok(brief.indexOf('standing rules') < brief.indexOf('What the folder is for') && brief.indexOf('What the folder is for') < brief.indexOf('### Socket'));
});

test('a code task in a repository the VM can push to runs there and waits for review on its own branch', async () => {
  const folders = { __rules: [{ text: 'Never push to main', quote: 'no main', paths: '[]' }] };
  const { board, calls } = fakeBoard(folders);
  const coded = [];
  await handle({ id: 7, text: 'For hive: fix the reader, and fix the bot in buckymatch' }, {
    board,
    plan: async () => JSON.stringify({ project: 'hive', tasks: [
      { title: 'Fix the reader!', quote: 'fix the reader', kind: 'code', difficulty: 'easy' },
    ] }),
    run: async () => assert.fail('a code task never goes to the screen'),
    code: async (brief, choice, where) => {
      coded.push({ brief, choice, where });
      return { ok: true, report: 'Fixed the reader. Tests pass.', seconds: 60, tokensIn: 5000, tokensOut: 300,
        branch: where.branch, files: ['src/reader.rs', 'tests/reader.rs'] };
    },
  });
  assert.equal(coded.length, 1);
  assert.deepEqual(coded[0].choice, { rating: 'hard', ...MODELS.hard });
  assert.deepEqual(coded[0].where, { project: 'hive', branch: 'hive/r7-1-fix-the-reader', title: 'Fix the reader!', request: 7, key: 1 });
  assert.match(coded[0].brief, /- Never push to main \(the owner said: "no main"\)/);
  const updates = calls.filter(c => c.path === '/v1/requests/update').map(c => c.body);
  const task = updates.flatMap(u => u.tasks ?? []).at(-1);
  assert.equal(task.status, 'waiting');
  assert.equal(task.outcome, 'Ready for your review: 2 files changed on branch hive/r7-1-fix-the-reader, not merged.');
  assert.match(task.report, /^Fixed the reader\. Tests pass\.\n\n2 files changed on branch hive\/r7-1-fix-the-reader, not merged: src\/reader\.rs, tests\/reader\.rs\.$/);
  assert.deepEqual([task.work_seconds, task.tokens_in, task.tokens_out], [60, 5000, 300]);
  assert.equal(updates.at(-1).outcome, '0 of 1 done; Fix the reader! (waiting, on hive/r7-1-fix-the-reader).');
  assert.equal(branchOf(3, { key: 2, title: '  ' }), 'hive/r3-2');

  // Elsewhere (no repository the VM can push to) it waits for the Mac, and nothing runs.
  const other = fakeBoard();
  await handle({ id: 8, text: 'fix the bot' }, {
    board: other.board,
    plan: async () => JSON.stringify({ project: 'buckymatch', tasks: [{ title: 'Fix the bot', quote: 'fix the bot', kind: 'code' }] }),
    run: async () => assert.fail('no run'),
    code: async () => assert.fail('no code run outside REPOS'),
  });
  const waiting = other.calls.filter(c => c.path === '/v1/requests/update').flatMap(c => c.body.tasks ?? []).at(-1);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.outcome, /code change in buckymatch: Hive's cloud agent changes code only in hive/);
});

test('a request asked on a web page becomes that page\'s rule', async () => {
  const { handle, parsePageRule } = await import('./orchestrator.mjs');
  assert.deepEqual(parsePageRule('{"off": true}'), { off: true });
  assert.throws(() => parsePageRule('{"title":"x"}'), /changes nothing/);
  const calls = [];
  const board = async (path, body) => { calls.push([path, body]); return path === '/v1/page-rules' ? { id: 3 } : { off: 1 }; };
  const ask = async prompt => {
    assert.match(prompt, /ic-DashboardCard/);
    return 'Here: {"title":"Only this semester\'s courses","path":"/","hide":["#right-side-wrapper"],' +
      '"keep":[{"items":".ic-DashboardCard","text":["CS 400","MATH 341"]}],"css":"","extra":1}';
  };
  await handle({ id: 9, text: 'just my 5 courses', page: { url: 'https://canvas.wisc.edu/', title: 'Dashboard', outline: 'div.ic-DashboardCard "CS 400"' } },
    { board, ask, plan: () => { throw new Error('no plan for a page'); } });
  const saved = calls.find(([path]) => path === '/v1/page-rules')[1];
  assert.equal(saved.host, 'canvas.wisc.edu');
  assert.equal(saved.path, '/');
  assert.deepEqual(saved.rule, { hide: ['#right-side-wrapper'], keep: [{ items: '.ic-DashboardCard', text: ['CS 400', 'MATH 341'] }], css: '' });
  assert.equal(calls.at(-1)[1].status, 'done');
});
