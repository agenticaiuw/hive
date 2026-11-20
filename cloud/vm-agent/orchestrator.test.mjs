import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODELS, Slots, branchOf, handle, labelOf, limitsRow, outcomeOf, parsePlan, pick, planWords, readEvents, runSender, scopeOf, taskBrief, turnStep } from './orchestrator.mjs';

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
    kind: 'screen', difficulty: 'easy', minutes: 5, value: 'high', needs: [],
  });
  assert.equal(plan.tasks[1].kind, 'screen');
  assert.equal(plan.tasks[1].difficulty, 'normal');
  assert.equal(plan.tasks[1].minutes, null);
  assert.equal(plan.tasks[1].value, 'medium');
  assert.throws(() => parsePlan('no idea'), /JSON/);
  assert.throws(() => parsePlan('{"tasks": []}'), /no tasks/);
});

test("Hive's own note about stuck tasks is planned as those tasks, not as no tasks", () => {
  const note = '[Hive, not the owner] This task is stuck, and Hive continues it so the owner doesn\'t have to (try 8):\n' +
    '- T133 ("Try the Hive Safari extension on Canvas")\nThis is Hive\'s note, not a new request: register no tasks for it.';
  const words = planWords({ text: note, from: 'mac' });
  assert.match(words, /^\(This is Hive's own note, not the owner's words: .*Plan exactly one task for each task it lists/);
  assert.ok(words.endsWith(note), 'the note itself comes along');
  // A cloud request run again keeps being planned from the owner's words that follow the note.
  const retried = `${note}\nDon't redo what's already done. The request, as it was:\nOpen Canvas`;
  assert.equal(planWords({ text: retried, from: 'web', retry: true }), retried);
  assert.equal(planWords({ text: 'Open Canvas', from: 'mac' }), "(Said to Hive on the owner's Mac.) Open Canvas");
  assert.equal(planWords({ text: 'Open Canvas', from: 'web' }), 'Open Canvas');
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
  assert.match(brief, /The whole message this came from, word for word[^\n]*\nFor hive › Voice: check the dictation socket/);
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
  assert.equal(outcomeOf('Updated the bio on the [profile](https://x.com/a):\n> Agentic AI Club\n> Build it.\n\nVerified on the page.', 'x'),
    'Updated the bio on the [profile](https://x.com/a):\n> Agentic AI Club\n> Build it.\nVerified on the page.', 'what a colon introduces is the outcome');
  assert.equal(outcomeOf(`Wrote:\n${'a'.repeat(600)}`, 'x'), 'Wrote:', 'a line too long to fit is left out');
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
  const { signal, ...where } = coded[0].where;
  assert.deepEqual(where, { project: 'hive', branch: 'hive/r7-1-fix-the-reader', title: 'Fix the reader!', request: 7, key: 1, label: 'R7-1' });
  assert.equal(signal.aborted, false, 'the owner stopping the request stops its agent');
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

test("Hive's Codex plan limits from app-server become the board's limits row", () => {
  const row = limitsRow({ rateLimits: { planType: 'prolite', primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1795015789 }, secondary: null } }, '~/.codex-hive', 100);
  assert.deepEqual(row, { harness: 'codex', home: '~/.codex-hive', plan: 'prolite', windows: [{ minutes: 10080, used: 17, resets_at: 1795015789 }], at: 100 });
  assert.equal(limitsRow(null), null);
});

test("a task's steps reach the board while it runs, in order, before the task is reported done", async () => {
  const { board, calls } = fakeBoard();
  await handle({ id: 11, text: 'open example.com' }, {
    board,
    stepEvery: 5,
    plan: async () => JSON.stringify({ project: '', tasks: [{ title: 'Open example.com', quote: 'open example.com', kind: 'screen' }] }),
    run: async (brief, choice, onStep) => {
      onStep('→ open_url: Open example.com');
      await new Promise(resolve => setTimeout(resolve, 20));
      onStep('   ');
      onStep('💬 The heading says Example Domain.');
      onStep('✅ Done.');
      return { ok: true, report: 'The heading says Example Domain.', seconds: 9, tokensIn: 10, tokensOut: 5 };
    },
  });
  const sent = calls.filter(c => c.path === '/v1/runs');
  assert.ok(sent.length >= 2, 'on the board, working, before the task finished');
  assert.ok(sent.every(c => c.body.machine === 'cloud' && c.body.run === '1101' && c.body.agent === 'cloud'
    && c.body.request === 11 && c.body.task === 1 && c.body.title === 'Open example.com'));
  assert.deepEqual(sent.flatMap(c => c.body.steps.map(s => [s.n, s.kind, s.text])),
    [[1, 'action', '→ open_url: Open example.com'], [2, 'say', '💬 The heading says Example Domain.'], [3, 'done', '✅ Done.']]);
  assert.deepEqual(sent.map(c => c.body.status ?? null), [...sent.slice(1).map(() => null), 'done']);
  const lastStep = calls.lastIndexOf(sent.at(-1));
  const done = calls.findIndex(c => c.path === '/v1/requests/update' && c.body.tasks?.[0]?.status === 'done');
  assert.ok(lastStep < done, 'every step is on the board before the task shows done');
});

test("a board that won't take steps never stops the task, and what it missed goes with the next post", async () => {
  let refuse = true;
  const sent = [];
  const logs = [];
  const ends = [];
  const board = async (path, body) => {
    if (refuse) throw new Error('fetch failed');
    sent.push(...body.steps.map(s => `${s.n} ${s.text}`));
    if (body.status) ends.push(body.status);
    return { ok: true };
  };
  const steps = runSender(board, { request: 12, task: 2 }, { every: 1000, log: line => logs.push(line) });
  steps.step('→ click: Compose');
  await steps.done('failed');
  assert.deepEqual(sent, []);
  assert.match(logs[0], /couldn't put R12's steps on the board: fetch failed/);
  refuse = false;
  steps.step('→ type: Hello');
  await steps.done('failed');
  assert.deepEqual(sent, ['1 → click: Compose', '2 → type: Hello']);
  assert.deepEqual(ends, ['failed'], 'how it ended is said once');

  // And a request whose board throws on steps still finishes and is reported.
  const { board: good, calls } = fakeBoard();
  const flaky = async (path, body) => (path === '/v1/runs' ? Promise.reject(new Error('down')) : good(path, body));
  await handle({ id: 13, text: 'x' }, {
    board: flaky, stepEvery: 1,
    plan: async () => JSON.stringify({ project: '', tasks: [{ title: 'X', quote: 'x', kind: 'screen' }] }),
    run: async (brief, choice, onStep) => { onStep('→ screenshot: Look'); return { ok: true, report: 'Done it.', seconds: 1, tokensIn: 1, tokensOut: 1 }; },
  });
  assert.equal(calls.filter(c => c.path === '/v1/requests/update').at(-1).body.status, 'done');
});

test("a task's run is on the board, working, before its agent says anything", async () => {
  const posts = [];
  const steps = runSender(async (path, body) => { posts.push({ path, body }); return { ok: true }; },
    { request: 7, task: 3, agent: 'code', title: 'Fix the login page' }, { every: 1000 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(posts, [{ path: '/v1/runs', body: {
    machine: 'cloud', run: '703', agent: 'code', title: 'Fix the login page', request: 7, task: 3, steps: [],
  } }]);
  await steps.done('done');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.status, 'done');
});

// The owner (2026-11-17): "why did this task on browser failed and also the previous task when i asked it to make it
// remain dark mode as i make the doc full screen on canvas?" Both came back "the rule changes nothing".
test('a page request sees the rules already on for the site, so a follow-up adds to the one it means', async () => {
  const { handle, pagePrompt } = await import('./orchestrator.mjs');
  const dark = { id: 7, host: 'canvas.wisc.edu', path: '', title: 'Dark document previews', rule: { hide: [], keep: [], css: '#doc_preview { filter: invert(1) hue-rotate(180deg); }' } };
  const prompt = pagePrompt({ text: 'Make sure it works when I put the file in full screen as well.' }, { url: 'https://canvas.wisc.edu/courses/1/files/2', title: 'Lab 5', outline: 'div#doc_preview' }, [dark]);
  assert.match(prompt, /rule 7, "Dark document previews", path "" \(every page\): .*#doc_preview \{ filter: invert/);
  assert.match(prompt, /write the whole rule: what it already does plus the change/);
  assert.match(prompt, /:fullscreen and\n?:-webkit-full-screen/);

  const calls = [];
  const board = async (path, body) => {
    calls.push([path, body]);
    if (path.startsWith('/v1/page-rules?host=')) return { rules: [dark] };
    return path === '/v1/page-rules' ? { id: 8 } : {};
  };
  const css = '#doc_preview { filter: invert(1) hue-rotate(180deg); } #doc_preview iframe:fullscreen { filter: invert(1) hue-rotate(180deg); }';
  await handle({ id: 17, text: 'Make sure it works when I put the file in full screen as well.', page: { url: 'https://canvas.wisc.edu/courses/1/files/2', title: 'Lab 5', outline: 'div#doc_preview' } },
    { board, ask: async p => (assert.match(p, /rule 7/), JSON.stringify({ title: 'Dark documents, in full screen too', path: '', css })) });
  assert.ok(calls.some(([p]) => p === '/v1/page-rules?host=canvas.wisc.edu'));
  assert.equal(calls.find(([p]) => p === '/v1/page-rules')[1].rule.css, css);
});

// The owner (2026-11-19), on Canvas's PDF viewer: "i want truly dark mode, and also, when i make a doc full screen it
// should stay dark mode as well whether it's the doc itself its margins the bars, whatever..." came back "The document
// viewer is inside an iframe, so the extension cannot style its document". Frames are reachable now: "frames" CSS.
test('a page rule can style inside the page\'s frames, and the guide says how, full screen included', async () => {
  const { handle, pagePrompt, parsePageRule } = await import('./orchestrator.mjs');
  const frames = 'html, body, .Toolbar { background: #000 !important; } .Page canvas { filter: invert(1) hue-rotate(180deg); }';
  assert.equal(parsePageRule(JSON.stringify({ title: 'Dark viewer', path: '', frames })).rules[0].rule.frames, frames, 'a frames-only rule changes something');
  assert.equal(parsePageRule(JSON.stringify({ title: 'Dark', path: '', css: 'html { color: red }' })).rules[0].rule.frames, undefined);
  const outline = 'div#doc_preview\n  iframe#doc_preview_frame [frame from canvas.wisc.edu]\n--- inside a frame from canvadocs.instructure.com (styled by the rule\'s "frames" CSS) ---\ndiv.Toolbar';
  const prompt = pagePrompt({ text: 'truly dark mode, full screen too' }, { url: 'https://canvas.wisc.edu/courses/1/files/2', title: 'Syllabus', outline });
  assert.match(prompt, /"frames": "<CSS applied inside every frame of the page/);
  assert.match(prompt, /inside a frame from canvadocs\.instructure\.com/);
  assert.match(prompt, /invert the iframe element once more so the two cancel/);
  assert.match(prompt, /iframe:fullscreen, iframe:-webkit-full-screen/);
  assert.doesNotMatch(prompt, /can't reach into them/);

  const calls = [];
  const board = async (path, body) => { calls.push([path, body]); return path === '/v1/page-rules' ? { id: 9 } : { rules: [] }; };
  await handle({ id: 18, text: 'truly dark mode, full screen too', page: { url: 'https://canvas.wisc.edu/courses/1/files/2', title: 'Syllabus', outline } },
    { board, ask: async () => JSON.stringify({ title: 'Truly dark, viewer and full screen', path: '', css: 'iframe:fullscreen { filter: none !important; }', frames }) });
  const saved = calls.find(([p]) => p === '/v1/page-rules')[1];
  assert.equal(saved.rule.frames, frames);
  assert.equal(calls.at(-1)[1].status, 'done');
});

test('an answer that changes nothing is asked once more, and one that cannot says exactly why', async () => {
  const { handle } = await import('./orchestrator.mjs');
  const page = { url: 'https://www.youtube.com/feed/subscriptions', title: 'Subscriptions', outline: 'ytd-browse#browse' };
  let asked = 0;
  const run = async answers => {
    const calls = [];
    const board = async (path, body) => { calls.push([path, body]); return path === '/v1/page-rules' ? { id: 9 } : { rules: [] }; };
    asked = 0;
    await handle({ id: 19, text: 'remove these shorts from my subscriptions page', page }, { board, ask: async prompt => answers[asked++](prompt) });
    return calls.filter(([p]) => p === '/v1/requests/update').at(-1)[1];
  };
  const fixed = await run([
    () => '{"title":"Hide Shorts","hide":[],"keep":[],"css":""}',
    prompt => (assert.match(prompt, /refused \(the rule changes nothing\)/), '{"title":"Hide Shorts","path":"/feed/subscriptions","hide":["ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])"]}'),
  ]);
  assert.equal(asked, 2);
  assert.equal(fixed.status, 'done');
  assert.match(fixed.outcome, /^Hide Shorts: on youtube\.com\/feed\/subscriptions from now on \(page rule 9\)\.$/);

  const cannot = await run([() => '{"cannot": "The video player draws inside a frame from another site, which a page rule can\'t reach."}']);
  assert.equal(asked, 1);
  assert.equal(cannot.status, 'failed');
  assert.equal(cannot.outcome, "Couldn't change the page: The video player draws inside a frame from another site, which a page rule can't reach.");
});

test('a page ask can send the page on and add a link, with a rule per path (YouTube: Subscriptions, Watch later)', async () => {
  const { handle, parsePageRule } = await import('./orchestrator.mjs');
  assert.throws(() => parsePageRule('{"title":"x","go":"/feed/subscriptions"}'), /needs the path/);
  assert.throws(() => parsePageRule('{"rules":[{"path":"/","css":"a{}"},{"path":"/","hide":["b"]}]}'), /same path/);
  const saves = [];
  let id = 20;
  const board = async (path, body) => {
    if (path === '/v1/page-rules') { saves.push(body); return { id: ++id }; }
    if (path.startsWith('/v1/page-rules?')) return { rules: [] };
    return {};
  };
  const ask = async () => JSON.stringify({ rules: [
    { title: 'Sidebar: no Home, Watch later', path: '', hide: ['ytd-mini-guide-entry-renderer:has(a[href="/"])'],
      add: [{ after: 'ytd-mini-guide-entry-renderer:has(a[href="/feed/subscriptions"])', text: 'Watch later', href: '/playlist?list=WL', onclick: 'x' }],
      css: 'a.hive-added { display: block }' },
    { title: 'Open on Subscriptions', path: '/', go: '/feed/subscriptions' },
  ] });
  const updates = [];
  const wrapped = async (path, body) => { if (path === '/v1/requests/update') updates.push(body); return board(path, body); };
  await handle({ id: 30, text: 'open on subscriptions, no home, watch later under subscriptions', page: { url: 'https://www.youtube.com/', title: 'YouTube', outline: '' } },
    { board: wrapped, ask, plan: () => { throw new Error('no plan for a page'); } });
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[0].rule.add, [{ after: 'ytd-mini-guide-entry-renderer:has(a[href="/feed/subscriptions"])', text: 'Watch later', href: '/playlist?list=WL' }]);
  assert.equal(saves[0].path, '');
  assert.equal(saves[1].rule.go, '/feed/subscriptions');
  assert.equal(saves[1].path, '/');
  assert.equal(updates.at(-1).status, 'done');
  assert.match(updates.at(-1).outcome, /Sidebar: no Home, Watch later: on youtube\.com \(every page\) from now on \(page rule 21\)\. Open on Subscriptions: on youtube\.com\/ from now on \(page rule 22\)\./);
});

test("a task's needs are earlier tasks only, renumbered when the planner's empty ones are dropped", () => {
  const plan = parsePlan(JSON.stringify({ tasks: [
    { title: 'Find the form', quote: 'find it' },
    { title: '', quote: '' },
    { title: 'Fill it in', quote: 'fill it', needs: [1, 3, 4, 'x'] },
    { title: 'Tell me', quote: 'tell me', needs: [3, 1, 3] },
    { title: 'Look something up', quote: 'look', needs: 'none' },
  ] }));
  assert.deepEqual(plan.tasks.map(t => [t.title, t.needs]), [
    ['Find the form', []], ['Fill it in', [1]], ['Tell me', [1, 2]], ['Look something up', []],
  ]);
});

const gate = () => { let open; const shut = new Promise(resolve => { open = resolve; }); return { shut, open }; };
const pause = () => new Promise(resolve => setImmediate(resolve));

test('when a task ends, its turns at the devices are given back, stopped or not', async () => {
  const { board } = fakeBoard();
  const released = [];
  await handle({ id: 74, text: 'Create 8 bars of jazz in Ableton' }, {
    board,
    stepEvery: 1,
    labels: new Map(),
    release: label => released.push(label),
    plan: async () => JSON.stringify({ tasks: [{ title: 'Make the jazz', quote: 'x', kind: 'screen' }] }),
    run: async () => ({ ok: false, report: 'Stopped (SIGTERM)', seconds: 1 }),
  });
  assert.deepEqual(released, ['R74-1']);
});

test("tasks that need nothing run at once, a task that needs another starts when it's done, and one whose need failed never starts", async () => {
  const { board, calls } = fakeBoard();
  const gates = { 'Find the form': gate(), 'Look up the deadline': gate(), 'Check the price': gate() };
  const started = [];
  const going = handle({ id: 40, text: 'x' }, {
    board,
    stepEvery: 1,
    labels: new Map(),
    plan: async () => JSON.stringify({ tasks: [
      { title: 'Find the form', quote: 'a', kind: 'screen' },
      { title: 'Look up the deadline', quote: 'b', kind: 'answer' },
      { title: 'Fill it in', quote: 'c', kind: 'screen', needs: [1] },
      { title: 'Check the price', quote: 'd', kind: 'answer' },
      { title: 'Email me the total', quote: 'e', kind: 'answer', needs: [3, 4] },
    ] }),
    run: async (brief, choice, step, { label, title }) => {
      started.push([title, label]);
      if (title === 'Fill it in') return { ok: false, report: 'The form was closed.', seconds: 1 };
      await gates[title].shut;
      return { ok: true, report: `${title}: done.`, seconds: 1 };
    },
  });
  await pause(); await pause(); await pause();
  assert.deepEqual(started.map(([t]) => t), ['Find the form', 'Look up the deadline', 'Check the price']);
  assert.deepEqual(started[0], ['Find the form', labelOf(40, 1)]);
  gates['Look up the deadline'].open();
  gates['Check the price'].open();
  await pause(); await pause();
  assert.equal(started.length, 3, 'Fill it in waits for Find the form');
  gates['Find the form'].open();
  await going;
  assert.deepEqual(started.map(([t]) => t), ['Find the form', 'Look up the deadline', 'Check the price', 'Fill it in']);
  const last = key => calls.filter(c => c.path === '/v1/requests/update').flatMap(c => c.body.tasks ?? []).filter(t => t.key === key).at(-1);
  assert.equal(last(3).status, 'blocked');
  assert.equal(last(5).status, 'blocked');
  assert.equal(last(5).outcome, 'Not started: it needs «Fill it in» first, which stopped before it finished.');
  assert.equal(calls.filter(c => c.path === '/v1/requests/update').at(-1).body.outcome,
    '3 of 5 done; Fill it in (blocked), Email me the total (blocked).');
});

test('the owner stopping a request stops its running agents, and its tasks not started yet never start', async () => {
  const { board: base, calls } = fakeBoard();
  let stopAt = null;
  const board = async (path, body) => (path === '/v1/requests/state?id=41' ? { request: { id: 41, stop_at: stopAt } } : base(path, body));
  const started = [];
  const going = handle({ id: 41, text: 'x', from: 'mac' }, {
    board, stepEvery: 1, stopEvery: 2,
    plan: async () => JSON.stringify({ tasks: [
      { title: 'Open Notes on the Mac', quote: 'a', kind: 'mac' },
      { title: 'Write the list', quote: 'b', kind: 'mac', needs: [1] },
    ] }),
    run: (brief, choice, step, { title, signal }) => {
      started.push(title);
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, report: 'Stopped (SIGTERM)', seconds: 1 })));
    },
  });
  await pause(); await pause();
  assert.deepEqual(started, ['Open Notes on the Mac']);
  stopAt = 1234;
  await going;
  assert.deepEqual(started, ['Open Notes on the Mac'], 'the second never starts');
  const updates = calls.filter(c => c.path === '/v1/requests/update');
  const last = key => updates.flatMap(c => c.body.tasks ?? []).filter(t => t.key === key).at(-1);
  assert.deepEqual([last(1).status, last(1).outcome], ['dropped', 'Stopped by the owner.']);
  assert.deepEqual([last(2).status, last(2).outcome], ['dropped', 'Stopped by the owner.']);
  assert.deepEqual([updates.at(-1).body.status, updates.at(-1).body.outcome], ['failed', 'Stopped by the owner.']);
  const run = calls.filter(c => c.path === '/v1/runs').at(-1).body;
  assert.equal(run.status, 'stopped');
});

test('no more tasks work at once than the slots allow, across requests, first come first served', async () => {
  const slots = new Slots(2);
  let working = 0;
  let most = 0;
  const order = [];
  const job = name => slots.with(async () => {
    working += 1; most = Math.max(most, working); order.push(name);
    await pause(); await pause();
    working -= 1;
  });
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(job));
  assert.equal(most, 2);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
  await assert.rejects(slots.with(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(slots.used, 0, 'a task that throws gives its slot back');
});

test("a task waiting for the screen or the phone says for whom, in its own run", () => {
  const said = [];
  const labels = new Map([
    ['R40-1', { title: 'Find the form', step: line => said.push(['R40-1', line]) }],
    ['R41-2', { title: 'Book the room', step: line => said.push(['R41-2', line]) }],
  ]);
  const show = (label, message) => { const s = turnStep(labels, label, message); if (s) s.task.step(s.text); };
  show('R41-2', { op: 'queued', device: 'screen', holder: 'R40-1', ahead: 0 });
  show('R41-2', { op: 'queued', device: 'phone', holder: 'R40-1 closing', ahead: 2 });
  show('R41-2', { op: 'granted', device: 'screen', waited_ms: 42_400 });
  show('R40-1', { op: 'granted', device: 'phone', waited_ms: 0 });
  show('R40-1', { op: 'revoked', device: 'phone' });
  show('by hand', { op: 'queued', device: 'screen', holder: 'R40-1' });
  assert.deepEqual(said, [
    ['R41-2', "⏳ Waiting for the VM's screen: «Find the form» is using it."],
    ['R41-2', "⏳ Waiting for the owner's iPhone: «Find the form» is using it (2 more ahead of this one)."],
    ['R41-2', "Got the VM's screen after 42 s."],
    ['R40-1', "Gave the owner's iPhone to the task waiting for it; this one waits in line for its next call."],
  ]);
});

test('a task Hive itself stands in the way of has Hive change itself, then runs again with the change', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const improveDir = mkdtempSync(join(tmpdir(), 'hive-improve-'));
  try {
    const { board, calls } = fakeBoard();
    const briefs = [];
    const asked = [];
    await handle({ id: 9, text: 'send the video to the VM' }, {
      board, now: () => 1000, stepEvery: 1, improveDir,
      plan: async () => JSON.stringify({ project: 'hive', tasks: [{ title: 'Send the video to the VM', quote: 'send the video to the VM', kind: 'mac', difficulty: 'normal' }] }),
      run: async (brief, choice, step, { improveFile }) => {
        briefs.push(brief);
        assert.equal(improveFile, join(improveDir, `r9-1-${briefs.length - 1}.json`), 'a need file a run');
        if (briefs.length === 1) {
          writeFileSync(improveFile, JSON.stringify({ what: 'Run shell commands on the Mac', why: 'Only a command can copy the file.' }));
          return { ok: true, report: 'Hive has no Mac shell; asked for one.', seconds: 5, tokensIn: 10, tokensOut: 1 };
        }
        return { ok: true, report: 'Sent it with hive-files.', seconds: 7, tokensIn: 20, tokensOut: 2 };
      },
      improve: async (need, where, step) => {
        asked.push({ need, where });
        step('$ Testing Hive\'s change (2 files)');
        return { ok: true, commit: 'abcdef0123456789', files: ['cloud/vm-agent/mac-mcp.mjs', 'cloud/vm-agent/mac-mcp.test.mjs'], live: ['the VM'], report: 'Added shell.', seconds: 60, tokensIn: 100, tokensOut: 10 };
      },
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].need.what, 'Run shell commands on the Mac');
    assert.equal(asked[0].where.request, 9);
    assert.equal(asked[0].where.key, 1);
    assert.equal(asked[0].where.round, 0);
    assert.match(asked[0].where.report, /no Mac shell/);
    assert.equal(briefs.length, 2);
    assert.match(briefs[1], /Hive just changed itself for this task, because it couldn't run shell commands on the Mac:\nabcdef0123 on main \(2 files: .*\); live on the VM/);
    const last = calls.filter(c => c.path === '/v1/requests/update').at(-1).body;
    assert.equal(last.status, 'done');
    const task = calls.filter(c => c.path === '/v1/requests/update' && c.body.tasks).at(-1).body.tasks[0];
    assert.equal(task.status, 'done');
    assert.equal(task.report, 'Sent it with hive-files.');
    assert.equal(task.work_seconds, 72, 'both runs and the change');
    assert.equal(task.tokens_in, 130);
    const steps = calls.filter(c => c.path === '/v1/runs').flatMap(c => c.body.steps ?? []).map(s => s.text);
    assert.ok(steps.includes('🛠 Hive is changing itself: Run shell commands on the Mac'));
    assert.ok(steps.some(s => /^✅ Hive changed itself: abcdef0123 on main/.test(s)));
  } finally {
    rmSync(improveDir, { recursive: true, force: true });
  }
});

test("a change Hive couldn't make, or one change too many, ends the task with exactly why", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const improveDir = mkdtempSync(join(tmpdir(), 'hive-improve-'));
  const plan = async () => JSON.stringify({ project: 'hive', tasks: [{ title: 'Do it', quote: 'do it', kind: 'screen', difficulty: 'normal' }] });
  const asking = async (brief, choice, step, { improveFile }) => {
    writeFileSync(improveFile, JSON.stringify({ what: 'Read PDFs.', why: 'The page is a PDF.' }));
    return { ok: true, report: 'Asked.', seconds: 1 };
  };
  const taskOf = calls => calls.filter(c => c.path === '/v1/requests/update' && c.body.tasks).at(-1).body.tasks[0];
  try {
    const first = fakeBoard();
    await handle({ id: 10, text: 'do it' }, {
      board: first.board, now: () => 1000, stepEvery: 1, improveDir, plan, run: asking,
      improve: async () => ({ ok: false, report: "Hive's tests still failed after 3 tries" }),
    });
    assert.equal(taskOf(first.calls).status, 'blocked');
    assert.match(taskOf(first.calls).report, /Hive couldn't change itself so it can Read PDFs: Hive's tests still failed after 3 tries/);

    const second = fakeBoard();
    let changes = 0;
    let runs = 0;
    await handle({ id: 11, text: 'do it' }, {
      board: second.board, now: () => 1000, stepEvery: 1, improveDir, plan,
      run: async (...args) => { runs++; return asking(...args); },
      improve: async () => { changes++; return { ok: true, commit: '0000000000ff', files: ['a.mjs'], live: [], report: '' }; },
    });
    assert.equal(changes, 2, 'MOST_ROUNDS changes, no more');
    assert.equal(runs, 3);
    assert.equal(taskOf(second.calls).status, 'blocked');
    assert.match(taskOf(second.calls).report, /already changed itself 2 times for this task/);

    const third = fakeBoard();
    await handle({ id: 12, text: 'do it' }, {
      board: third.board, now: () => 1000, stepEvery: 1, plan,
      run: async (brief, choice, step, { improveFile }) => { assert.equal(improveFile, '', 'no improve: no need file'); return { ok: true, report: 'Done.', seconds: 1 }; },
    });
    assert.equal(taskOf(third.calls).status, 'done');
  } finally {
    rmSync(improveDir, { recursive: true, force: true });
  }
});
