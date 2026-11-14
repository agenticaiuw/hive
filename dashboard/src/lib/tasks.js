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
 * Whether a task matches the chosen project and the search words.
 * @param {Task} task
 * @param {{project?: string, query?: string}} filter
 */
export function matches(task, { project = '', query = '' } = {}) {
  if (project && task.project !== project) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${task.title} ${task.quote} ${task.outcome} ${task.id}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The board's sections with their tasks, newest first; "Done" keeps the last `doneLimit`.
 * @param {Task[]} tasks
 * @param {{project?: string, query?: string, doneLimit?: number}} [filter]
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
 * The projects with tasks, the ones with the most unfinished first.
 * @param {Task[]} tasks
 */
export function projects(tasks) {
  /** @type {Map<string, {project: string, name: string, open: number, all: number}>} */
  const by = new Map();
  for (const t of tasks) {
    if (!t.project) continue;
    const p = by.get(t.project) ?? { project: t.project, name: t.projectName, open: 0, all: 0 };
    p.all += 1;
    if (!['done', 'dropped'].includes(t.status)) p.open += 1;
    by.set(t.project, p);
  }
  return [...by.values()].sort((a, b) => b.open - a.open || b.all - a.all || a.name.localeCompare(b.name));
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
