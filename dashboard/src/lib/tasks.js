/**
 * The owner's tasks, in one shape wherever the dashboard runs.
 *
 * Every agent the owner talks to (Claude Code, Codex, Hive, on the Mac or Hive's VM) saves each
 * message and the tasks in it to a ledger on its machine, and every ledger syncs to the cloud
 * board (cloud/tasks). `GET /api/tasks` answers `{source, note?, board}` on every host:
 *
 *   - `source: "cloud"`: `board` is the cloud board, every machine:
 *     `{now, tasks: [row], unsplit: [message], rules: [rule], folders: [folder], limits: [limit],
 *     requests: [request], runs: [run], run_steps: [step]}`, a row carrying its `machine`. `runs` are
 *     every node's agents at work or just finished (Hive on each Mac, Hive's cloud agent on the VM and
 *     the phone, each browser extension's own agent), each with its steps, line by line, as it did them;
 *   - `source: "local"`: the cloud couldn't be reached and `board` is this machine's ledger
 *     (`hive-tasks board --all --json`): `{generated_at, needs_you, in_progress, not_started,
 *     left_open, done, not_split, rules, folders, limits}`, with `note` saying why.
 *
 * Limits are how much of each subscription's usage windows the agents have used, as each machine
 * last read them from its harness (Codex writes them into every session; Claude Code doesn't).
 *
 * Folders are the parts of a project ("memory retrieval" in hive): a task names its folder
 * ("memory retrieval", or "hive › memory retrieval" when it's another project's), and each folder
 * keeps memories every agent working in it gets in full (`GET /api/folder`).
 *
 * Plain JavaScript so `node --test` can load it without a build.
 */

/** @typedef {{key: string, id: string, machine: string, message: string, quote: string,
 *   title: string, status: string, minutes: number|null, value: string, outcome: string,
 *   evidence: string, harness: string, session: string, project: string, projectName: string,
 *   folder: string, report: string, workSeconds: number|null, tokensIn: number|null,
 *   tokensOut: number|null, created: number, said: number, asked: string, updated: number,
 *   files: string[], commits: Commit[], retrying: boolean}} Task */

/** @typedef {{hash: string, branch: string, title: string}} Commit */
/** A standing rule, as the board gives it (normalizeBoard).
 *  @typedef {{key: string, id: string, machine: string, text: string, quote: string, project: string,
 *    projectName: string, paths: string[], shown: number}} Rule */

/** @typedef {{project: string, key: string, name: string, about: string, memories: number,
 *   updated: number}} Folder */

/** @typedef {{minutes: number, used: number, resetsAt: number}} LimitWindow */

/** @typedef {{id: string, follows: string, text: string, project: string, folder: string, status: string,
 *   outcome: string, created: number, updated: number, steps: Step[]}} Request */

/** One thing an agent said or did ("click(x=514, y=421)", "→ click: Open Compose", "💬 …", "Done."), in
 *  order; `kind` is action, think, say, done or failed when its node knows, and `task` the request's task.
 *  @typedef {{n: number, task: number, at: number, kind: string, text: string}} Step */

/** One of the owner's agents at work on one node, or just finished: `node` is where, in words. A
 *  Claude Code or Codex session on one of the owner's Macs is a run too ("claude:<session>", hive-tasks
 *  live.rs): its `harness` and `session` say which, and `label` reads "Claude Code · hive".
 *  @typedef {{key: string, machine: string, run: string, agent: string, node: string, label: string,
 *   title: string, status: string, request: string, task: number, project: string, projectName: string,
 *   harness: string, session: string, started: number, updated: number, steps: Step[]}} Run */

/** What each state of an agent's run reads as. */
export const RUN_WORDS = { working: 'Working', done: 'Done', failed: "Didn't finish", stopped: 'Stopped' };

/**
 * Where a run is happening, in words: "Hive in the cloud", "Chrome extension", "Hive on studio-mac".
 * @param {string} machine
 */
export function nodeName(machine) {
  if (machine === 'cloud') return 'Hive in the cloud';
  if (machine.startsWith('ext:')) {
    const browser = machine.slice(4);
    return `${browser.charAt(0).toUpperCase()}${browser.slice(1)} extension`;
  }
  return machine ? `Hive on ${machine}` : 'Hive';
}

/** What each state of an instruction sent to Hive's orchestrator in the cloud reads as. */
export const REQUEST_WORDS = {
  queued: 'Waiting for Hive',
  planning: 'Hive is planning it',
  working: 'Hive is working on it',
  done: 'Done',
  failed: "Didn't finish",
};

/** @typedef {{key: string, machine: string, harness: string, home: string, plan: string,
 *   windows: LimitWindow[], at: number}} Limit */

export const HARNESSES = { claude: 'Claude Code', codex: 'Codex', hive: 'Hive' };
/** The coding agents whose sessions stream to the board as runs (hive-tasks live.rs). */
const CODING_HARNESSES = ['claude', 'codex'];

/**
 * Whether a task goes nowhere without the owner: only one its agent stopped on with the exact
 * reason and what it needs from them (waiting). A stuck one is Hive's: the cloud keeps continuing it
 * (the owner: "if they must stop they must provide an exact reason of why they stopped and what
 * exactly do they need me for or else they'd just keep going").
 * @param {Task} t
 */
export const needsOwner = (t) => t.status === 'waiting';

/** The sections of the board, in the order they're shown, each with the tasks it holds (`has`). */
export const SECTIONS = [
  // What goes nowhere without the owner: a task waiting on them, its outcome saying why it stopped
  // and exactly what it needs.
  { id: 'needs-you', title: 'Needs you', statuses: ['waiting'], has: needsOwner },
  // A stuck task is still being worked on: Hive keeps continuing it.
  { id: 'working', title: 'Working on it', statuses: ['active', 'blocked'], has: (/** @type {Task} */ t) => t.status === 'active' || t.status === 'blocked' },
  { id: 'not-started', title: 'Not started', statuses: ['open'], has: (/** @type {Task} */ t) => t.status === 'open' },
  { id: 'done', title: 'Done', statuses: ['done', 'dropped'], has: (/** @type {Task} */ t) => t.status === 'done' || t.status === 'dropped' },
];

/**
 * Seconds since the epoch from a number of seconds or an ISO time (local when it has no zone,
 * as the ledgers write it). 0 when there's nothing to read.
 * @param {unknown} value
 */
export function seconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * A short name for a project: the repository's name for "github.com/owner/name", the folder's
 * name for a path, "a scratch folder" for the desktop app's throwaway session folders.
 * @param {unknown} project
 */
export function projectName(project) {
  const text = String(project || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (text.includes('/scratch-workspaces/')) return 'a scratch folder';
  return text.split('/').pop() || text;
}

/**
 * A list the ledger keeps as JSON text (a task's files or commits), or already a list.
 * @param {unknown} value
 * @returns {any[]}
 */
function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Where a commit's diff is: GitHub's page for it when the project is a GitHub repository.
 * @param {Task} task
 * @param {Commit} commit
 */
export function commitUrl(task, commit) {
  const repo = task.project.match(/^github\.com\/[\w.-]+\/[\w.-]+$/);
  return repo && /^[0-9a-f]{7,40}$/.test(commit.hash) ? `https://${repo[0]}/commit/${commit.hash}` : '';
}

/** @param {unknown} value */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {Record<string, any>} row
 * @param {string} machine
 * @returns {Task}
 */
function toTask(row, machine) {
  const text = (/** @type {string} */ key) => (row[key] == null ? '' : String(row[key]));
  const where = text('machine') || machine;
  // "hive › memory retrieval" is a folder of another project than the session's (its first name
  // was "part").
  const named = (text('folder') || text('part')).trim();
  const [inProject, folder] = named.includes('›')
    ? named.split('›').map((s) => s.trim())
    : ['', named];
  return {
    key: `${where}:${text('id')}`,
    id: text('id'),
    machine: where,
    message: text('message'),
    quote: text('quote'),
    title: text('title') || text('quote'),
    status: text('status') || 'open',
    minutes: typeof row.minutes === 'number' ? row.minutes : null,
    value: text('value'),
    outcome: text('outcome'),
    evidence: text('evidence'),
    harness: text('harness'),
    session: text('session'),
    project: text('project'),
    projectName: inProject || projectName(row.project),
    folder,
    report: text('report'),
    workSeconds: number(row.work_seconds),
    tokensIn: number(row.tokens_in),
    tokensOut: number(row.tokens_out),
    files: list(row.files).filter((f) => typeof f === 'string'),
    commits: list(row.commits)
      .filter((c) => c && typeof c.hash === 'string')
      .map((c) => ({ hash: c.hash, branch: String(c.branch || ''), title: String(c.title || '') })),
    created: seconds(row.created_at ?? row.said_at),
    said: seconds(row.said_at ?? row.created_at),
    // When the owner asked for it, which is all a task is called by besides its title (T246, T320).
    asked: stamp(seconds(row.said_at ?? row.created_at)),
    updated: seconds(row.updated_at ?? row.done_at ?? row.created_at ?? row.said_at),
    // Stuck, but Hive in the cloud is still continuing it by itself (the board's retrying).
    retrying: (text('status') === 'blocked') && Number(row.retrying) === 1,
  };
}

/** "261117 14:05": a moment as yymmdd hh:mm, in this device's time ('' for none). @param {number} at seconds */
export function stamp(at) {
  if (!at) return '';
  const d = new Date(at * 1000);
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${two(d.getFullYear() % 100)}${two(d.getMonth() + 1)}${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * A plan limit row (the cloud's, its windows a JSON text, or the local ledger's, a list).
 * @param {any} l
 * @param {string} machine
 * @returns {Limit}
 */
function toLimit(l, machine) {
  const harness = String(l.harness ?? '');
  const home = String(l.home ?? '');
  return {
    key: `${l.machine || machine}:${harness}:${home}`,
    machine: String(l.machine || machine),
    harness,
    home,
    plan: String(l.plan ?? ''),
    windows: list(l.windows).map((/** @type {any} */ w) => ({
      minutes: Number(w.minutes) || 0,
      used: Math.max(0, Math.min(100, Number(w.used) || 0)),
      resetsAt: Number(w.resets_at ?? w.resetsAt) || 0,
    })),
    at: seconds(l.at),
  };
}

const NODE_KINDS = /** @type {Record<string, string>} */ ({ board: 'Board', vm: 'VM', mac: 'Mac', phone: 'Phone' });
const SHORT = (/** @type {string} */ v) => (/^[0-9a-f]{12}$/.test(v) ? v.slice(0, 7) : v);

/**
 * Hive's nodes and what each runs (cloud/tasks/nodes.js), for the side panel: the board itself, then
 * each VM, Mac, browser and phone. The hive-tasks command on each machine isn't a node of its own.
 * `state` is "current", "behind" (a newer release is out for it), "old" (on routes the board no
 * longer serves), "dev" (built by hand, so it's never replaced by a release) or "" (nothing published
 * for its kind); `away` when it hasn't called for 10 minutes.
 * @param {any} list
 * @param {number} now seconds
 */
export function toNodes(list, now) {
  if (!list || !Array.isArray(list.nodes)) return [];
  const board = { key: 'board', kind: 'board', label: 'Board', version: SHORT(String(list.board?.version ?? 'dev')), latest: '', state: '', note: '', away: false };
  const rows = list.nodes
    .filter((/** @type {any} */ n) => n.kind !== 'cli')
    .map((/** @type {any} */ n) => {
      const kind = String(n.kind);
      const name = String(n.name ?? '');
      const kindName = NODE_KINDS[kind] ?? kind;
      // A machine named after its kind ("vm", "mac") is just "VM", "Mac": the name would only repeat it.
      const label = kind === 'extension' ? name.charAt(0).toUpperCase() + name.slice(1)
        : !name || name.toLowerCase() === kindName.toLowerCase() ? kindName : `${kindName} ${name}`;
      const state = n.old_protocol ? 'old' : n.version === 'dev' ? 'dev' : n.current === true ? 'current' : n.current === false ? 'behind' : '';
      return {
        key: `${kind}:${name}`,
        kind,
        label,
        version: SHORT(String(n.version ?? '')),
        latest: n.latest ? SHORT(String(n.latest)) : '',
        state,
        note: String(n.note ?? ''),
        away: now - Math.floor(Number(n.seen_at) / 1000) > 600,
      };
    });
  return [board, ...rows];
}

/**
 * The board in one shape, from either source.
 * @param {any} answer `GET /api/tasks`'s JSON
 */
export function normalizeBoard(answer) {
  const source = answer?.source === 'local' ? 'local' : 'cloud';
  const runs = toRuns(answer?.board ?? {});
  const board = answer?.board ?? {};
  const local = Array.isArray(board.needs_you) || Array.isArray(board.done);
  const machine = local ? 'this machine' : '';
  const rows = local
    ? ['needs_you', 'in_progress', 'not_started', 'left_open', 'done'].flatMap((k) => board[k] ?? [])
    : (board.tasks ?? []);
  const unsplit = (local ? board.not_split : board.unsplit) ?? [];
  return {
    source,
    note: typeof answer?.note === 'string' ? answer.note : '',
    now: seconds(local ? board.generated_at : board.now) || Math.floor(Date.now() / 1000),
    tasks: /** @type {Task[]} */ (rows.map((/** @type {any} */ r) => toTask(r, machine))),
    unsplit: unsplit.map((/** @type {any} */ m) => ({
      key: `${m.machine || machine}:${m.id}`,
      id: String(m.id ?? ''),
      machine: String(m.machine || machine),
      harness: String(m.harness ?? ''),
      project: String(m.project ?? ''),
      projectName: projectName(m.project),
      text: String(m.text ?? ''),
      said: seconds(m.said_at),
    })),
    folders: /** @type {Folder[]} */ ((board.folders ?? []).map((/** @type {any} */ f) => ({
      project: String(f.project ?? '').toLowerCase(),
      key: String(f.key ?? f.name ?? '').toLowerCase(),
      name: String(f.name ?? f.key ?? ''),
      about: String(f.about ?? ''),
      memories: Number(f.memories) || 0,
      updated: seconds(f.updated_at),
    }))),
    limits: /** @type {Limit[]} */ ((board.limits ?? []).map((/** @type {any} */ l) => toLimit(l, machine))),
    nodes: toNodes(board.nodes, seconds(board.now) || Math.floor(Date.now() / 1000)),
    requests: /** @type {Request[]} */ ((board.requests ?? []).map((/** @type {any} */ r) => ({
      id: `R${r.id}`,
      // The request this one follows up on, so a thread reads as one conversation.
      follows: r.follows ? `R${r.follows}` : '',
      text: String(r.text ?? ''),
      project: String(r.project ?? ''),
      folder: String(r.folder ?? ''),
      status: String(r.status ?? 'queued'),
      outcome: String(r.outcome ?? ''),
      created: seconds(r.created_at),
      updated: seconds(r.updated_at),
      // Its tasks' runs, task by task, numbered across the request.
      steps: runs
        .filter((run) => run.request === `R${r.id}`)
        .sort((a, b) => a.task - b.task)
        .flatMap((run) => run.steps.map((step) => ({ ...step, task: run.task })))
        .map((step, i) => ({ ...step, n: i + 1 })),
    }))),
    runs,
    // What the owner said to each agent from a dashboard, and how each got there.
    messages: list(board.run_messages).map((/** @type {any} */ m) => ({
      id: Number(m.id) || 0,
      machine: String(m.machine ?? ''),
      run: String(m.run ?? ''),
      text: String(m.text ?? ''),
      status: String(m.status ?? 'queued'),
      detail: String(m.detail ?? ''),
      task: Number(m.task) || 0,
      created_at: seconds(m.created_at),
    })),
    rules: (board.rules ?? []).map((/** @type {any} */ r) => /** @type {Rule} */ ({
      key: `${r.machine || machine}:${r.id}`,
      id: String(r.id ?? ''),
      // The machine whose ledger has it, so it can be turned off there (none on a local board).
      machine: String(r.machine ?? ''),
      text: String(r.text ?? ''),
      quote: String(r.quote ?? ''),
      project: String(r.project ?? ''),
      projectName: projectName(r.project),
      paths: rulePaths(r.paths),
      shown: Number(r.shown) || 0,
    })),
  };
}

/** A rule's file globs: the cloud keeps them as JSON text, a local board as a list. @param {unknown} paths */
function rulePaths(paths) {
  let list = paths;
  if (typeof paths === 'string') {
    try {
      list = JSON.parse(paths);
    } catch {
      list = paths ? [paths] : [];
    }
  }
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

/**
 * Where a standing rule applies and when an agent is given it, in one line (hive-tasks' hooks and
 * the cloud orchestrator's briefs): "hive · whole project · every agent session here, at its start
 * and after it compacts, and every cloud task" or "hive · web/*.svelte · when an agent first
 * edits one of these files in a session, and every cloud task · shown 3 times".
 * Under its project's heading (the rules page) the project is left out: it's said once, above.
 * @param {{projectName: string, paths: string[], shown: number}} rule
 * @param {{project?: boolean}} [options]
 */
export function ruleScope(rule, { project = true } = {}) {
  const where = rule.paths.length ? rule.paths.join(', ') : 'whole project';
  const when = rule.paths.length
    ? 'when an agent first edits one of these files in a session, and in every cloud task'
    : 'every agent session here, at its start and after it compacts, and every cloud task';
  const shown = rule.shown ? (rule.shown === 1 ? 'shown once' : `shown ${rule.shown} times`) : '';
  return [project ? rule.projectName : '', where, when, shown].filter(Boolean).join(' · ');
}

/**
 * The standing rules under their projects (T309): projects by name, a rule with no project last,
 * each project's rules in the order they were made.
 * @param {Rule[]} rules
 * @returns {{key: string, name: string, rules: Rule[]}[]}
 */
export function rulesByProject(rules) {
  /** @type {Map<string, {key: string, name: string, rules: Rule[]}>} */
  const groups = new Map();
  for (const rule of rules) {
    let group = groups.get(rule.project);
    if (!group) {
      group = { key: rule.project, name: rule.projectName || 'No project', rules: [] };
      groups.set(rule.project, group);
    }
    group.rules.push(rule);
  }
  return [...groups.values()].sort(
    (a, b) => Number(!a.key) - Number(!b.key) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
  );
}

/**
 * Every node's runs with their steps: still working first, then the latest.
 * @param {any} board
 * @returns {Run[]}
 */
function toRuns(board) {
  /** @type {Map<string, Step[]>} */
  const steps = new Map();
  for (const s of list(board.run_steps)) {
    const key = `${s.machine}:${s.run}`;
    if (!steps.has(key)) steps.set(key, []);
    steps.get(key)?.push({
      n: Number(s.n) || 0,
      task: 0,
      at: seconds(s.at),
      kind: String(s.kind ?? ''),
      text: String(s.text ?? ''),
    });
  }
  return list(board.runs)
    .map((/** @type {any} */ r) => {
      const machine = String(r.machine ?? '');
      const key = `${machine}:${r.run}`;
      const run = String(r.run ?? '');
      const agent = String(r.agent ?? '');
      const coding = CODING_HARNESSES.includes(agent) && run.startsWith(`${agent}:`);
      const name = projectName(r.project);
      const own = (steps.get(key) ?? []).sort((x, y) => x.n - y.n);
      // A session first seen mid-turn has no title yet: the last thing the owner asked it, if shown.
      const asked = own.filter((step) => step.kind === 'asked').at(-1)?.text ?? '';
      return {
        key,
        machine,
        run,
        agent,
        node: nodeName(machine),
        label: coding
          ? [HARNESSES[/** @type {keyof typeof HARNESSES} */ (agent)], name].filter(Boolean).join(' · ')
          : nodeName(machine),
        title: String(r.title || asked),
        project: String(r.project ?? ''),
        projectName: name,
        harness: coding ? agent : '',
        session: coding ? run.slice(agent.length + 1) : '',
        status: String(r.status ?? 'working'),
        request: r.request ? `R${r.request}` : '',
        task: Number(r.task) || 0,
        started: seconds(r.started_at),
        updated: seconds(r.updated_at),
        steps: own,
      };
    })
    .sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || b.updated - a.updated);
}

/**
 * Which project a task is in, by name: the repository, its folder on the Mac and the same name
 * spelled another way are one project ("github.com/agenticaiuw/hive", "/Users/x/hive", "Hive").
 * @param {{projectName: string}} task
 */
export function projectKey(task) {
  return task.projectName.toLowerCase();
}

/**
 * Whether a task matches the chosen project and folder and the search words.
 * @param {Task} task
 * @param {{project?: string, folder?: string, query?: string}} filter
 */
export function matches(task, { project = '', folder = '', query = '' } = {}) {
  if (project && projectKey(task) !== project) return false;
  if (folder && task.folder.toLowerCase() !== folder) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${task.title} ${task.quote} ${task.outcome} ${task.id} ${task.folder}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The board's sections with their tasks, newest first; "Done" keeps the last `doneLimit`.
 * @param {Task[]} tasks
 * @param {{project?: string, folder?: string, query?: string, doneLimit?: number}} [filter]
 */
export function sections(tasks, filter = {}) {
  const shown = tasks.filter((t) => matches(t, filter)).sort((a, b) => b.updated - a.updated);
  return SECTIONS.map((s) => {
    // Within a list, its first status first (a question before a stuck task), each newest first.
    const all = shown
      .filter(s.has)
      .sort((a, b) => s.statuses.indexOf(a.status) - s.statuses.indexOf(b.status));
    const limit = s.id === 'done' ? (filter.doneLimit ?? 30) : all.length;
    return { ...s, tasks: all.slice(0, limit), total: all.length };
  });
}

/**
 * Groups by a key, counting each group's unfinished tasks; the most unfinished first.
 * @param {Task[]} tasks
 * @param {(t: Task) => string} keyOf
 * @param {(t: Task) => string} nameOf
 */
function groups(tasks, keyOf, nameOf) {
  /** @type {Map<string, {key: string, name: string, open: number, all: number, names: Map<string, number>}>} */
  const by = new Map();
  for (const t of tasks) {
    const key = keyOf(t);
    if (!key) continue;
    const g = by.get(key) ?? { key, name: '', open: 0, all: 0, names: new Map() };
    g.all += 1;
    if (!['done', 'dropped'].includes(t.status)) g.open += 1;
    g.names.set(nameOf(t), (g.names.get(nameOf(t)) ?? 0) + 1);
    by.set(key, g);
  }
  return [...by.values()]
    .map(({ names, ...g }) => ({ ...g, name: [...names].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.open - a.open || b.all - a.all || a.name.localeCompare(b.name));
}

/**
 * The projects, by name (see projectKey): those with tasks, the most unfinished first, then those
 * that only have folders so far.
 * @param {Task[]} tasks
 * @param {Folder[]} [folders]
 */
export function projects(tasks, folders = []) {
  const list = groups(tasks, projectKey, (t) => t.projectName);
  for (const f of folders) {
    if (f.project && !list.some((p) => p.key === f.project)) {
      list.push({ key: f.project, name: f.project, open: 0, all: 0 });
    }
  }
  return list;
}

/**
 * A project's folders (or every project's): the ones the board keeps and the ones tasks name,
 * with their unfinished and total tasks and memories, the busiest first.
 * @param {Task[]} tasks
 * @param {Folder[]} folders
 * @param {string} [project] a projectKey
 */
export function folderList(tasks, folders, project = '') {
  const inProject = tasks.filter((t) => t.folder && (!project || projectKey(t) === project));
  const counted = groups(inProject, (t) => `${projectKey(t)}\u0000${t.folder.toLowerCase()}`, (t) => t.folder);
  /** @type {Map<string, Folder & {open: number, all: number}>} */
  const by = new Map();
  for (const f of folders) {
    if (project && f.project !== project) continue;
    by.set(`${f.project}\u0000${f.key}`, { ...f, open: 0, all: 0 });
  }
  for (const g of counted) {
    const [p, key] = g.key.split('\u0000');
    const known = by.get(g.key);
    by.set(g.key, known
      ? { ...known, open: g.open, all: g.all }
      : { project: p, key, name: g.name, about: '', memories: 0, updated: 0, open: g.open, all: g.all });
  }
  return [...by.values()].sort(
    (a, b) => b.open - a.open || b.all - a.all || a.name.localeCompare(b.name),
  );
}

/**
 * Tasks in runs by folder, in the order given, so similar work sits together: each folder's
 * tasks where its first one was, the ones in no folder last.
 * @param {Task[]} tasks
 */
export function byFolder(tasks) {
  /** @type {Map<string, {folder: string, tasks: Task[]}>} */
  const runs = new Map();
  for (const t of tasks) {
    const key = t.folder.toLowerCase();
    const run = runs.get(key) ?? { folder: t.folder, tasks: [] };
    run.tasks.push(t);
    runs.set(key, run);
  }
  const none = runs.get('');
  runs.delete('');
  return [...runs.values(), ...(none ? [none] : [])];
}

/**
 * A folder and its memories from `GET /api/folder`, from the cloud board or a machine's ledger
 * (`hive-tasks folder … --json`), in one shape.
 * @param {any} answer
 */
export function normalizeFolder(answer) {
  const f = answer?.folder ?? answer ?? {};
  return {
    project: String(f.project ?? ''),
    key: String(f.key ?? f.name ?? '').toLowerCase(),
    name: String(f.name ?? f.key ?? ''),
    about: String(f.about ?? ''),
    memories: (answer?.memories ?? []).map((/** @type {any} */ m) => ({
      key: `${m.machine ?? m.from ?? 'here'}:${m.id}`,
      kind: String(m.kind ?? 'note'),
      title: String(m.title ?? ''),
      body: String(m.body ?? ''),
      task: String(m.task ?? ''),
      from: String(m.machine ?? m.from ?? ''),
      created: seconds(m.created_at),
    })),
  };
}

/**
 * Which agents are at work: each session with a task under way (or one given it lately), and each
 * Claude Code or Codex session in the middle of a turn whether or not it has a task of its own (a
 * side session working on its parent's task, say), from its live run. Each carries its run, if it
 * streams one, so the owner can open what it's doing.
 * @param {Task[]} tasks
 * @param {number} now
 * @param {number} [recent]
 * @param {Run[]} [runs]
 */
export function agentsAtWork(tasks, now, recent = 20 * 60, runs = []) {
  /** @typedef {{key: string, harness: string, machine: string, projectName: string, session: string,
   *   on: Task[], open: Task[], last: number, run: Run | null}} Agent */
  /** @type {Map<string, Agent>} */
  const by = new Map();
  for (const t of tasks) {
    if (!t.session) continue;
    const key = `${t.machine}:${t.harness}:${t.session}`;
    const a = by.get(key) ?? {
      key, harness: t.harness, machine: t.machine, projectName: t.projectName, session: t.session,
      on: [], open: [], last: 0, run: null,
    };
    if (t.status === 'active') a.on.push(t);
    if (t.status === 'open') a.open.push(t);
    a.last = Math.max(a.last, t.updated, t.created);
    by.set(key, a);
  }
  for (const r of runs) {
    if (!r.session) continue;
    const key = `${r.machine}:${r.harness}:${r.session}`;
    const a = by.get(key) ?? {
      key, harness: r.harness, machine: r.machine, projectName: r.projectName, session: r.session,
      on: [], open: [], last: 0, run: null,
    };
    a.run = r;
    if (!a.projectName) a.projectName = r.projectName;
    if (r.status === 'working') a.last = Math.max(a.last, r.updated);
    by.set(key, a);
  }
  return [...by.values()]
    .filter((a) =>
      a.on.length
      || (a.open.length && now - a.last <= recent)
      || (a.run?.status === 'working' && now - a.run.updated <= recent))
    .sort((a, b) => b.last - a.last);
}

/**
 * "14 min", "1 h 5 min", "40 s".
 * @param {number|null} secs
 */
export function duration(secs) {
  if (secs == null) return '';
  if (secs < 60) return `${Math.round(secs)} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

/**
 * "850", "18k", "1.2M".
 * @param {number|null} n
 */
export function tokenCount(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/**
 * What a task cost, for its card: "took 14 min (est. 10 min) · 1.2M tokens, 18k written".
 * @param {Task} task
 */
export function cost(task) {
  const bits = [];
  if (task.workSeconds != null) {
    bits.push(`took ${duration(task.workSeconds)}${task.minutes ? ` (est. ${duration(task.minutes * 60)})` : ''}`);
  } else if (task.minutes) {
    bits.push(`est. ${duration(task.minutes * 60)}`);
  }
  if (task.tokensIn != null || task.tokensOut != null) {
    bits.push(`${tokenCount((task.tokensIn ?? 0) + (task.tokensOut ?? 0))} tokens, ${tokenCount(task.tokensOut ?? 0)} written`);
  }
  return bits.join(' · ');
}

/**
 * How done tasks' real time compares with their estimates: actual ÷ estimate over the last 30
 * with both, or null with fewer than 5.
 * @param {Task[]} tasks
 */
export function estimates(tasks) {
  const done = tasks
    .filter((t) => t.status === 'done' && t.workSeconds && t.minutes)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 30);
  if (done.length < 5) return null;
  const actual = done.reduce((s, t) => s + (t.workSeconds ?? 0), 0);
  const estimate = done.reduce((s, t) => s + (t.minutes ?? 0) * 60, 0);
  return { count: done.length, ratio: actual / estimate };
}

/**
 * A plan as its maker sells it, not as its sign-in token spells it: ChatGPT's token says "prolite"
 * for the plan OpenAI sells as Pro 10x. Claude's plans come already named ("Max 5x").
 * @type {Record<string, string>}
 */
const PLAN_NAMES = {
  free: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 10x', pro: 'Pro', team: 'Team', business: 'Business',
  enterprise: 'Enterprise', edu: 'Edu',
};

/** @param {string | null | undefined} plan */
export function planName(plan) {
  if (!plan) return '';
  return PLAN_NAMES[plan.toLowerCase()] ?? plan;
}

/**
 * Each subscription's windows for the side panel: "Codex · Pro 10x · studio-mac", then "Week 15%,
 * resets in 4 days" per window. A window whose reset has passed since the harness last wrote it
 * starts over, so it shows 0% and `fresh` (nothing used since, as far as anyone has seen).
 * @param {Limit[]} limits
 * @param {number} now
 */
export function planLimits(limits, now) {
  // One subscription seen from two places (the Mac's Codex and Hive's on the VM, signed in to the
  // same plan) has the same windows resetting at the same moments: show only the latest reading.
  /** @type {Map<string, Limit>} */
  const latest = new Map();
  for (const l of limits.filter((l) => l.windows.length)) {
    const resets = l.windows.map((w) => w.resetsAt).filter(Boolean).sort().join(',');
    const id = resets ? `${l.harness}:${l.plan}:${resets}` : l.key;
    const seen = latest.get(id);
    if (!seen || (l.at ?? 0) > (seen.at ?? 0)) latest.set(id, l);
  }
  return [...latest.values()]
    .map((l) => ({
      key: l.key,
      who: [HARNESSES[/** @type {keyof typeof HARNESSES} */ (l.harness)] ?? l.harness, planName(l.plan), l.machine]
        .filter(Boolean)
        .join(' · '),
      home: l.home,
      windows: l.windows.map((w) => {
        const fresh = w.resetsAt > 0 && w.resetsAt <= now;
        return {
          label: windowName(w.minutes),
          used: fresh ? 0 : w.used,
          fresh,
          resets: fresh || !w.resetsAt ? '' : `resets in ${until(w.resetsAt, now)}`,
        };
      }),
    }));
}

/**
 * A usage window by its length: "5 h", "Week", "Day".
 * @param {number} minutes
 */
function windowName(minutes) {
  if (minutes === 10080) return 'Week';
  if (minutes === 1440) return 'Day';
  if (minutes >= 40320 && minutes <= 44640) return 'Month'; // 28 to 31 days
  if (minutes > 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  return duration(minutes * 60);
}

/**
 * "12 min", "3 h", "4 days" from now to `then`.
 * @param {number} then
 * @param {number} now
 */
function until(then, now) {
  const s = Math.max(0, then - now);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const days = Math.round(s / 86400);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * "just now", "12 min ago", "3 h ago", "2 days ago".
 * @param {number} then
 * @param {number} now
 */
export function ago(then, now) {
  if (!then) return '';
  const s = Math.max(0, now - then);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Which agent, machine and project a task came from: "Claude Code · studio-mac · hive".
 * @param {{harness: string, machine: string, projectName: string}} task
 */
export function where(task) {
  return [HARNESSES[/** @type {keyof typeof HARNESSES} */ (task.harness)] ?? task.harness, task.machine, task.projectName]
    .filter(Boolean)
    .join(' · ');
}

/** What the owner sees for each status. */
export const STATUS_WORDS = {
  open: 'Not started',
  active: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  done: 'Done',
  dropped: 'Dropped',
};
