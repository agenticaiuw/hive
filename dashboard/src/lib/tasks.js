/**
 * The owner's tasks, in one shape wherever the dashboard runs.
 *
 * Every agent the owner talks to (Claude Code, Codex, Hive, on the Mac or Hive's VM) saves each
 * message and the tasks in it to a ledger on its machine, and every ledger syncs to the cloud
 * board (cloud/tasks). `GET /api/tasks` answers `{source, note?, board}` on every host:
 *
 *   - `source: "cloud"`: `board` is the cloud board, every machine:
 *     `{now, tasks: [row], unsplit: [message], rules: [rule]}`, a row carrying its `machine`;
 *   - `source: "local"`: the cloud couldn't be reached and `board` is this machine's ledger
 *     (`hive-tasks board --all --json`): `{generated_at, needs_you, in_progress, not_started,
 *     left_open, done, not_split, rules}`, with `note` saying why.
 *
 * Plain JavaScript so `node --test` can load it without a build.
 */

/** @typedef {{key: string, id: string, machine: string, message: string, quote: string,
 *   title: string, status: string, minutes: number|null, value: string, outcome: string,
 *   evidence: string, harness: string, session: string, project: string, projectName: string,
 *   part: string, workSeconds: number|null, tokensIn: number|null, tokensOut: number|null,
 *   created: number, updated: number}} Task */

export const HARNESSES = { claude: 'Claude Code', codex: 'Codex', hive: 'Hive' };

/** The sections of the board, in the order they're shown. */
export const SECTIONS = [
  { id: 'needs-you', title: 'Needs you', statuses: ['waiting', 'blocked'] },
  { id: 'working', title: 'Working on it', statuses: ['active'] },
  { id: 'not-started', title: 'Not started', statuses: ['open'] },
  { id: 'done', title: 'Done', statuses: ['done', 'dropped'] },
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
    projectName: projectName(row.project),
    part: text('part').trim(),
    workSeconds: number(row.work_seconds),
    tokensIn: number(row.tokens_in),
    tokensOut: number(row.tokens_out),
    created: seconds(row.created_at ?? row.said_at),
    updated: seconds(row.updated_at ?? row.done_at ?? row.created_at ?? row.said_at),
  };
}

/**
 * The board in one shape, from either source.
 * @param {any} answer `GET /api/tasks`'s JSON
 */
export function normalizeBoard(answer) {
  const source = answer?.source === 'local' ? 'local' : 'cloud';
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
    rules: (board.rules ?? []).map((/** @type {any} */ r) => ({
      key: `${r.machine || machine}:${r.id}`,
      id: String(r.id ?? ''),
      text: String(r.text ?? ''),
      quote: String(r.quote ?? ''),
      project: String(r.project ?? ''),
      projectName: projectName(r.project),
    })),
  };
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
 * Whether a task matches the chosen project and part and the search words.
 * @param {Task} task
 * @param {{project?: string, part?: string, query?: string}} filter
 */
export function matches(task, { project = '', part = '', query = '' } = {}) {
  if (project && projectKey(task) !== project) return false;
  if (part && task.part.toLowerCase() !== part) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${task.title} ${task.quote} ${task.outcome} ${task.id} ${task.part}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The board's sections with their tasks, newest first; "Done" keeps the last `doneLimit`.
 * @param {Task[]} tasks
 * @param {{project?: string, part?: string, query?: string, doneLimit?: number}} [filter]
 */
export function sections(tasks, filter = {}) {
  const shown = tasks.filter((t) => matches(t, filter)).sort((a, b) => b.updated - a.updated);
  return SECTIONS.map((s) => {
    const all = shown.filter((t) => s.statuses.includes(t.status));
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
 * The projects with tasks by name (see projectKey), the ones with the most unfinished first.
 * @param {Task[]} tasks
 */
export function projects(tasks) {
  return groups(tasks, projectKey, (t) => t.projectName);
}

/**
 * The parts of a project (or every project) that tasks name, the busiest first: "memory
 * retrieval", "major requirements validation".
 * @param {Task[]} tasks
 * @param {string} [project] a projectKey
 */
export function parts(tasks, project = '') {
  return groups(
    tasks.filter((t) => !project || projectKey(t) === project),
    (t) => t.part.toLowerCase(),
    (t) => t.part,
  );
}

/**
 * Tasks in runs by part, in the order given, so similar work sits together: each part's tasks
 * where its first one was, the ones with no part last.
 * @param {Task[]} tasks
 */
export function byPart(tasks) {
  /** @type {Map<string, {part: string, tasks: Task[]}>} */
  const runs = new Map();
  for (const t of tasks) {
    const key = t.part.toLowerCase();
    const run = runs.get(key) ?? { part: t.part, tasks: [] };
    run.tasks.push(t);
    runs.set(key, run);
  }
  const none = runs.get('');
  runs.delete('');
  return [...runs.values(), ...(none ? [none] : [])];
}

/**
 * The agents at work and what each is on: every session with a task marked active, or that the
 * owner wrote to or that reported in the last `recent` seconds with tasks still open.
 * @param {Task[]} tasks
 * @param {number} now
 * @param {number} [recent]
 */
export function agentsAtWork(tasks, now, recent = 20 * 60) {
  /** @type {Map<string, {key: string, harness: string, machine: string, projectName: string,
   *   session: string, on: Task[], open: Task[], last: number}>} */
  const by = new Map();
  for (const t of tasks) {
    if (!t.session) continue;
    const key = `${t.machine}:${t.harness}:${t.session}`;
    const a = by.get(key) ?? {
      key, harness: t.harness, machine: t.machine, projectName: t.projectName, session: t.session,
      on: [], open: [], last: 0,
    };
    if (t.status === 'active') a.on.push(t);
    if (t.status === 'open') a.open.push(t);
    a.last = Math.max(a.last, t.updated, t.created);
    by.set(key, a);
  }
  return [...by.values()]
    .filter((a) => a.on.length || (a.open.length && now - a.last <= recent))
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
 * Which agent, machine and project a task came from: "Claude Code · evans-mbp · hive".
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
