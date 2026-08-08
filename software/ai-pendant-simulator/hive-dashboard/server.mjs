#!/usr/bin/env node
// Hive — live observability dashboard aggregator for the AI pendant hive mind.
// Node 18+ builtins only. Localhost only. Secrets stay server-side.
//
// Sources:
//   1. Mac local agent      http://127.0.0.1:8000        (Bearer AGENT_TOKEN)
//   2. Cloud relay          $RELAY_URL (workers.dev)     (Bearer RELAY_API_KEY)
//   3. Design committee     diagnostics/harness-derivation/*.json[l] (read-only, stat-gated)
//
// Honesty rules: a failed source renders as failed with the real error.
// No sample data, no invented numbers, no placeholder values.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { stat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = '/Users/you/agentic-gadget';
const ENV_PATH = path.join(REPO_ROOT, '.env');
const DIAG_DIR = path.join(REPO_ROOT, 'diagnostics', 'harness-derivation');
const INDEX_PATH = path.join(__dirname, 'index.html');
const PORTS = [8010, 8011, 8012, 8013, 8014, 8015, 8016, 8017, 8018, 8019, 8020];
const STARTED_AT = Date.now();

// ---------------------------------------------------------------- env / secrets

function parseEnvFile(p) {
  const out = {};
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch (e) {
    console.error(`[hive] cannot read ${p}: ${e.message}`);
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const ENV = parseEnvFile(ENV_PATH);
const AGENT_TOKEN = ENV.AGENT_TOKEN || '';
const RELAY_API_KEY = ENV.RELAY_API_KEY || '';
const RELAY_BASE = (ENV.RELAY_URL || 'https://ai-pendant-relay.your-subdomain.workers.dev').replace(/\/+$/, '');
const AGENT_BASE = 'http://127.0.0.1:8000';

// Every value from .env is treated as a secret and scrubbed from every outbound byte.
const SECRET_VALUES = Object.values(ENV).filter((v) => typeof v === 'string' && v.length >= 8);
function scrub(str) {
  let s = str;
  for (const v of SECRET_VALUES) s = s.split(v).join('«masked»');
  return s;
}

// ---------------------------------------------------------------- small helpers

const now = () => Date.now();
function trunc(v, n) {
  if (v == null) return v;
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function tsMs(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : (fallback ?? now());
}
function errStr(e) {
  if (!e) return 'unknown error';
  const s = e instanceof Error ? (e.cause ? `${e.message} (${e.cause.code || e.cause.message || e.cause})` : e.message) : String(e);
  return trunc(scrub(s), 300);
}

async function fetchJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const t0 = now();
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${errStr(e)}`, ms: now() - t0 };
  }
  const ms = now() - t0;
  let body = '';
  try { body = await res.text(); } catch (e) {
    return { ok: false, status: res.status, error: `body read failed: ${errStr(e)}`, ms };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${trunc(scrub(body), 180) || res.statusText}`, ms };
  }
  try {
    return { ok: true, status: res.status, json: JSON.parse(body), ms };
  } catch {
    return { ok: false, status: res.status, parseError: true, error: `unparseable JSON (${body.length}B): ${trunc(scrub(body), 120)}`, ms };
  }
}

function agentGet(p, timeoutMs = 8000) {
  if (!AGENT_TOKEN) return Promise.resolve({ ok: false, error: 'AGENT_TOKEN missing from .env' });
  return fetchJson(AGENT_BASE + p, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` }, timeoutMs });
}
function relayGet(p, timeoutMs = 10000) {
  if (!RELAY_API_KEY) return Promise.resolve({ ok: false, error: 'RELAY_API_KEY missing from .env' });
  return fetchJson(RELAY_BASE + p, { headers: { Authorization: `Bearer ${RELAY_API_KEY}` }, timeoutMs });
}

// Tail a file efficiently: read only the final maxBytes, return whole lines.
async function tailFileLines(filePath, maxBytes) {
  const st = await stat(filePath);
  const fh = await open(filePath, 'r');
  try {
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { lines: text.split('\n').filter((l) => l.trim().length > 0), size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- event ticker

const events = []; // {seq, at(ms), source, kind, text}
let eventSeq = 0;
const seenKeys = new Map(); // dedup, insertion-ordered, bounded
const seededFeeds = new Set();

function markSeen(k) {
  if (seenKeys.has(k)) return false;
  seenKeys.set(k, 1);
  if (seenKeys.size > 6000) {
    let i = 0;
    for (const key of seenKeys.keys()) { seenKeys.delete(key); if (++i >= 1000) break; }
  }
  return true;
}
function pushEvent(ev) {
  events.push({ seq: ++eventSeq, at: ev.at, source: ev.source, kind: ev.kind, text: trunc(ev.text, 220) });
  if (events.length > 400) events.splice(0, events.length - 400);
}
// itemsNewestFirst: newest first. map(item) -> {key, at(ms), source, kind, text} | null
function feedEvents(feed, itemsNewestFirst, map, seedCount = 10) {
  const firstRun = !seededFeeds.has(feed);
  seededFeeds.add(feed);
  const fresh = [];
  for (let i = itemsNewestFirst.length - 1; i >= 0; i--) { // oldest first
    let m;
    try { m = map(itemsNewestFirst[i]); } catch { m = null; }
    if (!m || m.key == null) continue;
    if (!markSeen(`${feed}|${m.key}`)) continue;
    fresh.push(m);
  }
  const emit = firstRun ? fresh.slice(-seedCount) : fresh;
  for (const m of emit) pushEvent(m);
  return fresh.length;
}

// ---------------------------------------------------------------- activity map

const nodeActivity = { pendant: 0, relay: 0, mac: 0, extension: 0, ios: 0, committee: 0 };
const edgeActivity = { 'pendant-relay': 0, 'mac-relay': 0, 'ext-mac': 0, 'ios-relay': 0 };
function touchNode(id, t) { if (t > (nodeActivity[id] || 0)) nodeActivity[id] = t; }
function touchEdge(id, t) { if (t > (edgeActivity[id] || 0)) edgeActivity[id] = t; }

// ---------------------------------------------------------------- strippers

function stripJob(j) {
  return {
    jobId: j.jobId, type: j.type, status: j.status, source: j.source, sessionId: j.sessionId,
    command: trunc(j.command, 160), createdAt: j.createdAt, updatedAt: j.updatedAt,
    error: j.error ? trunc(typeof j.error === 'string' ? j.error : JSON.stringify(j.error), 200) : null,
    actionCount: Array.isArray(j.result?.results) ? j.result.results.length : null,
  };
}
function stripJournalAction(a) {
  return {
    seq: a.seq, type: a.type, label: trunc(a.label, 90), effect: a.effect, ok: a.ok, status: a.status,
    durationMs: a.durationMs, startedAt: a.startedAt, finishedAt: a.finishedAt,
    message: trunc(a.outcome?.message, 150), error: a.outcome?.error ? trunc(a.outcome.error, 150) : null,
    reversible: a.reversible, handsFree: a.handsFree, receiptId: a.receiptId,
  };
}
function stripJournalEntry(e) {
  return {
    jobId: e.jobId, type: e.type, status: e.status, source: e.source, running: e.running,
    command: trunc(e.command, 160), startedAt: e.startedAt, finishedAt: e.finishedAt,
    durationMs: e.durationMs, actionTimeMs: e.actionTimeMs,
    error: e.error ? trunc(typeof e.error === 'string' ? e.error : JSON.stringify(e.error), 200) : null,
    tier: e.plannedBy?.tier ?? null, plannerSource: e.plannedBy?.source ?? null,
    counts: e.counts ?? null,
    focus: e.focus ? { before: e.focus.foregroundBefore, after: e.focus.foregroundAfter, changed: e.focus.changed } : null,
    actions: Array.isArray(e.actions) ? e.actions.slice(0, 14).map(stripJournalAction) : [],
  };
}
function stripPipelineEvent(ev) {
  return { eventId: ev.eventId, stage: ev.stage, status: ev.status, label: trunc(ev.label, 100), source: ev.source, at: ev.at };
}
function stripPipelineRun(r) {
  const evs = Array.isArray(r.events) ? r.events : [];
  return {
    pipelineId: r.pipelineId, kind: r.kind, status: r.status, source: r.source,
    command: trunc(r.command, 160), createdAt: r.createdAt, updatedAt: r.updatedAt,
    events: evs.slice(-24).map(stripPipelineEvent),
  };
}
const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|credential|bearer|private[_-]?key|auth[_-]?key|passcode)/i;
function factLooksSecret(f) {
  const v = f.value;
  if (SECRET_KEY_RE.test(String(f.key || ''))) return true;
  if (/secret|credential/i.test(String(f.kind || ''))) return true;
  if (/^(secret|high|private)$/i.test(String(f.sensitivity || ''))) return true;
  if (typeof v === 'string') {
    if (/^(sk|pk|rk|ghp|gho|xox)[-_][A-Za-z0-9]/.test(v)) return true;
    if (/^eyJ[A-Za-z0-9_-]{8,}/.test(v)) return true;
    if (v.length >= 24 && /^[A-Za-z0-9+/_=-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true;
  }
  return false;
}
function stripFact(f) {
  const masked = factLooksSecret(f);
  return {
    id: f.id, key: trunc(f.key, 80), kind: f.kind, sensitivity: f.sensitivity,
    value: masked ? '•••••• (masked)' : trunc(typeof f.value === 'string' ? f.value : JSON.stringify(f.value), 140),
    masked, confidence: f.confidence, origin: f.source?.origin ?? null,
    updatedAt: f.updatedAt, lastUsedAt: f.lastUsedAt, useCount: f.useCount,
  };
}
function stripOpsEntry(e) {
  return {
    pipelineId: e.pipelineId, kind: e.kind, origin: e.origin, inputMode: e.inputMode, source: e.source,
    status: e.status, jobStatus: e.jobStatus, command: trunc(e.command, 140), reply: trunc(e.reply, 140),
    actionCount: e.actionCount, eventCount: e.eventCount,
    error: e.error ? trunc(typeof e.error === 'string' ? e.error : JSON.stringify(e.error), 160) : null,
    durationMs: e.durationMs, audioAvailable: e.audio?.available ?? null,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

// ---------------------------------------------------------------- source engine

// state[key] = {key,label,family,intervalMs,ok,at,ms,error,parseError,version,data,sig}
const state = {};
function setSource(key, patch) {
  const cur = state[key];
  const next = { ...cur, ...patch };
  const sig = JSON.stringify([next.ok, next.error, next.data]);
  if (cur && cur.sig === sig) {
    cur.at = next.at; cur.ms = next.ms; // freshness advances, version does not
    return cur;
  }
  next.sig = sig;
  next.version = (cur?.version || 0) + 1;
  state[key] = next;
  return next;
}

const prev = {}; // per-poller memory for change detection (timestamps etc.)

const POLLERS = [
  // ------------- Mac agent -------------
  {
    key: 'agent.health', label: 'agent /health', family: 'mac', every: 5000,
    async run() {
      const r = await fetchJson(AGENT_BASE + '/health', { timeoutMs: 4000 });
      if (!r.ok) return r;
      return { ok: true, ms: r.ms, data: { service: r.json.service, version: r.json.version, okFlag: r.json.ok } };
    },
  },
  {
    key: 'agent.snapshot', label: 'agent /ops/snapshot', family: 'mac', every: 20000,
    async run() {
      const r = await agentGet('/ops/snapshot', 15000);
      if (!r.ok) return r;
      const s = r.json?.status || {};
      const a = s.agent || {};
      const data = {
        agent: {
          service: a.service, version: a.version, fullControlMode: a.fullControlMode,
          llmPlannerEnabled: a.llmPlannerEnabled,
          computerUse: a.computerUse ? { loopEnabled: a.computerUse.loopEnabled, maxSteps: a.computerUse.maxSteps, visionModelConfigured: a.computerUse.visionModelConfigured } : null,
          dashboardAvailable: a.dashboardAvailable,
        },
        relay: s.relay ? { configured: s.relay.configured, url: s.relay.url, reachable: s.relay.reachable, error: s.relay.error ? trunc(String(s.relay.error), 200) : null } : null,
        browser: s.browser ? { online: s.browser.online, pendingCommands: s.browser.pendingCommands, spooled: s.browser.spool?.spooled ?? null } : null,
        machine: s.machine ? { hostname: s.machine.hostname, platform: s.machine.platform, appCount: s.machine.appCount, timezone: s.machine.timezone } : null,
        counts: s.counts ?? null,
        workingProject: s.workingProject ? {
          name: s.workingProject.name, path: s.workingProject.path,
          summary: trunc(s.workingProject.summary, 220), updatedAt: s.workingProject.updatedAt,
          goals: Array.isArray(s.workingProject.goals) ? s.workingProject.goals.length : null,
          openThreads: Array.isArray(s.workingProject.openThreads) ? s.workingProject.openThreads.length : null,
        } : null,
        routing: r.json?.routing ? { totalRequests: r.json.routing.totalRequests ?? null, savedRequests: r.json.routing.saved?.requests ?? null } : null,
      };
      touchNode('mac', now());
      if (data.relay?.reachable) touchEdge('mac-relay', now());
      return { ok: true, ms: r.ms, data };
    },
  },
  {
    key: 'agent.jobs', label: 'agent /jobs', family: 'mac', every: 3000,
    async run() {
      const r = await agentGet('/jobs?limit=25');
      if (!r.ok) return r;
      const jobs = (r.json?.jobs || []).map(stripJob);
      const n = feedEvents('jobs', jobs, (j) => ({
        key: `${j.jobId}:${j.status}`, at: tsMs(j.updatedAt ?? j.createdAt),
        source: 'mac', kind: 'job',
        text: `job ${j.status}: ${j.type}${j.command ? ' — ' + j.command : ''}${j.error ? ' — ' + j.error : ''}`,
      }), 8);
      if (n > 0) touchNode('mac', now());
      if (n > 0 && jobs.some((j) => String(j.type || '').startsWith('browser'))) touchEdge('ext-mac', now());
      return { ok: true, ms: r.ms, data: { jobs } };
    },
  },
  {
    key: 'agent.journal', label: 'agent /journal', family: 'mac', every: 4000,
    async run() {
      const r = await agentGet('/journal', 12000);
      if (!r.ok) return r;
      const j = r.json || {};
      const entries = (j.entries || []).map(stripJournalEntry);
      const acts = [];
      for (const e of entries) for (const a of e.actions) acts.push({ e, a });
      acts.sort((x, y) => tsMs(y.a.finishedAt ?? y.a.startedAt, 0) - tsMs(x.a.finishedAt ?? x.a.startedAt, 0));
      const n = feedEvents('journal', acts, ({ e, a }) => ({
        key: a.receiptId || `${e.jobId}:${a.seq}`, at: tsMs(a.finishedAt ?? a.startedAt),
        source: 'mac', kind: 'action',
        text: `${a.type} ${a.status}${a.durationMs != null ? ` ${a.durationMs}ms` : ''}${a.message ? ' — ' + a.message : ''}${a.error ? ' — ' + a.error : ''}`,
      }), 10);
      if (n > 0) touchNode('mac', now());
      const data = {
        generatedAt: j.generatedAt, totals: j.totals ?? null,
        window: j.window ? { jobsInStore: j.window.jobsInStore, returned: j.window.returned, newest: j.window.newest, oldest: j.window.oldest } : null,
        entries,
      };
      return { ok: true, ms: r.ms, data };
    },
  },
  {
    key: 'agent.pipeline', label: 'agent /pipeline', family: 'mac', every: 3000,
    async run() {
      const r = await agentGet('/pipeline', 12000);
      if (!r.ok) return r;
      const all = (r.json?.runs || []).slice();
      all.sort((a, b) => tsMs(b.updatedAt ?? b.createdAt, 0) - tsMs(a.updatedAt ?? a.createdAt, 0));
      const runs = all.slice(0, 15).map(stripPipelineRun);
      const flat = [];
      for (const run of runs) for (const ev of run.events) flat.push({ run, ev });
      flat.sort((x, y) => tsMs(y.ev.at, 0) - tsMs(x.ev.at, 0));
      const n = feedEvents('pipeline', flat, ({ run, ev }) => ({
        key: ev.eventId || `${run.pipelineId}:${ev.stage}:${ev.at}`, at: tsMs(ev.at),
        source: ev.source === 'cloud-relay' ? 'relay' : (/device|pendant/i.test(String(ev.source)) ? 'pendant' : 'mac'),
        kind: 'pipeline',
        text: `pipeline ${ev.stage} ${ev.status}${ev.label ? ' — ' + ev.label : ''}`,
      }), 10);
      if (n > 0) { touchNode('mac', now()); touchEdge('mac-relay', now()); }
      return { ok: true, ms: r.ms, data: { totalRuns: (r.json?.runs || []).length, runs } };
    },
  },
  {
    key: 'agent.browserStatus', label: 'agent /browser/status', family: 'mac', every: 2500,
    async run() {
      const r = await agentGet('/browser/status', 6000);
      if (!r.ok) return r;
      const b = r.json || {};
      const devices = (b.devices || []).map((d) => ({
        deviceName: d.deviceName, browserName: d.browserName, extensionVersion: d.extensionVersion,
        online: d.online, lastSeenAt: d.lastSeenAt, staleForMs: d.staleForMs, tabCount: d.tabCount,
      }));
      const newest = Math.max(0, ...devices.map((d) => tsMs(d.lastSeenAt, 0)));
      if (newest > (prev.extLastSeen || 0)) {
        prev.extLastSeen = newest;
        touchEdge('ext-mac', now());
        touchNode('extension', now());
      }
      const online = !!b.online;
      if (prev.extOnline !== undefined && prev.extOnline !== online) {
        pushEvent({ at: now(), source: 'extension', kind: 'status', text: `browser extension went ${online ? 'online' : 'offline'}` });
      }
      prev.extOnline = online;
      return { ok: true, ms: r.ms, data: { online, pendingCommands: b.pendingCommands, spool: b.spool ?? null, devices } };
    },
  },
  {
    key: 'agent.browserSpool', label: 'agent /browser/spool', family: 'mac', every: 10000,
    async run() {
      const r = await agentGet('/browser/spool');
      if (!r.ok) return r;
      const all = (r.json?.entries || []);
      const entries = all.slice(-25).reverse().map((e) => ({
        commandId: e.commandId, type: e.action?.type ?? null, reason: e.reason,
        detail: trunc(e.detail, 140), attempts: e.attempts, spooledAt: e.spooledAt,
      }));
      feedEvents('spool', entries, (e) => ({
        key: e.commandId, at: tsMs(e.spooledAt),
        source: 'extension', kind: 'spool',
        text: `spooled ${e.type || 'command'}: ${e.reason}${e.detail ? ' — ' + e.detail : ''}`,
      }), 5);
      return { ok: true, ms: r.ms, data: { total: all.length, entries } };
    },
  },
  {
    key: 'agent.browserSessions', label: 'agent /browser/sessions', family: 'mac', every: 20000,
    async run() {
      const r = await agentGet('/browser/sessions');
      if (!r.ok) return r;
      const sessions = (r.json?.sessions || []).map((s) => ({
        id: s.id, url: trunc(s.url, 120), title: trunc(s.title, 100),
        lastAction: s.lastAction, lastUsedAt: s.lastUsedAt, pinned: s.pinned,
      }));
      return { ok: true, ms: r.ms, data: { sessions } };
    },
  },
  {
    key: 'agent.routines', label: 'agent /routines', family: 'mac', every: 20000,
    async run() {
      const r = await agentGet('/routines');
      if (!r.ok) return r;
      const routines = (r.json?.routines || []).map((x) => ({
        id: x.id, name: x.name, command: trunc(x.command, 140), schedule: x.schedule,
        enabled: x.enabled, nextRunAt: x.nextRunAt, lastRunAt: x.lastRunAt,
        lastStatus: x.lastStatus, lastError: x.lastError ? trunc(String(x.lastError), 160) : null, runCount: x.runCount,
      }));
      feedEvents('routines', routines.slice().sort((a, b) => tsMs(b.lastRunAt, 0) - tsMs(a.lastRunAt, 0)), (x) => (x.lastRunAt ? {
        key: `${x.id}:${x.lastRunAt}`, at: tsMs(x.lastRunAt),
        source: 'mac', kind: 'routine',
        text: `routine "${x.name}" ${x.lastStatus}${x.lastError ? ' — ' + x.lastError : ''}`,
      } : null), 4);
      return { ok: true, ms: r.ms, data: { routines } };
    },
  },
  {
    key: 'agent.memoryFacts', label: 'agent /memory/facts', family: 'mac', every: 30000,
    async run() {
      const r = await agentGet('/memory/facts');
      if (!r.ok) return r;
      const all = r.json?.facts || [];
      const byKind = {};
      for (const f of all) byKind[f.kind || 'unknown'] = (byKind[f.kind || 'unknown'] || 0) + 1;
      const facts = all.slice().sort((a, b) => tsMs(b.updatedAt, 0) - tsMs(a.updatedAt, 0)).slice(0, 60).map(stripFact);
      return { ok: true, ms: r.ms, data: { total: all.length, byKind, maskedCount: facts.filter((f) => f.masked).length, facts } };
    },
  },
  {
    key: 'agent.capabilities', label: 'agent /capabilities', family: 'mac', every: 60000,
    async run() {
      const r = await agentGet('/capabilities', 15000);
      if (!r.ok) return r;
      const c = r.json || {};
      const data = {
        generatedAt: c.generatedAt, routeCount: c.http?.routeCount ?? c.routeCount ?? null,
        actionCount: c.actions?.count ?? null,
        publicPaths: c.http?.publicPaths ?? null,
        groups: (c.http?.groups || c.groups || []).map((g) => ({ group: g.group, routeCount: g.routeCount, what: trunc(g.what, 120) })),
      };
      return { ok: true, ms: r.ms, data };
    },
  },
  {
    key: 'agent.catchup', label: 'agent /catchup', family: 'mac', every: 30000,
    async run() {
      const r = await agentGet('/catchup', 15000);
      if (!r.ok) return r;
      const c = r.json || {};
      const data = {
        gapFrom: c.gap?.from ?? null, gapTo: c.gap?.to ?? null, spanMs: c.gap?.spanMs ?? null,
        counts: c.counts ?? null,
        clockNotes: (c.gap?.clock?.notes || c.clock?.notes || []).map((n) => trunc(n.note, 160)),
      };
      return { ok: true, ms: r.ms, data };
    },
  },
  {
    key: 'agent.observe', label: 'agent /observe', family: 'mac', every: 30000,
    async run() {
      // NOTE: plain /observe only. Never ?probeInput=1 (spawns a helper process).
      const r = await agentGet('/observe', 15000);
      if (!r.ok) return r;
      const o = r.json || {};
      const data = {
        observedAt: o.observedAt,
        foreground: o.foregroundApp ? { name: o.foregroundApp.name, bundleId: o.foregroundApp.bundleId } : null,
        runningApps: o.runningApps ? {
          count: o.runningApps.count, helperProcesses: o.runningApps.helperProcesses,
          apps: (o.runningApps.apps || []).slice(0, 30).map((a) => a.name),
        } : null,
      };
      return { ok: true, ms: r.ms, data };
    },
  },
  // ------------- Cloud relay -------------
  {
    key: 'relay.health', label: 'relay /health', family: 'relay', every: 5000,
    async run() {
      const r = await fetchJson(RELAY_BASE + '/health', { timeoutMs: 10000 });
      if (!r.ok) return r;
      const h = r.json || {};
      const seen = tsMs(h.macBridgeLastSeen, 0);
      if (seen > (prev.macBridgeSeen || 0)) { prev.macBridgeSeen = seen; touchEdge('mac-relay', now()); }
      touchNode('relay', now());
      return {
        ok: true, ms: r.ms,
        data: {
          service: h.service, version: h.version, platform: h.platform, store: h.store,
          macBridgeOnline: h.macBridgeOnline, macBridgeLastSeen: h.macBridgeLastSeen,
          capabilities: h.capabilities ?? null, models: h.models ?? null,
          pairingRequired: h.pairingRequired,
        },
      };
    },
  },
  {
    key: 'relay.devices', label: 'relay /v1/devices/status', family: 'relay', every: 10000,
    async run() {
      const r = await relayGet('/v1/devices/status');
      if (!r.ok) return { ...r, unsupported: r.status === 404 };
      const devices = (r.json?.devices || []).map((d) => ({
        deviceId: d.deviceId, deviceType: d.deviceType, name: d.name,
        registeredAt: d.registeredAt, lastSeenAt: d.lastSeenAt, online: d.online,
      }));
      for (const d of devices) {
        const t = tsMs(d.lastSeenAt, 0);
        const k = `dev:${d.deviceId}`;
        if (t > (prev[k] || 0)) {
          const isFirst = prev[k] === undefined;
          prev[k] = t;
          if (!isFirst) {
            if (/pendant|wearable|nrf/i.test(`${d.deviceType} ${d.deviceId}`)) { touchEdge('pendant-relay', now()); touchNode('pendant', now()); }
            else if (d.deviceType === 'mobile') { touchEdge('ios-relay', now()); touchNode('ios', now()); }
            else if (d.deviceType === 'mac_bridge') { touchEdge('mac-relay', now()); }
          }
        }
      }
      return { ok: true, ms: r.ms, data: { devices } };
    },
  },
  {
    key: 'relay.ops', label: 'relay /v1/ops/history', family: 'relay', every: 10000,
    async run() {
      const r = await relayGet('/v1/ops/history?limit=20');
      if (!r.ok) return { ...r, unsupported: r.status === 404 };
      const entries = (r.json?.entries || []).map(stripOpsEntry);
      const n = feedEvents('ops', entries, (e) => ({
        key: `${e.pipelineId}:${e.status}`, at: tsMs(e.updatedAt ?? e.createdAt),
        source: /live_lte|microsd/i.test(String(e.origin)) ? 'pendant' : 'relay', kind: 'voice-run',
        text: `voice run ${e.status} (${e.origin})${e.command ? ' — ' + e.command : ''}${e.error ? ' — ' + e.error : ''}`,
      }), 8);
      if (n > 0) { touchEdge('pendant-relay', now()); touchNode('relay', now()); }
      return { ok: true, ms: r.ms, data: { entries } };
    },
  },
  // ------------- Design committee files -------------
  {
    key: 'committee.bulletin', label: 'bulletin.json', family: 'committee', every: 5000,
    async run() {
      const p = path.join(DIAG_DIR, 'bulletin.json');
      const st = await stat(p);
      const gate = `${st.size}:${st.mtimeMs}`;
      if (prev.bulletinGate === gate && state['committee.bulletin']?.ok) {
        return { ok: true, ms: 0, data: state['committee.bulletin'].data, unchanged: true };
      }
      const raw = await readFile(p, 'utf8');
      let arr;
      try { arr = JSON.parse(raw); } catch (e) {
        return { ok: false, parseError: true, error: `bulletin.json parse error: ${errStr(e)}` };
      }
      if (!Array.isArray(arr)) return { ok: false, parseError: true, error: 'bulletin.json is not an array' };
      prev.bulletinGate = gate;
      let maxRound = 0;
      for (const m of arr) if (typeof m.round === 'number' && m.round > maxRound) maxRound = m.round;
      const recent = arr.slice(-80).map((m) => ({
        id: m.id, from: m.from, to: m.to, round: m.round,
        subject: trunc(m.subject, 110), body: trunc(m.body, 240),
      }));
      const n = feedEvents('bulletin', recent.slice().reverse(), (m) => ({
        key: m.id, at: seededFeeds.has('bulletin.live') ? now() : st.mtimeMs,
        source: 'committee', kind: 'bulletin',
        text: `${m.from} → ${m.to} [r${m.round}]: ${m.subject}`,
      }), 10);
      seededFeeds.add('bulletin.live');
      if (n > 0) touchNode('committee', now());
      return { ok: true, ms: 0, data: { total: arr.length, maxRound, fileMtime: st.mtimeMs, recent } };
    },
  },
  {
    key: 'committee.commons', label: 'commons.jsonl', family: 'committee', every: 5000,
    async run() {
      const p = path.join(DIAG_DIR, 'commons.jsonl');
      const preSt = await stat(p);
      const gate = `${preSt.size}:${preSt.mtimeMs}`;
      if (prev.commonsGate === gate && state['committee.commons']?.ok) {
        return { ok: true, ms: 0, data: state['committee.commons'].data, unchanged: true };
      }
      const { lines, size } = await tailFileLines(p, 262144); // last 256 KB only
      prev.commonsGate = gate;
      let parseErrors = 0;
      const parsed = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { parseErrors++; }
      }
      const cutoff = now() - 10 * 60 * 1000;
      let last10m = 0;
      for (const d of parsed) if (tsMs(d.at, 0) >= cutoff) last10m++;
      const atLeast = last10m >= parsed.length && parsed.length > 0; // tail window smaller than the burst
      const tail = parsed.slice(-50).reverse().map((d) => ({
        key: trunc(d.key, 90), tool: d.tool, agent: d.agent, round: d.round,
        bytes: d.bytes, at: d.at, summary: trunc(d.summary, 130), hash: d.hash, absent: d.absent,
      }));
      const n = feedEvents('commons', tail, (d) => ({
        key: `${d.hash}:${d.at}`, at: tsMs(d.at),
        source: 'committee', kind: 'deposit',
        text: `${d.agent} deposited ${d.tool}${d.bytes != null ? ` (${d.bytes}B)` : ''} — ${d.key}`,
      }), 8);
      if (n > 0) touchNode('committee', now());
      const lastAt = parsed.length ? parsed[parsed.length - 1].at : null;
      return { ok: true, ms: 0, data: { fileSize: size, parsedTail: parsed.length, parseErrors, depositsLast10m: last10m, depositsLast10mAtLeast: atLeast, lastAt, tail } };
    },
  },
  {
    key: 'committee.orchestrator', label: 'orchestrator.json', family: 'committee', every: 10000,
    async run() {
      const p = path.join(DIAG_DIR, 'orchestrator.json');
      const st = await stat(p);
      const gate = `${st.size}:${st.mtimeMs}`;
      if (prev.orchGate === gate && state['committee.orchestrator']?.ok) {
        return { ok: true, ms: 0, data: state['committee.orchestrator'].data, unchanged: true };
      }
      const raw = await readFile(p, 'utf8');
      let obj;
      try { obj = JSON.parse(raw); } catch (e) {
        return { ok: false, parseError: true, error: `orchestrator.json parse error: ${errStr(e)}` };
      }
      prev.orchGate = gate;
      const agents = {};
      let newestRun = 0;
      for (const [name, v] of Object.entries(obj)) {
        if (!v || typeof v !== 'object') continue;
        agents[name] = {
          lastCycle: v.lastCycle ?? null, lastRunAt: v.lastRunAt ?? null,
          seenCount: v.seen && typeof v.seen === 'object' ? Object.keys(v.seen).length : 0,
        };
        newestRun = Math.max(newestRun, tsMs(v.lastRunAt, 0));
      }
      if (newestRun > (prev.orchNewest || 0)) { prev.orchNewest = newestRun; touchNode('committee', now()); }
      return { ok: true, ms: 0, data: { agents, fileMtime: st.mtimeMs } };
    },
  },
  {
    key: 'committee.ledger', label: 'ledger.json', family: 'committee', every: 60000,
    async run() {
      const p = path.join(DIAG_DIR, 'ledger.json');
      const st = await stat(p);
      const gate = `${st.size}:${st.mtimeMs}`;
      if (prev.ledgerGate === gate && state['committee.ledger']?.ok) {
        return { ok: true, ms: 0, data: state['committee.ledger'].data, unchanged: true };
      }
      const raw = await readFile(p, 'utf8');
      let obj;
      try { obj = JSON.parse(raw); } catch (e) {
        return { ok: false, parseError: true, error: `ledger.json parse error: ${errStr(e)}` };
      }
      prev.ledgerGate = gate;
      const entries = Array.isArray(obj?.entries) ? obj.entries : [];
      const counts = {};
      for (const e of entries) counts[e.status || 'unknown'] = (counts[e.status || 'unknown'] || 0) + 1;
      return { ok: true, ms: 0, data: { total: entries.length, counts, fileMtime: st.mtimeMs } };
    },
  },
];

const running = new Set();
async function tick(p) {
  if (running.has(p.key)) return;
  running.add(p.key);
  const t0 = now();
  try {
    const r = await p.run();
    if (r.ok) {
      setSource(p.key, { key: p.key, label: p.label, family: p.family, intervalMs: p.every, ok: true, at: now(), ms: r.ms ?? (now() - t0), error: null, parseError: false, data: r.data });
    } else {
      setSource(p.key, { key: p.key, label: p.label, family: p.family, intervalMs: p.every, ok: false, at: now(), ms: r.ms ?? (now() - t0), error: r.error || 'unknown error', parseError: !!r.parseError, unsupported: !!r.unsupported, data: state[p.key]?.data ?? null });
      noteFailure(p, r);
    }
  } catch (e) {
    setSource(p.key, { key: p.key, label: p.label, family: p.family, intervalMs: p.every, ok: false, at: now(), ms: now() - t0, error: errStr(e), parseError: false, data: state[p.key]?.data ?? null });
    noteFailure(p, { error: errStr(e) });
  } finally {
    running.delete(p.key);
  }
}
function noteFailure(p, r) {
  const k = `fail:${p.key}`;
  const err = r.error || 'unknown error';
  if (prev[k] !== err) {
    prev[k] = err;
    pushEvent({ at: now(), source: 'system', kind: 'source-error', text: `${p.label} failed: ${err}` });
    console.error(`[hive] ${p.label} failed: ${err}`);
  }
}
function startPollers() {
  POLLERS.forEach((p, i) => {
    setTimeout(() => { tick(p); setInterval(() => tick(p), p.every); }, i * 130);
  });
}

// ---------------------------------------------------------------- node status

const AGENT_SOURCE_KEYS = POLLERS.filter((p) => p.family === 'mac').map((p) => p.key);
const COMMITTEE_AGENTS = ['mac-planner', 'mac-terminal', 'mac-vision', 'relay-realtime', 'browser-extension', 'unified', 'faculty-perception', 'faculty-judgement', 'faculty-action'];

function srcOk(k) { return state[k]?.ok === true; }
function srcData(k) { return state[k]?.ok ? state[k].data : null; }

function computeNodes() {
  const t = now();
  const nodes = [];

  // Mac agent
  {
    const h = state['agent.health'];
    let status = 'unknown', reason = 'not polled yet';
    if (h) {
      if (!h.ok) { status = 'down'; reason = h.error; }
      else {
        const failing = AGENT_SOURCE_KEYS.filter((k) => state[k] && !state[k].ok && !state[k].unsupported);
        if (failing.length > 0) { status = 'degraded'; reason = `health ok, ${failing.length} source(s) failing: ${failing.map((k) => state[k].label).join(', ')}`; }
        else { status = 'up'; reason = `${srcData('agent.health')?.service || 'agent'} v${srcData('agent.health')?.version || '?'}`; }
      }
    }
    nodes.push({ id: 'mac', label: 'Mac Agent', status, reason: trunc(reason, 220), activityAt: nodeActivity.mac || null });
  }
  // Relay
  {
    const h = state['relay.health'];
    let status = 'unknown', reason = 'not polled yet';
    if (h) {
      if (!h.ok) { status = 'down'; reason = `relay unreachable: ${h.error}`; }
      else {
        const d = h.data;
        status = 'up';
        reason = `${d.service} v${d.version} on ${d.platform}; mac bridge ${d.macBridgeOnline ? 'online' : 'OFFLINE'}`;
        const opsBad = state['relay.ops'] && !state['relay.ops'].ok && !state['relay.ops'].unsupported;
        const devBad = state['relay.devices'] && !state['relay.devices'].ok && !state['relay.devices'].unsupported;
        if (opsBad || devBad) { status = 'degraded'; reason += `; v1 endpoint failing: ${[opsBad ? state['relay.ops'].error : null, devBad ? state['relay.devices'].error : null].filter(Boolean).join(' | ')}`; }
      }
    }
    nodes.push({ id: 'relay', label: 'Cloud Relay', status, reason: trunc(reason, 220), activityAt: nodeActivity.relay || null });
  }
  // Browser extension (seen through the Mac agent)
  {
    let status = 'unknown', reason = 'unknown — mac agent unreachable';
    const bs = state['agent.browserStatus'];
    if (bs) {
      if (!bs.ok) { status = 'unknown'; reason = `unknown via mac agent: ${bs.error}`; }
      else if (!bs.data.online) { status = 'down'; reason = 'extension offline (no recent poll from Safari extension)'; }
      else {
        const spooled = bs.data.spool?.spooled ?? 0;
        if (spooled > 0) { status = 'degraded'; reason = `online, but ${spooled} command(s) sitting in spool`; }
        else {
          const d = bs.data.devices?.[0];
          status = 'up';
          reason = d ? `${d.deviceName} v${d.extensionVersion}, polls the mac agent every 750 ms` : 'online';
        }
      }
    }
    nodes.push({ id: 'extension', label: 'Browser Extension', status, reason: trunc(reason, 220), activityAt: nodeActivity.extension || null });
  }
  // Pendant (only visible via the relay)
  {
    let status = 'unknown', reason = 'unknown via relay';
    const rh = state['relay.health'];
    const dv = state['relay.devices'];
    if (rh && !rh.ok) reason = `unknown — relay unreachable: ${rh.error}`;
    else if (dv) {
      if (!dv.ok) reason = dv.unsupported ? 'unknown via relay (devices endpoint: HTTP 404)' : `unknown via relay: ${dv.error}`;
      else {
        const pend = (dv.data.devices || []).find((d) => /pendant|wearable|nrf/i.test(`${d.deviceType} ${d.deviceId} ${d.name}`));
        if (!pend) reason = 'no pendant device registered on the relay';
        else if (pend.online) { status = 'up'; reason = `${pend.name} online, last seen ${pend.lastSeenAt}`; }
        else { status = 'down'; reason = `${pend.name} offline, last seen ${pend.lastSeenAt}`; }
      }
    }
    nodes.push({ id: 'pendant', label: 'Pendant', status, reason: trunc(reason, 220), activityAt: nodeActivity.pendant || null });
  }
  // iOS app (web shell)
  {
    let status = 'unknown', reason = 'web shell → deployed dashboard; no live device row';
    const dv = state['relay.devices'];
    if (dv?.ok) {
      const mob = (dv.data.devices || []).filter((d) => d.deviceType === 'mobile');
      if (mob.length) {
        const on = mob.find((d) => d.online);
        if (on) { status = 'up'; reason = `${on.name} online`; }
        else { status = 'unknown'; reason = `web shell; ${mob[0].name} offline since ${mob[0].lastSeenAt}`; }
      }
    } else if (dv && !dv.ok && !dv.unsupported) {
      reason = `web shell; device row unknown: ${dv.error}`;
    }
    nodes.push({ id: 'ios', label: 'iOS App', status, reason: trunc(reason, 220), activityAt: nodeActivity.ios || null });
  }
  // Committee (design ring hub status)
  {
    let status = 'unknown', reason = 'orchestrator.json not read yet';
    const orch = state['committee.orchestrator'];
    const com = state['committee.commons'];
    const fileErrs = ['committee.bulletin', 'committee.commons', 'committee.orchestrator', 'committee.ledger'].filter((k) => state[k] && !state[k].ok);
    if (fileErrs.length) { status = 'down'; reason = fileErrs.map((k) => `${state[k].label}: ${state[k].error}`).join(' | '); }
    else if (orch?.ok) {
      let newest = 0;
      for (const a of Object.values(orch.data.agents)) newest = Math.max(newest, tsMs(a.lastRunAt, 0));
      const lastDeposit = com?.ok ? tsMs(com.data.lastAt, 0) : 0;
      const freshest = Math.max(newest, lastDeposit);
      if (t - freshest < 15 * 60 * 1000) { status = 'up'; reason = `active — last cycle/deposit ${new Date(freshest).toISOString()}`; }
      else { status = 'idle'; reason = `idle since ${freshest ? new Date(freshest).toISOString() : 'unknown'}`; }
    }
    nodes.push({ id: 'committee', label: 'Design Committee', status, reason: trunc(reason, 260), activityAt: nodeActivity.committee || null });
  }
  return nodes;
}

const EDGES = [
  { id: 'pendant-relay', from: 'pendant', to: 'relay', label: 'WebSocket + HTTP' },
  { id: 'mac-relay', from: 'mac', to: 'relay', label: 'long-poll every 5 s' },
  { id: 'ext-mac', from: 'extension', to: 'mac', label: 'poll 750 ms' },
  { id: 'ios-relay', from: 'ios', to: 'relay', label: 'web shell' },
];
function computeEdges() {
  return EDGES.map((e) => ({ ...e, lastActivityAt: edgeActivity[e.id] || null }));
}

function computeShared() {
  const snap = srcData('agent.snapshot');
  const rh = srcData('relay.health');
  const routines = srcData('agent.routines')?.routines || null;
  const facts = srcData('agent.memoryFacts');
  const pipe = srcData('agent.pipeline');
  const jobs = srcData('agent.jobs')?.jobs || null;
  const ledger = srcData('committee.ledger');
  const commons = srcData('committee.commons');
  const catchup = srcData('agent.catchup');
  const bstat = srcData('agent.browserStatus');
  const bulletin = srcData('committee.bulletin');

  let nextRoutine = null;
  if (routines) {
    const en = routines.filter((r) => r.enabled && r.nextRunAt);
    en.sort((a, b) => tsMs(a.nextRunAt, Infinity) - tsMs(b.nextRunAt, Infinity));
    if (en[0]) nextRoutine = { name: en[0].name, nextRunAt: en[0].nextRunAt, lastStatus: en[0].lastStatus };
  }
  const jobsByStatus = {};
  if (jobs) for (const j of jobs) jobsByStatus[j.status || 'unknown'] = (jobsByStatus[j.status || 'unknown'] || 0) + 1;
  const pipeByStatus = {};
  let inFlight = 0;
  if (pipe) for (const r of pipe.runs) {
    pipeByStatus[r.status || 'unknown'] = (pipeByStatus[r.status || 'unknown'] || 0) + 1;
    if (!/completed|failed|done|error/i.test(String(r.status))) inFlight++;
  }
  return {
    fleet: {
      relayReachableFromMac: snap?.relay?.reachable ?? null,
      relayErrorFromMac: snap?.relay?.error ?? null,
      macBridgeLastSeenByRelay: rh?.macBridgeLastSeen ?? null,
      macBridgeOnline: rh?.macBridgeOnline ?? null,
      snapshotAt: state['agent.snapshot']?.ok ? state['agent.snapshot'].at : null,
      relayHealthAt: state['relay.health']?.ok ? state['relay.health'].at : null,
    },
    routines: routines ? { total: routines.length, enabled: routines.filter((r) => r.enabled).length, failed: routines.filter((r) => r.lastStatus === 'failed').length, next: nextRoutine } : null,
    memory: facts ? { totalFacts: facts.total, byKind: facts.byKind, masked: facts.maskedCount } : null,
    pipeline: pipe ? { totalRuns: pipe.totalRuns, recent: pipe.runs.length, inFlight, byStatus: pipeByStatus, latest: pipe.runs[0] ? { pipelineId: pipe.runs[0].pipelineId, status: pipe.runs[0].status, updatedAt: pipe.runs[0].updatedAt } : null } : null,
    jobs: jobs ? { returned: jobs.length, byStatus: jobsByStatus, latestAt: jobs[0]?.updatedAt ?? jobs[0]?.createdAt ?? null } : null,
    ledger: ledger ? { total: ledger.total, counts: ledger.counts } : null,
    commons: commons ? { depositsLast10m: commons.depositsLast10m, atLeast: commons.depositsLast10mAtLeast, lastAt: commons.lastAt } : null,
    catchup: catchup ? { spanMs: catchup.spanMs, counts: catchup.counts } : null,
    spool: bstat ? { depth: bstat.spool?.spooled ?? null, lastReason: bstat.spool?.lastReason ?? null, pendingCommands: bstat.pendingCommands ?? null } : null,
    bulletin: bulletin ? { total: bulletin.total, maxRound: bulletin.maxRound, fileMtime: bulletin.fileMtime } : null,
    agentCounts: snap?.counts ?? null,
  };
}

function sourceMeta(s) {
  return {
    key: s.key, label: s.label, family: s.family, intervalMs: s.intervalMs,
    ok: s.ok, at: s.at, ms: s.ms, error: s.error, parseError: s.parseError, unsupported: !!s.unsupported, version: s.version,
  };
}

function buildOverview() {
  const sources = {};
  for (const k of Object.keys(state)) sources[k] = { ...sourceMeta(state[k]), data: state[k].data };
  return {
    now: now(), startedAt: STARTED_AT, port: boundPort,
    committeeAgents: COMMITTEE_AGENTS,
    nodes: computeNodes(), edges: computeEdges(), shared: computeShared(),
    sources,
    events: events.slice(-150),
    eventSeq,
  };
}

// ---------------------------------------------------------------- node detail

const receiptsCache = new Map(); // jobId -> {at, payload}
async function jobReceipts(jobId) {
  const c = receiptsCache.get(jobId);
  if (c && now() - c.at < 30000) return c.payload;
  const r = await agentGet(`/jobs/${encodeURIComponent(jobId)}/receipts`, 10000);
  const payload = r.ok ? { ok: true, receipts: r.json } : { ok: false, error: r.error };
  receiptsCache.set(jobId, { at: now(), payload });
  if (receiptsCache.size > 60) receiptsCache.delete(receiptsCache.keys().next().value);
  return payload;
}

function committeeAgentDetail(name) {
  const orch = srcData('committee.orchestrator')?.agents?.[name] ?? null;
  const bulletin = srcData('committee.bulletin');
  const commons = srcData('committee.commons');
  const msgs = (bulletin?.recent || []).filter((m) => m.from === name || m.to === name || m.to === 'all').slice(-30).reverse();
  const deposits = (commons?.tail || []).filter((d) => d.agent === name).slice(0, 20);
  return { agent: name, orchestrator: orch, messages: msgs, deposits };
}

async function nodeDetail(id, query) {
  const meta = (k) => (state[k] ? sourceMeta(state[k]) : null);
  const nodes = computeNodes();
  const node = nodes.find((n) => n.id === id) || null;
  switch (id) {
    case 'mac': {
      if (query.job) {
        if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(query.job)) return { error: 'bad job id' };
        return { id, job: query.job, receipts: await jobReceipts(query.job) };
      }
      return {
        id, node,
        snapshot: srcData('agent.snapshot'), snapshotMeta: meta('agent.snapshot'),
        observe: srcData('agent.observe'), observeMeta: meta('agent.observe'),
        capabilities: srcData('agent.capabilities'), capabilitiesMeta: meta('agent.capabilities'),
        journal: srcData('agent.journal'), journalMeta: meta('agent.journal'),
        jobs: srcData('agent.jobs'), jobsMeta: meta('agent.jobs'),
        routines: srcData('agent.routines'), routinesMeta: meta('agent.routines'),
        catchup: srcData('agent.catchup'), catchupMeta: meta('agent.catchup'),
        facts: srcData('agent.memoryFacts'), factsMeta: meta('agent.memoryFacts'),
      };
    }
    case 'relay':
      return {
        id, node,
        health: srcData('relay.health'), healthMeta: meta('relay.health'),
        devices: srcData('relay.devices'), devicesMeta: meta('relay.devices'),
        ops: srcData('relay.ops'), opsMeta: meta('relay.ops'),
      };
    case 'extension':
      return {
        id, node,
        status: srcData('agent.browserStatus'), statusMeta: meta('agent.browserStatus'),
        spool: srcData('agent.browserSpool'), spoolMeta: meta('agent.browserSpool'),
        sessions: srcData('agent.browserSessions'), sessionsMeta: meta('agent.browserSessions'),
        browserJobs: (srcData('agent.jobs')?.jobs || []).filter((j) => String(j.type || '').includes('browser')).slice(0, 15),
      };
    case 'pendant': {
      const devices = srcData('relay.devices');
      const pendantDevices = (devices?.devices || []).filter((d) => /pendant|wearable|nrf|mobile|mac_bridge/i.test(`${d.deviceType}`));
      const ops = srcData('relay.ops');
      const pendantOps = (ops?.entries || []).filter((e) => /live_lte|microsd/i.test(String(e.origin)));
      return {
        id, node,
        devices: devices ? { devices: pendantDevices } : null, devicesMeta: meta('relay.devices'),
        voiceRuns: ops ? pendantOps : null, opsMeta: meta('relay.ops'),
        latestPipeline: (srcData('agent.pipeline')?.runs || []).slice(0, 5), pipelineMeta: meta('agent.pipeline'),
      };
    }
    case 'ios': {
      const devices = srcData('relay.devices');
      return {
        id, node,
        note: 'iOS app is a web shell that loads the deployed dashboard; it has no dedicated telemetry endpoint.',
        mobileDevices: devices ? (devices.devices || []).filter((d) => d.deviceType === 'mobile') : null,
        devicesMeta: meta('relay.devices'),
      };
    }
    case 'committee':
      return {
        id, node,
        orchestrator: srcData('committee.orchestrator'), orchestratorMeta: meta('committee.orchestrator'),
        ledger: srcData('committee.ledger'), ledgerMeta: meta('committee.ledger'),
        bulletin: srcData('committee.bulletin'), bulletinMeta: meta('committee.bulletin'),
        commons: srcData('committee.commons'), commonsMeta: meta('committee.commons'),
      };
    default:
      if (COMMITTEE_AGENTS.includes(id)) return { id, node: null, ...committeeAgentDetail(id) };
      return { error: `unknown node id: ${id}` };
  }
}

// ---------------------------------------------------------------- SSE

const sseClients = new Set(); // {res, cursor, sentVersions}
function sseSend(client, obj) {
  try {
    client.res.write(`id: ${eventSeq}\ndata: ${scrub(JSON.stringify(obj))}\n\n`);
  } catch { /* socket gone; cleanup happens on close */ }
}
function ssePushAll() {
  if (sseClients.size === 0) return;
  const nodes = computeNodes();
  const edges = computeEdges();
  const shared = computeShared();
  const metaAll = {};
  for (const k of Object.keys(state)) metaAll[k] = sourceMeta(state[k]);
  for (const client of sseClients) {
    const changed = {};
    for (const k of Object.keys(state)) {
      const v = state[k].version;
      if (client.sentVersions[k] !== v) { client.sentVersions[k] = v; changed[k] = { ...metaAll[k], data: state[k].data }; }
    }
    const fresh = events.filter((e) => e.seq > client.cursor).slice(-100);
    if (fresh.length) client.cursor = fresh[fresh.length - 1].seq;
    sseSend(client, { t: now(), nodes, edges, shared, meta: metaAll, sources: changed, events: fresh, eventSeq });
  }
}
setInterval(ssePushAll, 2000);

// ---------------------------------------------------------------- http server

function sendJson(res, code, obj) {
  const body = scrub(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      let html;
      try { html = await readFile(INDEX_PATH, 'utf8'); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end(`index.html unreadable: ${errStr(e)}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(scrub(html));
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/overview') return sendJson(res, 200, buildOverview());
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const cursorRaw = Number(u.searchParams.get('cursor'));
      const client = { res, cursor: Number.isFinite(cursorRaw) ? cursorRaw : eventSeq, sentVersions: {} };
      if (sseClients.size >= 25) { res.end(); return; }
      sseClients.add(client);
      sseSend(client, { hello: true, t: now(), port: boundPort, eventSeq });
      req.on('close', () => sseClients.delete(client));
      return;
    }
    const nodeMatch = /^\/api\/node\/([A-Za-z0-9:_-]{1,64})$/.exec(p);
    if (nodeMatch) {
      const detail = await nodeDetail(nodeMatch[1], { job: u.searchParams.get('job') || undefined });
      return sendJson(res, detail.error ? 404 : 200, { now: now(), ...detail });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    try { sendJson(res, 500, { error: errStr(e) }); } catch { /* already ended */ }
  }
});

let boundPort = null;
function listen(idx = 0) {
  if (idx >= PORTS.length) {
    console.error(`[hive] no free port in ${PORTS[0]}..${PORTS[PORTS.length - 1]}`);
    process.exit(1);
  }
  const port = PORTS[idx];
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[hive] port ${port} busy, trying ${PORTS[idx + 1]}`);
      listen(idx + 1);
    } else {
      console.error(`[hive] listen error: ${e.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    boundPort = port;
    console.log(`[hive] Hive dashboard on http://127.0.0.1:${port}  (agent: ${AGENT_BASE}, relay: ${RELAY_BASE})`);
    console.log(`[hive] AGENT_TOKEN ${AGENT_TOKEN ? 'loaded' : 'MISSING'}, RELAY_API_KEY ${RELAY_API_KEY ? 'loaded' : 'MISSING'} from ${ENV_PATH}`);
    startPollers();
  });
}
listen();
