// Hive's one database, on the VM: what was asked, the tasks and rules it became, every agent's
// chat, the nodes and their tools, and the owner's personal info. Rules, no memories.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, at INTEGER, node TEXT, text TEXT, context TEXT,
  status TEXT DEFAULT 'new', reply TEXT);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, request_id INTEGER, project TEXT DEFAULT '', title TEXT,
  quote TEXT, nodes TEXT DEFAULT '[]', level TEXT DEFAULT 'normal', status TEXT DEFAULT 'open', agent_id INTEGER,
  outcome TEXT, why TEXT, need TEXT, at INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, text TEXT, quote TEXT, scope TEXT DEFAULT '', code TEXT,
  at INTEGER, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY, task_id INTEGER, kind TEXT DEFAULT 'codex', name TEXT,
  thread TEXT, status TEXT DEFAULT 'working', at INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, at INTEGER, agent_id INTEGER, task_id INTEGER,
  request_id INTEGER, who TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, tools TEXT DEFAULT '[]', seen INTEGER,
  version TEXT);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, node TEXT, tool TEXT, args TEXT, status TEXT DEFAULT 'queued',
  result TEXT, agent_id INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, node TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, name TEXT, size INTEGER, node TEXT, at INTEGER);
`;

export function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return {
    raw: db,
    all: (sql, ...args) => db.prepare(sql).all(...args),
    get: (sql, ...args) => db.prepare(sql).get(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    insert(table, row) {
      const keys = Object.keys(row);
      const values = keys.map(k => (row[k] !== null && typeof row[k] === 'object') ? JSON.stringify(row[k]) : row[k]);
      return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...values).lastInsertRowid);
    },
    update(table, id, row) {
      const keys = Object.keys(row);
      if (!keys.length) return;
      const values = keys.map(k => (row[k] !== null && typeof row[k] === 'object') ? JSON.stringify(row[k]) : row[k]);
      db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...values, id);
    },
    tables: () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name),
    close: () => db.close(),
  };
}

/** Rules that apply where an agent works: everywhere, or its folder, app or site. */
export function rulesFor(db, { nodes = [], site = '', app = '', folder = '' } = {}) {
  return db.all('SELECT * FROM rules WHERE active=1 ORDER BY id').filter(rule => {
    const [kind, value = ''] = (rule.scope || '').split(/:(.*)/s);
    if (!rule.scope) return true;
    if (kind === 'node') return nodes.includes(value);
    if (kind === 'site') return Boolean(site) && (site === value || site.endsWith(`.${value}`) || site.startsWith(value));
    if (kind === 'app') return Boolean(app) && app.toLowerCase() === value.toLowerCase();
    if (kind === 'folder') return Boolean(folder) && folder.startsWith(value);
    return false;
  });
}
