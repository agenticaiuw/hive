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
//   3. lands it on main, fast-forward (when main moved under it and it no longer applies, the same agent
//      resolves where the two meet, conflictBrief, and it's tested again), never carrying a secret from
//      the VM (leaksIn), and puts it live where it runs (partsOf): a VM release the
//      updater puts in at once when only what tasks start changed, the board, the dashboard website
//      (hive_self site), the Mac (hive_self install: a Mac release, put in on the owner's Mac once Hive
//      is idle);
//   4. runs the task again with the change (againBrief), at most MOST_ROUNDS changes a task.
// A code task in Hive's own repository goes the same way (askedBrief, orchestrator.mjs changeHive): Hive
// builds Hive, so what someone asks Hive to change in itself lands and goes live like a change it needed.
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

export const SELF_GUIDE = `You are Hive's agent, changing Hive's own code: so that Hive can do what one of its tasks needed, or as asked.
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

/** The code agent's brief when the change to Hive is itself what was asked (a code task in Hive's own
 *  repository: Hive builds Hive). */
export function askedBrief(need, { brief = '' } = {}) {
  return [
    `Change Hive as asked: ${need.what}`,
    `In the asker's words: ${need.why}`,
    brief && `The task's brief:\n${brief.slice(0, 4000)}`,
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
    // Hive Phone's sources (cloud/release.mjs PHONE_SOURCES): built on the Mac, offered by SideStore.
    phone: any(/^(mobile\/relay\/(WebDriverAgent|icon)\/|mobile\/relay\/build\.mjs$|cloud\/shared\/(ownerDetails|hiveCloud)\.mjs$)/),
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
 * makes one call on the Mac (mac-mcp.mjs callMac). The job starts (once the Mac is through with another
 * change's job: it runs one at a time), then its status is asked every `every` while it's running (or,
 * for an install, waiting for Hive to be idle), `wait` at most in all. A status the Mac didn't answer
 * (Hive restarting onto the release it just put in) is asked again. What it ended as:
 * {state, failures?, version?, here?, running, timedOut?}.
 */
export async function onTheMac(call, args, { wait = 90 * 60_000, every = 30_000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, onState = () => {} } = {}) {
  const said = result => {
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(text.replace(/^Failed: /, '') || 'the Mac said no');
    return JSON.parse(text);
  };
  const until = now() + wait;
  let started;
  for (;;) {
    try {
      started = said(await call('hive_self', args));
      break;
    } catch (error) {
      // Another change's job (two requests changing Hive at once): this one waits its turn.
      if (!/still on job/.test(error.message) || now() > until) throw error;
      await sleep(every);
    }
  }
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

// How long a change waits to land while an agent that leased one of its files first still holds it.
export const MOST_LEASE_WAIT_MS = 30 * 60_000;

/**
 * The leases a change must wait for before it lands (the board's /v1/team/claims over its files): another
 * agent's exclusive lease taken before this change's own (`me`'s oldest lease; ties by name). The younger
 * of two goes second, so two changes holding each other's files never wait on each other for ever.
 */
export function blockers(leases, me) {
  const mine = leases.filter(l => l.agent === me).reduce((age, l) => Math.max(age, l.held_for ?? 0), -1);
  return leases.filter(l => l.agent !== me && l.exclusive && ((l.held_for ?? 0) > mine || ((l.held_for ?? 0) === mine && l.agent < me)));
}

/** For a code agent's brief: the files other agents hold now. */
export function othersHold(leases, me) {
  const others = leases.filter(l => l.agent !== me);
  if (!others.length) return '';
  return `Other agents are changing these files of Hive's now; leave them alone unless your change needs them (if it does, say so in your report):\n`
    + others.map(l => `- ${l.path}: ${l.agent}${l.note ? ` (${l.note})` : ''}`).join('\n');
}

// How many times a change is put on main again, with its agent resolving where it meets what landed
// meanwhile, before it gives up.
export const MOST_CONFLICTS = 2;

/** The code agent's brief when main moved under its change: the change is on main as it is now, and these
 *  files have git's conflict markers where the two meet. */
export function conflictBrief(files) {
  return `While you worked, other changes landed on main, and yours no longer applied as it was. It's in this worktree again, `
    + `on main as it is now${files.length ? `, and these files have git's conflict markers (<<<<<<< ======= >>>>>>>) where yours meets `
    + `what landed: ${files.join(', ')}. Resolve each one, keeping what landed and what your change does` : ''}. `
    + `Then run the tests again. Never commit, rebase or change git settings.`;
}

/** Git's conflict markers left in a file's text. */
export const CONFLICT_MARKER = /^(<<<<<<<|>>>>>>>)( |$)/m;

/**
 * Land a tested change, with git scoped to its worktree. `base` is the commit it was built on,
 * not origin/main read just before fetching: worktrees share that ref, so another task's fetch
 * or push may already have moved it. Test again after each rebase, before trying to push.
 */
export async function landOnMain(git, { base, committer = [], test }) {
  // execFile's first message line is only the command. Keep Git's reason so a continuation can
  // tell a race from a permission failure without guessing from the command it ran.
  const reason = error => String(error.stderr || error.message).trim().slice(-2000);
  for (let attempt = 1; ; attempt++) {
    await git('fetch', '--quiet', 'origin', 'main');
    const next = await git('rev-parse', 'origin/main');
    if (next !== base) {
      try { await git(...committer, 'rebase', '--quiet', next); } catch (error) {
        await git('rebase', '--abort').catch(() => {});
        throw Object.assign(new Error(`it no longer applies to main, which changed meanwhile (${reason(error)})`), { conflict: true });
      }
      base = next;
      const again = await test(base);
      if (!again.ok) throw new Error(`its tests failed on main as it is now:\n${again.failures}`);
    }
    try {
      await git('push', '--quiet', 'origin', 'HEAD:refs/heads/main');
      return await git('rev-parse', 'HEAD');
    } catch (error) {
      if (attempt >= 3) throw new Error(`main wouldn't take it: ${reason(error)}`);
    }
  }
}

// The names of settings that hold secrets.
const SECRET_NAME = /TOKEN|KEY|SECRET|PASS|AUTH|CREDENTIAL|COOKIE|CODE/i;

/**
 * The secret values on this machine a change must never carry into the public repository: those of
 * environment variables named like secrets, and every string in the given JSON files (the board's config,
 * Codex's sign-in). Paths and short words are left out: they're not secrets, and code names them.
 */
export function secretValues({ env = {}, json = [] } = {}) {
  const found = new Set();
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name) && typeof value === 'string') found.add(value);
  const walk = value => {
    if (typeof value === 'string') found.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  json.forEach(walk);
  return [...found].filter(value => value.length >= 16 && !value.startsWith('/'));
}

/** How many secrets a change's diff holds (any of `secrets`, or a private key): one is enough to throw it away. */
export function leaksIn(diff, secrets) {
  return secrets.filter(secret => diff.includes(secret)).length + (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(diff) ? 1 : 0);
}

/** One line for the board on what landed, and where it went live. */
export function landedLine({ commit, files, live }) {
  const where = live.length ? `; live on ${live.join(', ')}` : '';
  return `${commit.slice(0, 10)} on main (${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''})${where}`;
}
