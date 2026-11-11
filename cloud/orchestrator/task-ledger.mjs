// Append-only instruction ledger. No method starts work or auto-resumes it.
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const MAY_CONTAIN_SECRET = /(?:\b(?:password|passwd|passcode|passkey|pin|otp|one[ -]time|secret|credential|authorization|bearer|token|private[ _-]?key|api[ _-]?key)\b|\b(?:sk|ghp|github_pat)[-_][a-z0-9_-]{12,}\b|\b[a-z0-9+/=_-]{40,}\b)/i;
const LABELED_SECRET = /(?:\b(?:password|passwd|passcode|verification\s+code|one.time\s+code|api[ _-]?key|access[ _-]?token|bearer|client[ _-]?secret)\b\s*(?:is\b|[:=])|\b(?:sk-[A-Za-z0-9_-]{12,}|pdt_[A-Za-z0-9_.-]{12,}|ghp_[A-Za-z0-9]{20,})\b)/i;

export class TaskLedger {
  constructor(path) {
    if (!nonempty(path)) throw new Error('Ledger path is required');
    this.path = resolve(path); this.lockPath = `${this.path}.lock`; this.keyPath = `${this.path}.key`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }
  // A lock is never auto-broken: absence of a heartbeat is not proof a writer
  // stopped. After an unclean exit the operator must verify before removing it.
  locked(fn) {
    const lock = openSync(this.lockPath, 'wx', 0o600);
    try { return fn(); } finally { closeSync(lock); unlinkSync(this.lockPath); }
  }
  key(create = false) {
    let fd;
    try { fd = openSync(this.keyPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      const key = randomBytes(32); fd = openSync(this.keyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(dirname(this.keyPath), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      return key;
    }
    try { const stat = fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Ledger key must be private'); const key = readFileSync(fd); if (key.length !== 32) throw new Error('Invalid ledger key'); return key; } finally { closeSync(fd); }
  }
  encodeText(text) {
    const key = this.key(true), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { encoding: 'aes-256-gcm', iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  decodeEvent(event) {
    const result = { ...event };
    for (const field of ['text', 'constraints', 'evidence', 'reason']) {
      const value = result[field];
      if (!value || value.encoding !== 'aes-256-gcm') continue;
      const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(value.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      const decoded = Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
      result[field] = value.json ? JSON.parse(decoded) : decoded;
    }
    if (event.type === 'instruction' && typeof result.text !== 'string') throw new Error('Invalid encrypted instruction');
    return result;
  }
  matchesInstruction(task, text) {
    if (task.contentDigest) return createHmac('sha256', this.key()).update(text).digest('hex') === task.contentDigest;
    return task.text === text;
  }
  read() {
    let fd;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return { tasks: Object.create(null), stopped: false, events: [], head: null }; throw error; }
    let data;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Ledger must be a private regular file');
      data = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    if (data && !data.endsWith('\n')) throw new Error('Incomplete ledger tail; recovery requires review');
    const state = { tasks: Object.create(null), stopped: false, events: [], head: null };
    for (const line of data.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error('Invalid ledger record'); }
      const { hash, ...content } = event;
      if (content.prev !== state.head || hash !== digest(content) || content.v !== 1) throw new Error('Ledger integrity check failed');
      apply(state, this.decodeEvent(event)); state.events.push(event); state.head = hash;
    }
    return state;
  }
  transaction(build) {
    return this.locked(() => {
      const state = this.read();
      const result = build(state);
      if (!result?.event) return clone(result?.value);
      const payload = { ...result.event };
      if (payload.type === 'instruction') {
        payload.text = this.encodeText(payload.text);
        payload.constraints = { ...this.encodeText(JSON.stringify(payload.constraints)), json: true };
      }
      if (payload.evidence) payload.evidence = { ...this.encodeText(JSON.stringify(payload.evidence)), json: true };
      if (payload.reason) {
        if (LABELED_SECRET.test(payload.reason)) throw new Error('Reason may contain a credential');
        payload.reason = this.encodeText(payload.reason);
      }
      const content = { v: 1, id: randomUUID(), at: new Date().toISOString(), prev: state.head, ...payload };
      const event = { ...content, hash: digest(content) };
      apply(state, this.decodeEvent(event)); // Refuse invalid transitions before writing.
      const existed = existsSync(this.path);
      const fd = openSync(this.path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { const stat = fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Ledger must be a private regular file'); const bytes = Buffer.from(`${JSON.stringify(event)}\n`); let n = 0; while (n < bytes.length) n += writeSync(fd, bytes, n, bytes.length - n); fsyncSync(fd); }
      finally { closeSync(fd); }
      if (!existed) { const dir = openSync(dirname(this.path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      return clone(result.value ?? state.tasks[event.taskId] ?? { stopped: state.stopped });
    });
  }
  recordInstruction({ id = randomUUID(), sourceId, text, parentId = null, requiresApproval = false, irreversible = false, constraints = [], contentDigest = null }) {
    if (![id, sourceId, text].every(nonempty) || (parentId !== null && !nonempty(parentId)) || typeof requiresApproval !== 'boolean' || typeof irreversible !== 'boolean' || !Array.isArray(constraints) || !constraints.every(nonempty) || (contentDigest !== null && !/^[a-f0-9]{64}$/.test(contentDigest))) throw new Error('Invalid instruction');
    return this.transaction(state => {
      const existing = Object.values(state.tasks).find(t => t.sourceId === sourceId);
      // Legacy reviewed summaries can be re-imported idempotently even when
      // newer, more conservative screening would withhold the same words.
      if (existing && existing.contentDigest === null && existing.id === id && existing.text === text && existing.parentId === parentId && existing.requiresApproval === requiresApproval && existing.irreversible === irreversible && JSON.stringify(existing.constraints ?? []) === JSON.stringify(constraints)) return { value: existing };
      if (constraints.some(value => LABELED_SECRET.test(value))) throw new Error('Constraint may contain a credential');
      if (MAY_CONTAIN_SECRET.test(text)) {
        contentDigest = createHmac('sha256', this.key(true)).update(text).digest('hex');
        text = '[Instruction content withheld: possible credential or verification code]';
      }
      const old = Object.values(state.tasks).find(t => t.sourceId === sourceId);
      if (old) {
        if (old.id !== id || old.text !== text || old.parentId !== parentId || old.requiresApproval !== requiresApproval || old.irreversible !== irreversible || old.contentDigest !== contentDigest || JSON.stringify(old.constraints ?? []) !== JSON.stringify(constraints)) throw new Error('Conflicting instruction identity');
        return { value: old };
      }
      if (state.tasks[id] || (parentId && !state.tasks[parentId])) throw new Error('Invalid task identity or parent');
      return { event: { type: 'instruction', taskId: id, sourceId, text, parentId, requiresApproval, irreversible, constraints, contentDigest } };
    });
  }
  stop(reason) { if (!nonempty(reason)) throw new Error('Stop reason required'); return this.transaction(() => ({ event: { type: 'stop', reason } })); }
  resume({ authorization, reason }) {
    if (authorization !== 'explicit_user' || !nonempty(reason)) throw new Error('Explicit user authorization required');
    return this.transaction(() => ({ event: { type: 'resume', reason } }));
  }
  approve(taskId, { authorization, reason }) {
    if (authorization !== 'explicit_user' || !nonempty(reason)) throw new Error('Explicit user authorization required');
    return this.transaction(state => { if (!state.tasks[taskId]) throw new Error('Unknown task'); return { event: { type: 'approval', taskId, reason } }; });
  }
  revokeApproval(taskId, reason) {
    if (!nonempty(reason)) throw new Error('Reason required');
    return this.transaction(state => { if (!state.tasks[taskId]) throw new Error('Unknown task'); return { event: { type: 'approval_revoked', taskId, reason } }; });
  }
  relate(taskId, relatedId) {
    if (!nonempty(taskId) || !nonempty(relatedId) || taskId === relatedId) throw new Error('Invalid task relationship');
    return this.transaction(state => {
      if (!state.tasks[taskId] || !state.tasks[relatedId]) throw new Error('Unknown related task');
      if (state.tasks[taskId].relatedIds.includes(relatedId)) return { value: state.tasks[taskId] };
      return { event: { type: 'related', taskId, relatedId } };
    });
  }
  setParent(taskId, parentId) {
    return this.transaction(state => {
      const task = state.tasks[taskId];
      if (!task || task.status !== 'pending' || (parentId !== null && !state.tasks[parentId])) throw new Error('Invalid parent update');
      for (let cursor = parentId; cursor; cursor = state.tasks[cursor]?.parentId) if (cursor === taskId) throw new Error('Parent cycle');
      return { event: { type: 'parent_changed', taskId, parentId } };
    });
  }
  setDependencies(taskId, dependencies) {
    return this.transaction(state => {
      if (!state.tasks[taskId] || state.tasks[taskId].status !== 'pending' || !Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length || dependencies.some(id => !state.tasks[id] || id === taskId)) throw new Error('Invalid dependencies');
      const reaches = (id, seen = new Set()) => { if (id === taskId) return true; if (seen.has(id)) return false; seen.add(id); return (state.tasks[id].dependsOn ?? []).some(next => reaches(next, seen)); };
      if (dependencies.some(id => reaches(id))) throw new Error('Dependency cycle');
      return { event: { type: 'dependencies', taskId, dependencies } };
    });
  }
  startAttempt(taskId, attemptId = randomUUID()) {
    return this.transaction(state => {
      const task = state.tasks[taskId];
      if (!task) throw new Error('Unknown task');
      if (state.stopped) throw new Error('Execution stopped');
      if (task.requiresApproval && !task.approved) throw new Error('Approval required');
      if (task.irreversible && !task.approved) throw new Error('Approval required for irreversible work');
      if ((task.dependsOn ?? []).some(id => state.tasks[id]?.status !== 'completed')) throw new Error('Prerequisite tasks remain unfinished');
      if (task.status !== 'pending') throw new Error('Task is not eligible for dispatch');
      if (!nonempty(attemptId)) throw new Error('Attempt identity required');
      return { event: { type: 'attempt_started', taskId, attemptId } };
    });
  }
  recordAdmission(taskId, attemptId, status, reason = null) {
    if (!['accepted', 'rejected', 'unknown'].includes(status) || (reason !== null && !nonempty(reason))) throw new Error('Invalid admission');
    return this.transaction(state => {
      const task = state.tasks[taskId];
      if (!task || task.attemptId !== attemptId || task.status !== 'dispatching') throw new Error('Attempt is not awaiting admission');
      return { event: { type: 'admission', taskId, attemptId, status, reason } };
    });
  }
  complete(taskId, evidence) {
    if (!evidence || !nonempty(evidence.source) || !nonempty(evidence.reference) || !nonempty(evidence.summary) || !Number.isFinite(Date.parse(evidence.observedAt))) throw new Error('Completion requires dated, attributable evidence');
    if ([evidence.source, evidence.reference, evidence.summary].some(value => LABELED_SECRET.test(value))) throw new Error('Evidence may contain a credential');
    return this.transaction(state => {
      const task = state.tasks[taskId];
      if (!task || !['accepted', 'unknown', 'dispatching'].includes(task.status)) throw new Error('Task has no eligible attempt');
      if (Object.values(state.tasks).some(child => child.parentId === taskId && child.status !== 'completed')) throw new Error('Child tasks remain unfinished');
      return { event: { type: 'completed', taskId, evidence: { source: evidence.source, reference: evidence.reference, summary: evidence.summary, observedAt: evidence.observedAt } } };
    });
  }
  addEvidence(taskId, evidence) {
    if (!evidence || !nonempty(evidence.source) || !nonempty(evidence.reference) || !nonempty(evidence.summary) || !Number.isFinite(Date.parse(evidence.observedAt))) throw new Error('Observation requires dated, attributable evidence');
    if ([evidence.source, evidence.reference, evidence.summary].some(value => LABELED_SECRET.test(value))) throw new Error('Evidence may contain a credential');
    return this.transaction(state => {
      if (!state.tasks[taskId]) throw new Error('Unknown task');
      return { event: { type: 'observation', taskId, evidence: { source: evidence.source, reference: evidence.reference, summary: evidence.summary, observedAt: evidence.observedAt } } };
    });
  }
  adoptReceipt(taskId, { receiptId, status, observedAt }) {
    if (!/^[a-f0-9]{32}$/.test(receiptId) || !['accepted', 'rejected', 'unknown', 'dispatching'].includes(status) || !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid receipt observation');
    return this.transaction(state => {
      const task = state.tasks[taskId];
      if (!task) throw new Error('Unknown task');
      if (task.externalReceipt?.receiptId === receiptId && task.externalReceipt.status === status) return { value: task };
      if (task.externalReceipt && task.externalReceipt.receiptId !== receiptId) throw new Error('Conflicting receipt identity');
      if (task.externalReceipt && Date.parse(observedAt) <= Date.parse(task.externalReceipt.observedAt)) throw new Error('Stale receipt observation');
      if (task.externalReceipt && ['accepted', 'rejected'].includes(task.externalReceipt.status)) throw new Error('Conflicting terminal receipt');
      if (['accepted', 'rejected'].includes(task.status) && task.status !== status) throw new Error('Receipt conflicts with recorded admission');
      return { event: { type: 'external_receipt', taskId, receiptId, status, observedAt } };
    });
  }
  snapshot() { const s = this.read(); return { stopped: s.stopped, tasks: Object.values(s.tasks), head: s.head }; }
  reconcile() {
    const { stopped, tasks, head } = this.snapshot();
    return { stopped, head, unfinished: tasks.filter(t => t.status !== 'completed').map(t => ({ ...t, next: stopped ? 'stopped' : t.status === 'pending' ? t.dependsOn.some(id => tasks.find(candidate => candidate.id === id)?.status !== 'completed') ? 'await_prerequisites' : (t.requiresApproval || t.irreversible) && !t.approved ? 'await_approval' : 'eligible_for_explicit_dispatch' : t.status === 'dispatching' ? 'inspect_interrupted_attempt' : t.status === 'accepted' ? 'await_completion_evidence' : t.status === 'unknown' ? 'investigate_unknown' : 'review_rejection' })) };
  }
}

function apply(state, event) {
  const t = state.tasks[event.taskId];
  switch (event.type) {
    case 'instruction':
      if (t || Object.values(state.tasks).some(x => x.sourceId === event.sourceId) || (event.parentId && !state.tasks[event.parentId])) throw new Error('Invalid instruction ledger event');
      if (event.parentId && state.tasks[event.parentId].status === 'completed') {
        state.tasks[event.parentId].status = 'accepted';
        delete state.tasks[event.parentId].evidence;
        state.tasks[event.parentId].updatedAt = event.at;
      }
      state.tasks[event.taskId] = { id: event.taskId, sourceId: event.sourceId, text: event.text, contentDigest: event.contentDigest ?? null, parentId: event.parentId, relatedIds: [], dependsOn: [], requiresApproval: event.requiresApproval, irreversible: event.irreversible, constraints: event.constraints ?? [], approved: false, status: 'pending', createdAt: event.at, updatedAt: event.at }; break;
    case 'related': if (!t || !state.tasks[event.relatedId] || event.relatedId === t.id) throw new Error('Invalid task relationship'); if (!t.relatedIds.includes(event.relatedId)) t.relatedIds.push(event.relatedId); if (!state.tasks[event.relatedId].relatedIds.includes(t.id)) state.tasks[event.relatedId].relatedIds.push(t.id); break;
    case 'parent_changed': if (!t || t.status !== 'pending' || (event.parentId !== null && !state.tasks[event.parentId])) throw new Error('Invalid parent ledger event'); t.parentId = event.parentId; break;
    case 'dependencies': if (!t || t.status !== 'pending' || !Array.isArray(event.dependencies) || event.dependencies.some(id => !state.tasks[id])) throw new Error('Invalid dependency ledger event'); t.dependsOn = event.dependencies; break;
    case 'stop': state.stopped = true; break;
    case 'resume': state.stopped = false; break;
    case 'approval': if (!t) throw new Error('Invalid approval ledger event'); t.approved = true; t.updatedAt = event.at; break;
    case 'approval_revoked': if (!t) throw new Error('Invalid approval ledger event'); t.approved = false; t.updatedAt = event.at; break;
    case 'attempt_started': if (!t || state.stopped || t.status !== 'pending' || ((t.requiresApproval || t.irreversible) && !t.approved) || t.dependsOn.some(id => state.tasks[id]?.status !== 'completed')) throw new Error('Invalid attempt ledger event'); t.status = 'dispatching'; t.attemptId = event.attemptId; t.updatedAt = event.at; break;
    case 'admission': if (!t || t.status !== 'dispatching' || t.attemptId !== event.attemptId) throw new Error('Invalid admission ledger event'); t.status = event.status; t.reason = event.reason; t.updatedAt = event.at; break;
    case 'observation': if (!t) throw new Error('Invalid observation ledger event'); (t.observations ??= []).push(event.evidence); t.updatedAt = event.at; break;
    case 'external_receipt':
      if (!t || (t.externalReceipt && t.externalReceipt.receiptId !== event.receiptId)) throw new Error('Invalid receipt ledger event');
      t.externalReceipt = { receiptId: event.receiptId, status: event.status, observedAt: event.observedAt };
      if (t.status !== 'completed') t.status = event.status === 'dispatching' ? 'unknown' : event.status;
      t.updatedAt = event.at; break;
    case 'completed': if (!t || !['accepted', 'unknown', 'dispatching'].includes(t.status) || Object.values(state.tasks).some(x => x.parentId === t.id && x.status !== 'completed')) throw new Error('Invalid completion ledger event'); t.status = 'completed'; t.evidence = event.evidence; t.updatedAt = event.at; break;
    default: throw new Error('Unknown ledger event');
  }
}
