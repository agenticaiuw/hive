// Hive changing itself (the owner, 2026-11-20: "you're adding the capabilities of a self-improving
// harness so that Hive can improve itself", "and then fix both of these issues itself within a
// continuous session").
//
// A task that finds Hive itself in its way (a tool it lacks, one of its own that is broken) calls
// improve_hive (knowledge-mcp.mjs), which writes what's missing to the task's need file. After the
// run, the orchestrator reads it (readNeed) and, instead of ending the task:
//   1. has a code agent change Hive in a worktree off main (SELF_GUIDE, improveBrief);
//   2. tests the change here (gateTests) and, for the Mac's parts, on the Mac (hive_self check, which
//      builds the whole Mac release: onTheMac), handing the failures back to the agent until it passes
//      (fixBrief, at most MOST_FIXES tries);
//   3. lands it on main, fast-forward, and puts it live where it runs (partsOf): a VM release the
//      updater puts in at once when only what tasks start changed, the board, the dashboard website
//      (hive_self site), the Mac (hive_self install: a Mac release, put in on the owner's Mac once Hive
//      is idle);
//   4. runs the task again with the change (againBrief), at most MOST_ROUNDS changes a task.
// The pure parts are here, with their tests (improve.test.mjs); the git, test and deploy steps are the
// orchestrator's (orchestrator.mjs improveOnVm).
import { readFileSync, rmSync } from 'node:fs';

export const MOST_ROUNDS = 2;
export const MOST_FIXES = 3;

/** What the task asked Hive to change, once: the need file is removed as it's read. Null when it asked nothing. */
export function readNeed(file, { read = path => readFileSync(path, 'utf8'), remove = path => rmSync(path, { force: true }) } = {}) {
  if (!file) return null;
  let text;
  try { text = read(file); } catch { return null; }
  remove(file);
  try {
    const need = JSON.parse(text);
    const what = String(need.what ?? '').trim();
    const why = String(need.why ?? '').trim();
    return what && why ? { what: what.slice(0, 500), why: why.slice(0, 4000) } : null;
  } catch {
    return null;
  }
}

export const SELF_GUIDE = `You are Hive's agent, changing Hive's own code so that Hive can do what one of its tasks needed.
You are in a worktree of Hive's repository off main, with a shell and the network off. Before each command, say in one
line what it is for. Make the change Hive needs, the smallest that does it well, in Hive's own style: the files' comments
say why the code is the way it is, in plain words; keep them true. Add or change tests beside the code you change, and run
them. Never commit, push or change git settings: Hive tests, lands and deploys your change itself. Never put the owner's
details (their name, email, school ID, phone, addresses, keys, the board's address) in code or tests: the repository is public.

Where things are:
- cloud/vm-agent: Hive on its cloud VM. orchestrator.mjs plans the owner's requests into tasks and runs them;
  hive-task.mjs runs one task's Codex with its tool servers and its guide (GUIDE); the tool servers are desktop-mcp.mjs
  (the VM's screen), browser-mcp.mjs, phone-mcp.mjs, knowledge-mcp.mjs and mac-mcp.mjs (the owner's Mac's tools, called
  through the board); files.mjs moves files between machines; updater.mjs keeps the VM on the newest release. Tests:
  cloud/vm-agent/*.test.mjs (node --test).
- cloud/tasks: the board, a Cloudflare Worker (worker.js, mac.js for the Mac's calls) with D1 migrations in
  cloud/knowledge/migrations; tests in cloud/tests/*.test.mjs (node --test, node:sqlite for D1).
- desktop/app/crates/hive: Hive on the owner's Mac, in Rust. hive-mac is the Mac's tools (the screen, keyboard, mouse);
  hive-app/src/cloud_brain.rs (MacPeer) answers the VM's calls on them; hive-codex runs the Mac's own agent; hive-tasks is
  the task board's CLI. These crates build only on macOS: you can't build or test them here, so write them carefully
  and keep their tests beside them; Hive builds and tests them on the Mac before anything lands.
- desktop/*.mjs: scripts on the Mac (hive-files.mjs sends files to the VM, vm-post.mjs hands the VM work).
- browser/chrome: Hive's browser extension. dashboard: the dashboard (a web app).

End with a short report: what you changed and why, what you ran and what it showed.`;

/** The code agent's brief: what the task needed, the task itself, and how far it got. */
export function improveBrief(need, { title = '', brief = '', report = '' } = {}) {
  return [
    `A task of Hive's couldn't go on because Hive itself is missing something. Change Hive so it can.`,
    `What Hive should be able to do: ${need.what}`,
    `Why (the task's own words): ${need.why}`,
    title && `The task: ${title}`,
    report && `What the task did before it stopped:\n${report.slice(0, 3000)}`,
    brief && `The task's brief, for what it was trying to do (don't do the task; change Hive so the task can):\n${brief.slice(0, 4000)}`,
  ].filter(Boolean).join('\n\n');
}

/** The same agent again, with what the tests said. */
export function fixBrief(failures) {
  return `Your change didn't pass Hive's tests. Fix it (your change is in this worktree as you left it), then run the tests again.\n\n${failures.slice(-6000)}`;
}

/** The task again, now that Hive has changed. */
export function againBrief(brief, need, landed) {
  return `${brief}\n\nHive just changed itself for this task, because it couldn't ${need.what.replace(/[.\s]+$/, '').replace(/^\w/, c => c.toLowerCase())}:\n${landed}\nCarry on from where the last run stopped, with the change.`;
}

/** Where a change lives, so where it's tested and put live. */
export function partsOf(files) {
  const any = re => files.some(f => re.test(f));
  return {
    vm: any(/^cloud\/vm-agent\//),
    board: any(/^cloud\/(tasks|knowledge\/migrations|shared)\//),
    mac: any(/^(desktop|browser|dashboard|branding)\//),
    site: any(/^dashboard\//),
    cloudTests: any(/^cloud\/(tasks|knowledge|shared|tests)\//),
  };
}

/** The tests run here before a change lands: the privacy test always, and the tests of each part it touched
 *  that run on Linux. `have` lists the repository's test files. */
export function gateTests(files, have) {
  const parts = partsOf(files);
  const pick = re => have.filter(f => re.test(f));
  return [...new Set([
    ...pick(/^cloud\/shared\/privacy\.test\.mjs$/),
    ...(parts.vm ? pick(/^cloud\/vm-agent\/[^/]+\.test\.mjs$/) : []),
    ...(parts.cloudTests ? pick(/^cloud\/(tests\/[^/]+|shared\/[^/]+)\.test\.mjs$/) : []),
    ...files.filter(f => /\.test\.mjs$/.test(f) && have.includes(f) && !/^(desktop|browser|dashboard)\//.test(f)),
  ])].sort();
}

/** The tail of a failed run's output that says what failed: node's ✖ lines and the errors under them. */
export function failuresOf(output) {
  const lines = String(output).split('\n');
  const keep = lines.filter(l => /✖|not ok|Error|expected|actual|failed|error:/i.test(l));
  return (keep.length ? keep : lines).slice(-80).join('\n').slice(-6000);
}

/**
 * A hive_self job on the owner's Mac (hive-app self_change.rs), followed to its end: `call(name, args)`
 * makes one call on the Mac (mac-mcp.mjs callMac). The job starts, then its status is asked every
 * `every` while it's running (or, for an install, waiting for Hive to be idle), `wait` at most. A status
 * the Mac didn't answer (Hive restarting onto the release it just put in) is asked again. What it ended
 * as: {state, failures?, version?, here?, running, timedOut?}.
 */
export async function onTheMac(call, args, { wait = 90 * 60_000, every = 30_000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onState = () => {} } = {}) {
  const said = result => {
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(text.replace(/^Failed: /, '') || 'the Mac said no');
    return JSON.parse(text);
  };
  const started = said(await call('hive_self', args));
  const until = now() + wait;
  let last = started;
  for (;;) {
    await sleep(every);
    try {
      last = said(await call('hive_self', { action: 'status', job: started.job }));
      onState(last);
    } catch (error) {
      if (now() > until) throw error;
      continue;
    }
    if (!['running', 'waiting'].includes(last.state)) return last;
    if (now() > until) return { ...last, timedOut: true };
  }
}

/** After an install, whether Hive on the Mac came back running the release it put in: its status, asked
 *  every `every` for `wait` at most, says which version answered (Hive restarts onto it once it's idle). */
export async function macRunning(call, job, { wait = 5 * 60_000, every = 15_000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  if (!job?.version) return false;
  if (job.running === job.version) return true;
  const until = now() + wait;
  while (now() <= until) {
    await sleep(every);
    try {
      const result = await call('hive_self', { action: 'status', job: job.id });
      if (!result?.isError && JSON.parse(result?.content?.[0]?.text ?? '{}').running === job.version) return true;
    } catch {}
  }
  return false;
}

/** The Mac's account of a failed check, for the code agent: which step, and what it said. */
export function macFailures(job) {
  return `On the owner's Mac (macOS), where Hive on the Mac builds: ${job.failures || 'the check failed'}`;
}

/** One line for the board on what landed, and where it went live. */
export function landedLine({ commit, files, live }) {
  const where = live.length ? `; live on ${live.join(', ')}` : '';
  return `${commit.slice(0, 10)} on main (${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''})${where}`;
}
